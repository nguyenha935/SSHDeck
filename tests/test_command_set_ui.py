"""Static integration checks for the command-set user journey."""
import re
from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def test_connection_form_uses_command_set_selector_and_preview():
    template = read('templates/index.html')

    for element_id in (
        'connectionCommandModeNone',
        'connectionCommandModeSet',
        'connectionCommandModeCommand',
        'connectionCommandModeFreeText',
        'connectionCommandSetPanel',
        'connectionSingleCommandPanel',
        'connectionFreeTextPanel',
        'connectionCommandSelect',
        'connectionCommandParameters',
        'startupCommandsInput',
        'commandSetSelect',
        'manageCommandSetsBtn',
        'editSelectedCommandSetBtn',
        'editSelectedCommandBtn',
        'connectionCommandPreview',
        'legacyCommandsNotice',
        'convertLegacyCommandsBtn',
    ):
        assert f'id="{element_id}"' in template


def test_commands_workspace_is_sets_only_and_library_lives_in_the_rail():
    template = read('templates/index.html')

    assert 'id="commandSetManagementModal"' not in template
    # The label span carries class="btn-label" -- the one-bar shell hides it
    # below 1024px so six glyph buttons fit a phone row -- and the tag wraps
    # across lines to stay inside 100 columns. What this asserts is unchanged:
    # the button's visible DESKTOP name comes from the commands.workspace key.
    #
    # H2 (mockup line 70) puts the icon BEFORE the label in DOM order:
    #   <button class="tw5-control" type="button" data-state="library">
    #     <i data-lucide="library" aria-hidden="true"></i><span>Lenh</span>
    # so an <svg class="icon"> now sits between the attributes and the label
    # span. The pattern allows that intervening icon rather than assuming the
    # label is the first child; the icon's presence is asserted separately just
    # below, so allowing it here does not let it go missing unnoticed.
    #
    #: the span now also carries `btn-label-desktop`, because V5 gives
    # this ONE canonical button two names -- "Lenh" (commands.workspace) in its
    # desktop header home at mockup line 70, and "Thu vien lenh"
    # (commands.library) while hosted in the touch global menu at line 132. Two
    # sibling label spans carry those, exactly one of them ever displayed. So the
    # class list is matched as a SET member rather than as the whole attribute
    # value; the key assertion is unchanged, and the menu-context sibling is
    # asserted just below so neither label can go missing unnoticed.
    assert re.search(
        r'id="commandLibraryBtn"[^>]*>.*?<span\s+'
        r'class="btn-label btn-label-desktop"\s+'
        r'data-i18n="commands\.workspace">',
        template,
        re.DOTALL,
    )
    # The menu-context label, same button, no clone: one node, one listener, two
    # translated spans (mockup line 132).
    assert re.search(
        r'id="commandLibraryBtn"[^>]*>.*?<span\s+'
        r'class="btn-label btn-label-menu"\s+'
        r'data-i18n="commands\.library">',
        template,
        re.DOTALL,
    )
    # Still exactly one Command control: the two spans are labels, not buttons.
    assert template.count('id="commandLibraryBtn"') == 1
    # H2's own claim, kept explicit: the icon really precedes that label.
    assert re.search(
        r'id="commandLibraryBtn"[^>]*>\s*<svg\s+class="icon"',
        template,
        re.DOTALL,
    )
    for element_id in (
        'commandSetsModal',
        'closeCommandSetsModal',
        'commandSetsPanel',
        'commandSetManagementList',
        'newCommandSetBtn',
        'commandSetForm',
        'commandSetNameInput',
        'commandSetDescriptionInput',
        'commandSetUseSudoInput',
        'commandSetSearchInput',
        'commandSetLibraryResults',
        'commandSetSteps',
        'addInlineCommandStepBtn',
        'saveCommandSetBtn',
    ):
        assert f'id="{element_id}"' in template

    # The Library moved out of the blocking modal into #commandRail, so the
    # two-section tablist and both of its tabs are gone entirely: a single
    # remaining tab would be decorative chrome over dead navigation code.
    for removed in (
        'id="commandLibraryTab"',
        'id="commandSetsTab"',
        'command-workspace-tabs',
        'commands-table-header',
        'commands-table-body',
    ):
        assert removed not in template
    assert 'role="tablist"' not in template
    assert template.count('role="tab"') == 0
    assert template.count('role="tabpanel"') == 0

    # Sets is the only modal content, and says so.
    assert re.search(
        r'id="commandSetsTitle"\s+data-i18n="commandSets\.manage"',
        template,
    )

    # #commandLibraryPanel exists exactly once, inside the rail -- never
    # duplicated back into the modal.
    assert template.count('id="commandLibraryPanel"') == 1
    assert template.index('id="commandRail"') < template.index(
        'id="commandLibraryPanel"'
    ) < template.index('id="commandSetsModal"')
    assert 'id="commandsList"' in template
    assert 'commands-card-list' in template
    assert 'data-os="linux"' in template
    assert 'data-os="windows"' in template


def test_commands_workspace_controller_owns_all_entry_points():
    workspace = read('static/js/command-workspace.js')
    library = read('static/js/command-library.js')
    sets = read('static/js/command-set-manager.js')
    app = read('static/js/app.js')
    template = read('templates/index.html')

    # Sets-only host: no section state, no tab switching, no Library branch.
    assert 'activeSection' not in workspace
    assert 'select(' not in workspace
    assert 'commandLibraryPanel' not in workspace
    assert 'commandLibraryTab' not in workspace
    assert 'commandSetsTab' not in workspace
    assert 'open() {' in workspace
    # requestClose still delegates, which is what preserves the nested
    # editor/form return-to-connection behavior.
    assert 'CommandSetManager?.close()' in workspace
    assert 'CommandWorkspace.open()' in sets
    assert "CommandWorkspace.open('library')" not in library
    assert "CommandWorkspace.open('sets')" not in sets

    # The Library's own entry points are the rail, not the modal.
    assert 'openEditor(commandId, returnToModalId = null)' in library
    assert 'toggleLibrary(' in library
    assert 'commandRailOpenBtn' in library
    assert 'commandRailCloseBtn' in library
    assert 'commandRailSetsBtn' in library
    assert 'CommandLibrary.toggleLibrary()' in app
    assert 'CommandWorkspace.init()' in app
    assert "filename='js/command-workspace.js'" in template


def test_command_set_scripts_load_in_dependency_order_before_app():
    template = read('templates/index.html')

    utils = template.index("filename='js/command-set-utils.js'")
    workspace = template.index("filename='js/command-workspace.js'")
    library = template.index("filename='js/command-library.js'")
    manager = template.index("filename='js/command-set-manager.js'")
    connection = template.index("filename='js/connection-command-manager.js'")
    app = template.index("filename='js/app.js'")
    assert utils < workspace < library < manager < connection < app


def test_connection_command_manager_uses_current_cache_version():
    template = read('templates/index.html')

    assert "filename='js/connection-command-manager.js') }}?v=2" in template


def test_connection_and_profile_payloads_send_only_selected_set_id():
    source = read('static/js/app.js')

    assert 'ConnectionCommandManager.getPayload()' in source
    # The emit stays in profile-manager.js; app.js never emits save_profile
    # itself. This is the substantive auto-launch decoupling, kept intact.
    assert "window.socket.emit('save_profile'" not in source

    # RETIRED NEGATIVE (W14 item 8, owner-approved plan): the old assertion was
    #   assert 'saveProfileCheck' not in source
    # It existed to keep the connection form free of an unsanctioned profile-save
    # path that could bypass the command-set-selection contract. Item 8 ADDS a
    # deliberate save-as-profile checkbox, so blanket absence now contradicts the
    # approved feature. The SAFETY PROPERTY it guarded is enforced positively
    # below: the save payload is assembled through the SAME
    # ConnectionCommandManager.getPayload() the connection frame uses, so it
    # carries only the selected set id (never a secret, never the whole set).
    builder_start = source.index('function buildConnectionProfilePayload')
    builder = source[builder_start:source.index('return payload;\n    }', builder_start)]
    assert 'ConnectionCommandManager.getPayload()' in builder
    assert 'password' not in builder


def test_profile_selection_supports_set_references_and_legacy_conversion():
    source = read('static/js/profile-manager.js')

    assert 'ConnectionCommandManager?.applyProfile(profile)' in source
    assert 'profile.startup_commands' in source
    assert 'CommandSetManager.openLegacyConversion(profile)' in source
    assert 'getLegacyStartupCommands()' in source


def test_builder_has_search_reorder_parameter_override_and_explicit_promotion():
    source = read('static/js/command-set-manager.js')

    assert 'CommandSetUtils.filterCommands' in source
    assert 'CommandSetUtils.moveStep' in source
    assert "parameters_override" in source
    assert "use-default-parameters" in source
    assert "data.stepAction === 'promote'" in source or "dataset.stepAction === 'promote'" in source
    assert 'showAddCommandForm' in source
    assert "window.socket.emit(event, payload, acknowledgement" in source


def test_command_library_can_return_a_new_command_to_inline_promotion():
    source = read('static/js/command-library.js')

    assert 'pendingSaveCallback' in source
    assert re.search(r'showAddCommandForm\([^)]*options', source)
    assert "window.socket.emit('add_command', data," in source


def test_editing_a_selected_command_returns_to_the_connection_dialog():
    connection_source = read('static/js/connection-command-manager.js')
    library_source = read('static/js/command-library.js')

    assert re.search(
        r"openEditor\(\s*this\.selectedCommandId,\s*'connectionModal'\s*\)",
        connection_source,
    )
    assert 'returnToModalId' in library_source
    assert 'window.ModalManager.activeModal = returnModal' in library_source


def test_command_library_os_filter_does_not_capture_command_set_filters():
    source = read('static/js/command-library.js')

    assert "document.querySelectorAll('#commandLibraryPanel .os-filter-btn')" in source


def test_command_library_search_uses_the_public_i18n_api():
    source = read('static/js/command-library.js')

    assert 'window.i18n.translations' not in source
    assert 'window.i18n.t(categoryKey)' in source


def test_closing_command_set_editor_resets_the_next_management_visit():
    source = read('static/js/command-set-manager.js')

    close_method = re.search(
        r'\n    close\(\) \{(?P<body>.*?)\n    \},',
        source,
        re.DOTALL,
    )
    assert close_method
    assert 'this.showManagementList()' in close_method.group('body')
    assert 'this.returnToConnection = false' in close_method.group('body')


def test_command_set_editor_controls_sudo_defaults_and_payload():
    source = read('static/js/command-set-manager.js')

    assert 'sudoInput.checked = source ? source.use_sudo === true : false' in source
    legacy_conversion = re.search(
        r'openLegacyConversion\(profile\) \{(?P<body>.*?)\n    \},',
        source,
        re.DOTALL,
    )
    assert legacy_conversion
    assert 'sudoInput.checked = false' in legacy_conversion.group('body')
    assert re.search(
        r'use_sudo:\s*document\.getElementById\('
        r"'commandSetUseSudoInput'\)\?\.checked\s*===\s*true",
        source,
    )
    assert 'command-set-sudo-badge' in source


def test_profiles_are_prominent_while_keys_and_jump_hosts_stay_in_account_menu():
    """v5 H3: Profiles is the FIRST entry of the account menu, not a header button.

    Mockup line 76 is unambiguous about where it lives::

        <button type="button"><i data-lucide="contact-round" aria-hidden="true">
        </i><span>Profiles</span><small>Host da luu</small></button>

    and that button is the first child of ``.tw5-global-menu`` (line 74), ahead
    of Theme (77), Ngon ngu (78), SSH keys & Jump hosts (79) and Cai dat (80).
    The v5 header itself is exactly four elements -- brand, Ket noi moi, Tep,
    Lenh, account (lines 66-72) -- so there is no header slot for Profiles at
    all.

    "Prominent" is therefore re-expressed against the surface that now owns it:
    Profiles must lead the account menu, ahead of the keys/jump-host entries,
    rather than being buried under them. That is the same claim the old
    ``index('commandLibraryBtn') < index('manageProfilesBtn')`` ordering made
    about the header group, applied to the menu the mockup specifies.
    """
    template = read('templates/index.html')

    header_group = re.search(
        r'<div class="header-group"[^>]*>(?P<body>.*?)</div>',
        template,
        re.DOTALL,
    )
    account_menu = re.search(
        r'<div class="account-dropdown-header"[^>]*>(?P<body>.*?)'
        r'<button id="logoutBtn"',
        template,
        re.DOTALL,
    )
    assert header_group
    assert account_menu
    header_tools = header_group.group('body')
    menu_body = account_menu.group('body')
    # H1: the header keeps its four v5 members and gains no fifth. Matched on
    # the id ATTRIBUTE, not the bare string: the header carries an explanatory
    # comment that names the relocated buttons, and a substring test would read
    # that prose as markup.
    assert 'commandLibraryBtn' in header_tools
    assert 'id="manageProfilesBtn"' not in header_tools
    # H3: Profiles leads the account menu, ahead of keys and jump hosts.
    assert 'id="manageProfilesBtn"' in menu_body
    for element_id in ('manageKeysBtn', 'manageJumpHostsBtn'):
        assert f'id="{element_id}"' in menu_body
        assert menu_body.index('id="manageProfilesBtn"') < menu_body.index(
            f'id="{element_id}"'
        )


def test_profile_management_is_independent_from_connect_submit():
    template = read('templates/index.html')
    profile_source = read('static/js/profile-manager.js')

    for element_id in (
        'profileManagementModal',
        'profileManagementList',
        'newProfileBtn',
        'profileEditorForm',
        'profileEditorName',
        'profileEditorHost',
        'profileEditorPort',
        'profileEditorUsername',
        'profileEditorAuthType',
        'profileEditorPostConnectMode',
        'profileEditorCommandSelect',
        'profileEditorCommandSetSelect',
        'profileEditorStartupCommands',
        'profileEditorCommandPreview',
    ):
        assert f'id="{element_id}"' in template
    profile_modal = re.search(
        r'id="profileManagementModal"(?P<body>.*?)</div>\s*</div>\s*</div>',
        template,
        re.DOTALL,
    )
    assert profile_modal
    assert 'type="password"' not in profile_modal.group('body')
    assert "window.socket.emit('save_profile'" in profile_source
    assert "window.socket.emit('ssh_connect'" not in profile_source
    assert 'renderEditorCommandPreview()' in profile_source


def test_connection_mode_help_uses_accessible_tooltips():
    template = read('templates/index.html')

    tooltip_ids = set(re.findall(r'id="([^"]+Tooltip)"[^>]*role="tooltip"', template))
    references = re.findall(r'aria-describedby="([^"]+Tooltip)"', template)
    assert references
    assert set(references).issubset(tooltip_ids)
    assert 'class="info-tooltip-trigger"' in template


def test_readme_documents_command_set_lifecycle_and_upgrade_behavior():
    readme = read('README.md')

    for phrase in (
        'Run after',
        'exact',
        'Free text',
        'Command Sets',
        'Save as library command',
        'maximum 4096 characters',
        'persistent tmux session does not run them again',
        'former free-text startup commands keep',
        'working after an update',
        'cannot be deleted while a profile references it',
        'No additional environment variable, Compose setting',
        'Run commands with sudo',
        'opt-in for new command sets',
        'Existing command sets',
        'legacy conversion keep their saved',
        'does not store or answer a sudo password',
        'created, inspected, updated, or deleted without opening an SSH',
        'joined with `&&`',
        'inside a free-text step remain unchanged',
        'legacy startup commands',
    ):
        assert phrase in readme
