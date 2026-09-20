"""The tmux options every view depends on: `ensure_tmux_window_options`.

Four session-scoped options, set on every attach:

  * `window-size smallest` -- THE multi-device policy (owner ruling
). The window follows the smallest attached client, so every
    device displays the whole pane and a device that stops watching gives its
    size back.
  * an `after-new-window` hook that repeats it, because `window-size` is a
    WINDOW option: measured on tmux 3.7c, a window created
    afterwards reads back `smallest` with the hook and nothing without it.
  * `mouse on`, which is what puts wheel and touch gestures into tmux copy
    mode.
  * `mode-keys emacs`, which the client's gesture code assumes, so a
    mouse-drag copy emits OSC 52 whatever the server's global mode-keys is.

None of them may be global (`-g`): the tmux server is shared with whatever
else the user runs on that host. All four are idempotent, so the helper runs on
every attach with no "have I done it yet" flag to drift out of step.

This replaces tests/test_tmux_socket_events.py's `_initialize_tmux_mouse_mode`
block, which covered mouse and mode-keys only at the socket layer.
"""
import pytest

from app import ssh_manager


@pytest.fixture(autouse=True)
def _clean_sessions():
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()
    yield
    with ssh_manager.sessions_lock:
        ssh_manager.sessions.clear()


def _capture_commands(monkeypatch, failures=()):
    """Record every tmux control command the helper issues, in order.

    ``failures`` names subcommand/argument fragments that must fail, so one
    option's failure can be proven not to skip the others.
    """
    calls = []

    def fake_run(session_id, subcommand, extra_args=None, exact_target=False,
                 **_kwargs):
        args = list(extra_args or ())
        calls.append((session_id, subcommand, args, exact_target))
        joined = ' '.join([subcommand] + args)
        for fragment in failures:
            if fragment in joined:
                return False, f'tmux command failed: {fragment}'
        return True, None

    monkeypatch.setattr(ssh_manager, '_run_tmux_control_command', fake_run)
    return calls


def _install_tmux_session(monkeypatch, use_tmux=True):
    monkeypatch.setattr(
        ssh_manager, 'get_session',
        lambda sid: {'use_tmux': use_tmux, 'tmux_session_name': 'tm'})


def test_every_option_is_set_session_scoped_and_exact_target(monkeypatch):
    _install_tmux_session(monkeypatch)
    calls = _capture_commands(monkeypatch)

    ok, error = ssh_manager.ensure_tmux_window_options('sess-options')

    assert (ok, error) == (True, None)
    # Mouse and mode-keys arrive through set_tmux_mouse_mode /
    # set_tmux_mode_keys, which are the single definition of how each is set
    # (and which validate their argument); the window-size pair is issued here
    # with tmux's exact-match target.
    assert calls == [
        ('sess-options', 'set-option', ['-w', 'window-size', 'smallest'], True),
        ('sess-options', 'set-hook',
         ['after-new-window', 'set-option -w window-size smallest'], True),
        ('sess-options', 'set-option', ['mouse', 'on'], False),
        ('sess-options', 'set-option', ['-w', 'mode-keys', 'emacs'], False),
    ]
    # Never global: the tmux server belongs to the user, not to SSHDeck.
    for _sid, _subcommand, args, _exact in calls:
        assert '-g' not in args
        assert '-s' not in args


def test_window_size_is_smallest_and_carries_to_windows_created_later(
        monkeypatch):
    """The policy AND its repeat, asserted as one property.

    `window-size` is a window option, so setting it on the current window says
    nothing about the next one. Without the hook a new window silently falls
    back to the server default (`latest`), which is the policy inverted: the
    pane would follow whichever client moved last instead of staying readable
    on the smallest screen.
    """
    _install_tmux_session(monkeypatch)
    calls = _capture_commands(monkeypatch)

    ssh_manager.ensure_tmux_window_options('sess-smallest')

    window_size = [args for _sid, sub, args, _exact in calls
                   if sub == 'set-option' and 'window-size' in args]
    assert window_size == [['-w', 'window-size', 'smallest']]
    hooks = [args for _sid, sub, args, _exact in calls if sub == 'set-hook']
    assert hooks == [['after-new-window',
                      'set-option -w window-size smallest']]
    assert 'latest' not in str(calls) and 'largest' not in str(calls)


def test_a_plain_shell_is_left_completely_alone(monkeypatch):
    _install_tmux_session(monkeypatch, use_tmux=False)
    calls = _capture_commands(monkeypatch)
    warnings = []
    monkeypatch.setattr(ssh_manager, 'log_warning',
                        lambda message, **kwargs: warnings.append(message))

    ok, error = ssh_manager.ensure_tmux_window_options('sess-plain')

    # No tmux to configure, so no command and no warning: a plain shell attach
    # is not a failure.
    assert (ok, error) == (True, None)
    assert calls == []
    assert warnings == []


def test_a_vanished_session_issues_no_command(monkeypatch):
    monkeypatch.setattr(ssh_manager, 'get_session', lambda sid: None)
    calls = _capture_commands(monkeypatch)

    ok, error = ssh_manager.ensure_tmux_window_options('sess-gone')

    assert (ok, error) == (True, None)
    assert calls == []


def test_one_option_failing_never_skips_the_others(monkeypatch):
    """The four options fail independently.

    Each decides a different part of the interaction model, so a helper that
    returned at the first failure would silently drop the rest -- a session
    with `smallest` but no `mouse on`, for instance, cannot scroll at all.
    """
    _install_tmux_session(monkeypatch)
    calls = _capture_commands(monkeypatch, failures=('window-size',))
    monkeypatch.setattr(ssh_manager, 'log_warning', lambda *a, **k: None)

    ok, error = ssh_manager.ensure_tmux_window_options('sess-partial')

    assert ok is False
    assert error
    flattened = [' '.join([sub] + args) for _sid, sub, args, _exact in calls]
    assert any('mouse on' in c for c in flattened), flattened
    assert any('mode-keys emacs' in c for c in flattened), flattened
    assert len(calls) == 4


def test_a_failure_is_reported_at_warning_with_the_session_and_the_reason(
        monkeypatch):
    """S14 R0: a tmux-init failure must be visible in production logs.

    In production `config.DEBUG` is false, so `log_debug` is discarded before
    it reaches a handler and a silent failure is byte-identical to a success.
    These options decide whether tmux owns the pointer and which size the
    window follows, so a failure that cannot be observed cannot be diagnosed.
    """
    _install_tmux_session(monkeypatch)
    _capture_commands(monkeypatch, failures=('mouse', 'mode-keys'))
    warnings = []
    debugs = []
    monkeypatch.setattr(ssh_manager, 'log_warning',
                        lambda message, **kwargs: warnings.append(
                            (message, kwargs)))
    monkeypatch.setattr(ssh_manager, 'log_debug',
                        lambda message, **kwargs: debugs.append(
                            (message, kwargs)))

    ok, error = ssh_manager.ensure_tmux_window_options('sess-loud')

    assert ok is False
    assert len(warnings) == 1
    message, kwargs = warnings[0]
    assert kwargs.get('session_id') == 'sess-loud'
    # The real tmux reason, not just "something failed".
    assert kwargs.get('error') == error and error
    assert message not in [m for m, _k in debugs]


def test_running_it_again_repeats_the_same_commands(monkeypatch):
    """Idempotent by construction, which is why every attach may run it.

    Setting an option that is already set costs one short command and changes
    nothing. A "have I done it yet" flag would be a second source of truth
    about the real tmux state, and it would be wrong the moment the user's own
    tmux config or another client changed an option.
    """
    _install_tmux_session(monkeypatch)
    calls = _capture_commands(monkeypatch)

    ssh_manager.ensure_tmux_window_options('sess-twice')
    first = list(calls)
    calls.clear()
    ssh_manager.ensure_tmux_window_options('sess-twice')

    assert calls == first
