/* ============================================================
   menus.js - screens

   The HUD is canvas because it changes every frame; menus are DOM
   because they are text, they need scrolling and focus, and they
   should be readable by a screen reader. Every screen is built
   once and shown or hidden.
   ============================================================ */


import { drawText, textWidth } from './font.js';

/* The title is drawn with the game's own bitmap font rather than
   set in a web font, so the menu and the HUD are visibly the same
   piece of software. */
function titleCanvas(text, scale, color) {
  const c = document.createElement('canvas');
  const w = textWidth(text, scale) + scale * 4;
  c.width = w; c.height = 7 * scale + scale * 4;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  drawText(g, text, scale * 2, scale * 2, { scale, color, shadow: '#2a1b46', shadowOffset: 2 });
  c.style.width = w + 'px';
  c.style.imageRendering = 'pixelated';
  c.className = 'title-canvas';
  return c;
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class Menus {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.screens = {};
    this.current = null;
    this._buildMain();
    this._buildPause();
    this._buildOver();
    this._buildSettings();
    this._buildChat();
    this._buildNetStat();
  }

  _screen(id, cls = '') {
    const s = el('div', `screen ${cls}`);
    s.id = 'screen-' + id;
    this.root.appendChild(s);
    this.screens[id] = s;
    return s;
  }

  open(id) {
    for (const k of Object.keys(this.screens)) this.screens[k].classList.remove('open');
    if (id) {
      this.screens[id].classList.add('open');
      const first = this.screens[id].querySelector('button, input');
      if (first && id !== 'skills') setTimeout(() => first.focus(), 20);
    }
    this.current = id || null;
  }

  close() { this.open(null); }
  get isOpen() { return this.current !== null; }

  /* ------------------------------------------------------ main menu */
  _buildMain() {
    const s = this._screen('main');
    const card = el('div', 'card');
    card.innerHTML = `
      <div id="title-slot"></div>
      <p class="subtitle">ARCANE MACHINE SURVIVAL</p>
      <p>You wake on a shore with nothing, and a dead beacon inland. Cut wood,
         break stone, make a fire before dark. Repair the beacon and it wakes
         the core in your chest. Then start closing the rift gates, one at a
         time, while the nights get worse.</p>
      <p class="warnline">Everything you do is heard. The louder you work, the
         better the night knows where to look.</p>
      <label class="field"><span>RUNNER NAME</span>
        <input id="in-name" type="text" maxlength="12" value="RUNNER" autocomplete="off" spellcheck="false"></label>
      <div class="row2">
        <label class="field"><span>WORLD SEED</span>
          <input id="in-seed" type="text" maxlength="14" value="MOSSGATE" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>DIFFICULTY</span>
          <select id="in-diff">
            <option value="0.8">WANDERER</option>
            <option value="1" selected>RUNNER</option>
            <option value="1.35">SCAVENGER</option>
            <option value="1.8">RIFTBORN</option>
          </select></label>
      </div>
      <div class="err" id="main-err"></div>
      <button class="primary" id="btn-solo">SOLO RUN <span class="hint">one against the night</span></button>
      <button id="btn-host">HOST CO-OP <span class="hint">up to four</span></button>
      <div class="row2">
        <label class="field" style="margin:0"><span>JOIN CODE</span>
          <input id="in-room" type="text" maxlength="10" placeholder="CODE" autocomplete="off" spellcheck="false"></label>
        <label class="field" style="margin:0"><span>SERVER</span>
          <input id="in-server" type="text" placeholder="AUTO" autocomplete="off" spellcheck="false"></label>
      </div>
      <button id="btn-join" style="margin-top:10px">JOIN A RUN</button>
      <p class="note">Co-op needs somebody to run the relay
        (<code>node server/server.js</code>, one file, no dependencies). Leave
        SERVER on AUTO when the game is served from that same machine;
        otherwise type the host's address, like <code>192.168.1.20:8090</code>.
        A solo run needs nothing at all.</p>
      <button class="ghost" id="btn-settings-main">SETTINGS</button>
      <h3>CONTROLS</h3>
      <table class="keys">
        <tr><td><span class="keycap">W</span><span class="keycap">A</span><span class="keycap">S</span><span class="keycap">D</span> · <span class="keycap">SHIFT</span></td><td>move · sprint</td></tr>
        <tr><td><span class="keycap">LMB</span></td><td>swing, mine, chop, build</td></tr>
        <tr><td><span class="keycap">1</span>–<span class="keycap">6</span></td><td>hotbar</td></tr>
        <tr><td><span class="keycap">TAB</span></td><td>pack and crafting</td></tr>
        <tr><td><span class="keycap">B</span></td><td>build menu &nbsp; <span class="keycap">RMB</span> cancel</td></tr>
        <tr><td><span class="keycap">G</span></td><td>use, deliver, revive an ally</td></tr>
        <tr><td><span class="keycap">Q</span></td><td>eat the best thing you have</td></tr>
        <tr><td><span class="keycap">SPACE</span></td><td>dash &nbsp; <span class="keycap">E</span><span class="keycap">R</span><span class="keycap">F</span> abilities</td></tr>
        <tr><td><span class="keycap">K</span> · <span class="keycap">J</span></td><td>core · log</td></tr>
        <tr><td><span class="keycap">ENTER</span></td><td>chat &nbsp; <span class="keycap">ESC</span> pause</td></tr>
      </table>`;
    const slot = card.querySelector('#title-slot');
    if (slot) slot.appendChild(titleCanvas('CHROMEWOOD', 8, '#efe6ff'));
    s.appendChild(card);

    card.querySelector('#btn-solo').onclick = () => this.hooks.startSolo(this.readForm());
    card.querySelector('#btn-host').onclick = () => this.hooks.startHost(this.readForm());
    card.querySelector('#btn-join').onclick = () => this.hooks.startJoin(this.readForm());
    card.querySelector('#btn-settings-main').onclick = () => this.open('settings');
    /* Remember the name between runs; nobody wants to retype it. */
    const nameIn = card.querySelector('#in-name');
    try {
      const saved = localStorage.getItem('chromewood.name');
      if (saved) nameIn.value = saved;
    } catch (e) { /* private mode */ }
    nameIn.addEventListener('change', () => {
      try { localStorage.setItem('chromewood.name', nameIn.value); } catch (e) { /* ignore */ }
    });
  }

  readForm() {
    const q = (id) => this.screens.main.querySelector(id);
    return {
      name: (q('#in-name').value || 'RUNNER').toUpperCase().slice(0, 12),
      seed: (q('#in-seed').value || 'MOSSGATE').toUpperCase().trim(),
      room: (q('#in-room').value || '').toUpperCase().trim(),
      server: (q('#in-server').value || '').trim(),
      difficulty: Number(q('#in-diff').value) || 1,
    };
  }

  setError(msg) {
    const e = this.screens.main.querySelector('#main-err');
    if (e) e.textContent = msg || '';
  }

  /* ---------------------------------------------------------- pause */
  _buildPause() {
    const s = this._screen('pause');
    const card = el('div', 'card');
    card.innerHTML = `
      <h2>PAUSED</h2>
      <p id="pause-info" class="muted"></p>
      <button class="primary" id="btn-resume">RESUME</button>
      <button id="btn-pause-settings">SETTINGS</button>
      <button id="btn-quit">ABANDON RUN</button>`;
    s.appendChild(card);
    card.querySelector('#btn-resume').onclick = () => this.hooks.resume();
    card.querySelector('#btn-pause-settings').onclick = () => this.open('settings');
    card.querySelector('#btn-quit').onclick = () => this.hooks.quit();
    this.pauseInfo = card.querySelector('#pause-info');
  }

  setPauseInfo(text) { if (this.pauseInfo) this.pauseInfo.textContent = text; }

  /* ------------------------------------------------------- game over */
  _buildOver() {
    const s = this._screen('over');
    const card = el('div', 'card');
    card.innerHTML = `<h2 id="over-title">THE BEACON IS DARK</h2>
      <div id="over-body"></div>
      <button class="primary" id="btn-again">RUN AGAIN</button>
      <button id="btn-over-menu">MAIN MENU</button>`;
    s.appendChild(card);
    card.querySelector('#btn-again').onclick = () => this.hooks.restart();
    card.querySelector('#btn-over-menu').onclick = () => this.hooks.quit();
    this.overTitle = card.querySelector('#over-title');
    this.overBody = card.querySelector('#over-body');
  }

  showOver(sim, localId, won) {
    const me = sim.players.get(localId);
    this.overTitle.textContent = won ? 'THE RIFT IS QUIET' : 'THE BEACON IS DARK';
    const rows = [...sim.players.values()].map(p =>
      `<tr><td>${p.name}${p.id === localId ? ' (you)' : ''}</td><td>lv ${p.level} · ${p.kills} kills · ${p.deaths} deaths</td></tr>`).join('');
    this.overBody.innerHTML = `
      <p>${won
        ? 'Every gate sealed and the Heart with them. The wood is only a wood again.'
        : `You held for <b style="color:#fff">${sim.night}</b> night${sim.night === 1 ? '' : 's'}. ` +
          (sim.night < 3 ? 'The rift barely noticed.'
            : sim.night < 6 ? 'Long enough to be remembered.'
            : 'Long enough that something out there learned your name.')}</p>
      <table class="keys">${rows}
        <tr><td>gates sealed</td><td>${sim.stats.gatesSealed} of ${sim.gates.length}</td></tr>
        <tr><td>built</td><td>${sim.buildings.length} pieces</td></tr>
        <tr><td>damage dealt</td><td>${me ? Math.round(me.damageDealt).toLocaleString() : 0}</td></tr>
      </table>`;
    this.open('over');
  }

  /* --------------------------------------------------------- settings */
  _buildSettings() {
    const s = this._screen('settings');
    const card = el('div', 'card');
    card.innerHTML = `
      <h2>SETTINGS</h2>
      <label class="field"><span>PIXEL SIZE — <b id="v-px">3</b></span>
        <input type="range" id="s-px" min="1" max="6" step="1" value="3"></label>
      <label class="field"><span>ZOOM — <b id="v-zoom">9.5</b></span>
        <input type="range" id="s-zoom" min="6" max="20" step="0.5" value="9.5"></label>
      <label class="field"><span>VOLUME — <b id="v-vol">70</b></span>
        <input type="range" id="s-vol" min="0" max="100" step="5" value="70"></label>
      <h3>EFFECTS</h3>
      <button id="s-outline" class="row">OUTLINES: ON</button>
      <button id="s-bloom" class="row">BLOOM: ON</button>
      <button id="s-dither" class="row">DITHER: ON</button>
      <button id="s-shadows" class="row">SHADOWS: ON</button>
      <button class="primary" id="btn-set-close" style="margin-top:16px">BACK</button>`;
    s.appendChild(card);
    const q = (id) => card.querySelector(id);
    q('#btn-set-close').onclick = () => this.hooks.settingsBack();
    q('#s-px').oninput = (e) => { q('#v-px').textContent = e.target.value; this.hooks.setPixelScale(+e.target.value); };
    q('#s-zoom').oninput = (e) => { q('#v-zoom').textContent = e.target.value; this.hooks.setZoom(+e.target.value); };
    q('#s-vol').oninput = (e) => { q('#v-vol').textContent = e.target.value; this.hooks.setVolume(+e.target.value / 100); };
    const toggle = (id, key, label) => {
      q(id).onclick = () => {
        const on = this.hooks.toggleEffect(key);
        q(id).textContent = `${label}: ${on ? 'ON' : 'OFF'}`;
      };
    };
    toggle('#s-outline', 'outline', 'OUTLINES');
    toggle('#s-bloom', 'bloom', 'BLOOM');
    toggle('#s-dither', 'dither', 'DITHER');
    toggle('#s-shadows', 'shadows', 'SHADOWS');
  }

  /* -------------------------------------------------------------- chat */
  _buildChat() {
    const box = el('div');
    box.id = 'chat';
    box.innerHTML = '<div id="chat-log"></div><input id="chat-input" type="text" maxlength="90" placeholder="say something…">';
    this.root.appendChild(box);
    this.chatBox = box;
    this.chatLog = box.querySelector('#chat-log');
    this.chatInput = box.querySelector('#chat-input');
    this.chatLines = [];
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { this.hooks.sendChat(this.chatInput.value); this.closeChat(); }
      else if (e.key === 'Escape') this.closeChat();
    });
  }

  openChat() {
    this.chatBox.classList.add('typing');
    this.chatInput.value = '';
    this.chatInput.focus();
  }

  closeChat() {
    this.chatBox.classList.remove('typing');
    this.chatInput.blur();
  }

  get chatOpen() { return this.chatBox.classList.contains('typing'); }

  addChat(text, color = '#d7e4f5') {
    this.chatLines.push({ text, color, at: performance.now() });
    if (this.chatLines.length > 7) this.chatLines.shift();
    this.renderChat();
  }

  renderChat() {
    const now = performance.now();
    this.chatLines = this.chatLines.filter(l => now - l.at < 16000 || this.chatOpen);
    this.chatLog.innerHTML = this.chatLines
      .map(l => `<div class="line" style="color:${l.color}">${escapeHtml(l.text)}</div>`).join('');
  }

  /* ------------------------------------------------------ connection */
  _buildNetStat() {
    const n = el('div');
    n.id = 'netstat';
    this.root.appendChild(n);
    this.netStat = n;
  }

  setNetStat(html) { this.netStat.innerHTML = html || ''; }
}

/* Drawn with spans rather than block glyphs: the box-drawing
   characters fall back to tofu in some monospace fonts. */
function pips(level, max) {
  let out = '';
  for (let i = 0; i < max; i++) out += `<i class="pip${i < level ? ' on' : ''}"></i>`;
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
