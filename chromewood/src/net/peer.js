/* ============================================================
   peer.js - co-op with no server to run

   The relay in server/ works, but a static host cannot run it,
   and a page served over https cannot open a ws:// socket to
   somebody's laptop either. So the browsers talk to each other
   directly over WebRTC and nothing in the middle holds the game.

   The shape is the same as it always was: one player hosts and
   owns the simulation, everyone else mirrors it. Here the host's
   browser is also the hub - every joiner opens one data channel
   to the host and nothing else, which is exactly the traffic the
   game already had, and it means this file does the small amount
   of room bookkeeping that server.js used to do.

   Two peers still have to be introduced before they can speak.
   That is all a signalling broker does: it forwards a handful of
   offer/answer/candidate messages by destination id and then has
   no further part in the game. We use the public PeerJS broker,
   whose protocol is small enough to speak directly rather than
   pulling in a bundled library.

   This file deliberately mirrors RoomClient's interface, so
   main.js does not care which transport it was handed.
   ============================================================ */

import { Emitter, Ring } from '../core/util.js';
import { PROTOCOL_VERSION } from './protocol.js';

/* Public STUN only. Without a TURN relay a small number of strict
   networks - symmetric NAT, some corporate firewalls - cannot open
   a direct path at all, and there is no free TURN worth depending
   on. When that happens the connection fails honestly and the menu
   says to use a relay instead. */
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

/* The public PeerJS broker. ?broker=host:port points this at your
   own PeerServer instead - useful if the public one is down, or
   blocked, or you would simply rather not depend on it. */
const DEFAULT_BROKER = { host: '0.peerjs.com', port: 443, path: '/', key: 'peerjs', secure: true };

export function brokerConfig() {
  const raw = ((typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('broker')) || '').trim();
  if (!raw) return DEFAULT_BROKER;

  /* Accept "host", "host:port", "ws://host:port" and a trailing path. */
  const scheme = /^wss:\/\//i.test(raw) ? 'wss'
    : /^ws:\/\//i.test(raw) ? 'ws' : '';
  const rest = raw.replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const pathPart = slash < 0 ? '' : rest.slice(slash);
  const [host, portStr] = authority.split(':');
  const port = portStr ? Number(portStr) : 0;

  /* An explicit scheme wins; then the port; then match the page,
     because a https page cannot open a plain ws:// socket anyway. */
  const secure = scheme ? scheme === 'wss'
    : port ? port === 443
      : (typeof location !== 'undefined' && location.protocol === 'https:');

  return {
    host: host || DEFAULT_BROKER.host,
    port: port || (secure ? 443 : 80),
    path: pathPart ? pathPart + '/' : '/',
    key: 'peerjs',
    secure,
  };
}

/* The reference client heartbeats every five seconds; the broker
   drops sockets that go quiet, and a host sits in a lobby waiting. */
const HEARTBEAT_MS = 5000;
const CLIENT_VERSION = '1.5.5';

/* No 0/O, 1/I/L: a room code gets read aloud down a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 5;
const MAX_PLAYERS = 4;

function makeCode() {
  let s = '';
  const r = new Uint32Array(CODE_LEN);
  crypto.getRandomValues(r);
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}

/* The broker's namespace is shared with every other PeerJS user on
   the internet, so the room code alone would collide constantly. */
export function brokerIdForRoom(code) { return `chromewood-room-${code}`; }

function randomId(prefix) {
  const r = new Uint32Array(3);
  crypto.getRandomValues(r);
  return prefix + Array.from(r, n => n.toString(36)).join('');
}

/* ------------------------------------------------- the broker */
/* A thin client for the PeerJS signalling server. It knows how to
   register an id and pass messages to another id; it never sees
   any game traffic. */
class Broker extends Emitter {
  constructor(id) {
    super();
    this.id = id;
    this.ws = null;
    this.open = false;
    this._beat = null;
  }

  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const token = randomId('t');
      const cfg = brokerConfig();
      const scheme = cfg.secure ? 'wss://' : 'ws://';
      const url = `${scheme}${cfg.host}:${cfg.port}${cfg.path}peerjs?`
        + `key=${cfg.key}&id=${encodeURIComponent(this.id)}&token=${token}`
        + `&version=${CLIENT_VERSION}`;
      let ws;
      try { ws = new WebSocket(url); }
      catch (e) { reject(new Error('Could not reach the matchmaking service.')); return; }
      this.ws = ws;

      const timer = setTimeout(() => {
        if (!this.open) {
          try { ws.close(); } catch (e) { /* already gone */ }
          reject(new Error('The matchmaking service did not answer.'));
        }
      }, timeoutMs);

      ws.onopen = () => { /* the server speaks first, with OPEN */ };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        switch (msg.type) {
          case 'OPEN':
            clearTimeout(timer);
            this.open = true;
            this._startBeat();
            resolve();
            break;
          case 'ID-TAKEN':
            clearTimeout(timer);
            reject(Object.assign(new Error('That room code is already in use.'), { taken: true }));
            break;
          case 'ERROR':
            clearTimeout(timer);
            reject(new Error((msg.payload && msg.payload.msg) || 'The matchmaking service refused.'));
            break;
          /* The other end is not connected - a wrong or stale code. */
          case 'EXPIRE':
          case 'LEAVE':
            this.emit('unreachable', { id: msg.src || msg.dst });
            break;
          case 'OFFER':
          case 'ANSWER':
          case 'CANDIDATE':
            this.emit('signal', { kind: msg.type, from: msg.src, payload: msg.payload });
            break;
          default: break;
        }
      };

      ws.onclose = () => {
        clearTimeout(timer);
        const wasOpen = this.open;
        this.open = false;
        this._stopBeat();
        this.emit('close', { wasOpen });
        if (!wasOpen) reject(new Error('The matchmaking service closed the connection.'));
      };
      ws.onerror = () => { /* onclose carries the outcome */ };
    });
  }

  send(kind, dst, payload) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ type: kind, dst, payload }));
    return true;
  }

  _startBeat() {
    this._stopBeat();
    /* The broker drops idle sockets. Joiners need it alive only for
       the handshake, but a host waits in the lobby indefinitely. */
    this._beat = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }, HEARTBEAT_MS);
  }

  _stopBeat() { if (this._beat) clearInterval(this._beat); this._beat = null; }

  close() {
    this._stopBeat();
    this.open = false;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } }
  }
}

/* --------------------------------------------- one connection */
/* A single RTCPeerConnection and its data channel, wrapped so the
   rest of the file can treat it as "a thing you send objects to". */
class Link extends Emitter {
  constructor(broker, remoteBrokerId, initiator) {
    super();
    this.broker = broker;
    this.remote = remoteBrokerId;
    this.initiator = initiator;
    this.pc = new RTCPeerConnection(ICE);
    this.channel = null;
    this.ready = false;
    this.closed = false;
    /* Candidates can arrive before the description they belong to. */
    this._pending = [];

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.broker.send('CANDIDATE', this.remote, { candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') this._die(s);
    };

    if (initiator) {
      this._bind(this.pc.createDataChannel('chromewood', { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this._bind(e.channel);
    }
  }

  _bind(ch) {
    this.channel = ch;
    ch.onopen = () => { this.ready = true; this.emit('open'); };
    ch.onclose = () => this._die('closed');
    ch.onmessage = (e) => {
      let obj;
      try { obj = JSON.parse(e.data); } catch (err) { return; }
      this.emit('data', obj);
    };
  }

  _die(why) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.emit('closed', { why });
  }

  async start() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.broker.send('OFFER', this.remote, { sdp: this.pc.localDescription });
  }

  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription(sdp);
    await this._drain();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.broker.send('ANSWER', this.remote, { sdp: this.pc.localDescription });
  }

  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription(sdp);
    await this._drain();
  }

  async addCandidate(c) {
    if (!this.pc.remoteDescription) { this._pending.push(c); return; }
    try { await this.pc.addIceCandidate(c); } catch (e) { /* a late candidate is not fatal */ }
  }

  async _drain() {
    const list = this._pending.splice(0);
    for (const c of list) {
      try { await this.pc.addIceCandidate(c); } catch (e) { /* as above */ }
    }
  }

  send(obj) {
    if (!this.ready || this.channel.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(obj));
    return true;
  }

  close() {
    this.closed = true;
    this.ready = false;
    try { if (this.channel) this.channel.close(); } catch (e) { /* already gone */ }
    try { this.pc.close(); } catch (e) { /* already gone */ }
  }
}

/* ------------------------------------------------- the façade */
export class PeerNet extends Emitter {
  constructor() {
    super();
    this.id = null;
    this.isHost = false;
    this.room = null;
    this.peers = new Map();       /* id -> { id, name } */
    this.ping = 0;
    this.pings = new Ring(20);
    this.state = 'idle';
    this.lastError = null;
    this.transport = 'p2p';

    this.broker = null;
    this.links = new Map();       /* player id -> Link */
    this._linkByBroker = new Map();
    this._nextId = 1;
    this._pingTimer = null;
    this._sentAt = new Map();
    this._seq = 1;
    this._hostLink = null;
    this._hostId = null;
    this._seed = '';
    this._difficulty = 1;
    this._name = 'RUNNER';
  }

  connect(opts) {
    this._name = opts.name || 'RUNNER';
    this._seed = opts.seed || '';
    this._difficulty = opts.difficulty || 1;
    return opts.host ? this._host(opts) : this._join(opts);
  }

  /* ------------------------------------------------ hosting */
  async _host(opts) {
    this.state = 'connecting';
    this.isHost = true;
    this.id = this._nextId++;
    this._hostId = this.id;

    /* Claim a code. A collision on the shared broker namespace is
       unlikely but cheap to retry around. */
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = (attempt === 0 && opts.room ? String(opts.room).toUpperCase() : makeCode());
      const broker = new Broker(brokerIdForRoom(code));
      try {
        await broker.connect();
        this.broker = broker;
        this.room = code;
        break;
      } catch (e) {
        broker.close();
        lastErr = e;
        if (!e.taken) break;     /* not a collision: stop retrying */
      }
    }
    if (!this.broker) {
      this.state = 'closed';
      throw lastErr || new Error('Could not open a room.');
    }

    this.broker.on('signal', (s) => this._onHostSignal(s));
    this.broker.on('close', ({ wasOpen }) => {
      /* Losing the broker does not end a game in progress: it was
         only ever the introduction. Nobody new can join, though. */
      if (wasOpen) this.emit('brokerlost', {});
    });

    this.state = 'open';
    this._startPing();
    const welcome = {
      t: 'welcome', id: this.id, host: true, room: this.room,
      peers: [], seed: this._seed, difficulty: this._difficulty, hostId: this.id,
    };
    this.emit('welcome', welcome);
    return welcome;
  }

  async _onHostSignal({ kind, from, payload }) {
    let link = this._linkByBroker.get(from);

    if (kind === 'OFFER') {
      if (this.peers.size + 1 >= MAX_PLAYERS) return;       /* room full */
      if (link) link.close();
      link = new Link(this.broker, from, false);
      this._linkByBroker.set(from, link);
      link.on('data', (obj) => this._onHostData(link, obj));
      link.on('closed', () => this._dropLink(link));
      try { await link.acceptOffer(payload.sdp); }
      catch (e) { this._dropLink(link); }
      return;
    }
    if (!link) return;
    if (kind === 'ANSWER') { try { await link.acceptAnswer(payload.sdp); } catch (e) { /* stale */ } }
    else if (kind === 'CANDIDATE') link.addCandidate(payload.candidate);
  }

  /* The host performs the room bookkeeping the relay used to do. */
  _onHostData(link, msg) {
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) {
        link.send({ t: 'err', msg: 'That player is running a different version of the game.' });
        setTimeout(() => link.close(), 400);
        return;
      }
      const id = this._nextId++;
      link.playerId = id;
      const name = String(msg.name || 'RUNNER').slice(0, 12);
      this.links.set(id, link);

      const others = [...this.peers.values()].map(p => ({ id: p.id, name: p.name }));
      others.push({ id: this.id, name: this._name });
      link.send({
        t: 'welcome', id, host: false, room: this.room, peers: others,
        seed: this._seed, difficulty: this._difficulty, hostId: this.id,
      });

      this.peers.set(id, { id, name });
      /* Tell everyone already here, and tell us. */
      for (const [otherId, other] of this.links) {
        if (otherId !== id) other.send({ t: 'peer', id, name });
      }
      this.emit('peer', { t: 'peer', id, name });
      return;
    }

    if (!link.playerId) return;                  /* not through the door yet */

    if (msg.t === 'ping') { link.send({ t: 'pong', n: msg.n }); return; }
    if (msg.t === 'pong') { this._notePong(msg.n); return; }

    if (msg.t === 'msg') {
      const out = { t: 'msg', from: link.playerId, d: msg.d };
      if (msg.to === 'all' || msg.to === undefined) {
        /* "Everyone else", which includes us. */
        for (const [otherId, other] of this.links) {
          if (otherId !== link.playerId) other.send(out);
        }
        this.emit('msg', out);
      } else if (msg.to === this.id) {
        this.emit('msg', out);
      } else {
        const target = this.links.get(msg.to);
        if (target) target.send(out);
      }
    }
  }

  _dropLink(link) {
    this._linkByBroker.delete(link.remote);
    const id = link.playerId;
    link.close();
    if (id === undefined) return;
    this.links.delete(id);
    this.peers.delete(id);
    for (const other of this.links.values()) other.send({ t: 'gone', id });
    this.emit('gone', { t: 'gone', id });
  }

  /* ------------------------------------------------- joining */
  async _join(opts) {
    const code = String(opts.room || '').trim().toUpperCase();
    if (code.length !== CODE_LEN) {
      throw new Error(`A room code is ${CODE_LEN} letters. Ask the host for theirs.`);
    }
    this.state = 'connecting';
    this.isHost = false;

    const broker = new Broker(randomId('chromewood-p-'));
    await broker.connect();
    this.broker = broker;

    const hostBrokerId = brokerIdForRoom(code);
    const link = new Link(broker, hostBrokerId, true);
    this._hostLink = link;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        this.state = 'closed';
        link.close();
        broker.close();
        reject(new Error(msg));
      };

      /* The broker says EXPIRE when nobody is listening on that id,
         which is what a wrong code looks like from here. */
      broker.on('unreachable', () => fail(`No run is being hosted under ${code}.`));

      const giveUp = setTimeout(() => {
        fail(link.pc.connectionState === 'connected'
          ? 'Joined, but the host never answered.'
          : `Could not reach the host of ${code}. If either of you is on a `
            + 'restricted network, a direct connection may be blocked.');
      }, 20000);

      broker.on('signal', async ({ kind, payload }) => {
        try {
          if (kind === 'ANSWER') await link.acceptAnswer(payload.sdp);
          else if (kind === 'CANDIDATE') await link.addCandidate(payload.candidate);
        } catch (e) { /* a stale signal is not fatal */ }
      });

      link.on('open', () => {
        link.send({
          t: 'hello', v: PROTOCOL_VERSION, name: this._name,
          seed: this._seed, difficulty: this._difficulty,
        });
      });

      link.on('closed', () => {
        clearTimeout(giveUp);
        if (settled) {
          const wasOpen = this.state === 'open';
          this.state = 'closed';
          this._stopPing();
          this.emit('close', { wasOpen });
        } else {
          fail('The connection to the host dropped before the run started.');
        }
      });

      link.on('data', (msg) => {
        if (msg.t === 'welcome') {
          clearTimeout(giveUp);
          settled = true;
          this.state = 'open';
          this.id = msg.id;
          this.room = msg.room;
          this._hostId = msg.hostId;
          this.peers.clear();
          for (const p of msg.peers) this.peers.set(p.id, p);
          this._startPing();
          this.emit('welcome', msg);
          resolve(msg);
          return;
        }
        if (msg.t === 'err') { this.lastError = msg.msg; fail(msg.msg); return; }
        if (msg.t === 'ping') { link.send({ t: 'pong', n: msg.n }); return; }
        if (msg.t === 'pong') { this._notePong(msg.n); return; }
        if (msg.t === 'peer') { this.peers.set(msg.id, { id: msg.id, name: msg.name }); this.emit('peer', msg); return; }
        if (msg.t === 'gone') { this.peers.delete(msg.id); this.emit('gone', msg); return; }
        if (msg.t === 'msg') { this.emit('msg', msg); return; }
      });

      link.start().catch(() => fail('Could not start a connection to the host.'));
    });
  }

  /* --------------------------------------------------- common */
  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.state !== 'open') return;
      const n = this._seq++;
      this._sentAt.set(n, performance.now());
      if (this._sentAt.size > 30) this._sentAt.delete(this._sentAt.keys().next().value);
      if (this.isHost) { for (const l of this.links.values()) l.send({ t: 'ping', n }); }
      else if (this._hostLink) this._hostLink.send({ t: 'ping', n });
    }, 2000);
  }

  _stopPing() { if (this._pingTimer) clearInterval(this._pingTimer); this._pingTimer = null; }

  _notePong(n) {
    const sent = this._sentAt.get(n);
    if (!sent) return;
    this.ping = performance.now() - sent;
    this.pings.push(this.ping);
    this._sentAt.delete(n);
  }

  /* `to` is a player id, or 'all' for everyone else. */
  sendTo(to, data) {
    if (this.state !== 'open') return false;
    if (this.isHost) {
      const out = { t: 'msg', from: this.id, d: data };
      if (to === 'all' || to === undefined) {
        let any = false;
        for (const l of this.links.values()) any = l.send(out) || any;
        return any;
      }
      const target = this.links.get(to);
      return target ? target.send(out) : false;
    }
    /* A joiner has exactly one pipe, and the host routes onward. */
    return this._hostLink ? this._hostLink.send({ t: 'msg', to, d: data }) : false;
  }

  get averagePing() {
    const arr = this.pings.toArray();
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  close() {
    this._stopPing();
    for (const l of this.links.values()) l.close();
    this.links.clear();
    this._linkByBroker.clear();
    if (this._hostLink) { this._hostLink.close(); this._hostLink = null; }
    if (this.broker) { this.broker.close(); this.broker = null; }
    this.state = 'closed';
  }
}

/* WebRTC data channels are everywhere a WebGL2 game could run, but
   check rather than throwing a ReferenceError at the player. */
export function peerSupported() {
  return typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function';
}
