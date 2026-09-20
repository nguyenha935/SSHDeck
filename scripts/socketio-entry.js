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

io.io = io;
io.Manager = Manager;
io.Socket = Socket;
io.connect = connect;
io.protocol = protocol;

window.io = io;
