"""One HTTP polling payload, and the ceiling on both sides of it.

python-engineio decodes at most `Payload.max_decode_packets` packets out of a
single polling POST. Above that it raises, the request is answered 200, and
NOTHING in the batch is delivered -- no error reaches the client, so nothing is
retried. Measured on the deployment 2026-09-20: a three-pane reload queued more
than 16 events while the transport was still polling, the batch was discarded,
and the panes sat on a stale frame for 7.1s and 7.2s until the app's own attach
retry woke them.

Two halves hold it shut, and both are pinned here:

  * the bundled client caps its own polling batch at 16, the floor any
    python-engineio deployment guarantees (scripts/socketio-entry.js, and the
    behaviour itself in tests/browser/socketio_polling.mjs);
  * this server raises its ceiling, which is what covers a browser still
    holding an older bundle, and a startup burst that grows with the workspace.
"""
from pathlib import Path

import config

SOURCE = Path(__file__).resolve().parent.parent
ENTRY = SOURCE / 'scripts' / 'socketio-entry.js'
BUNDLE = SOURCE / 'static' / 'vendor' / 'socketio' / 'socket.io.min.js'

# What python-engineio ships as its default, and therefore the largest batch a
# client may send to a deployment that has not raised it.
ENGINEIO_DEFAULT_MAX_DECODE_PACKETS = 16


def test_server_ceiling_clears_a_reload_burst():
    """The ceiling has to be above the burst it exists to survive."""
    assert config.SOCKETIO_MAX_DECODE_PACKETS > ENGINEIO_DEFAULT_MAX_DECODE_PACKETS
    # A three-pane reload measured 13 application events plus the protocol's
    # own packets. Double that is the headroom this number is chosen for.
    assert config.SOCKETIO_MAX_DECODE_PACKETS >= 32


def test_create_app_applies_the_ceiling(app):
    """Declaring it is not enough: engineio reads a class attribute."""
    from engineio.payload import Payload

    assert Payload.max_decode_packets == config.SOCKETIO_MAX_DECODE_PACKETS


def test_client_caps_its_own_polling_batches():
    """The cap ships in the bundle, at the value every deployment accepts."""
    entry = ENTRY.read_text(encoding='utf-8')
    assert f'ENGINE_IO_MAX_PACKETS = {ENGINEIO_DEFAULT_MAX_DECODE_PACKETS};' in entry
    assert '_getWritablePackets' in entry
    # The hook is private, so the entry must survive its disappearance rather
    # than calling `undefined` on every flush; `npm run vendor` refuses to
    # build without it, which is where that break is meant to surface.
    assert "typeof engineWritablePackets === 'function'" in entry
    # The built file is what the browser runs. Minification drops the wrapper's
    # name, but the stock library defines the method as a class member, so an
    # assignment to it can only be ours.
    assert '_getWritablePackets=function(' in BUNDLE.read_text(encoding='utf-8')
