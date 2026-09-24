(function() {
    'use strict';

    window.addEventListener('unhandledrejection', (e) => {
        console.error('[SSHDeck] Unhandled promise rejection:', e.reason);
    });

    window.addEventListener('error', (e) => {
        if (e.filename && e.filename.includes('socket.io')) return;
        console.error('[SSHDeck] Uncaught error:', e.message, e.filename, e.lineno);
    });

    const APP_ROOT = document.querySelector('meta[name="app-root"]')?.content || '';
    window.APP_ROOT = APP_ROOT;
    window.socket = io({ path: APP_ROOT + '/socket.io' });

    // G4 / P4a: Sole socket owner for restore/replay. Frames that arrive before
    // SessionManager.init finishes grid/layout are buffered; after initialized
    // each live frame dispatches exactly once. SessionManager must NOT also
    // register these two events (duplicate dispatch + drain-before-grid).
    // SessionManager is a top-level const, never assigned to window.
    window.__earlyRestoreFrames = [];
    window.__earlyReplayChunks = [];
    window.socket.on('ssh_session_restored', (data) => {
        if (typeof SessionManager !== 'undefined' && SessionManager.initialized) {
            SessionManager.restoreSession(data);
        } else {
            window.__earlyRestoreFrames.push(data);
        }
    });
    window.socket.on('ssh_replay_chunk', (data) => {
        if (typeof TerminalManager !== 'undefined'
                && typeof SessionManager !== 'undefined'
                && SessionManager.initialized) {
            TerminalManager.acceptReplayChunk(data.session_id, data);
        } else {
            window.__earlyReplayChunks.push(data);
        }
    });

    window.escapeHtml = function(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    window.showNotification = function(message, type = 'info', duration) {
        const container = document.getElementById('notificationContainer');
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        container.appendChild(notification);

        const timeout = duration || (type === 'success' || type === 'info' ? 2000 : 3000);
        setTimeout(() => {
            notification.classList.add('fade-out');
            setTimeout(() => notification.remove(), 300);
        }, timeout);
    };

    window.ModalManager = {
        activeModal: null,
        previouslyFocused: new WeakMap(),
        focusableSelector: 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',

        open(modal) {
            if (!modal) return;
            if (document.activeElement && document.activeElement !== document.body) {
                this.previouslyFocused.set(modal, document.activeElement);
            }
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
            this.activeModal = modal;

            const focusable = modal.querySelectorAll(this.focusableSelector);
            if (focusable.length > 0) {
                focusable[0].focus();
            }
        },

        close(modal) {
            if (!modal) return;
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
            if (this.activeModal === modal) {
                this.activeModal = null;
            }
            const previouslyFocused = this.previouslyFocused.get(modal);
            if (previouslyFocused?.isConnected) {
                previouslyFocused.focus();
            }
            this.previouslyFocused.delete(modal);
        },

        trapFocus(event) {
            if (!this.activeModal || event.key !== 'Tab') {
                return;
            }
            const focusable = Array.from(this.activeModal.querySelectorAll(this.focusableSelector));
            if (focusable.length === 0) {
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    };

    window.clearConnectionProfileState = () => {
        window.ConnectionCommandManager?.clear();
        ProfileManager.clearLegacyCommands();

        const profileSelect = document.getElementById('profileSelect');
        if (profileSelect) {
            profileSelect.value = '';
        }

        const deleteProfileBtn = document.getElementById('deleteProfileBtn');
        if (deleteProfileBtn) {
            deleteProfileBtn.style.display = 'none';
            delete deleteProfileBtn.dataset.profileId;
        }
    };

    const ConnectionHistory = {
        maxItems: 10,
        storageKey: 'recentConnections',
        maxAge: 30 * 24 * 60 * 60 * 1000,

        getHistory() {
            try {
                const history = JSON.parse(localStorage.getItem(this.storageKey) || '[]');
                const now = Date.now();
                const filtered = history.filter(entry => {
                    if (!entry.timestamp) return true;
                    return (now - entry.timestamp) < this.maxAge;
                });
                if (filtered.length !== history.length) {
                    localStorage.setItem(this.storageKey, JSON.stringify(filtered));
                }
                return filtered;
            } catch (e) {
                return [];
            }
        },

        addConnection(host, port, username) {
            const history = this.getHistory();
            const entry = { host, port: parseInt(port), username, timestamp: Date.now() };

            const filtered = history.filter(h =>
                !(h.host === host && h.port === parseInt(port) && h.username === username)
            );

            filtered.unshift(entry);

            const trimmed = filtered.slice(0, this.maxItems);

            try {
                localStorage.setItem(this.storageKey, JSON.stringify(trimmed));
            } catch (e) {
                console.error('Failed to save connection history:', e);
            }
        },

        renderHistoryDropdown() {
            const container = document.getElementById('recentConnectionsList');
            if (!container) return;

            const history = this.getHistory();
            container.innerHTML = '';

            if (history.length === 0) {
                container.style.display = 'none';
                return;
            }

            container.style.display = 'block';

            history.forEach(conn => {
                const option = document.createElement('div');
                option.className = 'recent-connection-item';
                option.innerHTML = `
                    <span class="recent-conn-label">${escapeHtml(conn.username)}@${escapeHtml(conn.host)}:${escapeHtml(String(conn.port))}</span>
                    <span class="recent-conn-time">${escapeHtml(this.formatTime(conn.timestamp))}</span>
                `;
                option.addEventListener('click', () => {
                    window.clearConnectionProfileState();
                    document.getElementById('hostInput').value = conn.host;
                    document.getElementById('portInput').value = conn.port;
                    document.getElementById('usernameInput').value = conn.username;
                    document.getElementById('passwordInput').focus();
                });
                container.appendChild(option);
            });
        },

        formatTime(timestamp) {
            const diff = Date.now() - timestamp;
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(diff / 3600000);
            const days = Math.floor(diff / 86400000);

            if (minutes < 1) return window.i18n?.t('time.justNow', 'just now') || 'just now';
            if (minutes < 60) return `${minutes}m`;
            if (hours < 24) return `${hours}h`;
            return `${days}d`;
        }
    };

    window.ConnectionHistory = ConnectionHistory;

    const TerminalSearch = {
        isOpen: false,
        searchBar: null,
        searchInput: null,
        searchCount: null,

        init() {
            this.searchBar = document.getElementById('terminalSearchBar');
            this.searchInput = document.getElementById('terminalSearchInput');
            this.searchCount = document.getElementById('terminalSearchCount');

            if (!this.searchBar || !this.searchInput) return;

            this.searchInput.addEventListener('input', () => {
                this.performSearch();
            });

            this.searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.findPrevious();
                    } else {
                        this.findNext();
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.close();
                }
            });

            /*
             * The addon debounces its highlight pass, so resultCount is usually
             * Not final by the time findNext returns -- the first render would
             * show a stale total. Repainting on its own event is what makes the
             * counter track the real match set. Guarded on isOpen so a background
             * event cannot write into a closed bar.
             */
            document.addEventListener('sshdeck:search-results', () => {
                if (!this.isOpen) return;
                this.renderCount(true);
            });

            document.getElementById('terminalSearchNext')?.addEventListener('click', () => this.findNext());
            document.getElementById('terminalSearchPrev')?.addEventListener('click', () => this.findPrevious());
            document.getElementById('terminalSearchClose')?.addEventListener('click', () => this.close());
        },

        open() {
            if (!TerminalManager.hasSearchSupport()) {
                showNotification('Search not available', 'warning');
                return;
            }

            const activeSession = SessionManager.getActiveSession();
            if (!activeSession) {
                showNotification('No active session', 'warning');
                return;
            }

            this.isOpen = true;
            this.searchBar?.classList.remove('hidden');
            this.searchInput?.focus();
            this.searchInput?.select();
        },

        close() {
            this.isOpen = false;
            this.searchBar?.classList.add('hidden');
            if (this.searchCount) this.searchCount.textContent = '';

            const activeSession = SessionManager.getActiveSession();
            if (activeSession) {
                TerminalManager.clearSearch(activeSession);
            }

            // Route through the shared focus policy: desktop -> the terminal's
            // hidden textarea; on mobile/touch it is a no-op (v3 strict focus
            // rule -- closing search must not summon the keyboard;
            // only direct composer interaction focuses the input).
            SessionManager.focusActivePane();
        },

        toggle() {
            if (this.isOpen) {
                this.close();
            } else {
                this.open();
            }
        },

        /*
         * P4 / mockup line 185: the counter reads "2 / 5" -- the ACTIVE match
         * position over the total. Before this it only ever showed the hardcoded
         * English "No matches" or an empty string, so a user searching a long
         * scrollback had no idea how many hits existed or where they were.
         *
         * The numbers come from the search addon's own onDidChangeResults, cached
         * per terminal by TerminalManager (getSearchResults). They are NOT
         * recomputed here: counting matches a second time in the chrome layer
         * would drift from what the addon actually highlighted.
         *
         * resultIndex is 0-based, and the addon documents -1 as "the match
         * threshold was exceeded, position unknown". Those are different states
         * and are rendered differently: a known position becomes "N / M", an
         * unknown one falls back to the total alone rather than inventing an
         * index. A found match with no event yet (an addon build without the
         * event) also shows nothing rather than a wrong number.
         */
        renderCount(found) {
            if (!this.searchCount) return;
            const term = this.searchInput?.value || '';
            const activeSession = SessionManager.getActiveSession();
            if (!activeSession || !term) {
                this.searchCount.textContent = '';
                return;
            }
            if (!found) {
                this.searchCount.textContent = window.i18n
                    ? i18n.t('terminal.searchNoMatches')
                    : 'No matches';
                return;
            }
            const results = TerminalManager.getSearchResults(activeSession);
            if (!results || !results.resultCount) {
                this.searchCount.textContent = '';
                return;
            }
            this.searchCount.textContent = results.resultIndex >= 0
                ? `${results.resultIndex + 1} / ${results.resultCount}`
                : `${results.resultCount}`;
        },

        performSearch() {
            const term = this.searchInput?.value || '';
            const activeSession = SessionManager.getActiveSession();

            if (!activeSession || !term) {
                if (this.searchCount) this.searchCount.textContent = '';
                if (activeSession) TerminalManager.clearSearch(activeSession);
                return;
            }

            const found = TerminalManager.findNext(activeSession, term, { incremental: true });
            this.renderCount(found);
        },

        findNext() {
            const term = this.searchInput?.value || '';
            const activeSession = SessionManager.getActiveSession();

            if (!activeSession || !term) return;

            const found = TerminalManager.findNext(activeSession, term, { incremental: false });
            this.renderCount(found);
        },

        findPrevious() {
            const term = this.searchInput?.value || '';
            const activeSession = SessionManager.getActiveSession();

            if (!activeSession || !term) return;

            const found = TerminalManager.findPrevious(activeSession, term);
            this.renderCount(found);
        }
    };

    window.TerminalSearch = TerminalSearch;

    const FilePreview = {
        modal: null,
        currentSessionId: null,
        currentPath: null,
        currentFilename: null,
        editMode: false,
        dirty: false,
        editEncoding: 'utf-8',
        editNewline: 'lf',
        maxEditFileSize: 5 * 1024 * 1024,
        _beforeUnloadHandler: null,

        textExtensions: ['.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.ini', '.conf', '.cfg', '.env', '.gitignore', '.dockerignore', '.editorconfig'],
        codeExtensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte'],
        logExtensions: ['.log', '.out', '.err'],
        imageExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'],

        init() {
            this.modal = document.getElementById('filePreviewModal');
            if (!this.modal) {
                console.error('[FilePreview] Modal not found: filePreviewModal');
                return;
            }
            console.log('[FilePreview] Initialized successfully');

            const sizeMeta = document.querySelector('meta[name="max-editor-file-size"]');
            const parsedSize = sizeMeta ? parseInt(sizeMeta.content, 10) : NaN;
            if (!isNaN(parsedSize) && parsedSize > 0) {
                this.maxEditFileSize = parsedSize;
            }

            document.getElementById('closeFilePreviewModal')?.addEventListener('click', () => this.close());

            this.modal.addEventListener('click', (e) => {
                if (e.target === this.modal) {
                    this.close();
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.modal.classList.contains('show')) {
                    this.close();
                }
            });

            document.getElementById('previewCopyBtn')?.addEventListener('click', () => this.copyToClipboard());
            document.getElementById('previewDownloadBtn')?.addEventListener('click', () => this.downloadFile());
            document.getElementById('previewRefreshBtn')?.addEventListener('click', () => this.refresh());
            document.getElementById('previewBinaryDownload')?.addEventListener('click', () => this.downloadFile());
            document.getElementById('previewEditBtn')?.addEventListener('click', () => this.enterEditMode());
            document.getElementById('editorSaveBtn')?.addEventListener('click', () => this.saveEdit());
            document.getElementById('editorCancelBtn')?.addEventListener('click', () => this.cancelEdit());
            document.getElementById('editorContent')?.addEventListener('input', () => this.markDirty());

            socket.off('preview_data');
            socket.off('preview_error');
            socket.off('edit_data');
            socket.off('edit_error');
            socket.off('file_saved');
            socket.on('preview_data', (data) => {
                this.handlePreviewData(data);
            });
            socket.on('preview_error', (data) => {
                this.handlePreviewError(data);
            });
            socket.on('edit_data', (data) => {
                this.handleEditData(data);
            });
            socket.on('edit_error', (data) => {
                this.handleEditError(data);
            });
            socket.on('file_saved', (data) => {
                this.handleFileSaved(data);
            });
        },

        getFileType(filename) {
            const ext = '.' + filename.split('.').pop().toLowerCase();
            if (this.imageExtensions.includes(ext)) return 'image';
            if (this.logExtensions.includes(ext)) return 'log';
            if (this.codeExtensions.includes(ext)) return 'code';
            if (this.textExtensions.includes(ext)) return 'text';
            if (!filename.includes('.')) return 'text';
            return 'unknown';
        },

        getLanguage(filename) {
            const ext = filename.split('.').pop().toLowerCase();
            const langMap = {
                'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript', 'tsx': 'typescript',
                'py': 'python', 'rb': 'ruby', 'php': 'php', 'java': 'java',
                'c': 'c', 'cpp': 'cpp', 'h': 'c', 'hpp': 'cpp', 'cs': 'csharp',
                'go': 'go', 'rs': 'rust', 'swift': 'swift', 'kt': 'kotlin', 'scala': 'scala',
                'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
                'ps1': 'powershell', 'bat': 'dos', 'cmd': 'dos',
                'sql': 'sql', 'html': 'html', 'htm': 'html', 'xml': 'xml',
                'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less',
                'json': 'json', 'yaml': 'yaml', 'yml': 'yaml',
                'md': 'markdown', 'vue': 'html', 'svelte': 'html',
                'ini': 'ini', 'conf': 'ini', 'cfg': 'ini',
                'dockerfile': 'dockerfile'
            };
            return langMap[ext] || 'plaintext';
        },

        formatFileSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        },

        open(sessionId, path, filename) {
            console.log('[FilePreview] open called:', { sessionId, path, filename });
            this.currentSessionId = sessionId;
            this.currentPath = path;
            this.currentFilename = filename;

            // Start every open in a clean (non-edit) state.
            this.editMode = false;
            this.dirty = false;
            this.detachBeforeUnload();
            document.getElementById('fileEditor')?.classList.add('hidden');
            this.modal?.classList.remove('editing');
            this.hideEditButton();
            this.showPreviewActions();

            const fileType = this.getFileType(filename);
            console.log('[FilePreview] File type:', fileType);

            this.showLoading();
            window.ModalManager.open(this.modal);

            document.getElementById('previewFilename').textContent = filename;
            document.getElementById('previewSize').textContent = '';

            if (fileType === 'image') {
                console.log('[FilePreview] Loading image...');
                this.loadImage(sessionId, path, filename);
            } else {
                const options = { session_id: sessionId, path: path };

                if (fileType === 'log') {
                    options.tail_lines = 1000;
                }

                console.log('[FilePreview] Emitting preview_file:', options);
                socket.emit('preview_file', options);
            }
        },

        loadImage(sessionId, path, filename) {
            if (this._pendingImageHandler) {
                socket.off('file_download_ready_binary', this._pendingImageHandler);
                this._pendingImageHandler = null;
            }

            const requestPath = path;
            socket.emit('download_file_binary', {
                session_id: sessionId,
                remote_path: path,
                for_preview: true
            });

            const handleBinaryDownload = (data) => {
                if (!data.for_preview) return;

                socket.off('file_download_ready_binary', handleBinaryDownload);
                this._pendingImageHandler = null;

                if (this.currentPath !== requestPath) return;

                if (data.error) {
                    this.showError(data.error);
                    return;
                }

                try {
                    const mimeType = this.getMimeType(filename);
                    let url;

                    if (data.encoding === 'base64') {
                        url = `data:${mimeType};base64,${data.file_data}`;
                    } else {
                        let binaryData = data.file_data;
                        if (binaryData && typeof binaryData === 'object') {
                            if (binaryData.data && Array.isArray(binaryData.data)) {
                                binaryData = new Uint8Array(binaryData.data);
                            } else if (binaryData instanceof ArrayBuffer) {
                                binaryData = new Uint8Array(binaryData);
                            }
                        }
                        const blob = new Blob([binaryData], { type: mimeType });
                        url = URL.createObjectURL(blob);
                    }

                    this.hideLoading();
                    this.showImage(url, data.size);
                } catch (err) {
                    this.showError('Failed to display image: ' + err.message);
                }
            };

            this._pendingImageHandler = handleBinaryDownload;
            socket.on('file_download_ready_binary', handleBinaryDownload);
        },

        getMimeType(filename) {
            const ext = filename.split('.').pop().toLowerCase();
            const mimeTypes = {
                'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
                'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
                'ico': 'image/x-icon', 'bmp': 'image/bmp'
            };
            return mimeTypes[ext] || 'application/octet-stream';
        },

        handlePreviewData(data) {
            this.hideLoading();

            document.getElementById('previewSize').textContent = this.formatFileSize(data.size);

            if (data.is_binary) {
                this.hideEditButton();
                this.showBinary();
                return;
            }

            this.showContent(data.content, data.filename, data.truncated, data.read_size, data.size);

            // Entering edit mode re-reads the full file (up to the editor limit)
            // via open_file_for_edit, so a truncated preview is safe to edit.
            // Gate only on the real file size, not on the 512KB preview cap.
            if (data.size <= this.maxEditFileSize) {
                this.showEditButton();
            } else {
                this.hideEditButton();
            }
        },

        handlePreviewError(data) {
            this.hideLoading();
            this.showError(data.error);
        },

        showLoading() {
            document.getElementById('previewLoading')?.classList.remove('hidden');
            document.getElementById('previewError')?.classList.add('hidden');
            document.getElementById('previewBinary')?.classList.add('hidden');
            document.getElementById('previewImage')?.classList.add('hidden');
            document.getElementById('previewContent')?.classList.add('hidden');
            document.getElementById('previewTruncated')?.classList.add('hidden');
            document.getElementById('fileEditor')?.classList.add('hidden');
        },

        hideLoading() {
            document.getElementById('previewLoading')?.classList.add('hidden');
        },

        showError(message) {
            document.getElementById('previewError')?.classList.remove('hidden');
            document.getElementById('previewErrorMessage').textContent = message;
        },

        showBinary() {
            document.getElementById('previewBinary')?.classList.remove('hidden');
        },

        showImage(url, size) {
            const imageContainer = document.getElementById('previewImage');
            const imageElement = document.getElementById('previewImageElement');

            imageContainer?.classList.remove('hidden');
            document.getElementById('previewSize').textContent = this.formatFileSize(size);

            if (imageElement.src && imageElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(imageElement.src);
            }

            imageElement.onload = () => {};
            imageElement.onerror = (e) => {
                imageContainer?.classList.add('hidden');
                this.showError('Failed to load image');
            };

            imageElement.src = url;
        },

        showContent(content, filename, truncated, readSize, totalSize) {
            const contentDiv = document.getElementById('previewContent');
            const codeEl = document.getElementById('previewCode');
            const lineNumbersEl = document.getElementById('previewLineNumbers');

            contentDiv?.classList.remove('hidden');

            // Keep the raw content for an accurate copy; for display, drop a
            // single trailing newline so the file's terminator isn't rendered
            // (and numbered) as a spurious empty last line.
            this._previewFullContent = content;
            const display = content.replace(/\n$/, '');
            codeEl.textContent = display;

            const language = this.getLanguage(filename);
            if (typeof hljs !== 'undefined') {
                codeEl.className = `language-${language}`;
                hljs.highlightElement(codeEl);
            }

            const lineCount = display === '' ? 1 : display.split('\n').length;
            lineNumbersEl.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');

            if (truncated) {
                document.getElementById('previewTruncated')?.classList.remove('hidden');
                document.getElementById('previewTruncatedSize').textContent = this.formatFileSize(readSize);
                document.getElementById('previewTotalSize').textContent = this.formatFileSize(totalSize);
            }
        },

        copyToClipboard() {
            const codeEl = document.getElementById('previewCode');
            if (!codeEl) return;

            const text = this._previewFullContent != null ? this._previewFullContent : codeEl.textContent;
            navigator.clipboard.writeText(text).then(() => {
                showNotification('Copied to clipboard', 'success');
            }).catch(() => {
                showNotification('Failed to copy', 'error');
            });
        },

        downloadFile() {
            if (!this.currentSessionId || !this.currentPath) return;

            socket.emit('download_file_binary', {
                session_id: this.currentSessionId,
                remote_path: this.currentPath
            });
        },

        // ---- Inline editor ----
        showEditButton() {
            document.getElementById('previewEditBtn')?.classList.remove('hidden');
        },

        hideEditButton() {
            document.getElementById('previewEditBtn')?.classList.add('hidden');
        },

        showPreviewActions() {
            ['previewCopyBtn', 'previewDownloadBtn', 'previewRefreshBtn'].forEach(id => {
                document.getElementById(id)?.classList.remove('hidden');
            });
        },

        hidePreviewActions() {
            ['previewCopyBtn', 'previewDownloadBtn', 'previewRefreshBtn', 'previewEditBtn'].forEach(id => {
                document.getElementById(id)?.classList.add('hidden');
            });
        },

        attachBeforeUnload() {
            if (this._beforeUnloadHandler) return;
            this._beforeUnloadHandler = (e) => {
                if (this.dirty) {
                    e.preventDefault();
                    e.returnValue = '';
                }
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        },

        detachBeforeUnload() {
            if (this._beforeUnloadHandler) {
                window.removeEventListener('beforeunload', this._beforeUnloadHandler);
                this._beforeUnloadHandler = null;
            }
        },

        markDirty() {
            if (!this.editMode) return;
            this.dirty = true;
            const status = document.getElementById('editorStatus');
            if (status) {
                status.textContent = window.i18n ? i18n.t('editor.unsavedChanges') : 'Unsaved changes';
            }
        },

        enterEditMode() {
            if (!this.currentSessionId || !this.currentPath) return;
            const status = document.getElementById('editorStatus');
            if (status) status.textContent = '';
            socket.emit('open_file_for_edit', {
                session_id: this.currentSessionId,
                path: this.currentPath
            });
        },

        handleEditData(data) {
            // Ignore responses for a file the user has since navigated away from.
            if (!data || data.path !== this.currentPath) return;

            const textarea = document.getElementById('editorContent');
            if (!textarea) return;

            this.editEncoding = data.encoding || 'utf-8';
            this.editNewline = data.newline || 'lf';
            textarea.value = data.content || '';

            document.getElementById('previewContent')?.classList.add('hidden');
            document.getElementById('previewTruncated')?.classList.add('hidden');
            document.getElementById('previewError')?.classList.add('hidden');
            document.getElementById('fileEditor')?.classList.remove('hidden');
            this.modal?.classList.add('editing');
            this.hidePreviewActions();

            this.editMode = true;
            this.dirty = false;
            const status = document.getElementById('editorStatus');
            if (status) status.textContent = '';
            this.attachBeforeUnload();
            textarea.focus();
        },

        handleEditError(data) {
            const msg = (data && data.error) ? data.error
                : (window.i18n ? i18n.t('editor.saveFailed') : 'Failed to open file');
            showNotification(msg, 'error');
        },

        saveEdit() {
            if (!this.editMode || !this.currentSessionId || !this.currentPath) return;
            const textarea = document.getElementById('editorContent');
            if (!textarea) return;

            const status = document.getElementById('editorStatus');
            if (status) status.textContent = window.i18n ? i18n.t('editor.saving') : 'Saving...';

            socket.emit('save_file', {
                session_id: this.currentSessionId,
                path: this.currentPath,
                content: textarea.value,
                encoding: this.editEncoding,
                newline: this.editNewline
            });
        },

        handleFileSaved(data) {
            if (!data || data.path !== this.currentPath) return;
            this.dirty = false;
            this.detachBeforeUnload();
            showNotification(window.i18n ? i18n.t('editor.saved') : 'File saved', 'success');
            // Leave edit mode and reload the preview to reflect the saved file.
            this.exitEditMode();
            this.refresh();
        },

        cancelEdit() {
            if (this.dirty) {
                const msg = window.i18n ? i18n.t('editor.unsavedConfirm') : 'Discard unsaved changes?';
                if (!window.confirm(msg)) return;
            }
            this.exitEditMode();
            // The preview content is still rendered underneath; just reveal it.
            document.getElementById('previewContent')?.classList.remove('hidden');
        },

        exitEditMode() {
            this.editMode = false;
            this.dirty = false;
            this.detachBeforeUnload();
            document.getElementById('fileEditor')?.classList.add('hidden');
            this.modal?.classList.remove('editing');
            const status = document.getElementById('editorStatus');
            if (status) status.textContent = '';
            this.showPreviewActions();
            this.showEditButton();
        },

        refresh() {
            if (!this.currentSessionId || !this.currentPath) return;

            const filename = this.currentPath.split('/').pop();
            this.open(this.currentSessionId, this.currentPath, filename);
        },

        close() {
            if (this.editMode && this.dirty) {
                const msg = window.i18n ? i18n.t('editor.unsavedConfirm') : 'Discard unsaved changes?';
                if (!window.confirm(msg)) return;
            }
            this.detachBeforeUnload();
            this.editMode = false;
            this.dirty = false;
            document.getElementById('fileEditor')?.classList.add('hidden');
            this.modal?.classList.remove('editing');

            window.ModalManager.close(this.modal);
            this.currentSessionId = null;
            this.currentPath = null;
            this.currentFilename = null;

            const imgEl = document.getElementById('previewImageElement');
            if (imgEl && imgEl.src.startsWith('blob:')) {
                URL.revokeObjectURL(imgEl.src);
                imgEl.src = '';
            }
        }
    };

    window.FilePreview = FilePreview;

    // Single keep-alive timer. Declared once; both start sites (load and
    // reconnect) go through the one guarded starter, so a healthy session can
    // never run two identical 60s timers. Cleared on 'disconnect' and restarted
    // by the next 'connect'. The immediate load-time start is preserved on
    // purpose: it must not depend on 'connect' delivery ordering (the socket is
    // created at the top of this file, before any listener is registered).
    let keepAliveInterval = null;
    const startKeepAliveTimer = () => {
        if (keepAliveInterval) return;
        keepAliveInterval = setInterval(() => {
            if (socket.connected) {
                socket.emit('keep_alive');
            }
        }, 60000);
    };

    /*
     * A page's FIRST connect is not a reconnect, and resetting on it costs a
     * whole extra attach round.
     *
     * Measured 2026-09-20, stacks recorded at the emit: every session sent
     * view_attach TWICE on a load -- once from syncViews (applyActiveSession),
     * then 2ms later from syncViews again, called by resetSocketEpoch out of
     * this handler. The attaches this page had already sent were BUFFERED by
     * socket.io and go out on this very socket, so there was nothing stale to
     * forget; the reset simply threw them away and re-sent them.
     *
     * It cost two things. The doubled burst is half of what pushed the startup
     * payload past the 16 packets python-engineio will decode (the defect this
     * branch is fixing). And the attach that survived carried `history:false`,
     * because the first one had already claimed the one-shot -- so a page whose
     * first attach was the one discarded never pulled its scrollback at all.
     *
     * A reconnect still resets, which is what this call is for: it runs under a
     * NEW socket sid, the server's client-size registry is keyed by sid, and the
     * tmux clients opened on the old socket are gone with it.
     */
    let socketHasConnectedBefore = false;

    socket.on('connect', () => {
        console.log('Connected to server');
        const reconnectBar = document.getElementById('reconnectBar');
        if (reconnectBar && reconnectBar.style.display !== 'none') {
            reconnectBar.style.display = 'none';
            showNotification('Reconnected!', 'success', 2000);
        }
        startKeepAliveTimer();
        /*
         * A reconnect runs under a NEW socket
         * sid, and the server's client-size registry is keyed by sid -- the
         * entries this client recorded before the drop are gone from it. Bump
         * the proposal-dedupe epoch so the next fit re-proposes its current
         * size once and the resize authority sees this client again; without
         * it a window that never changes size would stay invisible to the
         * registry until the socket died again.
         */
        if (socketHasConnectedBefore) {
            window.TerminalManager?.resetSocketEpoch();
        }
        socketHasConnectedBefore = true;
        /*
         * The tmux clients this page held were opened on the OLD socket's
         * channels, so the server closed them when that socket went away.
         * resetSocketEpoch above has already forgotten them and re-attached
         * whatever is displayed, which is also what re-sends this page's real
         * size -- there is no separate visibility ledger to re-declare any
         * more, because a size only exists while a client is attached.
         */
    });

    startKeepAliveTimer();

    socket.io.on('reconnect_attempt', (attempt) => {
        const reconnectBar = document.getElementById('reconnectBar');
        if (reconnectBar) {
            const textEl = reconnectBar.querySelector('.reconnect-text');
            if (textEl) {
                textEl.textContent = `Connection lost. Reconnecting... (attempt ${attempt})`;
            }
        }
    });

    /*
     * THE SOCKET HEALS ITSELF, OR IT SAYS WHY IT CANNOT.
     * ========================================================================
     * OWNER REPORT: "thuong xuyen dut het noi neu lau khong thao
     * tac hoac chuyen tab khac. Quay lai cung khong the reconnect lai duoc
     * phai tai lai trang."
     *
     * Measured in the server log: the socket drops, the reconnect handshake
     * arrives with no `_user_id`, the server answers `unauthenticated` and
     * Calls disconnect. Socket.IO v4 treats a server-side disconnect as
     * final -- reason "io server disconnect" switches auto-reconnect OFF --
     * so the page sat there with a dead socket until the owner reloaded, and
     * a reload logged straight back in because the browser still held a
     * remember cookie. Two repairs, in the order they are reached:
     *
     *   1. the SERVER now resolves that remember cookie itself, so the
     *      handshake usually succeeds where it used to be refused;
     *   2. when it genuinely cannot (no credential left at all), the page
     *      does what the owner was doing by hand -- go to /login, which
     *      bounces straight back if the credential was merely stale, and
     *      otherwise shows the form. Once per 30s, so a login page that
     *      keeps refusing cannot become a redirect loop.
     */
    const REAUTH_GUARD_KEY = 'sshdeck.reauthAt';
    const REAUTH_GUARD_MS = 30000;

    function reauthenticate() {
        let last = 0;
        try {
            last = parseInt(sessionStorage.getItem(REAUTH_GUARD_KEY) || '0', 10) || 0;
        } catch (e) {
            last = 0;
        }
        if (Date.now() - last < REAUTH_GUARD_MS) {
            // Already tried; a second bounce would be a loop. Say so instead.
            const bar = document.getElementById('reconnectBar');
            if (bar) {
                const text = window.i18n
                    ? window.i18n.t('session.signInAgain', 'Session expired. Sign in again.')
                    : 'Session expired. Sign in again.';
                bar.innerHTML = '';
                const span = document.createElement('span');
                span.className = 'reconnect-text';
                span.textContent = text + ' ';
                const link = document.createElement('a');
                link.href = APP_ROOT + '/login';
                link.textContent = window.i18n
                    ? window.i18n.t('auth.login', 'Login') : 'Login';
                span.appendChild(link);
                bar.appendChild(span);
                bar.style.display = 'flex';
            }
            return;
        }
        try {
            sessionStorage.setItem(REAUTH_GUARD_KEY, String(Date.now()));
        } catch (e) {
            // A private window with no storage still gets one attempt.
        }
        const here = window.location.pathname + window.location.search;
        window.location.replace(APP_ROOT + '/login?next=' + encodeURIComponent(here));
    }

    /*
     * Wake a socket that stopped trying. A phone that sleeps, a tab left in
     * the background and a laptop that lost wifi all end with a socket that
     * is not connected and, after a server-side refusal, not retrying either.
     * Every edge where the page is in front of a person again asks it to try
     * once more; when it is already connected this costs one property read.
     *
     * A socket that is still TRYING (`active`: connecting, or in Socket.IO's
     * own backoff) is left alone. Measured 2026-09-24 against a local server:
     * the load's own pageshow reached here while the first handshake was in
     * flight, connect() sent a second CONNECT on the same engine session, the
     * server answered `44"Unable to connect"` and dropped the session -- while
     * the page went on reporting itself connected, and every emit after it
     * went nowhere. `active` turns false only when the library has given up
     * (the "io server disconnect" case above), which is the one this is for.
     */
    function wakeSocket() {
        if (!window.socket || window.socket.connected || window.socket.active) {
            return;
        }
        try {
            window.socket.connect();
        } catch (e) {
            console.error('[SSHDeck] Could not wake the socket:', e);
        }
    }
    window.__wakeSocket = wakeSocket;

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            wakeSocket();
        }
    });
    window.addEventListener('pageshow', wakeSocket);
    window.addEventListener('online', wakeSocket);
    window.addEventListener('focus', wakeSocket);

    socket.on('connected', (data) => {
        if (data && data.status === 'unauthenticated') {
            reauthenticate();
            return;
        }
        if (data && data.status === 'success' && window.socket) {
            try {
                sessionStorage.removeItem(REAUTH_GUARD_KEY);
            } catch (e) {
                // Nothing to clear; the guard expires on its own.
            }
            window.socket.emit('get_notepad');
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        showNotification('Disconnected from server', 'error');
        const reconnectBar = document.getElementById('reconnectBar');
        if (reconnectBar) {
            reconnectBar.style.display = 'flex';
        }
        /*
         * "io server disconnect" is the one reason Socket.IO will not retry
         * by itself: the server hung up deliberately, so the library assumes
         * it meant it. Here it means the handshake was refused, which the
         * `connected` handler above has already answered if a credential was
         * the problem. Otherwise try once more after a second.
         */
        if (reason === 'io server disconnect') {
            setTimeout(wakeSocket, 1000);
        }
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        /*
         * Retirements whose ack can no longer arrive. Drop the records
         * and keep the candidates -- never remove UI on an assumption (the
         * deletion may or may not have landed server-side). The candidates stay
         * resettable; the next reload reconciles anything already deleted.
         *
         * The same socket death also ends every in-flight candidate
         * Reset (confirmation armed, form open, connect pending): its frames
         * can no longer complete, so the double-trigger guards are dropped and
         * each candidate becomes resettable again at once.
         */
        SessionManager.abortPendingCandidateRetirements();
        SessionManager.abortInFlightCandidateResets();
    });

    socket.on('ssh_connected', (data) => {
        console.log('SSH connected:', data);

        // Capture the request-keyed non-secret metadata BEFORE the pending
        // record is cleared, then pass it into createSession so the right
        // jumpHostId lands on the right session (no global handoff).
        const pending = data.client_request_id
            ? SessionManager.takePendingConnection(data.client_request_id)
            : null;

        if (connectTimer) {
            clearInterval(connectTimer);
            connectTimer = null;
            const connectBtn = document.getElementById('connectBtn');
            if (connectBtn) {
                connectBtn.textContent = 'Connect';
            }
        }

        setConnectLoading(false);
        currentConnectRequestId = null;

        /*
         * W14 item 8: complete a pending save-as-profile on SUCCESS.
         *
         * Only the request the user submitted with the checkbox checked has an
         * entry here, and it is consumed exactly once. The emit stays in
         * ProfileManager.saveProfile (profile-manager.js); app.js never emits
         * save_profile itself, so the auto-launch decoupling is preserved in
         * substance. A failed connect never reaches this handler, so nothing is
         * saved on failure. The checkbox and name field reset for the next open.
         */
        if (data.client_request_id
            && pendingProfileSaveMap.has(data.client_request_id)) {
            const profilePayload = pendingProfileSaveMap.get(data.client_request_id);
            pendingProfileSaveMap.delete(data.client_request_id);
            ProfileManager.saveProfile(profilePayload);
        }

        /*
         * Learn the server's replay line cap BEFORE createSession builds
         * the terminal, exactly as restoreSession does. The client's scrollback
         * capacity is DERIVED from this number, and the terminal about to be
         * created is the one that has to hold the tmux history this same payload
         * is announcing -- so learning it afterwards would be too late for the
         * session that needs it.
         */
        TerminalManager.noteServerReplayLines(data.replay_max_lines);

        const sessionId = SessionManager.createSession(data, pending);

        /*
         * Open the replay window when this connect carries scrollback.
         *
         * tmux repaints its window rather than scrolling it, so nothing this
         * client receives can fill xterm's scrollback -- the history lives in
         * tmux. The server reads it once per attach and delivers it as a plain
         * line stream through the SAME sequenced replay path a reload uses, so
         * the window is opened here, synchronously with the session event,
         * before the first chunk can arrive. Zero chunks (a plain SSH session,
         * or a fresh tmux pane with nothing above its screen) opens nothing at
         * all -- and must not, because a window with nothing to replay queues
         * every live frame behind a terminator that never comes.
         */
        if (Number.isInteger(data.replay_total_chunks)
            && data.replay_total_chunks > 0) {
            TerminalManager.beginReplay(sessionId, data.replay_total_chunks);
        }

        /*
         * A password reconnect completes HERE, not at emit time.
         *
         * The server has no stored password, so this route came back through
         * ssh_connect and therefore owns a NEW session id -- while the tmux
         * session on the host is the same one, reattached by name. So the old
         * client-side session is retired only now, once its replacement exists,
         * and its transcript is carried across first. Retiring it earlier (as
         * Reset does) would leave the user with nothing if the connect failed,
         * and retiring it with closeSession would kill the tmux session the new
         * connection has just reattached to.
         *
         * The client_request_id is what makes it exact: only the intent that
         * owns THIS request may retire a session. An ordinary connect, or a
         * different reconnect still in flight, finds no intent under its id and
         * changes nothing -- so responses arriving in any order cannot retire or
         * adopt the wrong candidate.
         */
        SessionManager.completePendingReconnect(sessionId, data.client_request_id);
        /*
         * A CANDIDATE Reset completes here too, and only here.
         *
         * It emitted its fresh `use_tmux:false` payload without destroying
         * anything, because a candidate has no transport to close and losing the
         * offer to a cancelled or failed attempt is worse than doing nothing. Now
         * that the replacement session exists, the exact old candidate named by
         * THIS request's id is retired through the product's own disconnect path,
         * which deletes the persisted row so the discarded offer does not
         * reappear on the next reload. For a candidate that path kills no tmux
         * (no in-RAM session, so close_session returns False) — the documented
         * non-killing semantics the confirmation copy promises. A live Reset is
         * unaffected: it closed its session at emit time and registers no
         * retirement intent.
         */
        SessionManager.completePendingReset(sessionId, data.client_request_id);

        let targetPane = null;
        if (data.client_request_id && pendingRequestPaneMap.has(data.client_request_id)) {
            targetPane = pendingRequestPaneMap.get(data.client_request_id);
            pendingRequestPaneMap.delete(data.client_request_id);
        }
        if (targetPane === null || targetPane === undefined) {
            const emptyIndex = SessionManager.getFirstEmptyPaneIndex();
            targetPane = emptyIndex !== -1 ? emptyIndex : null;
        }
        // No free pane: the new session is shown solo. It never evicts a
        // pane's session.
        if (targetPane === null) {
            SessionManager.setSolo(sessionId);
        } else {
            SessionManager.assignSessionToPane(sessionId, targetPane);
        }

        window.ModalManager.close(document.getElementById('connectionModal'));
        processPaneQueue();

        const connMsg = data.via_jump
            ? `Connected to ${data.username}@${data.host} via ${data.via_jump}`
            : `Connected to ${data.username}@${data.host}`;
        showNotification(connMsg, 'success');

        ConnectionHistory.addConnection(data.host, data.port, data.username);

        FileTransferManager.updateSessionSelects();

        // Start (or keep) the per-session latency poll now that there is a
        // transport to time. Idempotent -- startLatencyPolling returns early if
        // the timer already exists.
        SessionManager.startLatencyPolling();
    });

    // Mockup line 87: each chip's <small> reads "user · NN ms", and the
    // figure is that session's OWN SSH round trip, measured server-side by
    // ssh_manager.measure_session_latency. Only a session id and an integer
    // arrive here.
    socket.on('session_latency', (data) => {
        if (!data || !data.session_id) return;
        SessionManager.applySessionLatency(data.session_id, data.latency_ms);
    });

    socket.on('ssh_output', (data) => {
        /*
         * A malformed frame must not take the WRITE down with it. This line
         * used to read `data.data.length` before the write below, so a frame
         * without that field threw here and the output never reached the
         * terminal at all.
         *
         * And the log itself is now behind ?kbdebug=1. Measured cost is small
         * (23µs a call, 0.06% of a core at the three-pane streaming rate, 0.7%
         * at 300 frames a second), so this is not about speed: it is that a
         * line per frame buries whatever a reader opened the console FOR, and
         * the diagnostic that replaced it (?kbdebug=1 plus the screen
         * diagnostic, which records the real bytes) says far more.
         */
        if (!data || typeof data.data !== 'string') {
            return;
        }
        if (TerminalManager.keyboardDebugEnabled()) {
            console.log(`[SSH_OUTPUT] session ${data.session_id}, ${data.data.length} bytes`);
        }
        TerminalManager.writeOutput(data.session_id, data.data);
    });

    socket.on('ssh_error', (data) => {
        console.error('SSH error:', data);
        showNotification(`SSH Error: ${data.error}`, 'error');

        if (connectTimer) {
            clearInterval(connectTimer);
            connectTimer = null;
            const connectBtn = document.getElementById('connectBtn');
            if (connectBtn) {
                connectBtn.textContent = 'Connect';
            }
        }

        setConnectLoading(false);
        /*
         * `requestId` here is the LENIENT id, and it stays lenient ONLY for the
         * pending-chip and pane-map bookkeeping below: an old server that echoed
         * nothing must still be able to clear the spinner it started.
         */
        const requestId = data.client_request_id || currentConnectRequestId;
        if (requestId) {
            SessionManager.clearPendingConnection(requestId);
            if (requestId === currentConnectRequestId) {
                currentConnectRequestId = null;
            }
            if (pendingRequestPaneMap.has(requestId)) {
                pendingRequestPaneMap.delete(requestId);
            }
            /*
             * W14 item 8: a FAILED connect must not leave a pending profile save
             * behind -- the box was checked for this attempt only. Consumed here
             * rather than on the success path, so a later successful (different)
             * request cannot accidentally fire it.
             */
            if (pendingProfileSaveMap.has(requestId)) {
                pendingProfileSaveMap.delete(requestId);
            }
        }
        /*
         * A FAILED reconnect must leave the user exactly where they were.
         *
         * Nothing was destroyed on the way out (the candidate chip and the live
         * transport are both deliberately kept until the replacement exists), so
         * the only thing to undo is THIS request's intent, plus the credential
         * modal if THIS request is the one holding it. Otherwise the session
         * stays claimed and every later press returns silently against the
         * one-owner guard.
         *
         * ONLY `data.client_request_id`. The fallback to currentConnectRequestId
         * was wrong and had to go: that variable tracks whatever connect the FORM
         * most recently submitted, which is routinely a different request from the
         * one that failed. An uncorrelated ssh_error would then abandon an
         * unrelated reconnect -- dropping its intent so its reply could no longer
         * retire its chip or carry its transcript, and releasing a credential
         * modal another request still owned. An error the server did not name
         * must abandon NOTHING; every ssh_connect error path echoes the id
         * (including the outer exception handler), so a missing one is a server
         * bug to fix, not a gap to paper over here.
         *
         * Deliberately NOT resetConnectionModalIntent: that is the user-dismissal
         * cleanup and would also clear pendingResetMeta and hide the banner, so
         * one background reconnect failing could wipe a Reset the user is still
         * typing into.
         */
        if (data.client_request_id) {
            SessionManager.abandonReconnectRequest(data.client_request_id);
            // A failed candidate Reset drops only its retirement record. The
            // candidate itself was deliberately preserved through the attempt, so
            // the offer, its chip and its label are still there to try again.
            SessionManager.abandonResetRequest(data.client_request_id);
        }
    });

    /*
     * The CORRELATED ANSWER to a candidate retirement.
     *
     * `candidate_reset` is the retirement's only destructive act -- the DB row
     * deletion -- and these two frames are the only authority on how it went.
     * The ack purges the UI (chip, terminal, listeners, selection) through
     * completeCandidateRetirement; the error keeps everything and tells the
     * user. Neither acts on a request_id it does not own, so interleaved
     * retirements and unrelated frames cannot cross-contaminate.
     */
    socket.on('candidate_reset_ack', (data) => {
        if (!data || !data.request_id) return;
        SessionManager.completeCandidateRetirement(data.session_id, data.request_id);
    });

    socket.on('candidate_reset_error', (data) => {
        if (!data || !data.request_id) return;
        const keptId = SessionManager.failCandidateRetirement(data.request_id);
        if (!keptId) return; // Not ours: an unrelated or already-settled frame.
        // Bare global on purpose: SessionManager is a top-level const of a
        // classic script, NOT a property of window -- a window.SessionManager
        // guard would be undefined and silently degrade the label to the raw
        // session id, which is exactly what the user should not see.
        const label = SessionManager.getDisplayLabel(keptId,
            SessionManager.sessions[keptId]?.username,
            SessionManager.sessions[keptId]?.host);
        const t = (key, fallback) => (window.i18n ? i18n.t(key) : fallback);
        showNotification(
            t('session.candidateResetFailed',
                'Could not drop the saved session "{label}". It has been kept; you can try again.')
                .replace('{label}', label),
            'error');
    });

    socket.on('tmux_copy_mode_exited', (data) => {
        // Re-enable the one Exit-scroll control regardless of outcome; it is
        // disabled on click to keep taps from stacking control commands.
        const exitScrollBtn = document.getElementById('exitScrollBtn');
        if (exitScrollBtn) exitScrollBtn.disabled = false;
        if (data?.ok && data?.session_id && window.TerminalManager) {
            TerminalManager.setScrollState(data.session_id, false);
            // Tmux exits copy-mode by
            // repainting at the bottom; the local viewport must agree with
            // the remote one or the button hides while the scrollback still
            // sits away from the bottom.
            if (data.was_in_mode) {
                TerminalManager.scrollSessionToBottom(data.session_id);
            }
        }
        // Four outcomes, not two. Reporting a no-op as "Exited scroll mode" is
        // what made this button feel broken: nothing on screen changed and the
        // toast claimed it had done something. Say which of the four happened.
        //
        // The fourth exists because "pane_in_mode=0" has two very different
        // meanings. When a foreground app owns the mouse (claude, vim, htop —
        // DECSET 1000/1002/1003) tmux forwards the wheel to that app and never
        // enters copy-mode, so 0 is the truthful answer while the user is very
        // much scrolling — just inside the app, whose scroll this button cannot
        // reach. Saying "not in scroll mode" there reads as the button failing to
        // recognise the state. TerminalManager.appOwnsMouse tells the two apart
        // locally, from the same condition tmux itself uses, so no extra server
        // round-trip is needed.
        const ok = !!(data && data.ok);
        const wasInMode = !!(data && data.was_in_mode);
        const sessionId = data && data.session_id;
        const appOwnsScroll = !wasInMode && ok
            && TerminalManager.appOwnsMouse(sessionId || SessionManager.getActiveSession());
        const key = !ok
            ? 'tmux.exitCopyModeFailed'
            : (wasInMode
                ? 'tmux.exitedCopyMode'
                : (appOwnsScroll ? 'tmux.appOwnsScroll' : 'tmux.notInCopyMode'));
        const fallback = {
            'tmux.exitCopyModeFailed': 'Could not exit scroll mode',
            'tmux.exitedCopyMode': 'Exited scroll mode',
            'tmux.notInCopyMode': 'Not in scroll mode',
            'tmux.appOwnsScroll': 'This app handles its own scrolling',
        }[key];
        showNotification(window.i18n ? i18n.t(key) : fallback,
                         ok ? (wasInMode ? 'success' : 'info') : 'error');
    });

    /*
     * The -- the ONE write funnel that can leave tmux copy mode.
     *
     * tmux discards every byte written to the attached client's channel while
     * the pane is in copy mode (measured: 'echo SENDTEST' + CR, \x7f and \x15 all
     * vanished, and a printable byte did not even move copy_cursor_y). With tmux
     * `mouse on` as the product default an ordinary upward swipe puts the pane
     * there, so after a scroll the composer's whole write path was silently
     * dead -- the user typed, pressed Send, and nothing happened.
     *
     * A byte the user deliberately sends is not a read: in every terminal,
     * typing while scrolled back returns you to the prompt. So the advisory
     * `leave_scroll` field rides the EXISTING ssh_input event (no new event, no
     * new module) and the server exits copy mode inline before writing. It is
     * set only when TerminalManager.writeNeedsScrollExit says this session's
     * scroll is tmux copy mode rather than xterm scrollback -- the same
     * isSessionScrolled/appOwnsMouse discrimination exitScrollAction already
     * makes, never a blind exit.
     *
     * After the write the local viewport must agree with the remote one, because
     * tmux leaves copy mode by repainting at the bottom. That is not a new
     * mechanism: it is exactly what the `tmux_copy_mode_exited` handler above
     * does, the same two calls in the same order.
     */
    window.emitTerminalInput = (sessionId, data) => {
        if (!window.socket || !sessionId) return false;
        const payload = { session_id: sessionId, data };
        /*
         * A mouse tracking report is NOT a deliberate write, so it never
         * carries the advisory. The premise above ("a byte the user deliberately
         * sends is not a read") does not hold for the bytes that ARE the scroll:
         * the touch gesture's synthesized wheels and a desktop wheel both arrive
         * here as SGR reports, and flagging them made the server exit copy mode
         * and then write those same reports into a live pane, where readline
         * printed them as raw text and swallowed the next write's first character
         * (measured on the deployment, /tmp/s26reg/s30_p8.log). Suppressing the
         * flag also stops the two reconciliation calls below from yanking the
         * viewport to the bottom in the middle of the user's own scroll gesture.
         * The rule itself, with the measurements, lives at
         * TerminalManager.dataIsMouseReport.
         */
        const leaving = !window.TerminalManager?.dataIsMouseReport(data)
            && !!window.TerminalManager?.writeNeedsScrollExit(sessionId);
        if (leaving) {
            payload.leave_scroll = true;
        }
        window.socket.emit('ssh_input', payload);
        if (leaving) {
            TerminalManager.scrollSessionToBottom(sessionId);
            TerminalManager.setScrollState(sessionId, false);
        }
        return true;
    };

    socket.on('ssh_disconnected', (data) => {
        console.log('SSH disconnected:', data);
        showNotification(`Session disconnected: ${data.reason}`, 'warning');
        SessionManager.updateSessionStatus(data.session_id, 'disconnected');
        FileTransferManager.updateSessionSelects();

        if (window.sftpFileManager) {
            window.sftpFileManager.handleSessionDisconnected(data.session_id);
        }
    });

    // A saved row another device deleted (reset, or a persistent session's
    // disconnect): the offer this page may still show for it is void.
    socket.on('ssh_session_removed', (data) => {
        if (!data || !data.session_id) return;
        SessionManager.removeSessionUI(data.session_id);
        FileTransferManager.updateSessionSelects();
    });

    socket.on('session_timeout_warning', (data) => {
        showNotification(`Session "${data.session_id.substr(0,8)}..." will timeout in 2 minutes due to inactivity. Type anything to keep alive.`, 'warning', 10000);
    });

    socket.on('profiles_list', (data) => {
        ProfileManager.setProfiles(data.profiles);
    });

    socket.on('profile_saved', (data) => {
        showNotification('Profile saved successfully', 'success');
    });

    socket.on('profile_deleted', (data) => {
        showNotification('Profile deleted successfully', 'success');
    });

    socket.on('keys_list', (data) => {
        ProfileManager.setKeys(data.keys);
    });

    socket.on('key_uploaded', (data) => {
        showNotification('SSH key uploaded successfully', 'success');
        document.getElementById('keyUploadForm').reset();
    });

    socket.on('key_deleted', (data) => {
        showNotification('SSH key deleted successfully', 'success');
    });

    socket.on('jump_hosts_list', (data) => {
        if (window.JumpHostManager) window.JumpHostManager.setJumpHosts(data.jump_hosts);
    });

    socket.on('jump_host_saved', (data) => {
        showNotification(window.i18n ? i18n.t('jumphosts.savedOk') : 'Jump host saved', 'success');
        document.getElementById('jumpHostForm')?.reset();
        document.getElementById('jhKeyGroup')?.classList.add('hidden');
    });

    socket.on('jump_host_deleted', (data) => {
        showNotification(window.i18n ? i18n.t('jumphosts.deleted') : 'Jump host deleted', 'success');
    });

    socket.on('file_progress', (data) => {
        FileTransferManager.updateProgress(data);
    });

    socket.on('file_complete', (data) => {
        FileTransferManager.handleTransferComplete(data);
    });

    socket.on('file_download_ready', (data) => {
        FileTransferManager.handleDownloadReady(data);
    });

    socket.on('error', (data) => {
        if (window.sftpFileManager && window.sftpFileManager.isOpen) return;
        showNotification(`Error: ${data.error}`, 'error');
    });

    /*
     * Item 2: the notepad is revisioned. This device
     * remembers the last revision the server told it about
     * (notepadDataRevision) and every save carries it as base_revision, so a
     * stale device can no longer silently win -- the server refuses it with
     * 'notepad_conflict' instead of writing.
     *
     * adoptNotepadFrame is the single writer of the box: it applies the
     * server's text, adopts the server's revision, and cancels any pending
     * debounced save. That last step is the resurrection fix: a pending save's
     * text was read from the box BEFORE a broadcast or conflict replaced it,
     * so firing it afterwards would push the old text right back.
     */
    let notepadDataRevision = 0;
    let notepadPendingSaveTimer = null;
    // World-B save contract: the SAVER learns its outcome from the
    // save_notepad ACK, never from a broadcast back to itself (the server
    // excludes it with skip_sid). Saves are serialized -- one in flight at a
    // time -- so a burst never self-conflicts on a stale base_revision, and a
    // foreign frame arriving while the box is focused is deferred to blur so it
    // cannot yank the caret mid-type.
    let notepadSaveInFlight = false;
    let notepadQueuedSave = null;
    let deferredNotepadFrame = null;
    // The bucket whose text is currently painted in the box. A frame for THIS
    // bucket while focused is a mid-edit update and is deferred (caret safety);
    // a frame for a bucket the user just switched to is the initial paint and
    // applies at once even while focused.
    let notepadBoxBucket = { mode: 'global', target_id: null };
    let currentNotepadMode = 'global';
    let currentNotepadTarget = null;
    /*
     * Set once the user (not the server) has chosen a scope this
     * session. The startup restore below refuses to act afterwards, so a live
     * click during the connect handshake can never be clobbered by the slower
     * reply to the older request.
     */
    let notepadModeTouched = false;

    function notepadFrameMatchesBucket(data) {
        const frameMode = data.mode || 'global';
        const frameTarget = data.target_id || null;
        return !(frameMode !== currentNotepadMode
            || (frameMode === 'per_server' && frameTarget !== currentNotepadTarget));
    }

    /*
     * WRITE a frame into the box: paint its text with the caret preserved and
     * record which bucket the box now shows. The single physical writer. Callers
     * decide WHETHER to write (adoptNotepadFrame gates on focus / pending
     * intent); this only performs the write once that decision is made. The
     * revision is adopted by adoptNotepadFrame BEFORE this, eagerly, so a save
     * typed after a frame lands always bases off the freshest revision even when
     * the text paint itself is deferred.
     */
    function applyNotepadFrame(data) {
        if (!data || !notepadFrameMatchesBucket(data)) {
            return;
        }
        if (typeof data.revision === 'number') {
            notepadDataRevision = data.revision;
        }
        notepadBoxBucket = {
            mode: data.mode || 'global', target_id: data.target_id || null,
        };
        const notepad = document.getElementById('sessionNotepad');
        if (notepad) {
            const incoming = data.notepad ? data.notepad : '';
            /*
             * ASSIGN ONLY ON A REAL CHANGE, AND KEEP THE CARET.
             *
             * Writing `.value` collapses the selection to the end of the text --
             * that is the caret "jumping to the last line of the note" in the
             * report. It happens even when the incoming text is IDENTICAL to what
             * is already there, which is the common case for the echo of somebody
             * else's keystroke, so the cheapest half of this fix is simply not to
             * write when nothing changed.
             *
             * When the text really did change the caret still has to survive, so
             * the offsets are taken before the write and restored after, clamped to
             * the new length. Clamping matters because a remote edit can make the
             * text SHORTER than the old offset; an unclamped restore would throw or
             * silently land at 0.
             *
             * Only touched while this element is focused: setting selection on an
             * unfocused textarea is what makes some browsers scroll it into view.
             */
            if (notepad.value !== incoming) {
                const focused = document.activeElement === notepad;
                const start = focused ? notepad.selectionStart : null;
                const end = focused ? notepad.selectionEnd : null;
                notepad.value = incoming;
                if (focused && start !== null) {
                    const limit = notepad.value.length;
                    try {
                        notepad.setSelectionRange(
                            Math.min(start, limit), Math.min(end, limit));
                    } catch (e) {
                        // A browser that refuses the range must not break the sync.
                    }
                }
            }
        }
    }

    /*
     * ADOPT a frame. The REVISION is taken eagerly and always, because it is a
     * scalar with no caret cost and a save typed next must base off the server's
     * latest truth (session_switch_init §F.2b). The TEXT paint is deferred to
     * blur ONLY when the box is focused (or a local save is pending) AND the
     * frame concerns the bucket already on screen -- that is the mid-edit case
     * where a paint would yank the caret (browser test §D). A frame for a bucket
     * the user just SWITCHED TO is the initial paint of that connection's note
     * and must land at once even while focused (§F.3).
     */
    function adoptNotepadFrame(data) {
        if (!data || !notepadFrameMatchesBucket(data)) {
            return;
        }
        if (typeof data.revision === 'number') {
            notepadDataRevision = data.revision;
        }
        const notepad = document.getElementById('sessionNotepad');
        const focused = notepad && document.activeElement === notepad;
        const frameBucket = {
            mode: data.mode || 'global', target_id: data.target_id || null,
        };
        const sameAsBox = sameNotepadBucket(frameBucket, notepadBoxBucket);
        if ((focused || notepadPendingSaveTimer) && sameAsBox) {
            deferredNotepadFrame = data;
            return;
        }
        deferredNotepadFrame = null;
        applyNotepadFrame(data);
    }

    socket.on('notepad_data', (data) => {
        adoptNotepadFrame(data);
    });

    socket.on('notepad_updated', (data) => {
        // Another device saved -- the server excludes THIS saver with skip_sid,
        // so a frame here is always foreign. Converge (deferred while focused).
        adoptNotepadFrame(data);
    });

    let currentConnectRequestId = null;
    let pendingPaneIndex = null;
    const pendingPaneQueue = [];
    const pendingRequestPaneMap = new Map();
    /*
     * W14 item 8: save-as-profile is a CONNECT-SUCCESS side effect, keyed by the
     * same client_request_id the pane map uses, so exactly the request the user
     * submitted with the box checked triggers the save -- never a reconnect, a
     * reset, or an unrelated in-flight request. The stored payload carries the
     * storable fields ONLY (host/port/user/auth/key/jump/post-connect); the
     * password never enters this record, and the server's _validate_profile_payload
     * independently refuses credential fields, so the secret has no path to disk.
     */
    const pendingProfileSaveMap = new Map();
    let connectTimer = null;
    let connectSeconds = 0;

    function openConnectionModalForPane(paneIndex) {
        window.clearConnectionProfileState();
        /*
         * An ORDINARY New Connection. Any lifecycle intent left behind by an
         * abandoned Reconnect or Reset must be cleared BEFORE the form opens, or
         * this connect inherits it: Reset's forced use_tmux:false, or a
         * reconnect's reconnect_tmux_name pointing at someone else's tmux
         * session, plus a banner claiming an action this form is not serving.
         *
         * Same single owner every dismissal route uses. Not called from the
         * reconnect/reset openers themselves -- those set the state this clears.
         */
        SessionManager.resetConnectionModalIntent();
        pendingPaneIndex = paneIndex;
        if (paneIndex !== null && paneIndex !== undefined) {
            SessionManager.setActivePane(paneIndex);
        }

        // W14 item 8: save-as-profile defaults OFF on every open; a stale check or
        // name from a previous attempt must not ride into the next connection.
        resetSaveProfileControls();

        // Reset the jump host selection so a previous jump never carries into a
        // new connection by accident.
        const jumpHostSelect = document.getElementById('jumpHostSelect');
        if (jumpHostSelect) {
            jumpHostSelect.value = '';
            document.getElementById('jumpHostPasswordGroup')?.classList.add('hidden');
        }

        ConnectionHistory.renderHistoryDropdown();
        const historyGroup = document.getElementById('recentConnectionsGroup');
        if (historyGroup) {
            historyGroup.style.display = ConnectionHistory.getHistory().length > 0 ? 'block' : 'none';
        }

        const modal = document.getElementById('connectionModal');
        if (window.ModalManager) {
            window.ModalManager.open(modal);
        } else {
            modal.classList.add('show');
        }
        setConnectLoading(false);
    }

    function selectConnectionProfile(profileId) {
        const profileSelect = document.getElementById('profileSelect');
        const deleteBtn = document.getElementById('deleteProfileBtn');
        if (profileSelect) {
            profileSelect.value = profileId || '';
        }

        if (!profileId) {
            ProfileManager.clearLegacyCommands();
            ConnectionCommandManager.clear();
            deleteBtn.style.display = 'none';
            delete deleteBtn.dataset.profileId;
            return null;
        }

        const profile = ProfileManager.getProfile(profileId);
        if (!profile) {
            if (profileSelect) {
                profileSelect.value = '';
            }
            deleteBtn.style.display = 'none';
            delete deleteBtn.dataset.profileId;
            return null;
        }
        ProfileManager.selectProfile(profileId);
        deleteBtn.style.display = 'block';
        deleteBtn.dataset.profileId = profileId;
        return profile;
    }

    window.selectConnectionProfile = selectConnectionProfile;

    function isSelectedProfileReady(profile) {
        const authTypeSelect = document.getElementById('authTypeSelect');
        const keySelect = document.getElementById('keySelect');
        const jumpHostSelect = document.getElementById('jumpHostSelect');
        if (!profile || authTypeSelect.value !== profile.auth_type) {
            return false;
        }
        if (profile.auth_type === 'key' && keySelect.value !== profile.key_id) {
            return false;
        }
        if (jumpHostSelect.value !== (profile.jump_host_id || '')) {
            return false;
        }
        return true;
    }

    function launchProfileForPane(profileId, paneIndex) {
        const profile = ProfileManager.getProfile(profileId);
        if (!profile) {
            showNotification(
                window.i18n
                    ? i18n.t('connection.profileUnavailable')
                    : 'This profile is no longer available.',
                'warning',
            );
            ProfileManager.loadProfiles();
            return;
        }

        openConnectionModalForPane(paneIndex);
        const selected = selectConnectionProfile(profileId);
        if (!selected) {
            return;
        }

        const mode = ProfileManager.getLaunchMode(selected);
        const form = document.getElementById('connectionForm');
        if (mode === 'connect' && isSelectedProfileReady(selected)) {
            form.requestSubmit();
            return;
        }

        let focusTarget = document.getElementById('connectBtn');
        if (mode === 'password') {
            focusTarget = document.getElementById('passwordInput');
        } else if (mode === 'jump-host-password') {
            focusTarget = document.getElementById('jumpHostPasswordInput');
        }
        window.requestAnimationFrame(() => focusTarget?.focus());
    }

    window.launchProfileForPane = launchProfileForPane;

    window.openConnectionModalForProfile = (profileId) => {
        openConnectionModalForPane(getDefaultPaneIndex());
        selectConnectionProfile(profileId);
    };

    function queuePaneConnection(paneIndex) {
        if (paneIndex === null || paneIndex === undefined) {
            return;
        }
        if (pendingPaneQueue.includes(paneIndex)) {
            return;
        }
        pendingPaneQueue.push(paneIndex);
        processPaneQueue();
    }

    function processPaneQueue() {
        if (currentConnectRequestId || pendingPaneIndex !== null) {
            return;
        }
        if (pendingPaneQueue.length === 0) {
            return;
        }
        const nextPane = pendingPaneQueue.shift();
        openConnectionModalForPane(nextPane);
    }

    function clearPaneQueue() {
        pendingPaneQueue.length = 0;
        pendingPaneIndex = null;
    }

    function getDefaultPaneIndex() {
        const activeIndex = SessionManager.getActivePaneIndex();
        const activeSession = SessionManager.getActiveSession();
        if (!activeSession && activeIndex !== null && activeIndex !== undefined) {
            return activeIndex;
        }
        const emptyIndex = SessionManager.getFirstEmptyPaneIndex();
        if (emptyIndex !== -1) {
            return emptyIndex;
        }
        // Every pane is taken: the connection opens without a pane and the
        // session is shown solo when it arrives.
        return null;
    }

    window.openConnectionModalForPane = openConnectionModalForPane;

    function setConnectLoading(isLoading) {
        const connectBtn = document.getElementById('connectBtn');
        const spinner = document.getElementById('connectSpinner');
        if (!connectBtn || !spinner) {
            return;
        }
        connectBtn.disabled = isLoading;
        spinner.classList.toggle('hidden', !isLoading);
    }

    function setFieldState(input, hintEl, message, isValid) {
        if (!input || !hintEl) {
            return;
        }
        input.classList.toggle('is-valid', Boolean(isValid));
        input.classList.toggle('is-invalid', isValid === false);
        hintEl.textContent = message || '';
        hintEl.classList.toggle('hint-error', isValid === false);
        hintEl.classList.toggle('hint-success', isValid === true);
    }

    function setupConnectionValidation() {
        const hostInput = document.getElementById('hostInput');
        const portInput = document.getElementById('portInput');
        const userInput = document.getElementById('usernameInput');
        const passwordInput = document.getElementById('passwordInput');
        const keySelect = document.getElementById('keySelect');
        const profileNameInput = document.getElementById('profileNameInput');
        const authTypeSelect = document.getElementById('authTypeSelect');

        if (!hostInput || !portInput || !userInput) {
            return;
        }

        const hostHint = document.getElementById('hostHint');
        const portHint = document.getElementById('portHint');
        const userHint = document.getElementById('usernameHint');
        const passHint = document.getElementById('passwordHint');
        const keyHint = document.getElementById('keyHint');
        const profileHint = document.getElementById('profileHint');

        const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
        const usernamePattern = /^[a-zA-Z0-9_-]{1,32}$/;

        hostInput.addEventListener('input', () => {
            const value = hostInput.value.trim();
            const isValid = value && (hostnamePattern.test(value) || ipPattern.test(value));
            setFieldState(hostInput, hostHint, isValid ? '✓ Valid host' : 'Hostname or IP required', isValid);
        });

        portInput.addEventListener('input', () => {
            const value = parseInt(portInput.value, 10);
            const isValid = value >= 1 && value <= 65535;
            setFieldState(portInput, portHint, isValid ? '✓ Valid port' : 'Port 1-65535', isValid);
        });

        userInput.addEventListener('input', () => {
            const value = userInput.value.trim();
            const isValid = usernamePattern.test(value);
            setFieldState(userInput, userHint, isValid ? '✓ Valid username' : '1-32 chars, a-z 0-9 _ -', isValid);
        });

        if (passwordInput) {
            passwordInput.addEventListener('input', () => {
                const value = passwordInput.value;
                const isValid = value.length > 0;
                setFieldState(passwordInput, passHint, isValid ? '✓ Ready' : 'Password required', isValid);
            });
        }

        if (keySelect) {
            keySelect.addEventListener('change', () => {
                const value = keySelect.value;
                setFieldState(keySelect, keyHint, value ? '✓ Key selected' : 'Select a key', Boolean(value));
            });
        }

        if (profileNameInput) {
            profileNameInput.addEventListener('input', () => {
                const value = profileNameInput.value.trim();
                setFieldState(profileNameInput, profileHint, value ? '✓ Saved name' : '', value ? true : null);
            });
        }

        if (authTypeSelect) {
            authTypeSelect.addEventListener('change', () => {
                if (authTypeSelect.value === 'password' && passwordInput) {
                    setFieldState(passwordInput, passHint, passwordInput.value ? '✓ Ready' : 'Password required', Boolean(passwordInput.value));
                }
                if (authTypeSelect.value === 'key' && keySelect) {
                    setFieldState(keySelect, keyHint, keySelect.value ? '✓ Key selected' : 'Select a key', Boolean(keySelect.value));
                }
            });
        }
    }

    function setupPasswordToggles() {
        document.querySelectorAll('.password-toggle').forEach(button => {
            button.addEventListener('click', () => {
                const targetId = button.dataset.target;
                const input = document.getElementById(targetId);
                if (!input) {
                    return;
                }
                const isHidden = input.getAttribute('type') === 'password';
                input.setAttribute('type', isHidden ? 'text' : 'password');
                button.classList.toggle('active', isHidden);
            });
        });
    }

    function setupClipboardActions() {
        const saveBtn = document.getElementById('saveTranscriptBtn');
        const reloadBtn = document.getElementById('reloadPageBtn');

        // Was an inline onclick="location.reload". Bound here beside the other
        // tab-row icon buttons so the tab row's markup carries no behaviour.
        if (reloadBtn) {
            reloadBtn.addEventListener('click', () => location.reload());
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const active = SessionManager.getActiveSession();
                if (!active) {
                    showNotification('No active session', 'warning');
                    return;
                }
                const transcript = TerminalManager.getCleanTranscript(active);
                if (!transcript) {
                    showNotification('Transcript is empty', 'info');
                    return;
                }
                const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `session-${active}.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showNotification('Transcript saved', 'success');
            });
        }

        const mobileInput = document.getElementById('mobileInput');
        const mobileSendBtn = document.getElementById('mobileSendBtn');
        const exitScrollBtn = document.getElementById('exitScrollBtn');
        const mobileKeypadBtn = document.getElementById('mobileKeypadBtn');
        const mobileKeypad = document.getElementById('mobileKeypad');

        /*
         * ---- Composer: a MIRROR of the terminal's input line -----------------
         *
         * The box is a 1:1 view of what THIS device
         * has put on the session's input line, and nothing else. Every settled
         * edit becomes the bytes that make the line match the box again: the
         * box is compared with `mirror` (what was streamed), the differing tail
         * is erased with one DEL per grapheme cluster and the new tail typed.
         * A newline in the box is ESC+CR (a newline inside Claude Code and
         * codex; ignored by bash and zsh -- on the host:
         * "ESC+CR then ZQ2" painted `ZQ1ZQ2` in both shells and a new line in
         * Claude Code); Send is the CR that runs the line. Backspace on an
         * empty box is one raw DEL, so text typed elsewhere or before a reload
         * can still be erased, and the keypad's ^U clears the whole line.
         *
         * WHAT IS DELIBERATELY GONE, all of it at the owner's request: the
         * classifier over inputType/isTrusted, the immutable streamed prefix,
         * taint, the per-device draft sync, the resync and conflict sheets,
         * the truth budget. Paste, undo, autocorrect, a Command Library insert
         * and an IME commit are all just edits, and an edit is always
         * expressible as DELs + text. The ONE thing never streamed is a
         * events with isComposing are ignored and the settled syllable is
         * streamed once, at compositionend.
         *
         * KNOWN LIMIT, documented and accepted: the diff assumes the remote
         * caret sits at the END of the line. After a keypad arrow moved it, the
         * DELs erase from where the caret is; ^U and a retype recovers.
         *
         * Broadcast is a target mode over the same box: while it is open the
         * box is a local draft (nothing streams) and Send fans the text out
         * through BroadcastInput.sendAll; when it closes the box keeps its text,
         * and the next edit streams the whole box to the active session, whose
         * mirror is empty.
         */
        const DEL = '\x7f';
        const NEWLINE_KEYS = '\x1b\r';
        const KILL_LINE = '\x15';
        const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
            ? new Intl.Segmenter('vi', { granularity: 'grapheme' }) : null;
        // One DEL erases one grapheme cluster in readline and in the TUIs
        // diff is computed over clusters, never over code units.
        const clusters = (text) => (segmenter
            ? Array.from(segmenter.segment(text), part => part.segment)
            : Array.from(text));

        /*
         * Per session: `mirror`, what this device has streamed to its line, and
         * `draft`, what the box held when the user last looked at it (equal to
         * the mirror while streaming; a local draft while the session could not
         * be written to, or while Broadcast held the box). Memory only: a
         * streamed line survives a reload IN THE TERMINAL, and the reverse sync
         * below pulls it back into the box.
         */
        const composerStates = new Map();
        const stateFor = (key) => {
            if (!composerStates.has(key)) {
                composerStates.set(key, { mirror: '', draft: '' });
            }
            return composerStates.get(key);
        };
        const composerTargetKey = () => SessionManager.getActiveSession() || null;
        let boundKey = null;
        let mobileComposing = false;
        // Session the in-progress composition belongs to. A syllable started in
        // session A must never be streamed into session B if the user switches
        // panes mid-composition.
        let mobileComposingSession = null;
        // True between pointerdown and click on the Send button. iOS fires the
        // textarea's blur in that window; the blur handler consumes it so an
        // abandoned tap does not leak the flag.
        let mobileSendPressed = false;
        // F2/F3-IME-One-Tap: a Send that lands mid-composition is
        // queued, and the matching compositionend fulfils it once.
        let mobileSendQueued = false;
        // Some iOS IMEs finalize the textarea on a Send-caused blur but omit
        // compositionend; that exact blur is remembered so the click can still
        // fulfil the Send after a short wait.
        let mobileSendBlurredComposition = false;
        let mobileSendFallbackTimer = null;

        // How much of the ACTIVE session's line this device has streamed.
        // BroadcastInput refuses to open while it is non-zero: that session
        // would otherwise receive the line a second time.
        window.__composerMirrorLen = () => {
            const key = composerTargetKey();
            return key === null ? 0 : clusters(stateFor(key).mirror).length;
        };

        // Auto-grow the box with the draft, capped so it can never crowd out the
        // terminal: the ceiling is the smaller of ~3 lines (88px) and 30% of the
        // usable app height (correction 3,). "Usable" means the height
        // above the on-screen keyboard, read from the visual viewport first, then
        // the --app-height terminal-manager pins to that same height, then the
        // window. Reset height to 'auto' first so scrollHeight reports the true
        // content height (box-sizing: border-box makes scrollHeight the
        // content+padding height, which is what we want under the cap). Floor is
        // the 44px coarse-pointer minimum, enforced by CSS min-height.
        const usableHeight = () => {
            const vv = window.visualViewport && window.visualViewport.height;
            if (vv) return vv;
            const pinned = parseFloat(
                getComputedStyle(document.documentElement).getPropertyValue('--app-height'));
            if (pinned) return pinned;
            return window.innerHeight || 800;
        };
        /*
         * W14 item 4: the cap is FOUR lines of the composer text
         * (16px * 1.4 line-height = 22.4px), plus the box's own vertical
         * padding and border. 88px was roughly three lines, one below the
         * requested 3-4. Measured live off the computed style, not a magic
         * number, so a font/padding change moves the cap with it:
         * 4 * lineHeight + paddingTop + paddingBottom + borderTop + borderBottom.
         * The CSS static ceiling (style.css .mobile-input-bar textarea
         * max-height) moves in lockstep with this; the two are one contract.
         */
        const COMPOSER_CAP_LINES = 4;
        const composerCap = () => {
            const cs = getComputedStyle(mobileInput);
            const lh = parseFloat(cs.lineHeight) || 22.4;
            const vertical = ['paddingTop', 'paddingBottom',
                'borderTopWidth', 'borderBottomWidth']
                .reduce((sum, p) => sum + (parseFloat(cs[p]) || 0), 0);
            return Math.ceil(COMPOSER_CAP_LINES * lh + vertical);
        };
        let composerMeasureFrame = 0;
        /*
         * W14 item 4: publish the dock's height term QUANTIZED to line-count
         * changes. The old code published the measured pixel height on every
         * input frame; below the cap each newline changed it, the dock grew,
         * the terminal ResizeObserver fired, fitTerminal ran and a resize
         * proposal went to the server -- per keystroke. Publishing only when
         * the LINE COUNT changes means the dock changes height at most
         * COMPOSER_CAP_LINES times total while filling the box, and once the
         * cap holds the internal overflow-y:auto absorbs further typing with
         * zero dock movement.
         *
         * The published VALUE is still the real measured box height (never a
         * rounded approximation), so the dock keeps matching the textarea to
         * the pixel; only the TRIGGER is quantized. A genuine WIDTH change
         * (rotation, split layout) changes the height without changing the
         * line count, so the pixel value is also a trigger -- the guard
         * against input-time thrash is the line count, not the height.
         */
        let publishedLineCount = null;
        let publishedHeight = null;
        /*
         * AN UNSETTLED MEASUREMENT IS NOT A HEIGHT CHANGE.
         *
         * The height is a trigger as well as the line count (a rotation or split
         * changes the box height without changing the line count, and the dock has
         * To follow it). But `getBoundingClientRect` inside a rAF can also land
         * MID-LAYOUT, while the browser has applied the new content but not yet the
         * new box height -- and such a frame published a height that belonged to no
         * steady state at all.
         *
         * Measured on the real page (/tmp/s34/growth_diag.log): lineHeight 20,
         * vertical 24, so filling the box to its 4-line cap has exactly four steady
         * heights -- 62, 82, 102 for two/three/four lines and 104 once the cap
         * clamps. That is the whole budget the contract allows
         * (composer_growth_quantum §Q1, "at most four distinct published heights"),
         * so ONE transient frame overruns it: the suite went red 1 run in ~4 under
         * sweep ordering while passing 8/8 standalone.
         *
         * The fix is to publish only a SETTLED measurement: the box height that
         * belongs to the line count we just computed. A rect more than half a line
         * away from that has been read mid-layout, so the frame is re-scheduled
         * rather than published. Bounded to two retries, after which the measurement
         * is published anyway -- an unusual layout must never wedge the dock at a
         * stale height, and being briefly 2px out is a cosmetic cost where refusing
         * forever would be a functional one.
         *
         * This coalesces intermediate frames WITHOUT hiding a real change: a genuine
         * width change settles at a new height for the SAME line count within a
         * frame or two and publishes normally.
         */
        const SETTLE_RETRIES = 2;
        let composerSettleAttempt = 0;
        const publishComposerContentHeight = () => {
            if (!mobileInput) return;
            cancelAnimationFrame(composerMeasureFrame);
            composerMeasureFrame = requestAnimationFrame(() => {
                const height = Math.ceil(mobileInput.getBoundingClientRect().height);
                if (!height) return;
                const cs = getComputedStyle(mobileInput);
                const lh = parseFloat(cs.lineHeight) || 22.4;
                const vertical = ['paddingTop', 'paddingBottom',
                    'borderTopWidth', 'borderBottomWidth']
                    .reduce((sum, p) => sum + (parseFloat(cs[p]) || 0), 0);
                const cap = composerCap();
                const maxLines = Math.max(1, Math.floor((cap - vertical) / lh));
                const lines = Math.min(maxLines, Math.max(1,
                    Math.round((mobileInput.scrollHeight - vertical) / lh)));
                if (lines === publishedLineCount && height === publishedHeight) {
                    composerSettleAttempt = 0;
                    return;
                }
                // The height this line count settles at. Clamped by the cap, which
                // is where the box stops growing and the internal scroll takes over.
                const settled = Math.min(cap, Math.ceil(lines * lh + vertical));
                if (Math.abs(height - settled) > lh / 2
                        && composerSettleAttempt < SETTLE_RETRIES) {
                    // Read mid-layout: this frame describes no steady state. Try
                    // again next frame rather than publishing a height that will be
                    // immediately superseded.
                    composerSettleAttempt += 1;
                    publishComposerContentHeight();
                    return;
                }
                composerSettleAttempt = 0;
                publishedLineCount = lines;
                publishedHeight = height;
                const next = height + 'px';
                const root = document.documentElement;
                if (root.style.getPropertyValue('--composer-content-height') !== next) {
                    root.style.setProperty('--composer-content-height', next);
                }
            });
        };

        /*
         * Autogrow WITHOUT a synchronous layout flush on the keystroke path.
         *
         * Measured cost (defect 10,): this runs on every `input`, and
         * writing `height:auto` then reading `scrollHeight` is a
         * write->read->write cycle, so the browser must flush layout
         * synchronously in the middle of handling the key. That latency is paid
         * per character while typing.
         *
         * A first attempt gated the measurement on `scrollWidth <= clientWidth`.
         * That was wrong twice over and is deliberately not what this does: the
         * comparison is itself a layout READ (so the flush stayed on the key
         * path), and a soft-wrapped textarea keeps scrollWidth == clientWidth,
         * so wrapped text was misclassified as one line and never grew.
         *
         * What this does instead: the keystroke path performs NO layout access at
         * all. It only marks the box dirty and schedules one measurement in a
         * requestAnimationFrame, which runs after the event has been handled and
         * is naturally coalesced -- N keystrokes in one frame produce ONE
         * measurement, and the pending frame is reused rather than re-scheduled.
         * Inside the frame the real `height:auto` + `scrollHeight` measurement is
         * performed unconditionally, so soft-wrapped text (including long
         * Vietnamese text with no spaces to break on) grows exactly as before.
         *
         * The height write is skipped when the resolved value is unchanged, which
         * keeps a held key from dirtying style for no reason.
         */
        let growFrame = 0;
        const measureAndGrow = () => {
            growFrame = 0;
            if (!mobileInput) return;
            const cap = Math.min(composerCap(), Math.floor(usableHeight() * 0.30));
            let target;
            if (mobileInput.value === '') {
                target = 44;
            } else {
                // Inside a rAF callback: reading layout here does not stall the
                // keystroke that requested it.
                mobileInput.style.height = 'auto';
                target = Math.min(mobileInput.scrollHeight, cap);
            }
            const next = `${target}px`;
            if (mobileInput.style.height !== next) {
                mobileInput.style.height = next;
            }
            publishComposerContentHeight();
        };
        const growMobileInput = () => {
            if (!mobileInput) return;
            if (growFrame) return;
            growFrame = requestAnimationFrame(measureAndGrow);
        };
        /*
         * Some callers need the box already at its final height when they return
         * (initial layout, and the post-Send collapse that the send path measures
         * straight afterwards). They ask for it explicitly rather than every
         * keystroke paying for it.
         */
        const growMobileInputNow = () => {
            if (growFrame) {
                cancelAnimationFrame(growFrame);
            }
            measureAndGrow();
        };

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', growMobileInput);
        }
        window.addEventListener('resize', growMobileInput);
        // Initial layout must be correct before first paint, not one frame later.
        growMobileInputNow();

        /*
         * Terminal column -> string index, for the reverse sync below: the
         * cursor column from tmux counts CELLS, and Vietnamese text has more
         * UTF-16 units than cells (combining marks), so slicing by the column
         * would cut the marks off the last character.
         */
        const indexForColumn = (row, column) => {
            let col = 0;
            let i = 0;
            while (i < row.length) {
                const cp = row.codePointAt(i);
                const wide = cp > 0xffff;
                // Combining marks (the Vietnamese-relevant ranges plus the
                // general block) take a cell from their base character rather
                // than one of their own.
                const combining = (cp >= 0x0300 && cp <= 0x036f)
                    || (cp >= 0x1ab0 && cp <= 0x1aff)
                    || (cp >= 0x20d0 && cp <= 0x20f0)
                    || (cp >= 0xfe20 && cp <= 0xfe2f);
                /*
                 * Stop only at a code point that would OCCUPY the next cell. The
                 * marks that decorate the last accepted character sit at the
                 * same column, so stopping the moment the count is reached
                 * would cut them off -- measured: for the production line
                 * index 29 and the composer got "ngtie", losing exactly the two
                 * marks. They belong to the character before them, so they are
                 * consumed with it.
                 */
                if (col >= column && !combining) return i;
                if (!combining) col += 1;
                i += wide ? 2 : 1;
            }
            return row.length;
        };

        // May the box stream to the active session right now? Recomputed on
        // every edit from live state; nothing is latched.
        const streamTarget = () => {
            if (boundKey === null) return null;
            if (window.BroadcastInput?.open === true) return null;
            const active = SessionManager.getActiveSession();
            if (!active || active !== boundKey) return null;
            if (!SessionManager.isSendableSession(SessionManager.getSession(active))) {
                return null;
            }
            return active;
        };

        /*
         * The one place an edit becomes bytes. Called for every settled edit:
         * `input` outside a composition, compositionend, the Enter newline, a
         * Command Library insert (its synthetic `input`), and Send (so a draft
         * that could not stream when it was typed reaches the line before the
         * CR). Idempotent: a box equal to the mirror sends nothing.
         */
        const settleEdit = () => {
            if (!mobileInput) return;
            growMobileInput();
            // An edit is also a binding event: text can be placed in the box
            // before anything rebinds the composer (first paint, a Command
            // Library insert, a draft typed while the app was still starting),
            // and that text belongs to the session that is active NOW.
            syncComposerBinding();
            if (boundKey === null) return;
            const st = stateFor(boundKey);
            st.draft = mobileInput.value;
            if (mobileComposing) return;
            const session = streamTarget();
            if (session === null) return;
            const next = mobileInput.value.normalize('NFC');
            const had = clusters(st.mirror);
            const want = clusters(next);
            let common = 0;
            while (common < had.length && common < want.length
                    && had[common] === want[common]) {
                common += 1;
            }
            const bytes = DEL.repeat(had.length - common)
                + want.slice(common).join('').replace(/\n/g, NEWLINE_KEYS);
            if (bytes === '') return;
            if (window.emitTerminalInput(session, bytes)) {
                st.mirror = next;
            }
        };

        // The remote line was killed (keypad ^U): nothing is on it any more,
        // so the mirror and the box are emptied together.
        const composerLineCleared = (sessionId) => {
            const st = stateFor(sessionId);
            st.mirror = '';
            st.draft = '';
            if (sessionId === boundKey && mobileInput && !mobileComposing) {
                mobileInput.value = '';
                growMobileInput();
            }
        };

        /*
         * REVERSE SYNC: an empty box asks the server what the shell's line
         * holds (`get_terminal_line` -> `terminal_line_data`, a read-only
         * capture-pane on tmux; refused on the alternate screen, where a TUI
         * owns the row). The text after the last prompt marker becomes the box
         * AND the mirror, so the next edit diffs against what is really there.
         * Asked once per session per trigger -- a bind, the page coming back,
         * the session becoming sendable -- never on a timer. If the line cannot
         * be read the box simply stays empty, and Backspace on it still erases.
         */
        const reverseSyncPending = new Set();
        const requestReverseSync = (key) => {
            if (!key || !window.socket || typeof window.socket.emit !== 'function') return;
            if (mobileInput.value !== '' || mobileComposing) return;
            if (reverseSyncPending.has(key)) return;
            const session = SessionManager.getSession(key);
            if (!session || !session.useTmux
                    || !SessionManager.isSendableSession(session)) {
                return;
            }
            reverseSyncPending.add(key);
            window.socket.emit('get_terminal_line', { session_id: key });
        };
        const PROMPT_MARKER = /[$#%❯➜›]\s/g;
        const typedAfterPrompt = (line, cursorX) => {
            const head = line.slice(0, indexForColumn(line, cursorX));
            let end = -1;
            for (const match of head.matchAll(PROMPT_MARKER)) {
                end = match.index + match[0].length;
            }
            return end === -1 ? '' : head.slice(end);
        };
        if (window.socket && typeof window.socket.on === 'function') {
            window.socket.on('terminal_line_data', (data) => {
                if (!data || !data.session_id) return;
                reverseSyncPending.delete(data.session_id);
                if (data.session_id !== boundKey || !mobileInput) return;
                if (mobileInput.value !== '' || mobileComposing) return;
                const typed = typedAfterPrompt(String(data.line || ''),
                    Number(data.cursor_x) || 0);
                if (typed === '') return;
                const st = stateFor(boundKey);
                st.mirror = typed.normalize('NFC');
                st.draft = typed;
                mobileInput.value = typed;
                growMobileInput();
            });
            window.socket.on('terminal_line_unavailable', (data) => {
                if (data && data.session_id) reverseSyncPending.delete(data.session_id);
            });
        }

        const bindComposerTo = (key) => {
            const carried = mobileInput && boundKey === null
                && mobileInput.value !== '' ? mobileInput.value : null;
            if (mobileInput && boundKey !== null) {
                stateFor(boundKey).draft = mobileInput.value;
            }
            boundKey = key;
            if (!mobileInput) return;
            if (carried !== null && key !== null && stateFor(key).draft === '') {
                // Text that existed before any session was bound: it is this
                // session's draft, not something to discard.
                stateFor(key).draft = carried;
            }
            const draft = key === null ? '' : stateFor(key).draft;
            if (mobileInput.value !== draft) {
                mobileInput.value = draft;
                growMobileInput();
            }
            if (key !== null && draft === '') requestReverseSync(key);
        };

        // Re-read the bound target after any event that can change it. Cheap and
        // idempotent when the target has not moved.
        const syncComposerBinding = () => {
            const key = composerTargetKey();
            if (key !== boundKey) bindComposerTo(key);
        };

        /*
         * SEND. Plan v5 section 5: ONE composer, two targets. With Broadcast on
         * the box fans out through BroadcastInput.sendAll, which owns the CR
         * for that path (a multi-line draft goes as one bracketed paste so the
         * shell runs its lines in order). Otherwise whatever the line does not
         * hold yet is streamed first, then the CR that runs it. The active
         * session only, never a fallback: an id that is disconnected or still
         * a reconnect candidate has no channel, so the commit is refused.
         */
        window.commitTerminalDraft = (draft) => {
            if (!draft || !window.socket) return false;
            const normalized = draft.value.replace(/\r\n?/g, '\n');
            const clear = () => {
                draft.value = '';
                if (draft === mobileInput) {
                    if (boundKey !== null) stateFor(boundKey).draft = '';
                    growMobileInput();
                }
            };

            if (window.BroadcastInput?.open === true) {
                const text = normalized.includes('\n')
                    ? `\x1b[200~${normalized.replace(/\n/g, '\r')}\x1b[201~`
                    : normalized;
                const count = window.BroadcastInput.sendAll(text);
                if (!count) {
                    showNotification(window.i18n
                        ? i18n.t('broadcast.noTargets')
                        : 'No sessions to broadcast to', 'warning');
                    return false;
                }
                clear();
                return true;
            }

            const session = draft === mobileInput
                ? streamTarget() : SessionManager.getActiveSession();
            if (!session) {
                showNotification('No active session', 'warning');
                return false;
            }
            if (draft === mobileInput) {
                settleEdit();
            } else if (normalized !== '') {
                window.emitTerminalInput(session, normalized.replace(/\n/g, NEWLINE_KEYS));
            }
            window.emitTerminalInput(session, '\r');
            const st = stateFor(session);
            st.mirror = '';
            clear();
            return true;
        };
        const commitMobileInput = () => window.commitTerminalDraft(mobileInput);

        // The active session changed: an in-flight composition belongs to the
        // old one and is abandoned, a queued Send with it. Then rebind.
        const resetMobileInputState = () => {
            if (mobileSendFallbackTimer !== null) {
                clearTimeout(mobileSendFallbackTimer);
                mobileSendFallbackTimer = null;
            }
            mobileComposing = false;
            mobileComposingSession = null;
            mobileSendQueued = false;
            mobileSendBlurredComposition = false;
            syncComposerBinding();
        };

        if (mobileInput) {
            mobileInput.addEventListener('compositionstart', () => {
                mobileComposing = true;
                syncComposerBinding();
                mobileComposingSession = boundKey;
            });
            mobileInput.addEventListener('compositionend', () => {
                // The normal IME path wins: cancel the missing-compositionend
                // fallback before fulfilling the same queued Send here, or one
                // tap could commit twice.
                if (mobileSendFallbackTimer !== null) {
                    clearTimeout(mobileSendFallbackTimer);
                    mobileSendFallbackTimer = null;
                }
                mobileSendBlurredComposition = false;
                const startedIn = mobileComposingSession;
                mobileComposing = false;
                mobileComposingSession = null;
                if (startedIn !== null && startedIn !== composerTargetKey()) {
                    // The target moved under the syllable: it stays a local
                    // draft of the session it was typed for.
                    mobileSendQueued = false;
                    return;
                }
                // The syllable is final: stream it now, in order, before any
                // keystroke that follows it.
                settleEdit();
                if (mobileSendQueued) {
                    mobileSendQueued = false;
                    commitMobileInput();
                }
            });
            // Every edit, whatever produced it: typing, paste, drop, undo,
            // autocorrect, a synthetic event from the Command Library. A
            // composition in flight only grows the box.
            mobileInput.addEventListener('input', (e) => {
                if (e.isComposing || mobileComposing) {
                    growMobileInput();
                    return;
                }
                settleEdit();
            });
            // iOS blurs the box on the Send tap, sometimes mid-composition, and
            // used to leave mobileComposing stuck. A Send-caused blur keeps the
            // composition state so the click can queue the one-tap Send; any
            // other blur releases it. The box is never touched here.
            mobileInput.addEventListener('blur', () => {
                const causedBySend = mobileSendPressed;
                mobileSendPressed = false;
                if (!mobileComposing) return;
                if (causedBySend) {
                    mobileSendBlurredComposition = true;
                    return;
                }
                mobileSendBlurredComposition = false;
                mobileComposing = false;
                mobileComposingSession = null;
            });
            mobileInput.addEventListener('keydown', (e) => {
                /*
                 * BACKSPACE ON AN EMPTY BOX, ON THE EVENT THAT ACTUALLY
                 * FIRES. An empty textarea has nothing to delete, so the browser
                 * raises no beforeinput/input for it (measured: 6 presses ->
                 * keydown 6, beforeinput 0). ONE RAW DEL: the terminal's own
                 * line editor knows what it erases, and this is how text typed
                 * on another device or before a reload is still erasable. A
                 * non-empty box is edited locally and the diff does the rest.
                 */
                if (e.key === 'Backspace') {
                    if (e.isComposing || mobileComposing) return;
                    if (mobileInput.value !== '') return;
                    syncComposerBinding();
                    if (!boundKey || streamTarget() === null) return;
                    e.preventDefault();
                    window.emitTerminalInput(boundKey, '\x7f');
                    return;
                }
                if (e.key !== 'Enter') return;
                // Ctrl/Cmd+Enter mid-composition is the physical-keyboard twin
                // of the Send tap: queue it for compositionend. A bare Enter
                // while composing is the IME's own (iOS sends it before
                // compositionend) and is left alone.
                if (mobileComposing || e.isComposing) {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        mobileSendBlurredComposition = false;
                        mobileSendQueued = true;
                    }
                    return;
                }
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) {
                    commitMobileInput();
                    return;
                }
                // A bare Enter is a newline IN THE BOX -- and, through the diff,
                // ESC+CR on the line (a newline in Claude Code / codex). The
                // visible Send is what runs the line.
                const start = mobileInput.selectionStart;
                const end = mobileInput.selectionEnd;
                mobileInput.setRangeText('\n', start, end, 'end');
                settleEdit();
            });
            // Only fires when the active session id really changed (same-pane
            // taps do not fire it). The outgoing box is kept against its own
            // session and the incoming one restored.
            document.addEventListener('sshdeck:active-session-changed', () => {
                resetMobileInputState();
            });
            // A double-tap hands typing to xterm's own textarea; the box is
            // left alone, only the composition flag is released.
            document.addEventListener('sshdeck:raw-terminal-focus', () => {
                mobileComposing = false;
                mobileComposingSession = null;
            });
            // The page coming back, or the bound session becoming writable,
            // are the moments an empty box may have a line to pull back.
            const reverseSyncIfEmpty = () => {
                if (document.visibilityState === 'hidden') return;
                syncComposerBinding();
                if (boundKey !== null) {
                    reverseSyncPending.delete(boundKey);
                    requestReverseSync(boundKey);
                }
            };
            document.addEventListener('visibilitychange', reverseSyncIfEmpty);
            window.addEventListener('pageshow', reverseSyncIfEmpty);
            document.addEventListener('sshdeck:session-status-changed', reverseSyncIfEmpty);

            // Establish the initial binding so the first keystroke has a target.
            syncComposerBinding();
        }

        // ---- Broadcast target state on the ONE shared composer ----------------
        //
        // Plan v5 section 5: Broadcast switches the composer's TARGET; it does not
        // create a bar, an input or a draft of its own. This is the sole consumer
        // of that state and holds no copy of it -- BroadcastInput stays the single
        // source of truth, so there is nothing here to fall out of sync.
        //
        // It deliberately touches neither focus, the soft keyboard, the draft text,
        // nor the socket: switching target must never send, clear, or summon the
        // keyboard (v5 gates 5 and 6).
        {
            const composerTarget = document.getElementById('composerTarget');

            const renderBroadcastState = (active, count, total, allMode) => {
                if (composerTarget) {
                    /*
                     * Exactly the localized target format. W14 item 6: two
                     * states, two labels. All-mode keeps the existing form
                     * ("All 3" / "Tất cả 3"); a user-chosen subset reads
                     * "2 / 3" (selected / total) through the dedicated
                     * count key, so the custom state is legible instead of
                     * hiding behind the all-mode copy. No extra word is
                     * prefixed: on a 359px phone the composer cannot spare
                     * the width. Without i18n the target still must not
                     * render blank while Broadcast is active: an empty badge
                     * would hide the blast radius right before a fan-out
                     * send. Falls back to the untranslated English form,
                     * matching the Send label below.
                     */
                    let targetText = '';
                    if (active) {
                        if (allMode !== false) {
                            targetText = window.i18n
                                ? i18n.t('broadcast.target').replace('{n}', count)
                                : `All ${count}`;
                        } else {
                            targetText = window.i18n
                                ? i18n.t('broadcast.targetCount')
                                    .replace('{x}', count).replace('{y}', total)
                                : `${count} / ${total}`;
                        }
                    }
                    // B2: the chip is now icon + label + chevron (mockup line
                    // 192), so the text goes into its label span. Writing
                    // textContent on the chip itself would delete both <svg>
                    // children on the first render.
                    const targetLabel =
                        composerTarget.querySelector('.composer-target-label');
                    if (targetLabel) {
                        targetLabel.textContent = targetText;
                    } else {
                        composerTarget.textContent = targetText;
                    }
                    composerTarget.hidden = !active;
                }
                // Drives the fine-pointer Broadcast reveal in CSS. Distinct from
                // body.broadcast-active, which stays the terminal-highlight state.
                //
                // The reveal takes 52 px of the terminal area on desktop. That
                // is OUR panel, not a change in what the remote pane should be,
                // so the grid is held across the toggle and the text scales
                // instead -- otherwise opening and closing Broadcast resizes
                // the tmux window twice and every attached device repaints
                // change, so the resize it causes is already covered.
                if (typeof TerminalManager !== 'undefined') {
                    TerminalManager.holdChromeGrid(active);
                }
                document.body.classList.toggle('broadcast-composer', active);
                if (mobileSendBtn) {
                    // Touch keeps this control icon-only; only its accessible name
                    // changes. CSS reveals the text label on desktop Broadcast.
                    const label = window.i18n
                        ? i18n.t(active ? 'broadcast.send' : 'commandPanel.send')
                        : (active ? 'Send all' : 'Send');
                    mobileSendBtn.setAttribute('aria-label', label);
                    const span = mobileSendBtn.querySelector('.btn-label');
                    if (span) span.textContent = label;
                }
            };

            document.addEventListener('sshdeck:broadcast-changed', (event) => {
                /*
                 * Turning Broadcast ON makes the box an all-local draft, so
                 * whatever the mirror already put on the active session's line
                 * is RETRACTED here -- one DEL per cluster -- leaving the line
                 * as it was and the box untouched. Without this the same text
                 * would reach that session twice: once as the mirror, once in
                 * the fan-out. Turning it OFF needs no counterpart: the mirror
                 * is empty, so the next edit streams the whole box.
                 */
                if (event.detail?.active === true && mobileInput) {
                    syncComposerBinding();
                    const key = boundKey;
                    const st = key === null ? null : stateFor(key);
                    if (st && st.mirror !== ''
                            && SessionManager.isSendableSession(
                                SessionManager.getSession(key))) {
                        const erased = clusters(st.mirror).length;
                        if (erased > 0
                                && window.emitTerminalInput(key, DEL.repeat(erased))) {
                            st.mirror = '';
                        }
                    }
                }
                syncComposerBinding();
                renderBroadcastState(
                    event.detail?.active === true,
                    event.detail?.count ?? 0,
                    event.detail?.total ?? 0,
                    event.detail?.allMode ?? true);
            });
            // Re-render in the new language without touching target state.
            window.addEventListener('languageChanged', () => {
                const bi = window.BroadcastInput;
                renderBroadcastState(
                    bi?.open === true,
                    bi?.selectedCount?.() ?? 0,
                    bi?.targetCount?.() ?? 0,
                    bi?.allMode ?? true);
            });
        }

        if (mobileSendBtn) {
            // Mark the tap BEFORE the textarea's blur fires, so the blur handler
            // knows Send caused it and keeps the pending text instead of rewinding
            // the box. Without this the tap hid the keyboard and sent an empty
            // line, and the dropped characters could resurface after the CR as
            // junk at the next prompt — the bug being fixed here.
            //
            // pointerdown/mousedown also preventDefault, which stops focus from
            // leaving at all (keyboard stays up for the next command). NOT done on
            // touchstart: WebKit treats a prevented touchstart as "no click", which
            // would disable the button outright. So the flag, not preventDefault,
            // is what actually guarantees the fix on iOS.
            // v3 strict focus rule: Send is the ONLY code
            // path that may focus the composer, and only when the composer was
            // already active at press time -- a continuation of an already-
            // intentional composer session. Capture on the FIRST press event
            // only: on touch the passive touchstart does not preventDefault, so
            // a blur can land before the compat mousedown; re-capturing there
            // would read the post-blur state and drop the keyboard on exactly
            // the engines the refocus exists for.
            let wasComposerActive = false;
            const markSendPressed = (e) => {
                if (!mobileSendPressed) {
                    wasComposerActive = document.activeElement === mobileInput;
                }
                mobileSendPressed = true;
                if (e.type !== 'touchstart') e.preventDefault();
            };
            mobileSendBtn.addEventListener('pointerdown', markSendPressed);
            // Engines without Pointer Events (older Safari) reach these instead.
            mobileSendBtn.addEventListener('mousedown', markSendPressed);
            mobileSendBtn.addEventListener('touchstart', markSendPressed, { passive: true });
            mobileSendBtn.addEventListener('click', () => {
                mobileSendPressed = false;

                // Dated amendment (F2/F3-IME-One-Tap): if the click
                // lands during an active composition, queue the explicit Send
                // intent instead of committing a partial syllable. The matching
                // compositionend will fulfill the queue: one commit, one payload,
                // no second tap.
                if (mobileComposing) {
                    mobileSendQueued = true;
                    /*
                     * iOS can finalize the textarea on blur yet omit
                     * compositionend. Only a Send-caused blur enables this fallback;
                     * ordinary composition and physical Ctrl/Cmd+Enter continue to
                     * wait for compositionend.
                     *
                     * The delay is load-bearing, not cosmetic. setTimeout(..., 0)
                     * yields ONE macrotask, but a real compositionend arrives several
                     * macrotasks later, so a zero delay made this recovery outrun the
                     * primary path and commit every ordinary Send itself -- breaking
                     * the F2/F3-IME-One-Tap contract, where compositionend
                     * is the one fulfilling event. A real compositionend follows its
                     * blur inside one frame; this waits ~15 frames, so the normal path
                     * always wins and this only ever runs when the IME truly sent
                     * nothing. Its handler clears this timer.
                     *
                     * Capture the composition's session and recheck it before
                     * committing so this recovery path cannot cross panes.
                     */
                    if (mobileSendBlurredComposition) {
                        const queuedFor = mobileComposingSession;
                        if (mobileSendFallbackTimer !== null) {
                            clearTimeout(mobileSendFallbackTimer);
                        }
                        mobileSendFallbackTimer = setTimeout(() => {
                            mobileSendFallbackTimer = null;
                            if (!mobileSendQueued || !mobileComposing) return;
                            if (queuedFor !== null && queuedFor !== composerTargetKey()) {
                                mobileSendQueued = false;
                                mobileSendBlurredComposition = false;
                                return;
                            }
                            mobileSendQueued = false;
                            mobileSendBlurredComposition = false;
                            mobileComposing = false;
                            mobileComposingSession = null;
                            commitMobileInput();
                        }, 250);
                    }
                    return;
                }

                mobileSendBlurredComposition = false;
                commitMobileInput();

                // F1 strict focus rule: refocus only when the composer
                // was already active at press time (continuation of an intentional
                // composer session). Usually a no-op anyway (preventDefault keeps
                // focus from leaving).
                if (wasComposerActive && mobileInput) mobileInput.focus();
                wasComposerActive = false;
            });
        }

        // ---- Mobile function keypad ------------------------------------------
        //
        // A soft keyboard has no arrows, so on a phone there was NO way to pick an
        // item in any list a program draws (claude's menus, vim, a TUI picker) —
        // the reason this exists. It is a sheet that takes the place of the system
        // keyboard rather than another row of buttons in the input bar.
        //
        // Keys are delivered by dispatching a synthetic KeyboardEvent at xterm's
        // hidden textarea and letting XTERM encode it. That is the crux: an arrow
        // is \x1b[A in a shell but \x1bOA once a program turns on DECCKM
        // (application cursor keys), and sending the wrong form means the program
        // ignores the key entirely. Measured on this xterm build, both a real
        // keypress and this synthetic one produce \x1b[A / \x1bOA in the matching
        // mode, so xterm gets it right in every context and we never hard-code a
        // sequence. Only the control bytes xterm has no key for (^C/^D/^Z/^L,
        // Shift-Tab) are sent literally, via data-seq.
        //
        // Also measured: the dispatch does NOT need focus on xterm's textarea and
        // does not move focus, so #mobileInput keeps it and the Vietnamese IME is
        // untouched.
        if (mobileKeypadBtn && mobileKeypad) {
            const keypadOpen = () => mobileKeypad.classList.contains('mobile-open');

            // Sticky modifiers. The v5 inventory dropped the four hardcoded
            // ^C/^D/^Z/^L keys, so Ctrl/Alt must carry that ability or the ability
            // to interrupt a running command would be gone: Ctrl then C is still
            // 0x03, Ctrl then D still 0x04. Arming is PURELY LOCAL -- it emits
            // nothing, moves no focus, and so cannot raise the system keyboard.
            // One key consumes it, tapping the armed key again disarms it.
            let armedModifier = null;

            const setArmedModifier = (name) => {
                armedModifier = name;
                mobileKeypad.querySelectorAll('[data-keypad-modifier]').forEach((btn) => {
                    const armed = btn.getAttribute('data-keypad-modifier') === name;
                    btn.setAttribute('aria-pressed', armed ? 'true' : 'false');
                    btn.classList.toggle('is-armed', armed);
                });
            };

            const setKeypad = (open) => {
                mobileKeypad.classList.toggle('mobile-open', open);
                mobileKeypad.setAttribute('aria-hidden', open ? 'false' : 'true');
                mobileKeypadBtn.classList.toggle('active', open);
                mobileKeypadBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
                document.body.classList.toggle('keypad-open', open);
                if (open) {
                    // Swap the system keyboard for the panel: blurring the box is
                    // what makes iOS retract its keyboard so the sheet has the room.
                    if (mobileInput) mobileInput.blur();
                } else {
                    // Every close path converges here: dock toggle, head close,
                    // system-keyboard transition and session switch. A modifier
                    // belongs to this one visible keypad interaction only; keeping
                    // it armed after the keypad disappears would make an ordinary
                    // character after reopen unexpectedly become Ctrl/Alt input.
                    setArmedModifier(null);
                    // Deliberately NO focus here. This button toggles the function
                    // keypad and nothing else. Focusing the box is what makes iOS
                    // raise its keyboard, and that raise is not free: it sets
                    // body.keyboard-open, which hides the header so the terminal can
                    // grow, and the frame resizing under the terminal left the view
                    // showing older output further up instead of the newest lines and
                    // the remote cursor. Closing the keypad now changes nothing but
                    // the keypad. Typing is reached by tapping the box, as usual.
                }
            };

            // Which of the two key pages is showing. The pages are a native
            // horizontal scroll-snap track, so the browser does the swiping and
            // nothing here has to recognise a gesture — this only mirrors the
            // resulting scroll position into the two dots.
            const keypadPages = document.getElementById('mobileKeypadPages');
            const keypadDots = mobileKeypad.querySelectorAll('.keypad-dot');
            const keypadPageLabel = document.getElementById('keypadPageLabel');
            const updateKeypadPageLabel = (page) => {
                if (!keypadPageLabel) return;
                const tpl = (window.i18n && typeof i18n.t === 'function')
                    ? i18n.t('terminal.keypadPage') : 'Page {n} / {m}';
                keypadPageLabel.textContent = tpl
                    .replace('{n}', String(page + 1))
                    .replace('{m}', String(keypadDots.length));
            };
            if (keypadPages && keypadDots.length) {
                // P6 / mockup line 194 also puts a "Trang N / M" read-out in
                // the head. It is derived from the SAME scroll position the
                // dots are, so the two can never disagree.
                const syncKeypadDots = () => {
                    const width = keypadPages.clientWidth || 1;
                    const page = Math.round(keypadPages.scrollLeft / width);
                    keypadDots.forEach((dot, i) => {
                        dot.classList.toggle('is-active', i === page);
                    });
                    updateKeypadPageLabel(page);
                };
                keypadPages.addEventListener('scroll', syncKeypadDots, { passive: true });
                // The page label is dynamic text, so data-i18n cannot repaint
                // it. Without this listener, switching the shell to Vietnamese
                window.addEventListener('languageChanged', syncKeypadDots);
                syncKeypadDots();
            }

            // move the ONE mounted scroll-snap track -- both pages stay in the DOM
            // and the single delegated handler keeps serving every key, so nothing
            // is remounted, overlaid or absolutely positioned. The head read-out
            // still derives from scrollLeft, so a tap and a swipe cannot disagree.
            // Setting scrollLeft fires the native scroll event, so the dot track
            // stays owned by the one scroll listener above rather than by a second
            // writer here. The label is updated directly because a zero-width
            // track (offscreen/unlaid-out) produces no scroll event to derive from.
            const showKeypadPage = (page) => {
                if (!keypadPages) return;
                const width = keypadPages.clientWidth || 0;
                keypadPages.scrollLeft = width * (page - 1);
                updateKeypadPageLabel(page - 1);
            };

            // Ctrl-<letter> is the byte with bits 6-7 cleared (C -> 0x03), which is
            // what a real terminal sends; Ctrl-? is DEL. Anything with no control
            // byte is left alone rather than mangled into one.
            const controlByte = (ch) => {
                const code = ch.toUpperCase().charCodeAt(0);
                if (code === 63) return '\x7f';
                if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
                return null;
            };

            const emitModified = (ch) => {
                // Telex safety: a composition in flight is local by construction.
                // No modifier may be applied to it and no synthetic byte may be
                // emitted, or the composed syllable would be corrupted.
                if (mobileComposing) return false;
                /*
                 * Broadcast owns only the shared composer's explicit Send. A sticky
                 * Control sequence cannot use BroadcastInput.sendAll: that
                 * primitive appends CR, while sending only to the active session
                 * would contradict the visible "All N" target. Therefore Broadcast
                 * accepts no sticky modifier; the character remains an ordinary
                 * local part of the Broadcast draft.
                 */
                if (window.BroadcastInput?.open === true) return false;
                const active = SessionManager.getActiveSession();
                if (!active || !window.socket) return false;
                const data = armedModifier === 'ctrl' ? controlByte(ch) : `\x1b${ch}`;
                if (data === null) return false;
                // A sticky Ctrl/Alt sequence is a deliberate write.
                window.emitTerminalInput(active, data);
                // Ctrl+U kills the line the composer mirrors, so the box and
                // the mirror empty with it. This is the keypad's line-clear:
                // the sticky Ctrl already encodes it, so no 17th key is added
                // to a frame the owner fixed at 2 x 8.
                if (data === KILL_LINE) composerLineCleared(active);
                return true;
            };

            // The armed modifier consumes the next printable character typed into
            // the ONE shared composer. beforeinput is what iOS reports reliably for
            // soft-keyboard text, and cancelling it keeps the character out of the
            // local draft: it left as a control sequence, so a copy in the box
            // would be a phantom edit.
            //
            if (mobileInput) {
                // Some IMEs emit compositionstart without a matching beforeinput.
                // Clear independently here so an armed modifier cannot survive into
                // or past a Vietnamese composition.
                mobileInput.addEventListener('compositionstart', () => {
                    setArmedModifier(null);
                });

                mobileInput.addEventListener('beforeinput', (e) => {
                    if (!armedModifier) return;
                    // A composition must reach the terminal unchanged. An armed
                    // modifier is ignored AND cleared rather than applied to it.
                    if (e.isComposing || mobileComposing) {
                        setArmedModifier(null);
                        return;
                    }
                    /*
                     * The modifier is one-shot even when the next edit has no
                     * terminal modifier representation. Paste, drop, replacement,
                     * multi-character insert, emoji, Backspace and line-break input
                     * clear it and continue through the existing composer path
                     * unchanged. Only one UTF-16-code-unit insertText is eligible
                     * for Ctrl/Alt encoding.
                     */
                    if (e.inputType !== 'insertText' || !e.data || e.data.length !== 1) {
                        setArmedModifier(null);
                        return;
                    }
                    const consumed = emitModified(e.data);
                    setArmedModifier(null);
                    if (consumed) e.preventDefault();
                });

                // Paste/drop precede beforeinput on supporting engines and can occur
                // without it on others. Either operation consumes the modifier but
                // otherwise remains an ordinary local composer edit.
                mobileInput.addEventListener('paste', () => {
                    setArmedModifier(null);
                });
                mobileInput.addEventListener('drop', () => {
                    setArmedModifier(null);
                });

                // Backspace and Enter can be handled entirely by keydown and may not
                // produce beforeinput. Capture first so they consume the modifier
                // before the existing composer keydown logic runs.
                mobileInput.addEventListener('keydown', (e) => {
                    if (armedModifier && (e.key === 'Backspace' || e.key === 'Enter')) {
                        setArmedModifier(null);
                    }
                }, true);

                // Leaving the composer ends the interaction that could consume the
                // armed modifier. It must not remain latent until a later focus.
                mobileInput.addEventListener('blur', () => {
                    setArmedModifier(null);
                });

                // Tapping the composer is the explicit transition from the
                // function keypad back to the system keyboard. Close through the
                // same state owner BEFORE the browser raises the keyboard, which
                // also guarantees an armed modifier cannot cross that transition.
                mobileInput.addEventListener('focus', () => {
                    if (keypadOpen()) setKeypad(false);
                });
            }

            mobileKeypadBtn.addEventListener('click', () => setKeypad(!keypadOpen()));

            // P6 / mockup line 194: the sheet closes from its own head. Routed
            // through setKeypad, the one owner of the open state, so the dock
            // button's aria-expanded and the published height follow.
            document.getElementById('keypadCloseBtn')?.addEventListener('click', () => {
                setKeypad(false);
                mobileKeypadBtn.focus();
            });

            // Same focus-retention pattern the Send button proved on iOS: prevent
            // the default on pointerdown/mousedown so the tap cannot blur anything,
            // but never on touchstart (WebKit reads a prevented touchstart as "no
            // click" and the button stops working altogether).
            const holdFocus = (e) => {
                if (e.type !== 'touchstart') e.preventDefault();
            };
            mobileKeypadBtn.addEventListener('pointerdown', holdFocus);
            mobileKeypadBtn.addEventListener('mousedown', holdFocus);

            const sendKeypadKey = (button) => {
                const active = SessionManager.getActiveSession();
                if (!active) {
                    // Same untranslated string the other no-session guards use
                    // (app.js:250/1288/1306/1323) rather than a new i18n key for
                    // one edge case.
                    showNotification('No active session', 'warning');
                    return;
                }

                // v3 local-commit model: the buffer is inert local text
                // until the user explicitly sends it. A function key acts on the
                // REMOTE line directly, bypassing the box, but there is no mirror
                // to keep in sync anymore. Do NOT force-commit the pending text;
                // the user will edit and Send it themselves when ready.

                const seq = button.getAttribute('data-seq');
                if (seq) {
                    if (window.socket) {
                        // A keypad key is a deliberate write.
                        window.emitTerminalInput(active, seq);
                        // ^U killed the line the composer mirrors.
                        if (seq === KILL_LINE) composerLineCleared(active);
                    }
                    setArmedModifier(null);
                    return;
                }

                const key = button.getAttribute('data-key');
                if (!key) return;
                const terminal = SessionManager.getActiveTerminal();
                const textarea = terminal && terminal.element
                    ? terminal.element.querySelector('.xterm-helper-textarea')
                    : null;
                if (!textarea) return;
                // keyCode/which are legacy but xterm 5.3.0 still reads them.
                const legacy = {
                    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
                    Home: 36, End: 35, PageUp: 33, PageDown: 34,
                    Tab: 9, Escape: 27, Delete: 46,
                }[key] || 0;
                // An armed modifier also applies to a keypad key (Ctrl-ArrowRight
                // is a real binding), and is consumed by that one key like any
                // other. xterm does the encoding, as it does for the bare key.
                const ctrlKey = armedModifier === 'ctrl';
                const altKey = armedModifier === 'alt';
                setArmedModifier(null);
                textarea.dispatchEvent(new KeyboardEvent('keydown', {
                    key: key,
                    code: key,
                    keyCode: legacy,
                    which: legacy,
                    ctrlKey: ctrlKey,
                    altKey: altKey,
                    bubbles: true,
                    cancelable: true,
                }));
            };

            mobileKeypad.addEventListener('pointerdown', (e) => {
                // Keep the panel from stealing focus, so repeated key taps stay
                // possible and the box is still focused when the panel closes.
                if (e.target.closest('.keypad-key')) e.preventDefault();
            });
            mobileKeypad.addEventListener('mousedown', (e) => {
                if (e.target.closest('.keypad-key')) e.preventDefault();
            });
            mobileKeypad.addEventListener('click', (e) => {
                const button = e.target.closest('.keypad-key');
                if (!button) return;
                // Page navigation and modifier arming are keypad-local state, so
                // they are handled before the key-dispatch path and never reach
                // the terminal as input.
                const page = button.getAttribute('data-keypad-page');
                if (page) {
                    showKeypadPage(Number(page));
                    return;
                }
                const modifier = button.getAttribute('data-keypad-modifier');
                if (modifier) {
                    // Broadcast's explicit-Send target cannot encode a raw sticky
                    // control sequence without either appending CR or silently
                    // addressing only one session. Leave it visibly unarmed.
                    if (window.BroadcastInput?.open === true) {
                        setArmedModifier(null);
                        return;
                    }
                    setArmedModifier(armedModifier === modifier ? null : modifier);
                    return;
                }
                sendKeypadKey(button);
            });

            // Entering Broadcast invalidates a modifier armed under the active-only
            // target. Leaving Broadcast does not resurrect it.
            document.addEventListener('sshdeck:broadcast-changed', (event) => {
                if (event.detail?.active === true) {
                    setArmedModifier(null);
                }
            });

            // A pane/session switch invalidates the panel's target; close it so a
            // key cannot land on a session the user is no longer looking at.
            // Unconditional normalization also clears a modifier if the visible
            // state and the internal state were ever desynchronized.
            document.addEventListener('sshdeck:active-session-changed', () => {
                setKeypad(false);
            });
        }

        // There is deliberately no mobile paste button.
        //
        // It existed because the input box used to be cleared after every
        // keystroke, so it was useless for editing: the only way to get clipboard
        // Text in was to push it straight at the terminal with terminal.paste.
        // Now that the box mirrors the remote line and keeps its content, the
        // system "Paste" from the iOS text-selection menu drops the text into the
        // box, where it can be reviewed and edited before Send — strictly better,
        // and it goes through the mirror so no DEL bookkeeping is lost. A button
        // that bypasses the box would only reintroduce that desync.

        // Exit-scroll is one contextual dock control. TerminalManager publishes
        // explicit scroll state for the active session; at rest the button keeps
        // no box or hit target, and leaving scroll mode hides it again.
        const renderExitScrollState = () => {
            if (!exitScrollBtn) return;
            const active = SessionManager.getActiveSession();
            const session = active ? SessionManager.getSession(active) : null;
            const visible = !!(session?.useTmux
                && TerminalManager.isSessionScrolled(active));
            exitScrollBtn.hidden = !visible;
            exitScrollBtn.setAttribute('aria-hidden', String(!visible));
            if (!visible) exitScrollBtn.disabled = false;
        };
        const exitTmuxCopyMode = () => {
            const active = SessionManager.getActiveSession();
            if (!active) return;
            const session = SessionManager.getSession(active);
            if (!session || !session.useTmux || !window.socket) return;
            /*
             * The button must EXIT, whatever
             * is being scrolled. exitScrollAction decides: a mouse-owned pane
             * (claude/vim/htop) exits CLIENT-SIDE -- the scrollback snaps to
             * the bottom and the state clears, no server round-trip that
             * would answer a no-op was_in_mode:0; anything else goes through
             * tmux_exit_copy_mode exactly as before. Disabled only on the
             * server path, where the reply re-enables; the client-side path
             * never disables, so the button cannot stick.
             */
            const route = TerminalManager.exitScrollAction(active);
            SessionManager.focusActivePane();
            if (route !== 'tmux-copy-mode') return;
            exitScrollBtn.disabled = true;
            window.socket.emit('tmux_exit_copy_mode', { session_id: active });
        };
        exitScrollBtn?.addEventListener('click', exitTmuxCopyMode);
        document.addEventListener('sshdeck:terminal-scroll-state', renderExitScrollState);
        document.addEventListener('sshdeck:active-session-changed', renderExitScrollState);
        renderExitScrollState();

    }

    function setupSplitControls() {
        document.querySelectorAll('.split-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const layout = parseInt(btn.dataset.layout, 10);
                const variant = btn.dataset.variant || 'default';

                // Both halves of the layout identity decide whether this is a
                // but is still a different layout, and comparing the count alone
                // would make that click do nothing.
                const unchanged = layout === SessionManager.layout
                    && variant === SessionManager.layoutVariant;

                if (!unchanged && SessionManager.hasAnySessions()) {
                    SessionManager.showPaneAssignmentModal(layout, variant);
                } else {
                    SessionManager.setSplitLayout(layout, variant);
                }
            });
        });
    }

    // Assigned by setupResizeHandle, which owns the desktop collapse helper.
    // Declared at this shared scope because setupNotepad (mobile toggle, aux
    // exclusion) and setupResizeHandle (desktop toggle) are sibling functions,
    // so neither can see a local of the other. Stays null in reduced fixtures
    // that never build the resize handle; every call site guards for that.
    let setNotepadCollapsed = null;

    function setupNotepad() {
        const notepad = document.getElementById('sessionNotepad');
        const saveStatus = document.getElementById('notepadSaveStatus');
        if (!notepad) {
            return;
        }

        // so #notepadOpenBtn is the ONE Notes control at every tier and carries
        // both behaviours. The dock's former #mobileNotepadBtn is gone: it made
        // coarse tablets show two Note controls with different semantics.
        // Touch owns .mobile-open (the sheet); desktop owns .collapsed (the
        // persisted rail). The tier is chosen by the canonical capability
        // predicate, never by width.
        const notepadPanel = document.getElementById('notepadPanel');
        const notepadOpenTouchBtn = document.getElementById('notepadOpenBtn');
        if (notepadOpenTouchBtn && notepadPanel) {
            notepadOpenTouchBtn.addEventListener('click', () => {
                if (!(window.TerminalManager && TerminalManager.isTouchShell())) {
                    return;
                }
                /*
                 * The Notes button TOGGLES (owner ruling superseded the
                 * open-only rule). Pressing Notes while it is open
                 * closes the sheet, returns focus to the button, and refits the
                 * terminal — the same close path as #notepadCloseBtn, just from
                 * the button instead of the X.
                 */
                if (notepadPanel.classList.contains('mobile-open')) {
                    notepadPanel.classList.remove('mobile-open');
                    notepadOpenTouchBtn.setAttribute('aria-expanded', 'false');
                    notepadOpenTouchBtn.focus();
                    if (window.TerminalManager) {
                        const sid = SessionManager.getActiveSession?.();
                        if (sid) TerminalManager.requestFit(sid);
                    }
                    return;
                }
                // The notepad and the command rail share the one auxiliary slot,
                // so announce BEFORE opening and let the rail close on the event.
                document.dispatchEvent(new CustomEvent('sshdeck:aux-panel-opening', {
                    detail: { panel: 'notepad' },
                }));
                notepadPanel.classList.add('mobile-open');
                notepadOpenTouchBtn.setAttribute('aria-expanded', 'true');
            });
        }

        /*
         * S21 item 1 — the closed sheet is made non-interactive AFTER its
         * transition, never during it.
         *
         * style.css no longer display:none's the panel on any path (that flip
         * between mousedown and mouseup is what swallowed the close click,
         * measured /tmp/s16work/s21_j1_mech.out). The panel therefore stays
         * rendered, and the CLOSED position -- translateY(100%) inside a
         * .workspace that is position:relative + overflow:hidden -- already puts
         * it wholly outside the visible box (measured
         * /tmp/s16work/s21_sheet_geom.out: elementFromPoint over the old 253px
         * band and over the dock both return <html>, never #sessionNotepad).
         *
         * `.sheet-inert` adds pointer-events:none on top of that, as belt to the
         * geometry's braces, and it is applied on `transitionend` so it can
         * never appear under a finger that is mid-gesture: the ruling's "set
         * pointer-events:none only after the transition ends". Two safeguards
         * because a transition can be skipped entirely (reduced motion, a test
         * harness that disables transitions, a class toggled while the panel is
         * display-swapped by an ancestor): the state is also reconciled on the
         * next frame after every open/close, and both writers call one helper so
         * the class can never disagree with .mobile-open.
         */
        /*
         * GUARDED WRITES, not `toggle`. DOMTokenList's add/remove/toggle run
         * their "update steps" and re-serialise the class attribute even when
         * the token was already in the wanted state, and an attribute write is a
         * MutationObserver record -- so an unguarded writer plus the observer
         * below is an endless rAF ping-pong that never yields (measured: the
         * notes gate stopped completing at all, RC=124 on a 280s timeout).
         * Checking first makes this idempotent and lets both the transitionend
         * and the rAF path call it freely.
         */
        const syncSheetInert = () => {
            if (!notepadPanel) return;
            const open = notepadPanel.classList.contains('mobile-open');
            const inert = notepadPanel.classList.contains('sheet-inert');
            if (open && inert) {
                notepadPanel.classList.remove('sheet-inert');
            } else if (!open && !inert) {
                notepadPanel.classList.add('sheet-inert');
            }
        };
        if (notepadPanel) {
            notepadPanel.addEventListener('transitionend', (e) => {
                // Only the sheet's OWN transform settles this; a child's colour
                // transition says nothing about where the sheet is.
                if (e.target !== notepadPanel || e.propertyName !== 'transform') {
                    return;
                }
                syncSheetInert();
            });
            /*
             * An OPEN sheet becomes interactive immediately -- waiting for the
             * transition would make the first tap inside a just-opened sheet a
             * no-op. CLOSING waits for the transform transition, per the ruling,
             * with one rAF fallback for the case where no transition runs at all
             * (reduced motion, or a harness that disables transitions -- which is
             * every browser gate in this suite).
             */
            const observer = new MutationObserver(() => {
                if (notepadPanel.classList.contains('mobile-open')) {
                    syncSheetInert();
                    return;
                }
                requestAnimationFrame(() => {
                    if (!notepadPanel.classList.contains('mobile-open')) {
                        syncSheetInert();
                    }
                });
            });
            observer.observe(notepadPanel,
                { attributes: true, attributeFilter: ['class'] });
            syncSheetInert();
        }

        // The other half of the exclusion: the command rail opening closes the
        // notepad in both of its states.
        if (notepadPanel) {
            document.addEventListener('sshdeck:aux-panel-opening', (event) => {
                if (event.detail?.panel === 'notepad') return;
                notepadPanel.classList.remove('mobile-open');
                notepadOpenTouchBtn?.setAttribute('aria-expanded', 'false');
                /*
                 * On a touch shell the sheet IS the notepad, and removing
                 * .mobile-open above has already closed it. setNotepadCollapsed(true)
                 * would additionally persist notepadCollapsed=true, so opening the
                 * Command sheet would collapse the notepad on the next desktop visit.
                 * Canonical capability predicate (terminal-manager.js:104), not width.
                 */
                if (window.TerminalManager && TerminalManager.isTouchShell()) {
                    // Closing the sheet reclaims terminal space on touch too.
                    const sid = SessionManager.getActiveSession?.();
                    if (sid) TerminalManager.requestFit(sid);
                    return;
                }
                if (notepadPanel.classList.contains('collapsed')) return;
                if (setNotepadCollapsed) {
                    // Preferred path: keeps aria-expanded, the button label,
                    // localStorage and the terminal refit in one place.
                    setNotepadCollapsed(true);
                } else {
                    // Reduced fixture with no resize handle: still get out of the
                    // shared cell rather than throwing.
                    notepadPanel.classList.add('collapsed');
                }
            });
        }

        /*
         * P1 / mockup line 177: the panel head carries a close control. Before
         * this, the ONLY way out of the notes panel was the same button that
         * opened it -- fine on desktop, but on a touch shell the sheet covers
         * the header, so closing meant finding the header action again with
         * the sheet in the way.
         *
         * It closes whichever state is live rather than choosing by width: touch
         * owns .mobile-open, desktop owns .collapsed, exactly as the open path
         * above splits them. setNotepadCollapsed is preferred on desktop so
         * aria-expanded, the toggle glyph, localStorage and the terminal refit
         * all stay in their one owner.
         */
        const notepadCloseBtn = document.getElementById('notepadCloseBtn');
        if (notepadCloseBtn && notepadPanel) {
            notepadCloseBtn.addEventListener('click', () => {
                if (notepadPanel.classList.contains('mobile-open')) {
                    notepadPanel.classList.remove('mobile-open');
                    notepadOpenTouchBtn?.setAttribute('aria-expanded', 'false');
                    notepadOpenTouchBtn?.focus();
                    // Refit terminal on touch close (was desktop-only).
                    if (window.TerminalManager) {
                        const sid = SessionManager.getActiveSession?.();
                        if (sid) TerminalManager.requestFit(sid);
                    }
                    return;
                }
                if (setNotepadCollapsed) {
                    setNotepadCollapsed(true);
                } else {
                    notepadPanel.classList.add('collapsed');
                }
                document.getElementById('notepadOpenBtn')?.focus();
            });
        }

        /*
         * session these notes belong to. That is not decoration: the notepad
         * swaps its content on every session change (socket notepad_data at
         * 1136), so without the host the same box silently shows different
         * text. Read from the session record the app already keeps -- no new
         * state, no socket traffic.
         */
        const notepadMetaHost = document.getElementById('notepadMetaHost');
        const globalBtn = document.getElementById('notepadModeGlobalBtn');
        const serverBtn = document.getElementById('notepadModeServerBtn');

        const setNotepadMode = (mode, shouldFetch = true) => {
            currentNotepadMode = mode;
            if (globalBtn && serverBtn) {
                globalBtn.classList.toggle('active', mode === 'global');
                globalBtn.setAttribute('aria-checked', mode === 'global');
                serverBtn.classList.toggle('active', mode === 'per_server');
                serverBtn.setAttribute('aria-checked', mode === 'per_server');
            }
            refreshNotepadHost();
            if (shouldFetch && window.socket) {
                window.socket.emit('get_notepad', {
                    mode: currentNotepadMode,
                    target_id: currentNotepadTarget,
                });
            }
        };

        if (globalBtn) {
            globalBtn.addEventListener('click', () => { notepadModeTouched = true; setNotepadMode('global'); });
        }
        if (serverBtn) {
            serverBtn.addEventListener('click', () => { notepadModeTouched = true; setNotepadMode('per_server'); });
        }

        /*
         * The subtitle names the HOST, in both scopes.
         *
         * The uncommitted per-server-notes work made this line mode-dependent:
         * host, so the one piece of information the subtitle exists to carry
         * disappeared for the default scope, and it stopped following the active
         * session. Measured against HEAD: HEAD writes ` · ${host}` with no mode
         * branch at all, and panel_contracts §3 pins the mockup's own shape
         *
         * The scope is already legible: the two toggle buttons carry
         * active/aria-checked, which is where a two-state choice belongs. It was
         * never the subtitle's job, and taking the host's place made the panel
         * silently ambiguous about which session's notes were on screen -- the
         * exact failure the host was added to prevent (the box swaps content on
         * every session change).
         *
         * currentNotepadTarget still tracks the active session in BOTH scopes so
         * a scope switch to Per-server has its bucket key ready; only the
         * refetch is scope-gated, because a global note does not change when the
         * active session does.
         */
        const refreshNotepadHost = () => {
            if (!notepadMetaHost) return;
            // SessionManager is a top-level `const` (session-manager.js:1), NOT a
            // window property -- `window.SessionManager` is undefined here, which
            // is why the first version of this silently wrote nothing. Guard on
            // typeof instead, the same way the rest of this file reaches it.
            if (typeof SessionManager === 'undefined') return;
            const id = SessionManager.getActiveSession
                ? SessionManager.getActiveSession() : null;
            // getActiveSession returns the ID, not the record (session-manager.js:2495).
            const s = id && SessionManager.sessions ? SessionManager.sessions[id] : null;
            const host = s && (s.displayName || s.host);
            const prevTarget = currentNotepadTarget;
            currentNotepadTarget = host || id || null;
            notepadMetaHost.textContent = host ? ` · ${host}` : '';

            // Per-server notes are keyed by target, so a connection switch must
            // rebind the content. Global notes are the same text everywhere and
            // must NOT refetch -- that would discard an unsaved local edit.
            if (currentNotepadMode === 'per_server'
                && currentNotepadTarget !== prevTarget && window.socket) {
                window.socket.emit('get_notepad', {
                    mode: 'per_server',
                    target_id: currentNotepadTarget,
                });
            }
        };
        refreshNotepadHost();
        /*
         * The persisted scope is restored on load.
         *
         * The panel's initial state used to be whatever the `let` initialiser
         * said -- hardcoded 'global' at app.js:1419 -- and nothing ever corrected
         * it from the server: the connect-time fetch (`socket.emit('get_notepad')`
         * at app.js:962) sent NO mode and the reply carried no preference either,
         * so a user who chose Per-server landed on Global after every reload.
         *
         * Keyed on data.stored_mode, NOT data.mode. The effective mode in a
         * frame answers "which bucket does THIS text come from" and collapses
         * to 'global' whenever no target_id is bound yet -- which is exactly
         * the state at connect time -- so it can never carry a persisted
         * per_server choice back. stored_mode is the raw saved preference,
         * independent of any resolution.
         *
         * setNotepadMode(mode, false): refreshNotepadHost derives the target
         * from the ACTIVE SESSION and fetches when it changes; passing
         * shouldFetch=false avoids a second get_notepad racing the one already
         * in flight. If no session is bound yet, the panel still lands on
         * Per-server with the host subtitle empty until one activates.
         *
         * The notepadModeTouched guard matters: setNotepadMode writes the
         * client-side state BEFORE any frame arrives, so if the user clicks
         * during startup this must not clobber their choice with a slower
         * server reply for the older one.
         */
        socket.on('notepad_data', (data) => {
            const stored = data && data.stored_mode;
            if ((stored === 'global' || stored === 'per_server')
                && !notepadModeTouched) {
                notepadModeTouched = true;
                /*
                 * AND FETCH THE BUCKET IT JUST SWITCHED TO.
                 *
                 * `shouldFetch = false` assumed refreshNotepadHost would do it,
                 * because a target change fetches. On a reload it does not: the
                 * session restore has usually already fired
                 * sshdeck:active-session-changed, so the target is ALREADY the
                 * active host when this switches the mode to per_server -- the
                 * target does not change, nothing fetches, and the box keeps the
                 * GLOBAL text this connect asked for (empty, for a user who
                 * then held one bucket's text under another bucket's label.
                 *
                 * The race the old comment worried about is already handled:
                 * notepadFrameMatchesBucket discards any frame whose bucket is
                 * not the one on screen, so the earlier global reply cannot
                 * overwrite the per-server text that this fetch brings back.
                 */
                setNotepadMode(stored, stored !== currentNotepadMode);
            }
        });
        document.addEventListener('sshdeck:active-session-changed', refreshNotepadHost);

        const updateSaveStatus = (status) => {
            if (!saveStatus) return;
            const st = (key, fallback) =>
                (window.i18n && typeof i18n.t === 'function') ? i18n.t(key) : fallback;
            if (status === 'saving') {
                // These two were hardcoded English on a Vietnamese shell.
                saveStatus.textContent = st('terminal.notepadSaving', 'Saving…');
                saveStatus.className = 'notepad-save-status saving';
            } else if (status === 'saved') {
                saveStatus.textContent = st('terminal.notepadSaved', '✓ Saved');
                saveStatus.className = 'notepad-save-status saved';
                setTimeout(() => {
                    saveStatus.className = 'notepad-save-status';
                    saveStatus.textContent = '';
                }, 2000);
            }
        };
        // Published so the shared-scope ACK handler (flushNotepadSave) can clear
        // the "Saving…" indicator when the server confirms the write.
        window.__notepadUpdateSaveStatus = updateSaveStatus;

        /*
         * S16 defect 1: the companion class is set UNCONDITIONALLY on focus.
         *
         * It used to be gated on `keyboard-open` already being present, which
         * made the pair order-dependent: focusing the note first and the
         * keyboard opening second left `keyboard-open` alone for as long as it
         * took another recompute to notice, and style.css:5018 hides
         * `.notepad-panel` in exactly that state -- `display:none` on the
         * focused textarea drops the caret, and the composer-first redirectors
         * Then take the rest of the note into #mobileInput (the user's
         * "note text leaks INTO the composer"). Every rule that reads
         * `notepad-focused` also requires `keyboard-open`, so setting it while
         * the keyboard is closed changes nothing visually and removes the
         * ordering hazard entirely. terminal-manager's syncNotepadFocusedClass
         * recomputes the same fact on every keyboard-state pass.
         */
        notepad.addEventListener('focus', () => {
            document.body.classList.add('notepad-focused');
        });
        notepad.addEventListener('blur', () => {
            document.body.classList.remove('notepad-focused');
            // A foreign frame that arrived while the box was focused was deferred
            // (browser test §D); apply it now that the caret has left the box, but
            // never over an unsent local save still waiting to go out.
            if (deferredNotepadFrame && !notepadPendingSaveTimer) {
                const frame = deferredNotepadFrame;
                deferredNotepadFrame = null;
                applyNotepadFrame(frame);
            }
        });

        /*
         * THE BUCKET IS CAPTURED WITH THE TEXT, not read 300ms
         * later. `value` was always captured here; mode, target and revision
         * were not, and they are read inside the timer, so a connection
         * switch inside the debounce window rebound them under a save that
         * had already been decided. Measured (session_switch_init.mjs §F.2 /
         * §F.2b, /tmp/s35/p37_red5.log): text typed on connection A while a
         * switch to B landed mid-debounce was emitted as
         *
         *     save_notepad { text: "TYPED-WHILE-ON-A", target_id: "B" }
         *     save_notepad { text: "EDITED-ON-A-THEN-LEFT",
         *                    target_id: "B", base_revision: 3 }
         *
         * A's words written into B's per-server bucket, and in the second
         * case against B's OWN revision, so the conditional write the
         * base_revision exists to guard would have SUCCEEDED and replaced B's
         * note with A's text. The revision is late-bound the same way and for
         * the same reason: adoptNotepadFrame assigns notepadDataRevision
         * before it decides whether the frame even applies, so a refetch for
         * another connection moves the baseline under this save.
         *
         * A save belongs to the bucket that was on screen when the user
         * typed. Binding all four fields at that one instant is what makes
         * that true: state is keyed to whom it belongs to, not to whoever
         * happens to be active when it is flushed.
         */
        const scheduleNotepadSave = () => {
            if (notepadPendingSaveTimer) clearTimeout(notepadPendingSaveTimer);
            const req = {
                text: notepad.value,
                mode: currentNotepadMode,
                target_id: currentNotepadTarget,
                base_revision: notepadDataRevision,
            };
            updateSaveStatus('saving');
            notepadPendingSaveTimer = setTimeout(() => {
                notepadPendingSaveTimer = null;
                flushNotepadSave(req);
            }, 300);
        };

        /*
         * N3 — a Telex/IME composition schedules NO save until it settles.
         *
         * The mobile composer already draws this line (mobileComposing +
         * compositionstart/end, and the input handler streams nothing while
         * `e.isComposing || mobileComposing`); the notepad had no such
         * scheduled a save. Under a real RTT that maximised the in-flight saves
         * and thus the stale-base window that made the box notify + erase the
         * just-typed char. A composition is local by construction: hold it, and
         * flush one save on compositionend from the settled text.
         */
        let notepadComposing = false;
        notepad.addEventListener('compositionstart', () => {
            notepadComposing = true;
        });
        notepad.addEventListener('compositionend', () => {
            notepadComposing = false;
            scheduleNotepadSave();
        });

        notepad.addEventListener('input', (e) => {
            if (e.isComposing || notepadComposing) return;
            scheduleNotepadSave();
        });
    }

    // World-B save contract: saves are SERIALIZED. A save carrying a stale
    // base_revision is refused, so a second save must wait for the first ACK to
    // learn the revision it advanced to -- otherwise a burst self-conflicts. One
    // save is in flight at a time; a save proposed meanwhile is coalesced into
    // notepadQueuedSave (latest text wins) and flushed when the ACK returns.
    function sameNotepadBucket(a, b) {
        return a && b && (a.mode || 'global') === (b.mode || 'global')
            && (a.target_id || null) === (b.target_id || null);
    }

    function flushNotepadSave(req) {
        if (!window.socket) {
            return;
        }
        if (notepadSaveInFlight) {
            // Coalesce: only the newest pending edit needs to reach the server.
            notepadQueuedSave = req;
            return;
        }
        /*
         * N3 — RE-BASE THE DIRECT FLUSH, not only the queued one.
         *
         * base_revision is frozen into `req` when the user types, and it only
         * advances on this device through an applied:true ACK (or an adopted
         * frame). drainQueuedNotepadSave already re-bases a save that was queued
         * behind an in-flight one; but a save that DEBOUNCED behind an ACK -- RTT
         * under the 300ms debounce, the common case -- reaches here with nothing
         * in flight and flushes its STALE frozen base directly, so the server
         * refuses it (applied:false) and the box adopts server truth mid-type,
         * erasing the just-typed char. Re-basing onto the freshest adopted
         * revision removes that self-conflict at the source.
         *
         * the re-base used to be REFUSED while a foreign frame was
         * deferred, so that the other device's text could not be overwritten
         * silently. Measured consequence (notepad_fast_typing.mjs §4): once any
         * frame is deferred -- which is the normal state with two devices open,
         * the owner's setup -- every later save keeps its frozen stale base, is
         * refused forever, and NOTHING the user types is ever written. The
         * typist's text was lost outright, which is worse than the overwrite the
         * guard was avoiding. The live typist now wins (see
         * handleNotepadSaveAck); the other device converges through the
         * broadcast this write makes.
         */
        if (sameNotepadBucket(req, {
            mode: currentNotepadMode, target_id: currentNotepadTarget,
        })) {
            req.base_revision = notepadDataRevision;
        }
        notepadSaveInFlight = true;
        // base_revision makes the save conditional: the server only applies it
        // if nobody else saved since this device last synced.
        window.socket.emit('save_notepad', {
            text: req.text,
            base_revision: req.base_revision,
            mode: req.mode,
            target_id: req.target_id,
        }, (ack) => {
            notepadSaveInFlight = false;
            handleNotepadSaveAck(req, ack);
        });
    }

    /*
     * The ACK is how THIS saver learns its outcome (the server excludes it from
     * its own broadcast with skip_sid). applied:true advances the revision the
     * next save bases off; applied:false means a stale base -- the server truth
     * wins, the box takes it and the user is told. Either way, a queued save is
     * re-based onto the revision this ACK settled (same bucket only) and flushed,
     * so serialized saves march forward without ever self-conflicting.
     */
    function handleNotepadSaveAck(req, ack) {
        const updateSaveStatus = window.__notepadUpdateSaveStatus;
        if (!ack || typeof ack !== 'object') {
            if (updateSaveStatus) updateSaveStatus('saved');
            drainQueuedNotepadSave(req, null);
            return;
        }
        if (ack.error) {
            showNotification(window.i18n
                ? i18n.t('notepad.saveFailed')
                : 'Failed to save note', 'error');
            drainQueuedNotepadSave(req, null);
            return;
        }
        const revision = typeof ack.revision === 'number' ? ack.revision : null;
        const notepadEl = document.getElementById('sessionNotepad');
        const bucketIsCurrent = sameNotepadBucket(req, {
            mode: currentNotepadMode, target_id: currentNotepadTarget,
        });
        /*
         * IS THE USER STILL IN THIS NOTE? A refusal that lands while they are
         * typing must not take their words away: the box is focused, or a save
         * of theirs is still pending, and their text is the newest intent
         * anybody has expressed.
         */
        const typistIsHere = bucketIsCurrent && !!notepadEl
            && (document.activeElement === notepadEl
                || !!notepadPendingSaveTimer || !!notepadQueuedSave);
        if (ack.applied === false && typistIsHere
                && notepadEl.value !== ack.notepad) {
            /*
             * RE-BASE AND WRITE IT AGAIN, rather than adopt-and-lose.
             *
             * The previous behaviour deferred the server's text to blur and let
             * the refusal stand; on blur that text replaced the box, so the
             * words typed after the conflict were destroyed -- and, with the
             * re-base blocked while a frame was deferred, every following save
             * was refused too (notepad_fast_typing.mjs §4 measured the server
             * ending up empty after 40 characters). A note is one person's
             * scratchpad: the device whose owner is typing wins, and the idle
             * one converges through the broadcast. The deferred frame is
             * dropped because this write supersedes it.
             */
            if (revision !== null) {
                notepadDataRevision = revision;
            }
            deferredNotepadFrame = null;
            notepadQueuedSave = {
                text: notepadEl.value,
                mode: currentNotepadMode,
                target_id: currentNotepadTarget,
                base_revision: notepadDataRevision,
            };
            if (updateSaveStatus) updateSaveStatus('saving');
            drainQueuedNotepadSave(req, null);
            return;
        }
        if (ack.applied === false) {
            /*
             * N3 — a REFUSED save adopts server truth THROUGH the focus gate.
             *
             * The refusal used to call applyNotepadFrame directly, the one path
             * that writes a FOCUSED box -- so a stale save landing mid-keystroke
             * overwrote the caret's line and erased the char the user was still
             * typing, then raised the toast. adoptNotepadFrame takes the revision
             * eagerly (so the next save bases forward) but DEFERS the text paint
             * to blur while the box is focused, exactly as a foreign frame is
             * handled: a genuine conflict still converges, just never over the
             * user's live keystroke. With the direct-flush re-base above, this
             * fires only for a real cross-device conflict, not a fast typist.
             */
            adoptNotepadFrame({
                notepad: ack.notepad,
                revision: ack.revision,
                mode: ack.mode || req.mode,
                target_id: ack.target_id || req.target_id,
            });
            showNotification(window.i18n
                ? i18n.t('notepad.updatedElsewhere')
                : 'Notepad was changed on another device; showing the latest version',
                'warning');
        } else {
            // Applied: adopt the new revision so the next save bases forward.
            // The box is NOT rewritten -- the saver's own text is authoritative.
            if (revision !== null && bucketIsCurrent) {
                notepadDataRevision = revision;
            }
            // A frame held for blur described the note BEFORE this write, so
            // painting it later would undo what was just saved.
            if (deferredNotepadFrame && bucketIsCurrent) {
                deferredNotepadFrame = null;
            }
            if (updateSaveStatus) updateSaveStatus('saved');
        }
        drainQueuedNotepadSave(req, revision);
    }

    function drainQueuedNotepadSave(ackedReq, revision) {
        if (!notepadQueuedSave) {
            return;
        }
        const next = notepadQueuedSave;
        notepadQueuedSave = null;
        // A queued save in the SAME bucket must base off the revision the ACK
        // just settled -- that is the serialized-forward contract that stops a
        // burst from self-conflicting on the old base.
        if (revision !== null && sameNotepadBucket(next, ackedReq)) {
            next.base_revision = revision;
        }
        flushNotepadSave(next);
    }

    function setupResizeHandle() {
        const handle = document.getElementById('resizeHandle');
        const workspace = document.getElementById('workspace');
        const terminalArea = workspace.querySelector('.terminal-area');
        const notepadPanel = document.getElementById('notepadPanel');
        const commandRail = document.getElementById('commandRail');

        if (!handle || !workspace || !terminalArea || !notepadPanel) {
            return;
        }

        /*
         * The two auxiliary panels share one grid track, and the hidden one
         * measures 0. Measuring whichever panel actually occupies the track
         * keeps the drag from starting at 0 and from saving 0 to localStorage.
         */
        const auxPanel = () => (
            commandRail?.classList.contains('aux-open') ? commandRail : notepadPanel
        );

        let isResizing = false;
        let startX = 0;
        let startNotepadWidth = 0;

        const saveLayout = (notepadWidth) => {
            localStorage.setItem('workspace-notepad-width', String(Math.round(notepadWidth)));
        };

        const loadLayout = () => {
            const notepadWidth = parseFloat(localStorage.getItem('workspace-notepad-width'));
            if (!Number.isNaN(notepadWidth) && notepadWidth > 0) {
                workspace.style.setProperty('--notepad-width', `${notepadWidth}px`);
            }
        };

        const startResize = (e) => {
            isResizing = true;
            startX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
            startNotepadWidth = auxPanel().offsetWidth;

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            if (e.pointerId !== undefined) {
                handle.setPointerCapture(e.pointerId);
            }

            e.preventDefault();
        };

        const resize = (e) => {
            if (!isResizing) {
                return;
            }

            const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
            const deltaX = clientX - startX;
            const workspaceWidth = workspace.offsetWidth;

            let newNotepadWidth = startNotepadWidth - deltaX;

            const minNotepadWidth = 180;
            const maxNotepadWidth = workspaceWidth * 0.6;
            const minTerminalWidth = workspaceWidth * 0.3;

            newNotepadWidth = Math.max(minNotepadWidth, Math.min(maxNotepadWidth, newNotepadWidth));
            let newTerminalWidth = workspaceWidth - newNotepadWidth;

            if (newTerminalWidth < minTerminalWidth) {
                newTerminalWidth = minTerminalWidth;
                newNotepadWidth = workspaceWidth - minTerminalWidth;
            }

            workspace.style.setProperty('--notepad-width', `${newNotepadWidth}px`);

            // The terminal wrapper changes size with this grid track. Its
            // debounced ResizeObserver is the single fit owner; scheduling one
            // more timeout per pointermove creates an unbounded fit backlog.

            e.preventDefault();
        };

        const stopResize = () => {
            if (!isResizing) {
                return;
            }

            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            const notepadWidth = auxPanel().getBoundingClientRect().width;
            if (!Number.isNaN(notepadWidth) && notepadWidth > 0) {
                saveLayout(notepadWidth);
            }
        };

        handle.addEventListener('pointerdown', startResize);
        document.addEventListener('pointermove', resize);
        document.addEventListener('pointerup', stopResize);
        document.addEventListener('pointercancel', stopResize);

        handle.style.touchAction = 'none';

        loadLayout();

        if (notepadPanel) {
            const storedNotepadCollapsed = localStorage.getItem('notepadCollapsed');
            const initiallyCollapsed = storedNotepadCollapsed === null
                || storedNotepadCollapsed === 'true';
            if (initiallyCollapsed) {
                notepadPanel.classList.add('collapsed');
            }
            // #notepadOpenBtn is the SOLE Notes aria-expanded owner. The
            // withdrawn in-terminal chevron (#notepadToggle) is gone from the
            // template, so there is no second owner whose state could disagree.
            document.getElementById('notepadOpenBtn')
                ?.setAttribute('aria-expanded', String(!initiallyCollapsed));

            const setNotepadCollapsedLocal = (isCollapsed) => {
                // Desktop opening transition (collapsed -> open) is the moment the
                // notepad claims the shared auxiliary cell, so announce it here.
                if (!isCollapsed && notepadPanel.classList.contains('collapsed')) {
                    document.dispatchEvent(new CustomEvent('sshdeck:aux-panel-opening', {
                        detail: { panel: 'notepad' },
                    }));
                }
                notepadPanel.classList.toggle('collapsed', isCollapsed);
                // Sole aria-expanded owner, updated on every state change.
                document.getElementById('notepadOpenBtn')
                    ?.setAttribute('aria-expanded', String(!isCollapsed));
                localStorage.setItem('notepadCollapsed', isCollapsed);
                setTimeout(() => {
                    if (window.TerminalManager) {
                        const sid = SessionManager.getActiveSession?.();
                        if (sid) TerminalManager.requestFit(sid);
                    }
                }, 300);
            };
            // Publish to the shared binding so setupNotepad's aux-exclusion
            // listener can close the desktop panel through this same helper.
            setNotepadCollapsed = setNotepadCollapsedLocal;

            // Contextual-row open button. Desktop only: on a touch shell the
            // same node drives the .mobile-open sheet from setupNotepad, so
            // running both would toggle the sheet and persist a collapse in
            // one click. The capability predicate keeps the two halves
            // mutually exclusive rather than duplicating either.
            const notepadOpenBtn = document.getElementById('notepadOpenBtn');
            if (notepadOpenBtn) {
                notepadOpenBtn.addEventListener('click', () => {
                    if (window.TerminalManager && TerminalManager.isTouchShell()) {
                        return;
                    }
                    // Toggle. Open if collapsed, close if open.
                    if (notepadPanel.classList.contains('collapsed')) {
                        setNotepadCollapsed(false);
                    } else {
                        setNotepadCollapsed(true);
                    }
                });
            }
        }

        handle.addEventListener('dblclick', (e) => {
            workspace.style.removeProperty('--notepad-width');
            localStorage.removeItem('workspace-notepad-width');
            showNotification('Layout reset to default', 'info');

            if (SessionManager.hasAnySessions()) {
                const activeSessionId = SessionManager.getActiveSession();
                if (activeSessionId) {
                    // Coalesced fit owner; a double-click reset that lands in
                    // the same window as any other fit request produces one fit.
                    TerminalManager.requestFit(activeSessionId);
                }
            }
        });
    }

    function setupDropUpload() {
        const overlay = document.getElementById('dropOverlay');
        const form = document.getElementById('dropUploadForm');
        const fileNameInput = document.getElementById('dropUploadFileName');
        const pathInput = document.getElementById('dropUploadPath');
        const modal = document.getElementById('dropUploadModal');
        let pendingFile = null;

        if (!overlay || !form || !modal) {
            return;
        }

        const showOverlay = () => overlay.classList.remove('hidden');
        const hideOverlay = () => overlay.classList.add('hidden');

        document.addEventListener('dragover', (e) => {
            if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
                e.preventDefault();
                showOverlay();
            }
        });

        document.addEventListener('dragleave', (e) => {
            if (e.target === document.documentElement) {
                hideOverlay();
            }
        });

        document.addEventListener('dragend', () => {
            hideOverlay();
        });

        document.addEventListener('drop', (e) => {
            e.preventDefault();
            hideOverlay();

            const active = SessionManager.getActiveSession();
            if (!active) {
                /*
                 * Quick connect. Dropping a file with nothing connected is a
                 * statement of intent -- the user wants that file on a server --
                 * so the warning is followed by the connection modal rather than
                 * leaving them to find it themselves. This is the one behaviour
                 * carried over from the retired drag-drop-manager.js, whose own
                 * upload paths never ran: they were gated behind a transferClient
                 * that could not be constructed, because binary-transfer-client.js
                 * never exported its class onto window.
                 */
                showNotification('No active session for upload', 'warning');
                const connectionModal = document.getElementById('connectionModal');
                if (connectionModal && window.ModalManager) {
                    window.ModalManager.open(connectionModal);
                }
                return;
            }

            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) {
                return;
            }
            pendingFile = file;
            fileNameInput.value = file.name;
            pathInput.value = `./${file.name}`;

            if (window.ModalManager) {
                window.ModalManager.open(modal);
            } else {
                modal.classList.add('show');
            }
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const active = SessionManager.getActiveSession();
            if (!active || !pendingFile) {
                showNotification('No active session for upload', 'warning');
                return;
            }
            const remotePath = pathInput.value.trim();
            if (!remotePath) {
                showNotification('Remote path required', 'error');
                return;
            }
            FileTransferManager.uploadFile(active, pendingFile, remotePath);
            pendingFile = null;
            if (window.ModalManager) {
                window.ModalManager.close(modal);
            } else {
                modal.classList.remove('show');
            }
        });

        document.getElementById('cancelDropUploadBtn').addEventListener('click', () => {
            pendingFile = null;
            if (window.ModalManager) {
                window.ModalManager.close(modal);
            } else {
                modal.classList.remove('show');
            }
        });

        document.getElementById('closeDropUploadModal').addEventListener('click', () => {
            pendingFile = null;
            if (window.ModalManager) {
                window.ModalManager.close(modal);
            } else {
                modal.classList.remove('show');
            }
        });
    }

    function setupShortcutsModal() {
        const modal = document.getElementById('shortcutsModal');
        const list = document.getElementById('shortcutsList');
        const shortcuts = [
            { keys: 'F1', labelKey: 'shortcuts.openCommandLibrary' },
            { keys: 'Ctrl+K', labelKey: 'shortcuts.openCommandPalette' },
            { keys: 'Ctrl+?', labelKey: 'shortcuts.showShortcuts' },
            { keys: 'Ctrl+Shift+N', labelKey: 'shortcuts.newConnection' },
            { keys: 'Ctrl+F', labelKey: 'shortcuts.searchTerminal' },
            { keys: 'Ctrl/Cmd+C', labelKey: 'shortcuts.copyTerminal' },
            { keys: 'Ctrl/Cmd+V', labelKey: 'shortcuts.pasteTerminal' },
            { keys: 'Ctrl+1-9', labelKey: 'shortcuts.switchTab' },
            { keys: 'Ctrl+Tab', labelKey: 'shortcuts.nextTab' },
            { keys: 'Ctrl+Shift+Tab', labelKey: 'shortcuts.previousTab' },
            { keys: 'F2', labelKey: 'shortcuts.renameFile' },
            { keys: 'F5', labelKey: 'shortcuts.transferFile' },
            { keys: 'F7', labelKey: 'shortcuts.newFolder' },
            { keys: 'Delete', labelKey: 'shortcuts.deleteSelected' },
            { keys: 'Tab', labelKey: 'shortcuts.switchPane' },
            { keys: 'Ctrl+A', labelKey: 'shortcuts.selectAll' },
            { keys: 'Esc', labelKey: 'shortcuts.closeModals' }
        ];
        if (!list) {
            return;
        }

        const renderShortcuts = () => {
            list.innerHTML = '';
            shortcuts.forEach(shortcut => {
                const row = document.createElement('div');
                row.className = 'shortcut-row';
                const label = window.i18n ? i18n.t(shortcut.labelKey) : shortcut.labelKey;
                row.innerHTML = `<strong>${shortcut.keys}</strong><span>${label}</span>`;
                list.appendChild(row);
            });
        };
        renderShortcuts();
        window.addEventListener('languageChanged', renderShortcuts);

        const closeBtn = document.getElementById('closeShortcutsModal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                window.ModalManager.close(modal);
            });
        }

        return modal;
    }

    function setupCommandPalette() {
        const modal = document.getElementById('commandPaletteModal');
        const input = document.getElementById('commandPaletteInput');
        const list = document.getElementById('commandPaletteList');
        if (!modal || !input || !list) {
            return null;
        }

        const actions = [
            { labelKey: 'connection.newConnection', hint: 'Ctrl+Shift+N', action: () => document.getElementById('newConnectionBtn').click() },
            { labelKey: 'commands.library', hint: 'F1', action: () => CommandLibrary.openLibrary({ focusSearch: true }) },
            { labelKey: 'files.fileTransfer', hint: '', action: () => document.getElementById('fileTransferBtn').click() },
            { labelKey: 'keys.manageKeys', hint: '', action: () => document.getElementById('manageKeysBtn').click() },
            { labelKey: 'auth.changePassword', hint: '', action: () => document.getElementById('changePasswordBtn').click() },
            { labelKey: 'terminal.saveTranscript', hint: '', action: () => document.getElementById('saveTranscriptBtn').click() },
            { labelKey: 'shortcuts.title', hint: 'Ctrl+?', action: () => openShortcuts() }
        ];

        let filtered = actions;
        let activeIndex = 0;

        function render() {
            list.innerHTML = '';
            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'palette-item';
                empty.textContent = window.i18n ? i18n.t('palette.noMatches') : 'No matches';
                list.appendChild(empty);
                return;
            }
            filtered.forEach((item, index) => {
                const el = document.createElement('div');
                el.className = 'palette-item' + (index === activeIndex ? ' active' : '');
                const label = window.i18n ? i18n.t(item.labelKey) : item.labelKey;
                el.innerHTML = `${label}<span>${item.hint}</span>`;
                el.addEventListener('click', () => {
                    item.action();
                    closePalette();
                });
                list.appendChild(el);
            });
        }

        function openPalette() {
            input.value = '';
            filtered = actions;
            activeIndex = 0;
            render();
            window.ModalManager.open(modal);
            setTimeout(() => input.focus(), 50);
        }

        function closePalette() {
            window.ModalManager.close(modal);
        }

        input.addEventListener('input', () => {
            const query = input.value.trim().toLowerCase();
            filtered = actions.filter(item => {
                const label = window.i18n ? i18n.t(item.labelKey) : item.labelKey;
                return label.toLowerCase().includes(query);
            });
            activeIndex = 0;
            render();
        });

        window.addEventListener('languageChanged', render);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
                render();
                e.preventDefault();
            } else if (e.key === 'ArrowUp') {
                activeIndex = Math.max(activeIndex - 1, 0);
                render();
                e.preventDefault();
            } else if (e.key === 'Enter') {
                const item = filtered[activeIndex];
                if (item) {
                    item.action();
                    closePalette();
                }
            } else if (e.key === 'Escape') {
                closePalette();
            }
        });

        document.getElementById('closeCommandPaletteModal').addEventListener('click', () => closePalette());
        return openPalette;
    }

    let openShortcuts = null;
    let shortcutsModal = null;
    let openPalette = null;

    /*
     * W14 item 8: assemble the STORABLE payload for save-as-profile.
     *
     * This is deliberately NOT derived from `connectionData` (the connect
     * frame): the connect frame carries the password for password auth and a
     * proxy_jump credential block, and deriving from it would make "never
     * persist the secret" depend on remembering to strip fields out of the
     * wrong object. Instead each storable field is read from its own form
     * Control here, exactly the way the profile editor's saveFromEditor
     * builds its payload (profile-manager.js), and nothing secret is ever
     * touched. Server-side, _validate_profile_payload reconstructs the stored
     * record from an allow-list and never accepts credential fields, so this
     * is defense in depth, not the only line.
     */
    function buildConnectionProfilePayload(name) {
        const payload = {
            name: name,
            host: document.getElementById('hostInput').value.trim(),
            port: Number(document.getElementById('portInput').value) || 22,
            username: document.getElementById('usernameInput').value.trim(),
            auth_type: document.getElementById('authTypeSelect').value,
        };
        if (payload.auth_type === 'key') {
            payload.key_id = document.getElementById('keySelect').value || null;
        }
        const jumpHostId = document.getElementById('jumpHostSelect').value;
        if (jumpHostId) {
            payload.jump_host_id = jumpHostId;
        }
        Object.assign(payload, ConnectionCommandManager.getPayload());
        return payload;
    }

    /*
     * W14 item 8: reset the save-as-profile controls. Called when the modal
     * opens, so the checkbox is OFF (the default) and a stale name from a
     * previous attempt never rides along into the next connection.
     */
    function resetSaveProfileControls() {
        const check = document.getElementById('saveProfileCheck');
        if (check) {
            check.checked = false;
        }
        const nameInput = document.getElementById('profileNameInput');
        if (nameInput) {
            nameInput.value = '';
        }
        const group = document.getElementById('profileNameGroup');
        if (group) {
            group.classList.add('hidden');
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const reconnectBar = document.createElement('div');
        reconnectBar.id = 'reconnectBar';
        reconnectBar.className = 'reconnect-bar';
        reconnectBar.style.display = 'none';
        reconnectBar.innerHTML = '<span class="reconnect-text">Connection lost. Reconnecting...</span>';
        const header = document.querySelector('.header');
        if (header) {
            header.after(reconnectBar);
        }

        SessionManager.init();

        CommandWorkspace.init();
        CommandLibrary.init();
        window.CommandSetManager?.init();
        window.ConnectionCommandManager?.init();
        ProfileManager.init();

        ProfileManager.loadProfiles();
        ProfileManager.loadKeys();
        if (window.JumpHostManager) {
            window.JumpHostManager.load();
        }

        document.getElementById('newConnectionBtn').addEventListener('click', () => {
            openConnectionModalForPane(getDefaultPaneIndex());
        });

        // #newTabBtn used to sit at the end of the session row and forward its
        // click straight to #newConnectionBtn -- two buttons, two labels, one
        // action. It is gone; the labelled Connect button is the one that stays.

        document.getElementById('closeConnectionModal').addEventListener('click', () => {
            window.ModalManager.close(document.getElementById('connectionModal'));
            setConnectLoading(false);
            currentConnectRequestId = null;
            clearPaneQueue();
            if (connectTimer) { clearInterval(connectTimer); connectTimer = null; }
            // ONE owner for all four dismissal routes (X, Cancel, outside click,
            // failed connect): clears Reset's meta, cancels the exact reconnect
            // claim that owns this modal, and hides the intent banner. Nothing is
            // destroyed — the session or candidate chip was deliberately left
            // intact while the form was open.
            SessionManager.resetConnectionModalIntent();
        });

        document.getElementById('cancelConnectionBtn').addEventListener('click', () => {
            window.ModalManager.close(document.getElementById('connectionModal'));
            setConnectLoading(false);
            currentConnectRequestId = null;
            clearPaneQueue();
            if (connectTimer) { clearInterval(connectTimer); connectTimer = null; }
            SessionManager.resetConnectionModalIntent();
        });

        document.getElementById('connectionForm').addEventListener('submit', (e) => {
            e.preventDefault();

            const host = document.getElementById('hostInput').value;
            const port = document.getElementById('portInput').value;
            const username = document.getElementById('usernameInput').value;
            const authType = document.getElementById('authTypeSelect').value;
            const password = document.getElementById('passwordInput').value;
            const keyId = document.getElementById('keySelect').value;
            const targetPane = pendingPaneIndex;

            if (!host || !username) {
                showNotification('Host and username are required', 'error');
                return;
            }

            if (authType === 'password' && !password) {
                showNotification('Password is required', 'error');
                document.getElementById('passwordInput').focus();
                return;
            }

            if (authType === 'key' && !keyId) {
                showNotification('SSH key is required', 'error');
                return;
            }

            // Optional jump host (bastion) — chosen from the saved list
            const jumpHostId = document.getElementById('jumpHostSelect').value;
            let proxyJump = null;
            if (jumpHostId) {
                const jh = window.JumpHostManager ? window.JumpHostManager.getById(jumpHostId) : null;
                if (!jh) {
                    showNotification('Selected jump host not found', 'error');
                    return;
                }
                proxyJump = {
                    host: jh.host,
                    port: jh.port,
                    username: jh.username,
                    auth_type: jh.auth_type
                };
                if (jh.auth_type === 'password') {
                    const jhPass = document.getElementById('jumpHostPasswordInput').value;
                    if (!jhPass) {
                        showNotification('Jump host password is required', 'error');
                        document.getElementById('jumpHostPasswordInput').focus();
                        return;
                    }
                    proxyJump.password = jhPass;
                } else {
                    proxyJump.key_id = jh.key_id;
                }
            }

            pendingPaneIndex = null;
            // Constraint A: resolve the request id FIRST. A reset reuses the
            // fresh reset_* id stored in pendingResetMeta so payload, pending
            // record and pane map all carry the same id. Do not create a req_*
            // record and rename it later.
            const resetMeta = SessionManager.pendingResetMeta;
            // The reconnect through the credential form, resolved by the request
            // that OWNS the modal -- not by a single global slot. Its request id
            // was minted when the form opened, for the same Constraint-A reason
            // the reset id is: payload, pending record and pane map must agree,
            // and success/error must be able to find this exact request among
            // any others already in flight.
            const reconnectMeta = SessionManager.activeReconnectIntent();
            currentConnectRequestId = resetMeta
                ? resetMeta.requestId
                : (reconnectMeta
                    ? reconnectMeta.requestId
                    : `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
            SessionManager.createPendingConnection(currentConnectRequestId, host, username, port, {
                authType, keyId, jumpHostId: jumpHostId || null,
                // Request-correlated only. The old `pendingDisplayName` global
                // in this list was shared mutable state: with two connections in
                // flight the second consumed the first's name.
                displayName: resetMeta?.displayName || reconnectMeta?.displayName
                    || null,
            });
            if (targetPane !== null && targetPane !== undefined) {
                pendingRequestPaneMap.set(currentConnectRequestId, targetPane);
            }

            /*
             * W14 item 8: capture a pending profile save for THIS request only.
             *
             * It is keyed by client_request_id so the ssh_connected for exactly
             * the request the user submitted is what triggers the save -- never a
             * different in-flight request. It is an ORDINARY connect only:
             * Reconnect and Reset reuse this same form with lifecycle intent, and
             * saving a profile out of a reconnect/reset attempt was never the
             * contract, so both are excluded. The payload is assembled now (before
             * the form is reset) and carries no secret. Auto-launch
             * (launchProfileForPane -> requestSubmit) never checks this box, so it
             * records nothing and emits zero save_profile frames.
             */
            const saveProfileCheck = document.getElementById('saveProfileCheck');
            if (saveProfileCheck && saveProfileCheck.checked
                && !resetMeta && !reconnectMeta) {
                const profileName = (document.getElementById('profileNameInput')
                    ?.value || '').trim();
                pendingProfileSaveMap.set(currentConnectRequestId,
                    buildConnectionProfilePayload(
                        profileName || `${username}@${host}`));
            } else if (pendingProfileSaveMap.has(currentConnectRequestId)) {
                pendingProfileSaveMap.delete(currentConnectRequestId);
            }

            const connectionData = {
                host: host,
                port: parseInt(port),
                username: username,
                client_request_id: currentConnectRequestId,
                auth_type: authType
            };
            Object.assign(connectionData, ConnectionCommandManager.getPayload());

            if (authType === 'password') {
                connectionData.password = password;
            } else if (authType === 'key') {
                connectionData.key_id = keyId;
            }

            if (proxyJump) {
                connectionData.proxy_jump = proxyJump;
            }

            const useTmuxCheck = document.getElementById('useTmuxCheck');
            if (useTmuxCheck && useTmuxCheck.checked) {
                connectionData.use_tmux = true;
            }

            // §12.6 Reset (modal path): force fresh-session fields on the
            // payload. Do NOT consume/close here — that happens immediately
            // before socket.emit so the old session is not lost if the
            // intervening UI-setup throws.
            if (resetMeta) {
                connectionData.use_tmux = false;
                connectionData.reconnect_tmux_name = null;
                if (resetMeta.displayName) {
                    connectionData.display_name = resetMeta.displayName;
                }
            }

            /*
             * Reconnect through the credential form: assert the RECONNECT fields
             * on the payload, mirroring how Reset asserts its own.
             *
             * The tmux name comes from the INTENT record, keyed by the request
             * that owns this modal. It used to come from the shared
             * `pendingReconnectTmux` global, which the tmux-checkbox block above
             * consumed and nulled -- so a reconnect emitted use_tmux with no
             * name, i.e. a FRESH tmux session. That was the silent reset the owner
             * reported. A second connection in flight could blank it too.
             *
             * D2a: the use_tmux flag follows the
             * SAME rule the intent's tmux name does. A reconnect intent WITH a
             * real tmux name reattaches: use_tmux:true plus the exact name. A
             * reconnect intent WITHOUT one — the ordinary disconnected non-tmux
             * Retry, which D2a now routes through this intent so its dead chip
             * retires on success — keeps its plain non-tmux semantics:
             * use_tmux:false and no reconnect_tmux_name. The old unconditional
             * true turned that restore into a request for a NEW tmux session —
             * exactly the "use_tmux with no name" defect class the paragraph
             * above describes, rediscovered one layer down. The server reads
             * use_tmux:false as "no tmux", so the restore lands as the logical
             * session, not a tmux wrapper.
             *
             * Reset and reconnect can never both apply: opening either cancels
             * the other's pending state.
             */
            if (reconnectMeta && !resetMeta) {
                connectionData.use_tmux = !!reconnectMeta.tmuxSessionName;
                if (reconnectMeta.tmuxSessionName) {
                    connectionData.reconnect_tmux_name = reconnectMeta.tmuxSessionName;
                    // The SOURCE session id travels with every reattach
                    // claim. The server binds the claim to exactly this row --
                    // same session, same host/port/username -- and refuses a
                    // name that belongs to any other session rather than
                    // dropping it and connecting fresh under Reconnect's label.
                    connectionData.session_id = reconnectMeta.sessionId;
                }
                if (reconnectMeta.displayName) {
                    connectionData.display_name = reconnectMeta.displayName;
                }
            }

            const connectBtn = document.getElementById('connectBtn');
            const originalText = connectBtn.textContent;
            connectSeconds = 0;
            connectBtn.textContent = 'Connecting... 0s';
            connectTimer = setInterval(() => {
                connectSeconds++;
                connectBtn.textContent = `Connecting... ${connectSeconds}s`;
            }, 1000);

            /*
             * NO endpoint-wide candidate sweep here.
             *
             * There used to be one: every candidate matching host/port/user was
             * removeSessionUI'd at emit time. Two things were wrong with it.
             * First, one endpoint can legitimately have SEVERAL tmux candidates
             * (the tmux name is what distinguishes them, and the sweep ignored
             * it), so reconnecting one silently destroyed the offers for all the
             * others -- with no server round trip, so they were simply gone from
             * the UI until the next restore. Second, it removed the very
             * candidate being reconnected, before its replacement existed: a
             * failed connect then left nothing to retry from and the transcript
             * handoff with no source.
             *
             * Exactly ONE session may retire on success: the sessionId owned by
             * the intent whose client_request_id came back. completePendingReconnect
             * does that, after the replacement session exists, with the
             * transcript carried across first.
             */

            /*
             * Consume pendingResetMeta exactly once, immediately before the
             * single socket.emit. The equality check guards against a concurrent
             * reset clearing a different one.
             *
             * WHICH RETIREMENT RULE APPLIES depends on what is being reset, and
             * conflating the two was a release blocker:
             *
             *   * a LIVE session is closed here, before the emit. It has a real
             *     connection the user asked to replace, and closeSession ->
             *     ssh_disconnect closes it and kills its tmux. Destructive by
             *     design, unchanged.
             *   * a CANDIDATE is NOT touched. It has no transport, so the same
             *     call only made the server delete the persisted offer while
             *     Close_session failed to kill anything — so a cancelled or
             *     failed Reset destroyed the offer for good and left an orphan
             *     pane. Its chip, DB row, selection, notes and label survive the
             *     whole attempt; only the ssh_connected carrying THIS request's
             *     id retires it, via completePendingReset.
             */
            if (resetMeta && resetMeta === SessionManager.pendingResetMeta) {
                SessionManager.pendingResetMeta = null;
                if (resetMeta.fromCandidate) {
                    SessionManager.beginCandidateResetIntent(
                        resetMeta.sessionId, resetMeta.requestId);
                } else if (SessionManager.sessions[resetMeta.sessionId]) {
                    SessionManager.closeSession(resetMeta.sessionId);
                }
            }

            socket.emit('ssh_connect', connectionData);
            setConnectLoading(true);
            /*
             * The form is on its way out. Release the MODAL ownership -- but not
             * the intent: it stays in the registry under its own request id,
             * because that is what the reply will be matched against.
             *
             * releaseReconnectModal, never a raw `activeReconnectRequestId =
             * null`: it releases only if THIS request is the owner, so a submit
             * cannot free a modal another request is holding. And never
             * resetConnectionModalIntent, which cancels the intent -- right for a
             * dismissal, wrong for a submit that has just sent the frame.
             */
            if (reconnectMeta) {
                SessionManager.releaseReconnectModal(reconnectMeta.requestId);
            }
            SessionManager.setConnectionFormIntent(null);

            document.getElementById('passwordInput').value = '';
            document.getElementById('jumpHostPasswordInput').value = '';
        });

        document.getElementById('profileSelect').addEventListener('change', (e) => {
            selectConnectionProfile(e.target.value);
        });

        document.getElementById('deleteProfileBtn').addEventListener('click', (e) => {
            const profileId = e.target.dataset.profileId;
            if (profileId) {
                ProfileManager.deleteProfile(profileId);
                window.clearConnectionProfileState();
            }
        });

        document.getElementById('authTypeSelect').addEventListener('change', (e) => {
            ProfileManager.handleAuthTypeChange(e.target.value);
        });

        /*
         * W14 item 8: the profile-name field is only meaningful while
         * save-as-profile is checked, so it is revealed/hidden with the box.
         * This is presentation only -- the actual save gate is the checkbox at
         * submit time, so the field's visibility never controls the contract.
         */
        document.getElementById('saveProfileCheck')?.addEventListener('change', (e) => {
            const group = document.getElementById('profileNameGroup');
            if (group) {
                group.classList.toggle('hidden', !e.target.checked);
            }
            if (e.target.checked) {
                document.getElementById('profileNameInput')?.focus();
            }
        });

        document.getElementById('jumpHostSelect').addEventListener('change', () => {
            if (window.JumpHostManager) {
                window.JumpHostManager.updatePasswordVisibility();
            }
        });

        document.getElementById('manageKeysBtn').addEventListener('click', () => {
            window.ModalManager.open(document.getElementById('keyManagementModal'));
            ProfileManager.loadKeys();
        });

        document.getElementById('closeKeyModal').addEventListener('click', () => {
            window.ModalManager.close(document.getElementById('keyManagementModal'));
        });

        document.getElementById('keyUploadForm').addEventListener('submit', (e) => {
            e.preventDefault();

            const name = document.getElementById('keyNameInput').value;
            const keyContent = document.getElementById('keyContentInput').value;

            if (!name || !keyContent) {
                showNotification('Key name and content are required', 'error');
                return;
            }

            ProfileManager.uploadKey(name, keyContent);
        });

        document.getElementById('manageJumpHostsBtn')?.addEventListener('click', () => {
            window.ModalManager.open(document.getElementById('jumpHostManagementModal'));
            ProfileManager.loadKeys();
            if (window.JumpHostManager) {
                window.JumpHostManager.load();
                window.JumpHostManager.renderList();
            }
        });

        document.getElementById('closeJumpHostModal')?.addEventListener('click', () => {
            window.ModalManager.close(document.getElementById('jumpHostManagementModal'));
        });

        document.querySelectorAll('input[name="jhAuthType"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.getElementById('jhKeyGroup').classList.toggle('hidden', e.target.value !== 'key');
            });
        });

        document.getElementById('jumpHostForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('jhNameInput').value.trim();
            const host = document.getElementById('jhHostInput').value.trim();
            const port = document.getElementById('jhPortInput').value;
            const username = document.getElementById('jhUsernameInput').value.trim();
            const authType = document.querySelector('input[name="jhAuthType"]:checked').value;
            const keyId = document.getElementById('jhKeySelect').value;
            if (!name || !host || !username) {
                showNotification('Name, host and username are required', 'error');
                return;
            }
            if (authType === 'key' && !keyId) {
                showNotification('SSH key is required', 'error');
                return;
            }
            if (window.JumpHostManager) {
                window.JumpHostManager.save(name, host, port, username, authType, keyId);
            }
        });

        const changePasswordBtn = document.getElementById('changePasswordBtn');
        if (changePasswordBtn) {
            changePasswordBtn.addEventListener('click', () => {
                window.location.href = APP_ROOT + '/change-password';
            });
        }

        // Scrollback lines setting
        const scrollbackInput = document.getElementById('scrollbackInput');
        if (scrollbackInput) {
            const savedScrollback = localStorage.getItem('terminalScrollback') || '150';
            scrollbackInput.value = savedScrollback;
            scrollbackInput.addEventListener('change', () => {
                // One owner decides what a legal capacity is: the same sanitizer
                // createTerminal uses. The parseInt + 50/10000 pair that stood
                // here read a numeric prefix ('1e3' -> 1) and sent every
                // malformed value to the floor instead of the default, so one
                // stored string could mean 50 lines on the live terminals and
                // 150 on the next reload.
                const val = TerminalManager.sanitizeScrollback(scrollbackInput.value);
                scrollbackInput.value = val;
                localStorage.setItem('terminalScrollback', String(val));
                // Update all existing terminals
                Object.keys(TerminalManager.terminals).forEach(key => {
                    TerminalManager.terminals[key].options.scrollback = val;
                });
            });
        }

        /*
         * LOGOUT ASKS ONLY WHEN THERE IS SOMETHING TO LOSE.
         * ====================================================================
         * OWNER REPORT: "modal mac dinh cua he thong khi tat dong
         * chuyen trang van chua duoc bo di. Chi duy nhat chip connect khong co
         * phien tmux gan ma chay binh thuong tat di se mat moi can thong bao
         * thoi."
         *
         * This was the dialog he meant -- not `beforeunload`, which went on
         *but a native `confirm` on the Logout button. It fired
         * for everyone, every time, and its own text said the sessions would be
         * preserved, so it asked permission for nothing.
         *
         * A session is only LOST by leaving when it is live and has no tmux
         * session on the remote host to come back to. `tmuxSessionName` is the
         * test rather than `useTmux`: a row can carry is_persistent with a null
         * name, which claims tmux and has nothing to reattach (see
         * session-manager.js, the candidate shapes).
         *
         * When something really would be lost the app asks in its OWN modal,
         * naming what goes. Otherwise it logs straight out.
         */
        function submitLogout() {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = APP_ROOT + '/logout';
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            if (csrfToken) {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'csrf_token';
                input.value = csrfToken;
                form.appendChild(input);
            }
            document.body.appendChild(form);
            form.submit();
        }

        function sessionsLostOnLeaving() {
            return Object.values(SessionManager.sessions || {}).filter(s =>
                s && s.connected === true && !s.isPersistentCandidate
                && !s.tmuxSessionName);
        }

        document.getElementById('logoutBtn').addEventListener('click', () => {
            const doomed = sessionsLostOnLeaving();
            if (doomed.length === 0) {
                submitLogout();
                return;
            }
            const t = (key, fallback) => (window.i18n ? i18n.t(key, fallback) : fallback);
            SessionManager.openSessionConfirm({
                title: t('auth.logoutTitle', 'Log out?'),
                body: t('auth.logoutLosesSessions',
                    'These connections have no tmux session on the remote host, '
                    + 'so logging out ends them: ')
                    + doomed.map(s => s.displayName || s.host || s.id).join(', '),
                acceptLabel: t('auth.logout', 'Logout'),
                icon: 'log-out',
                danger: true,
                onAccept: submitLogout,
            });
        });

        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                window.ModalManager.close(e.target);
                if (e.target.id === 'connectionModal') {
                    clearPaneQueue();
                    if (connectTimer) { clearInterval(connectTimer); connectTimer = null; }
                    // Same single owner as the X / Cancel buttons.
                    SessionManager.resetConnectionModalIntent();
                }
            }
        });

        document.addEventListener('keydown', (e) => {
            const tag = document.activeElement?.tagName;
            if ((tag === 'INPUT' || tag === 'TEXTAREA') && e.key !== 'F1' && e.key !== 'Escape') {
                return;
            }

            if (e.key === 'F1') {
                e.preventDefault();
                CommandLibrary.toggleLibrary();
            }

            if (e.ctrlKey && e.key.toLowerCase() === 'f') {
                if (SessionManager.hasAnySessions()) {
                    e.preventDefault();
                    TerminalSearch.toggle();
                }
            }

            if (e.ctrlKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (openPalette) {
                    openPalette();
                }
            }

            if (e.ctrlKey && (e.key === '/' || e.key === '?')) {
                e.preventDefault();
                if (openShortcuts) {
                    openShortcuts();
                }
            }

            if (e.ctrlKey && e.shiftKey && e.key === 'N') {
                e.preventDefault();
                document.getElementById('newConnectionBtn').click();
            }

            if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
                e.preventDefault();
                const index = parseInt(e.key) - 1;
                const tabs = document.querySelectorAll('.session-tab');
                if (tabs[index]) {
                    tabs[index].click();
                }
            }

            if (e.ctrlKey && e.key === 'Tab') {
                e.preventDefault();
                const tabs = Array.from(document.querySelectorAll('.session-tab'));
                const activeIndex = tabs.findIndex(t => t.classList.contains('active'));
                if (tabs.length > 0) {
                    const nextIndex = e.shiftKey
                        ? (activeIndex - 1 + tabs.length) % tabs.length
                        : (activeIndex + 1) % tabs.length;
                    tabs[nextIndex].click();
                }
            }

            if (e.key === 'Escape') {
                if (TerminalSearch.isOpen) {
                    TerminalSearch.close();
                } else {
                    document.querySelectorAll('.modal.show').forEach(modal => {
                        window.ModalManager.close(modal);
                    });
                }
            }

            window.ModalManager.trapFocus(e);
        });

        // The hamburger and its outside-click closer are gone with the second
        // header bar. They existed only to re-show .header-buttons, which the
        // phone stylesheet had hidden after laying it out as a column -- three
        // layers for one behaviour. The six actions are now glyph-only buttons
        // in row one of the bar, visible at every width, so there is nothing to
        // toggle and no .is-open state to leak.

        setupConnectionValidation();
        setupPasswordToggles();
        setupClipboardActions();
        setupDropUpload();
        setupSplitControls();
        setupNotepad();
        setupResizeHandle();
        TerminalSearch.init();
        FilePreview.init();

        shortcutsModal = setupShortcutsModal();
        openShortcuts = () => {
            if (shortcutsModal) {
                window.ModalManager.open(shortcutsModal);
            }
        };

        openPalette = setupCommandPalette();

        document.getElementById('closeCommandPaletteModal')?.addEventListener('click', () => {
            window.ModalManager.close(document.getElementById('commandPaletteModal'));
        });

        /*
         * NO beforeunload HERE, DELIBERATELY.
         * --------------------------------------------------------------------
         * This used to warn "You have active SSH sessions. They will be
         * closed." Two things were wrong with it. The warning was FALSE: a
         * tmux session survives the page, the registry keeps its row, and the
         * restore on the next connect puts it back -- which is the whole
         * design since the views rewrite. And a beforeunload listener cannot
         * be styled: every engine has ignored custom text since 2016, so the
         * owner got the browser's own dialog ("khong co modal rieng, van dung
         * modal mac dinh cua he thong kha xau") and could not be given a
         * better one.
         *
         * Removing it also hands the page back to BFCache -- Chromium
         * disqualifies any document with a beforeunload listener -- so Back
         * and Forward now restore this page instantly instead of reloading
         * it, and the `pageshow`/`persisted` paths below become live.
         *
         * FilePreview keeps its own beforeunload for an editor with unsaved
         * text: that warning is true, and it only arms while text is dirty.
         */

        // Cleanup observers and timers on page unload.
        window.addEventListener('pagehide', () => {
            window.HeaderMenus?.cleanup();
            // This document is going away -- frozen, discarded or navigated --
            // so its tmux clients must go with it RIGHT NOW. The detach is
            // synchronous because pagehide is the last task the page may run,
            // and a lost detach is exactly the stuck-size bug: the other device
            // would stay clipped to a phone that is no longer watching. A
            // bfcache return re-attaches from pageshow.
            window.TerminalManager?.syncViews();
        });

        /*
         * THE VISIBILITY LIFECYCLE OF THIS PAGE'S TMUX CLIENTS. One rule:
         * whenever what THIS PAGE displays changes, bring the attached set in
         * line with it, synchronously. The edges:
         *
         *   visibilitychange hidden  -- tab backgrounded/app switched away:
         *                              detach, which is what returns the pane
         *                              to the other device's size.
         *   visibilitychange visible -- back on screen: re-attach at this
         *                              page's own measured size.
         *   freeze                   -- Chrome freezing the page for memory
         *                              reclaim; no further JS is guaranteed, so
         *                              the detach has to happen here.
         *   pageshow persisted       -- a bfcache RESTORE: the page was hidden
         *                              while frozen and its clients are gone.
         *   socket connect           -- handled by resetSocketEpoch, which
         *                              re-attaches everything displayed.
         *
         * All of them go through syncViews, which is idempotent: a redundant
         * edge costs one comparison and emits nothing.
         */
        const syncPageViews = () => window.TerminalManager?.syncViews();
        document.addEventListener('visibilitychange', syncPageViews);
        document.addEventListener('freeze', syncPageViews);
        window.addEventListener('pageshow', (event) => {
            if (event.persisted) {
                // The socket may have cycled while the page was away, so the
                // recorded sizes no longer match anything the server holds.
                window.TerminalManager?.resetSocketEpoch();
            }
        });

        /*
         * Status bar (approved v5 mockup, bottom band).
         * =============================================
         *
         * Reads state that already exists; it adds no Socket.IO event and no
         * server change. Three inputs:
         *
         *   state    -- the active SSH session record is authoritative. Socket
         *               lifecycle events only trigger a refresh; they do not
         *               override a live SSH session's visible state.
         *   latency  -- the active session's SSH round-trip latency, the same
         *               value rendered in that session's desktop chip.
         *   geometry -- the active terminal's cols/rows, read on the same
         *               resize path terminal-manager already runs.
         *
         * Everything is guarded: no #statusBar (the band is display:none on
         * phone tiers, but the node still exists) or no terminal yet must be a
         * no-op, never a throw, because this runs on every socket event.
         */
        const StatusBar = (() => {
            const bar = document.getElementById('statusBar');
            // Both members, so a caller never has to feature-test the shape:
            // scheduleRefresh is now the one the listeners use, and a missing
            // node must degrade to a no-op for it too, not to undefined.
            if (!bar) return { refresh() {}, scheduleRefresh() {} };

            const dot = document.getElementById('statusBarDot');
            const text = document.getElementById('statusBarStateText');
            const latencyEl = document.getElementById('statusBarLatency');
            const dimsEl = document.getElementById('statusBarDims');

            const t = (key, fallback) =>
                (window.i18n && typeof i18n.t === 'function') ? i18n.t(key) : fallback;

            /*
             * P5 defect: both of these read `window.SessionManager`, but
             * SessionManager is a top-level `const` (session-manager.js:1) and
             * is never assigned onto window -- unlike TerminalManager, which is
             * (terminal-manager.js:1203). So the guard was permanently false:
             * the band could report "connecting" but never "connected", and the
             * Cols x rows read-out was always blank because activeTerminal
             * returned null before it ever looked at the map. Guard on typeof,
             * which is what the rest of this file does.
             */
            const activeSessionId = () =>
                (typeof SessionManager === 'undefined')
                    ? null : SessionManager.activeSessionId;

            function activeSession() {
                const id = activeSessionId();
                return id && typeof SessionManager !== 'undefined'
                    ? SessionManager.getSession(id) : null;
            }

            function currentState() {
                const session = activeSession();
                if (!session) return 'disconnected';
                return session.connected ? 'connected' : 'disconnected';
            }

            function activeTerminal() {
                if (!window.TerminalManager || !TerminalManager.terminals) return null;
                const id = activeSessionId();
                if (!id) return null;
                // The map is keyed by terminalKey, which defaults to sessionId
                // (terminal-manager.js createTerminal). Fall back to a prefix
                // match so a split pane's suffixed key still resolves.
                if (TerminalManager.terminals[id]) return TerminalManager.terminals[id];
                const key = Object.keys(TerminalManager.terminals)
                    .find(k => k === id || k.startsWith(id + '-'));
                return key ? TerminalManager.terminals[key] : null;
            }

            function refresh() {
                const state = currentState();
                bar.dataset.state = state;

                if (text) {
                    // data-i18n on the node keeps the language switcher working;
                    // this sets the key so a later switch re-resolves it.
                    const key = 'status.' + state;
                    text.setAttribute('data-i18n', key);
                    text.textContent = t(key, state);
                }
                if (dot) dot.className = 'status-dot ' + state;

                if (latencyEl) {
                    const session = activeSession();
                    latencyEl.textContent = state === 'connected'
                        && typeof session?.latencyMs === 'number'
                        ? `${session.latencyMs} ms` : '';
                }

                if (dimsEl) {
                    const term = activeTerminal();
                    dimsEl.textContent = (term && term.cols && term.rows)
                        ? `${term.cols} × ${term.rows}` : '';
                }
            }

            /*
             * layout": every event below wrote the whole bar synchronously, so a
             * burst coalesced nowhere. Measured with eight restored sessions: one
             * cycle of latency replies produced 48 mutation records on #statusBar,
             * and 7 of the 8 replies concerned a session that is not even the
             * active one — the bar can only ever show ONE session, so at most one
             * write per frame is meaningful.
             *
             * scheduleRefresh coalesces to one refresh per animation frame. It is
             * what the listeners register, so a burst of any size costs a single
             * recomputation on the next frame, while a single event still repaints
             * in that same frame. StatusBar.refresh stays exported and synchronous
             * for callers (and tests) that need the value immediately.
             */
            let refreshQueued = false;
            function scheduleRefresh() {
                if (refreshQueued) return;
                refreshQueued = true;
                const run = () => { refreshQueued = false; refresh(); };
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(run);
                } else {
                    setTimeout(run, 16);
                }
            }

            if (window.socket) {
                socket.on('connect', scheduleRefresh);
                socket.on('disconnect', scheduleRefresh);
                socket.on('ssh_connected', scheduleRefresh);
                socket.on('ssh_disconnected', scheduleRefresh);
            }
            document.addEventListener('sshdeck:active-session-changed', scheduleRefresh);
            document.addEventListener('sshdeck:session-status-changed', scheduleRefresh);
            document.addEventListener('sshdeck:session-latency-changed', scheduleRefresh);
            document.addEventListener('sshdeck:terminal-resized', scheduleRefresh);
            window.addEventListener('resize', scheduleRefresh);

            refresh();
            return { refresh, scheduleRefresh };
        })();
        window.StatusBar = StatusBar;

        /*
         * W14 item 3: the touch-tier mini status band (#mobileMiniStatus).
         *
         * The desktop #statusBar is hidden on touch shells, and before this
         * there was nothing below the composer -- the missing flush bottom
         * edge. This is the same pattern, shrunk to one compact line: the
         * active session's connection dot + state word, and its latency from
         * the same `session_latency` poll (SessionManager.applySessionLatency
         * -> `sshdeck:session-latency-changed`). One coalesced refresh per
         * frame, exactly like the desktop bar, so a burst of latency replies
         * costs one recomputation.
         *
         * It only exists in the DOM on touch tiers (CSS turns it on there and
         * keeps it display:none elsewhere, including short landscape), so the
         * renderer degrades to a no-op when the node is absent -- a desktop
         * page never paints it and never pays for it.
         */
        const MobileStatusBar = (() => {
            const bar = document.getElementById('mobileMiniStatus');
            if (!bar) return { refresh() {}, scheduleRefresh() {} };

            const dot = document.getElementById('mobileMiniStatusDot');
            const text = document.getElementById('mobileMiniStatusText');
            const latencyEl = document.getElementById('mobileMiniStatusLatency');

            const t = (key, fallback) =>
                (window.i18n && typeof i18n.t === 'function') ? i18n.t(key) : fallback;

            const activeSession = () => {
                if (typeof SessionManager === 'undefined') return null;
                const id = SessionManager.activeSessionId;
                return id ? SessionManager.getSession(id) : null;
            };

            function refresh() {
                const session = activeSession();
                const state = session
                    ? (session.connected ? 'connected' : 'disconnected')
                    : 'disconnected';
                bar.dataset.state = state;

                if (text) {
                    const key = 'status.' + state;
                    text.setAttribute('data-i18n', key);
                    text.textContent = t(key, state);
                }
                if (dot) dot.className = 'status-dot ' + state;

                if (latencyEl) {
                    latencyEl.textContent = state === 'connected'
                        && typeof session?.latencyMs === 'number'
                        ? `${session.latencyMs} ms` : '';
                }
            }

            let refreshQueued = false;
            function scheduleRefresh() {
                if (refreshQueued) return;
                refreshQueued = true;
                const run = () => { refreshQueued = false; refresh(); };
                if (typeof requestAnimationFrame === 'function') {
                    requestAnimationFrame(run);
                } else {
                    setTimeout(run, 16);
                }
            }

            if (window.socket) {
                socket.on('connect', scheduleRefresh);
                socket.on('disconnect', scheduleRefresh);
                socket.on('ssh_connected', scheduleRefresh);
                socket.on('ssh_disconnected', scheduleRefresh);
            }
            document.addEventListener('sshdeck:active-session-changed', scheduleRefresh);
            document.addEventListener('sshdeck:session-status-changed', scheduleRefresh);
            document.addEventListener('sshdeck:session-latency-changed', scheduleRefresh);

            refresh();
            return { refresh, scheduleRefresh };
        })();
        window.MobileStatusBar = MobileStatusBar;

        console.log('SSHDeck initialized');
    });
})();
