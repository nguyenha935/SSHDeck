const FileTransferManager = {
    updateSessionSelects() {
        const uploadSelect = document.getElementById('uploadSessionSelect');
        const downloadSelect = document.getElementById('downloadSessionSelect');

        if (!uploadSelect || !downloadSelect) return;

        uploadSelect.innerHTML = '<option value="">-- Select Active Session --</option>';
        downloadSelect.innerHTML = '<option value="">-- Select Active Session --</option>';

        const sessions = SessionManager.getAllSessions();

        sessions.forEach(session => {
            if (session.connected) {
                const label = `${session.username}@${session.host}:${session.port}`;

                const uploadOption = document.createElement('option');
                uploadOption.value = session.id;
                uploadOption.textContent = label;
                uploadSelect.appendChild(uploadOption);

                const downloadOption = document.createElement('option');
                downloadOption.value = session.id;
                downloadOption.textContent = label;
                downloadSelect.appendChild(downloadOption);
            }
        });
    },

    uploadFile(sessionId, file, remotePath) {
        const reader = new FileReader();

        reader.onload = (e) => {
            const arrayBuffer = e.target.result;
            const base64Data = this.arrayBufferToBase64(arrayBuffer);

            if (window.socket) {
                window.socket.emit('upload_file', {
                    session_id: sessionId,
                    filename: file.name,
                    file_data: base64Data,
                    remote_path: remotePath
                });

                this.showUploadProgress(0);
            }
        };

        reader.onerror = (e) => {
            window.showNotification('File read error', 'error');
        };

        reader.readAsArrayBuffer(file);
    },

    downloadFile(sessionId, remotePath) {
        if (window.socket) {
            window.socket.emit('download_file', {
                session_id: sessionId,
                remote_path: remotePath
            });

            this.showDownloadProgress(0);
        }
    },

    handleDownloadReady(data) {
        const byteCharacters = atob(data.file_data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray]);

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.hideDownloadProgress();
        window.showNotification(`Downloaded: ${data.filename}`, 'success');
    },

    showUploadProgress(percent) {
        const container = document.getElementById('uploadProgress');
        const fill = document.getElementById('uploadProgressFill');
        const text = document.getElementById('uploadProgressText');

        if (container) container.classList.remove('hidden');
        if (fill) fill.style.width = percent + '%';
        if (text) text.textContent = percent + '%';
    },

    hideUploadProgress() {
        const container = document.getElementById('uploadProgress');
        if (container) {
            container.classList.add('hidden');
        }
    },

    showDownloadProgress(percent) {
        const container = document.getElementById('downloadProgress');
        const fill = document.getElementById('downloadProgressFill');
        const text = document.getElementById('downloadProgressText');

        if (container) container.classList.remove('hidden');
        if (fill) fill.style.width = percent + '%';
        if (text) text.textContent = percent + '%';
    },

    hideDownloadProgress() {
        const container = document.getElementById('downloadProgress');
        if (container) {
            container.classList.add('hidden');
        }
    },

    updateProgress(data) {
        if (data.type === 'upload') {
            this.showUploadProgress(data.percent);
        } else if (data.type === 'download') {
            this.showDownloadProgress(data.percent);
        }
    },

    handleTransferComplete(data) {
        if (data.type === 'upload') {
            this.hideUploadProgress();

            if (!window._currentUploadBatchId) {
                window.showNotification(`Uploaded: ${data.filename}`, 'success');
            }

            document.getElementById('uploadForm').reset();
        } else if (data.type === 'download') {
            this.hideDownloadProgress();
        }
    },

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    /* ------------------------------------------------------------------------
     * The BROWSER <-> SERVER Upload/Download modal's own open/close/toggle.
     *
     * This modal moves bytes
     * between THIS BROWSER and one connected SSH session: an <input type=file>
     * up, a remote path down. It has one session picker per direction and no
     * concept of a second host, so it structurally cannot express "server A to
     * server B" -- which is what the owner means by File Transfer.
     *
     * It was therefore WRONGLY bound to the global #fileTransferOpenBtn menu
     * item. That binding is gone: the menu item now opens the
     * dual-pane server-to-server surface (sftp-file-manager.js), and this modal
     * is reached from the per-session file tooling as "Upload / Download",
     * which is what it actually does. Distinct feature, distinct label, one
     * host each.
     *
     * It stays a toggle like the other openers, and refreshes the session
     * selects on open so the list reflects sessions connected since page load.
     * --------------------------------------------------------------------- */
    isOpen() {
        return !!document.getElementById('fileTransferModal')
            ?.classList.contains('show');
    },

    openModal() {
        const modal = document.getElementById('fileTransferModal');
        if (!modal) {
            return;
        }
        this.updateSessionSelects();
        window.ModalManager?.open(modal);
    },

    closeModal() {
        const modal = document.getElementById('fileTransferModal');
        if (!modal) {
            return;
        }
        window.ModalManager?.close(modal);
    },

    toggleModal() {
        if (this.isOpen()) {
            this.closeModal();
            return;
        }
        this.openModal();
    },
};

document.addEventListener('DOMContentLoaded', () => {
    /*
     * #fileTransferOpenBtn is deliberately NOT bound here. It is the GLOBAL
     * File Transfer menu item and belongs to the server-to-server dual-pane
     * surface (sftp-file-manager.js). Binding this browser<->server modal to it
     * is the exact defect the owner.
     *
     * The opener for THIS modal is #fmUploadDownloadBtn, created inside the
     * per-session file tooling (the inline SFTP inspector) and labelled
     * files.uploadDownload. It is delegated from document because that panel is
     * rendered lazily, after this listener runs.
     */
    document.addEventListener('click', (event) => {
        if (event.target.closest?.('#fmUploadDownloadBtn')) {
            FileTransferManager.toggleModal();
        }
    });
    document.getElementById('closeFileTransferModal')
        ?.addEventListener('click', () => FileTransferManager.closeModal());
});
