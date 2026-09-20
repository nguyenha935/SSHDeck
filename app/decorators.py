import inspect
from functools import wraps
from flask_socketio import disconnect, emit
from flask import request, abort
from flask_login import current_user
from .auth import get_user_from_socket
from .audit_logger import log_warning


def admin_required(f):
    """Require an authenticated admin for an HTTP route (use after @login_required)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not current_user.is_authenticated or not getattr(current_user, 'is_admin', False):
            log_warning("Unauthorized admin access attempt",
                        user=getattr(current_user, 'username', None),
                        path=getattr(request, 'path', None))
            abort(403)
        return f(*args, **kwargs)
    return decorated_function

def accepts_raw_payload(f):
    """Opt a socket handler out of the decorator's non-dict refusal.

    By default socket_login_required REFUSES a non-dict payload, because it
    cannot know whether a given handler reads {} as "use every default" or as a
    mutation -- and at least one (save_notepad) turns {} into a last-write-wins
    empty write that destroys the user's note.

    A handler marks itself with this ONLY when it answers a malformed frame
    BETTER than the generic refusal can. The one case today is
    handle_candidate_reset: its contract (W13-B6) echoes `request_id` on EVERY
    reply, success and error alike, so the client can act on exactly its own
    answer; a generic 'error' frame would strip that correlation. Such a handler
    MUST normalize the payload itself and MUST NOT mutate anything on a
    malformed frame.

    Marking is an attribute rather than a wrapper so the __wrapped__ chain the
    tests rely on is unchanged, and so `grep -n accepts_raw_payload` lists every
    exception to the refusal contract in one shot.
    """
    f._accepts_raw_payload = True
    return f


def socket_login_required(f):
    """
    Decorator to require authentication for socket events.

    This decorator:
    1. Gets the SocketIO session ID from the request
    2. Looks up the authenticated user for this socket
    3. Disconnects if no authenticated user found
    4. Injects 'current_user' parameter into the decorated function

    Usage:
        @socketio.on('some_event')
        @socket_login_required
        def handle_event(data, current_user=None):
            # current_user is automatically injected
            print(f"User {current_user.username} triggered event")

    Payload contract (S1). Flask-SocketIO dispatches non-connect events as
    ``handler(*args)`` and its TypeError retry exists ONLY for 'connect', and
    this app registers no exception_handlers -- so a handler that raises is
    dropped silently: no reply, no error, the client waits forever. Two shapes
    used to raise exactly that way:

      * a bare ``emit('x')`` reached a required-``data`` handler as
        ``handler()`` -> "missing 1 required positional argument: 'data'";
      * any payload reached a data-less handler as ``handler(payload,
        current_user=user)`` -> "got multiple values for argument
        'current_user'" (the logged get_notepad / list_profiles / list_keys /
        list_jump_hosts failures, plus latent get_sessions).

    So the arity is normalized here, once, for every handler: no payload, an
    explicit ``None`` and ``{}`` all arrive as ``{}`` (no handler subscripts
    ``data``; every one reads it with ``.get()``, so an empty dict takes each
    missing-field branch), and a payload that cannot be a payload is refused
    with an error frame rather than raised. Only the top-level container is
    normalized: a dict carrying bytes for a binary transfer passes through
    untouched.
    """
    # Decoration-time: does this handler own a data slot? The five list/get
    # handlers take no payload, so handing them one positionally IS the
    # "multiple values for current_user" crash.
    _positional = [p for p in inspect.signature(f).parameters.values()
                   if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
                   and p.name != 'current_user']
    _takes_data = bool(_positional)

    @wraps(f)
    def decorated_function(*args, **kwargs):
        socket_sid = request.sid
        user = get_user_from_socket(socket_sid)
        if not user:
            log_warning(f"Unauthorized socket event attempt", event=f.__name__, sid=socket_sid)
            disconnect()
            return
        kwargs['current_user'] = user

        # Never raise from here: a raising handler is dropped silently, which
        # is the production failure mode this contract exists to end. Refuse
        # loudly instead, to THIS client (emit is context-local; socketio.emit
        # without a room would broadcast one client's error to everyone).
        if len(args) > 1:
            log_warning("Multi-arg socket payload refused",
                        event=f.__name__, sid=socket_sid)
            emit('error', {'error': 'Invalid payload'})
            return None
        payload = args[0] if args else None
        if payload is None:
            payload = {}
        elif not isinstance(payload, dict):
            # REFUSE. Never normalize a non-dict into {} and pass it on.
            #
            # An earlier revision of this decorator did exactly that, reasoning
            # That {} is harmless because every handler reads data with.get.
            # That reasoning was WRONG, and the counter-example is destructive:
            #
            #   emit('save_notepad', 'garbage')
            #     -> text = data.get('text', '')          == ''
            #     -> the 100KB size check passes trivially (it is not a guard)
            #     -> base_revision = data.get('base_revision')  == None
            #     -> save_notepad_revision(user, '', None), and None is the
            #        documented pre-upgrade LAST-WRITE-WINS path
            #     -> the note is WIPED and the revision bumped, so G3's
            #        broadcast then converges every other device on the empty
            #        text.
            # Measured: 'IMPORTANT NOTES the owner typed' -> '' (revision 1->2).
            #
            # The decorator cannot know which handlers treat {} as a legal
            # "defaults everywhere" request and which treat it as a mutation, so
            # refusal is the only contract that is safe for all 50 gated
            # handlers by construction. A handler that genuinely wants to answer
            # a malformed frame itself opts in with @accepts_raw_payload.
            if not getattr(f, '_accepts_raw_payload', False):
                log_warning("Non-dict socket payload refused",
                            event=f.__name__, sid=socket_sid)
                emit('error', {'error': 'Invalid payload'})
                return None
            # Opted in: hand the raw value through UNCHANGED so the handler can
            # produce its own correlated reply. It is the handler's contract to
            # normalize (candidate_reset does `data if isinstance(data, dict)
            # Else {}` and then echoes request_id on every reply,).

        return f(payload, **kwargs) if _takes_data else f(**kwargs)

    return decorated_function
