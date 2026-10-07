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
  // ---- real firearms ("The Free Firearm Sound Library", CC0): three takes each, cut by scripts/audio-slice.py ----
  ar15: ["ar15_01", "ar15_02", "ar15_03"], ak47: ["ak47_01", "ak47_02", "ak47_03"], sks: ["sks_01", "sks_02", "sks_03"],
  carlgustav: ["carlgustav_01", "carlgustav_02", "carlgustav_03"], tikka: ["tikka_01", "tikka_02", "tikka_03"],
  marlin: ["marlin_01", "marlin_02", "marlin_03"], lever1894: ["lever1894_01", "lever1894_02", "lever1894_03"],
  mosin: ["mosin_01", "mosin_02", "mosin_03"], savage: ["savage_01", "savage_02", "savage_03"], arisaka: ["arisaka_01", "arisaka_02", "arisaka_03"],
  colt1911: ["colt1911_01", "colt1911_02", "colt1911_03"], ppq: ["ppq_01", "ppq_02", "ppq_03"], bersa: ["bersa_01", "bersa_02", "bersa_03"],
  ruger22: ["ruger22_01", "ruger22_02", "ruger22_03"], sw642: ["sw642_01", "sw642_02", "sw642_03"], singlesix: ["singlesix_01", "singlesix_02", "singlesix_03"],
  m1917: ["m1917_01", "m1917_02", "m1917_03"], mossberg: ["mossberg_01", "mossberg_02", "mossberg_03"], model12: ["model12_01", "model12_02", "model12_03"],
  nova: ["nova_01", "nova_02", "nova_03"], ak47burst: ["ak47burst_01"], ppshburst: ["ppshburst_01"],
  // ---- bangs, cannons and booms (fireworks, CC0) ----
  bolt: ["bolt_01", "bolt_02", "bolt_03"],
  cannon: ["cannon_01", "cannon_02", "cannon_03"],
  crack: ["crack_01", "crack_02"],
  boomdeep: ["boomdeep_01", "boomdeep_02", "boomdeep_03"],
  blast: ["blast_01", "blast_02", "blast_03", "blast_04", "blast_05", "blast_06", "blast_07"],
  pop: ["pop_01", "pop_02", "pop_03", "pop_04", "pop_05", "pop_06"],
  // ---- hits ----
  hitmetal: ["hitmetal_000", "hitmetal_001", "hitmetal_002"],
  hitpunch: ["hitpunch_000", "hitpunch_001", "hitpunch_002"],
  hitsoft: ["hitsoft_000", "hitsoft_001", "hitsoft_002"],
  hitplate: ["hitplate_000", "hitplate_001", "hitplate_002"],
  hitwood: ["hitwood_000", "hitwood_001", "hitwood_002"],
  // ---- interface (Kenney Interface Sounds + UI Audio, CC0) ----
  ui_hover: ["ui_hover_01", "ui_hover_02"], ui_select: ["ui_select_01", "ui_select_02"], ui_unit: ["ui_unit_01", "ui_unit_02"],
  ui_confirm: ["ui_confirm_01"], ui_deploy: ["ui_deploy_01"], ui_turn: ["ui_turn_01"], ui_ready: ["ui_ready_01"],
  ui_back: ["ui_back_01", "ui_back_02"], ui_error: ["ui_error_01", "ui_error_02"], ui_toggle: ["ui_toggle_01", "ui_toggle_02"],
  ui_open: ["ui_open_01"], ui_drop: ["ui_drop_01", "ui_drop_02"], ui_win: ["ui_win_01", "ui_win_02"], ui_lose: ["ui_lose_01", "ui_lose_02"],
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
  // explosions and cannons (fireworks): the loudest things on the field
  boomdeep: 1, cannon: 0.8, blast: 0.8, crack: 0.75, pop: 0.7, bolt: 0.8,
  // firearms, from each recording's measured energy (scripts/audio-stats.py) toward a target loudness per weapon class:
  // marksman rifles loudest, shotguns next, then the machine guns (one clip per burst), rifles, SMGs, and pistols lightest
  mosin: 1.3, savage: 1.35, arisaka: 1.35, mossberg: 1.25, model12: 1.25, nova: 1.2,
  ak47burst: 0.72, ppshburst: 0.56, ar15: 1.1, tikka: 0.65, carlgustav: 0.84, sks: 1.0, ak47: 0.9, marlin: 1.0, lever1894: 0.93,
  colt1911: 0.73, m1917: 0.65, ppq: 1.0, bersa: 0.74, ruger22: 0.72, sw642: 0.79, singlesix: 1.0,
  // the synthesized-era groups some tests and fallbacks still name
  rifle: 0.45, carbine: 0.38, pellet: 0.38, pistol: 0.3,
  hitsoft: 0.5, hitmetal: 0.55, hitplate: 0.55, hitpunch: 0.5, hitwood: 0.55,
  ui_hover: 0.3, ui_select: 0.55, ui_unit: 0.55, ui_confirm: 0.6, ui_deploy: 0.6, ui_turn: 0.55, ui_ready: 0.5, ui_back: 0.5,
  ui_error: 0.5, ui_toggle: 0.5, ui_open: 0.5, ui_drop: 0.55, ui_win: 0.7, ui_lose: 0.7,
};

export interface Voice {
  /** Sample group, or "" for a purely synthesized voice. */
  group: string;
  /** Other takes of the same job: each shot picks one of `group` and these at random (three bolt rifles for a marksman). */
  alt?: string[];
  /** A recorded BURST: plays once per order (the first round), not once per round. */
  burst?: boolean;
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
  // A recruit's rifle, and the other infantry, each its OWN gun (owner 2026-10-03: "snipe, heavy gunner and regular guy sound the same").
  soldier: { group: "ar15", rate: 1, m: 1 },
  scout: { group: "carlgustav", rate: 1.06, m: 1 },
  jumper: { group: "tikka", rate: 1.1, m: 1 },
  sniper: { group: "mosin", alt: ["savage", "arisaka"], rate: 0.95, m: 1 },
  heavy: { group: "ak47burst", rate: 0.92, m: 1, burst: true },
  striker: { group: "colt1911", rate: 1, m: 1 },
  flamer: { group: "", rate: 1, m: 1, synth: "flame" },
  bazooka: { group: "crack", rate: 0.7, m: 1, synth: "rocket" },
  grenadier: { group: "pop", rate: 0.7, m: 0.85, synth: "thunk" },
  mortar: { group: "blast", rate: 0.55, m: 0.6, synth: "thunk" },
  mortarpit: { group: "blast", rate: 0.5, m: 0.65, synth: "thunk" },
  tank: { group: "cannon", rate: 0.9, m: 1 },
  cannonpost: { group: "cannon", rate: 1.0, m: 1 },
  artillery: { group: "cannon", rate: 0.6, m: 1.15 },
  exturret: { group: "cannon", rate: 0.74, m: 0.9 },
  base: { group: "cannon", rate: 1.15, m: 0.7 },
  flak: { group: "crack", rate: 1.35, m: 0.8 },
  gunship: { group: "ppshburst", rate: 1.1, m: 1, burst: true },
  turret: { group: "marlin", alt: ["lever1894"], rate: 0.9, m: 1 },
  bunker: { group: "ak47burst", rate: 0.8, m: 1, burst: true },
  gunpost: { group: "ppshburst", rate: 0.9, m: 1, burst: true },
  rocketpost: { group: "crack", rate: 0.62, m: 1, synth: "rocket" },
  flamepost: { group: "", rate: 0.9, m: 1, synth: "flame" },
  sentry: { group: "marlin", rate: 1.35, m: 0.75 },
  turrettech: { group: "sw642", rate: 1.05, m: 0.9 },
  sledge: { group: "singlesix", rate: 0.8, m: 0.9 },
  lancer: { group: "sks", alt: ["ar15"], rate: 1.18, m: 1 },
  ironclad: { group: "lever1894", rate: 0.85, m: 1 },
  breaker: { group: "m1917", rate: 1.15, m: 1 },
  juggernaut: { group: "cannon", rate: 1.32, m: 0.8 },
  hookshot: { group: "crack", rate: 0.9, m: 0.8, synth: "whoosh" },
  skater: { group: "bersa", rate: 1.25, m: 0.9 },
  molotov: { group: "", rate: 1, m: 1, synth: "whoosh" },
  mole: { group: "ruger22", rate: 1.0, m: 0.9 },
  runabout: { group: "ppshburst", rate: 1.12, m: 0.9, burst: true },
  hornet: { group: "cannon", rate: 1.18, m: 0.85 },
};
/** A hand grenade leaving a hand, and a bomb leaving a bay. */
const THROW_VOICE: Voice = { group: "", rate: 1, m: 1, synth: "whoosh" };
const BOMB_VOICE: Voice = { group: "pop", rate: 0.5, m: 0.6 };
const AIR = new Set(["gunship", "bomber"]);

/** The sound of a round leaving its barrel. Pure. */
export function voiceFor(kind: ShotKind, source?: string): Voice {
  if (kind === "grenade" && source === "soldier") return THROW_VOICE;
  if (kind === "grenade" && source && AIR.has(source)) return BOMB_VOICE;
  return (source && GUN_VOICES[source]) || GUN_VOICES.soldier;
}

/** Which impact material a hit lands on, from what was hit. Pure. */
export function impactClass(kind: string, coverKind?: string): "hitsoft" | "hitmetal" | "hitplate" | "hitwood" {
  const SOFT = new Set(["soldier", "scout", "sniper", "striker", "heavy", "grenadier", "mortar", "flamer", "jumper", "bazooka", "turrettech", "sledge", "lancer", "ironclad", "breaker", "boomer", "juggernaut", "hookshot", "skater", "molotov", "mole"]);
  if (SOFT.has(kind)) return "hitsoft";
  if (kind === "cover") {
    const wood = new Set(["tree", "crate", "log", "stump", "bush", "haybale", "fence", "rack", "tent", "hut", "boat", "barricade", "sandbag", "bones", "grave"]);
    return coverKind && wood.has(coverKind) ? "hitwood" : "hitplate";
  }
  if (kind === "base" || kind === "wall" || kind === "bunker" || kind === "gunpost" || kind === "mortarpit" || kind === "rocketpost" || kind === "flamepost" || kind === "cannonpost") return "hitplate";
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
  private sample(group: string, gain = 1, rate = 1, minGap = 0.035): boolean {
    const buffers = this.samples.get(group);
    if (!buffers || !this.ctx || !this.master || this.muted) return buffers ? true : false;
    const now = this.ctx.currentTime;
    // A burst of the same sound inside a few ms is one sound (a heavy gunner's ten rounds stay a rattle, not a wall).
    if (now - (this.lastPlayed.get(group) ?? -1) < minGap || this.voices >= MAX_VOICES) return true;
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
  shot(kind: ShotKind, source?: string, gain = 1, orderId?: string): void {
    const v = voiceFor(kind, source);
    // A recorded burst is ONE clip per order: the other nine rounds of a machine gun's burst stay silent.
    if (v.burst && orderId) {
      if (this.lastBurstOrder === orderId) return;
      this.lastBurstOrder = orderId;
    }
    if (v.synth) this.synthVoice(v.synth, gain);
    const group = v.alt?.length ? [v.group, ...v.alt][Math.floor(Math.random() * (v.alt.length + 1))] : v.group;
    if (group && this.sample(group, (GROUP_GAIN[group] ?? 0.5) * v.m * gain, v.rate, v.burst ? 0 : 0.035)) return;
    if (v.synth) return;
    if (kind === "shell") this.boom(150, 0.16, 0.5 * gain);
    else if (kind === "bolt") this.zap(620, 0.09);
    else this.crack(0.05);
  }
  private lastBurstOrder = "";

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

  /** The freight train: a two-note horn, twice, over a low rumble. */
  horn(gain = 1): void {
    for (const at of [0, 0.7]) {
      this.blip(196, 0.55, "sawtooth", 0.11 * gain, at);
      this.blip(247, 0.55, "sawtooth", 0.09 * gain, at);
    }
    this.boom(42, 1.4, 0.4 * gain);
  }

  /** A placed item landing: a soft thud. */
  place(gain = 1): void {
    if (this.sample("hitplate", GROUP_GAIN.hitplate * 0.9 * gain, 0.75)) return;
    this.thunk(140, 0.1);
  }

  /** Every unit's orders are in: a soft chime that says "end the turn". */
  allSet(): void {
    if (this.sample("ui_ready", GROUP_GAIN.ui_ready, 1, 0.2)) return;
    this.blip(784, 0.12, "sine", 0.14);
    this.blip(1175, 0.2, "sine", 0.12, 0.1);
  }

  /** Cash banked: two bright rising notes. */
  coin(gain = 1): void {
    this.blip(1320 * 0.75, 0.07, "triangle", 0.14 * gain);
    this.blip(1760 * 0.75, 0.16, "triangle", 0.12 * gain, 0.07);
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

  /** An achievement unlocking: a short rising three-note chime, bright and clean. */
  achievement(): void {
    this.blip(660, 0.09, "triangle", 0.16);
    this.blip(880, 0.09, "triangle", 0.16, 0.09);
    this.blip(1320, 0.2, "triangle", 0.18, 0.18);
  }

  /** Two rounds meeting in the air: a bright metal ping for small arms, a ringing crack for a sniper bolt, a bang for a shell. */
  clash(family: "spark" | "bolt" | "blast", gain = 1): void {
    if (family === "blast") { this.explosion(1.3, 0.75 * gain); return; }
    if (this.sample("hitmetal", GROUP_GAIN.hitmetal * (family === "bolt" ? 1.15 : 0.8) * gain, family === "bolt" ? 1.25 : 1.35)) return;
    this.thunk(family === "bolt" ? 320 : 460, 0.06);
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

  // ---- ambience: each map's own air (wind, hum, birds, distant guns), quiet, under the effects bus ----
  private amb: { map: string; stop: () => void } | undefined;
  private nextAmbEvent = 0;

  /** Name the map ("" for none): its ambience fades in. Wind that fits the place, not a single loop for all six. */
  setAmbience(map: string): void {
    if (this.amb?.map === map) return;
    this.amb?.stop();
    this.amb = undefined;
    const ctx = this.ctx;
    if (!ctx || !this.master || !map) return;
    const noise = (): AudioBufferSourceNode => {
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true; src.start();
      return src;
    };
    // [filter type, frequency, Q, level, gust rate Hz, gust depth 0..1]
    const WIND: Record<string, [BiquadFilterType, number, number, number, number, number]> = {
      dustbowl: ["bandpass", 520, 0.7, 0.05, 0.11, 0.6],  // dry desert wind, long gusts
      ironworks: ["lowpass", 140, 0.5, 0.05, 0.05, 0.2],  // furnace roar: low and steady
      verdant: ["highpass", 2400, 0.4, 0.022, 0.15, 0.5], // a light breeze through leaves
      causeway: ["bandpass", 360, 0.5, 0.06, 0.08, 0.8],  // cold gusty wind
      karak: ["bandpass", 240, 0.9, 0.04, 0.06, 0.5],     // hollow, low
      crossfire: ["lowpass", 110, 0.5, 0.04, 0.04, 0.3],  // distant rumble
    };
    const w = WIND[map] ?? WIND.dustbowl;
    const src = noise();
    const filter = ctx.createBiquadFilter(); filter.type = w[0]; filter.frequency.value = w[1]; filter.Q.value = w[2];
    const level = ctx.createGain(); level.gain.value = 0;
    const gust = ctx.createOscillator(); gust.frequency.value = w[4];
    const gustDepth = ctx.createGain(); gustDepth.gain.value = w[3] * w[5];
    gust.connect(gustDepth).connect(level.gain); gust.start();
    src.connect(filter).connect(level).connect(this.master);
    level.gain.setTargetAtTime(w[3], ctx.currentTime, 1.5);
    const extras: OscillatorNode[] = [];
    if (map === "ironworks" || map === "karak") {
      // a machine hum / a temple drone
      for (const f of map === "ironworks" ? [55, 82.5] : [49, 73.4]) {
        const o = ctx.createOscillator(); o.type = map === "ironworks" ? "sawtooth" : "sine"; o.frequency.value = f;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 180;
        const g = ctx.createGain(); g.gain.value = map === "ironworks" ? 0.012 : 0.02;
        o.connect(lp).connect(g).connect(this.master); o.start(); extras.push(o);
      }
    }
    this.nextAmbEvent = ctx.currentTime + 3;
    this.amb = {
      map,
      stop: () => {
        level.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
        window.setTimeout(() => { try { src.stop(); gust.stop(); for (const o of extras) o.stop(); } catch { /* already stopped */ } }, 1500);
      },
    };
  }

  /** Per-frame: the occasional bird (Verdant) or far-off gun (Crossfire). */
  tickAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.amb || this.muted || ctx.currentTime < this.nextAmbEvent) return;
    this.nextAmbEvent = ctx.currentTime + 4 + Math.random() * 6;
    if (this.amb.map === "verdant") {
      const base = 2200 + Math.random() * 900;
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i += 1) {
        const t = ctx.currentTime + i * 0.13;
        const o = ctx.createOscillator(); o.type = "sine";
        o.frequency.setValueAtTime(base, t); o.frequency.exponentialRampToValueAtTime(base * 1.35, t + 0.09);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.025, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        o.connect(g).connect(this.master!); o.start(t); o.stop(t + 0.14);
      }
    } else if (this.amb.map === "crossfire") {
      this.sample("boomdeep", 0.07, 0.5 + Math.random() * 0.2); // a far-off gun
    } else if (this.amb.map === "ironworks") {
      this.sample("hitmetal", 0.05, 0.5 + Math.random() * 0.3); // a distant clank
    }
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

  // ---- the interface: recorded Kenney sounds (CC0), each job its own sound, the old synth blips only as the fallback ----

  /** A plain button press. */
  ui(): void {
    if (this.sample("ui_select", GROUP_GAIN.ui_select, 1, 0.03)) return;
    this.blip(540, 0.04, "triangle", 0.18);
  }

  /** The pointer moving onto something clickable: barely there. */
  hover(): void {
    this.sample("ui_hover", GROUP_GAIN.ui_hover, 1, 0.05);
  }

  /** A unit picked on the board or in the roster. */
  unit(): void {
    if (this.sample("ui_unit", GROUP_GAIN.ui_unit, 1, 0.05)) return;
    this.blip(720, 0.05, "sine", 0.2);
  }

  /** A refused order. */
  error(): void {
    if (this.sample("ui_error", GROUP_GAIN.ui_error, 1, 0.08)) return;
    this.blip(220, 0.07, "square", 0.12);
    this.blip(196, 0.09, "square", 0.1, 0.06);
  }

  /** An order accepted. */
  select(): void {
    if (this.sample("ui_confirm", GROUP_GAIN.ui_confirm, 1, 0.05)) return;
    this.blip(720, 0.05, "sine", 0.2);
  }

  /** Back / cancel / closing something. */
  back(): void {
    if (this.sample("ui_back", GROUP_GAIN.ui_back, 1, 0.05)) return;
    this.blip(330, 0.06, "sine", 0.14);
  }

  toggle(): void {
    if (this.sample("ui_toggle", GROUP_GAIN.ui_toggle, 1, 0.05)) return;
    this.blip(640, 0.04, "triangle", 0.16);
  }

  /** A menu or panel opening. */
  open(): void {
    if (this.sample("ui_open", GROUP_GAIN.ui_open, 1, 0.1)) return;
    this.blip(400, 0.06, "sine", 0.16);
  }

  deploy(): void {
    if (this.sample("ui_deploy", GROUP_GAIN.ui_deploy, 1, 0.1) && this.sample("ui_drop", GROUP_GAIN.ui_drop, 1, 0)) return;
    this.blip(330, 0.08, "sawtooth", 0.22);
    this.blip(440, 0.1, "sawtooth", 0.16, 0.06);
  }

  build(): void {
    if (this.sample("ui_drop", GROUP_GAIN.ui_drop, 0.9, 0.08)) return;
    this.thunk(160, 0.14);
    this.blip(300, 0.06, "square", 0.16, 0.05);
  }

  /** Ending the turn / a strike called. */
  turn(): void {
    if (this.sample("ui_turn", GROUP_GAIN.ui_turn, 1, 0.1)) return;
    this.blip(420, 0.07, "sine", 0.22);
    this.blip(560, 0.09, "sine", 0.18, 0.07);
  }

  victory(): void {
    if (this.sample("ui_win", GROUP_GAIN.ui_win, 1, 0)) { window.setTimeout(() => this.sample("ui_win", GROUP_GAIN.ui_win, 1.12, 0), 260); return; }
    [523, 659, 784, 1046].forEach((f, i) => this.blip(f, 0.16, "triangle", 0.24, i * 0.12));
  }

  defeat(): void {
    if (this.sample("ui_lose", GROUP_GAIN.ui_lose, 0.85, 0)) return;
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
