// Commander profile: lifetime stats, medals, and doctrine mastery, persisted across
// battles in localStorage. Purely a trophy case — no gameplay effect. The Achievements page
// on the main menu is its home.

import { FACTIONS } from "./game/factions";
import { MAPS } from "./game/maps";
import { MODES } from "./game/modes";

export interface CommanderStats {
  battles: number;
  wins: number;
  losses: number;
  kills: number;
  killsByKind: Record<string, number>;
  doctrineUse: Record<string, number>;
  medals: string[];
  /** Distinct maps / modes / factions won at least once (for the "every X" medals). */
  mapWins: string[];
  modeWins: string[];
  factionWins: string[];
}

export interface MedalDef {
  id: string;
  name: string;
  blurb: string;
  /** [have, need] for a counted medal, so the page can show how close it is. */
  progress?: (s: CommanderStats) => [number, number];
}

export const MEDALS: readonly MedalDef[] = [
  { id: "first-victory", name: "First Blood", blurb: "Win your first battle." },
  { id: "flawless", name: "Flawless Command", blurb: "Win a battle without losing a single unit." },
  { id: "blitz", name: "Blitz", blurb: "Win a battle in 5 turns or fewer." },
  { id: "demolitionist", name: "Demolitionist", blurb: "Topple a pillar or tree during a winning battle." },
  { id: "warlord", name: "Warlord", blurb: "Win 10 battles.", progress: (s) => [s.wins, 10] },
  { id: "centurion", name: "Centurion", blurb: "Reach 100 lifetime unit kills.", progress: (s) => [s.kills, 100] },
  { id: "iron", name: "Iron Commander", blurb: "Win a battle on Hard." },
  { id: "last-stand", name: "Last Stand", blurb: "Win with your Home Base under a quarter of its health." },
  { id: "combined-arms", name: "Combined Arms", blurb: "Win with infantry, a vehicle and an aircraft all still on the field." },
  { id: "world-tour", name: "World Tour", blurb: "Win on every battlefield.", progress: (s) => [s.mapWins.length, MAPS.length] },
  { id: "rulebook", name: "Every Rule", blurb: "Win in every game mode.", progress: (s) => [s.modeWins.length, MODES.length] },
  { id: "banners", name: "Every Banner", blurb: "Win with every faction.", progress: (s) => [s.factionWins.length, FACTIONS.length] },
  { id: "veteran", name: "Old Soldier", blurb: "Fight 25 battles.", progress: (s) => [s.battles, 25] },
];

/** Everything about a finished battle the medals look at. */
export interface BattleRecord {
  victory: boolean;
  turns: number;
  losses: number;
  killsByKind: Record<string, number>;
  toppleHappened: boolean;
  map?: string;
  mode?: string;
  faction?: string;
  difficulty?: string;
  /** Player base health left, 0..1. */
  baseHealth?: number;
  /** Which arms the player still had on the field at the end. */
  arms?: { infantry: boolean; vehicle: boolean; air: boolean };
}

const KEY = "rht.commander.v1";
const EMPTY = (): CommanderStats => ({ battles: 0, wins: 0, losses: 0, kills: 0, killsByKind: {}, doctrineUse: {}, medals: [], mapWins: [], modeWins: [], factionWins: [] });

export class Commander {
  stats: CommanderStats = EMPTY();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.stats = { ...EMPTY(), ...(JSON.parse(raw) as Partial<CommanderStats>) };
    } catch {
      // ignore
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.stats));
    } catch {
      // ignore
    }
  }

  recordResearch(nodeId: string): void {
    this.stats.doctrineUse[nodeId] = (this.stats.doctrineUse[nodeId] ?? 0) + 1;
    this.save();
  }

  /** Mastery tier for a doctrine: I at 3 lifetime researches, II at 6, III at 10. */
  masteryTier(nodeId: string): number {
    const uses = this.stats.doctrineUse[nodeId] ?? 0;
    return uses >= 10 ? 3 : uses >= 6 ? 2 : uses >= 3 ? 1 : 0;
  }

  /** Total mastery "stars" summed across every doctrine — drives slow cosmetic unlocks. */
  totalMastery(): number {
    return Object.keys(this.stats.doctrineUse).reduce((sum, id) => sum + this.masteryTier(id), 0);
  }

  /**
   * Record a finished battle and return any NEWLY earned medals (for toasts).
   * `killsByKind` is this battle's player kills grouped by victim kind.
   */
  recordBattle(input: BattleRecord): MedalDef[] {
    const s = this.stats;
    s.battles += 1;
    if (input.victory) s.wins += 1;
    else s.losses += 1;
    const add = (list: string[], id?: string): void => { if (input.victory && id && !list.includes(id)) list.push(id); };
    add(s.mapWins, input.map);
    add(s.modeWins, input.mode);
    add(s.factionWins, input.faction);
    for (const [kind, n] of Object.entries(input.killsByKind)) {
      s.killsByKind[kind] = (s.killsByKind[kind] ?? 0) + n;
      s.kills += n;
    }
    const fresh: MedalDef[] = [];
    const earn = (id: string, condition: boolean): void => {
      if (!condition || s.medals.includes(id)) return;
      s.medals.push(id);
      const def = MEDALS.find((m) => m.id === id);
      if (def) fresh.push(def);
    };
    earn("first-victory", input.victory);
    earn("flawless", input.victory && input.losses === 0);
    earn("blitz", input.victory && input.turns <= 5);
    earn("demolitionist", input.victory && input.toppleHappened);
    earn("warlord", s.wins >= 10);
    earn("centurion", s.kills >= 100);
    earn("iron", input.victory && input.difficulty === "hard");
    earn("last-stand", input.victory && input.baseHealth !== undefined && input.baseHealth < 0.25);
    earn("combined-arms", input.victory && Boolean(input.arms?.infantry && input.arms.vehicle && input.arms.air));
    earn("world-tour", s.mapWins.length >= MAPS.length);
    earn("rulebook", s.modeWins.length >= MODES.length);
    earn("banners", s.factionWins.length >= FACTIONS.length);
    earn("veteran", s.battles >= 25);
    this.save();
    return fresh;
  }

  /** The player's deadliest unit kind by lifetime kills. */
  topUnitKind(): string | undefined {
    const entries = Object.entries(this.stats.killsByKind);
    if (!entries.length) return undefined;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  reset(): void {
    this.stats = EMPTY();
    this.save();
  }
}

export const commander = new Commander();
