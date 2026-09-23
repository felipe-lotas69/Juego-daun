/* ============================================================
   client.js - talking to the room server

   The server only ever moves messages between the people in a
   room. One of them is the host and owns the simulation; if the
   host leaves, the server promotes the next player and tells
   everyone, and the new host rebuilds a world from the same seed.
   ============================================================ */

import { Emitter, Ring } from '../core/util.js';
import { PROTOCOL_VERSION } from './protocol.js';

export function defaultServerUrl() {
  if (typeof location === 'undefined') return 'ws://localhost:8090/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  /* Served by the game's own node server? Then the relay is here.
     On a static host there is no relay, and the player supplies one. */
  const port = location.port ? ':' + location.port : '';
  return `${proto}//${location.hostname}${port}/ws`;
}

export function normalizeServerUrl(input) {
  if (!input) return defaultServerUrl();
  let s = input.trim();
  if (/^wss?:\/\//i.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s.replace(/^https:/i, 'wss:').replace(/\/$/, '') + '/ws';
  if (/^http:\/\//i.test(s)) return s.replace(/^http:/i, 'ws:').replace(/\/$/, '') + '/ws';
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:';
  return `${proto}//${s.replace(/\/$/, '')}/ws`;
}

export class RoomClient extends Emitter {
  constructor() {
    super();
    this.ws = null;
    this.id = null;
    this.isHost = false;
    this.room = null;
    this.peers = new Map();
    this.ping = 0;
    this.pings = new Ring(20);
    this.state = 'idle';       /* idle | connecting | open | closed  */
    this.lastError = null;
    this._pingTimer = null;
    this._sentAt = new Map();
    this._seq = 1;
  }

  connect(opts) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = normalizeServerUrl(opts.server); }
      catch (e) { reject(new Error('That server address does not look right.')); return; }

      this.state = 'connecting';
      let ws;
      try { ws = new WebSocket(url); }
      catch (e) { this.state = 'closed'; reject(new Error('Could not open ' + url)); return; }
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (this.state !== 'open') {
          try { ws.close(); } catch (e) { /* already gone */ }
          reject(new Error('No answer from ' + url + '. Is the server running?'));
        }
      }, 7000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          t: 'hello', v: PROTOCOL_VERSION,
          room: opts.room || '', name: opts.name || 'RUNNER',
          host: !!opts.host, seed: opts.seed || '', difficulty: opts.difficulty || 1,
        }));
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        switch (msg.t) {
          case 'welcome':
            clearTimeout(timeout);
            this.state = 'open';
            this.id = msg.id;
            this.isHost = msg.host;
            this.room = msg.room;
            this.peers.clear();
            for (const p of msg.peers) this.peers.set(p.id, p);
            this._startPing();
            this.emit('welcome', msg);
            resolve(msg);
            break;
          case 'peer':
            this.peers.set(msg.id, { id: msg.id, name: msg.name });
            this.emit('peer', msg);
            break;
          case 'gone':
            this.peers.delete(msg.id);
            this.emit('gone', msg);
            break;
          case 'hostchange':
            this.isHost = msg.id === this.id;
            this.emit('hostchange', msg);
            break;
          case 'msg':
            this.emit('msg', msg);
            break;
          case 'pong': {
            const sent = this._sentAt.get(msg.n);
            if (sent) {
              this.ping = performance.now() - sent;
              this.pings.push(this.ping);
              this._sentAt.delete(msg.n);
            }
            break;
          }
          case 'err':
            clearTimeout(timeout);
            this.lastError = msg.msg;
            this.emit('error', msg);
            if (this.state !== 'open') reject(new Error(msg.msg));
            break;
          default: break;
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        const wasOpen = this.state === 'open';
        this.state = 'closed';
        this._stopPing();
        this.emit('close', { wasOpen });
        if (!wasOpen) reject(new Error('The connection closed before the room was joined.'));
      };

      ws.onerror = () => { /* onclose carries the outcome */ };
    });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.state !== 'open') return;
      const n = this._seq++;
      this._sentAt.set(n, performance.now());
      /* Drop stale entries so a flaky link cannot grow this forever. */
      if (this._sentAt.size > 30) {
        const oldest = this._sentAt.keys().next().value;
        this._sentAt.delete(oldest);
      }
      this._send({ t: 'ping', n });
    }, 2000);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /* `to` is a peer id, or 'all' for everyone else in the room. */
  sendTo(to, data) {
    return this._send({ t: 'msg', to, d: data });
  }

  get averagePing() {
    const arr = this.pings.toArray();
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  close() {
    this._stopPing();
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } }
    this.state = 'closed';
  }
}
