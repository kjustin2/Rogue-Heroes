// Commander profile: lifetime stats, medals, and doctrine mastery, persisted across
// battles in localStorage. Purely a trophy case — no gameplay effect. The Achievements page
// on the main menu is its home.

import { FACTIONS } from "./game/factions";
import { MAPS } from "./game/maps";
import { PLAYABLE_MODES } from "./game/modes";

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
  /** Lifetime counters behind the higher-tier medals (added 2026-10-02; older saves default to zero). */
  winStreak: number;
  bestStreak: number;
  flawlessWins: number;
  hardWins: number;
  mapWinCount: Record<string, number>;
  factionWinCount: Record<string, number>;
  fastestWin: number;
}

export type MedalPage = "Campaign" | "Kills" | "Skill" | "Range";
export const MEDAL_PAGES: readonly MedalPage[] = ["Campaign", "Kills", "Skill", "Range"];

export interface MedalDef {
  id: string;
  name: string;
  blurb: string;
  /** Which Achievements page shows it. */
  page: MedalPage;
  /** [have, need] for a counted medal, so the page can show how close it is. */
  progress?: (s: CommanderStats) => [number, number];
}

const AIR_KINDS = ["gunship", "interceptor", "bomber", "transport"];
const VEHICLE_KINDS = ["tank", "apc", "artillery", "flak"];
const killsOf = (s: CommanderStats, kinds: string[]): number => kinds.reduce((sum, k) => sum + (s.killsByKind[k] ?? 0), 0);
const INFANTRY_KILLS = (s: CommanderStats): number => s.kills - killsOf(s, AIR_KINDS) - killsOf(s, VEHICLE_KINDS);

export const MEDALS: readonly MedalDef[] = [
  // ---- CAMPAIGN: wins and battles fought, each a bigger number than the last ----
  { id: "first-victory", page: "Campaign", name: "First Blood", blurb: "Win your first battle." },
  { id: "warlord", page: "Campaign", name: "Warlord", blurb: "Win 10 battles.", progress: (s) => [s.wins, 10] },
  { id: "conqueror", page: "Campaign", name: "Conqueror", blurb: "Win 25 battles.", progress: (s) => [s.wins, 25] },
  { id: "overlord", page: "Campaign", name: "Overlord", blurb: "Win 50 battles.", progress: (s) => [s.wins, 50] },
  { id: "legend", page: "Campaign", name: "Living Legend", blurb: "Win 100 battles.", progress: (s) => [s.wins, 100] },
  { id: "veteran", page: "Campaign", name: "Old Soldier", blurb: "Fight 25 battles.", progress: (s) => [s.battles, 25] },
  { id: "career", page: "Campaign", name: "Career Soldier", blurb: "Fight 75 battles.", progress: (s) => [s.battles, 75] },
  { id: "lifer", page: "Campaign", name: "Lifer", blurb: "Fight 200 battles.", progress: (s) => [s.battles, 200] },
  { id: "streak3", page: "Campaign", name: "On a Roll", blurb: "Win 3 battles in a row.", progress: (s) => [s.bestStreak, 3] },
  { id: "streak7", page: "Campaign", name: "Unstoppable", blurb: "Win 7 battles in a row.", progress: (s) => [s.bestStreak, 7] },
  { id: "streak15", page: "Campaign", name: "Undefeated", blurb: "Win 15 battles in a row.", progress: (s) => [s.bestStreak, 15] },
  { id: "mastery5", page: "Campaign", name: "Student of War", blurb: "Earn 5 doctrine mastery stars.", progress: (s) => [masteryStars(s), 5] },
  { id: "mastery15", page: "Campaign", name: "Master Tactician", blurb: "Earn 15 doctrine mastery stars.", progress: (s) => [masteryStars(s), 15] },
  { id: "mastery30", page: "Campaign", name: "Grand Strategist", blurb: "Earn 30 doctrine mastery stars.", progress: (s) => [masteryStars(s), 30] },
  // ---- KILLS: lifetime tallies, overall and by arm ----
  { id: "kills25", page: "Kills", name: "Blooded", blurb: "Reach 25 lifetime unit kills.", progress: (s) => [s.kills, 25] },
  { id: "centurion", page: "Kills", name: "Centurion", blurb: "Reach 100 lifetime unit kills.", progress: (s) => [s.kills, 100] },
  { id: "kills250", page: "Kills", name: "Reaper", blurb: "Reach 250 lifetime unit kills.", progress: (s) => [s.kills, 250] },
  { id: "kills500", page: "Kills", name: "Executioner", blurb: "Reach 500 lifetime unit kills.", progress: (s) => [s.kills, 500] },
  { id: "kills1000", page: "Kills", name: "Death Incarnate", blurb: "Reach 1,000 lifetime unit kills.", progress: (s) => [s.kills, 1000] },
  { id: "kills2500", page: "Kills", name: "Extinction Event", blurb: "Reach 2,500 lifetime unit kills.", progress: (s) => [s.kills, 2500] },
  { id: "foot50", page: "Kills", name: "Infantry Hunter", blurb: "Destroy 50 foot soldiers.", progress: (s) => [INFANTRY_KILLS(s), 50] },
  { id: "foot250", page: "Kills", name: "Trench Sweeper", blurb: "Destroy 250 foot soldiers.", progress: (s) => [INFANTRY_KILLS(s), 250] },
  { id: "armor10", page: "Kills", name: "Tank Buster", blurb: "Destroy 10 vehicles.", progress: (s) => [killsOf(s, VEHICLE_KINDS), 10] },
  { id: "armor50", page: "Kills", name: "Iron Breaker", blurb: "Destroy 50 vehicles.", progress: (s) => [killsOf(s, VEHICLE_KINDS), 50] },
  { id: "air10", page: "Kills", name: "Sky Hunter", blurb: "Shoot down 10 aircraft.", progress: (s) => [killsOf(s, AIR_KINDS), 10] },
  { id: "air40", page: "Kills", name: "Ace", blurb: "Shoot down 40 aircraft.", progress: (s) => [killsOf(s, AIR_KINDS), 40] },
  // ---- SKILL: how well a battle was won ----
  { id: "flawless", page: "Skill", name: "Flawless Command", blurb: "Win a battle without losing a single unit." },
  { id: "flawless5", page: "Skill", name: "Perfectionist", blurb: "Win 5 battles without losing a unit.", progress: (s) => [s.flawlessWins, 5] },
  { id: "flawless15", page: "Skill", name: "Untouchable", blurb: "Win 15 battles without losing a unit.", progress: (s) => [s.flawlessWins, 15] },
  { id: "blitz", page: "Skill", name: "Blitz", blurb: "Win a battle in 5 turns or fewer." },
  { id: "lightning", page: "Skill", name: "Lightning War", blurb: "Win a battle in 3 turns or fewer." },
  { id: "iron", page: "Skill", name: "Iron Commander", blurb: "Win a battle on Hard." },
  { id: "iron5", page: "Skill", name: "Hard as Nails", blurb: "Win 5 battles on Hard.", progress: (s) => [s.hardWins, 5] },
  { id: "iron20", page: "Skill", name: "Elite Command", blurb: "Win 20 battles on Hard.", progress: (s) => [s.hardWins, 20] },
  { id: "clutch", page: "Skill", name: "Clutch Win", blurb: "Win with your Home Base under a quarter of its health." },
  { id: "clutch10", page: "Skill", name: "Last Stand", blurb: "Win with your Home Base under a tenth of its health." },
  { id: "demolitionist", page: "Skill", name: "Demolitionist", blurb: "Topple a pillar, obelisk, girder, tower or tree during a winning battle." },
  // ---- RANGE: every map, mode and faction, then again ----
  { id: "world-tour", page: "Range", name: "World Tour", blurb: "Win on every battlefield.", progress: (s) => [s.mapWins.length, MAPS.length] },
  { id: "world-tour3", page: "Range", name: "Homefront Hero", blurb: "Win 3 times on every battlefield.", progress: (s) => [MAPS.filter((m) => (s.mapWinCount[m.id] ?? 0) >= 3).length, MAPS.length] },
  { id: "world-tour8", page: "Range", name: "Lord of the Maps", blurb: "Win 8 times on every battlefield.", progress: (s) => [MAPS.filter((m) => (s.mapWinCount[m.id] ?? 0) >= 8).length, MAPS.length] },
  { id: "rulebook", page: "Range", name: "Every Rule", blurb: "Win in every game mode.", progress: (s) => [s.modeWins.filter((m) => PLAYABLE_MODES.some((p) => p.id === m)).length, PLAYABLE_MODES.length] },
  { id: "banners", page: "Range", name: "Every Banner", blurb: "Win with every faction.", progress: (s) => [s.factionWins.length, FACTIONS.length] },
  { id: "banners5", page: "Range", name: "Loyal Banner", blurb: "Win 5 times with every faction.", progress: (s) => [FACTIONS.filter((f) => (s.factionWinCount[f.id] ?? 0) >= 5).length, FACTIONS.length] },
  { id: "banners15", page: "Range", name: "Faction Master", blurb: "Win 15 times with every faction.", progress: (s) => [FACTIONS.filter((f) => (s.factionWinCount[f.id] ?? 0) >= 15).length, FACTIONS.length] },
  { id: "combined-arms", page: "Range", name: "Combined Arms", blurb: "Win with infantry, a vehicle and an aircraft all still on the field." },
];

function masteryStars(s: CommanderStats): number {
  return Object.values(s.doctrineUse).reduce((sum, uses) => sum + (uses >= 10 ? 3 : uses >= 6 ? 2 : uses >= 3 ? 1 : 0), 0);
}

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
const EMPTY = (): CommanderStats => ({
  battles: 0, wins: 0, losses: 0, kills: 0, killsByKind: {}, doctrineUse: {}, medals: [], mapWins: [], modeWins: [], factionWins: [],
  winStreak: 0, bestStreak: 0, flawlessWins: 0, hardWins: 0, mapWinCount: {}, factionWinCount: {}, fastestWin: 0,
});

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
    if (input.victory) {
      s.wins += 1;
      s.winStreak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.winStreak);
      if (input.losses === 0) s.flawlessWins += 1;
      if (input.difficulty === "hard") s.hardWins += 1;
      if (input.map) s.mapWinCount[input.map] = (s.mapWinCount[input.map] ?? 0) + 1;
      if (input.faction) s.factionWinCount[input.faction] = (s.factionWinCount[input.faction] ?? 0) + 1;
      s.fastestWin = s.fastestWin ? Math.min(s.fastestWin, input.turns) : input.turns;
    } else {
      s.losses += 1;
      s.winStreak = 0;
    }
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
    earn("clutch", input.victory && input.baseHealth !== undefined && input.baseHealth < 0.25);
    earn("combined-arms", input.victory && Boolean(input.arms?.infantry && input.arms.vehicle && input.arms.air));
    earn("world-tour", s.mapWins.length >= MAPS.length);
    earn("rulebook", PLAYABLE_MODES.every((m) => s.modeWins.includes(m.id)));
    earn("banners", s.factionWins.length >= FACTIONS.length);
    earn("veteran", s.battles >= 25);
    // Higher tiers of the same trophies, and the new page-fillers (2026-10-02).
    const total = (id: string, n: number, value: number): void => earn(id, value >= n);
    total("conqueror", 25, s.wins); total("overlord", 50, s.wins); total("legend", 100, s.wins);
    total("career", 75, s.battles); total("lifer", 200, s.battles);
    total("streak3", 3, s.bestStreak); total("streak7", 7, s.bestStreak); total("streak15", 15, s.bestStreak);
    total("mastery5", 5, masteryStars(s)); total("mastery15", 15, masteryStars(s)); total("mastery30", 30, masteryStars(s));
    total("kills25", 25, s.kills); total("kills250", 250, s.kills); total("kills500", 500, s.kills); total("kills1000", 1000, s.kills); total("kills2500", 2500, s.kills);
    total("foot50", 50, INFANTRY_KILLS(s)); total("foot250", 250, INFANTRY_KILLS(s));
    total("armor10", 10, killsOf(s, VEHICLE_KINDS)); total("armor50", 50, killsOf(s, VEHICLE_KINDS));
    total("air10", 10, killsOf(s, AIR_KINDS)); total("air40", 40, killsOf(s, AIR_KINDS));
    total("flawless5", 5, s.flawlessWins); total("flawless15", 15, s.flawlessWins);
    earn("lightning", input.victory && input.turns <= 3);
    total("iron5", 5, s.hardWins); total("iron20", 20, s.hardWins);
    earn("clutch10", input.victory && input.baseHealth !== undefined && input.baseHealth < 0.1);
    earn("world-tour3", MAPS.every((m) => (s.mapWinCount[m.id] ?? 0) >= 3));
    earn("world-tour8", MAPS.every((m) => (s.mapWinCount[m.id] ?? 0) >= 8));
    earn("banners5", FACTIONS.every((f) => (s.factionWinCount[f.id] ?? 0) >= 5));
    earn("banners15", FACTIONS.every((f) => (s.factionWinCount[f.id] ?? 0) >= 15));
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
