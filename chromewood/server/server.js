#!/usr/bin/env node
/* ============================================================
   server.js - rooms for Chromewood

   Serves the game over HTTP and relays messages between the
   players in a room. It does not simulate anything: one client is
   the host and owns the world, which keeps this process small
   enough to run on a laptop, a Pi or a free dyno, and means the
   game still works with no server at all when you play solo.

   No dependencies. The WebSocket handshake and framing are done
   against RFC 6455 by hand, which is about a hundred and fifty
   lines and saves the project from needing an install step.

     node server/server.js [--port 8090] [--max 4]
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = parseInt(arg('port', process.env.PORT || '8090'), 10);
const MAX_PLAYERS = Math.max(2, Math.min(8, parseInt(arg('max', '4'), 10)));
const ROOM_IDLE_MS = 10 * 60 * 1000;

/* ------------------------------------------------------ static files */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg',
};

function serve(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  if (rel === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: totalPlayers() }));
    return;
  }
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------ websocket plumbing */
function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(payload, opcode = 0x1) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, data]);
}

/* Pulls whole frames out of a growing buffer, reassembling any
   continuation frames a browser decides to split a snapshot into. */
function decode(state, chunk, onText, onClose, onPing) {
  state.buf = state.buf ? Buffer.concat([state.buf, chunk]) : chunk;
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 4 * 1024 * 1024) { onClose(); return; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return;
    const mask = masked ? b.subarray(off, off + 4) : null;
    const payload = Buffer.from(b.subarray(off + maskLen, off + maskLen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    state.buf = b.subarray(off + maskLen + len);

    if (opcode === 0x8) { onClose(); return; }
    if (opcode === 0x9) { onPing(payload); continue; }
    if (opcode === 0xA) continue;                    /* pong: ignore */
    if (opcode === 0x0) {
      state.frag = Buffer.concat([state.frag || Buffer.alloc(0), payload]);
    } else if (opcode === 0x1) {
      state.frag = payload;
    } else {
      continue;                                      /* binary: unused */
    }
    if (fin && state.frag) {
      const text = state.frag.toString('utf8');
      state.frag = null;
      onText(text);
    }
  }
}

/* ----------------------------------------------------------- rooms */
const rooms = new Map();          /* code -> { code, clients: [], seed, difficulty, hostId, lastActive } */
let nextClientId = 1;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* no look-alikes */
function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

function totalPlayers() {
  let n = 0;
  for (const r of rooms.values()) n += r.clients.length;
  return n;
}

function send(client, obj) {
  if (client.socket.destroyed) return;
  try { client.socket.write(frame(JSON.stringify(obj))); }
  catch (e) { dropClient(client); }
}

function broadcast(room, obj, exceptId) {
  for (const c of room.clients) if (c.id !== exceptId) send(c, obj);
}

function dropClient(client) {
  const room = rooms.get(client.room);
  try { client.socket.destroy(); } catch (e) { /* already gone */ }
  if (!room) return;
  const i = room.clients.indexOf(client);
  if (i >= 0) room.clients.splice(i, 1);
  broadcast(room, { t: 'gone', id: client.id });
  log(`${client.name} left ${room.code} (${room.clients.length} left)`);

  if (!room.clients.length) {
    rooms.delete(room.code);
    log(`room ${room.code} closed`);
    return;
  }
  /* Promote the longest-present survivor; they rebuild the world
     from the room's seed and carry on. */
  if (room.hostId === client.id) {
    room.hostId = room.clients[0].id;
    broadcast(room, { t: 'hostchange', id: room.hostId });
    log(`room ${room.code} host is now ${room.clients[0].name}`);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/* ------------------------------------------------------------ boot */
const server = http.createServer(serve);

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n');
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const client = { id: nextClientId++, socket, name: 'RUNNER', room: null, joined: false };
  const state = {};

  socket.on('data', (chunk) => decode(state, chunk,
    (text) => handle(client, text),
    () => dropClient(client),
    (payload) => { try { socket.write(frame(payload.toString('utf8'), 0xA)); } catch (e) { /* gone */ } }));
  socket.on('error', () => dropClient(client));
  socket.on('close', () => dropClient(client));
});

function handle(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }

  if (msg.t === 'ping') { send(client, { t: 'pong', n: msg.n }); return; }

  if (msg.t === 'hello') {
    if (client.joined) return;
    client.name = String(msg.name || 'RUNNER').slice(0, 12).toUpperCase();

    let room;
    if (msg.host) {
      room = {
        code: makeRoomCode(), clients: [], seed: String(msg.seed || '').slice(0, 16),
        difficulty: Number(msg.difficulty) || 1, hostId: client.id, lastActive: Date.now(),
      };
      rooms.set(room.code, room);
      log(`room ${room.code} opened by ${client.name}`);
    } else {
      const code = String(msg.room || '').toUpperCase().trim();
      room = rooms.get(code);
      if (!room) { send(client, { t: 'err', code: 'noroom', msg: `No run with the code ${code || '(blank)'}.` }); return; }
      if (room.clients.length >= MAX_PLAYERS) {
        send(client, { t: 'err', code: 'full', msg: 'That run is full.' });
        return;
      }
    }

    client.room = room.code;
    client.joined = true;
    room.clients.push(client);
    room.lastActive = Date.now();

    send(client, {
      t: 'welcome',
      id: client.id,
      host: room.hostId === client.id,
      room: room.code,
      seed: room.seed,
      difficulty: room.difficulty,
      hostId: room.hostId,
      peers: room.clients.filter(c => c.id !== client.id).map(c => ({ id: c.id, name: c.name })),
    });
    broadcast(room, { t: 'peer', id: client.id, name: client.name }, client.id);
    log(`${client.name} joined ${room.code} (${room.clients.length}/${MAX_PLAYERS})`);
    return;
  }

  if (msg.t === 'msg' && client.joined) {
    const room = rooms.get(client.room);
    if (!room) return;
    room.lastActive = Date.now();
    const out = { t: 'msg', from: client.id, d: msg.d };
    if (msg.to === 'all' || msg.to === undefined) broadcast(room, out, client.id);
    else {
      const target = room.clients.find(c => c.id === msg.to);
      if (target) send(target, out);
    }
  }
}

/* Sweep rooms nobody has spoken in for a while, so a crashed tab
   cannot hold a code forever. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_IDLE_MS) {
      for (const c of [...room.clients]) { try { c.socket.destroy(); } catch (e) { /* gone */ } }
      rooms.delete(code);
      log(`room ${code} timed out`);
    }
  }
}, 60000);

server.listen(PORT, () => {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
  }
  console.log('');
  console.log('  CHROMEWOOD server');
  console.log(`  play:    http://localhost:${PORT}/`);
  for (const a of addrs) console.log(`  network: http://${a}:${PORT}/`);
  console.log(`  relay:   ws://<host>:${PORT}/ws   (max ${MAX_PLAYERS} per room)`);
  console.log('');
});
