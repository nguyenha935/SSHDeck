"""S1 -- every @socket_login_required handler survives every payload shape a
client can legally send.

Two production failure modes, one contract. The decorator injects current_user
as a kwarg and Flask-SocketIO dispatches non-connect events as handler(*args)
with NO TypeError fallback (that retry exists only for 'connect'), and this app
registers no exception_handlers -- so a handler that raises is dropped
silently: no reply, no error, the client waits forever.

  * a data-less handler handed any payload raises 'got multiple values for
    argument current_user' -- the four logged production TypeErrors
    (get_notepad, list_profiles, list_keys, list_jump_hosts) plus the latent
    fifth, get_sessions, which no browser emits today;
  * a required-data handler called with NO payload raises 'missing 1 required
    positional argument' -- the mirror-image half, which any bare emit hits.

A third failure mode was introduced while fixing those two, and is pinned here
as well: a NON-DICT payload must be REFUSED, never normalized to {} and passed
on. {} is not harmless -- save_notepad turns it into a last-write-wins empty
write that destroys the note (measured: 'IMPORTANT NOTES...' -> '', revision
1 -> 2). Only handlers that answer a malformed frame BETTER than the refusal can,
and that mutate nothing on that path, opt in via @accepts_raw_payload; today
that is candidate_reset alone, for its W13-B6 request_id correlation.

The registry is DERIVED from app/socket_events.py on every run, so a handler
added later without a data slot fails here instead of shipping.

Isolation: no reload of socket_events (that re-registers all handlers on the
module-global socketio and leaks them into later suites); DATA_DIR/config
restored on teardown; a uuid-stemmed throwaway account inside the temp
DATA_DIR only. No production data, no real SSH, no owner session touched.
"""
import importlib
import inspect
import os
import re
import tempfile
import uuid
from pathlib import Path

import pytest

PAYLOAD_SHAPES = (('no payload', ()), ('empty dict', ({},)))

# Events whose reply proves the event was not dropped. The production symptom
# was silence, so 'did not raise' is too weak an assertion on its own.
EXPECTED_REPLY = {
    'get_notepad': 'notepad_data',        # the four logged TypeErrors
    'list_profiles': 'profiles_list',
    'list_keys': 'keys_list',
    'list_jump_hosts': 'jump_hosts_list',
    'get_sessions': 'sessions_list',      # latent: no browser emitter today
    'list_command_sets': 'command_sets_list',
    'detect_os': 'error',                 # a refusal by design is still a reply
}


def _registry():
    """Every gated event -> handler, derived from source (not a hand list)."""
    root = Path(__file__).resolve().parent.parent
    src = (root / 'app' / 'socket_events.py').read_text(encoding='utf-8')
    # Tolerate ANY intervening decorator or comment lines between
    # @socket_login_required and the def.
    #
    # This regex used to demand that the def follow @socket_login_required
    # IMMEDIATELY, which made the whole suite quietly weaker: adding a second
    # decorator (or even a comment) to a handler dropped it out of the registry,
    # so every sweep below silently stopped covering it -- no failure, just less
    # coverage. Found when @accepts_raw_payload was added to candidate_reset.
    # The count assertion below is what turns a future drop-out into a failure.
    pairs = re.findall(
        r"@socketio\.on\('([a-z_]+)'\)\s*\n\s*@socket_login_required\s*\n"
        r"(?:\s*(?:#[^\n]*|@[^\n]+)\n)*"
        r"\s*def (handle_\w+)\(",
        src)
    # Independent count of gated handlers, from the decorator pairing alone.
    gated = re.findall(r"@socketio\.on\('([a-z_]+)'\)\s*\n\s*@socket_login_required", src)
    assert len(pairs) == len(gated), (
        f'registry lost {len(gated) - len(pairs)} handler(s) to a parsing gap: '
        f'{sorted(set(gated) - {e for e, _ in pairs})}. Every gated handler must '
        'be swept, or the guarantees in this suite are narrower than they read.')
    from app import socket_events
    return {ev: getattr(socket_events, fn) for ev, fn in pairs}


@pytest.fixture(scope='module')
def app():
    saved_data_dir = os.environ.get('DATA_DIR')
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        os.environ['DATA_DIR'] = tmpdir
        import config
        importlib.reload(config)
        saved_ratelimit = config.RATELIMIT_ENABLED
        config.RATELIMIT_ENABLED = False

        from app import create_app
        from app.models import db

        test_app = create_app()          # registers handlers once; NO reload
        test_app.config.update(TESTING=True, WTF_CSRF_ENABLED=False)
        with test_app.app_context():
            db.create_all()
        yield test_app
        with test_app.app_context():
            db.session.remove()
            db.engine.dispose()
        config.RATELIMIT_ENABLED = saved_ratelimit
    if saved_data_dir is None:
        os.environ.pop('DATA_DIR', None)
    else:
        os.environ['DATA_DIR'] = saved_data_dir


@pytest.fixture(scope='module')
def client(app):
    from app import socketio
    from app.auth import register_user

    stem = f's1contract{uuid.uuid4().hex[:8]}'
    password = 'contract-pass-123'
    with app.app_context():
        user, error = register_user(stem, password)
        assert error is None
    http = app.test_client()
    response = http.post('/login', data={'username': stem, 'password': password})
    assert response.status_code == 302
    sock = socketio.test_client(app, flask_test_client=http)
    assert sock.is_connected()
    sock.get_received()                  # drain the connect snapshot
    return sock


def test_every_gated_handler_declares_a_data_slot():
    """Static pin: first positional is a data slot, current_user is a kwarg.

    This is exactly what the five broken signatures violated. Derived, so the
    next handler written without a data slot fails here.
    """
    offenders = []
    for event, fn in sorted(_registry().items()):
        params = list(inspect.signature(fn.__wrapped__).parameters)
        if not params or params[0] != 'data' or 'current_user' not in params:
            offenders.append(f'{event}{tuple(params)}')
    assert offenders == [], (
        f'handlers without a (data, ..., current_user) shape: {offenders}')


def test_no_gated_event_raises_on_any_legal_payload_shape(client):
    """Fire EVERY gated event with no payload AND with {}. None may raise or
    drop the socket. A raise here is invisible in production (no
    exception_handlers), so the connection check is the observable proxy.
    """
    for event in sorted(_registry()):
        for label, args in PAYLOAD_SHAPES:
            client.emit(event, *args)
            client.get_received()        # public API only; one drain per emit
            assert client.is_connected(), f'{event} with {label}: socket dropped'


def test_reply_bearing_events_answer_with_no_payload(client):
    """The four logged TypeErrors plus the latent fifth: the client must get
    its reply, not silence.
    """
    missing = []
    for event, reply in sorted(EXPECTED_REPLY.items()):
        client.emit(event)               # bare emit: the production shape
        names = {pkt['name'] for pkt in client.get_received()}
        if reply not in names:
            missing.append(
                f'{event} -> expected {reply}, got {sorted(names) or "silence"}')
    assert missing == [], (
        'events the client would wait forever for: ' + '; '.join(missing))


def test_malformed_payloads_never_raise_and_always_answer(client):
    """A malformed payload must be answered, never dropped silently.

    Two shapes, two treatments -- deliberately different:

      * NON-DICT is normalized to {} and passed to the handler, so the handler
        gives its OWN answer. Nine handlers already normalize a non-dict
        themselves and reply with a correlated error (candidate_reset echoes
        request_id on every reply, per W13-B6); a decorator-level generic frame
        would pre-empt that richer reply and tell the client less. {} is safe
        because every handler reads data with .get().
      * MULTI-ARG is refused at the decorator with a generic error frame,
        because there is no single payload to hand on and collapsing the args
        into a tuple would put a non-dict in the data slot, where .get() raises
        inside the handler's try-block and the event is dropped.

    Either way the socket survives and the client is told something.
    """
    for event in ('get_notepad', 'list_directory'):
        client.emit(event, 'not-a-dict')
        names = {pkt['name'] for pkt in client.get_received()}
        assert names == {'error'}, (
            f'{event} with a non-dict payload must be refused at the decorator '
            f'and never reach the handler; got {sorted(names) or "silence"}')
        assert client.is_connected()

        client.emit(event, {}, {})
        names = {pkt['name'] for pkt in client.get_received()}
        assert 'error' in names, f'{event} with multiple args: refused silently'
        assert client.is_connected()


def test_the_decorator_module_imports_every_name_its_error_path_uses():
    """Static guard for the NameError class of defect.

    The decorator's refusal branch emits an error frame. If `emit` is not
    imported in app/decorators.py, that raises NameError -- and with no
    exception_handlers registered the raise is swallowed, so the loud refusal
    becomes the silent drop this whole contract exists to end. Asserted
    statically because a missing import fails only on the error path, which is
    exactly the path least likely to be exercised by accident.
    """
    import app.decorators as decorators
    source = Path(decorators.__file__).read_text(encoding='utf-8')
    if 'emit(' in source:
        assert hasattr(decorators, 'emit'), (
            'app/decorators.py calls emit() but never imports it: every '
            'malformed payload would raise NameError and be dropped silently')
        from flask_socketio import emit as flask_socketio_emit
        assert decorators.emit is flask_socketio_emit, (
            'decorators.emit must be flask_socketio.emit (client-scoped). '
            'socketio.emit without a room broadcasts one client\'s payload '
            'error to every connected user.')
    assert hasattr(decorators, 'inspect'), (
        'the decorator introspects handler signatures; inspect must be imported')


def test_a_non_dict_payload_cannot_wipe_the_notepad(app, client):
    """R1 negative proof: the regression this contract exists to prevent.

    An earlier revision normalized a non-dict payload to {} and passed it on,
    reasoning that {} is harmless because handlers read data with .get(). For
    save_notepad it is destructive: text defaults to '', the 100KB check passes
    trivially, base_revision defaults to None, and None is the documented
    pre-upgrade LAST-WRITE-WINS path -- so the note is wiped and the revision
    bumped, after which G3's broadcast converges every other device on the empty
    text. Measured before the fix: 'IMPORTANT NOTES...' -> '' (revision 1 -> 2).

    This pin is the one whose absence let that ship. It asserts STORED STATE,
    not the reply, because the reply was never the problem.
    """
    from app.user_settings import get_notepad, save_notepad_revision

    seeded = 'IMPORTANT NOTES the owner typed'
    with app.app_context():
        from app.models import User
        user = User.query.filter(User.username.like('s1contract%')).first()
        assert user is not None, 'the fixture account is missing'
        ok, _result = save_notepad_revision(user.id, seeded, None)
        assert ok
        before_text, before_revision = get_notepad(user.id)
        assert before_text == seeded
        user_id = user.id

    client.emit('save_notepad', 'garbage-not-a-dict')
    client.get_received()

    with app.app_context():
        after_text, after_revision = get_notepad(user_id)
    assert after_text == seeded, (
        f'a non-dict payload mutated the notepad: {before_text!r} -> '
        f'{after_text!r}')
    assert after_revision == before_revision, (
        f'a non-dict payload bumped the revision {before_revision} -> '
        f'{after_revision}, which would broadcast the change to every device')


def test_no_gated_event_mutates_state_on_a_non_dict_payload(client):
    """Sweep every gated event with a non-dict payload.

    Per-event state assertions are impossible here, so this asserts the
    mechanism instead: each event must be REFUSED at the decorator (an 'error'
    frame, no handler reply) unless it is explicitly opted in with
    @accepts_raw_payload. Refusal is what makes "cannot mutate" true for all of
    them at once, so a future handler added without a guard is covered by
    construction rather than by review.
    """
    import app.socket_events as socket_events

    exempt = {event for event, fn in _registry().items()
              if getattr(fn.__wrapped__, '_accepts_raw_payload', False)}
    # Recorded explicitly so widening the exemption set is a visible change.
    assert exempt == {'candidate_reset'}, (
        f'the raw-payload exemption set changed: {exempt}. Every addition must '
        'be justified: the handler must answer better than the generic refusal '
        'AND must mutate nothing on a malformed frame.')

    offenders = []
    for event in sorted(_registry()):
        if event in exempt:
            continue
        client.emit(event, 'not-a-dict')
        names = {pkt['name'] for pkt in client.get_received()}
        if names != {'error'}:
            offenders.append(f'{event} -> {sorted(names) or "silence"}')
        assert client.is_connected(), f'{event}: socket dropped'
    assert offenders == [], (
        'events that did not cleanly refuse a non-dict payload (each one could '
        f'reach a handler that reads {{}} as a valid request): {offenders}')


def test_opted_in_handler_still_answers_with_a_correlated_error(client):
    """The exemption must buy something real.

    candidate_reset is exempt precisely so it can answer a malformed frame with
    its own correlated error instead of the generic refusal. If that stops
    working, the exemption is pure risk with no benefit and should be removed.
    """
    client.emit('candidate_reset', 'not-a-dict')
    frames = client.get_received()
    names = {pkt['name'] for pkt in frames}
    assert 'candidate_reset_error' in names, (
        f'the opted-in handler did not produce its correlated error: {names}')
    assert 'error' not in names, (
        'the generic refusal frame was emitted for an opted-in handler')


def test_decorator_refusal_reaches_the_client_as_a_real_frame(client):
    """The executable half of the import smoke.

    The static test above proves `emit` is imported; this proves the refusal
    branch actually RUNS to completion and delivers to THIS client -- rather
    than raising NameError inside the decorator (which, with no
    exception_handlers registered, would be swallowed and look like silence) or
    broadcasting one client's payload error to everyone.

    Driven with the multi-arg shape, which is the shape the decorator refuses on
    its own; a non-dict is normalized and answered by the handler instead.
    """
    client.emit('get_notepad', {}, {})
    frames = client.get_received()
    errors = [pkt for pkt in frames if pkt['name'] == 'error']
    assert errors, (
        f'refusal never reached the client; got {[p["name"] for p in frames]}')
    assert errors[0]['args'][0] == {'error': 'Invalid payload'}
    assert client.is_connected()
