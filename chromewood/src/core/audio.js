/* ============================================================
   audio.js - procedural sound

   No audio files: every sound is a short WebAudio graph built on
   the spot. It keeps the whole game to what fits in this repo, and
   it lets pitch and timbre follow the simulation - a crit is the
   same shot a fifth higher, a boss death is the same blast an
   octave down and four times as long.
   ============================================================ */

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.enabled = true;
    this.lastAt = new Map();      /* throttles repeated sounds */
    this.ambientGain = null;
  }

  /* Browsers only allow audio after a gesture, so this is called
     from the first click rather than at load. */
  resume() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 7;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this._buildAmbient();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  _throttle(key, ms) {
    const now = performance.now();
    const last = this.lastAt.get(key) || 0;
    if (now - last < ms) return false;
    this.lastAt.set(key, now);
    return true;
  }

  _env(node, gain, attack, decay, when) {
    const t = when || this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(this.master);
    return g;
  }

  _tone(freq, type, gain, attack, decay, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t + attack + decay);
    let src = o;
    if (opts.filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = opts.filter;
      f.frequency.setValueAtTime(opts.cutoff || 1200, t);
      if (opts.cutoffTo) f.frequency.exponentialRampToValueAtTime(opts.cutoffTo, t + attack + decay);
      f.Q.value = opts.q || 1;
      o.connect(f);
      src = f;
    }
    this._env(src, gain, attack, decay);
    o.start(t);
    o.stop(t + attack + decay + 0.02);
  }

  _noise(gain, decay, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const len = Math.max(0.03, decay);
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * len), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      /* Slightly brown noise reads as impact; white reads as hiss. */
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.type || 'lowpass';
    f.frequency.setValueAtTime(opts.cutoff || 900, t);
    if (opts.cutoffTo) f.frequency.exponentialRampToValueAtTime(opts.cutoffTo, t + decay);
    f.Q.value = opts.q || 0.8;
    src.connect(f);
    this._env(f, gain, 0.006, decay);
    src.start(t);
    src.stop(t + len + 0.02);
  }

  /* A quiet drone that shifts with the day cycle. */
  _buildAmbient() {
    const t = this.ctx.currentTime;
    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.0;
    this.ambientGain.connect(this.master);
    const o1 = this.ctx.createOscillator();
    o1.type = 'sine'; o1.frequency.value = 55;
    const o2 = this.ctx.createOscillator();
    o2.type = 'sine'; o2.frequency.value = 82.5;
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 3.5;
    lfo.connect(lfoGain);
    lfoGain.connect(o2.frequency);
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 340;
    o1.connect(filt); o2.connect(filt);
    filt.connect(this.ambientGain);
    o1.start(t); o2.start(t); lfo.start(t);
    this.ambientOsc = [o1, o2];
  }

  setAmbient(nightAmount) {
    if (!this.ambientGain) return;
    const t = this.ctx.currentTime;
    this.ambientGain.gain.setTargetAtTime(0.02 + nightAmount * 0.09, t, 1.5);
    if (this.ambientOsc) {
      this.ambientOsc[0].frequency.setTargetAtTime(55 - nightAmount * 12, t, 2);
      this.ambientOsc[1].frequency.setTargetAtTime(82.5 - nightAmount * 20, t, 2);
    }
  }

  /* --------------------------------------------------------- events */
  shoot(pitch = 1) {
    if (!this._throttle('shoot', 45)) return;
    this._tone(760 * pitch, 'square', 0.055, 0.004, 0.09,
      { slideTo: 300 * pitch, filter: 'lowpass', cutoff: 3600, cutoffTo: 900 });
  }

  hit(crit) {
    if (!this._throttle('hit', 28)) return;
    this._noise(crit ? 0.14 : 0.075, crit ? 0.14 : 0.07, { cutoff: crit ? 3200 : 1800, cutoffTo: 320 });
    if (crit) this._tone(880, 'triangle', 0.07, 0.004, 0.14, { slideTo: 1500 });
  }

  boom(size = 1) {
    this._noise(0.22 * Math.min(2, size), 0.55 * size, { cutoff: 1400, cutoffTo: 90 });
    this._tone(110 / size, 'sine', 0.2, 0.01, 0.5 * size, { slideTo: 38 });
  }

  cast(color) {
    this._tone(420, 'sawtooth', 0.07, 0.01, 0.26,
      { slideTo: 980, filter: 'bandpass', cutoff: 900, cutoffTo: 2400, q: 4 });
  }

  dash() {
    this._noise(0.08, 0.16, { cutoff: 2600, cutoffTo: 500, type: 'bandpass', q: 1.4 });
  }

  pickup(kind) {
    if (!this._throttle('pickup', 55)) return;
    const base = kind === 'cores' ? 900 : kind === 'essence' ? 700 : 560;
    this._tone(base, 'triangle', 0.055, 0.004, 0.1, { slideTo: base * 1.6 });
  }

  levelUp() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => setTimeout(() => this._tone(f, 'triangle', 0.09, 0.01, 0.3), i * 70));
  }

  hurt() {
    if (!this._throttle('hurt', 140)) return;
    this._tone(220, 'sawtooth', 0.11, 0.006, 0.2, { slideTo: 90, filter: 'lowpass', cutoff: 1100, cutoffTo: 240 });
  }

  down() {
    this._tone(180, 'sawtooth', 0.16, 0.02, 1.1, { slideTo: 48, filter: 'lowpass', cutoff: 900, cutoffTo: 120 });
  }

  nightfall() {
    this._tone(140, 'sine', 0.16, 0.6, 2.4, { slideTo: 62 });
    this._tone(210, 'triangle', 0.09, 0.8, 2.0, { slideTo: 93 });
  }

  dawn() {
    const notes = [392, 494, 587];
    notes.forEach((f, i) => setTimeout(() => this._tone(f, 'sine', 0.07, 0.15, 0.9), i * 160));
  }

  ui(kind = 'click') {
    this._tone(kind === 'deny' ? 180 : 620, 'square', 0.04, 0.003, 0.06,
      { slideTo: kind === 'deny' ? 120 : 760 });
  }

  breakProp() {
    if (!this._throttle('break', 70)) return;
    this._noise(0.1, 0.22, { cutoff: 2400, cutoffTo: 300 });
  }
}
