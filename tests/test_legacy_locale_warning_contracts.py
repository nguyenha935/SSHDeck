"""W13-A4 source contracts: the legacy tmux locale warning is tri-state,
snapshot-driven, single-owner, and invisible on healthy sessions.

The UI indication has one failure mode that hurts and three that add noise:

  * it disappears when it should show (a pane created before the UTF-8 locale
    fix silently eats Vietnamese/Telex keystrokes, and the user blames the
    product);
  * it shows when it should not (a measured-fine or unmeasured session gains
    a warning badge, which is how users learn to ignore warnings);
  * two surfaces own the state and drift (the chip says one thing, the
    lifecycle sheet another).

Each check below pins one of those: the snapshot is absorbed on every ingestion
path, the warning class is written by exactly one helper that compares strictly
against ``=== true``, the badge exists in every chip but paints only through
that class, and the lifecycle annotation reads the same session field. The
browser suite (tests/browser/legacy_locale_warning.mjs) proves the painted
result; these contracts keep the source from drifting under it.
"""

import re
from pathlib import Path

from tests.locale_sources import all_locale_text, locale_source


def _source(path):
    return Path(path).read_text(encoding='utf-8')


def test_create_session_absorbs_the_legacy_tmux_locale_measurement():
    source = _source('static/js/session-manager.js')
    create = source[source.index('    createSession(sessionData, pending) {'):
                    source.index('    createSessionTab(sessionId, host, username)')]
    # The tri-state is stored verbatim with ?? null: absent and null collapse
    # identically, true and false survive unchanged. A truthiness fallback
    # (|| null) would coerce false to null and hide measured-fine panes from
    # any future strict comparison; the contract is the nullish operator.
    assert 'legacyTmuxLocale: sessionData.legacy_tmux_locale ?? null' in create


def test_restore_session_carries_legacy_tmux_locale_into_session_data():
    source = _source('static/js/session-manager.js')
    # The slice ends where placement begins; since that is the
    # remembered-pane read (the old "let targetPane" fallback is gone).
    restore = source[source.index('    restoreSession(data) {'):
                     source.index('        const persistedPane = data.pane_index;')]
    assert 'legacy_tmux_locale: data.legacy_tmux_locale ?? null' in restore


def test_reconnected_snapshot_absorbs_the_remeasured_locale():
    source = _source('static/js/session-manager.js')
    on_reconnected = source[source.index('    onReconnected(data) {'):
                            source.index('    onReconnectFailed(data)')]
    # The swap's replacement transport re-measures the pane; the snapshot is
    # authoritative for the new generation. undefined means "field not sent"
    # and must leave the prior measurement untouched.
    assert 'data.legacy_tmux_locale !== undefined' in on_reconnected
    assert 'session.legacyTmuxLocale = data.legacy_tmux_locale ?? null' in on_reconnected
    assert 'this.updateLegacyLocaleWarning(sessionId)' in on_reconnected


def test_update_legacy_locale_warning_is_the_sole_class_writer_and_is_strict():
    source = _source('static/js/session-manager.js')
    # Exactly ONE writer of the .legacy-locale class, and it compares strictly
    # against true so false (measured fine) and null (unmeasured) can never
    # warn. A loose truthiness check would warn on both.
    helpers = re.findall(r"classList\.toggle\('legacy-locale'", source)
    assert len(helpers) == 1
    helper = source[source.index('    updateLegacyLocaleWarning(sessionId) {'):]
    helper = helper[:helper.index('\n    },') + 7]
    assert 'session.legacyTmuxLocale === true' in helper
    assert "classList.toggle('legacy-locale'" in helper
    # No other code path writes this class -- add/remove would be a second
    # owner.
    assert "classList.add('legacy-locale'" not in source
    assert "classList.remove('legacy-locale'" not in source


def test_chip_creates_exactly_one_badge_and_paints_it_via_the_class():
    source = _source('static/js/session-manager.js')
    create_tab = source[source.index('    createSessionTab(sessionId, host, username) {'):]
    create_tab = create_tab[:create_tab.index('\n    },') + 7]
    # One badge node per chip, created unconditionally so the shape is
    # state-driven; the warning class alone decides visibility.
    assert create_tab.count("legacyBadge.className = 'chip-locale-warning'") == 1
    assert 'legacyBadge.textContent' in create_tab
    # Accessibility: the glyph is decorative; the label carries the meaning.
    assert "legacyBadge.setAttribute('role', 'img')" in create_tab
    assert "legacyBadge.setAttribute('aria-label', legacyBadge.title)" in create_tab
    assert "dataset.i18nAriaLabel = 'session.legacyTmuxLocale'" in create_tab
    # The updater runs AFTER the tab is appended: it resolves the chip through
    # document.getElementById, which cannot see a detached node.
    # Since (item C) the chip is inserted at its remembered place
    # rather than appended; the contract is unchanged: in the DOM first.
    append_at = create_tab.index('this.insertTabInOrder(tab, sessionId)')
    update_at = create_tab.index('this.updateLegacyLocaleWarning(sessionId)')
    assert update_at > append_at


def test_lifecycle_detail_annotates_only_the_explicit_true_measurement():
    source = _source('static/js/session-manager.js')
    render = source[source.index('    renderLifecycleTarget() {'):]
    render = render[:render.index('\n    },') + 7]
    assert 'session.legacyTmuxLocale === true' in render
    assert "i18n.t('session.legacyTmuxLocaleShort')" in render
    assert "'tmux locale pre-UTF-8 fix'" in render


def test_deck_css_paints_the_badge_only_through_the_warning_state():
    css = _source('static/css/deck.css')
    # Hidden by default, painted only under .legacy-locale: a healthy chip is
    # byte-for-byte the mockup shape.
    hidden = re.search(
        r'#sessionTabs \.session-tab \.chip-locale-warning \{[^}]*display: none;',
        css, re.DOTALL)
    assert hidden is not None
    shown = re.search(
        r'#sessionTabs \.session-tab\.legacy-locale \.chip-locale-warning \{[^}]*display: flex;',
        css, re.DOTALL)
    assert shown is not None
    # Themed through the semantic warning token pair, never a literal colour:
    # the ten theme blocks derive --tw-warning per theme.
    badge = css[hidden.start():shown.end()]
    assert 'var(--tw-warning)' in badge
    assert 'color-mix(in srgb, var(--tw-warning) 14%, transparent)' in badge
    assert not re.search(r'#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(', badge)


def test_i18n_carries_the_warning_keys_in_every_locale():
    text = all_locale_text()
    # One occurrence per locale, six locales; test_i18n_parity.py pins that
    # the key sets are identical, so presence here is the content contract.
    assert text.count("'session.legacyTmuxLocale':") == 6
    assert text.count("'session.legacyTmuxLocaleShort':") == 6
    # The Vietnamese text must name both the input method users know (Telex)
    # and the remedy (a new session), because that is the whole point of the
    # warning in the owner's language.
    vietnamese = locale_source('vi')
    assert 'Telex' in vietnamese
    assert 'session.legacyTmuxLocale' in vietnamese


def test_backend_snapshot_and_connect_payloads_carry_the_measurement():
    # The client contract above is only honest if the server actually sends
    # the key on every ingestion path. _build_session_snapshot feeds
    # restore / get_sessions / reconnect; ssh_connected feeds fresh connects.
    events = _source('app/socket_events.py')
    snapshot = events[events.index('def _build_session_snapshot('):]
    snapshot = snapshot[:snapshot.index('\ndef ', 1)]
    assert "'legacy_tmux_locale': session.get('legacy_tmux_locale')" in snapshot
    connected = events[events.index("emit('ssh_connected'"):]
    connected = connected[:connected.index('})')]
    assert "'legacy_tmux_locale':" in connected
