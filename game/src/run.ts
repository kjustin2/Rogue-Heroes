// Skirmish Run: a short roguelike ladder of auto-generated battles. A seed fixes the whole run
// (map + mode + difficulty per sector) so it reproduces for resume; survivors carry forward as a
// veteran roster (permadeath) and leftover cash banks into the next sector's starting funds. Win
// every sector to clear the run; lose one and the run is over. Built entirely on top of the
// existing battle config + serialize() save + the campaign's veteran roster — no new sim systems.

import { Rng } from "./core/rng";
import type { Difficulty, ModeId } from "./game/sim";
import { MAPS } from "./game/maps";
import { mergeRoster, type RosterMember } from "./campaign";

export interface RunBattle {
  map: string; // map id
  mode: ModeId;
  difficulty: Difficulty;
}

export const RUN_LENGTH = 4;
// Modes that have a clean win condition for a fixed ladder (survival is endless — excluded).
const RUN_MODES: readonly ModeId[] = ["destroy", "hill", "ctf", "domination"];
// Difficulty ramp across the run; falls back to the hardest tier if the run is ever lengthened.
const RUN_DIFFICULTY: readonly Difficulty[] = ["easy", "normal", "normal", "hard"];
// Leftover cash you can bank into the next sector — capped so a runaway economy can't snowball.
const CASH_CARRY_CAP = 300;

const KEY = "rht.run.v1";

interface RunState {
  seed: number;
  index: number;
  roster: RosterMember[];
  bankedCash: number;
  active: boolean;
}

export class SkirmishRun {
  seed = 0;
  index = 0; // 0-based sector currently being played
  roster: RosterMember[] = [];
  bankedCash = 0;
  active = false;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<RunState>;
      this.seed = s.seed ?? 0;
      this.index = s.index ?? 0;
      this.roster = s.roster ?? [];
      this.bankedCash = s.bankedCash ?? 0;
      this.active = s.active ?? false;
    } catch {
      // ignore corrupt/unavailable storage
    }
  }

  private save(): void {
    try {
      const state: RunState = { seed: this.seed, index: this.index, roster: this.roster, bankedCash: this.bankedCash, active: this.active };
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }

  get length(): number {
    return RUN_LENGTH;
  }

  /** 1-based sector number for display. */
  get sectorNumber(): number {
    return this.index + 1;
  }

  // The full battle plan, derived deterministically from the seed so it survives a resume.
  // No back-to-back map repeats keeps the run visually varied.
  plan(): RunBattle[] {
    const rng = new Rng(this.seed || 1);
    const battles: RunBattle[] = [];
    let lastMap = "";
    for (let i = 0; i < RUN_LENGTH; i += 1) {
      let map = rng.pick(MAPS).id;
      let guard = 0;
      while (map === lastMap && guard++ < 8) map = rng.pick(MAPS).id;
      lastMap = map;
      battles.push({ map, mode: rng.pick(RUN_MODES), difficulty: RUN_DIFFICULTY[i] ?? "hard" });
    }
    return battles;
  }

  /** The sector the run is currently on. */
  current(): RunBattle {
    return this.plan()[Math.min(this.index, RUN_LENGTH - 1)];
  }

  begin(seed: number): void {
    this.seed = seed >>> 0 || 1;
    this.index = 0;
    this.roster = [];
    this.bankedCash = 0;
    this.active = true;
    this.save();
  }

  /** Take (and clear) the banked cash for the next sector start. */
  consumeCash(): number {
    const c = this.bankedCash;
    this.bankedCash = 0;
    this.save();
    return c;
  }

  // Clear the current sector: carry survivors forward as veterans, bank leftover cash, advance.
  // Returns true when that was the final sector (run complete → active clears).
  advance(survivors: Array<{ name: string; kind: string; kills: number }>, leftoverCash: number): boolean {
    this.roster = mergeRoster(this.roster, survivors);
    this.bankedCash = Math.min(CASH_CARRY_CAP, Math.max(0, Math.floor(leftoverCash)));
    this.index += 1;
    if (this.index >= RUN_LENGTH) {
      this.active = false;
      this.save();
      return true;
    }
    this.save();
    return false;
  }

  /** End a run without completing it (defeat or abandon). */
  end(): void {
    this.active = false;
    this.bankedCash = 0;
    this.save();
  }

  reset(): void {
    this.seed = 0;
    this.index = 0;
    this.roster = [];
    this.bankedCash = 0;
    this.active = false;
    this.save();
  }
}

export const run = new SkirmishRun();
