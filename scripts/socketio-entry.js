/*
 * The entry point for the Socket.IO browser bundle that `npm run vendor`
 * builds into static/vendor/socketio/socket.io.min.js.
 *
 * It reproduces the shape the upstream prebuilt bundle exposed, because that
 * is what the page expects: a global `io` that is callable
 * (`window.socket = io({ path: ... })` in static/js/app.js) and carries the
 * named exports as properties.
 *
 * This file exists because the upstream prebuilt bundle inlines a
 * socket.io-parser older than the one CVE-2026-69185 was fixed in, and no
 * dependency bump can change a file that ships already built.
 */
import { io, Manager, Socket, connect, protocol } from 'socket.io-client';
import { Socket as EngineSocket } from 'engine.io-client';

/*
 * Python Engine.IO accepts at most 16 packets in one HTTP polling payload
 * (engineio.payload.Payload.max_decode_packets). The browser client normally
 * limits only by byte size, so a reload with several panes can queue more than
 * 16 startup events while polling is still active. The server then logs
 * "Too many packets in payload", returns 200, and silently loses the whole
 * batch, including view_attach and get_notepad. Keep the server's safety cap
 * and split the client packet batch before it crosses that boundary.
 *
 * The method is private in Engine.IO, but it is the single point where a
 * writable polling payload is selected. The original method still enforces
 * the negotiated byte limit; this wrapper adds the packet-count ceiling and
 * leaves WebSocket batches untouched.
 */
const ENGINE_IO_MAX_PACKETS = 16;
const engineWritablePackets = EngineSocket.prototype._getWritablePackets;
EngineSocket.prototype._getWritablePackets = function sshdeckWritablePackets() {
    const packets = engineWritablePackets.call(this);
    if (this.transport?.name !== 'polling') {
        return packets;
    }
    return packets.length > ENGINE_IO_MAX_PACKETS
        ? packets.slice(0, ENGINE_IO_MAX_PACKETS) : packets;
};

io.io = io;
io.Manager = Manager;
io.Socket = Socket;
io.connect = connect;
io.protocol = protocol;

window.io = io;
