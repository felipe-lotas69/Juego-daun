#!/usr/bin/env node
/* ============================================================
   server.js - LAN host for Getaway Daun

   Serves the game over HTTP and runs the authoritative simulation,
   so every machine on the network sees the same world. Up to four
   players; any empty slot is filled with a bot.

   No dependencies: the WebSocket handshake and framing are done by
   hand against RFC 6455, which is about a hundred lines and saves
   the whole project from needing an install step.

     node server/server.js [--port 8080] [--bots 3] [--target 3]
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ------------------------------------------------------------------ args */
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = parseInt(arg('port', '8080'), 10);
const FILL_BOTS = Math.max(0, Math.min(3, parseInt(arg('bots', '3'), 10)));
const TARGET = Math.max(1, parseInt(arg('target', '3'), 10));

/* ------------------------------------------------------------ the engine */
['utils', 'pixel', 'audio', 'particles', 'gore', 'weapons', 'entities',
 'levels', 'versusmaps', 'game', 'navgraph', 'bots', 'match']
  .forEach(f => require(path.join(ROOT, 'js', f + '.js')));
globalThis.Sound.setEnabled(false);          /* nobody is listening here */

/* ------------------------------------------------------------ static files */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function serve(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ------------------------------------------------- minimal websocket server */
function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(payload) {
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
  head[0] = 0x81;                                    /* FIN + text */
  return Buffer.concat([head, data]);
}

/* Pulls whole frames out of a growing buffer. */
function decode(state, chunk, onText, onClose) {
  state.buf = state.buf ? Buffer.concat([state.buf, chunk]) : chunk;
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return;
    const mask = masked ? b.slice(off, off + 4) : null;
    const payload = b.slice(off + maskLen, off + maskLen + len);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    state.buf = b.slice(off + maskLen + len);
    if (opcode === 0x8) { onClose(); return; }
    if (opcode === 0x1) onText(payload.toString('utf8'));
    /* ping/pong and continuations are ignored: this protocol only sends text */
  }
}

/* ------------------------------------------------------------------ room */
const clients = new Map();          /* socket -> { id, slot, name, input } */
let nextId = 1;

const NO = () => false;
function makeInput() {
  const st = { l: false, r: false, j: false, je: false, ip: false, ih: false, f: false, fh: false, dr: false };
  return {
    st: st,
    left: () => st.l, right: () => st.r, jump: () => st.j, jumpPressed: () => st.je,
    interactPressed: () => st.ip, interactHeld: () => st.ih,
    firePressed: () => st.f, fireHeld: () => st.fh, dropPressed: () => st.dr,
    pressed: NO, mouse: { down: false, pressed: false }
  };
}

const slots = [];                   /* 4 fixed slots */
for (let i = 0; i < 4; i++) {
  slots.push({ index: i, taken: false, client: null, input: makeInput(), name: 'P' + (i + 1) });
}

let match = null;
let world = null;
let roundOverAt = 0;

function humanSlotCount() { return slots.filter(s => s.taken).length; }

function buildMatch() {
  const defs = [];
  for (let i = 0; i < 4; i++) {
    const s = slots[i];
    if (s.taken) defs.push({ name: s.name, isBot: false, wins: 0 });
    else {
      const key = globalThis.PERSONALITY_ORDER[i % globalThis.PERSONALITY_ORDER.length];
      defs.push({ name: globalThis.PERSONALITIES[key].name, isBot: true, personality: key, wins: 0 });
    }
  }
  match = new globalThis.Match({ target: TARGET, slots: defs, rotation: [0, 1, 2] });
}

function startRound() {
  world = new globalThis.World(match.mapIndex(), {
    toast() {},
    roundWin(p) { roundOverAt = Date.now() + 3200; }
  }, {
    mode: 'versus',
    levels: globalThis.VERSUS_MAPS,
    players: match.playerDefs(),
    localIndex: 0,
    goreLevel: 1
  });
  broadcast({ t: 'round', map: match.mapIndex(), name: match.mapName(),
              round: match.roundIndex + 1, target: match.target,
              slots: match.slots.map((s, i) => ({ i, name: s.name, bot: s.isBot, wins: s.wins })) });
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const [sock] of clients) {
    try { sock.write(frame(text)); } catch (e) { /* dropping client */ }
  }
}

function snapshot() {
  const w = world;
  return {
    t: 's',
    e: +w.elapsed.toFixed(2),
    over: !!w.roundOver,
    p: w.players.map(p => ({
      x: Math.round(p.x), y: Math.round(p.y),
      a: +p.angle.toFixed(2), f: p.facing,
      h: Math.round(p.health), d: p.dead ? 1 : 0, fin: p.finished ? 1 : 0,
      w: p.weapon ? p.weapon.key : null, am: p.weapon ? p.weapon.ammo : 0,
      wn: p.wins
    })),
    b: w.bullets.slice(0, 40).map(b => ({ x: Math.round(b.x), y: Math.round(b.y),
                                          vx: Math.round(b.vx), vy: Math.round(b.vy), k: b.def.short })),
    ev: w.elevators.map(e => ({ x: Math.round(e.x), y: Math.round(e.y) })),
    dz: w.doors.map(d => ({ x: Math.round(d.x), y: Math.round(d.y) })),
    hz: w.hazards.map(h => ({ x: Math.round(h.x), y: Math.round(h.y) })),
    gl: w.glass.map(g => (g.broken ? 1 : 0)),
    cr: w.crates.map(c => (c.broken ? 1 : 0)),
    pk: w.pickups.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), k: p.key }))
  };
}

/* ------------------------------------------------------------------ loop */
const STEP = 1 / 120;
const SNAP_EVERY = 1 / 30;
let acc = 0, snapAcc = 0, last = Date.now();

function tick() {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;

  if (world) {
    acc += dt;
    let guard = 0;
    while (acc >= STEP && guard++ < 16) {
      const inputs = slots.map(s => (s.taken ? s.input : null));
      world.update(STEP, inputs);
      for (const s of slots) { s.input.st.je = false; s.input.st.ip = false; s.input.st.f = false; s.input.st.dr = false; }
      acc -= STEP;
    }

    snapAcc += dt;
    if (snapAcc >= SNAP_EVERY) {
      snapAcc = 0;
      broadcast(snapshot());
    }

    if (world.roundOver && roundOverAt && now > roundOverAt) {
      roundOverAt = 0;
      const winner = world.roundWinner ? world.roundWinner.index : -1;
      match.recordRound(winner, world);
      const champ = match.champion();
      if (champ >= 0) {
        broadcast({ t: 'match', champion: champ,
                    slots: match.slots.map((s, i) => ({ i, name: s.name, wins: s.wins })) });
        setTimeout(() => { buildMatch(); startRound(); }, 6000);
        world = null;
      } else {
        startRound();
      }
    }
  }
  setTimeout(tick, 8);
}

/* ------------------------------------------------------------------ boot */
const server = http.createServer(serve);

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const free = slots.find(s => !s.taken);
  if (!free) {
    socket.write(frame(JSON.stringify({ t: 'full' })));
    socket.end();
    return;
  }
  free.taken = true;
  free.client = socket;
  const me = { id: nextId++, slot: free.index };
  clients.set(socket, me);
  console.log(`player joined slot ${free.index + 1} (${humanSlotCount()} human${humanSlotCount() === 1 ? '' : 's'})`);

  buildMatch();
  startRound();
  socket.write(frame(JSON.stringify({ t: 'hello', slot: free.index, target: TARGET })));

  const state = {};
  socket.on('data', chunk => decode(state, chunk,
    text => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg.t === 'i') {
        const st = free.input.st;
        st.l = !!msg.l; st.r = !!msg.r; st.j = !!msg.j; st.ih = !!msg.ih; st.fh = !!msg.fh;
        if (msg.je) st.je = true;
        if (msg.ip) st.ip = true;
        if (msg.f) st.f = true;
        if (msg.dr) st.dr = true;
      } else if (msg.t === 'name' && typeof msg.name === 'string') {
        free.name = msg.name.slice(0, 10).toUpperCase();
      }
    },
    () => close()
  ));

  function close() {
    if (!clients.has(socket)) return;
    clients.delete(socket);
    free.taken = false;
    free.client = null;
    console.log(`player left slot ${free.index + 1}`);
    try { socket.destroy(); } catch (e) { /* already gone */ }
    if (humanSlotCount() === 0) { world = null; match = null; }
    else { buildMatch(); startRound(); }
  }
  socket.on('close', close);
  socket.on('error', close);
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) addrs.push(n.address);
    }
  }
  console.log('\n  GETAWAY DAUN - LAN host');
  console.log('  ----------------------------------------');
  console.log(`  this machine : http://localhost:${PORT}`);
  addrs.forEach(a => console.log(`  other players: http://${a}:${PORT}`));
  console.log(`  slots        : 4 (empty ones are filled with bots)`);
  console.log(`  first to     : ${TARGET} round wins`);
  console.log('  ----------------------------------------\n');
  void FILL_BOTS;
  tick();
});
