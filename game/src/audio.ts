// A tiny WebAudio sound-effects layer. Everything is synthesized at runtime (no asset files)
// so it stays self-contained. All calls are safe no-ops until the AudioContext is unlocked by
// a user gesture, and respect the mute/volume settings.

type ShotKind = "rifle" | "shell" | "bolt" | "grenade";

export class Sfx {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private muted = false;
  private volume = 0.6;
  private lastAt = 0;

  // Create the audio graph on the first user gesture (browsers block autoplay otherwise).
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = undefined;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  // The music layer routes through the same context + master gain, so the global
  // volume/mute controls govern it too.
  get audioContext(): AudioContext | undefined {
    return this.ctx;
  }

  get masterGain(): GainNode | undefined {
    return this.master;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && !this.muted) this.master.gain.value = this.volume;
  }

  shot(kind: ShotKind): void {
    if (kind === "shell") this.boom(150, 0.16, 0.5);
    else if (kind === "grenade") this.thunk(220, 0.12);
    else if (kind === "bolt") this.zap(620, 0.09);
    else this.crack(0.05);
  }

  impact(): void {
    this.crack(0.04, 0.35);
  }

  explosion(): void {
    this.boom(90, 0.28, 0.7);
  }

  // Strike aircraft flyby: a long filtered-noise sweep that rises then falls.
  jet(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = 1.4;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(220, t);
    bp.frequency.exponentialRampToValueAtTime(1450, t + dur * 0.45);
    bp.frequency.exponentialRampToValueAtTime(180, t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.4);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(env).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // Orbital lance: a deep descending charge tone under a bright zap.
  beam(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(1600, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.9);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.28, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.95);
    osc.connect(env).connect(this.master!);
    osc.start(t);
    osc.stop(t + 1);
    this.boom(70, 0.5, 0.5);
  }

  ui(): void {
    this.blip(540, 0.04, "triangle", 0.18);
  }

  select(): void {
    this.blip(720, 0.05, "sine", 0.2);
  }

  deploy(): void {
    this.blip(330, 0.08, "sawtooth", 0.22);
    this.blip(440, 0.1, "sawtooth", 0.16, 0.06);
  }

  build(): void {
    this.thunk(160, 0.14);
    this.blip(300, 0.06, "square", 0.16, 0.05);
  }

  turn(): void {
    this.blip(420, 0.07, "sine", 0.22);
    this.blip(560, 0.09, "sine", 0.18, 0.07);
  }

  victory(): void {
    [523, 659, 784, 1046].forEach((f, i) => this.blip(f, 0.16, "triangle", 0.24, i * 0.12));
  }

  defeat(): void {
    [392, 330, 262].forEach((f, i) => this.blip(f, 0.22, "sawtooth", 0.22, i * 0.16));
  }

  // ---- primitives ----

  private ready(): boolean {
    if (!this.ctx || !this.master || this.muted) return false;
    // Throttle so a heavy-gunner burst or many simultaneous impacts don't stack into clipping.
    const now = this.ctx.currentTime;
    if (now - this.lastAt < 0.012) return false;
    this.lastAt = now;
    return true;
  }

  private blip(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(env).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private crack(dur: number, gain = 0.45): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    src.connect(hp).connect(env).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private boom(freq: number, dur: number, gain: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.32), t + dur);
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    // a little noise body for grit
    this.crack(Math.min(0.12, dur * 0.4), gain * 0.5);
  }

  private thunk(freq: number, dur: number): void {
    this.blip(freq, dur, "square", 0.22);
  }

  private zap(freq: number, dur: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 2.4, t + dur);
    env.gain.setValueAtTime(0.2, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

export const sfx = new Sfx();
