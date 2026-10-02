// A tiny WebAudio sound-effects layer. Real recorded samples (public/audio/sfx, CC0, see
// public/audio/ATTRIBUTION.md) play when they have loaded; every sound still has its synthesized
// voice underneath, so the game is complete (and silent-safe) with the folder empty. All calls are
// safe no-ops until the AudioContext is unlocked by a user gesture, and respect the mute/volume settings.
//
// Two buses, so the settings are independent: `master` is SOUND EFFECTS (the Volume slider), and
// `musicBus` goes straight to the speakers (the Music slider lives inside the music layer). Mute gates both.

type ShotKind = "rifle" | "shell" | "bolt" | "grenade";

/** Sample groups: file stems under audio/sfx (every file peak-normalised to -3 dBFS by scripts/audio-build.sh). */
export const SAMPLE_GROUPS: Record<string, string[]> = {
  rifle: ["rifle"], carbine: ["carbine"], pistol: ["pistol"], pellet: ["pellet"],
  bolt: ["bolt_01", "bolt_02", "bolt_03"],
  cannon: ["cannon_01", "cannon_02", "cannon_03"],
  crack: ["crack_01", "crack_02"],
  boomdeep: ["boomdeep_01", "boomdeep_02", "boomdeep_03"],
  blast: ["blast_01", "blast_02", "blast_03", "blast_04", "blast_05", "blast_06", "blast_07"],
  pop: ["pop_01", "pop_02", "pop_03", "pop_04", "pop_05", "pop_06"],
  hitmetal: ["hitmetal_000", "hitmetal_001", "hitmetal_002"],
  hitpunch: ["hitpunch_000", "hitpunch_001", "hitpunch_002"],
  hitsoft: ["hitsoft_000", "hitsoft_001", "hitsoft_002"],
  hitplate: ["hitplate_000", "hitplate_001", "hitplate_002"],
  hitwood: ["hitwood_000", "hitwood_001", "hitwood_002"],
};
const MAX_VOICES = 10;

/**
 * THE LOUDNESS HIERARCHY, in one table. Every sample is the same peak level, but the recordings differ by
 * 10+ dB in energy (a firework bang is a spike, a rifle a long crack), so this gain is set from each group's
 * MEASURED RMS (scripts/audio-stats.py) to give the order a player expects:
 *   deep boom > cannon = blast > crack > pop > rifle > carbine = pellet > pistol,
 * with the machine gun held back (it fires ten rounds) and impacts under the guns that cause them.
 */
export const GROUP_GAIN: Record<string, number> = {
  boomdeep: 1, cannon: 0.8, blast: 0.8, crack: 0.75, pop: 0.7,
  rifle: 0.45, carbine: 0.38, pellet: 0.38, pistol: 0.3, bolt: 0.8,
  hitsoft: 0.5, hitmetal: 0.55, hitplate: 0.55, hitpunch: 0.5, hitwood: 0.55,
};

export interface Voice {
  /** Sample group, or "" for a purely synthesized voice. */
  group: string;
  /** Playback rate: lower = heavier and longer, higher = lighter. */
  rate: number;
  /** Multiplier on the group's gain: how big this particular weapon is within its group. */
  m: number;
  /** A synthesized layer played with (or instead of) the sample. */
  synth?: "flame" | "rocket" | "thunk" | "whoosh";
}

/**
 * ONE VOICE PER WEAPON (owner 2026-10-03: "variety across units"). Shooter kind -> its sound: the same few
 * recordings, pitched and weighted so a marksman, a recruit, a scout, a machine gun, a tank and the siege gun
 * are all distinguishable by ear. `voiceFor` is pure so a test can hold the table to that promise.
 */
export const GUN_VOICES: Record<string, Voice> = {
  soldier: { group: "carbine", rate: 1, m: 1 },
  scout: { group: "carbine", rate: 1.22, m: 0.75 },
  jumper: { group: "carbine", rate: 1.1, m: 0.85 },
  sniper: { group: "rifle", rate: 0.92, m: 1 },
  striker: { group: "pistol", rate: 1, m: 1 },
  medic: { group: "pistol", rate: 1.12, m: 0.75 },
  droneop: { group: "pistol", rate: 1.25, m: 0.75 },
  engineer: { group: "pistol", rate: 0.98, m: 0.85 },
  builder: { group: "pistol", rate: 0.9, m: 0.9 },
  demo: { group: "pistol", rate: 0.82, m: 0.9 },
  oiler: { group: "pistol", rate: 1.05, m: 0.85 },
  springer: { group: "pistol", rate: 1.3, m: 0.8 },
  sapper: { group: "pellet", rate: 1, m: 1 },
  heavy: { group: "bolt", rate: 0.78, m: 1 },
  flamer: { group: "", rate: 1, m: 1, synth: "flame" },
  bazooka: { group: "crack", rate: 0.7, m: 1, synth: "rocket" },
  grenadier: { group: "pop", rate: 0.7, m: 0.85, synth: "thunk" },
  mortar: { group: "blast", rate: 0.55, m: 0.6, synth: "thunk" },
  mortarpit: { group: "blast", rate: 0.5, m: 0.65, synth: "thunk" },
  tank: { group: "cannon", rate: 0.9, m: 1 },
  artillery: { group: "cannon", rate: 0.6, m: 1.15 },
  exturret: { group: "cannon", rate: 0.74, m: 0.9 },
  base: { group: "cannon", rate: 1.15, m: 0.7 },
  apc: { group: "bolt", rate: 1, m: 0.9 },
  flak: { group: "crack", rate: 1.35, m: 0.8 },
  aaturret: { group: "crack", rate: 1.2, m: 0.8 },
  gunship: { group: "bolt", rate: 1.15, m: 0.8 },
  interceptor: { group: "bolt", rate: 1.32, m: 0.8 },
  turret: { group: "bolt", rate: 0.92, m: 0.9 },
  bunker: { group: "bolt", rate: 0.8, m: 0.95 },
  gunpost: { group: "bolt", rate: 0.84, m: 1 },
};
/** A hand grenade leaving a hand, and a bomb leaving a bay. */
const THROW_VOICE: Voice = { group: "", rate: 1, m: 1, synth: "whoosh" };
const BOMB_VOICE: Voice = { group: "pop", rate: 0.5, m: 0.6 };
const AIR = new Set(["gunship", "interceptor", "bomber", "transport"]);

/** The sound of a round leaving its barrel. Pure. */
export function voiceFor(kind: ShotKind, source?: string): Voice {
  if (kind === "grenade" && source === "soldier") return THROW_VOICE;
  if (kind === "grenade" && source && AIR.has(source)) return BOMB_VOICE;
  return (source && GUN_VOICES[source]) || GUN_VOICES.soldier;
}

/** Which impact material a hit lands on, from what was hit. Pure. */
export function impactClass(kind: string, coverKind?: string): "hitsoft" | "hitmetal" | "hitplate" | "hitwood" {
  const SOFT = new Set(["soldier", "scout", "sniper", "striker", "heavy", "grenadier", "mortar", "medic", "engineer", "flamer", "droneop", "sapper", "jumper", "bazooka", "builder", "demo", "oiler", "springer"]);
  if (SOFT.has(kind)) return "hitsoft";
  if (kind === "cover") {
    const wood = new Set(["tree", "crate", "log", "stump", "bush", "haybale", "fence", "rack", "tent", "hut", "boat", "barricade", "sandbag", "bones", "grave"]);
    return coverKind && wood.has(coverKind) ? "hitwood" : "hitplate";
  }
  if (kind === "base" || kind === "wall" || kind === "bunker" || kind === "gunpost" || kind === "mortarpit") return "hitplate";
  return "hitmetal"; // vehicles, aircraft, turrets
}

/** The explosion sample group for a blast of this radius (metres). Pure. */
export function blastGroup(radius: number): "boomdeep" | "blast" | "pop" {
  return radius >= 3.2 ? "boomdeep" : radius >= 1.5 ? "blast" : "pop";
}

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

  /** A round leaving a barrel; `source` is the shooter's kind, `gain` the on-screen factor (1 in view, less out of it). */
  shot(kind: ShotKind, source?: string, gain = 1): void {
    const v = voiceFor(kind, source);
    if (v.synth) this.synthVoice(v.synth, gain);
    if (v.group && this.sample(v.group, (GROUP_GAIN[v.group] ?? 0.5) * v.m * gain, v.rate)) return;
    if (v.synth) return;
    if (kind === "shell") this.boom(150, 0.16, 0.5 * gain);
    else if (kind === "bolt") this.zap(620, 0.09);
    else this.crack(0.05);
  }

  /** A hit landing on `what` (an entity kind, with its cover kind if it is cover): flesh, hull, concrete or wood. */
  impact(what = "soldier", coverKind?: string, gain = 1): void {
    const group = impactClass(what, coverKind);
    if (this.sample(group, (GROUP_GAIN[group] ?? 0.5) * gain)) return;
    this.crack(0.04, 0.35 * gain);
  }

  /** A blow landing (melee). */
  strike(gain = 1): void {
    if (this.sample("hitpunch", GROUP_GAIN.hitpunch * 1.3 * gain)) return;
    this.crack(0.05, 0.4);
  }

  /** An explosion of `radius` metres: a pop, a blast or a deep boom, louder the bigger it is. */
  explosion(radius = 1.5, gain = 1): void {
    const group = blastGroup(radius);
    const size = Math.min(1.15, 0.6 + radius * 0.12);
    if (this.sample(group, (GROUP_GAIN[group] ?? 0.8) * size * gain, group === "boomdeep" ? 0.9 + Math.random() * 0.1 : 1)) return;
    this.boom(90, 0.28, 0.7 * gain);
  }

  // A heavy object slamming into the ground: toppling pillars/trees.
  crash(gain = 1): void {
    if (this.sample("hitwood", GROUP_GAIN.hitwood * 1.5 * gain, 0.7) && this.sample("boomdeep", 0.35 * gain, 1.1)) return;
    this.boom(58, 0.42, 0.62 * gain);
    this.crack(0.09, 0.5);
  }

  /** The synthesized layers: things no recording here covers (fire, a rocket's rush, a tube's thump, a throw). */
  private synthVoice(kind: NonNullable<Voice["synth"]>, gain: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    if (kind === "thunk") { this.thunk(170, 0.14); return; }
    const dur = kind === "flame" ? 0.55 : kind === "rocket" ? 0.7 : 0.22;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = kind === "flame" ? 0.7 : 1.4;
    // flame: a low roar that blooms; rocket: a rising rush; whoosh: a quick airy swish.
    if (kind === "flame") { bp.frequency.setValueAtTime(380, t); bp.frequency.linearRampToValueAtTime(900, t + dur); }
    else if (kind === "rocket") { bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(2400, t + dur); }
    else { bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(2600, t + dur); }
    const peak = (kind === "flame" ? 0.34 : kind === "rocket" ? 0.3 : 0.12) * gain;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.linearRampToValueAtTime(peak, t + dur * (kind === "flame" ? 0.25 : 0.4));
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(env).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** Oil catching: a low whump and a rush of flame. */
  ignite(gain = 1): void {
    this.boom(70, 0.35, 0.45 * gain);
    this.synthVoice("flame", gain);
  }

  /** A placed item landing: a soft thud. */
  place(gain = 1): void {
    if (this.sample("hitplate", GROUP_GAIN.hitplate * 0.9 * gain, 0.75)) return;
    this.thunk(140, 0.1);
  }

  /** A fuse tick: one short bright beep. */
  fuse(): void {
    this.blip(1040, 0.06, "square", 0.1);
  }

  /** A trooper settling into a post: a metallic clank. */
  clank(gain = 1): void {
    if (this.sample("hitmetal", GROUP_GAIN.hitmetal * 0.9 * gain, 0.85)) return;
    this.thunk(200, 0.08);
  }

  // ---- the bed under movement: footfalls, engines, rotors (quiet, and only for what is in view) ----
  private bed: { engine: GainNode; rotor: GainNode } | undefined;
  private lastStepAt = 0;

  /** Called every frame while orders resolve with how many troopers, ground vehicles and aircraft are moving in view. */
  moveBed(infantry: number, vehicles: number, air: number): void {
    if (!this.ctx || !this.master || this.muted) { if (this.bed) { this.bed.engine.gain.value = 0; this.bed.rotor.gain.value = 0; } return; }
    const ctx = this.ctx;
    if (!this.bed) {
      // One looped noise, two filters: a low rumble for tracks and a thin whirr for rotors.
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i += 1) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; data[i] = last * 14; } // brown noise
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const low = ctx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = 160;
      const engine = ctx.createGain(); engine.gain.value = 0;
      const high = ctx.createBiquadFilter(); high.type = "bandpass"; high.frequency.value = 520; high.Q.value = 2.5;
      const rotor = ctx.createGain(); rotor.gain.value = 0;
      src.connect(low).connect(engine).connect(this.master);
      src.connect(high).connect(rotor).connect(this.master);
      src.start();
      this.bed = { engine, rotor };
    }
    const t = ctx.currentTime;
    this.bed.engine.gain.setTargetAtTime(Math.min(0.2, vehicles * 0.07), t, 0.15);
    this.bed.rotor.gain.setTargetAtTime(Math.min(0.1, air * 0.03), t, 0.2);
    // Footfalls: a soft thud every few tenths of a second, quicker the more feet there are.
    if (infantry > 0 && t - this.lastStepAt > 0.34 / (1 + 0.3 * Math.min(infantry, 6))) {
      this.lastStepAt = t;
      this.sample("hitsoft", 0.1, 1.7 + Math.random() * 0.5);
    }
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
