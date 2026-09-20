/* Dedicated modal host for the reusable command sets.
 *
 * The Command Library moved out to #commandRail, a non-blocking rail that keeps
 * the terminal visible, so this host owns Command Sets only: there is no tablist
 * and no section switching left. requestClose still delegates to
 * CommandSetManager, which is what preserves its return-to-connection behavior
 * for the nested editor and form. */
window.CommandWorkspace = {
    init() {
        const modal = document.getElementById('commandSetsModal');
        document.getElementById('closeCommandSetsModal')?.addEventListener('click', () => {
            this.requestClose();
        });
        modal?.addEventListener('click', event => {
            if (event.target === modal) this.requestClose();
        });
    },

    open() {
        const modal = document.getElementById('commandSetsModal');
        if (!modal) return;
        if (window.ModalManager) window.ModalManager.open(modal);
        else modal.classList.add('show');
    },

    requestClose() {
        window.CommandSetManager?.close();
    },

    close() {
        const modal = document.getElementById('commandSetsModal');
        if (!modal) return;
        if (window.ModalManager) window.ModalManager.close(modal);
        else modal.classList.remove('show');
    },
};
