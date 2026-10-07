// Commander profile: lifetime stats, medals, and doctrine mastery, persisted across
// battles in localStorage. Purely a trophy case — no gameplay effect. The Achievements page
// on the main menu is its home.

import { FACTIONS } from "./game/factions";
import { MAPS } from "./game/maps";
import { PLAYABLE_MODES } from "./game/modes";
import { SUPPORT_POWERS, TROOP_KINDS } from "./game/units";
import { TECH_TREE } from "./game/tech";

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
  /** Lifetime battle tallies behind the Arsenal medals (sim.stats keys: slams, thrown, burned, deploy:<kind> ...). */
  counters: Record<string, number>;
}

export type MedalPage = "Battles" | "Kills" | "Skill" | "Range" | "Arsenal";
export const MEDAL_PAGES: readonly MedalPage[] = ["Battles", "Kills", "Skill", "Range", "Arsenal"];

export interface MedalDef {
  id: string;
  name: string;
  blurb: string;
  /** Which Achievements page shows it. */
  page: MedalPage;
  /** [have, need] for a counted medal, so the page can show how close it is. */
  progress?: (s: CommanderStats) => [number, number];
  /** Armory points paid once, the moment it is earned. */
  points: number;
}

function EMPTY(): CommanderStats {
  return {
  battles: 0, wins: 0, losses: 0, kills: 0, killsByKind: {}, doctrineUse: {}, medals: [], mapWins: [], modeWins: [], factionWins: [],
  winStreak: 0, bestStreak: 0, flawlessWins: 0, hardWins: 0, mapWinCount: {}, factionWinCount: {}, fastestWin: 0, counters: {},
  };
}

type MedalSeed = Omit<MedalDef, "points"> & { points?: number };

/** Points when a medal does not say: bigger numbers pay more, one-off feats pay 40. */
function defaultPoints(m: MedalSeed): number {
  if (m.points !== undefined) return m.points;
  const need = m.progress ? m.progress({ ...EMPTY(), wins: 0 })[1] : 0;
  return need > 0 ? Math.max(10, Math.min(120, Math.round(Math.sqrt(need) * 5))) : 40;
}

const AIR_KINDS = ["gunship", "bomber"];
const VEHICLE_KINDS = ["tank", "runabout", "artillery", "flak", "chopbike", "bulldozer"];
const killsOf = (s: CommanderStats, kinds: string[]): number => kinds.reduce((sum, k) => sum + (s.killsByKind[k] ?? 0), 0);
const INFANTRY_KILLS = (s: CommanderStats): number => s.kills - killsOf(s, AIR_KINDS) - killsOf(s, VEHICLE_KINDS);

const MEDAL_SEEDS: readonly MedalSeed[] = [
  // ---- CAMPAIGN: wins and battles fought, each a bigger number than the last ----
  { id: "first-victory", page: "Battles", name: "First Blood", blurb: "Win your first battle." },
  { id: "warlord", page: "Battles", name: "Warlord", blurb: "Win 10 battles.", progress: (s) => [s.wins, 10] },
  { id: "conqueror", page: "Battles", name: "Conqueror", blurb: "Win 25 battles.", progress: (s) => [s.wins, 25] },
  { id: "overlord", page: "Battles", name: "Overlord", blurb: "Win 50 battles.", progress: (s) => [s.wins, 50] },
  { id: "legend", page: "Battles", name: "Living Legend", blurb: "Win 100 battles.", progress: (s) => [s.wins, 100] },
  { id: "veteran", page: "Battles", name: "Old Soldier", blurb: "Fight 25 battles.", progress: (s) => [s.battles, 25] },
  { id: "career", page: "Battles", name: "Career Soldier", blurb: "Fight 75 battles.", progress: (s) => [s.battles, 75] },
  { id: "lifer", page: "Battles", name: "Lifer", blurb: "Fight 200 battles.", progress: (s) => [s.battles, 200] },
  { id: "streak3", page: "Battles", name: "On a Roll", blurb: "Win 3 battles in a row.", progress: (s) => [s.bestStreak, 3] },
  { id: "streak7", page: "Battles", name: "Unstoppable", blurb: "Win 7 battles in a row.", progress: (s) => [s.bestStreak, 7] },
  { id: "streak15", page: "Battles", name: "Undefeated", blurb: "Win 15 battles in a row.", progress: (s) => [s.bestStreak, 15] },
  { id: "mastery5", page: "Battles", name: "Student of War", blurb: "Earn 5 research stars.", progress: (s) => [masteryStars(s), 5] },
  { id: "mastery15", page: "Battles", name: "Master Tactician", blurb: "Earn 15 research stars.", progress: (s) => [masteryStars(s), 15] },
  { id: "mastery30", page: "Battles", name: "Grand Strategist", blurb: "Earn 30 research stars.", progress: (s) => [masteryStars(s), 30] },
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
  // ---- ARSENAL: what the new units, posts, strikes and base upgrades can do (live: they unlock mid-battle) ----
  ...[
    ["slam10", "Hammer Time", "Fling 10 foes with the Sledge's slam.", "slams", 10, 20],
    ["slam100", "Wrecking Ball", "Fling 100 foes with the Sledge's slam.", "slams", 100, 60],
    ["thrown25", "Fly, Little Guy", "Throw 25 foes 2 metres or more.", "thrown", 25, 20],
    ["thrown150", "Launch Pad", "Throw 150 foes 2 metres or more.", "thrown", 150, 60],
    ["ringout5", "Over the Edge", "Send 5 foes off the map or into the water.", "ringouts", 5, 35],
    ["burn25", "Pyromaniac", "Set 25 troopers alight.", "burned", 25, 25],
    ["burn150", "Firestarter", "Set 150 troopers alight.", "burned", 150, 65],
    ["boom10", "Big Badda Boom", "Detonate 10 Boomers.", "booms", 10, 25],
    ["punch25", "Home Run", "Punch 25 foes with a Breaker.", "punches", 25, 25],
    ["hook25", "Get Over Here", "Drag 25 foes in with a Hookshot.", "hooks", 25, 25],
    ["bowl20", "Strike!", "Bowl over 20 troopers with a Rocket Skater.", "bowled", 20, 25],
    ["molotov25", "Firebug", "Throw 25 Molotovs.", "molotovs", 25, 20],
    ["erupt20", "Surprise!", "Erupt under foes 20 times with a Mole Sapper.", "erupts", 20, 30],
    ["slash25", "Easy Rider", "Slash through 25 troopers with a Chop Bike.", "slashed", 25, 25],
    ["shove30", "Clear the Road", "Shove 30 things with a Bulldozer.", "shoved", 30, 25],
    ["clash10", "Bullet Meets Bullet", "See 10 rounds meet in mid-air.", "clashes", 10, 30],
    ["clash50", "Point Defense", "See 50 rounds meet in mid-air.", "clashes", 50, 70],
    ["cannon10", "Big Gun", "Fire the Fortress Cannon 10 times.", "cannon", 10, 30],
    ["cannon50", "Fortress Master", "Fire the Fortress Cannon 50 times.", "cannon", 50, 75],
    ["fullcar", "Clown Car", "Fill a Runabout with five aboard.", "fullcar", 1, 30],
    ["hops50", "Hopper", "Make 50 hops.", "hops", 50, 20],
    ["hops300", "Kangaroo", "Make 300 hops.", "hops", 300, 55],
    ["emp25", "Lights Out", "Kill the power on 25 machines with EMP.", "empHits", 25, 30],
    ["calls25", "Air Mail", "Call in 25 support strikes.", "supportCalls", 25, 30],
    ["calls100", "Rain of Steel", "Call in 100 support strikes.", "supportCalls", 100, 70],
    ["rails10", "Tungsten Rain", "Call 10 Rail Strikes.", "support:railstrike", 10, 35],
    ["medevac10", "Dust Off", "Call 10 Medevacs.", "support:medevac", 10, 35],
    ["fieldwork", "Both Schools", "Research both Fire Discipline and Demolitions (in different battles).", "", 2, 40],
  ].map(([id, name, blurb, key, need, points]) => ({
    id: id as string, page: "Arsenal" as const, name: name as string, blurb: blurb as string, points: points as number,
    progress: (st: CommanderStats): [number, number] => id === "fieldwork"
      ? [(st.counters["research:incendiary"] ? 1 : 0) + (st.counters["research:demolition"] ? 1 : 0), 2]
      : [st.counters[key as string] ?? 0, need as number],
  })),
  { id: "tried8", page: "Arsenal", name: "Try Them All", blurb: "Field every one of the newest troop types.", points: 60, progress: (st) => [triedKinds(st, NEW_KINDS), NEW_KINDS.length] },
  { id: "roster", page: "Arsenal", name: "Full Roster", blurb: "Field every troop type in the game at least once.", points: 100, progress: (st) => [triedKinds(st, TROOP_KINDS), TROOP_KINDS.length] },
  { id: "tech10", page: "Arsenal", name: "Branching Out", blurb: "Research 10 different tech nodes (across battles).", points: 30, progress: (st) => [triedTech(st), 10] },
  { id: "tech20", page: "Arsenal", name: "Fully Tooled", blurb: "Research 20 different tech nodes (across battles).", points: 80, progress: (st) => [triedTech(st), 20] },
  { id: "allcalls", page: "Arsenal", name: "Full Arsenal", blurb: "Call in every kind of support strike at least once.", points: 90, progress: (st) => [SUPPORT_POWERS.filter((p) => (st.counters[`support:${p.kind}`] ?? 0) > 0).length, SUPPORT_POWERS.length] },
  { id: "armored", page: "Arsenal", name: "Fortified", blurb: "Build Base Armor II.", points: 30, progress: (st) => [st.counters["upgrade:armor2"] ? 1 : 0, 1] },
  { id: "cannonbuilt", page: "Arsenal", name: "Heavy Metal", blurb: "Build the Fortress Cannon.", points: 50, progress: (st) => [st.counters["upgrade:cannon"] ? 1 : 0, 1] },
  { id: "radarbuilt", page: "Arsenal", name: "Eyes Open", blurb: "Build the Watch Radar.", points: 25, progress: (st) => [st.counters["upgrade:radar"] ? 1 : 0, 1] },
  { id: "sledgekills", page: "Arsenal", name: "Sledge Hunter", blurb: "Kill 25 foes with Sledges (hammer or sidearm).", points: 40, progress: (st) => [st.counters["killer:sledge"] ?? 0, 25] },
  { id: "flamekills", page: "Arsenal", name: "Burn Notice", blurb: "Kill 25 foes with Flamers or Flame Posts.", points: 40, progress: (st) => [(st.counters["killer:flamer"] ?? 0) + (st.counters["killer:flamepost"] ?? 0), 25] },
  { id: "rocketkills", page: "Arsenal", name: "Post Haste", blurb: "Kill 15 vehicles' worth of foes from Rocket Posts.", points: 40, progress: (st) => [st.counters["killer:rocketpost"] ?? 0, 15] },
];

const NEW_KINDS = ["runabout", "sledge", "breaker", "boomer", "juggernaut", "hookshot", "skater", "molotov", "mole", "chopbike", "bulldozer"];
const triedKinds = (st: CommanderStats, kinds: readonly string[]): number => kinds.filter((k) => (st.counters[`deploy:${k}`] ?? 0) > 0).length;
const triedTech = (st: CommanderStats): number => TECH_TREE.filter((n) => (st.counters[`research:${n.id}`] ?? 0) > 0).length;

export const MEDALS: readonly MedalDef[] = MEDAL_SEEDS.map((m) => ({ ...m, points: defaultPoints(m) }));

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
  /** The sim's player tallies for this battle (see sim.stats). */
  counters?: Record<string, number>;
}

const KEY = "rht.commander.v1";


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
    for (const [key, n] of Object.entries(input.counters ?? {})) s.counters[key] = (s.counters[key] ?? 0) + n;
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
    // Every counted medal (the Arsenal page, and the old ones too) is earned the moment its counter is met.
    for (const def of MEDALS) if (def.progress) { const [have, need] = def.progress(s); earn(def.id, have >= need); }
    this.save();
    return fresh;
  }

  /**
   * LIVE medals: called mid-battle with the battle's tallies so far. Any counted medal that this battle's progress
   * (lifetime + so far) already meets is earned NOW, saved, and returned, so the toast fires when it happens. The end
   * of the battle merges the same tallies once; medals already held are skipped, so nothing pays twice.
   */
  liveCheck(counters: Record<string, number>, killsByKind: Record<string, number> = {}): MedalDef[] {
    const real = this.stats;
    const merged: CommanderStats = { ...real, counters: { ...real.counters }, killsByKind: { ...real.killsByKind }, kills: real.kills };
    for (const [key, n] of Object.entries(counters)) merged.counters[key] = (merged.counters[key] ?? 0) + n;
    for (const [kind, n] of Object.entries(killsByKind)) { merged.killsByKind[kind] = (merged.killsByKind[kind] ?? 0) + n; merged.kills += n; }
    const fresh: MedalDef[] = [];
    for (const def of MEDALS) {
      if (!def.progress || real.medals.includes(def.id)) continue;
      const [have, need] = def.progress(merged);
      if (have >= need) { real.medals.push(def.id); fresh.push(def); }
    }
    if (fresh.length) this.save();
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
