/* ============================================================
   menus.js - screens

   The HUD is canvas because it changes every frame; menus are DOM
   because they are text, they need scrolling and focus, and they
   should be readable by a screen reader. Every screen is built
   once and shown or hidden.
   ============================================================ */

import { SKILLS, SKILL_BRANCHES, BEACON_UPGRADES } from '../game/defs.js';

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
    this._buildSkills();
    this._buildBeacon();
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
    if (id === 'skills') this.refreshSkills();
    if (id === 'beacon') this.refreshBeacon();
  }

  close() { this.open(null); }
  get isOpen() { return this.current !== null; }

  /* ------------------------------------------------------ main menu */
  _buildMain() {
    const s = this._screen('main');
    const card = el('div', 'card');
    card.innerHTML = `
      <h1 class="title">CHROMEWOOD</h1>
      <p class="subtitle">ARCANE MACHINE SURVIVAL</p>
      <p>The forest grew back through the machines, and something in the rift
         started sending things out at night. Hold the beacon, salvage what you
         can while it is light, and come back stronger.</p>
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
      <button class="ghost" id="btn-settings-main">SETTINGS</button>
      <h3>CONTROLS</h3>
      <table class="keys">
        <tr><td><span class="keycap">W</span><span class="keycap">A</span><span class="keycap">S</span><span class="keycap">D</span></td><td>move</td></tr>
        <tr><td>mouse / <span class="keycap">LMB</span></td><td>aim and fire</td></tr>
        <tr><td><span class="keycap">SPACE</span></td><td>dash (i-frames)</td></tr>
        <tr><td><span class="keycap">Q</span><span class="keycap">E</span><span class="keycap">R</span><span class="keycap">F</span></td><td>abilities</td></tr>
        <tr><td><span class="keycap">G</span></td><td>interact / revive an ally</td></tr>
        <tr><td><span class="keycap">TAB</span></td><td>skills</td></tr>
        <tr><td><span class="keycap">ENTER</span></td><td>chat &nbsp; <span class="keycap">ESC</span> pause</td></tr>
      </table>`;
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
      <button id="btn-pause-skills">SKILLS <span class="hint">TAB</span></button>
      <button id="btn-pause-settings">SETTINGS</button>
      <button id="btn-quit">ABANDON RUN</button>`;
    s.appendChild(card);
    card.querySelector('#btn-resume').onclick = () => this.hooks.resume();
    card.querySelector('#btn-pause-skills').onclick = () => this.open('skills');
    card.querySelector('#btn-pause-settings').onclick = () => this.open('settings');
    card.querySelector('#btn-quit').onclick = () => this.hooks.quit();
    this.pauseInfo = card.querySelector('#pause-info');
  }

  setPauseInfo(text) { if (this.pauseInfo) this.pauseInfo.textContent = text; }

  /* ----------------------------------------------------- skill tree */
  _buildSkills() {
    const s = this._screen('skills', 'pane');
    const card = el('div', 'card full');
    card.innerHTML = `
      <div class="spread">
        <h2>NEURAL LATTICE</h2>
        <div><span class="tag" id="sk-points">0 POINTS</span></div>
      </div>
      <p class="muted">Every level buys a point. Nodes need the node above them.
         Unlocks drop into the next free ability slot.</p>
      <div class="tree" id="sk-tree"></div>
      <button class="primary" id="btn-sk-close" style="margin-top:14px">BACK <span class="hint">TAB / ESC</span></button>`;
    s.appendChild(card);
    card.querySelector('#btn-sk-close').onclick = () => this.hooks.resume();
    this.skillTree = card.querySelector('#sk-tree');
    this.skillPoints = card.querySelector('#sk-points');
  }

  refreshSkills() {
    const me = this.hooks.getPlayer();
    if (!me) return;
    this.skillPoints.textContent = `${me.skillPoints} POINT${me.skillPoints === 1 ? '' : 'S'}`;
    this.skillTree.innerHTML = '';
    for (const branch of SKILL_BRANCHES) {
      const col = el('div', 'branch');
      col.appendChild(el('h4', '', `<span style="color:${branch.color}">${branch.name}</span>`));
      col.appendChild(el('div', 'blurb', branch.blurb));
      const nodes = Object.entries(SKILLS)
        .filter(([, v]) => v.branch === branch.id)
        .sort((a, b) => a[1].tier - b[1].tier);
      for (const [key, def] of nodes) {
        const owned = !!me.skills[key];
        const reqOk = !def.req || !!me.skills[def.req];
        const affordable = me.skillPoints >= def.cost;
        const state = owned ? 'owned' : (reqOk && affordable) ? 'available' : 'locked';
        const node = el('div', `node ${state}`);
        node.innerHTML =
          `<span class="n-cost">${owned ? '✓' : def.cost + 'p'}</span>` +
          `<div class="n-name" style="color:${owned ? branch.color : ''}">${def.name}</div>` +
          `<div class="n-desc">${def.desc}</div>`;
        if (state === 'available') {
          node.onclick = () => { this.hooks.learnSkill(key); this.refreshSkills(); };
          node.tabIndex = 0;
          node.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') node.onclick(); };
        } else if (!reqOk && !owned) {
          node.title = 'Requires ' + SKILLS[def.req].name;
        }
        col.appendChild(node);
      }
      this.skillTree.appendChild(col);
    }
  }

  /* --------------------------------------------------- beacon panel */
  _buildBeacon() {
    const s = this._screen('beacon', 'pane');
    const card = el('div', 'card wide');
    card.innerHTML = `
      <div class="spread"><h2>BEACON CONSOLE</h2><span class="tag" id="bc-int">INTEGRITY</span></div>
      <p class="muted">Salvage is pooled: whatever anyone picks up is spent here,
         and everything bought helps the whole run.</p>
      <div class="stock" id="bc-stock"></div>
      <div id="bc-list"></div>
      <button class="primary" id="btn-bc-close" style="margin-top:12px">BACK <span class="hint">ESC</span></button>`;
    s.appendChild(card);
    card.querySelector('#btn-bc-close').onclick = () => this.hooks.resume();
    this.bcList = card.querySelector('#bc-list');
    this.bcStock = card.querySelector('#bc-stock');
    this.bcInt = card.querySelector('#bc-int');
  }

  refreshBeacon() {
    const sim = this.hooks.getSim();
    if (!sim) return;
    const res = sim.beacon.res;
    this.bcStock.innerHTML =
      `<span style="color:var(--amber)">⛭ SCRAP <b>${res.scrap}</b></span>` +
      `<span style="color:var(--arcane)">✧ ESSENCE <b>${res.essence}</b></span>` +
      `<span style="color:#ff4fd8">◆ CORES <b>${res.cores}</b></span>`;
    this.bcInt.textContent = `INTEGRITY ${Math.round(sim.beacon.hp)} / ${sim.beacon.maxHp}`;
    this.bcList.innerHTML = '';
    for (const [key, def] of Object.entries(BEACON_UPGRADES)) {
      const level = sim.beacon.upgrades[key];
      const maxed = level >= def.max;
      const cost = maxed ? null : def.cost(level);
      const canAfford = cost && Object.entries(cost).every(([r, a]) => (res[r] || 0) >= a);
      const row = el('div', 'upg');
      /* "1 CORES" reads as a bug, so singularise on the way out. */
      const unit = (r, a) => (a === 1 && r === 'cores' ? 'CORE' : r.toUpperCase());
      const costText = maxed ? 'MAXED'
        : Object.entries(cost).map(([r, a]) => `${a} ${unit(r, a)}`).join(' + ');
      row.innerHTML =
        `<div>
           <div class="u-name">${def.icon} ${def.name.toUpperCase()}</div>
           <div class="u-desc">${maxed ? 'Fully upgraded.' : def.desc(level)}</div>
           <div class="u-pips">${pips(level, def.max)}</div>
         </div>`;
      const btn = el('button', canAfford ? 'primary' : '', costText);
      btn.disabled = maxed || !canAfford;
      btn.onclick = () => { this.hooks.buyUpgrade(key); this.refreshBeacon(); };
      row.appendChild(btn);
      this.bcList.appendChild(row);
    }
  }

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

  showOver(sim, localId) {
    const me = sim.players.get(localId);
    this.overTitle.textContent = 'THE BEACON IS DARK';
    const rows = [...sim.players.values()].map(p =>
      `<tr><td>${p.name}${p.id === localId ? ' (you)' : ''}</td><td>lv ${p.level} · ${p.kills} kills · ${p.deaths} deaths</td></tr>`).join('');
    this.overBody.innerHTML = `
      <p>You held for <b style="color:#fff">${sim.night}</b> night${sim.night === 1 ? '' : 's'}.
         ${sim.night < 3 ? 'The rift barely noticed.'
        : sim.night < 6 ? 'Long enough to be remembered.'
        : 'Long enough that something out there learned your name.'}</p>
      <table class="keys">${rows}
        <tr><td>damage dealt</td><td>${me ? Math.round(me.damageDealt).toLocaleString() : 0}</td></tr>
        <tr><td>salvage banked</td><td>${sim.beacon.res.scrap} scrap · ${sim.beacon.res.essence} essence</td></tr>
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
