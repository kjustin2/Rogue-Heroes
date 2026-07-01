// 100% procedural ambient music, layered by game state (no asset files, matching the
// synthesized SFX layer). A slow detuned drone + filtered wind runs everywhere; a sparse
// pentatonic pulse joins during the command phase; kick/hat/bass percussion drives the
// resolve phase; everything fades for the victory/defeat stingers.
//
// The frame loop calls update() every frame: it lazily builds the graph once the shared
// AudioContext exists (first user gesture) and schedules notes ~0.6s ahead of the clock.
// Not sim code — Math.random() is fine here.

import { sfx } from "./audio";

export type MusicState = "menu" | "command" | "resolve" | "end";

// A-minor pentatonic pool for the command-phase pulse.
const PULSE_NOTES = [220, 261.63, 293.66, 329.63, 392];
const STEP = 0.42; // resolve percussion step (s)

export class MusicDirector {
  private ctx: AudioContext | undefined;
  private out: GainNode | undefined; // musicVolume
  private droneGain: GainNode | undefined;
  private windGain: GainNode | undefined;
  private pulseGain: GainNode | undefined;
  private drumGain: GainNode | undefined;
  private droneFilter: BiquadFilterNode | undefined;
  private state: MusicState = "menu";
  private volume = 0.5;
  private nextPulseAt = 0;
  private nextStepAt = 0;
  private step = 0;

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
  }

  setState(state: MusicState): void {
    if (state === this.state) return;
    this.state = state;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Cross-fade the layers to the new state over ~1.2s.
    this.droneGain?.gain.setTargetAtTime(state === "end" ? 0 : 1, t, 0.5);
    this.windGain?.gain.setTargetAtTime(state === "end" ? 0 : 1, t, 0.5);
    this.pulseGain?.gain.setTargetAtTime(state === "command" || state === "menu" ? 1 : 0, t, 0.4);
    this.drumGain?.gain.setTargetAtTime(state === "resolve" ? 1 : 0, t, 0.3);
    // Resolve pushes the drone filter open a touch — more edge under fire.
    this.droneFilter?.frequency.setTargetAtTime(state === "resolve" ? 620 : 360, t, 0.8);
  }

  /** Called every frame: builds the graph once audio is unlocked, then schedules ahead. */
  update(): void {
    if (!this.ctx) {
      const ctx = sfx.audioContext;
      const master = sfx.masterGain;
      if (!ctx || !master) return;
      this.build(ctx, master);
    }
    const ctx = this.ctx!;
    if (ctx.state !== "running") return;
    const horizon = ctx.currentTime + 0.6;
    while (this.nextPulseAt < horizon) this.schedulePulse();
    while (this.nextStepAt < horizon) this.scheduleStep();
  }

  private build(ctx: AudioContext, master: GainNode): void {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;
    this.out.connect(master);

    // Drone: two saws an octave apart, detuned, through a slow-moving lowpass.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 1;
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = "lowpass";
    this.droneFilter.frequency.value = 360;
    this.droneFilter.Q.value = 0.7;
    const droneLevel = ctx.createGain();
    droneLevel.gain.value = 0.05;
    for (const [freq, detune] of [[55, -5], [110, 6], [110, -9]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(droneLevel);
      osc.start();
    }
    // Slow filter sweep gives the pad motion without a melody.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 120;
    lfo.connect(lfoDepth).connect(this.droneFilter.frequency);
    lfo.start();
    droneLevel.connect(this.droneFilter).connect(this.droneGain).connect(this.out);

    // Wind: looped noise through a wandering bandpass.
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 1;
    const windLevel = ctx.createGain();
    windLevel.gain.value = 0.028;
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 420;
    windFilter.Q.value = 0.6;
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = 0.07;
    const windLfoDepth = ctx.createGain();
    windLfoDepth.gain.value = 180;
    windLfo.connect(windLfoDepth).connect(windFilter.frequency);
    windLfo.start();
    noise.connect(windFilter).connect(windLevel).connect(this.windGain).connect(this.out);
    noise.start();

    // Layer buses for the scheduled voices.
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 1;
    this.pulseGain.connect(this.out);
    this.drumGain = ctx.createGain();
    this.drumGain.gain.value = 0;
    this.drumGain.connect(this.out);

    this.nextPulseAt = ctx.currentTime + 1;
    this.nextStepAt = ctx.currentTime + 0.5;
    // Re-assert the current state so layer gains match (build happens after setState calls).
    const state = this.state;
    this.state = "end";
    this.setState(state);
  }

  // Sparse pentatonic tone, slow attack/release — the "planning" texture.
  private schedulePulse(): void {
    const ctx = this.ctx!;
    const at = this.nextPulseAt;
    this.nextPulseAt = at + 1.9 + Math.random() * 1.7;
    if (Math.random() < 0.3) return; // rests keep it sparse
    const freq = PULSE_NOTES[Math.floor(Math.random() * PULSE_NOTES.length)];
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = Math.random() < 0.22 ? freq / 2 : freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.055, at + 0.5);
    env.gain.exponentialRampToValueAtTime(0.0008, at + 2.4);
    osc.connect(env).connect(this.pulseGain!);
    osc.start(at);
    osc.stop(at + 2.5);
  }

  // Kick / hat / bass step sequencer — the "under fire" drive during resolve.
  private scheduleStep(): void {
    const ctx = this.ctx!;
    const at = this.nextStepAt;
    this.nextStepAt = at + STEP;
    const step = this.step;
    this.step = (this.step + 1) % 16;
    const bus = this.drumGain!;
    if (step % 4 === 0) {
      const kick = ctx.createOscillator();
      kick.type = "sine";
      kick.frequency.setValueAtTime(120, at);
      kick.frequency.exponentialRampToValueAtTime(42, at + 0.16);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.4, at);
      env.gain.exponentialRampToValueAtTime(0.001, at + 0.2);
      kick.connect(env).connect(bus);
      kick.start(at);
      kick.stop(at + 0.22);
    }
    if (step % 2 === 1) {
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
      const d = buffer.getChannelData(0);
      for (let i = 0; i < d.length; i += 1) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const hat = ctx.createBufferSource();
      hat.buffer = buffer;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 6200;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.09, at);
      env.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
      hat.connect(hp).connect(env).connect(bus);
      hat.start(at);
      hat.stop(at + 0.05);
    }
    if (step % 8 === 0) {
      const bass = ctx.createOscillator();
      bass.type = "square";
      bass.frequency.value = step === 0 ? 55 : 49; // A1 / G1 alternation
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 240;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(0.11, at + 0.03);
      env.gain.exponentialRampToValueAtTime(0.001, at + STEP * 3.4);
      bass.connect(lp).connect(env).connect(bus);
      bass.start(at);
      bass.stop(at + STEP * 3.5);
    }
  }
}

export const music = new MusicDirector();
