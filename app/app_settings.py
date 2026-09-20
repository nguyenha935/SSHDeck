"""Application-wide runtime settings an admin changes without a redeploy.

Owner ruling: "Giới hạn mở phiên kết nối... phải được admin cài
đặt chứ?" -- the limits used to live only in environment variables, and the
admin page could toggle exactly one thing (self-registration). Every setting
here is a named key with a type and bounds; the value an admin saves is
written to `app_settings.json` in DATA_DIR, applied to the `config` module at
once (every consumer reads `config.X` at call time), and applied again at
boot. The environment value the process started with stays the default, so
"Reset to defaults" always means "what the deployment says".

`is_registration_enabled` / `set_registration_enabled` keep their old shape
for the callers that predate the table.
"""
import json
import os
import re

import config
from .audit_logger import log_info, log_warning

RATE_RE = re.compile(r'^(\d{1,6}) per (second|minute|hour)$')

# key -> spec. `config` is the attribute the value is applied to. Bounds on the
# integers are the runaway guard the owner asked to keep (a loop, not a
# person): a person never needs a thousand sessions, and a session timeout
# under two minutes would reap a pane the user just looked away from.
SETTINGS = {
    'registration_enabled': {'type': 'bool', 'config': 'REGISTRATION_ENABLED'},
    'ratelimit_enabled': {'type': 'bool', 'config': 'RATELIMIT_ENABLED'},
    'max_sessions': {'type': 'int', 'config': 'MAX_SESSIONS', 'min': 1, 'max': 1000},
    'max_sessions_per_user': {'type': 'int', 'config': 'MAX_SESSIONS_PER_USER',
                              'min': 1, 'max': 1000},
    'max_views_per_session': {'type': 'int', 'config': 'MAX_VIEWS_PER_SESSION',
                              'min': 1, 'max': 64},
    'session_timeout': {'type': 'int', 'config': 'SESSION_TIMEOUT',
                        'min': 120, 'max': 7 * 24 * 3600, 'unit': 'seconds'},
    'ssh_connect_ratelimit': {'type': 'rate', 'config': 'RATELIMIT_SSH_CONNECT'},
    'login_ratelimit': {'type': 'rate', 'config': 'RATELIMIT_LOGIN_LIMIT'},
}

# What the process started with: captured once, before any override is
# applied, so a reset can always return to the deployment's own values.
_env_defaults = {key: getattr(config, spec['config']) for key, spec in SETTINGS.items()}


def _file():
    return config.DATA_DIR / 'app_settings.json'


def _load():
    try:
        with open(_file(), 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save(data):
    tmp = str(_file()) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    os.replace(tmp, _file())


def coerce(key, value):
    """Validate one value for `key`. Returns ``(ok, value_or_reason)``."""
    spec = SETTINGS.get(key)
    if spec is None:
        return False, 'unknown setting'
    kind = spec['type']
    if kind == 'bool':
        if isinstance(value, bool):
            return True, value
        if value in (0, 1, '0', '1', 'true', 'false', 'True', 'False'):
            return True, str(value).lower() in ('1', 'true')
        return False, 'expected true or false'
    if kind == 'int':
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            return False, 'expected a whole number'
        try:
            number = int(value)
        except ValueError:
            return False, 'expected a whole number'
        if not spec['min'] <= number <= spec['max']:
            return False, f"must be between {spec['min']} and {spec['max']}"
        return True, number
    if kind == 'rate':
        if not isinstance(value, str) or not RATE_RE.match(value.strip()):
            return False, 'expected "<count> per second|minute|hour"'
        count = int(value.strip().split()[0])
        if count < 1:
            return False, 'the count must be at least 1'
        return True, value.strip()
    return False, 'unknown setting type'


def env_default(key):
    return _env_defaults[key]


def current(key):
    """The effective value: the saved override when it is valid, else the
    environment default."""
    saved = _load()
    if key in saved:
        ok, value = coerce(key, saved[key])
        if ok:
            return value
    return _env_defaults[key]


def _apply(key, value):
    setattr(config, SETTINGS[key]['config'], value)


def describe():
    """Every setting as the admin page shows it."""
    saved = _load()
    rows = []
    for key, spec in SETTINGS.items():
        row = {'key': key, 'type': spec['type'], 'value': current(key),
               'default': _env_defaults[key], 'overridden': key in saved}
        for bound in ('min', 'max', 'unit'):
            if bound in spec:
                row[bound] = spec[bound]
        rows.append(row)
    return rows


def update(changes, actor=None):
    """Validate every change, then save and apply them all, or none.

    Returns ``(ok, errors)`` with one reason per refused key. Each applied
    change is logged with who made it and what it replaced.
    """
    errors = {}
    accepted = {}
    for key, value in (changes or {}).items():
        ok, result = coerce(key, value)
        if ok:
            accepted[key] = result
        else:
            errors[key] = result
    if errors:
        return False, errors
    if not accepted:
        return True, {}
    data = _load()
    for key, value in accepted.items():
        before = current(key)
        data[key] = value
        _apply(key, value)
        log_info("Admin changed a setting", admin=actor, setting=key,
                 previous=before, value=value)
    _save(data)
    return True, {}


def reset(keys=None, actor=None):
    """Drop the override of `keys` (every key when None): the environment
    default is applied again and the file no longer names them."""
    data = _load()
    targets = list(SETTINGS) if keys is None else [k for k in keys if k in SETTINGS]
    for key in targets:
        if key in data:
            del data[key]
            log_info("Admin reset a setting to its default", admin=actor,
                     setting=key, value=_env_defaults[key])
        _apply(key, _env_defaults[key])
    _save(data)


def apply_saved():
    """Apply every valid saved override to `config` (called at boot)."""
    saved = _load()
    applied = []
    for key, raw in saved.items():
        if key not in SETTINGS:
            continue
        ok, value = coerce(key, raw)
        if not ok:
            log_warning("Ignoring an invalid saved setting", setting=key,
                        reason=value)
            continue
        _apply(key, value)
        applied.append(key)
    if applied:
        log_info("Applied saved settings at startup", settings=applied)
    return applied


def is_registration_enabled():
    return bool(current('registration_enabled'))


def set_registration_enabled(value):
    update({'registration_enabled': bool(value)})
    return is_registration_enabled()
