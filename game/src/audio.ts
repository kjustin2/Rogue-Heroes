// A tiny WebAudio sound-effects layer. Real recorded samples (public/audio/sfx, CC0, see
// public/audio/ATTRIBUTION.md) play when they have loaded; every sound still has its synthesized
// voice underneath, so the game is complete (and silent-safe) with the folder empty. All calls are
// safe no-ops until the AudioContext is unlocked by a user gesture, and respect the mute/volume settings.
//
// Two buses, so the settings are independent: `master` is SOUND EFFECTS (the Volume slider), and
// `musicBus` goes straight to the speakers (the Music slider lives inside the music layer). Mute gates both.

type ShotKind = "rifle" | "shell" | "bolt" | "grenade";

/** Sample groups: file stems under audio/sfx, numbered 01.. (or 000..) per group. */
const SAMPLE_GROUPS: Record<string, string[]> = {
  rifle: ["rifle"], carbine: ["carbine"], pistol: ["pistol"], pellet: ["pellet"],
  bolt: ["bolt_01", "bolt_02", "bolt_03"],
  cannon: ["cannon_01", "cannon_02", "cannon_03", "cannon_04", "cannon_05"],
  blast: ["blast_01", "blast_02", "blast_03", "blast_04", "blast_05", "blast_06", "blast_07", "blast_08", "blast_09", "blast_10"],
  boom: ["boom_01", "boom_02", "boom_03", "boom_04", "boom_05", "boom_06"],
  hitmetal: ["hitmetal_000", "hitmetal_001", "hitmetal_002"],
  hitpunch: ["hitpunch_000", "hitpunch_001", "hitpunch_002"],
  hitsoft: ["hitsoft_000", "hitsoft_001", "hitsoft_002"],
  hitplate: ["hitplate_000", "hitplate_001", "hitplate_002"],
  hitwood: ["hitwood_000", "hitwood_001", "hitwood_002"],
};
const MAX_VOICES = 10;

export class Sfx {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private muted = false;
  private volume = 0.6;
  private lastAt = 0;
  private musicGate: GainNode | undefined;
  private readonly samples = new Map<string, AudioBuffer[]>();
  private voices = 0;
  private lastPlayed = new Map<string, number>();

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
      this.musicGate = this.ctx.createGain();
      this.musicGate.gain.value = this.muted ? 0 : 1;
      this.musicGate.connect(this.ctx.destination);
      void this.loadSamples();
    } catch {
      this.ctx = undefined;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
    if (this.musicGate) this.musicGate.gain.value = muted ? 0 : 1;
  }

  /** Fetch + decode every sample group in the background; a missing file just leaves that sound synthesized. */
  private async loadSamples(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [group, stems] of Object.entries(SAMPLE_GROUPS)) {
      const buffers: AudioBuffer[] = [];
      for (const stem of stems) {
        try {
          const response = await fetch(new URL(`audio/sfx/${stem}.ogg`, document.baseURI).href);
          if (!response.ok) continue;
          buffers.push(await ctx.decodeAudioData(await response.arrayBuffer()));
        } catch { /* synthesized fallback */ }
      }
      if (buffers.length) this.samples.set(group, buffers);
    }
  }

  /** Play a random sample of a group (pitch-jittered, voice-capped). False when the group has not loaded. */
  private sample(group: string, gain = 1, rate = 1): boolean {
    const buffers = this.samples.get(group);
    if (!buffers || !this.ctx || !this.master || this.muted) return buffers ? true : false;
    const now = this.ctx.currentTime;
    // A burst of the same sound inside a few ms is one sound (a heavy gunner's ten rounds stay a rattle, not a wall).
    if (now - (this.lastPlayed.get(group) ?? -1) < 0.035 || this.voices >= MAX_VOICES) return true;
    this.lastPlayed.set(group, now);
    const src = this.ctx.createBufferSource();
    src.buffer = buffers[Math.floor(Math.random() * buffers.length)];
    src.playbackRate.value = rate * (0.93 + Math.random() * 0.14);
    const env = this.ctx.createGain();
    env.gain.value = gain;
    src.connect(env).connect(this.master);
    this.voices += 1;
    src.onended = () => { this.voices -= 1; };
    src.start();
    return true;
  }

  /** The bus the music layer plays into (the Music slider lives inside it; mute gates it). */
  get musicBus(): GainNode | undefined {
    return this.musicGate;
  }

  // Exposed via window.__rht.audioMuted() so smokes can assert test runs are actually silent.
  get isMuted(): boolean {
    return this.muted;
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

  /** A round leaving a barrel. `source` (the shooter's kind) picks the gun: a marksman's rifle, a pistol, a scattergun, a cannon. */
  shot(kind: ShotKind, source?: string): void {
    const group = kind === "shell" ? "cannon"
      : kind === "bolt" ? "bolt"
      : kind === "grenade" ? ""
      : source === "sniper" ? "rifle"
      : source === "sapper" ? "pellet"
      : source === "medic" || source === "droneop" || source === "builder" || source === "demo" || source === "oiler" || source === "springer" || source === "striker" ? "pistol"
      : source === "heavy" || source === "gunpost" ? "bolt"
      : "carbine";
    if (group && this.sample(group, kind === "shell" ? 0.85 : 0.7, source === "artillery" || source === "exturret" ? 0.8 : 1)) return;
    if (kind === "shell") this.boom(150, 0.16, 0.5);
    else if (kind === "grenade") this.thunk(220, 0.12);
    else if (kind === "bolt") this.zap(620, 0.09);
    else this.crack(0.05);
  }

  impact(): void {
    const group = ["hitsoft", "hitmetal", "hitplate"][Math.floor(Math.random() * 3)];
    if (this.sample(group, 0.5)) return;
    this.crack(0.04, 0.35);
  }

  /** A blow landing (melee). */
  strike(): void {
    if (this.sample("hitpunch", 0.75)) return;
    this.crack(0.05, 0.4);
  }

  explosion(big = false): void {
    if (this.sample(big || Math.random() < 0.4 ? "boom" : "blast", big ? 0.95 : 0.75)) return;
    this.boom(90, 0.28, 0.7);
  }

  // A heavy object slamming into the ground — toppling pillars/trees.
  crash(): void {
    if (this.sample("hitwood", 0.9, 0.7)) return;
    this.boom(58, 0.42, 0.62);
    this.crack(0.09, 0.5);
  }

  /** A bounce pad: a rising spring "boing". */
  boing(): void {
    this.blip(260, 0.22, "sine", 0.22);
    this.blip(520, 0.2, "sine", 0.16, 0.06);
  }

  /** A treat order landing: a soft two-note chime. */
  heal(): void {
    this.blip(660, 0.18, "sine", 0.16);
    this.blip(880, 0.24, "sine", 0.14, 0.1);
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

  /** A refused order: a short falling dissonant pair. */
  error(): void {
    this.blip(220, 0.07, "square", 0.12);
    this.blip(196, 0.09, "square", 0.1, 0.06);
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
