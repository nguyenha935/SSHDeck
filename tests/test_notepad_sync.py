"""Item 2: notepad revision/conflict contract.

The defect: the notepad was one global per-user key saved last-write-wins with
no revision, no broadcast and no conflict detection. A device holding stale
content saved it back AFTER another device had cleared the note, resurrecting
deleted text across devices.

Redesigned to kill the self-echo round trip that jittered the box
and clamped the caret while the user typed. The SAVER now learns its outcome
from the socket.io ACK -- the value handle_save_notepad RETURNS -- and is
excluded from the broadcast with ``skip_sid``.

The contract this suite pins:

  * ``get_notepad`` answers the text AND its revision (0 for a fresh user);
  * ``save_notepad`` carries ``base_revision``; a save based on the CURRENT
    revision applies, bumps the revision, RETURNS the outcome to the saver's
    ack, and broadcasts ``notepad_updated`` to every OTHER device in the room;
  * a save based on a STALE base_revision returns ``applied: False`` to the
    saver's ack carrying the server's text and revision, and nothing is
    written -- the deleted note can never be resurrected by a stale writer;
  * a save WITHOUT ``base_revision`` (pre-upgrade clients) keeps working as
    last-write-wins so old clients never break;
  * the server state after any sequence of saves is exactly the freshest
    accepted write.

Driven through ``socketio.test_client`` with two sockets of ONE user, exactly
like tests/test_pty_geometry_socket.py. The ack is read as the return value of
``emit(..., callback=True)``.
"""
import importlib
import os
import tempfile
import time

import pytest

from app import socketio
from app.auth import register_user


@pytest.fixture(scope='module')
def app():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        config.RATELIMIT_ENABLED = False

        from app import create_app
        from app.models import db

        test_app = create_app()
        from app import socket_events
        importlib.reload(socket_events)
        test_app.config['TESTING'] = True
        test_app.config['WTF_CSRF_ENABLED'] = False
        with test_app.app_context():
            db.create_all()
        yield test_app
        with test_app.app_context():
            db.session.remove()
            db.engine.dispose()


_registered_users_by_app = {}


def _login(app, stem):
    """One call = one MORE socket of the SAME user ``stem``.

    The stem is registered exactly once PER APP INSTANCE; every later call
    with the same stem opens another Flask session and another SocketIO test
    client for that SAME account -- a second device, not a second user. Two
    different stems still produce two different users. Getting this wrong
    makes every cross-device assertion in this suite vacuous: rooms are per
    USER, so two different users can never observe each other's broadcasts
    and the convergence contract below would test nothing. The registry is
    keyed by app instance id, so no registration leaks between fixtures.
    """
    registered = _registered_users_by_app.setdefault(id(app), set())
    if stem not in registered:
        with app.app_context():
            user, error = register_user(stem, 'notepad-sync-pass-123')
            assert error is None
        registered.add(stem)
    http_client = app.test_client()
    response = http_client.post('/login', data={
        'username': stem,
        'password': 'notepad-sync-pass-123',
    })
    assert response.status_code == 302
    socket_client = socketio.test_client(app, flask_test_client=http_client)
    assert socket_client.is_connected()
    socket_client.get_received()
    return socket_client


def _received(socket_client, name, timeout=5):
    deadline = time.monotonic() + timeout
    events = []
    while time.monotonic() < deadline:
        events.extend(socket_client.get_received())
        if any(event['name'] == name for event in events):
            break
        socketio.sleep(0.02)
    return [event['args'][0] for event in events if event['name'] == name]


def test_fresh_user_gets_empty_notepad_at_revision_zero(app):
    desktop = _login(app, 'fresh')
    desktop.emit('get_notepad')
    frames = _received(desktop, 'notepad_data')
    assert len(frames) == 1
    assert frames[0]['notepad'] == ''
    assert frames[0]['revision'] == 0
    assert frames[0].get('mode') == 'global'
    desktop.disconnect()


def test_one_device_consecutive_saves_never_self_conflict(app):
    """Redesign: the jank fix, as a SERVER contract.

    The old flow bumped the revision only when the self-echo broadcast came
    back, so a second save fired before that echo carried the SAME stale
    base_revision and the server refused it -- a self-conflict that overwrote
    the box and clamped the caret mid-type. The ack settles the revision
    SYNCHRONOUSLY, so a single device can save as fast as it likes and every
    save applies against the revision the previous ack returned. No frame is
    broadcast back to the saver at all, so its box is never rewritten by its
    own keystrokes.
    """
    solo = _login(app, 'solojank')

    base = 0
    for i in range(5):
        ack = solo.emit('save_notepad',
                        {'text': f'line {i}', 'base_revision': base},
                        callback=True)
        assert ack['applied'] is True, f'save {i} self-conflicted'
        assert ack['revision'] == i + 1
        base = ack['revision']
    # Not one self-echo reached the saver across the whole burst.
    assert _received(solo, 'notepad_updated', timeout=1) == []

    solo.emit('get_notepad')
    frames = _received(solo, 'notepad_data')
    assert frames[-1]['notepad'] == 'line 4' and frames[-1]['revision'] == 5
    solo.disconnect()


def test_current_base_save_applies_bumps_revision_and_broadcasts(app):
    desktop = _login(app, 'writer')
    mobile = _login(app, 'writer')

    # The saver learns its own new revision through the ACK, not a broadcast.
    ack = desktop.emit('save_notepad', {'text': 'hello', 'base_revision': 0},
                       callback=True)
    assert ack['applied'] is True
    assert ack['notepad'] == 'hello' and ack['revision'] == 1
    # The saver is excluded from its own broadcast (skip_sid): no self-echo.
    assert _received(desktop, 'notepad_updated', timeout=1) == []
    # The second device converges via the broadcast without ever asking.
    frames = _received(mobile, 'notepad_updated')
    assert any(f['notepad'] == 'hello' and f['revision'] == 1 for f in frames)

    mobile.emit('get_notepad')
    frames = _received(mobile, 'notepad_data')
    assert frames[-1]['notepad'] == 'hello' and frames[-1]['revision'] == 1
    desktop.disconnect()
    mobile.disconnect()


def test_stale_base_save_is_refused_and_cannot_resurrect(app):
    """The owner's exact cross-device sequence: desktop clears the note, then a
    stale mobile save must NOT resurrect the deleted content."""
    desktop = _login(app, 'resurrect')
    mobile = _login(app, 'resurrect')

    desktop.emit('save_notepad', {'text': 'keep me', 'base_revision': 0},
                 callback=True)
    _received(mobile, 'notepad_updated')

    # Desktop clears the note from revision 1 -> revision 2.
    desktop.emit('save_notepad', {'text': '', 'base_revision': 1},
                 callback=True)

    # Mobile is stale: it still believes revision 1 holds 'keep me' and saves
    # an edited variant of it. The write is refused; the ACK carries applied:
    # False plus the server truth, and the stored note stays empty.
    ack = mobile.emit('save_notepad',
                      {'text': 'keep me more', 'base_revision': 1},
                      callback=True)
    assert ack['applied'] is False
    assert ack['notepad'] == '' and ack['revision'] == 2

    mobile.emit('get_notepad')
    frames = _received(mobile, 'notepad_data')
    assert frames[-1]['notepad'] == '' and frames[-1]['revision'] == 2
    desktop.emit('get_notepad')
    frames = _received(desktop, 'notepad_data')
    assert frames[-1]['notepad'] == '' and frames[-1]['revision'] == 2
    desktop.disconnect()
    mobile.disconnect()


def test_save_without_base_revision_stays_last_write_wins(app):
    """Pre-upgrade clients send no base_revision. They must keep working:
    accepted as last-write-wins and broadcast like any other save."""
    old = _login(app, 'oldclient')
    new = _login(app, 'oldclient')

    # A pre-upgrade client sends no base_revision and requests no callback; the
    # save still applies and the OTHER device converges via the broadcast.
    old.emit('save_notepad', {'text': 'legacy write'})
    frames = _received(new, 'notepad_updated')
    assert len(frames) == 1
    assert frames[0]['notepad'] == 'legacy write'
    assert frames[0]['revision'] >= 1
    old.disconnect()
    new.disconnect()


def test_saved_mode_persists_the_choice_not_the_resolution(app):
    """S17 D2: saving per_server with no target yet writes the global bucket
    (that is what effective resolution demands -- the label must never lie)
    but still records notepad_mode='per_server' as the user's CHOICE. The
    defect being pinned: persisting the resolved mode silently discarded the
    preference and put the panel back on Global at every reload.
    """
    c = _login(app, 'choicemode')

    # No target bound: the write resolves to global and lands there...
    ack = c.emit('save_notepad', {'text': 'chosen but unbound', 'base_revision': 0,
                                  'mode': 'per_server'}, callback=True)
    assert ack['mode'] == 'global', 'label names the bucket actually written'
    # ...and get_notepad confirms it read the GLOBAL note:
    c.emit('get_notepad')
    f = _received(c, 'notepad_data')[-1]
    assert f['notepad'] == 'chosen but unbound' and f['mode'] == 'global'
    # ...but the CHOICE is what persists:
    assert f['stored_mode'] == 'per_server'

    c.disconnect()


def test_global_mode_invariance_and_per_server_isolation(app):
    """Ruling A / G2: Global notes stay invariant; Per-server notes are isolated per target."""
    c1 = _login(app, 'scopeuser')
    c2 = _login(app, 'scopeuser')

    # 1. Global note saved by c1
    c1.emit('save_notepad', {'text': 'global note content', 'base_revision': 0, 'mode': 'global'})
    frames = _received(c2, 'notepad_updated')
    assert any(f['notepad'] == 'global note content' and f['mode'] == 'global' for f in frames)

    # 2. Per-server note for server-A
    c1.emit('save_notepad', {'text': 'server A notes', 'base_revision': 0, 'mode': 'per_server', 'target_id': 'host-a.example'})
    frames = _received(c2, 'notepad_updated')
    assert any(f['notepad'] == 'server A notes' and f['target_id'] == 'host-a.example' for f in frames)

    # 3. Per-server note for server-B (fresh revision 0)
    c1.emit('save_notepad', {'text': 'server B notes', 'base_revision': 0, 'mode': 'per_server', 'target_id': 'host-b.example'})
    frames = _received(c2, 'notepad_updated')
    assert any(f['notepad'] == 'server B notes' and f['target_id'] == 'host-b.example' for f in frames)

    # 4. Fetch server A vs server B vs global: all distinct
    c2.emit('get_notepad', {'mode': 'per_server', 'target_id': 'host-a.example'})
    f_a = _received(c2, 'notepad_data')
    assert f_a[-1]['notepad'] == 'server A notes'
    assert f_a[-1]['revision'] == 1

    c2.emit('get_notepad', {'mode': 'per_server', 'target_id': 'host-b.example'})
    f_b = _received(c2, 'notepad_data')
    assert f_b[-1]['notepad'] == 'server B notes'
    assert f_b[-1]['revision'] == 1

    c2.emit('get_notepad', {'mode': 'global'})
    f_g = _received(c2, 'notepad_data')
    assert f_g[-1]['notepad'] == 'global note content'
    assert f_g[-1]['revision'] == 1

    c1.disconnect()
    c2.disconnect()


def test_frame_carries_stored_mode_independent_of_effective_mode(app):
    """S17 D2: every notepad_data frame carries ``stored_mode`` -- the raw
    persisted preference -- alongside the EFFECTIVE mode naming the bucket
    actually read.

    The two must be separate keys because they legitimately disagree at
    connect time: a persisted per_server choice with no target_id bound yet
    resolves to global (per-server needs a target), so a client keying its
    startup restore off the effective mode could never restore per_server.
    This is the server half of the reload-restoration contract; app.js's
    notepad_data handler reads stored_mode.
    """
    c = _login(app, 'restoreuser')

    # Fresh user: nothing persisted, both agree on global.
    c.emit('get_notepad')
    f = _received(c, 'notepad_data')[-1]
    assert f['mode'] == 'global'
    assert f['stored_mode'] == 'global'

    # Persist the per_server choice...
    c.emit('save_notepad', {'text': 'x', 'base_revision': 0, 'mode': 'per_server', 'target_id': None},
           callback=True)

    # ...then ask with NO mode and NO target: content resolves to global,
    # effective mode says global, but stored_mode still says per_server --
    # that key is what lets the panel come back on Per-server after reload.
    c.emit('get_notepad')
    f = _received(c, 'notepad_data')[-1]
    assert f['mode'] == 'global', 'no target bound: bucket read is genuinely global'
    assert f['stored_mode'] == 'per_server', 'the CHOICE survives independent of resolution'

    # An explicit request for another scope does not overwrite the preference.
    c.emit('get_notepad', {'mode': 'global'})
    f = _received(c, 'notepad_data')[-1]
    assert f['mode'] == 'global' and f['stored_mode'] == 'per_server'

    # With a target bound, per_server resolves as itself and the two agree.
    c.emit('get_notepad', {'mode': 'per_server', 'target_id': 'host-a.example'})
    f = _received(c, 'notepad_data')[-1]
    assert f['mode'] == 'per_server' and f['stored_mode'] == 'per_server'

    c.disconnect()
