import json
from .storage_utils import storage_lock, atomic_write_json


def effective_notepad_mode(requested, stored, target_id):
    """Which scope a notepad read/write ACTUALLY resolves to.

    S17 D2. Two callers used to decide this inline and they did not agree, which
    is how a ``per_server`` request with no ``target_id`` came back carrying the
    GLOBAL note labelled ``per_server`` -- the client then stored that text under
    a per-server heading it never belonged to. The rule is stated once here and
    both the read and the write path call it, so the label a caller reports can
    never drift from the bucket it actually touched.

    * ``requested`` None/empty means "no preference": the persisted mode wins,
      which is what makes the Owner's chosen scope survive a reload.
    * ``per_server`` without a target id cannot address a per-server bucket, so
      it resolves to ``global`` -- the bucket that is genuinely read or written.
    * anything unrecognised resolves to ``global`` rather than being trusted.
    """
    mode = requested or stored or 'global'
    if mode == 'per_server':
        return 'per_server' if target_id else 'global'
    return 'global'


def stored_notepad_mode(user_id):
    """The scope the user last chose, for a client that has not asked for one."""
    return get_user_settings(user_id).get('notepad_mode', 'global')


def get_notepad(user_id, mode='global', target_id=None):
    """Return the notepad text AND its revision.

    Item 2: revision 0 means "fresh" (nothing ever
    saved). Existing settings.json files written before revisions existed
    carry no revision key, so they read back as revision 0 -- the first
    revisioned save then bumps to 1 without any migration step.

    Ruling A: support 'global' (user-wide) and 'per_server'
    (user + server/connection target) storage scopes.

    S17 D2: the scope is resolved by effective_notepad_mode, so passing
    ``mode=None`` genuinely honours the persisted choice. It could not before --
    the default was the literal string 'global', which is truthy, so the stored
    mode was unreachable through this function and every reload landed on Global.
    """
    settings = get_user_settings(user_id)
    stored_mode = settings.get('notepad_mode', 'global')
    effective_mode = effective_notepad_mode(mode, stored_mode, target_id)

    if effective_mode == 'per_server':
        server_notes = settings.get('server_notepads', {})
        note_data = server_notes.get(str(target_id), {})
        text = note_data.get('notepad', '')
        revision = note_data.get('revision', 0)
    else:
        text = settings.get('notepad', '')
        revision = settings.get('notepad_revision', 0)

    if not isinstance(revision, int) or revision < 0:
        revision = 0
    return text, revision


def save_notepad_revision(user_id, text, base_revision=None, mode='global', target_id=None):
    """Persist notepad text with the revision/conflict contract.

    * ``base_revision`` matching the CURRENT revision (or None, pre-upgrade
      last-write-wins) applies the write and bumps the revision.
    * a stale ``base_revision`` refuses the write and returns the server's
      truth, so a device holding deleted text can never resurrect it.

    Returns ``(ok, result)``: ``ok`` is False on storage failure; ``result``
    is either ``{'applied': True, 'notepad', 'revision'}`` or
    ``{'applied': False, 'notepad', 'revision'}`` (the server truth).
    """
    from .models import User
    user = User.query.get(user_id)
    if not user:
        return False, None

    settings_file = user.get_data_dir() / 'settings.json'
    settings_file.parent.mkdir(parents=True, exist_ok=True)

    try:
        with storage_lock(f'settings:{user_id}'):
            current = get_user_settings(user_id)
            # One shared resolver, so a write can never report a scope
            # different from the bucket it touched. See effective_notepad_mode.
            effective_mode = effective_notepad_mode(
                mode, current.get('notepad_mode', 'global'), target_id)

            if effective_mode == 'per_server':
                server_notes = current.setdefault('server_notepads', {})
                note_entry = server_notes.setdefault(str(target_id), {'notepad': '', 'revision': 0})
                current_text = note_entry.get('notepad', '')
                current_revision = note_entry.get('revision', 0)
            else:
                current_text = current.get('notepad', '')
                current_revision = current.get('notepad_revision', 0)

            if not isinstance(current_revision, int) or current_revision < 0:
                current_revision = 0

            if base_revision is not None and base_revision != current_revision:
                return True, {
                    'applied': False,
                    'notepad': current_text,
                    'revision': current_revision,
                    'mode': effective_mode,
                    'target_id': target_id,
                }

            merged = current
            new_revision = current_revision + 1
            if effective_mode == 'per_server':
                merged.setdefault('server_notepads', {})[str(target_id)] = {
                    'notepad': text,
                    'revision': new_revision,
                }
            else:
                merged['notepad'] = text
                merged['notepad_revision'] = new_revision

            # Persist the mode the user CHOSE, not the one this write
            # resolved to. A per_server choice whose target id has not arrived yet
            # still writes to the global bucket (above), but recording 'global'
            # here would silently discard the preference and put the panel back on
            # Global at the next reload -- the defect being fixed.
            if mode in ('global', 'per_server'):
                merged['notepad_mode'] = mode

            atomic_write_json(settings_file, merged)
            return True, {
                'applied': True,
                'notepad': text,
                'revision': new_revision,
                'mode': effective_mode,
                'target_id': target_id,
            }
    except Exception:
        return False, None


# Every theme the app ships, in the order the picker shows them. One tuple,
# because three places need it: the socket handler that saves a choice, the
# route that reads the `theme` cookie before there is a user, and any test that
# wants to sweep them.
VALID_THEMES = (
    'glass', 'retro', 'solar', 'paper', 'noir',
    'arctic-ice', 'rose-gold', 'cyberpunk-neon', 'emerald-matrix', 'obsidian',
)

DEFAULT_SETTINGS = {
    'theme': 'glass',
    'notepad': '',
    # Session ids in the order the user arranged their tabs (item C,
    #); shared by every device of the account.
    'tab_order': []
}


def get_user_settings(user_id):
    """Load user settings from disk with defaults."""
    from .models import User
    user = User.query.get(user_id)
    if not user:
        return DEFAULT_SETTINGS.copy()

    settings_file = user.get_data_dir() / 'settings.json'
    if not settings_file.exists():
        return DEFAULT_SETTINGS.copy()

    try:
        with open(settings_file, 'r') as f:
            data = json.load(f)
            settings = DEFAULT_SETTINGS.copy()
            settings.update(data)
            return settings
    except Exception:
        return DEFAULT_SETTINGS.copy()

def save_user_settings(user_id, settings):
    """Persist user settings to disk."""
    from .models import User
    user = User.query.get(user_id)
    if not user:
        return False

    settings_file = user.get_data_dir() / 'settings.json'
    settings_file.parent.mkdir(parents=True, exist_ok=True)

    try:
        with storage_lock(f'settings:{user_id}'):
            merged = get_user_settings(user_id)
            merged.update(settings or {})
            atomic_write_json(settings_file, merged)
        return True
    except Exception:
        return False
