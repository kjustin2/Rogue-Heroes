import { EventBus } from "../core/events";
import {
  clamp,
  clamp01,
  dist,
  moveToward,
  normalize,
  pointToSegmentDistance,
  segmentProgress,
  type Vec2,
} from "../core/math";
import { Rng } from "../core/rng";
import {
  AIM_LABELS,
  aimDamageMultiplier,
  applyDamage,
  createApc,
  createArtillery,
  createEngineer,
  createGrenadier,
  createHeavy,
  createMedic,
  createMortar,
  createScout,
  createSniper,
  createCover,
  createBase,
  createDroneOp,
  createJumper,
  createFlamer,
  createFlak,
  createGunship,
  createInterceptor,
  createBomber,
  createTransport,
  createSapper,
  createSoldier,
  createStriker,
  createTank,
  createTurret,
  COVER_PROFILES,
  createExTurret,
  createWall,
  factionLiving,
  isBuildingKind,
  isDefenseKind,
  isToppleKind,
  isAirKind,
  isInfantryKind,
  isPartIntact,
  isVehicleKind,
  preferredPart,
  recomputeStatus,
  repairForNewTurn,
  spendCommandPoint,
  vulnerabilityMultiplier,
  type AimMode,
  type CoverKind,
  type CombatEntity,
  type DamagePart,
  type DamageResult,
  type EntityKind,
  type InfantryStance,
  type Team,
} from "./damageModel";
import { createScenario } from "./scenario";
import { DEFAULT_TERRAIN, TERRAIN_STEP, ARENA_BOUNDS, clampToArena, nearestDryPoint, onTerrainEdge, setActiveTerrain, terrainHeightAt, pointInWater } from "./terrain";
import { TROOP_CATALOG, troopSpec, defenseSpec, supportPowerSpec, unitStats, type TroopKind, type DefenseKind, type SupportPowerKind, type ProjectileKind } from "./units";
import { TECH_TREE, techNode, aggregateTechEffect, type TechNode, type TechEffect } from "./tech";
import { modeDef, type ModeId } from "./modes";
import { DEFAULT_FACTION, factionDef, type FactionDef, type FactionId } from "./factions";
import { MAPS, mapDef, mapCenter, flagPositions, type MapDef, type MapEventConfig, type MapEventKind } from "./maps";

export { TROOP_CATALOG, troopSpec, DEFENSE_CATALOG, defenseSpec, SUPPORT_POWERS, supportPowerSpec, UNIT_STATS, unitStats, type TroopKind, type TroopSpec, type DefenseKind, type DefenseSpec, type SupportPowerKind, type SupportPowerSpec, type ProjectileKind, type UnitStats } from "./units";
export { TECH_TREE, techNode, troopsUnlockedBy, type TechNode } from "./tech";
export { MODES, PLAYABLE_MODES, modeDef, type ModeId, type ModeDef } from "./modes";
export { FACTIONS, factionDef, DEFAULT_FACTION, type FactionId, type FactionDef } from "./factions";
export { MAPS, mapDef, flagPositions, mapCenter, mapSize, type MapDef, type MapTheme, type MapSize } from "./maps";

export type Phase = "command" | "resolve" | "victory" | "defeat";
// A placed deploy whose exact point is blocked slides to the nearest clear spot within this reach
// (measured from the click to the edge of the unit's footprint).
export const DEPLOY_SNAP = 1.5;

export type Intent = "select" | "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "overwatch" | "mine" | "interact" | "inspect" | "inspect-detail" | "build" | "support" | "load" | "unload" | "smoke" | "recon" | "deploy";
export type OrderKind = "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "load" | "unload" | "smoke" | "recon" | "deploy";

// Hard cap on how many combat units one side can field at once.
export const POP_CAP = 10;

// Income paid each round at each upgrade level (scaled by reactor health). Bumped up a notch to
// accelerate the early game so the opening turns build toward a real army faster.
export const INCOME_BY_LEVEL = [110, 160, 215, 285] as const;
export const MAX_INCOME_LEVEL = INCOME_BY_LEVEL.length - 1;
// Cost to raise income from level i to level i+1.
export const INCOME_UPGRADE_COST = [200, 300, 420] as const;

// Income at level 0; retained as a named constant for clarity and tests.
export const BASE_INCOME = INCOME_BY_LEVEL[0];

// Treasury each side opens with. A little fuller than before so the first turns move faster.
export const START_MONEY_PLAYER = 380;
export const START_MONEY_ENEMY = 320;

// Cost to upgrade the Home Base to 2 command points per turn. A second CP effectively doubles
// a base's tempo, so it is priced as a heavy, mid-game investment.
export const COMMAND_UPGRADE_COST = 540;

// Base melee strike damage before vulnerability/difficulty scaling.
const MELEE_BASE_UNIT = 76;
const MELEE_BASE_COVER = 54;

// Bot difficulty: higher tiers give enemy units more health and damage and a richer economy.
export type Difficulty = "easy" | "normal" | "hard";
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];
interface DifficultyMods {
  label: string;
  enemyHp: number;
  enemyDamage: number;
  enemyIncome: number;
}
const DIFFICULTY_MODS: Record<Difficulty, DifficultyMods> = {
  easy: { label: "Easy", enemyHp: 0.8, enemyDamage: 0.82, enemyIncome: 0.85 },
  normal: { label: "Normal", enemyHp: 1, enemyDamage: 1, enemyIncome: 1 },
  hard: { label: "Hard", enemyHp: 1.15, enemyDamage: 1.12, enemyIncome: 1.25 }, // the hard BRAIN carries most of it now
};
// Reaction fire is snap fire: the spread multiplier applied to an overwatch shot.
// Resolve-phase budgets, in simulated seconds. SETTLE is the graceful escape once nothing is
// airborne; HARD_CEILING is the unconditional one that guarantees the phase always ends.
const RESOLVE_SETTLE_TIMEOUT = 18;
const RESOLVE_HARD_CEILING = 20;

const OVERWATCH_SPREAD_PENALTY = 1.55;
// Half-angle of the overwatch watch cone. The player picks a facing; only hostiles moving
// inside this arc (±60°, a 120° wedge) around it trip the reaction shot.
export const OVERWATCH_ARC_HALF = Math.PI / 3;
// Salvage economy: each vehicle wreck holds this much money, stripped this fast by an
// adjacent unit at the start of each turn.
const SALVAGE_PER_WRECK = 60;
const SALVAGE_PER_TURN = 30;
const SALVAGE_REACH = 0.9;
// Capturable neutral structures.
const CAPTURE_REACH = 1.0;
export const DEPOT_INCOME = 25;
// Loose cash caches scattered on the field: run a unit over one to bank it. How close a unit
// must get to grab it, and the min/spread of cash per cache.
const PICKUP_REACH = 0.95;
const TRANSPORT_CAPACITY = 2; // how many ground units an air transport (or an APC) can carry at once
// APC carry: the ground lift needs the passenger beside the hull, and unloads beside it too.
const APC_LOAD_REACH = 1.2;
const APC_UNLOAD_REACH = 3;
// STRIKER CHARGE: metres of free closing distance folded into the strike order.
export const STRIKER_CHARGE = 5;
// Hull-down tanks take this fraction of incoming shot damage.
const HULL_DOWN_DAMAGE = 0.7;
// AIRBURST (grenadier): a launcher round that bursts on cover still lands this share of its direct
// damage on the target sheltering right behind it — cover is half protection, not full.
const AIRBURST_SHARE = 0.5;
const AIRBURST_REACH = 2.7;
// FEAR (flamer): enemy infantry this close to burning ground at turn start run from it.
export const FLAMER_FEAR_RADIUS = 6;
// STRAFE (gunship): a move also fires one burst at every hostile within this much of the path.
export const STRAFE_RADIUS = 4;
const STRAFE_DAMAGE_SHARE = 0.75;
// CARPET (bomber): three bombs in a line along the heading, this far apart.
export const CARPET_BOMBS = 3;
const CARPET_SPACING = 2.2;
// A jump trooper landing next to an enemy: damage before difficulty scaling.
const SLAM_LANDING_DAMAGE = 15;

// Metres a piercing round carries on past a body it went through.
const PIERCE_CARRY = 7;

type StrikeKind = "barrage" | "collapse" | "airstrike" | "cluster" | "laser" | "lightning" | "slag";
const LIGHTNING_RADIUS = 2.0;

// Gas clouds (see runGasTick / igniteGasAt).
const GAS_START_RADIUS = 2.2;
const GAS_SPREAD_PER_TURN = 1.3;
const GAS_MAX_RADIUS = 6.5;
const GAS_CHOKE_DAMAGE = 7;
const GAS_BLAST_DAMAGE = 72;

// Flamer burning ground.
const BURN_RADIUS = 1.6;
// A ruptured fuel cell leaves a bigger, longer fire than a flamer's splash: burning fuel is the
// whole point of shooting one, and it has to outlast the turn it happened on to deny ground.
const FUEL_FIRE_RADIUS = 2.4;
const FUEL_FIRE_TURNS = 3;
// The falling column's colour: foliage, rusted steel, weathered timber; stone is the default.
const TOPPLE_COLOR: Partial<Record<CoverKind, number>> = { tree: 0x4f7a3a, girder: 0x6b5446, tower: 0x6a4a2c };
// An ammo cache scatters instead of detonating once.
const AMMO_COOKOFF_COUNT = 5;
const AMMO_COOKOFF_SPREAD = 2.2;
// A cut conduit browns out nearby emplacements: they hold position but cannot fire.
const CONDUIT_RADIUS = 7;
const CONDUIT_OUTAGE_TURNS = 2;
const BURN_TURNS = 2;
const BURN_DAMAGE = 14;
// Mortar smoke round: a cloud that blocks flat line of fire through it for a few turns.
const SMOKE_RADIUS = 3;
const SMOKE_TURNS = 3;
const SMOKE_COLOR = 0x9aa3a8;
// Medic stabilise: an infantry kill with a friendly medic this close becomes a DOWNED body; a medic
// still this close at the next turn start revives it with this share of its core.
const STABILISE_RANGE = 6;
const REVIVE_CORE_FRACTION = 0.3;
// Sniper mark: every OTHER friendly shooter gets this spread multiplier and accurate-band bonus
// against a unit a sniper fired at, until the turn after.
const MARK_SPREAD_SCALE = 0.8;
const MARK_ACCURATE_BONUS = 0.2;
// Sapper proximity mines.
const MINE_COST = 15;
const MINE_TRIGGER = 0.85;
const MINE_SPLASH = 1.5;
const MINE_DAMAGE = 30;

export function difficultyLabel(d: Difficulty): string {
  return DIFFICULTY_MODS[d].label;
}

// Reactor efficiency for a Home Base (drives its income).
export function generatorEfficiency(base: CombatEntity): number {
  if (!base.status.alive) return 0;
  const power = base.parts.find((p) => p.id === "power");
  if (!power || power.hp <= 0) return 0;
  return 0.35 + 0.65 * (power.hp / power.maxHp);
}

// Base income per round before reactor scaling, at the base's current upgrade level.
export function baseIncomeRate(base: CombatEntity): number {
  return INCOME_BY_LEVEL[clamp(base.incomeLevel ?? 0, 0, MAX_INCOME_LEVEL)];
}

// Actual money paid this round (rate × reactor health), rounded.
export function baseIncome(base: CombatEntity): number {
  return Math.round(baseIncomeRate(base) * generatorEfficiency(base));
}

// Cost to upgrade income to the next level, or undefined when already maxed.
export function incomeUpgradeCost(base: CombatEntity): number | undefined {
  const level = base.incomeLevel ?? 0;
  return level >= MAX_INCOME_LEVEL ? undefined : INCOME_UPGRADE_COST[level];
}

// Cost to upgrade the base to 2 command points per turn, or undefined when already upgraded.
export function commandUpgradeCost(base: CombatEntity): number | undefined {
  return base.maxCommandPoints >= 2 ? undefined : COMMAND_UPGRADE_COST;
}

export function isTechUnlocked(base: CombatEntity, nodeId: string): boolean {
  return (base.unlockedTech ?? []).includes(nodeId);
}

export function techPrereqsMet(base: CombatEntity, node: TechNode): boolean {
  return node.requires.every((req) => isTechUnlocked(base, req));
}

type AttackMode = "weapon" | "grenade";

export interface TacticalOrder {
  id: string;
  actorId: string;
  kind: OrderKind;
  destination?: Vec2;
  targetId?: string;
  targetPartId?: string;
  aim: AimMode;
  elapsed: number;
  duration: number;
  fired: boolean;
  done: boolean;
  stance?: InfantryStance;
  start?: Vec2;
  startedCrouched?: boolean;
  projectileId?: string;
  // STRAFE: hostiles this gunship move has already gunned (one burst each).
  strafed?: string[];
}

/** One enemy unit's planned order for the coming resolve, as revealed by a drone op's recon pulse. */
export interface EnemyIntent {
  actorId: string;
  kind: OrderKind;
  destination?: Vec2;
  targetId?: string;
}

export interface VisualEvent {
  id: string;
  // "jet" = a strike aircraft flying from->to; "beam" = an orbital lance burning the from->to
  // line; "topple" = a tall cover column falling from `from` toward `to`.
  // "strike" = a melee blow landing at `to`, swung from `from`.
  // "bolt" = lightning striking `to` from the sky; "land" = a jump trooper touching down at `to`.
  type: "shot" | "impact" | "blast" | "ping" | "jet" | "beam" | "topple" | "strike" | "bolt" | "land";
  from: Vec2;
  to: Vec2;
  color: number;
  age: number;
  duration: number;
  radius?: number;
}

export interface ShotPreview {
  actorId: string;
  targetId: string;
  targetPartId: string;
  impactEntityId?: string;
  impactPartId?: string;
  from: Vec2;
  aimPoint: Vec2;
  impactPoint: Vec2;
  fromHeight: number;
  aimHeight: number;
  impactHeight: number;
  amount: number;
  accuracy: AccuracyRating;
  accuracyLabel: string;
  hitChance: number;
  spreadDegrees: number;
  accuracyNotes: string[];
  projectileKind: ProjectileKind;
  arcHeight: number;
  blockedById?: string;
  blockedByGround?: boolean;
  // A flat shot whose line passes through a smoke cloud is swallowed by it (arcing rounds sail over).
  blockedBySmoke?: boolean;
  warningEntityId?: string;
  warningText?: string;
}

export type AccuracyRating = "great" | "good" | "steady" | "average" | "poor" | "terrible";

export interface Projectile {
  id: string;
  orderId: string;
  actorId: string;
  targetId?: string;
  targetPartId?: string;
  aim: AimMode;
  kind: ProjectileKind;
  // The entity kind that fired this — lets the renderer give each unit a distinct round.
  // Optional so test-constructed projectiles stay valid; renderer falls back to `kind`.
  sourceKind?: EntityKind;
  position: Vec2;
  previous: Vec2;
  origin: Vec2;
  direction: Vec2;
  verticalSlope: number;
  travel: number;
  maxTravel: number;
  aimPoint: Vec2;
  intendedPoint: Vec2;
  height: number;
  previousHeight: number;
  originHeight: number;
  speed: number;
  age: number;
  maxAge: number;
  color: number;
  accuracy: AccuracyRating;
  spreadRadians: number;
  yawErrorRadians: number;
  pitchErrorRadians: number;
  arcHeight: number;
  arcDistance: number;
  attackMode?: AttackMode;
  groundTarget?: boolean;
  // A mortar smoke round: lands a smoke cloud instead of a blast, harms nothing.
  smoke?: boolean;
  state: "flying" | "rolling";
  rollElapsed: number;
  rollDuration: number;
  rollSpeed: number;
  ignoredEntityIds: string[];
  /** Bodies this round has already gone through (piercing rounds only). */
  pierced?: number;
}

export interface TurnDamageEntry {
  id: string;
  actorName: string;
  actorId: string;
  targetName: string;
  targetId: string;
  targetTeam: CombatEntity["team"];
  partId: string;
  partLabel: string;
  amount: number;
  remainingHp: number;
  maxHp: number;
  killed: boolean;
  destroyed: boolean;
  source?: string;
}

export interface TurnReport {
  turn: number;
  phase: "active" | "complete";
  entries: TurnDamageEntry[];
  notes: string[];
}

interface AccuracyBreakdown {
  rating: AccuracyRating;
  label: string;
  spreadRadians: number;
  spreadDegrees: number;
  hitChance: number;
  notes: string[];
}

interface ProjectileHit {
  entity: CombatEntity;
  part: DamagePart;
  point: Vec2;
  height: number;
  progress: number;
}

export interface FlagState {
  team: Team; // the team that owns (defends) this flag
  home: Vec2;
  pos: Vec2;
  carrierId?: string;
  droppedTurns?: number; // rounds a dropped (uncarried, away-from-home) flag has sat
}

export interface ModeState {
  mode: ModeId;
  target: number;
  playerScore: number;
  enemyScore: number;
  hill: Vec2;
  hillRadius: number;
  hillHolder?: Team;
  flags: FlagState[];
  // Domination: the three scored sectors and who held each last round (for the renderer).
  hills?: Vec2[];
  hillHolders?: (Team | undefined)[];
}

// A stable, order-independent separation angle for a pair of coincident units, so ejecting them
// apart is deterministic (and reproducible for tests) rather than a fixed axis nudge.
function pairAngle(a: string, b: string): number {
  const s = a < b ? a + "|" + b : b + "|" + a;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
}

/**
 * How hard a blast throws a thing. Infantry are 1 and fly; armour is heavy and barely registers it;
 * anything bolted to the ground is Infinity and does not move at all. Tuned so a grenade shoves a
 * trooper about two metres and a tank a few centimetres.
 */
const KNOCKBACK_SCALE = 2.4;
const KNOCKBACK_MAX = 4.5;

function blastMass(entity: CombatEntity): number {
  if (entity.kind === "cover" || isBuildingKind(entity.kind) || isDefenseKind(entity.kind)) return Infinity;
  if (isVehicleKind(entity.kind)) return 5.5;
  return 1;
}

export class TacticalSim {
  readonly bus = new EventBus();
  readonly rng = new Rng(0x726f6775);
  readonly entities: CombatEntity[];
  readonly orders: TacticalOrder[] = [];
  readonly projectiles: Projectile[] = [];
  readonly effects: VisualEvent[] = [];
  readonly defending = new Set<string>();
  readonly detonated = new Set<string>();
  // Bases already told "deflected" this resolve, so a multi-shell volley logs the cue once.
  private readonly strikeDeflected = new Set<string>();
  // Covers that already toppled (so a corpse caught in a later blast doesn't fall twice).
  readonly toppled = new Set<string>();
  // Vehicles that already left a wreck behind, and salvage money remaining per wreck id.
  readonly wrecked = new Set<string>();
  readonly salvage = new Map<string, number>();
  // Units on overwatch: actorId -> reaction shots remaining. Set during command (costs a
  // CP), consumed when a hostile moves inside watch radius during resolve, cleared at the
  // start of the next command phase.
  readonly overwatching = new Map<string, number>();
  // Direction each watcher is facing (yaw). A reaction shot only triggers for a hostile that
  // moves inside the watch radius AND within OVERWATCH_ARC_HALF of this facing — the player
  // picks the arc when arming overwatch, so it covers an approach lane, not the whole field.
  readonly overwatchFacing = new Map<string, number>();
  // Burning ground left by flamer hits (damages at turn start) and sapper proximity mines.
  readonly burnZones: { id: string; x: number; z: number; radius: number; turnsLeft: number }[] = [];
  // GAS CLOUDS. A shot-out canister leaks a cloud that grows each turn until it hits its cap or
  // something lights it: any blast inside it (grenade, shell, mine, a flamer round, burning ground)
  // detonates the WHOLE cloud at once. Chokes whoever stands in it meanwhile. Rides serialize().
  readonly gasClouds: { id: string; x: number; z: number; radius: number; maxRadius: number }[] = [];
  // Mortar smoke: flat shots through a cloud are lost in it; shrinks a turn per turn start. Rides serialize().
  readonly smokeClouds: { id: string; x: number; z: number; radius: number; turnsLeft: number }[] = [];
  // RECON (drone op): set when a recon order resolves; the enemy's NEXT command is revealed, so
  // during the following command phase enemyIntents() can show what each enemy unit will do.
  // Cleared once that command is actually issued. Rides serialize().
  revealedOrders = false;
  // Which side the pulse was flown for. Only the player ever recons against the bot, but in hotseat
  // either seat can, and the reveal belongs to whoever flew it (flips with the seats).
  revealedTeam: Team = "player";
  private enemyIntentCache?: { turn: number; list: EnemyIntent[] };
  // True while enemyIntents() dry-runs the enemy AI: addOrder stays silent (no log, no bus event).
  private previewingEnemy = false;
  readonly mines: { id: string; x: number; z: number; team: Team }[] = [];
  // Loose cash caches scattered on the field at battle start: a unit that runs over one banks its
  // cash for that team, then it's gone. A "grab the loot" incentive to spread out and take ground.
  readonly pickups: { id: string; x: number; z: number; amount: number }[] = [];
  // Battle bookkeeping for the Achievements medals: kills per player unit, and how
  // many player field units died this battle.
  readonly killsBy = new Map<string, number>();
  playerLosses = 0;
  private readonly countedDead = new Set<string>();
  readonly log: string[] = [];
  // Hotseat: how many lines have ever been logged, and the count when the current seat started
  // planning. swapSides() drops the outgoing seat's planning chatter so the next seat cannot read
  // the other human's orders off the log.
  private logSeq = 0;
  private seatLogMark = 0;
  readonly turnReports: TurnReport[] = [];
  readonly economy = new Map<Team, number>([["player", START_MONEY_PLAYER], ["enemy", START_MONEY_ENEMY], ["neutral", 0]]);

  mapDef: MapDef;
  mode: ModeId;
  modeState: ModeState;
  difficulty: Difficulty = "normal";

  phase: Phase = "command";
  intent: Intent = "select";
  aim: AimMode = "center";
  selectedId = "p-base-1";
  turn = 1;
  // The defense kind queued for placement when intent is "build" (set by the HUD build deck).
  pendingBuild: DefenseKind | undefined;
  // The troop kind awaiting a ground point when intent is "deploy" (set by the HUD deploy deck).
  // Command-phase UI state only — never serialized.
  pendingDeploy: TroopKind | undefined;
  // The support power awaiting a ground target when intent is "support" (set by the HUD).
  pendingSupport: SupportPowerKind | undefined;
  // Support strikes committed this command phase; they fly in during the next resolve.
  private queuedSupport: { kind: SupportPowerKind; point: Vec2; dir: Vec2 }[] = [];
  // Timed one-shot visual events (strike jets, orbital beams) played during a resolve.
  private pendingFx: { at: number; type: VisualEvent["type"]; from: Vec2; to: Vec2; color: number; duration: number; radius?: number; fired?: boolean }[] = [];

  private orderSeq = 0;
  private effectSeq = 0;
  private projectileSeq = 0;
  private damageSeq = 0;
  private troopSeq = 0;
  private resolveClock = 0;
  private activeTurnReport: TurnReport | undefined;

  // Dynamic map events are a pure function of the map config + current turn, so none of this
  // needs serializing — restore() just recomputes it. `forced*` are single-turn debug/test
  // overrides; `pendingStrikes` are the staggered barrage/collapse detonations during a resolve.
  eventNotice: string | undefined;
  private forcedSandstorm = false;
  private forcedIonStorm = false;
  private forcedZones: { kind: MapEventKind; x: number; z: number; radius: number }[] = [];
  private pendingStrikes: { at: number; point: Vec2; radius: number; damage: number; kind: StrikeKind; fired?: boolean }[] = [];
  private strikeClock = 0;

  constructor(init?: CombatEntity[] | { map?: MapDef; mode?: ModeId }) {
    if (Array.isArray(init)) {
      // Direct entity list (tests / sandbox) — keep the deterministic default terrain.
      setActiveTerrain(DEFAULT_TERRAIN);
      this.mapDef = MAPS[0];
      this.mode = "destroy";
      this.entities = init;
    } else {
      this.mapDef = init?.map ?? MAPS[0];
      this.mode = init?.mode ?? "destroy";
      this.applyTerrain();
      this.entities = createScenario(this.mapDef, this.mode);
    }
    this.modeState = this.buildModeState();
    this.selectedId = this.entities.find((e) => e.team === "player" && isBuildingKind(e.kind))?.id ?? this.entities[0]?.id ?? "";
    this.syncAllElevations();
    this.pushLog("Turn 1 command phase");
  }

  // Restart on a (possibly new) map, mode, and difficulty, clearing all battle state.
  // Which faction each side is fielding. Sim-level rather than a field on the base entity:
  // `survival` mode creates no enemy base at all (scenario.ts), and faction has to outlive the HQ
  // anyway -- it still selects render skins and AI target bias for whatever survives it.
  private factions: Record<Team, FactionId> = { player: DEFAULT_FACTION, enemy: DEFAULT_FACTION, neutral: DEFAULT_FACTION };

  /** The faction definition a side is fielding. */
  factionOf(team: Team): FactionDef {
    return factionDef(this.factions[team]);
  }

  factionIdOf(team: Team): FactionId {
    return this.factions[team];
  }

  /**
   * Set a side's faction without rebuilding the battlefield. configure() also takes factions, but
   * it resets every entity, so it is only usable at battle start; this is for choosing a faction
   * on an already-staged sim (the faction-select screen) and for tests that build entities directly.
   */
  setFaction(team: Team, faction: FactionId): void {
    this.factions[team] = faction;
  }

  /**
   * Bridge spans that have been destroyed this battle, as indices into the map's authored bridge
   * list. Terrain is a module singleton rebuilt from the MapDef, so a dropped span would come back
   * on reload unless the loss is recorded here and re-applied -- this is the state that makes
   * bridge destruction a real, persistent consequence rather than a one-session visual.
   */
  private droppedBridges: number[] = [];

  /** Re-derive the active terrain from the map minus whatever spans have been dropped. */
  private applyTerrain(): void {
    const authored = this.mapDef.terrain;
    if (this.droppedBridges.length === 0 || !authored.bridges?.length) {
      setActiveTerrain(authored);
      return;
    }
    const gone = new Set(this.droppedBridges);
    setActiveTerrain({ ...authored, bridges: authored.bridges.filter((_, i) => !gone.has(i)) });
  }

  /**
   * Drop the bridge span covering a point. Ground units lose that crossing for the rest of the
   * battle; flyers never cared. Returns the index dropped, or -1 when the point is not on a span.
   */
  dropBridgeAt(point: Vec2): number {
    const bridges = this.mapDef.terrain.bridges ?? [];
    const index = bridges.findIndex((r, i) =>
      !this.droppedBridges.includes(i)
      && point.x >= r.minX && point.x <= r.maxX && point.z >= r.minZ && point.z <= r.maxZ);
    if (index < 0) return -1;
    this.droppedBridges.push(index);
    this.applyTerrain();
    // Anything standing on the span goes into the water with it.
    for (const entity of this.entities) {
      if (!entity.status.alive || entity.flying || entity.kind === "cover") continue;
      if (!pointInWater(entity.position)) continue;
      entity.position = nearestDryPoint(entity.position);
    }
    this.effect("blast", point, point, 0x8a7f66, 0.9, 2.6);
    this.pushLog("A bridge span collapses into the channel");
    return index;
  }

  /** Which authored bridge spans are gone. */
  bridgesDropped(): readonly number[] {
    return this.droppedBridges;
  }

  // `factions` is optional and defaults to PRESERVING the current pick, because configure() also
  // runs on reset() -- passing nothing must not silently drop the player back to the default.
  /**
   * LOCAL 2-PLAYER (hotseat). Both sides are human: the AI never queues orders, and the composition
   * root hands the command phase to each player in turn, calling `swapSides()` so Player 2 plans
   * through the ordinary "player" UI. The sim always RESOLVES with sides unswapped (Player 1 =
   * "player"), so a victory is always Player 1's and a defeat Player 2's. Set by `configure`.
   */
  hotseat = false;
  /** True while Player 2 is planning (sides swapped). Never true during a resolve or a save. */
  sidesSwapped = false;

  configure(map: MapDef, mode: ModeId, difficulty: Difficulty = this.difficulty, factions?: Partial<Record<Team, FactionId>>, hotseat = false): void {
    this.hotseat = hotseat;
    this.sidesSwapped = false;
    if (factions?.player) this.factions.player = factions.player;
    if (factions?.enemy) this.factions.enemy = factions.enemy;
    this.mapDef = map;
    this.mode = mode;
    this.difficulty = difficulty;
    // A new battle starts with every span intact.
    this.droppedBridges = [];
    this.mapDef = map;
    this.applyTerrain();
    const fresh = createScenario(map, mode);
    this.entities.splice(0, this.entities.length, ...fresh);
    this.modeState = this.buildModeState();
    this.orders.splice(0);
    this.effects.splice(0);
    this.projectiles.splice(0);
    this.defending.clear();
    this.detonated.clear();
    this.toppled.clear();
    this.overwatching.clear();
    this.overwatchFacing.clear();
    this.wrecked.clear();
    this.salvage.clear();
    this.burnZones.splice(0);
    this.gasClouds.splice(0);
    this.smokeClouds.splice(0);
    this.revealedOrders = false;
    this.revealedTeam = "player";
    this.enemyIntentCache = undefined;
    this.mines.splice(0);
    this.placePickups();
    this.killsBy.clear();
    this.playerLosses = 0;
    this.countedDead.clear();
    this.log.splice(0);
    this.turnReports.splice(0);
    this.activeTurnReport = undefined;
    this.phase = "command";
    this.intent = "select";
    this.aim = "center";
    this.selectedId = this.entities.find((e) => e.team === "player" && isBuildingKind(e.kind))?.id ?? "";
    this.turn = 1;
    this.orderSeq = 0;
    this.effectSeq = 0;
    this.projectileSeq = 0;
    this.damageSeq = 0;
    this.troopSeq = 0;
    this.resolveClock = 0;
    this.rng.reseed(0x726f6775);
    this.economy.set("player", START_MONEY_PLAYER);
    // The bot's smaller purse is a handicap for the human; two humans start even.
    this.economy.set("enemy", hotseat ? START_MONEY_PLAYER : START_MONEY_ENEMY);
    this.economy.set("neutral", 0);
    this.pendingBuild = undefined;
    this.pendingDeploy = undefined;
    this.pendingSupport = undefined;
    this.queuedSupport = [];
    this.pendingFx = [];
    this.forcedSandstorm = false;
    this.forcedIonStorm = false;
    this.forcedZones = [];
    this.pendingStrikes = [];
    this.strikeClock = 0;
    this.eventNotice = undefined;
    this.syncAllElevations();
    this.pushLog(`${modeDef(mode).name} — ${map.name}`);
    this.pushLog("Turn 1 command phase");
    this.refreshEventNotice();
    this.seatLogMark = this.logSeq;
  }

  private buildModeState(): ModeState {
    const def = modeDef(this.mode);
    const flags = flagPositions(this.mapDef);
    // Domination sectors: the central hill plus a point toward each base — symmetric,
    // so neither side spawns on top of two of the three.
    const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    const hills = this.mode === "domination"
      ? [{ ...this.mapDef.hill }, midpoint(this.mapDef.playerBase, this.mapDef.hill), midpoint(this.mapDef.enemyBase, this.mapDef.hill)]
      : undefined;
    return {
      mode: this.mode,
      target: def.scoreTarget,
      playerScore: 0,
      enemyScore: 0,
      hill: { ...this.mapDef.hill },
      hillRadius: this.mapDef.hillRadius,
      flags: [
        { team: "player", home: { ...flags.player }, pos: { ...flags.player } },
        { team: "enemy", home: { ...flags.enemy }, pos: { ...flags.enemy } },
      ],
      hills,
      hillHolders: hills ? hills.map(() => undefined) : undefined,
    };
  }

  get selected(): CombatEntity | undefined {
    return this.entity(this.selectedId);
  }

  get currentTurnReport(): TurnReport | undefined {
    return this.activeTurnReport;
  }

  get gameOver(): boolean {
    return this.phase === "victory" || this.phase === "defeat";
  }

  entity(id: string | undefined): CombatEntity | undefined {
    return id ? this.entities.find((e) => e.id === id) : undefined;
  }

  living(team?: CombatEntity["team"]): CombatEntity[] {
    return this.entities.filter((e) => e.status.alive && (!team || e.team === team));
  }

  money(team: Team): number {
    return this.economy.get(team) ?? 0;
  }

  private addMoney(team: Team, amount: number): void {
    this.economy.set(team, Math.max(0, this.money(team) + amount));
  }

  setIntent(intent: Intent): void {
    this.intent = intent;
  }

  setAim(aim: AimMode): void {
    this.aim = aim;
    this.pushLog(`Aim: ${AIM_LABELS[aim]}`);
  }

  select(id: string): void {
    const entity = this.entity(id);
    if (!entity || !entity.status.alive) return;
    this.selectedId = id;
    if (entity.team === "player") this.intent = "select";
  }

  deselect(): void {
    this.selectedId = "";
    this.intent = "select";
  }

  // Cycle the selection through the player's mobile squad (no base/defenses), wrapping at
  // either end. direction 1 = next (Tab), -1 = previous (Shift+Tab). When nothing in the
  // squad is currently selected — e.g. a wall, turret, or the base was clicked — we step in
  // from the first/last unit so Tab always lands on a real unit instead of stalling.
  cyclePlayer(direction = 1): void {
    const units = this.living("player").filter((e) => !isBuildingKind(e.kind) && !isDefenseKind(e.kind));
    if (!units.length) return;
    const step = direction < 0 ? -1 : 1;
    const index = units.findIndex((e) => e.id === this.selectedId);
    const next = index >= 0
      ? (index + step + units.length) % units.length
      : (step > 0 ? 0 : units.length - 1);
    this.select(units[next].id);
  }

  queueMove(destination: Vec2): boolean {
    return this.queueMoveToDestination(destination);
  }

  private queueMoveToDestination(destination: Vec2, allowedCoverId?: string): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot move`);
    // DEPLOYED artillery has its outriggers down: packing up to move takes the whole turn.
    if (actor.kind === "artillery" && actor.deployed && (actor.commandPoints < actor.maxCommandPoints || this.orders.some((o) => o.actorId === actor.id))) {
      return this.reject(`${actor.name} is deployed — packing up to move takes its whole turn`);
    }
    const start = this.projectedActorForPreview(actor).position;
    const desired = clampToArena(destination);
    const limitedByRange = limitMoveDestination(actor, start, desired);
    const limited = this.blockedMoveDestination(actor, start, limitedByRange, allowedCoverId);
    // A move that goes nowhere is refused, not charged: the block reason is already in the log, and
    // spending a command point on a zero-length order read as "the tank ignored me".
    if (dist(start, limited) < 0.3 && dist(start, desired) > 0.3) {
      if (this.log[0]?.startsWith(actor.name)) return false; // the reason is already the newest line
      return this.reject(`${actor.name} can't move that way`);
    }
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    if (actor.kind === "artillery" && actor.deployed) {
      actor.commandPoints = 0;
      actor.deployed = false;
      this.pushLog(`${actor.name} packs up its outriggers to move`);
    }
    // Say WHICH limit applied: range, or the obstacle already named in the log.
    if (dist(desired, limitedByRange) > 0.05 && dist(limitedByRange, limited) <= 0.05) this.pushLog(`${actor.name} move limited to ${moveRange(actor).toFixed(1)}m`);
    this.addOrder({
      actorId: actor.id,
      kind: "move",
      destination: limited,
      aim: this.aim,
      duration: isVehicleKind(actor.kind) ? 2.85 : 2.55,
    });
    return true;
  }

  queueMoveToCover(coverId: string): boolean {
    const actor = this.requirePlayerActor();
    const cover = this.entity(coverId);
    if (!actor || !cover || cover.kind !== "cover") return false;
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot move`);
    if (actor.commandPoints <= 0) return this.reject(`${actor.name} has no command points`);
    if (isCliffCover(cover)) {
      if (!isInfantryKind(actor.kind)) return this.reject(`${actor.name} cannot climb the cliff`);
      return this.queueClimbCover(cover.id);
    }
    if (actor.kind === "tank") {
      const queued = this.queueRam(cover.id);
      if (queued) this.pushLog(`${actor.name} crushes through ${cover.name}`);
      return queued;
    }
    const destination = this.coverDestination(actor, cover);
    const queued = this.queueMoveToDestination(destination, cover.id);
    if (queued) this.pushLog(`${actor.name} moves to cover at ${cover.name}`);
    return queued;
  }

  // Can the selected infantry actually reach this cover and crouch this turn?
  previewTakeCover(coverId: string): { ok: boolean; reason?: string } {
    const actor = this.selected;
    const cover = this.entity(coverId);
    if (!actor || actor.team !== "player" || !cover || cover.kind !== "cover") return { ok: false, reason: "Select a unit and a cover object" };
    if (!isInfantryKind(actor.kind)) return { ok: false, reason: "Only infantry can take cover" };
    if (!actor.status.canMove) return { ok: false, reason: `${actor.name} cannot move` };
    if (isCliffCover(cover)) return { ok: false, reason: "Climb the cliff instead of taking cover" };
    const start = this.projectedActorForPreview(actor).position;
    const destination = this.coverDestination(actor, cover);
    if (dist(start, destination) > moveRange(actor) + 0.6) return { ok: false, reason: `${cover.name} is too far to take cover this turn` };
    return { ok: true };
  }

  queueTakeCover(coverId: string): boolean {
    const status = this.previewTakeCover(coverId);
    if (!status.ok) return this.reject(status.reason ?? "Cannot take cover here");
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const queued = this.queueMoveToCover(coverId);
    if (!queued) return false;
    if (actor.commandPoints > 0 && isInfantryKind(actor.kind)) this.queueDefend("crouched");
    return true;
  }

  queueClimbCover(coverId: string): boolean {
    const actor = this.requirePlayerActor();
    const cover = this.entity(coverId);
    if (!actor || !cover || cover.kind !== "cover") return false;
    if (!isInfantryKind(actor.kind)) return this.reject("Only infantry can climb objects");
    if (!canClimbCover(cover)) return this.reject(`${cover.name} is too tall to climb`);
    const queued = this.queueMoveToDestination(cover.position, cover.id);
    if (queued) this.pushLog(isCliffCover(cover) ? `${actor.name} climbs the cliff` : `${actor.name} climbs onto ${cover.name}`);
    return queued;
  }

  // ---- Capturing neutral field structures (supply depots, derelict turrets) ----

  /** Distance at which a unit is close enough to hold/flip a capturable structure. */
  captureInReach(actor: CombatEntity, structure: CombatEntity): boolean {
    return dist(actor.position, structure.position) <= structure.radius + actor.radius + CAPTURE_REACH;
  }

  captureFailureReason(actor: CombatEntity | undefined, structure: CombatEntity | undefined): string | undefined {
    if (!structure || !structure.capturable) return "This object cannot be captured";
    if (!actor || actor.team !== "player") return "Select one of your units first";
    if (structure.team === "player") return `${structure.name} is already yours`;
    if (!actor.status.canMove) return `${actor.name} cannot move to seize it`;
    return undefined;
  }

  // Player API: send the selected unit to hold a capturable structure. Standing beside it
  // uncontested at the start of the next turn flips it to your team (a depot then pays income;
  // a derelict turret comes online next turn). If the unit is already in reach this simply
  // confirms the hold and spends no command point.
  queueCapture(structureId: string): boolean {
    const actor = this.requirePlayerActor();
    const structure = this.entity(structureId);
    const failure = this.captureFailureReason(actor, structure);
    if (failure) return this.reject(failure);
    if (!actor || !structure) return false;
    if (this.captureInReach(actor, structure)) {
      this.pushLog(`${actor.name} holds ${structure.name} — it flips to you next turn unless the enemy contests it`);
      return true;
    }
    const destination = this.coverDestination(actor, structure);
    const queued = this.queueMoveToDestination(destination, structure.id);
    if (queued) this.pushLog(`${actor.name} moves to seize ${structure.name}`);
    return queued;
  }

  queueShoot(targetId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueShootFor(actor, target, this.aim);
  }

  queueShootPart(targetId: string, partId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueShootFor(actor, target, aimForPart(target.parts.find((part) => part.id === partId)), partId);
  }

  queueGrenade(targetId: string): boolean {
    const actor = this.requirePlayerActor();
    if (actor && isAirBomber(actor)) return this.queueGrenadeAt(actor.position); // a plane just drops straight down
    const target = this.entity(targetId);
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueGrenadeFor(actor, target, this.aim);
  }

  queueGrenadePart(targetId: string, partId: string): boolean {
    const actor = this.requirePlayerActor();
    if (actor && isAirBomber(actor)) return this.queueGrenadeAt(actor.position);
    const target = this.entity(targetId);
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueGrenadeFor(actor, target, aimForPart(target.parts.find((part) => part.id === partId)), partId);
  }

  queueGrenadeAt(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    // An aircraft bombs straight down beneath itself; ground units lob to the clicked spot.
    const point = isAirBomber(actor) ? { x: actor.position.x, z: actor.position.z } : clampToArena(destination);
    const failure = this.grenadeLocationFailureReason(actor, point);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    actor.grenades = Math.max(0, actor.grenades - 1);
    this.addOrder({
      actorId: actor.id,
      kind: "grenade",
      destination: point,
      aim: "center",
      duration: 1.15,
    });
    return true;
  }

  // An aircraft drops a bomb straight down beneath itself — no target needed, aimed by position.
  queueBombDrop(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isAirBomber(actor)) return this.reject(`${actor.name} can't drop bombs`);
    return this.queueGrenadeAt(actor.position);
  }

  // ---- Transport / APC carry: load a friendly ground unit, carry it, and unload it ----
  // The air transport flies to its passenger and to the unload point; the APC is the two-seat
  // GROUND version — it takes aboard whoever is beside it and sets them down beside it.

  private loadFailureReason(actor: CombatEntity | undefined, passenger: CombatEntity | undefined): string | undefined {
    if (!actor || !isCarrierKind(actor.kind)) return "Only a transport or APC can carry units";
    if (!actor.status.alive || !actor.status.canMove) return `${actor.name} can't move`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    if ((actor.passengerIds?.length ?? 0) >= TRANSPORT_CAPACITY) return `${actor.name} is full (${TRANSPORT_CAPACITY} aboard)`;
    if (!passenger || !passenger.status.alive) return "Pick a friendly unit to airlift";
    if (passenger.id === actor.id || passenger.team !== actor.team) return "Can only airlift your own units";
    if (passenger.flying || isBuildingKind(passenger.kind) || isDefenseKind(passenger.kind) || passenger.kind === "cover") return "That unit can't be airlifted";
    if (passenger.carriedById) return `${passenger.name} is already aboard`;
    if (actor.kind === "apc" && (!isInfantryKind(passenger.kind) || passenger.kind === "jumper")) return "An APC only carries foot troops";
    if (actor.kind === "apc" && dist(actor.position, passenger.position) > actor.radius + passenger.radius + APC_LOAD_REACH) return `${passenger.name} must be beside the APC to board`;
    return undefined;
  }

  /** Whether the selected transport / APC could pick up the given unit (for HUD affordances). */
  canAirlift(passengerId: string): boolean {
    return !this.loadFailureReason(this.selected, this.entity(passengerId));
  }

  queueLoad(passengerId: string): boolean {
    const actor = this.requirePlayerActor();
    const passenger = this.entity(passengerId);
    const failure = this.loadFailureReason(actor, passenger);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor!)) return this.reject(`${actor!.name} has no command points`);
    this.addOrder({ actorId: actor!.id, kind: "load", targetId: passengerId, aim: "center", duration: actor!.kind === "apc" ? 1.2 : 2.6 });
    return true;
  }

  queueUnload(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isCarrierKind(actor.kind)) return this.reject(`${actor.name} can't carry units`);
    if (!(actor.passengerIds?.length)) return this.reject(`${actor.name} isn't carrying anyone`);
    const point = clampToArena(destination);
    if (actor.kind === "apc" && dist(actor.position, point) > actor.radius + APC_UNLOAD_REACH) return this.reject("An APC sets its troops down beside itself — pick a spot next to it");
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({ actorId: actor.id, kind: "unload", destination: point, aim: "center", duration: actor.kind === "apc" ? 1.2 : 2.4 });
    return true;
  }

  // Set a transport's passengers back on the ground at free spots near it, and clear the links.
  private dropPassengers(transport: CombatEntity): void {
    for (const pid of [...(transport.passengerIds ?? [])]) {
      const passenger = this.entity(pid);
      if (!passenger) continue;
      passenger.carriedById = undefined;
      passenger.position = this.freeSpawnNear(transport);
      this.syncEntityElevation(passenger); // back to ground level
      this.pushLog(`${transport.name} sets down ${passenger.name}`);
    }
    transport.passengerIds = [];
  }

  // Carried passengers ride with their transport each frame; if the transport is destroyed, they
  // bail out where it falls (permadeath cargo — losing a loaded transport hurts).
  private syncCarriedPassengers(): void {
    for (const passenger of this.entities) {
      if (!passenger.carriedById) continue;
      const carrier = this.entity(passenger.carriedById);
      if (!carrier || !carrier.status.alive) {
        passenger.carriedById = undefined;
        passenger.position = this.freeSpawnNear(carrier ?? passenger);
        this.syncEntityElevation(passenger);
        if (carrier) {
          carrier.passengerIds = (carrier.passengerIds ?? []).filter((id) => id !== passenger.id);
          this.pushLog(`${passenger.name} bails out of the falling ${carrier.name}`);
        }
        continue;
      }
      passenger.position = { ...carrier.position };
      passenger.elevation = carrier.elevation; // rides at altitude with the transport (it's hidden anyway)
    }
  }

  // Fire a unit's explosive round (tank/artillery shell, mortar/grenadier round, turret) at a
  // ground spot rather than a specific enemy part.
  queueShootAt(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!canGroundShellAttack(actor)) return this.reject(`${actor.name} cannot fire at the ground`);
    if (!actor.status.canShoot) return this.reject(`${actor.name} cannot shoot`);
    if (actor.kind === "artillery" && !actor.deployed) return this.reject(`${actor.name} must deploy before it can fire`);
    if (this.isPowerCut(actor)) return this.reject(`${actor.name} has no power — the conduit is cut`);
    const point = clampToArena(destination);
    const projected = this.projectedActorForPreview(actor);
    if (dist(muzzlePoint(projected, "weapon"), point) > projectileRange(actor, "weapon")) return this.reject("Ground target is out of range");
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({ actorId: actor.id, kind: "shoot", destination: point, aim: "center", duration: 1.35 });
    return true;
  }

  // ---- Mortar smoke round ----

  smokeFailureReason(actor: CombatEntity | undefined, point?: Vec2): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "mortar") return "Only a mortar fires smoke rounds";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (!actor.status.canShoot) return `${actor.name} cannot fire — its tube is destroyed`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    if (point) {
      const projected = this.projectedActorForPreview(actor);
      if (dist(muzzlePoint(projected, "weapon"), point) > projectileRange(actor, "weapon")) return "Smoke target is out of range";
    }
    return undefined;
  }

  /** Player API: lob a smoke round at a ground point (1 CP, mortar range). The cloud that lands
   *  blocks flat line of fire through it for SMOKE_TURNS turns; arcing rounds sail over it. */
  queueSmokeAt(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const point = clampToArena(destination);
    const failure = this.smokeFailureReason(actor, point);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({ actorId: actor.id, kind: "smoke", destination: point, aim: "center", duration: 1.35 });
    this.pushLog(`${actor.name} lays a smoke round on the marked spot`);
    return true;
  }

  // ---- Artillery deploy ----

  deployFailureReason(actor: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "artillery") return "Only artillery deploys";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (actor.deployed) return `${actor.name} is already deployed`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    if (this.orders.some((o) => o.actorId === actor.id && (o.kind === "move" || o.kind === "ram"))) return `${actor.name} can't deploy while it has a move queued`;
    return undefined;
  }

  /** Player API: plant the artillery's outriggers (whole turn). It fires only while deployed and
   *  packing up to move costs a turn again. An artillery that simply does not move also deploys
   *  on its own at end of turn — this order just says so explicitly. */
  queueDeploy(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const failure = this.deployFailureReason(actor);
    if (failure) return this.reject(failure);
    actor.commandPoints = 0;
    this.addOrder({ actorId: actor.id, kind: "deploy", aim: "center", duration: 1.4 });
    this.pushLog(`${actor.name} plants its outriggers`);
    return true;
  }

  // ---- Drone op recon pulse ----

  reconFailureReason(actor: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "droneop") return "Only a drone operator can send a recon pulse";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (!actor.parts.some((p) => p.role === "utility" && p.hp > 0)) return `${actor.name}'s drone is destroyed`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    if (actor.commandPoints < actor.maxCommandPoints || this.orders.some((o) => o.actorId === actor.id)) return `${actor.name} needs its whole turn for a recon pulse`;
    if (this.revealedOrders && (!this.hotseat || this.revealedTeam === actor.team)) return "The enemy's orders are already revealed";
    return undefined;
  }

  /** Player API: the drone op spends its whole turn on a pulse that reveals every enemy unit's
   *  next order (see enemyIntents()) during the player's next command phase. */
  queueRecon(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const failure = this.reconFailureReason(actor);
    if (failure) return this.reject(failure);
    actor.commandPoints = 0;
    this.addOrder({ actorId: actor.id, kind: "recon", aim: "center", duration: 1.4 });
    this.pushLog(`${actor.name} sends the drone up for a recon pulse`);
    return true;
  }

  /**
   * What each enemy unit will do this coming resolve, once a recon pulse has revealed it: the
   * enemy AI is DRY-RUN against the current board and everything it touched (command points,
   * grenades, the order list, the log, the rng stream) is put back, so the real decision at
   * endTurn is byte-identical to the preview. Cached per turn; empty when nothing is revealed.
   */
  enemyIntents(): EnemyIntent[] {
    if (!this.revealedOrders || this.phase !== "command") return [];
    // HOTSEAT: the other seat is a human, so there is no AI to dry-run. The seat that flew the pulse
    // plans SECOND the next turn (main.ts) and sees the other human's real, already-queued orders.
    if (this.hotseat) {
      if (this.revealedTeam !== "player") return [];
      return this.orders
        .filter((o) => !o.done && this.entity(o.actorId)?.team === "enemy")
        .map((o) => ({ actorId: o.actorId, kind: o.kind, destination: o.destination ? { ...o.destination } : undefined, targetId: o.targetId }));
    }
    if (this.enemyIntentCache?.turn === this.turn) return this.enemyIntentCache.list;
    const rngState = this.rng.save();
    const snapshot = this.entities.map((e) => ({ e, cp: e.commandPoints, grenades: e.grenades, yaw: e.yaw }));
    const orderCount = this.orders.length;
    const orderSeq = this.orderSeq;
    const logBefore = this.log.slice();
    this.previewingEnemy = true;
    try {
      this.queueEnemyOrders(true);
    } finally {
      this.previewingEnemy = false;
    }
    const list: EnemyIntent[] = this.orders.slice(orderCount).map((o) => ({
      actorId: o.actorId, kind: o.kind,
      destination: o.destination ? { ...o.destination } : undefined,
      targetId: o.targetId,
    }));
    this.orders.length = orderCount;
    this.orderSeq = orderSeq;
    this.log.splice(0, this.log.length, ...logBefore);
    for (const { e, cp, grenades, yaw } of snapshot) { e.commandPoints = cp; e.grenades = grenades; e.yaw = yaw; }
    this.rng.load(rngState);
    this.enemyIntentCache = { turn: this.turn, list };
    return list;
  }

  /** Whether a flat shot along from->to passes through a smoke cloud. */
  private smokeBlocksSegment(from: Vec2, to: Vec2): boolean {
    for (const cloud of this.smokeClouds) {
      if (pointToSegmentDistance(cloud, from, to) <= cloud.radius) return true;
    }
    return false;
  }

  /** Where along from->to a flat round first enters a smoke cloud (0..1), or undefined. */
  private smokeEntryProgress(from: Vec2, to: Vec2): number | undefined {
    let best: number | undefined;
    for (const cloud of this.smokeClouds) {
      if (pointToSegmentDistance(cloud, from, to) > cloud.radius) continue;
      const progress = clamp(segmentProgress(cloud, from, to), 0, 1);
      if (best === undefined || progress < best) best = progress;
    }
    return best;
  }

  private burstSmokeAt(actor: CombatEntity, point: Vec2): void {
    const at = clampToArena({ ...point });
    this.smokeClouds.push({ id: `smoke-${++this.effectSeq}`, x: at.x, z: at.z, radius: SMOKE_RADIUS, turnsLeft: SMOKE_TURNS });
    this.effect("blast", at, at, SMOKE_COLOR, 0.9, SMOKE_RADIUS);
    this.pushLog(`${actor.name}'s smoke round blooms — flat shots through it are lost`);
  }

  private runSmokeTick(): void {
    if (!this.smokeClouds.length) return;
    for (const cloud of this.smokeClouds) cloud.turnsLeft -= 1;
    this.smokeClouds.splice(0, this.smokeClouds.length, ...this.smokeClouds.filter((cloud) => cloud.turnsLeft > 0));
  }

  // True when the selected unit can aim its weapon at the ground (explosive direct/indirect fire).
  selectedCanGroundTarget(): boolean {
    const actor = this.selected;
    return Boolean(actor && actor.team === "player" && canGroundShellAttack(actor) && actor.status.canShoot && actor.commandPoints > 0 && this.phase === "command");
  }

  // Preview an explosive thrown/fired at a ground spot: the arc, the blast radius, whether it
  // reaches, and whether terrain or a unit in front intercepts it before the marked spot.
  groundAimPreview(point: Vec2): {
    from: Vec2; fromHeight: number; to: Vec2; toHeight: number; arcHeight: number;
    radius: number; reachable: boolean; blocked: boolean; hit?: { point: Vec2; height: number };
  } | undefined {
    const actor = this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command") return undefined;
    const grenade = this.intent === "grenade" && canUseHandGrenade(actor);
    const shell = this.intent === "shoot" && canGroundShellAttack(actor) && actor.status.canShoot;
    if (!grenade && !shell) return undefined;
    // An aircraft's bomb always lands directly beneath it — the disc previews the drop, not a lob.
    const airDrop = grenade && isAirBomber(actor);
    const to = airDrop ? { x: actor.position.x, z: actor.position.z } : clampToArena(point);
    const projected = this.projectedActorForPreview(actor);
    projected.yaw = Math.atan2(to.x - projected.position.x, to.z - projected.position.z);
    const attackMode: AttackMode = grenade ? "grenade" : "weapon";
    const from = muzzlePoint(projected, attackMode);
    const fromHeight = muzzleHeight(projected, attackMode);
    const kind = grenade ? "grenade" : projectileKind(actor, "weapon");
    const horizontal = dist(from, to);
    const reachable = airDrop || horizontal <= (grenade ? grenadeThrowRange(actor) : projectileRange(actor, "weapon"));
    const toHeight = terrainHeightAt(to) + 0.14;
    const arcHeight = airDrop ? 0 : grenade ? projectileArcHeight("grenade", horizontal) : Math.max(projectileArcHeight(kind, horizontal, actor.kind), 0.6);
    const radius = explosiveBlast(kind).radius;
    const ground = firstGroundBetweenShot(from, to, fromHeight, toHeight, arcHeight);
    const obstacle = ground ? undefined : this.firstEntityBetweenShot(from, to, fromHeight, toHeight, actor.id, "", arcHeight);
    const cover = ground || obstacle ? undefined : this.firstCoverBetweenShot(from, to, fromHeight, toHeight, undefined, arcHeight);
    const hit = ground
      ? { point: ground.point, height: ground.height }
      : obstacle
        ? { point: { ...obstacle.position }, height: obstacle.elevation + obstacle.height * 0.5 }
        : cover
          ? { point: { ...cover.position }, height: cover.elevation + cover.height * 0.5 }
          : undefined;
    return { from, fromHeight, to, toHeight, arcHeight, radius, reachable, blocked: Boolean(hit), hit };
  }

  queueRam(targetId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    const failure = this.ramFailureReason(actor, target);
    if (failure) return this.reject(failure);
    if (!actor) return false;
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({
      actorId: actor.id,
      kind: "ram",
      targetId,
      aim: "center",
      duration: 1.85,
    });
    return true;
  }

  previewRam(targetId: string): { ok: boolean; reason?: string } {
    const failure = this.ramFailureReason(this.selected, this.entity(targetId));
    return failure ? { ok: false, reason: failure } : { ok: true };
  }

  explainRamTarget(targetId: string): boolean {
    const status = this.previewRam(targetId);
    if (status.reason) this.reject(status.reason);
    return status.ok;
  }

  previewMelee(targetId: string): { ok: boolean; reason?: string } {
    const failure = this.meleeFailureReason(this.selected, this.entity(targetId));
    return failure ? { ok: false, reason: failure } : { ok: true };
  }

  explainMeleeTarget(targetId: string): boolean {
    const status = this.previewMelee(targetId);
    if (status.reason) this.reject(status.reason);
    return status.ok;
  }

  // Estimated strike damage for the selected unit against a target (shown on the Strike button).
  previewMeleeDamage(targetId: string, partId?: string): number | undefined {
    const actor = this.selected;
    const target = this.entity(targetId);
    if (!actor || !target) return undefined;
    return this.meleeDamageEstimate(actor, target, partId).amount;
  }

  private meleeDamageEstimate(actor: CombatEntity, target: CombatEntity, partId?: string): { amount: number; part: DamagePart } {
    const targetPart = partId
      ? preferredPartByIdOrAim(target, partId, "weakest")
      : preferredPart(target, target.kind === "cover" ? "center" : "weakest");
    const base = target.kind === "cover" ? MELEE_BASE_COVER : MELEE_BASE_UNIT;
    const amount = Math.round(base * (target.kind === "cover" ? 1 : vulnerabilityMultiplier(target, targetPart)) * this.teamDamageScale(actor) * meleeStrikeMultiplier(actor));
    return { amount, part: targetPart };
  }

  projectedSelected(): { position: Vec2; elevation: number; stance: InfantryStance } | undefined {
    const actor = this.selected;
    if (!actor) return undefined;
    const projected = this.projectedActorForPreview(actor);
    return { position: { ...projected.position }, elevation: projected.elevation, stance: projected.stance };
  }

  selectedActionRange(): { kind: "ram" | "melee" | "grenade" | "move" | "overwatch" | "shoot"; radius: number; position: Vec2; elevation: number } | undefined {
    const actor = this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command") return undefined;
    const projected = this.projectedActorForPreview(actor);
    // Weapon reach while aiming. Without it the only way to learn a unit's range was to try
    // targets one by one and read "too far" — the single most asked "why can't I" in play.
    if (this.intent === "shoot" && actor.status.canShoot && projectileRange(actor, "weapon") > 0) {
      return { kind: "shoot", radius: projectileRange(actor, "weapon"), position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "overwatch" && !this.overwatchFailureReason(actor)) {
      return { kind: "overwatch", radius: this.overwatchRadius(actor), position: { ...projected.position }, elevation: projected.elevation };
    }
    // Show how far the unit can move this turn, centred on where it WILL stand after any
    // already-queued move (so a second move previews from the projected spot, not the origin).
    if (this.intent === "move" && actor.status.canMove && moveRange(actor) > 0) {
      return { kind: "move", radius: moveRange(actor), position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "grenade" && canUseHandGrenade(actor)) {
      return { kind: "grenade", radius: grenadeThrowRange(actor), position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "ram" && actor.kind === "tank" && actor.status.canMove) {
      return { kind: "ram", radius: ramRange(actor) + actor.radius, position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "melee" && isInfantryKind(actor.kind) && actor.status.canMove) {
      return { kind: "melee", radius: meleeRange(actor) + actor.radius, position: { ...projected.position }, elevation: projected.elevation };
    }
    return undefined;
  }

  queueMelee(targetId: string): boolean {
    return this.queueMeleePart(targetId, "");
  }

  queueMeleePart(targetId: string, partId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    const failure = this.meleeFailureReason(actor, target);
    if (failure) return this.reject(failure);
    if (!actor || !target) return false;
    const requestedPart = partId ? this.targetableParts(target).find((part) => part.id === partId) : undefined;
    if (partId && !requestedPart) return this.reject(`${target.name} does not have that targetable part`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    const targetPart = requestedPart ?? preferredPart(target, "weakest");
    this.addOrder({
      actorId: actor.id,
      kind: "melee",
      targetId,
      targetPartId: targetPart.id,
      aim: aimForPart(targetPart),
      duration: 0.78,
    });
    return true;
  }

  queueDefend(stance: InfantryStance = "crouched"): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isInfantryKind(actor.kind)) return this.reject("Only infantry can change stance");
    if (stance === "prone") return this.reject("Prone is unavailable in this slice");
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot change stance without mobility`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({
      actorId: actor.id,
      kind: "defend",
      aim: "center",
      stance: "crouched",
      duration: 0.52,
    });
    return true;
  }

  // ---- Home Base economy: deploy troops, upgrade income, upgrade tech ----

  // Combat units a side currently has on the field (excludes its base and neutral cover).
  fieldUnitCount(team: Team): number {
    return this.entities.filter((e) => e.status.alive && e.team === team && !isBuildingKind(e.kind) && !isDefenseKind(e.kind) && e.kind !== "cover").length;
  }

  troopCooldown(base: CombatEntity, kind: TroopKind): number {
    return base.spawnCooldowns?.[kind] ?? 0;
  }

  // Why a base cannot deploy this troop right now, or undefined if it can.
  spawnFailureReason(base: CombatEntity | undefined, kind: TroopKind): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base to deploy troops";
    if (!base.status.alive) return `${base.name} is disabled`;
    if (!base.status.canProduce) return `${base.name} cannot deploy troops`;
    const spec = troopSpec(kind);
    const faction = this.factionOf(base.team);
    if (!faction.roster.includes(kind)) return `${spec.label} is not in the ${faction.name} roster`;
    if (spec.tech && !isTechUnlocked(base, spec.tech)) {
      const node = techNode(spec.tech);
      return `${spec.label} needs ${node?.name ?? "research"} first`;
    }
    const cooldown = this.troopCooldown(base, kind);
    if (cooldown > 0) return `${spec.label} on cooldown (${cooldown} turn${cooldown === 1 ? "" : "s"})`;
    if (this.fieldUnitCount(base.team) >= POP_CAP) return `Field is full (${POP_CAP} units)`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    if (base.commandPoints <= 0) return `${base.name} has no command points`;
    return undefined;
  }

  /** Quick deploy: the troop appears at the base's own auto-picked spot (`freeSpawnNear`). The
   *  tutorial, the enemy AI and the smokes use this path; the HUD card's second click too. */
  queueSpawnTroop(kind: TroopKind): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    const ok = this.spawnTroopFor(base, kind);
    if (ok && this.pendingDeploy === kind) this.setPendingDeploy(undefined);
    return ok;
  }

  // ---- Placed deploy: the player picks the spot inside the ring around the base ----

  // How far from its base a troop can be fielded (radius around the base centre).
  deployPlacementRadius(base: CombatEntity): number {
    return base.radius + 6;
  }

  // The placement footprint for the armed deploy, or undefined if not placing a troop.
  deployPlacement(): { center: Vec2; radius: number } | undefined {
    if (this.intent !== "deploy" || !this.pendingDeploy) return undefined;
    const base = this.selected;
    if (!base || base.kind !== "base" || base.team !== "player") return undefined;
    return { center: { ...base.position }, radius: this.deployPlacementRadius(base) };
  }

  setPendingDeploy(kind: TroopKind | undefined): void {
    this.pendingDeploy = kind;
    this.intent = kind ? "deploy" : "select";
    if (kind) {
      this.pendingBuild = undefined;
      this.pendingSupport = undefined;
    }
  }

  // The footprint a troop of this kind needs on the ground (rng-free probe entity, never fielded).
  private troopFootprint(kind: TroopKind, team: Team): { radius: number; flying: boolean } {
    const probe = makeTroop(kind, "probe", "probe", team, { x: 0, z: 0 });
    return { radius: probe.radius, flying: Boolean(probe.flying) };
  }

  // Same clearance rules as `freeSpawnNear`: clear of the base and every living body (sized to
  // THIS unit), off a terrain step, and — for ground troops — dry.
  private deploySpotBlocked(base: CombatEntity, point: Vec2, unitRadius: number, flying: boolean): boolean {
    if (dist(point, base.position) < base.radius + unitRadius + 0.3) return true;
    if (this.entities.some((e) => e.id !== base.id && e.status.alive && !e.carriedById && dist(e.position, point) < e.radius + unitRadius + 0.3)) return true;
    if (onTerrainEdge(point, spawnClearance(unitRadius))) return true;
    if (!flying && pointInWater(point)) return true;
    return false;
  }

  /** Where a troop would actually land if deployed at `point`: the point itself when clear, else
   *  the nearest clear spot within `DEPLOY_SNAP` of it that is still inside the ring. `reason` is
   *  set when there is no such spot (and `point` is then the clicked point, unchanged). */
  deployPointPreview(base: CombatEntity | undefined, kind: TroopKind, point: Vec2): { point: Vec2; snapped: boolean; reason?: string } {
    const clicked = clampToArena(point);
    if (!base || base.kind !== "base") return { point: clicked, snapped: false, reason: "Select your Home Base to deploy troops" };
    const ring = this.deployPlacementRadius(base);
    if (dist(clicked, base.position) > ring) return { point: clicked, snapped: false, reason: "Deploy inside the ring around your base" };
    const { radius, flying } = this.troopFootprint(kind, base.team);
    if (!this.deploySpotBlocked(base, clicked, radius, flying)) return { point: clicked, snapped: false };
    let best: Vec2 | undefined;
    let bestDist = Infinity;
    // Reach is measured to the footprint EDGE, so a trooper clicked onto another trooper still
    // finds the spot beside it (two 0.65 bodies plus the 0.3 gap need 1.6 centre to centre).
    const reach = DEPLOY_SNAP + radius;
    for (let r = 0.3; r <= reach + 1e-6; r += 0.3) {
      for (let i = 0; i < 16; i += 1) {
        const angle = (Math.PI * 2 * i) / 16;
        const candidate = clampToArena({ x: clicked.x + Math.sin(angle) * r, z: clicked.z + Math.cos(angle) * r });
        if (dist(candidate, base.position) > ring) continue;
        if (this.deploySpotBlocked(base, candidate, radius, flying)) continue;
        const d = dist(candidate, clicked);
        if (d < bestDist) { bestDist = d; best = candidate; }
      }
      if (best) break;
    }
    if (best) return { point: best, snapped: true };
    const spec = troopSpec(kind);
    const why = !flying && pointInWater(clicked) ? "in the water" : onTerrainEdge(clicked, spawnClearance(radius)) ? "on a cliff edge" : "blocked";
    return { point: clicked, snapped: false, reason: `No room for ${spec.label} there (${why})` };
  }

  /** Player API: field `kind` at a chosen point inside the deploy ring. Spends the CP and cash
   *  exactly once, only when the spot is accepted; a rejection costs nothing. */
  queueDeployAt(kind: TroopKind, point: Vec2): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    const failure = this.spawnFailureReason(base, kind);
    if (failure) return this.reject(failure);
    const spot = this.deployPointPreview(base, kind, point);
    if (spot.reason) return this.reject(spot.reason);
    const ok = this.spawnTroopFor(base, kind, spot.point);
    if (ok) this.setPendingDeploy(undefined);
    return ok;
  }

  private spawnTroopFor(base: CombatEntity, kind: TroopKind, at?: Vec2): boolean {
    const failure = this.spawnFailureReason(base, kind);
    if (failure) return this.reject(failure);
    const spec = troopSpec(kind);
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    const unit = this.createTroop(kind, base, at);
    this.entities.push(unit);
    this.syncEntityElevation(unit);
    // The deployed troop holds position until the next turn.
    unit.commandPoints = 0;
    base.spawnCooldowns = { ...(base.spawnCooldowns ?? {}), [kind]: spec.cooldown };
    this.pushLog(`${base.name} deploys ${unit.name}`);
    return true;
  }

  private createTroop(kind: TroopKind, base: CombatEntity, at?: Vec2): CombatEntity {
    const spec = troopSpec(kind);
    const prefix = base.team === "player" ? "p" : "e";
    const id = `${prefix}-spawn-${++this.troopSeq}`;
    const name = `${spec.label} ${this.troopSeq}`;
    const spawnAt = makeTroop(kind, id, name, base.team, base.position);
    // Clearance is sized to THIS unit: a tank fielded with an infantry-sized gap sat inside the
    // nearest crate or wall. A placed deploy (`at`) was validated by deployPointPreview.
    spawnAt.position = at ? { ...at } : this.freeSpawnNear(base, spawnAt.radius);
    if (!spawnAt.flying) spawnAt.position = nearestDryPoint(spawnAt.position);
    const unit = spawnAt;
    // Difficulty scaling: enemy units field with more health on higher difficulties.
    if (base.team === "enemy") scaleEntityHp(unit, DIFFICULTY_MODS[this.difficulty].enemyHp);
    // Specialization scaling: Bulwark Training / Reactive Plating deploy tougher units.
    const eff = this.teamTech(base.team);
    if (isInfantryKind(unit.kind)) scaleEntityHp(unit, eff.infantryHp);
    else if (isVehicleKind(unit.kind)) scaleEntityHp(unit, eff.vehicleHp);
    return unit;
  }

  upgradeBaseIncome(): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    return this.upgradeIncomeFor(base);
  }

  private upgradeIncomeFor(base: CombatEntity): boolean {
    if (base.kind !== "base") return this.reject("Only the Home Base can be upgraded");
    if (!base.status.alive) return this.reject(`${base.name} is disabled`);
    const cost = incomeUpgradeCost(base);
    if (cost === undefined) return this.reject(`${base.name} income is already maxed`);
    if (this.money(base.team) < cost) return this.reject(`Not enough money to boost income ($${cost})`);
    if (base.commandPoints <= 0) return this.reject(`${base.name} has no command points`);
    spendCommandPoint(base);
    this.addMoney(base.team, -cost);
    base.incomeLevel = (base.incomeLevel ?? 0) + 1;
    this.pushLog(`${base.name} boosts income to tier ${base.incomeLevel} ($${baseIncomeRate(base)}/turn)`);
    return true;
  }

  upgradeBaseCommand(): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    return this.upgradeCommandFor(base);
  }

  private upgradeCommandFor(base: CombatEntity): boolean {
    if (base.kind !== "base") return this.reject("Only the Home Base can be upgraded");
    if (!base.status.alive) return this.reject(`${base.name} is disabled`);
    if (commandUpgradeCost(base) === undefined) return this.reject(`${base.name} command is already upgraded`);
    if (this.money(base.team) < COMMAND_UPGRADE_COST) return this.reject(`Not enough money to upgrade command ($${COMMAND_UPGRADE_COST})`);
    if (base.commandPoints <= 0) return this.reject(`${base.name} has no command points`);
    spendCommandPoint(base);
    this.addMoney(base.team, -COMMAND_UPGRADE_COST);
    base.maxCommandPoints = 2;
    this.pushLog(`${base.name} upgrades to 2 command points per turn`);
    return true;
  }

  // ---- Buildable base defenses: turret, wall, explosive turret ----

  // How close to its base a structure can be placed (radius around the base centre).
  defensePlacementRadius(base: CombatEntity): number {
    return base.radius + 9.5;
  }

  // The placement footprint for the active build order, or undefined if not building.
  buildPlacement(): { center: Vec2; radius: number } | undefined {
    if (this.intent !== "build" || !this.pendingBuild) return undefined;
    const base = this.selected;
    if (!base || base.kind !== "base" || base.team !== "player") return undefined;
    return { center: { ...base.position }, radius: this.defensePlacementRadius(base) };
  }

  setPendingBuild(kind: DefenseKind | undefined): void {
    this.pendingBuild = kind;
    this.intent = kind ? "build" : "select";
    if (kind) this.pendingDeploy = undefined;
  }

  // ---- Off-map support powers (airstrike / cluster / orbital lance) ----

  setPendingSupport(kind: SupportPowerKind | undefined): void {
    this.pendingSupport = kind;
    this.intent = kind ? "support" : "select";
    if (kind) {
      this.pendingBuild = undefined;
      this.pendingDeploy = undefined;
    }
  }

  supportCooldown(base: CombatEntity, kind: SupportPowerKind): number {
    return base.supportCooldowns?.[kind] ?? 0;
  }

  // Why a support power can't be called right now, or undefined if it can.
  supportFailureReason(base: CombatEntity | undefined, kind: SupportPowerKind): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base to call support";
    if (!base.status.alive) return `${base.name} is disabled`;
    const spec = supportPowerSpec(kind);
    const supportFaction = this.factionOf(base.team);
    if (!supportFaction.supports.includes(kind)) return `${spec.label} is not a ${supportFaction.name} asset`;
    if (spec.tech && !isTechUnlocked(base, spec.tech)) {
      const tech = techNode(spec.tech);
      return `Research ${tech?.name ?? "the required doctrine"} to unlock ${spec.label}`;
    }
    if (base.commandPoints <= 0) return `${base.name} has no command points`;
    const cooldown = this.supportCooldown(base, kind);
    if (cooldown > 0) return `${spec.label} on cooldown (${cooldown} turn${cooldown === 1 ? "" : "s"})`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    return undefined;
  }

  // Commit the pending support power at a ground point (the HUD targeting flow). The strike
  // itself flies in during the next resolve; line powers align away from the calling base.
  queueSupportAt(point: Vec2): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    const kind = this.pendingSupport;
    if (!kind) return this.reject("Choose a support power first");
    const failure = this.supportFailureReason(base, kind);
    if (failure) return this.reject(failure);
    const spec = supportPowerSpec(kind);
    const target = clampToArena(point);
    const dx = target.x - base.position.x;
    const dz = target.z - base.position.z;
    const len = Math.hypot(dx, dz);
    const dir = len > 0.01 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    base.supportCooldowns = { ...(base.supportCooldowns ?? {}), [kind]: spec.cooldown };
    this.queuedSupport.push({ kind, point: target, dir });
    this.pendingSupport = undefined;
    this.intent = "select";
    this.pushLog(
      kind === "airstrike" ? `${base.name} tasks a strike wing — bombs on the next resolve`
      : kind === "cluster" ? `${base.name} authorizes a cluster strike — saturation on the next resolve`
      : `${base.name} requests the orbital lance — beam on the next resolve`,
    );
    return true;
  }

  // Convert committed support calls into staggered detonations + fly-in visuals.
  private scheduleSupportStrikes(): void {
    for (const call of this.queuedSupport) {
      const { kind, point, dir } = call;
      if (kind === "airstrike") {
        // The jet crosses the whole line low and fast; bombs walk behind it.
        const from = clampToArena({ x: point.x - dir.x * 16, z: point.z - dir.z * 16 });
        const to = clampToArena({ x: point.x + dir.x * 16, z: point.z + dir.z * 16 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0xffc37a, duration: 1.5 });
        for (let i = 0; i < 5; i += 1) {
          const p = clampToArena({ x: point.x + dir.x * (i - 2) * 1.7, z: point.z + dir.z * (i - 2) * 1.7 });
          this.pendingStrikes.push({ at: 1.0 + i * 0.13, point: p, radius: 1.9, damage: 42, kind: "airstrike" });
        }
      } else if (kind === "cluster") {
        const from = clampToArena({ x: point.x - dir.x * 14, z: point.z - dir.z * 14 });
        const to = clampToArena({ x: point.x + dir.x * 14, z: point.z + dir.z * 14 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0xffb02e, duration: 1.5 });
        for (let i = 0; i < 8; i += 1) {
          const angle = this.rng.range(0, Math.PI * 2);
          const r = Math.sqrt(this.rng.range(0, 1)) * 3.2;
          const p = clampToArena({ x: point.x + Math.sin(angle) * r, z: point.z + Math.cos(angle) * r });
          this.pendingStrikes.push({ at: 1.1 + i * 0.09, point: p, radius: 1.35, damage: 24, kind: "cluster" });
        }
      } else {
        // The lance burns for ~2s and its detonations sweep down the line with it.
        const from = clampToArena({ x: point.x - dir.x * 4.5, z: point.z - dir.z * 4.5 });
        const to = clampToArena({ x: point.x + dir.x * 4.5, z: point.z + dir.z * 4.5 });
        this.pendingFx.push({ at: 0.7, type: "beam", from, to, color: 0xff5a4d, duration: 1.9 });
        for (let i = 0; i < 7; i += 1) {
          const t = i / 6;
          const p = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
          this.pendingStrikes.push({ at: 0.9 + i * 0.22, point: p, radius: 1.15, damage: 32, kind: "laser" });
        }
      }
    }
    this.queuedSupport = [];
  }

  // Why a structure can't be placed at a point right now, or undefined if it can.
  buildFailureReason(base: CombatEntity | undefined, kind: DefenseKind, point: Vec2): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base to build defenses";
    if (!base.status.alive) return `${base.name} is disabled`;
    if (base.commandPoints <= 0) return `${base.name} has no command points`;
    const spec = defenseSpec(kind);
    const buildFaction = this.factionOf(base.team);
    if (!buildFaction.defenses.includes(kind)) return `${spec.label} is not a ${buildFaction.name} emplacement`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    if (dist(point, base.position) > this.defensePlacementRadius(base)) return `Place ${spec.label} closer to the base`;
    if (terrainHeightAt(point) > 1.2) return "Cannot build on a cliff top";
    const radius = defenseRadius(kind);
    const blocked = this.entities.some((e) => e.status.alive && e.id !== base.id && dist(e.position, point) < e.radius + radius + 0.2);
    if (blocked) return "Spot is blocked by another object";
    return undefined;
  }

  // Place a defense for the player at a ground point (used by the HUD build flow).
  queueBuildStructure(point: Vec2): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    const kind = this.pendingBuild;
    if (!kind) return this.reject("Choose a defense to build first");
    return this.buildStructureFor(base, kind, clampToArena(point));
  }

  private buildStructureFor(base: CombatEntity, kind: DefenseKind, point: Vec2): boolean {
    const failure = this.buildFailureReason(base, kind, point);
    if (failure) return this.reject(failure);
    const spec = defenseSpec(kind);
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    const structure = this.createDefenseEntity(kind, base, point);
    this.entities.push(structure);
    this.syncEntityElevation(structure);
    structure.commandPoints = 0; // can't act the turn it is built
    this.pendingBuild = undefined;
    this.intent = "select";
    this.pushLog(`${base.name} builds a ${spec.label}`);
    return true;
  }

  private createDefenseEntity(kind: DefenseKind, base: CombatEntity, point: Vec2): CombatEntity {
    const prefix = base.team === "player" ? "p" : "e";
    const id = `${prefix}-def-${++this.troopSeq}`;
    const spec = defenseSpec(kind);
    const name = `${spec.label} ${this.troopSeq}`;
    const structure =
      kind === "turret" ? createTurret(id, name, base.team, { ...point })
      : kind === "exturret" ? createExTurret(id, name, base.team, { ...point })
      : createWall(id, name, base.team, { ...point });
    scaleEntityHp(structure, tierHpMultiplier(structure.kind));
    if (base.team === "enemy") scaleEntityHp(structure, DIFFICULTY_MODS[this.difficulty].enemyHp);
    return structure;
  }

  // Defenses a side currently fields, capped separately from the troop population.
  defenseCount(team: Team): number {
    return this.entities.filter((e) => e.status.alive && e.team === team && isDefenseKind(e.kind)).length;
  }

  // Why a node cannot be researched right now, or undefined if it can.
  researchFailureReason(base: CombatEntity | undefined, nodeId: string): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base to research";
    if (!base.status.alive) return `${base.name} is disabled`;
    const node = techNode(nodeId);
    if (!node) return "Unknown research";
    const researchFaction = this.factionOf(base.team);
    if (!researchFaction.tech.includes(nodeId)) return `${node.name} is outside ${researchFaction.name} doctrine`;
    if (isTechUnlocked(base, nodeId)) return `${node.name} already researched`;
    if (!techPrereqsMet(base, node)) {
      const missing = node.requires.find((req) => !isTechUnlocked(base, req));
      return `${node.name} requires ${techNode(missing ?? "")?.name ?? "a prerequisite"}`;
    }
    // Specializations come in mutually-exclusive pairs: picking one permanently locks the sibling.
    const lockedBy = (base.unlockedTech ?? []).find((owned) => techNode(owned)?.excludes?.includes(nodeId) || node.excludes?.includes(owned));
    if (lockedBy) return `${node.name} is locked out by ${techNode(lockedBy)?.name ?? "your doctrine"}`;
    if (this.money(base.team) < node.cost) return `Not enough money to research ${node.name} ($${node.cost})`;
    if (base.commandPoints <= 0) return `${base.name} has no command points`;
    return undefined;
  }

  researchTech(nodeId: string): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    return this.researchTechFor(base, nodeId);
  }

  private researchTechFor(base: CombatEntity, nodeId: string): boolean {
    const failure = this.researchFailureReason(base, nodeId);
    if (failure) return this.reject(failure);
    const node = techNode(nodeId)!;
    spendCommandPoint(base);
    this.addMoney(base.team, -node.cost);
    base.unlockedTech = [...(base.unlockedTech ?? []), nodeId];
    this.pushLog(`${base.name} researches ${node.name}`);
    return true;
  }

  // A clear deployment spot just outside the base, fanning out on the unit's own side.
  private freeSpawnNear(base: CombatEntity, unitRadius = 0.5): Vec2 {
    const ring = base.radius + unitRadius + 1.1;
    const forward = base.team === "player" ? 1 : -1;
    for (let radius = ring; radius <= ring + 6; radius += 0.8) {
      for (let i = 0; i < 12; i += 1) {
        const angle = (Math.PI * 2 * i) / 12 + (forward > 0 ? 0 : Math.PI);
        const point = clampToArena({
          x: base.position.x + Math.sin(angle) * radius,
          z: base.position.z + Math.cos(angle) * radius,
        });
        const blocked = this.entities.some((e) => e.id !== base.id && e.status.alive && !e.carriedById && dist(e.position, point) < e.radius + unitRadius + 0.3)
          || onTerrainEdge(point, spawnClearance(unitRadius));
        if (!blocked) return point;
      }
    }
    return clampToArena({ x: base.position.x + forward * ring, z: base.position.z });
  }

  cancelOrder(orderId: string): boolean {
    if (this.phase !== "command") return this.reject("Orders can only be changed during command phase");
    let index = this.orders.findIndex((order) => order.id === orderId);
    if (index < 0) index = this.orders.findIndex((order) => order.actorId === orderId && this.entity(order.actorId)?.team === "player");
    const order = this.orders[index];
    const actor = this.entity(order?.actorId);
    if (!actor || actor.team !== "player" || index < 0) return false;
    this.orders.splice(index, 1);
    actor.commandPoints = Math.min(actor.maxCommandPoints, actor.commandPoints + 1);
    if (order.kind === "grenade") actor.grenades = Math.min(actor.maxGrenades, actor.grenades + 1);
    this.pushLog(`${actor.name} order cancelled`);
    return true;
  }

  targetableParts(target: CombatEntity): DamagePart[] {
    return target.parts.filter(isPartIntact);
  }

  previewShot(actorId: string, targetId: string, partId: string): ShotPreview | undefined {
    return this.previewAttack(actorId, targetId, partId, "weapon");
  }

  previewGrenade(actorId: string, targetId: string, partId: string): ShotPreview | undefined {
    return this.previewAttack(actorId, targetId, partId, "grenade");
  }

  previewGrenadeTarget(targetId: string): { ok: boolean; reason?: string } {
    const failure = this.grenadeFailureReason(this.selected, this.entity(targetId));
    return failure ? { ok: false, reason: failure } : { ok: true };
  }

  explainGrenadeTarget(targetId: string): boolean {
    const status = this.previewGrenadeTarget(targetId);
    if (status.reason) this.reject(status.reason);
    return status.ok;
  }

  private previewAttack(actorId: string, targetId: string, partId: string, attackMode: AttackMode): ShotPreview | undefined {
    // Elevations are refreshed every frame in update(); avoid an O(n) re-sync here so the
    // HUD can call previewAttack many times per frame without lagging.
    const sourceActor = this.entity(actorId);
    const intendedTarget = this.entity(targetId);
    if (!sourceActor || !intendedTarget || sourceActor.id === intendedTarget.id) return undefined;
    const intendedPart = this.targetableParts(intendedTarget).find((part) => part.id === partId);
    if (!intendedPart) return undefined;

    const actor = this.projectedActorForPreview(sourceActor);
    const aimPoint = aimPointFor(intendedTarget, intendedPart);
    const aimHeight = aimHeightFor(intendedTarget, intendedPart);
    actor.yaw = Math.atan2(aimPoint.x - actor.position.x, aimPoint.z - actor.position.z);
    const from = muzzlePoint(actor, attackMode);
    const fromHeight = muzzleHeight(actor, attackMode);
    const accuracy = this.accuracyForShot(actor, intendedTarget, intendedPart, this.actorHasQueuedMove(actor.id), attackMode);
    const kind = projectileKind(actor, attackMode);
    const arcHeight = projectileArcHeight(kind, dist(from, aimPoint), actor.kind);
    const ground = firstGroundBetweenShot(from, aimPoint, fromHeight, aimHeight, arcHeight);
    const warning = ground ? undefined : this.firstEntityBetweenShot(from, aimPoint, fromHeight, aimHeight, actor.id, intendedTarget.id, arcHeight);
    // A shot at a FLYING target sails up over ground cover (flyers forfeit terrain defense), so no
    // low prop intercepts it.
    const cover = ground || warning || intendedTarget.flying ? undefined : this.firstCoverBetweenShot(from, aimPoint, fromHeight, aimHeight, intendedTarget.id, arcHeight);
    // Smoke swallows a FLAT round; a lobbed grenade or a mortar/artillery arc sails over the cloud.
    const smoke = !ground && !warning && !cover && arcHeight <= 0.5 && this.smokeBlocksSegment(from, aimPoint);
    const impactTarget = warning ?? cover ?? intendedTarget;
    const impactPart = warning ? preferredPart(warning, warning.kind === "cover" ? "center" : "weakest") : cover ? preferredPart(cover, "center") : intendedPart;
    const aim = cover || warning ? "center" : aimForPart(intendedPart);
    const impactPoint = ground?.point ?? (warning || cover ? aimPointFor(impactTarget, impactPart) : aimPoint);
    const impactHeight = ground?.height ?? (warning || cover ? aimHeightFor(impactTarget, impactPart) : aimHeight);
    const friendlyWarning = warning && warning.team === actor.team ? warning : undefined;

    return {
      actorId,
      targetId,
      targetPartId: partId,
      impactEntityId: ground ? undefined : impactTarget.id,
      impactPartId: ground ? undefined : impactPart.id,
      from,
      aimPoint,
      impactPoint,
      fromHeight,
      aimHeight,
      impactHeight,
      amount: ground || smoke ? 0 : this.estimateShotDamage(actor, impactTarget, impactPart, aim, Boolean(cover), attackMode) * (attackMode === "weapon" ? burstCount(actor) : 1),
      accuracy: accuracy.rating,
      accuracyLabel: accuracy.label,
      hitChance: accuracy.hitChance,
      spreadDegrees: accuracy.spreadDegrees,
      accuracyNotes: accuracy.notes,
      projectileKind: kind,
      arcHeight,
      blockedById: cover?.id,
      blockedByGround: Boolean(ground),
      blockedBySmoke: smoke,
      warningEntityId: friendlyWarning?.id,
      warningText: friendlyWarning ? `Friendly fire risk: ${friendlyWarning.name} is in the path` : undefined,
    };
  }

  endTurn(): void {
    if (this.phase !== "command") return;
    // Last Stand: reinforcement waves crest every other round before the enemy acts.
    if (this.mode === "survival" && this.turn % 2 === 1 && this.phase === "command") this.spawnSurvivalWave();
    if (this.hotseat) {
      if (this.sidesSwapped) this.swapSides(); // always resolve as Player 1 = "player"
    } else {
      this.queueEnemyOrders();
    }
    this.revealedOrders = false; // the pulse covered exactly this one enemy command
    this.enemyIntentCache = undefined;
    // HULL DOWN. A tank with no move/ram order this resolve settles in and takes 30% less damage
    // until it moves. Decided here so the enemy AI's tanks get it on the same terms.
    // DEPLOY. Artillery that does not move this resolve plants its outriggers (it can fire from
    // next turn); artillery that moves packs them up. Same terms for both sides.
    for (const e of this.entities) {
      if (!e.status.alive || (e.kind !== "tank" && e.kind !== "artillery")) continue;
      const moving = this.orders.some((o) => o.actorId === e.id && !o.done && (o.kind === "move" || o.kind === "ram"));
      if (e.kind === "tank") {
        const was = Boolean(e.hullDown);
        e.hullDown = !moving;
        if (e.hullDown && !was) this.pushLog(`${e.name} goes hull down`);
      } else if (moving) {
        e.deployed = false;
      } else if (!e.deployed && !this.orders.some((o) => o.actorId === e.id && o.kind === "deploy")) {
        e.deployed = true;
        this.pushLog(`${e.name} deploys its outriggers`);
      }
    }
    this.scheduleMapStrikes();
    this.scheduleSupportStrikes();
    this.phase = "resolve";
    this.resolveClock = 0;
    this.activeTurnReport = { turn: this.turn, phase: "active", entries: [], notes: [] };
    this.pushLog(`Turn ${this.turn} resolving`);
    this.bus.emit("RESOLVE_START", { turn: this.turn });
  }

  reset(): void {
    // A hotseat restart from Player 2's planning seat must not hand Player 2's faction to Player 1.
    if (this.sidesSwapped) this.flipTeams();
    this.configure(this.mapDef, this.mode, this.difficulty, undefined, this.hotseat);
  }

  // ---------------------------------------------------------------------------
  // Debug / scenario harness
  // ----------------------------------------------------------------------------
  // Deterministic state-setup primitives so automated tests and capture scripts can cut
  // straight to a specific situation (and screenshot it) instead of driving the whole UI.
  // These bypass the economy/CP rules on purpose — they are dev tooling, not gameplay.

  // Drop a combat unit straight onto the field, ready to act (no cost, no cooldown).
  /**
   * Place an emplacement or the base directly, bypassing cost, placement radius and command points.
   * Debug/capture surface only -- debugSpawn covers troops, and the portrait sheet needs the other
   * half of what is actually on screen.
   */
  debugStructure(kind: DefenseKind | "base", team: Team, position: Vec2): CombatEntity {
    const id = `${team === "player" ? "p" : "e"}-dbg-${++this.troopSeq}`;
    const at = clampToArena(position);
    const entity = kind === "base" ? createBase(id, "Home Base", team, at)
      : kind === "turret" ? createTurret(id, "Gun Turret", team, at)
      : kind === "exturret" ? createExTurret(id, "Mortar Turret", team, at)
      : createWall(id, "Blast Wall", team, at);
    this.entities.push(entity);
    this.syncEntityElevation(entity);
    return entity;
  }

  /** Place a scenery/cover prop directly. Same purpose as debugStructure. */
  debugCover(coverKind: CoverKind, position: Vec2, options: { volatile?: boolean } = {}): CombatEntity {
    const profile = COVER_PROFILES[coverKind];
    const entity = createCover(`cover-dbg-${++this.troopSeq}`, profile.label, clampToArena(position), {
      coverKind,
      volatile: options.volatile ?? profile.volatile,
    });
    this.entities.push(entity);
    this.syncEntityElevation(entity);
    return entity;
  }

  /**
   * HOTSEAT: issue the enemy AI's orders for the PLAYER side during the command phase. Every
   * team-keyed thing (entity teams, economy, mines) is swapped, the AI runs as if the player's
   * army were its own (base purchases included), and everything is swapped back. This is how
   * balance.test.ts plays the one AI against itself. Test/debug surface only.
   */
  debugCommandAsAi(brain?: Difficulty): void {
    if (this.phase !== "command") return;
    this.flipTeams();
    const saved = this.brainOverride;
    if (brain) this.brainOverride = brain;
    try {
      this.queueEnemyOrders();
    } finally {
      this.brainOverride = saved;
      this.flipTeams();
    }
  }

  /** Hotseat: hand the "player" seat to the other human (and back). Command phase only. */
  swapSides(): void {
    if (this.phase !== "command") return;
    // The outgoing seat's planning lines ("Recruit 3 queued move", "sets overwatch ...") would tell
    // the other human exactly what was ordered. They are dropped, not deferred: the resolve reports
    // what actually happened.
    this.log.splice(0, Math.min(this.logSeq - this.seatLogMark, this.log.length));
    this.flipTeams();
    this.sidesSwapped = !this.sidesSwapped;
    this.seatLogMark = this.logSeq;
    // A seat with no troops out yet (turn 1) starts on its Home Base, as configure() does for
    // Player 1; otherwise nothing is selected, so no deck covers the board at the handoff.
    const own = this.entities.filter((e) => e.team === "player" && e.status.alive && e.kind !== "cover");
    this.selectedId = own.some((e) => !isBuildingKind(e.kind) && !isDefenseKind(e.kind)) ? "" : own.find((e) => isBuildingKind(e.kind))?.id ?? "";
    // Half-finished input belongs to the player who left the seat.
    this.intent = "select";
    this.pendingBuild = undefined;
    this.pendingDeploy = undefined;
    this.pendingSupport = undefined;
  }

  /** Hotseat: which human (1 or 2) owns a side in the CURRENT frame (it flips while Player 2 plans). */
  seatOf(team: Team): 1 | 2 {
    return (team === "player") !== this.sidesSwapped ? 1 : 2;
  }

  /** Hotseat: the seat that flew a recon pulse last resolve (it plans second this turn), if any. */
  revealedSeat(): 1 | 2 | undefined {
    return this.hotseat && this.revealedOrders ? this.seatOf(this.revealedTeam) : undefined;
  }

  /** How the log names a side: "You" / "Enemy" against the bot, "Player 1" / "Player 2" in hotseat. */
  private sideName(team: Team, vsBot: string): string {
    return this.hotseat && (team === "player" || team === "enemy") ? `Player ${this.seatOf(team)}` : vsBot;
  }

  // Everything team-keyed trades places: entities, mines, treasury, faction, and the mode's
  // scoreboard (scores, hill holders, flag owners), so the other seat sees its own side as "player".
  private flipTeams(): void {
    const flip = (team: Team): Team => (team === "player" ? "enemy" : team === "enemy" ? "player" : team);
    for (const e of this.entities) e.team = flip(e.team);
    for (const m of this.mines) m.team = flip(m.team);
    const player = this.economy.get("player") ?? 0;
    const enemy = this.economy.get("enemy") ?? 0;
    this.economy.set("player", enemy);
    this.economy.set("enemy", player);
    const f = this.factions.player;
    this.factions.player = this.factions.enemy;
    this.factions.enemy = f;
    const s = this.modeState;
    [s.playerScore, s.enemyScore] = [s.enemyScore, s.playerScore];
    if (s.hillHolder) s.hillHolder = flip(s.hillHolder);
    if (s.hillHolders) s.hillHolders = s.hillHolders.map((h) => (h ? flip(h) : h));
    for (const flag of s.flags) flag.team = flip(flag.team);
    this.revealedTeam = flip(this.revealedTeam);
  }

  debugSpawn(kind: TroopKind, team: Team, position: Vec2, options: { elite?: boolean; bossName?: string; clearTerrain?: boolean } = {}): CombatEntity {
    const id = `${team === "player" ? "p" : "e"}-dbg-${++this.troopSeq}`;
    const unit = makeTroop(kind, id, options.bossName ?? `${troopSpec(kind).label} ${this.troopSeq}`, team, clampToArena(position));
    // Placement bypasses the movement rules, so a ground unit could otherwise be dropped into a
    // water channel that movement would never have let it enter.
    if (!unit.flying) unit.position = nearestDryPoint(unit.position);
    if (team === "enemy") scaleEntityHp(unit, DIFFICULTY_MODS[this.difficulty].enemyHp);
    // Elites/bosses: substantially tougher, gold-trimmed, tracked by the top HP bar.
    if (options.elite || options.bossName) {
      unit.elite = true;
      unit.bossName = options.bossName;
      scaleEntityHp(unit, options.bossName ? 2.6 : 1.5);
    }
    unit.commandPoints = unit.maxCommandPoints;
    this.entities.push(unit);
    // Scenario staging drops units at literal offsets; push them out of whatever prop or body is
    // already there so a staged column never starts inside a crate.
    this.separateFromUnits(unit);
    // Opt-in (the title diorama): step off any terrain edge so the model is not inside a rise. Tests
    // and scenarios stage units at literal spots and must land exactly there.
    if (options.clearTerrain && !unit.flying) unit.position = clearOfTerrainEdge(unit.position, spawnClearance(unit.radius));
    this.syncEntityElevation(unit);
    return unit;
  }

  // Place a defensive structure (turret/wall/exturret) directly on the field.
  debugBuild(kind: DefenseKind, team: Team, position: Vec2): CombatEntity {
    const id = `${team === "player" ? "p" : "e"}-dbg-${++this.troopSeq}`;
    const name = `${defenseSpec(kind).label} ${this.troopSeq}`;
    const point = clampToArena(position);
    const structure =
      kind === "turret" ? createTurret(id, name, team, point)
      : kind === "exturret" ? createExTurret(id, name, team, point)
      : createWall(id, name, team, point);
    scaleEntityHp(structure, tierHpMultiplier(structure.kind));
    if (team === "enemy") scaleEntityHp(structure, DIFFICULTY_MODS[this.difficulty].enemyHp);
    this.entities.push(structure);
    this.syncEntityElevation(structure);
    // A staged wall lands where it is put; whatever was standing there steps aside.
    for (const other of this.entities) {
      if (other.id === structure.id || !other.status.alive || other.flying || other.kind === "cover" || isBuildingKind(other.kind) || isDefenseKind(other.kind)) continue;
      if (dist(other.position, structure.position) < other.radius + structure.radius) this.separateFromUnits(other);
    }
    return structure;
  }

  // Apply raw damage to a part (e.g. to stage a destroyed-part or near-dead state).
  // Passing a sourceId routes through the full damage funnel (explosions, toppling, kill
  // effects) exactly as if that entity dealt the blow.
  debugDamage(entityId: string, partId: string, amount: number, sourceId?: string): void {
    const entity = this.entity(entityId);
    if (!entity) return;
    const result = applyDamage(entity, partId, amount);
    const source = sourceId ? this.entity(sourceId) : undefined;
    if (source) this.afterDamage(source, entity, result);
  }

  // Disable every unit on a team — used to stage victory/defeat end screens.
  debugDefeatTeam(team: Team): void {
    for (const entity of this.entities.filter((e) => e.team === team)) {
      for (const part of entity.parts) part.hp = 0;
      recomputeStatus(entity);
    }
  }

  debugGrant(team: Team, money: number): void {
    this.economy.set(team, Math.max(0, money));
  }

  /** Clear the field entirely — the silhouette shape test stages its own row and wants nothing else. */
  debugClearField(): void {
    this.entities.length = 0;
    this.orders.length = 0;
    this.projectiles.length = 0;
    this.selectedId = "";
  }

  debugSelect(id: string): void {
    if (this.entity(id)) this.selectedId = id;
  }

  // Force the phase directly (e.g. to capture an end screen). Re-syncs elevations.
  debugSetPhase(phase: Phase): void {
    this.phase = phase;
    this.syncAllElevations();
  }

  // Serialize the live battle for the in-combat Save option. Entities are plain data objects,
  // so a JSON round-trip is sufficient.
  serialize(): string {
    // A hotseat save taken while Player 2 plans is written with the sides put back, so a restore
    // (which always resumes unswapped) cannot hand Player 1's army to Player 2.
    if (this.sidesSwapped) {
      this.flipTeams();
      try { return this.serializeState(); } finally { this.flipTeams(); }
    }
    return this.serializeState();
  }

  private serializeState(): string {
    return JSON.stringify({
      map: this.mapDef.id,
      mode: this.mode,
      difficulty: this.difficulty,
      factions: this.factions,
      droppedBridges: this.droppedBridges,
      turn: this.turn,
      economy: [...this.economy],
      entities: this.entities,
      orders: this.orders, // queued-but-unresolved orders survive a save so CP stays consistent
      modeState: this.modeState,
      troopSeq: this.troopSeq,
      detonated: [...this.detonated],
      toppled: [...this.toppled],
      overwatch: [...this.overwatching],
      overwatchFacing: [...this.overwatchFacing],
      wrecked: [...this.wrecked],
      salvage: [...this.salvage],
      burnZones: this.burnZones,
      gasClouds: this.gasClouds,
      smokeClouds: this.smokeClouds,
      revealedOrders: this.revealedOrders,
      revealedTeam: this.revealedTeam,
      queuedSupport: this.queuedSupport,
      hotseat: this.hotseat,
      mines: this.mines,
      pickups: this.pickups,
    });
  }

  // Load a saved battle. Returns false on malformed data. Always resumes in the command phase.
  restore(raw: string): boolean {
    try {
      const data = JSON.parse(raw) as {
        map: string; mode: ModeId; difficulty?: Difficulty; turn?: number; factions?: Partial<Record<Team, FactionId>>;
        droppedBridges?: number[];
        economy: [Team, number][]; entities: CombatEntity[]; orders?: TacticalOrder[]; modeState: ModeState; troopSeq?: number;
        detonated?: string[]; toppled?: string[]; overwatch?: [string, number][]; overwatchFacing?: [string, number][];
        wrecked?: string[]; salvage?: [string, number][];
        burnZones?: { id: string; x: number; z: number; radius: number; turnsLeft: number }[];
        gasClouds?: { id: string; x: number; z: number; radius: number; maxRadius: number }[];
        smokeClouds?: { id: string; x: number; z: number; radius: number; turnsLeft: number }[];
        revealedOrders?: boolean;
        revealedTeam?: Team;
        queuedSupport?: { kind: SupportPowerKind; point: Vec2; dir: Vec2 }[];
        hotseat?: boolean;
        mines?: { id: string; x: number; z: number; team: Team }[];
        pickups?: { id: string; x: number; z: number; amount: number }[];
      };
      const map = mapDef(data.map);
      this.mapDef = map;
      // Restore dropped spans BEFORE the terrain is applied, or a reload silently rebuilds the
      // bridge a player spent a turn destroying.
      this.droppedBridges = (data.droppedBridges ?? []).filter((i) => Number.isInteger(i) && i >= 0);
      this.applyTerrain();
      this.mode = data.mode;
      this.difficulty = data.difficulty ?? "normal";
      // Rebuilt as a fresh literal rather than assigned: guarantees key order (so serialize output
      // stays byte-stable), sanitizes a corrupt save, and lets pre-faction saves load.
      this.factions = {
        player: data.factions?.player ?? DEFAULT_FACTION,
        enemy: data.factions?.enemy ?? DEFAULT_FACTION,
        neutral: DEFAULT_FACTION,
      };
      this.entities.splice(0, this.entities.length, ...data.entities);
      this.economy.clear();
      for (const [team, amount] of data.economy) this.economy.set(team, amount);
      this.modeState = data.modeState;
      this.turn = data.turn ?? 1;
      this.troopSeq = data.troopSeq ?? 0;
      // Resume queued orders whose actor still exists and that have NOT yet executed (never
      // resurrect a fired shot or completed action), so a save mid-command-phase keeps command
      // points consistent — dropping the order while keeping its spent CP silently robs the player.
      const liveIds = new Set(this.entities.map((e) => e.id));
      this.orders.splice(0, this.orders.length, ...(data.orders ?? []).filter((o) => liveIds.has(o.actorId) && !o.fired && !o.done));
      this.projectiles.splice(0);
      this.effects.splice(0);
      this.defending.clear();
      this.overwatching.clear();
      this.overwatchFacing.clear();
      // Restore which volatile covers already blew up, so a destroyed-but-still-present cover
      // caught in a later blast doesn't detonate a second time after a save/load.
      this.detonated.clear();
      for (const id of data.detonated ?? []) this.detonated.add(id);
      this.toppled.clear();
      for (const id of data.toppled ?? []) this.toppled.add(id);
      for (const [id, shots] of data.overwatch ?? []) this.overwatching.set(id, shots);
      for (const [id, facing] of data.overwatchFacing ?? []) this.overwatchFacing.set(id, facing);
      this.wrecked.clear();
      for (const id of data.wrecked ?? []) this.wrecked.add(id);
      this.salvage.clear();
      for (const [id, amount] of data.salvage ?? []) this.salvage.set(id, amount);
      this.burnZones.splice(0, this.burnZones.length, ...(data.burnZones ?? []));
      this.gasClouds.splice(0, this.gasClouds.length, ...(data.gasClouds ?? []));
      this.smokeClouds.splice(0, this.smokeClouds.length, ...(data.smokeClouds ?? []));
      this.revealedOrders = data.revealedOrders === true;
      this.revealedTeam = data.revealedTeam === "enemy" ? "enemy" : "player";
      this.hotseat = data.hotseat === true;
      this.sidesSwapped = false;
      this.enemyIntentCache = undefined;
      this.mines.splice(0, this.mines.length, ...(data.mines ?? []));
      this.pickups.splice(0, this.pickups.length, ...(data.pickups ?? []));
      this.log.splice(0);
      this.turnReports.splice(0);
      this.activeTurnReport = undefined;
      this.phase = "command";
      this.intent = "select";
      this.aim = "center";
      this.pendingBuild = undefined;
      this.pendingDeploy = undefined;
      this.pendingSupport = undefined;
      // A support call is paid for (money, command point, cooldown) when it is queued; dropping it
      // on a save/load would take all three and deliver nothing.
      this.queuedSupport = (data.queuedSupport ?? []).map((c) => ({ kind: c.kind, point: { ...c.point }, dir: { ...c.dir } }));
      this.pendingFx = [];
      this.resolveClock = 0;
      this.selectedId = this.entities.find((e) => e.team === "player" && isBuildingKind(e.kind))?.id ?? this.entities[0]?.id ?? "";
      this.syncAllElevations();
      this.refreshDefendingStances();
      this.forcedSandstorm = false;
      this.forcedIonStorm = false;
      this.forcedZones = [];
      this.pendingStrikes = [];
      this.refreshEventNotice();
      this.pushLog(`Battle restored — Turn ${this.turn}`);
      this.seatLogMark = this.logSeq;
      return true;
    } catch {
      return false;
    }
  }

  update(dt: number): void {
    this.syncAllElevations();
    for (const effect of this.effects) effect.age += dt;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].age >= this.effects[i].duration) this.effects.splice(i, 1);
    }

    this.refreshDefendingStances();
    if (this.phase !== "resolve") return;
    this.resolveClock += dt;
    for (let index = 0; index < this.orders.length; index += 1) {
      const order = this.orders[index];
      if (!order.done) this.updateOrder(order, dt);
    }
    this.updateProjectiles(dt);
    this.updateMapStrikes(dt);
    this.syncCarriedPassengers();

    const allDone = this.orders.every((o) => o.done);
    if (allDone && this.projectiles.length === 0 && this.pendingStrikes.length === 0 && this.pendingFx.length === 0 && this.resolveClock > 1.9) this.finishResolve();
    if (this.projectiles.length === 0 && this.pendingStrikes.length === 0 && this.resolveClock > RESOLVE_SETTLE_TIMEOUT) this.finishResolve();
    // HARD CEILING — resolve must always terminate. The settle timeout above is gated on nothing
    // being airborne, which a slow shot fired late in a long resolve can block indefinitely
    // (artillery: speed 2.45 over range 42 = 17s of flight, longer than the timeout itself). That
    // hung the phase forever. Force-expire anything still in the air through the normal miss path
    // and end the turn; a resolve is never allowed to outlive this budget.
    if (this.phase === "resolve" && this.resolveClock > RESOLVE_HARD_CEILING) {
      for (const projectile of [...this.projectiles]) this.expireProjectile(projectile);
      this.pendingStrikes.splice(0);
      this.pendingFx.splice(0);
      this.finishResolve();
    }
  }

  private queueShootFor(actor: CombatEntity, target: CombatEntity, aim: AimMode, partId?: string): boolean {
    if (!actor.status.canShoot) return this.reject(`${actor.name} cannot shoot`);
    if (actor.kind === "artillery" && !actor.deployed) return this.reject(`${actor.name} must deploy before it can fire`);
    if (target.downed) return this.reject(`${target.name} is down — out of the fight unless a medic reaches them`);
    if (this.isPowerCut(actor)) return this.reject(`${actor.name} has no power — the conduit is cut`);
    // Plane guns are air-to-air: a gunship's autocannon only engages other flyers (it drops bombs
    // on the ground instead). Ground units CAN shoot up at flyers — that is the anti-air.
    if (isAirKind(actor.kind) && !target.flying) return this.reject(`${actor.name}'s autocannon only engages aircraft — drop bombs on ground targets`);
    const requestedPart = partId ? this.targetableParts(target).find((part) => part.id === partId) : undefined;
    if (partId && !requestedPart) return this.reject(`${target.name} does not have that targetable part`);
    const targetPart = requestedPart ?? preferredPart(target, aim);
    if (this.previewAttack(actor.id, target.id, targetPart.id, "weapon")?.blockedBySmoke) return this.reject(`${target.name} is hidden by smoke`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({
      actorId: actor.id,
      kind: "shoot",
      targetId: target.id,
      targetPartId: targetPart.id,
      aim,
      duration: 1.35,
    });
    return true;
  }

  // ---- Overwatch / reaction fire ----

  /** Watch radius: slightly inside weapon range so the reaction shot can actually connect. */
  overwatchRadius(actor: CombatEntity): number {
    return projectileRange(actor) * 0.9;
  }

  overwatchFailureReason(actor: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (!actor.status.canShoot) return `${actor.name} cannot shoot`;
    if (this.isPowerCut(actor)) return `${actor.name} has no power — the conduit is cut`;
    if (this.overwatching.has(actor.id)) return `${actor.name} is already on overwatch`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    if (isBuildingKind(actor.kind)) return "The base cannot overwatch";
    return undefined;
  }

  /** Player API: put the selected unit on overwatch (1 CP, 1 reaction shot this resolve),
   *  watching in the direction it currently faces. */
  queueOverwatch(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    return this.armOverwatch(actor, actor.yaw);
  }

  /** Overwatch aimed at a chosen ground point: the unit turns to face it and watches that lane. */
  queueOverwatchToward(point: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const facing = Math.atan2(point.x - actor.position.x, point.z - actor.position.z);
    return this.armOverwatch(actor, facing);
  }

  private armOverwatch(actor: CombatEntity, facing: number): boolean {
    const failure = this.overwatchFailureReason(actor);
    if (failure) return this.reject(failure);
    spendCommandPoint(actor);
    actor.yaw = facing; // the unit visibly turns to watch its chosen lane
    this.overwatching.set(actor.id, 1);
    this.overwatchFacing.set(actor.id, facing);
    this.pushLog(`${actor.name} sets overwatch — the first hostile to move into its watch arc eats a reaction shot`);
    this.bus.emit("ORDER_QUEUED", { actorId: actor.id, kind: "shoot" });
    return true;
  }

  // Called while any unit is moving during resolve: opposing watchers inside radius take
  // their reaction shot (single round, widened spread — snap fire, not an aimed shot).
  private checkOverwatch(mover: CombatEntity): void {
    if (this.overwatching.size === 0 || !mover.status.alive || mover.kind === "cover" || mover.team === "neutral") return;
    for (const [watcherId, shots] of this.overwatching) {
      if (shots <= 0) {
        this.overwatching.delete(watcherId);
        continue;
      }
      const watcher = this.entity(watcherId);
      if (!watcher || !watcher.status.alive || !watcher.status.canShoot || this.isPowerCut(watcher)) {
        this.overwatching.delete(watcherId);
        continue;
      }
      if (watcher.team === mover.team) continue;
      // DASH: a scout is too fast to track — overwatch never triggers on it.
      if (mover.kind === "scout") continue;
      // An aircraft's autocannon is air-to-air ONLY — its overwatch guards the air lane and never
      // snaps at ground units (closes the loophole where a plane could gun the ground via overwatch).
      if (isAirKind(watcher.kind) && !mover.flying) continue;
      if (dist(watcher.position, mover.position) > this.overwatchRadius(watcher)) continue;
      // Directional overwatch: only fire if the mover is inside the watched arc (older saves
      // with no stored facing fall back to a full 360° watch).
      const facing = this.overwatchFacing.get(watcherId);
      if (facing !== undefined) {
        const bearing = Math.atan2(mover.position.x - watcher.position.x, mover.position.z - watcher.position.z);
        const delta = Math.abs(Math.atan2(Math.sin(bearing - facing), Math.cos(bearing - facing)));
        if (delta > OVERWATCH_ARC_HALF) continue;
      }
      this.overwatching.set(watcherId, shots - 1);
      if ((this.overwatching.get(watcherId) ?? 0) <= 0) this.overwatching.delete(watcherId);
      const part = preferredPart(mover, "center");
      const reaction: TacticalOrder = {
        id: `order-${++this.orderSeq}`,
        actorId: watcher.id,
        kind: "shoot",
        targetId: mover.id,
        targetPartId: part.id,
        aim: "center",
        elapsed: 0,
        duration: 0,
        fired: true,
        done: true,
      };
      watcher.yaw = Math.atan2(mover.position.x - watcher.position.x, mover.position.z - watcher.position.z);
      this.spawnShotProjectile(reaction, watcher, mover, OVERWATCH_SPREAD_PENALTY, false);
      this.pushLog(`${watcher.name} reaction fire — ${mover.name} moved into the kill zone`);
      this.effect("ping", { ...watcher.position }, { ...mover.position }, 0xffd166, 0.5, watcher.radius + 0.5);
    }
  }

  private queueGrenadeFor(actor: CombatEntity, target: CombatEntity, aim: AimMode, partId?: string): boolean {
    const failure = this.grenadeFailureReason(actor, target);
    if (failure) return this.reject(failure);
    const requestedPart = partId ? this.targetableParts(target).find((part) => part.id === partId) : undefined;
    if (partId && !requestedPart) return this.reject(`${target.name} does not have that targetable part`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    actor.grenades = Math.max(0, actor.grenades - 1);
    const targetPart = requestedPart ?? preferredPart(target, aim);
    this.addOrder({
      actorId: actor.id,
      kind: "grenade",
      targetId: target.id,
      targetPartId: targetPart.id,
      aim,
      duration: 1.15,
    });
    return true;
  }

  private addOrder(input: Omit<TacticalOrder, "id" | "elapsed" | "fired" | "done">): void {
    const order: TacticalOrder = {
      ...input,
      id: `order-${++this.orderSeq}`,
      elapsed: 0,
      fired: false,
      done: false,
    };
    this.orders.push(order);
    if (this.previewingEnemy) return;
    this.pushLog(`${this.entity(order.actorId)?.name ?? "Unit"} queued ${order.kind}`);
    this.bus.emit("ORDER_QUEUED", { actorId: order.actorId, kind: order.kind });
  }

  private updateOrder(order: TacticalOrder, dt: number): void {
    if (this.hasActivePriorOrder(order)) return;
    const actor = this.entity(order.actorId);
    if (!actor || !actor.status.alive) {
      order.done = true;
      return;
    }
    order.elapsed += dt;

    if (order.kind === "defend") {
      actor.stance = order.stance ?? "crouched";
      this.defending.add(actor.id);
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "deploy") {
      if (!order.fired && order.elapsed >= 0.7) {
        order.fired = true;
        if (!actor.deployed) {
          actor.deployed = true;
          this.pushLog(`${actor.name} is deployed — outriggers down, gun ready`);
        }
      }
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "recon") {
      if (!order.fired && order.elapsed >= 0.6) {
        order.fired = true;
        this.revealedOrders = true;
        this.revealedTeam = actor.team;
        this.enemyIntentCache = undefined;
        this.pushLog(`${actor.name}'s drone maps the enemy's plans — their next orders are revealed`);
        this.effect("ping", actor.position, actor.position, 0x8de4ff, 0.9, 6);
      }
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "move") {
      if (!order.destination || !actor.status.canMove) {
        order.done = true;
        return;
      }
      if (!order.start) {
        order.start = { ...actor.position };
        order.startedCrouched = actor.stance === "crouched";
        actor.stance = "standing";
        this.defending.delete(actor.id);
      }
      const crouchMoveSlow = order.startedCrouched ? 0.66 : 1;
      if (canJump(actor)) {
        // THE JUMP. Airborne for the whole leap (so it is a flyer to targeting and mines), on a
        // sine arc whose height scales with the distance, and back on the ground the moment it
        // lands. The order's own progress drives the arc, so it can never desync from the move.
        const total = Math.max(0.01, dist(order.start, order.destination));
        actor.position = moveToward(actor.position, order.destination, moveSpeed(actor) * 1.15 * dt);
        const progress = clamp(1 - dist(actor.position, order.destination) / total, 0, 1);
        const landed = dist(actor.position, order.destination) < 0.08;
        actor.flying = !landed;
        actor.agl = landed ? undefined : Math.sin(progress * Math.PI) * Math.min(4.2, 1.2 + total * 0.28);
        this.syncEntityElevation(actor);
        actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
        if (landed) {
          this.separateFromUnits(actor, order.destination);
          this.syncEntityElevation(actor);
          this.effect("land", actor.position, actor.position, 0xbfe9ff, 0.5, actor.radius * 1.3);
          // SLAM LANDING: anyone hostile within a stride of the touchdown is knocked back and hurt.
          for (const other of this.entities) {
            if (other.team === actor.team || other.team === "neutral" || !other.status.alive || other.flying || other.kind === "cover" || isBuildingKind(other.kind) || isDefenseKind(other.kind)) continue;
            if (dist(other.position, actor.position) > actor.radius + other.radius + 0.6) continue;
            const result = applyDamage(other, preferredPart(other, "center").id, Math.round(SLAM_LANDING_DAMAGE * this.teamDamageScale(actor)));
            this.pushLog(`${actor.name} slams down on ${other.name}`);
            this.effect("strike", actor.position, other.position, 0xbfe9ff, 0.45, other.radius + 0.6);
            this.afterDamage(actor, other, result, "Slam");
            this.applyKnockback(actor, other, actor.position, 30, 0.9);
          }
          this.checkMines(actor);
          this.checkPickups(actor);
          order.done = true;
        } else if (order.elapsed >= order.duration + 0.5) {
          actor.flying = false;
          actor.agl = undefined;
          this.syncEntityElevation(actor);
          order.done = true;
        }
        return;
      }
      actor.position = moveToward(actor.position, order.destination, moveSpeed(actor) * crouchMoveSlow * dt);
      this.separateFromUnits(actor, order.destination);
      this.syncEntityElevation(actor);
      actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
      this.checkOverwatch(actor);
      this.checkMines(actor);
      this.checkPickups(actor);
      if (actor.kind === "gunship") this.strafeAlongPath(order, actor);
      if (dist(actor.position, order.destination) < 0.08 || order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "shoot" || order.kind === "grenade" || order.kind === "smoke") {
      // Ground-targeted explosives (hand grenade, tank/artillery/turret shell, mortar smoke) carry a
      // destination but no specific entity; they fly to the marked spot and detonate.
      if (order.destination && !order.targetId) {
        if (order.fired) {
          order.done = !this.projectiles.some((projectile) => projectile.orderId === order.id);
          return;
        }
        if (!actor.status.alive || (order.kind !== "grenade" && !actor.status.canShoot)) {
          order.done = true;
          return;
        }
        // A straight-down bomb drop keeps the aircraft's heading (the carpet is laid along it).
        if (dist(order.destination, actor.position) > 0.05) actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
        if (order.elapsed >= 0.58) {
          order.fired = true;
          if (order.kind === "grenade" && actor.kind === "bomber") {
            // CARPET: a bomber lays its load in a line along its heading — one bomb short of the
            // aircraft, one beneath it, one past it — instead of a single drop.
            const heading = { x: Math.sin(actor.yaw), z: Math.cos(actor.yaw) };
            for (let i = 0; i < CARPET_BOMBS; i += 1) {
              const along = (i - (CARPET_BOMBS - 1) / 2) * CARPET_SPACING;
              const point = clampToArena({ x: actor.position.x + heading.x * along, z: actor.position.z + heading.z * along });
              order.projectileId = this.launchGrenadeAtPoint(order, actor, point, point);
            }
            this.pushLog(`${actor.name} carpets the line beneath it with ${CARPET_BOMBS} bombs`);
          } else {
            order.projectileId = order.kind === "grenade"
              ? this.launchGrenadeAtPoint(order, actor, order.destination)
              : this.launchExplosiveAtPoint(order, actor, order.destination, order.kind === "smoke");
          }
        }
        return;
      }
      const target = this.entity(order.targetId);
      if (order.fired) {
        order.done = !this.projectiles.some((projectile) => projectile.orderId === order.id);
        return;
      }
      if (!target || !target.status.alive || (order.kind === "shoot" && !actor.status.canShoot)) {
        order.done = true;
        return;
      }
      const targetPart = order.targetPartId
        ? preferredPartByIdOrAim(target, order.targetPartId, order.aim)
        : preferredPart(target, order.aim);
      const aimPoint = aimPointFor(target, targetPart);
      actor.yaw = Math.atan2(aimPoint.x - actor.position.x, aimPoint.z - actor.position.z);
      if (order.elapsed >= 0.58) {
        order.fired = true;
        order.projectileId = this.launchProjectile(order, actor, target);
      }
      return;
    }

    // Airlift: fly to a friendly ground unit and take it aboard.
    if (order.kind === "load") {
      const passenger = this.entity(order.targetId);
      if (!passenger || !passenger.status.alive || passenger.carriedById || !actor.status.canMove || (actor.passengerIds?.length ?? 0) >= TRANSPORT_CAPACITY) {
        order.done = true;
        return;
      }
      actor.yaw = Math.atan2(passenger.position.x - actor.position.x, passenger.position.z - actor.position.z);
      if (dist(actor.position, passenger.position) <= actor.radius + passenger.radius + 0.7) {
        (actor.passengerIds ??= []).push(passenger.id);
        passenger.carriedById = actor.id;
        passenger.position = { ...actor.position };
        this.syncEntityElevation(passenger);
        this.pushLog(actor.kind === "apc" ? `${passenger.name} boards ${actor.name}` : `${actor.name} airlifts ${passenger.name} aboard`);
        order.done = true;
        return;
      }
      actor.position = moveToward(actor.position, passenger.position, moveSpeed(actor) * dt);
      this.syncEntityElevation(actor);
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    // Airlift: fly to a spot and set the passengers down.
    if (order.kind === "unload") {
      if (!order.destination || !actor.status.canMove || !(actor.passengerIds?.length)) {
        order.done = true;
        return;
      }
      actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
      // An APC does not drive to the point: the ramp drops where it stands, beside the hull.
      if (actor.kind === "apc" || dist(actor.position, order.destination) <= actor.radius + 0.5 || order.elapsed >= order.duration) {
        this.dropPassengers(actor);
        order.done = true;
        return;
      }
      actor.position = moveToward(actor.position, order.destination, moveSpeed(actor) * dt);
      this.syncEntityElevation(actor);
      return;
    }

    const target = this.entity(order.targetId);
    if (!target || !target.status.alive || !actor.status.canMove) {
      order.done = true;
      return;
    }

    if (order.kind === "melee") {
      actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
      // CHARGE: a striker closes the gap first (a real move — overwatch and mines apply) and the
      // swing clock only starts once the blade is in reach.
      const swingReach = unitStats(actor.kind).meleeRange + actor.radius + target.radius;
      if (!order.fired && dist(actor.position, target.position) > swingReach + 0.05) {
        const gap = dist(actor.position, target.position) - swingReach;
        actor.position = moveToward(actor.position, target.position, Math.min(gap, moveSpeed(actor) * 1.6 * dt));
        this.separateFromUnits(actor);
        this.syncEntityElevation(actor);
        this.checkOverwatch(actor);
        this.checkMines(actor);
        order.elapsed = 0;
        return;
      }
      if (!order.fired && order.elapsed >= 0.36) {
        order.fired = true;
        this.resolveMelee(actor, target, order.targetPartId);
      }
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
    actor.position = moveToward(actor.position, target.position, moveSpeed(actor) * 1.25 * dt);
    this.syncEntityElevation(actor);
    this.checkOverwatch(actor);
    this.checkMines(actor);
    this.checkPickups(actor);
    if (!order.fired && dist(actor.position, target.position) <= actor.radius + target.radius + 0.25) {
      order.fired = true;
      this.resolveRam(actor, target);
    }
    if (order.elapsed >= order.duration) order.done = true;
  }

  // STRAFE. A gunship on the move guns everything hostile it passes: one burst per unit within
  // STRAFE_RADIUS of its path, resolved as direct damage the moment it comes into reach (the
  // autocannon's air-to-air rule is for aimed fire; a gun run is the exception).
  private strafeAlongPath(order: TacticalOrder, actor: CombatEntity): void {
    if (!actor.status.canShoot) return;
    const strafed = (order.strafed ??= []);
    for (const target of this.entities) {
      if (target.team === actor.team || target.team === "neutral" || !target.status.alive || target.downed || target.carriedById) continue;
      if (target.kind === "cover" || isBuildingKind(target.kind) || strafed.includes(target.id)) continue;
      if (dist(target.position, actor.position) > STRAFE_RADIUS + target.radius) continue;
      strafed.push(target.id);
      const part = preferredPart(target, "center");
      const amount = Math.max(1, Math.round(this.estimateShotDamage(actor, target, part, "center", false) * STRAFE_DAMAGE_SHARE));
      const result = applyDamage(target, part.id, amount);
      this.pushLog(`${actor.name} strafes ${target.name}`);
      this.effect("shot", actor.position, target.position, actor.team === "player" ? 0x75d8ff : 0xff765f, 0.3);
      this.effect("impact", target.position, target.position, result.destroyed ? 0xffd166 : 0xffffff, 0.42, target.radius);
      this.afterDamage(actor, target, result, "Strafe");
    }
  }

  private hasActivePriorOrder(order: TacticalOrder): boolean {
    const index = this.orders.indexOf(order);
    if (index <= 0) return false;
    return this.orders.slice(0, index).some((candidate) => candidate.actorId === order.actorId && !candidate.done);
  }

  private projectedActorForPreview(actor: CombatEntity): CombatEntity {
    const projected: CombatEntity = {
      ...actor,
      position: { ...actor.position },
      status: { ...actor.status },
      stance: actor.stance,
      parts: actor.parts,
    };
    for (const order of this.orders) {
      if (order.actorId !== actor.id || order.done) continue;
      if (order.kind === "move" && order.destination) {
        projected.position = { ...order.destination };
        projected.stance = "standing";
        projected.elevation = this.elevationForEntityAt(projected, projected.position);
      } else if (order.kind === "defend") {
        projected.stance = order.stance ?? "crouched";
      } else if (order.kind === "ram") {
        const target = this.entity(order.targetId);
        if (target) projected.position = moveToward(projected.position, target.position, Math.max(0, dist(projected.position, target.position) - actor.radius - target.radius - 0.25));
        projected.stance = "standing";
        projected.elevation = this.elevationForEntityAt(projected, projected.position);
      } else if (order.kind === "melee") {
        projected.stance = "standing";
        projected.elevation = this.elevationForEntityAt(projected, projected.position);
      }
    }
    return projected;
  }

  private coverDestination(actor: CombatEntity, cover: CombatEntity): Vec2 {
    const projected = this.projectedActorForPreview(actor);
    const away = normalize({
      x: projected.position.x - cover.position.x,
      z: projected.position.z - cover.position.z,
    });
    const direction = Math.abs(away.x) + Math.abs(away.z) > 0.001 ? away : { x: actor.team === "player" ? -1 : 1, z: 0 };
    return clampToArena({
      x: cover.position.x + direction.x * (cover.radius + actor.radius + 0.14),
      z: cover.position.z + direction.z * (cover.radius + actor.radius + 0.14),
    });
  }

  private ramFailureReason(actor: CombatEntity | undefined, target: CombatEntity | undefined): string | undefined {
    if (!actor || !target || actor.id === target.id) return "Select a tank and target first";
    if (target.team === "player") return "Cannot ram friendly units";
    if (actor.kind !== "tank") return "Only tanks can ram";
    if (!actor.status.canMove) return `${actor.name} cannot ram without mobility`;
    const projected = this.projectedActorForPreview(actor);
    const reach = ramRange(actor) + actor.radius + target.radius;
    if (dist(projected.position, target.position) > reach) return `${target.name} is too far to ram`;
    return undefined;
  }

  private meleeFailureReason(actor: CombatEntity | undefined, target: CombatEntity | undefined): string | undefined {
    if (!actor || !target || actor.id === target.id) return "Select a unit and target first";
    if (target.team === "player") return "Cannot strike friendly units";
    if (!isInfantryKind(actor.kind)) return "Only infantry can strike in melee";
    if (!actor.status.canMove) return `${actor.name} cannot strike without mobility`;
    if (!hasIntactMeleeWeapon(actor)) return `${actor.name} has no weapon to strike with`;
    const projected = this.projectedActorForPreview(actor);
    const reach = meleeRange(actor) + actor.radius + target.radius;
    if (dist(projected.position, target.position) > reach) return `${target.name} is too far to strike`;
    return undefined;
  }

  private grenadeFailureReason(actor: CombatEntity | undefined, target: CombatEntity | undefined): string | undefined {
    if (!actor || !target || actor.id === target.id) return "Select a unit and target first";
    if (actor.team === target.team) return "Cannot throw grenades at friendly units";
    if (actor.kind !== "soldier" && actor.kind !== "gunship" && actor.kind !== "bomber") return "This unit carries no bombs/grenades";
    if (target.flying) return "Bombs can't hit aircraft — use guns on flyers";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (actor.grenades <= 0) return `${actor.name} is out of grenades`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    const projected = this.projectedActorForPreview(actor);
    const targetPart = preferredPart(target, target.kind === "cover" ? "center" : "core");
    const origin = muzzlePoint(projected, "grenade");
    const aimPoint = aimPointFor(target, targetPart);
    if (dist(origin, aimPoint) > grenadeThrowRange(actor) + target.radius * 0.45) return `${target.name} is outside grenade range`;
    return undefined;
  }

  private grenadeLocationFailureReason(actor: CombatEntity | undefined, point: Vec2): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "soldier" && actor.kind !== "gunship" && actor.kind !== "bomber") return "This unit carries no bombs/grenades";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (actor.grenades <= 0) return `${actor.name} is out of grenades`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    const projected = this.projectedActorForPreview(actor);
    const origin = muzzlePoint(projected, "grenade");
    if (dist(origin, point) > grenadeThrowRange(actor)) return "Ground target is outside grenade range";
    return undefined;
  }

  private blockedMoveDestination(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId?: string, silent = false): Vec2 {
    const stop = this.blockedMoveStop(actor, start, destination, allowedCoverId, silent);
    return actor.flying || canJump(actor) ? stop : settleClearOfRises(start, stop, spawnClearance(actor.radius));
  }

  private blockedMoveStop(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId?: string, silent = false): Vec2 {
    const pathLength = dist(start, destination);
    if (pathLength < 0.05) return destination;
    // A JUMP arcs over everything on the way. Only the landing matters: dry ground, not inside a
    // prop or a structure. Anything else in range is a legal target -- that is the whole unit.
    if (canJump(actor)) return this.jumpLanding(actor, nearestDryPoint(clampToArena(destination)));
    // Terrain (steep step / water) stop — computed silently; we log only if it's the winning stop.
    const terrainStop = this.blockedBySteepTerrain(actor, start, destination, allowedCoverId, pathLength, true);
    if (actor.flying) return destination; // flyers overfly all ground cover/structures
    // Solid objects that block ground movement: cover (except walkable ridges) and any Home Base or
    // defense. Ridges are high ground you can stand on; the cover being taken is exempt.
    const blockers = this.entities
      .filter((entity) =>
        entity.status.alive &&
        entity.id !== actor.id &&
        entity.id !== allowedCoverId &&
        ((entity.kind === "cover" && entity.coverKind !== "ridge") || entity.kind === "base" || isDefenseKind(entity.kind)))
      .map((entity) => ({
        entity,
        progress: segmentProgress(entity.position, start, destination),
        distance: pointToSegmentDistance(entity.position, start, destination),
      }))
      .filter((hit) => hit.progress > 0.02 && hit.progress <= 1 && hit.distance <= hit.entity.radius + actor.radius * 0.9)
      .sort((a, b) => a.progress - b.progress);
    const blocker = blockers[0];
    let coverStop: Vec2 | undefined;
    if (blocker) {
      const stopBack = (blocker.entity.radius + actor.radius + 0.28) / pathLength;
      const t = clamp(blocker.progress - stopBack, 0, 1);
      coverStop = clampToArena({ x: start.x + (destination.x - start.x) * t, z: start.z + (destination.z - start.z) * t });
    }
    if (!terrainStop && !coverStop) return destination;
    // BOTH a wall/cover AND a terrain step can lie on the path — stop at whichever comes FIRST (nearer
    // to the start), so a wall on the flat approach isn't skipped by a farther terrain feature.
    if (terrainStop && (!coverStop || dist(start, terrainStop) <= dist(start, coverStop))) {
      if (!silent) this.blockedBySteepTerrain(actor, start, destination, allowedCoverId, pathLength, false); // re-run only to log the reason
      return terrainStop;
    }
    if (!silent) this.pushLog(isCliffCover(blocker!.entity) ? `${actor.name} must use a cliff ascent` : `${actor.name}'s move is blocked by ${blocker!.entity.name}`);
    return coverStop!;
  }

  private jumpLanding(actor: CombatEntity, destination: Vec2): Vec2 {
    const solid = this.entities.filter((e) =>
      e.status.alive && e.id !== actor.id &&
      ((e.kind === "cover" && e.coverKind !== "ridge") || e.kind === "base" || isDefenseKind(e.kind)));
    let landing = { ...destination };
    // Push out of any solid it would land inside, a few times over so a cluster resolves too.
    for (let pass = 0; pass < 4; pass += 1) {
      let moved = false;
      for (const e of solid) {
        const gap = e.radius + actor.radius + 0.2;
        const d = dist(landing, e.position);
        if (d >= gap) continue;
        const away = d > 0.001 ? normalize({ x: landing.x - e.position.x, z: landing.z - e.position.z }) : { x: 1, z: 0 };
        landing = clampToArena({ x: e.position.x + away.x * gap, z: e.position.z + away.z * gap });
        moved = true;
      }
      if (!moved) break;
    }
    return nearestDryPoint(landing);
  }

  private blockedBySteepTerrain(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId: string | undefined, pathLength: number, silent = false): Vec2 | undefined {
    if (actor.flying || canJump(actor)) return undefined; // flyers and jumpers ignore ground terrain entirely — they overfly it
    const allowedCover = this.entity(allowedCoverId);
    if (allowedCover && isCliffCover(allowedCover) && isInfantryKind(actor.kind)) return undefined;
    const samples = Math.max(12, Math.ceil(pathLength * 4));
    // A unit can step up onto a ledge no taller than TERRAIN_STEP, and can always drop down.
    // The first place the terrain rises by more than one step is a wall/cliff face: stop there.
    let footing = terrainHeightAt(start);
    // FOOTPRINT, not a point (2026-09-22 terrain audit). Only the centre line used to be checked and
    // the stop sat 0.34m short of the face whatever the unit's size, so a tank parked with its hull
    // inside a mesa and a trooper's rifle went into the wall beside him. The unit's clearance
    // (weapon reach for infantry, most of the hull for vehicles) is sampled ahead and to both sides.
    const clearance = spawnClearance(actor.radius);
    const dirLen = Math.max(0.0001, dist(start, destination));
    const fwd = { x: (destination.x - start.x) / dirLen, z: (destination.z - start.z) / dirLen };
    const offsets = [0, 0.7, -0.7, 1.4, -1.4].map((a) => ({
      x: (fwd.x * Math.cos(a) - fwd.z * Math.sin(a)) * clearance,
      z: (fwd.x * Math.sin(a) + fwd.z * Math.cos(a)) * clearance,
    }));
    const footprintRise = (point: Vec2, ground: number): boolean =>
      offsets.some((o) => terrainHeightAt({ x: point.x + o.x, z: point.z + o.z }) - ground > TERRAIN_STEP);
    // Already touching a face (spawned there, or thrown there)? Fall back to the centre line so the
    // unit can always walk away from it.
    const useFootprint = !footprintRise(start, footing);
    let lastClear = start;

    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      const point = {
        x: start.x + (destination.x - start.x) * t,
        z: start.z + (destination.z - start.z) * t,
      };
      const height = terrainHeightAt(point);

      // Impassable water (unless a bridge crosses here): stop the unit at the shoreline.
      if (pointInWater(point)) {
        const back = Math.min(0.34 / pathLength, t);
        const stopT = clamp(t - back, 0, 1);
        const stopped = clampToArena({
          x: start.x + (destination.x - start.x) * stopT,
          z: start.z + (destination.z - start.z) * stopT,
        });
        if (!silent) this.pushLog(`${actor.name} can't cross the water — find a bridge`);
        return stopped;
      }

      if (useFootprint && height - footing <= TERRAIN_STEP && footprintRise(point, Math.max(footing, height))) {
        if (!silent) this.pushLog(`${actor.name} must use a cliff ascent`);
        return lastClear;
      }
      if (height - footing > TERRAIN_STEP) {
        const back = Math.min(0.34 / pathLength, t);
        const stopT = clamp(t - back, 0, 1);
        const stopped = clampToArena({
          x: start.x + (destination.x - start.x) * stopT,
          z: start.z + (destination.z - start.z) * stopT,
        });
        if (!silent) this.pushLog(`${actor.name} must use a cliff ascent`);
        return useFootprint ? lastClear : stopped;
      }

      footing = height;
      lastClear = point;
    }

    return undefined;
  }

  // Fire a shot or grenade at a target. Heavy gunners spray a multi-round burst (machine-gun
   // style); everyone else fires a single round.
  private launchProjectile(order: TacticalOrder, actor: CombatEntity, target: CombatEntity): string {
    const count = burstCount(actor);
    let firstId = "";
    for (let i = 0; i < count; i += 1) {
      const id = this.spawnShotProjectile(order, actor, target, count > 1 ? 1 + i * 0.16 : 1, i === 0);
      if (!firstId) firstId = id;
    }
    return firstId;
  }

  private spawnShotProjectile(order: TacticalOrder, actor: CombatEntity, target: CombatEntity, spreadBoost = 1, announce = true): string {
    this.syncEntityElevation(actor);
    this.syncEntityElevation(target);
    const targetPart = order.targetPartId
      ? preferredPartByIdOrAim(target, order.targetPartId, order.aim)
      : preferredPart(target, order.aim);
    const attackMode: AttackMode = order.kind === "grenade" ? "grenade" : "weapon";
    const origin = muzzlePoint(actor, attackMode);
    const originHeight = muzzleHeight(actor, attackMode);
    const intendedPoint = aimPointFor(target, targetPart);
    const intendedHeight = aimHeightFor(target, targetPart);
    const movedBeforeShot = this.actorMovedBeforeOrder(order);
    const accuracy = this.accuracyForShot(actor, target, targetPart, movedBeforeShot, attackMode);
    // SNIPER MARK. Firing at a unit (hit or miss) paints it for every OTHER friendly until next turn.
    if (announce && actor.kind === "sniper" && attackMode === "weapon" && target.team !== actor.team && target.kind !== "cover") {
      if ((target.markedUntilTurn ?? 0) < this.turn + 1) this.pushLog(`${target.name} is marked`);
      target.markedUntilTurn = this.turn + 1;
      target.markedById = actor.id;
    }
    const errorSpread = accuracy.spreadRadians * spreadBoost;
    const baseYaw = Math.atan2(intendedPoint.x - origin.x, intendedPoint.z - origin.z);
    const horizontalDistance = Math.max(0.001, dist(origin, intendedPoint));
    const basePitch = Math.atan2(intendedHeight - originHeight, horizontalDistance);
    const yawError = errorSpread > 0 ? this.rng.range(-errorSpread, errorSpread) : 0;
    const pitchSpread = errorSpread * 0.62;
    const pitchError = pitchSpread > 0 ? this.rng.range(-pitchSpread, pitchSpread) : 0;
    const yaw = baseYaw + yawError;
    // Allow the shot to actually aim at the true elevation of the target. The old ±0.42 rad clamp
    // was flatter than the angle to a target on a mesa/high cover, so the projectile passed under
    // it and whiffed even though previewAttack (which uses the true unclamped line) reported a clean
    // hit. ±1.2 rad covers ground/high-cover; a near-overhead FLYER needs a steeper ±1.5 so the AA
    // round reaches it instead of passing beneath. The small aim scatter (pitchError) is unchanged.
    const pitchLimit = target.flying ? 1.5 : 1.2;
    const pitch = clamp(basePitch + pitchError, -pitchLimit, pitchLimit);
    const direction = normalize({ x: Math.sin(yaw), z: Math.cos(yaw) });
    const maxTravel = Math.max(horizontalDistance + 10, projectileRange(actor, attackMode));
    const kind = projectileKind(actor, attackMode);
    const speed = projectileSpeed(actor, attackMode);
    const projectile: Projectile = {
      id: `projectile-${++this.projectileSeq}`,
      orderId: order.id,
      actorId: actor.id,
      targetId: target.id,
      targetPartId: order.targetPartId,
      aim: order.aim,
      kind,
      sourceKind: actor.kind,
      position: { ...origin },
      previous: { ...origin },
      origin,
      direction,
      verticalSlope: Math.tan(pitch),
      travel: 0,
      maxTravel,
      aimPoint: {
        x: origin.x + direction.x * maxTravel,
        z: origin.z + direction.z * maxTravel,
      },
      intendedPoint,
      height: originHeight,
      previousHeight: originHeight,
      originHeight,
      speed,
      age: 0,
      maxAge: projectileMaxAge(maxTravel, speed),
      color: actor.team === "player" ? 0x75d8ff : 0xff765f,
      accuracy: accuracy.rating,
      spreadRadians: accuracy.spreadRadians,
      yawErrorRadians: yawError,
      pitchErrorRadians: pitchError,
      arcHeight: projectileArcHeight(kind, horizontalDistance, actor.kind),
      arcDistance: horizontalDistance,
      attackMode,
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    this.projectiles.push(projectile);
    // Heavy gunners get a bright muzzle flash on each round so the burst reads as machine-gun fire.
    if (actor.kind === "heavy") this.effect("ping", origin, origin, actor.team === "player" ? 0xeaffff : 0xffd2bd, 0.16, 0.55);
    if (announce) this.pushLog(`${actor.name} ${attackMode === "grenade" ? "throws a grenade at" : "fires at"} ${target.name} (${accuracy.label})`);
    return projectile.id;
  }

  // Lob a unit's explosive round (tank/artillery shell, turret shell) at a ground point.
  private launchExplosiveAtPoint(order: TacticalOrder, actor: CombatEntity, point: Vec2, smoke = false): string {
    this.syncEntityElevation(actor);
    const origin = muzzlePoint(actor, "weapon");
    const originHeight = muzzleHeight(actor, "weapon");
    const intendedPoint = { ...point };
    const intendedHeight = terrainHeightAt(point) + 0.14;
    const baseYaw = Math.atan2(intendedPoint.x - origin.x, intendedPoint.z - origin.z);
    const horizontalDistance = Math.max(0.001, dist(origin, intendedPoint));
    const basePitch = Math.atan2(intendedHeight - originHeight, horizontalDistance);
    const direction = normalize({ x: Math.sin(baseYaw), z: Math.cos(baseYaw) });
    const kind = projectileKind(actor, "weapon");
    const arcHeight = Math.max(projectileArcHeight(kind, horizontalDistance, actor.kind), 0.6);
    const maxTravel = horizontalDistance + 0.2;
    const speed = projectileSpeed(actor, "weapon");
    const projectile: Projectile = {
      id: `projectile-${++this.projectileSeq}`,
      orderId: order.id,
      actorId: actor.id,
      aim: "center",
      kind,
      sourceKind: actor.kind,
      position: { ...origin },
      previous: { ...origin },
      origin,
      direction,
      verticalSlope: Math.tan(clamp(basePitch, -0.42, 0.42)),
      travel: 0,
      maxTravel,
      aimPoint: intendedPoint,
      intendedPoint,
      height: originHeight,
      previousHeight: originHeight,
      originHeight,
      speed,
      age: 0,
      maxAge: projectileMaxAge(maxTravel, speed),
      color: actor.team === "player" ? 0x75d8ff : 0xff765f,
      accuracy: "steady",
      spreadRadians: 0,
      yawErrorRadians: 0,
      pitchErrorRadians: 0,
      arcHeight,
      arcDistance: horizontalDistance,
      attackMode: "weapon",
      groundTarget: true,
      smoke: smoke || undefined,
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    if (smoke) projectile.color = SMOKE_COLOR;
    this.projectiles.push(projectile);
    this.pushLog(smoke ? `${actor.name} fires a smoke round at the marked spot` : `${actor.name} fires at the marked spot`);
    return projectile.id;
  }

  private launchGrenadeAtPoint(order: TacticalOrder, actor: CombatEntity, point: Vec2, airDropAt?: Vec2): string {
    this.syncEntityElevation(actor);
    // A bomber's bomb always drops beneath the aircraft's CURRENT position (so a moving plane still
    // drops straight down), plummets steeply, and doesn't arc up. `airDropAt` lets a carpet run
    // stagger its bombs along the heading.
    const airDrop = isAirBomber(actor);
    const dropPoint = airDrop ? (airDropAt ?? { x: actor.position.x, z: actor.position.z }) : point;
    // A carpet bomb is released where it falls (as the plane passes over), never lobbed forward
    // from the nose — a lobbed one would fly through anything airborne in between.
    const origin = airDrop && airDropAt ? { ...airDropAt } : muzzlePoint(actor, "grenade");
    const originHeight = muzzleHeight(actor, "grenade");
    const intendedPoint = { ...dropPoint };
    const intendedHeight = terrainHeightAt(dropPoint) + 0.14;
    const baseYaw = Math.atan2(intendedPoint.x - origin.x, intendedPoint.z - origin.z);
    const horizontalDistance = Math.max(0.001, dist(origin, intendedPoint));
    const basePitch = Math.atan2(intendedHeight - originHeight, horizontalDistance);
    const direction = normalize({ x: Math.sin(baseYaw), z: Math.cos(baseYaw) });
    const maxTravel = horizontalDistance + 0.18;
    const speed = projectileSpeed(actor, "grenade");
    const projectile: Projectile = {
      id: `projectile-${++this.projectileSeq}`,
      orderId: order.id,
      actorId: actor.id,
      aim: "center",
      kind: "grenade",
      sourceKind: actor.kind,
      position: { ...origin },
      previous: { ...origin },
      origin,
      direction,
      // Bombs plummet steeply (wide down-clamp); a lobbed grenade keeps the shallow ±0.42 arc.
      verticalSlope: Math.tan(clamp(basePitch, airDrop ? -1.5 : -0.42, 0.42)),
      travel: 0,
      maxTravel,
      aimPoint: intendedPoint,
      intendedPoint,
      height: originHeight,
      previousHeight: originHeight,
      originHeight,
      speed,
      age: 0,
      maxAge: projectileMaxAge(maxTravel, speed),
      color: actor.team === "player" ? 0x75d8ff : 0xff765f,
      accuracy: "steady",
      spreadRadians: 0,
      yawErrorRadians: 0,
      pitchErrorRadians: 0,
      arcHeight: airDrop ? 0 : projectileArcHeight("grenade", horizontalDistance),
      arcDistance: horizontalDistance,
      attackMode: "grenade",
      groundTarget: true,
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    this.projectiles.push(projectile);
    this.pushLog(airDrop ? `${actor.name} drops a bomb` : `${actor.name} throws a grenade at the ground`);
    return projectile.id;
  }

  // Retire a shot that never connected, through the one miss path: drop it, complete its order so
  // the actor is not left mid-order forever, and log the miss.
  private expireProjectile(projectile: Projectile): void {
    const actor = this.entity(projectile.actorId);
    const intendedTarget = this.entity(projectile.targetId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
    if (intendedTarget) this.pushLog(`${actor ? actor.name : "Shot"} misses ${intendedTarget.name}`);
  }

  private updateProjectiles(dt: number): void {
    for (const projectile of [...this.projectiles]) this.updateProjectile(projectile, dt);
  }

  private updateProjectile(projectile: Projectile, dt: number): void {
    const actor = this.entity(projectile.actorId);
    const intendedTarget = this.entity(projectile.targetId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
    projectile.age += dt;

    if (!actor) {
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      if (intendedTarget) this.pushLog(`Shot misses ${intendedTarget.name}`);
      return;
    }

    if (projectile.state === "rolling") {
      this.updateRollingProjectile(projectile, actor, intendedTarget, order, dt);
      return;
    }

    if (projectile.age > projectile.maxAge || projectile.travel >= projectile.maxTravel) {
      this.expireProjectile(projectile);
      return;
    }

    projectile.previous = { ...projectile.position };
    projectile.previousHeight = projectile.height;
    const step = Math.min(projectile.speed * dt, projectile.maxTravel - projectile.travel);
    const nextTravel = projectile.travel + step;
    const next = {
      x: projectile.origin.x + projectile.direction.x * nextTravel,
      z: projectile.origin.z + projectile.direction.z * nextTravel,
    };
    const nextHeight = projectileHeightAt(projectile, nextTravel);
    const ground = firstGroundBetweenShot(projectile.position, next, projectile.height, nextHeight);
    const hit = this.firstEntityHitBySegment(projectile, projectile.position, next, projectile.height, nextHeight);
    // SMOKE. A flat round that flies into a smoke cloud is lost in it (arcing rounds pass over).
    const smokeAt = projectile.arcHeight <= 0.5 && !projectile.smoke && this.smokeClouds.length ? this.smokeEntryProgress(projectile.position, next) : undefined;
    if (smokeAt !== undefined && (!ground || smokeAt <= ground.progress) && (!hit || smokeAt <= hit.progress)) {
      projectile.travel += step * smokeAt;
      projectile.position = { x: projectile.position.x + (next.x - projectile.position.x) * smokeAt, z: projectile.position.z + (next.z - projectile.position.z) * smokeAt };
      this.effect("ping", { ...projectile.position }, { ...projectile.position }, SMOKE_COLOR, 0.5, 0.6);
      this.pushLog(`${actor.name}'s shot is lost in the smoke${intendedTarget ? ` short of ${intendedTarget.name}` : ""}`);
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      return;
    }
    if (ground && (!hit || ground.progress <= hit.progress)) {
      projectile.travel += step * ground.progress;
      projectile.position = { ...ground.point };
      projectile.height = ground.height;
      this.groundImpactProjectile(projectile, intendedTarget, ground.point);
      return;
    }
    if (hit) {
      projectile.travel += step * hit.progress;
      projectile.position = { ...hit.point };
      projectile.height = hit.height;
      this.impactProjectile(projectile, hit.entity, hit.part, hit.entity.kind === "cover");
      return;
    }

    if (!projectile.groundTarget) {
      const proximity = this.firstExplosiveProximity(projectile, projectile.position, next, projectile.height, nextHeight);
      if (proximity) {
        projectile.travel += step * proximity.progress;
        projectile.position = { ...proximity.point };
        projectile.height = projectile.height + (nextHeight - projectile.height) * proximity.progress;
        this.proximityDetonateProjectile(projectile, proximity.entity, proximity.point);
        return;
      }
    }

    if (projectile.groundTarget && nextTravel >= projectile.arcDistance) {
      projectile.travel = projectile.arcDistance;
      projectile.position = { ...projectile.intendedPoint };
      projectile.height = terrainHeightAt(projectile.intendedPoint) + 0.14;
      this.detonateGroundTarget(projectile, actor, order);
      return;
    }

    projectile.travel = nextTravel;
    projectile.position = next;
    projectile.height = nextHeight;
  }

  private groundImpactProjectile(projectile: Projectile, intendedTarget: CombatEntity | undefined, point: Vec2): void {
    const actor = this.entity(projectile.actorId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
    if (projectile.groundTarget && actor) {
      this.detonateGroundTarget(projectile, actor, order, point);
      return;
    }

    if (projectile.kind === "grenade" && actor) {
      projectile.state = "rolling";
      projectile.previous = { ...point };
      projectile.previousHeight = terrainHeightAt(point) + 0.13;
      projectile.position = { ...point };
      projectile.height = terrainHeightAt(point) + 0.13;
      projectile.rollElapsed = 0;
      projectile.rollDuration = 0.9;
      projectile.rollSpeed = 2.05;
      projectile.maxAge += 1.15;
      this.pushLog(`${actor.name}'s grenade skips and rolls${intendedTarget ? ` short of ${intendedTarget.name}` : ""}`);
      this.effect("ping", point, point, 0xffd166, 0.5, 0.72);
      return;
    }

    if (actor) this.pushLog(`${actor.name}'s shot hits high ground${intendedTarget ? ` short of ${intendedTarget.name}` : ""}`);
    const explosive = projectile.kind === "shell" || projectile.kind === "grenade";
    this.effect(explosive ? "blast" : "ping", point, point, explosive ? 0xffbf69 : 0xffffff, 0.58, explosive ? 1.3 : 0.5);
    if (actor && explosive) this.applyExplosiveRadius(actor, point, projectile.kind === "grenade" ? 2.3 : 1.85, projectile.kind === "grenade" ? 28 : 22, `${actor.name}'s blast`);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private updateRollingProjectile(projectile: Projectile, actor: CombatEntity, intendedTarget: CombatEntity | undefined, order: TacticalOrder | undefined, dt: number): void {
    projectile.previous = { ...projectile.position };
    projectile.previousHeight = projectile.height;
    projectile.rollElapsed += dt;

    const progress = clamp(projectile.rollElapsed / Math.max(0.001, projectile.rollDuration), 0, 1);
    const speed = projectile.rollSpeed * (1 - progress * 0.72);
    const next = clampToArena({
      x: projectile.position.x + projectile.direction.x * speed * dt,
      z: projectile.position.z + projectile.direction.z * speed * dt,
    });
    const nextHeight = terrainHeightAt(next) + 0.13;
    const hit = this.firstEntityHitBySegment(projectile, projectile.position, next, projectile.height, nextHeight);
    if (hit) {
      projectile.position = { ...hit.point };
      projectile.height = hit.height;
      this.impactProjectile(projectile, hit.entity, hit.part, hit.entity.kind === "cover");
      return;
    }

    const proximity = this.firstExplosiveProximity(projectile, projectile.position, next, projectile.height, nextHeight);
    if (proximity) {
      projectile.position = { ...proximity.point };
      projectile.height = nextHeight;
      this.proximityDetonateProjectile(projectile, proximity.entity, proximity.point);
      return;
    }

    projectile.position = next;
    projectile.height = nextHeight;
    projectile.travel += dist(projectile.previous, next);

    if (projectile.rollElapsed >= projectile.rollDuration) this.detonateRollingGrenade(projectile, actor, intendedTarget, order);
  }

  private detonateRollingGrenade(projectile: Projectile, actor: CombatEntity, intendedTarget: CombatEntity | undefined, order: TacticalOrder | undefined): void {
    const point = { ...projectile.position };
    this.pushLog(`${actor.name}'s grenade rolls and explodes${intendedTarget ? ` near ${intendedTarget.name}` : ""}`);
    this.effect("blast", point, point, 0xffbf69, 0.78, 2.35);
    this.applyExplosiveRadius(actor, point, 2.55, 34, `${actor.name}'s rolling blast`);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private detonateGroundTarget(projectile: Projectile, actor: CombatEntity, order: TacticalOrder | undefined, point = projectile.position): void {
    if (projectile.smoke) {
      this.burstSmokeAt(actor, point);
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      return;
    }
    const blast = explosiveBlast(projectile.kind);
    const word = projectile.kind === "grenade" ? "grenade" : "shell";
    const blastPoint = { ...point };
    this.pushLog(`${actor.name}'s ${word} explodes at the marked spot`);
    this.effect("blast", blastPoint, blastPoint, 0xffbf69, 0.78, blast.radius);
    this.applyExplosiveRadius(actor, blastPoint, blast.radius, blast.damage, `${actor.name}'s ${word} blast`);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private proximityDetonateProjectile(projectile: Projectile, trigger: CombatEntity, point: Vec2): void {
    const actor = this.entity(projectile.actorId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
    if (!actor) {
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      return;
    }
    this.pushLog(`${actor.name}'s ${projectile.kind === "grenade" ? "grenade" : "shell"} bursts near ${trigger.name}`);
    this.effect("blast", point, point, projectile.kind === "grenade" ? 0xffbf69 : 0xffd166, 0.72, projectile.kind === "grenade" ? 2.25 : 1.6);
    this.applyExplosiveRadius(actor, point, projectile.kind === "grenade" ? 2.55 : 1.75, projectile.kind === "grenade" ? 34 : 26, `${trigger.name} is caught in the blast`);
    if (trigger.kind === "cover") this.airburstBehindCover(actor, projectile, trigger);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  // AIRBURST. A grenadier round that bursts on (or fuses beside) a cover piece still comes down on
  // whoever is sheltering right behind it: the intended target takes half of the direct hit the
  // cover just spared it. Cover is half protection against the launcher, not full.
  private airburstBehindCover(actor: CombatEntity, projectile: Projectile, cover: CombatEntity): void {
    if (actor.kind !== "grenadier") return;
    const target = this.entity(projectile.targetId);
    if (!target || target.id === cover.id || !target.status.alive || target.downed || target.flying) return;
    if (dist(target.position, projectile.position) > AIRBURST_REACH + target.radius) return;
    const part = preferredPart(target, "center");
    const direct = this.estimateShotDamage(actor, target, part, "center", false, projectile.attackMode ?? "weapon");
    const burst = applyDamage(target, part.id, Math.max(1, Math.round(direct * AIRBURST_SHARE)));
    if (burst.amount <= 0) return;
    this.pushLog(`${actor.name}'s round airbursts over ${cover.name} — ${target.name} is hit behind it`);
    this.effect("impact", target.position, target.position, 0xffbf69, 0.42, target.radius);
    this.afterDamage(actor, target, burst);
  }

  private impactProjectile(projectile: Projectile, target: CombatEntity, targetPart: DamagePart, cover: boolean): void {
    const actor = this.entity(projectile.actorId);
    const intendedTarget = this.entity(projectile.targetId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
    if (projectile.smoke && actor) {
      this.burstSmokeAt(actor, projectile.position);
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      return;
    }
    if (!actor) {
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      return;
    }

    if (!cover && target.id === intendedTarget?.id && targetPart.role === "head" && target.stance !== "standing") {
      this.pushLog(`${target.name} ${target.stance === "prone" ? "goes prone under" : "ducks under"} ${actor.name}'s head shot`);
      this.effect("ping", target.position, target.position, 0x8de4ff, 0.45, target.radius + 0.45);
      projectile.ignoredEntityIds.push(target.id);
      return;
    }

    const pierce = unitStats(actor.kind).pierce ?? 0;
    const through = projectile.pierced ?? 0;
    const amount = Math.round(this.estimateShotDamage(actor, target, targetPart, cover ? "center" : projectile.aim, cover, projectile.attackMode ?? "weapon") * Math.max(0.2, 1 - pierce * through));
    const result = applyDamage(target, targetPart.id, amount);
    if (cover && intendedTarget) this.pushLog(`${target.name} intercepts shot at ${intendedTarget.name}`);
    if (!cover && intendedTarget && target.id !== intendedTarget.id) this.pushLog(`${target.name} is hit by a stray shot at ${intendedTarget.name}`);
    if (projectile.kind === "shell" || projectile.kind === "grenade") {
      this.effect("impact", target.position, target.position, 0xffffff, 0.42, target.radius + 0.45);
      this.effect("blast", projectile.position, projectile.position, result.destroyed ? 0xffd166 : 0xffbf69, 0.7, target.radius + 1.05);
      this.resolveShellSplash(actor, target, targetPart, amount, projectile.position);
      this.airburstBehindCover(actor, projectile, target);
    } else {
      this.effect("impact", target.position, target.position, result.destroyed ? 0xffd166 : 0xffffff, 0.42, target.radius);
    }
    this.afterDamage(actor, target, result);
    // SUPPRESSION. A machine-gun hit pins the target: one command point next turn, crouched.
    if (!cover && unitStats(actor.kind).suppresses && target.status.alive && isInfantryKind(target.kind) && result.amount > 0) {
      if ((target.suppressedUntilTurn ?? 0) <= this.turn) this.pushLog(`${target.name} is suppressed`);
      target.suppressedUntilTurn = this.turn + 1;
    }
    // A piercing round goes THROUGH a body and keeps flying; only cover stops it. The order stays
    // open until the round expires, so the line it draws is the whole shot.
    if (pierce > 0 && !cover) {
      projectile.pierced = through + 1;
      projectile.ignoredEntityIds.push(target.id);
      if (through === 0 && intendedTarget) this.pushLog(`${actor.name}'s round goes clean through ${target.name}`);
      // Carries on for a few more metres past the body, not to the end of its range: the order is
      // complete at the first hit, and a round that flew 30m past a kill held the resolve open.
      projectile.maxTravel = Math.min(projectile.maxTravel, projectile.travel + PIERCE_CARRY);
      if (order) order.done = true;
      return;
    }
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private removeProjectile(id: string): void {
    const index = this.projectiles.findIndex((projectile) => projectile.id === id);
    if (index < 0) return;
    const projectile = this.projectiles[index];
    // Flamer rounds torch the ground where they end: burning terrain for the next turns.
    if (projectile.sourceKind === "flamer") {
      const point = clampToArena({ ...projectile.position });
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: point.x, z: point.z, radius: BURN_RADIUS, turnsLeft: BURN_TURNS });
      this.effect("blast", point, point, 0xff7a2a, 0.6, BURN_RADIUS);
    }
    this.projectiles.splice(index, 1);
  }

  // Burning ground: at the start of each turn, everything standing in a burn zone takes
  // fire damage (both teams — fire doesn't check dog tags). Crouching doesn't help; move.
  private runBurnTick(): void {
    if (!this.burnZones.length) return;
    for (const zone of this.burnZones) {
      for (const e of this.entities) {
        if (!e.status.alive || e.downed || e.kind === "base" || e.flying) continue; // flyers are above the flames
        if (dist(e.position, zone) > zone.radius + e.radius * 0.5) continue;
        const part = preferredPart(e, "center");
        applyDamage(e, part.id, BURN_DAMAGE);
        this.effect("impact", { ...e.position }, { ...e.position }, 0xff7a2a, 0.5, e.radius + 0.3);
        this.pushLog(`${e.name} is burned by the fire (${BURN_DAMAGE})`);
        if (!e.status.alive) this.checkEndState();
      }
      zone.turnsLeft -= 1;
    }
    this.burnZones.splice(0, this.burnZones.length, ...this.burnZones.filter((zone) => zone.turnsLeft > 0));
  }

  private runGasTick(): void {
    if (!this.gasClouds.length) return;
    for (const cloud of this.gasClouds) {
      cloud.radius = Math.min(cloud.maxRadius, cloud.radius + GAS_SPREAD_PER_TURN);
      for (const e of this.entities) {
        if (!e.status.alive || e.downed || e.kind === "cover" || e.kind === "base" || isDefenseKind(e.kind) || e.flying || isVehicleKind(e.kind)) continue;
        if (dist(e.position, cloud) > cloud.radius + e.radius * 0.5) continue;
        const result = applyDamage(e, preferredPart(e, "head").id, GAS_CHOKE_DAMAGE);
        this.effect("impact", { ...e.position }, { ...e.position }, 0xa6e05a, 0.5, e.radius + 0.3);
        this.pushLog(`${e.name} is choking in the gas (${result.amount})`);
        if (!e.status.alive) this.checkEndState();
      }
    }
    // Burning ground inside a cloud lights it.
    for (const zone of this.burnZones) this.igniteGasAt(zone, zone.radius);
  }

  private igniteGasAt(point: Vec2, sparkRadius: number): void {
    const lit = this.gasClouds.filter((c) => dist(c, point) <= c.radius + sparkRadius * 0.5);
    if (!lit.length) return;
    for (const cloud of lit) {
      const i = this.gasClouds.indexOf(cloud);
      if (i < 0) continue; // already gone (a neighbour's detonation took it)
      this.gasClouds.splice(i, 1);
      this.pushLog("The gas ignites!");
      const actor = this.entities.find((e) => e.kind === "base" && e.team === "neutral") ?? this.entities[0];
      // The whole cloud goes at once: a blast the size of the cloud, and it throws what it does
      // not kill. Effect first so a neighbouring cloud chains off it.
      this.effect("blast", cloud, cloud, 0xd9ff5a, 0.9, cloud.radius + 0.6);
      this.applyExplosiveRadius(actor, cloud, cloud.radius + 0.4, GAS_BLAST_DAMAGE, "caught in the gas explosion");
      this.checkEndState();
    }
  }

  // ---- Sapper mines ----

  mineFailureReason(actor: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "sapper") return "Only sappers carry mines";
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    if (this.money(actor.team) < MINE_COST) return `Not enough money for a mine ($${MINE_COST})`;
    if (this.mines.some((m) => m.team === actor.team && dist(m, actor.position) < 1.2)) return "There is already a mine here";
    return undefined;
  }

  /** Player API: the selected sapper plants a proximity mine at its feet (1 CP + $15). */
  queueMine(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const failure = this.mineFailureReason(actor);
    if (failure) return this.reject(failure);
    spendCommandPoint(actor);
    this.addMoney(actor.team, -MINE_COST);
    this.mines.push({ id: `mine-${++this.effectSeq}`, x: actor.position.x, z: actor.position.z, team: actor.team });
    this.pushLog(`${actor.name} plants a proximity mine`);
    return true;
  }

  // Called while units move during resolve (same hook as overwatch): a hostile stepping
  // on a mine detonates it.
  private checkMines(mover: CombatEntity): void {
    // Flyers overfly ground pressure mines (like pickups/captures — they never touch the ground).
    if (!this.mines.length || !mover.status.alive || mover.kind === "cover" || mover.team === "neutral" || mover.flying) return;
    for (let i = this.mines.length - 1; i >= 0; i -= 1) {
      const mine = this.mines[i];
      if (mine.team === mover.team) continue;
      if (dist(mine, mover.position) > MINE_TRIGGER + mover.radius * 0.5) continue;
      this.mines.splice(i, 1);
      this.effect("blast", { x: mine.x, z: mine.z }, { x: mine.x, z: mine.z }, 0xffb02e, 0.8, MINE_SPLASH);
      this.pushLog(`${mover.name} triggers a mine!`);
      this.applyExplosiveRadius(this.entity(`${mine.team === "player" ? "p" : "e"}-base-1`) ?? mover, { x: mine.x, z: mine.z }, MINE_SPLASH, MINE_DAMAGE, `${mover.name} is caught in the mine blast`);
    }
  }

  // Same move-resolve hook as mines/overwatch: a unit that runs over a cash cache banks it.
  private checkPickups(mover: CombatEntity): void {
    if (!this.pickups.length || !mover.status.alive || mover.kind === "cover" || mover.flying) return;
    if (mover.team !== "player" && mover.team !== "enemy") return;
    for (let i = this.pickups.length - 1; i >= 0; i -= 1) {
      const pickup = this.pickups[i];
      if (dist(pickup, mover.position) > mover.radius + PICKUP_REACH) continue;
      this.pickups.splice(i, 1);
      this.addMoney(mover.team, pickup.amount);
      this.effect("ping", { x: pickup.x, z: pickup.z }, { x: pickup.x, z: pickup.z }, 0xffe08a, 0.95, 1.1);
      this.pushLog(`${mover.name} grabs a $${pickup.amount} field cache`);
    }
  }

  // Scatter a handful of cash caches at battle start — deterministic per map (a self-contained
  // hash, NO this.rng consumption, so event/AI RNG order is untouched). Bigger arenas carry more.
  private placePickups(): void {
    this.pickups.splice(0);
    const b = ARENA_BOUNDS;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const count = Math.max(3, Math.min(8, Math.round((w * d) / 300)));
    let seed = 0x9e37;
    for (const ch of this.mapDef.id) seed = (seed * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    for (let i = 0; i < count; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const fx = (seed >> 8) % 1000 / 1000;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const fz = (seed >> 8) % 1000 / 1000;
      const point = { x: b.minX + w * (0.12 + fx * 0.76), z: b.minZ + d * (0.12 + fz * 0.76) };
      const amount = 45 + (seed % 4) * 15; // 45..90
      if (this.pickupSpotClear(point)) this.pickups.push({ id: `pickup-${i}`, x: point.x, z: point.z, amount });
    }
  }

  // A cache must sit on open ground a unit can actually reach — not inside a base/defense/solid
  // cover, and not adjacent to a base (loot is earned by taking ground, not handed out at spawn).
  private pickupSpotClear(p: Vec2): boolean {
    for (const e of this.entities) {
      if (e.kind === "base" && dist(p, e.position) < 8.5) return false;
      if ((e.kind === "cover" || e.kind === "base" || isDefenseKind(e.kind)) && dist(p, e.position) < e.radius + 1.3) return false;
    }
    return true;
  }

  // Anti-air multiplier vs a flying target: read the shooter's intact weapon part vsAir if it has
  // one (Flak Track 2.4, Gunship autocannon 1.4), else a by-kind default — snipers/heavies/turrets
  // can loose some rounds skyward; everyone else barely scratches a flyer, teaching "bring AA".
  private vsAirMultiplier(actor: CombatEntity): number {
    const weapon = actor.parts.find((p) => p.role === "weapon" && p.hp > 0);
    if (weapon?.vsAir !== undefined) return weapon.vsAir;
    switch (actor.kind) {
      case "sniper": return 0.6;
      case "heavy": return 0.5;
      case "turret": return 0.45;
      case "exturret": return 0.3;
      default: return 0.14;
    }
  }

  // Flanking: a shot from OUTSIDE the target's facing wedge (reusing the overwatch cone as "front")
  // catches an exposed side/rear. Returns 0 (dead ahead) .. 1 (directly behind). Only mobile units
  // that actually turn to face a threat can be flanked — cover, the base, and static defenses can't.
  private flankFactor(actor: CombatEntity, target: CombatEntity): number {
    return this.flankFactorAt(actor.position, target);
  }

  // Flank strength a shooter WOULD have standing at `pos` — lets the AI mover reward tiles that
  // wrap into a target's exposed rear, not just the tile a stationary shooter already occupies.
  private flankFactorAt(pos: Vec2, target: CombatEntity): number {
    if (target.kind === "cover" || target.kind === "base" || isDefenseKind(target.kind)) return 0;
    const bearing = Math.atan2(pos.x - target.position.x, pos.z - target.position.z);
    const delta = Math.abs(Math.atan2(Math.sin(bearing - target.yaw), Math.cos(bearing - target.yaw)));
    if (delta <= OVERWATCH_ARC_HALF) return 0; // inside the front 120° cone — facing the shooter
    return clamp((delta - OVERWATCH_ARC_HALF) / (Math.PI - OVERWATCH_ARC_HALF), 0, 1);
  }

  private estimateShotDamage(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, aim: AimMode, cover: boolean, attackMode: AttackMode = "weapon"): number {
    let base = baseShotDamage(actor.kind, attackMode);
    // Sapper demolition rounds: purpose-built to breach — 3x vs cover and walls
    // (pairs with toppling: fell a pillar onto whoever hides behind it).
    // BREACH: a demolition round takes a wall or cover piece down in ONE shot, whatever its HP.
    if (actor.kind === "sapper" && (target.kind === "cover" || target.kind === "wall")) base = Math.max(base * 3, 9999);
    const range = dist(actor.position, target.position);
    const falloff = clamp(1.08 - range / 26, 0.65, 1);
    if (target.kind === "tank" && target.hullDown) base *= HULL_DOWN_DAMAGE;
    const vulnerability = cover ? 1 : vulnerabilityMultiplier(target, targetPart);
    const explosiveActor = actor.kind === "tank" || actor.kind === "artillery" || actor.kind === "grenadier" || actor.kind === "mortar" || actor.kind === "exturret";
    const shellObjectBoost = ((attackMode === "weapon" && explosiveActor) || attackMode === "grenade") && target.kind === "cover" ? 1.72 : 1;
    const aimMultiplier = attackMode === "grenade" ? 1 : aimDamageMultiplier(aim);
    // Flanking: a direct shot into an exposed side/rear hits harder (area grenades don't flank).
    const flank = attackMode === "weapon" ? 1 + this.flankFactor(actor, target) * 0.28 : 1;
    // Anti-air: a shot at a FLYING target is scaled by the shooter's vsAir — dedicated AA shreds it,
    // most ground units barely scratch it. This single number IS the AA read on the shot preview.
    const vsAir = target.flying ? this.vsAirMultiplier(actor) : 1;
    return Math.round(base * falloff * (cover ? 1.05 : aimMultiplier) * vulnerability * shellObjectBoost * flank * vsAir * this.supportDamageMultiplier(actor) * this.teamDamageScale(actor) * this.techDamageScale(actor, target));
  }

  // Difficulty scaling: enemy units hit harder on higher difficulties.
  private teamDamageScale(actor: CombatEntity): number {
    return actor.team === "enemy" ? DIFFICULTY_MODS[this.difficulty].enemyDamage : 1;
  }

  // Specialization scaling: Breaching Rounds boosts infantry damage, Hunter Rounds boosts
  // damage dealt to vehicles. Reads the firing team's researched doctrine specializations.
  private techDamageScale(actor: CombatEntity, target: CombatEntity): number {
    const eff = this.teamTech(actor.team);
    let scale = 1;
    if (isInfantryKind(actor.kind)) scale *= eff.infantryDamage;
    if (isVehicleKind(target.kind)) scale *= eff.vsVehicleDamage;
    return scale;
  }

  // Aggregate combat modifiers from a team's Home Base specializations (1×/+0 if none).
  private teamTech(team: Team): Required<TechEffect> {
    const base = this.entities.find((e) => e.team === team && e.kind === "base");
    return aggregateTechEffect(base?.unlockedTech ?? [], this.factionOf(team).passive);
  }

  private supportDamageMultiplier(actor: CombatEntity): number {
    const support = this.entities.find((entity) =>
      entity.id !== actor.id &&
      entity.team === actor.team &&
      entity.status.alive &&
      dist(entity.position, actor.position) <= 4.5 &&
      entity.parts.some((part) => part.hp > 0 && part.tags?.includes("support-aura"))
    );
    return support ? 1.16 : 1;
  }

  private resolveShellSplash(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, amount: number, impactPoint: Vec2): void {
    // Ordnance specializations: Thermobarics boosts splash damage, Cluster Munitions widens it.
    const eff = this.teamTech(actor.team);
    const localSplash = Math.max(10, Math.round(amount * 0.34 * eff.splashDamage));
    for (const partId of adjacentPartIds(target, targetPart.id)) {
      const part = target.parts.find((candidate) => candidate.id === partId && candidate.hp > 0);
      if (!part) continue;
      const result = applyDamage(target, part.id, localSplash);
      if (result.amount > 0) {
        this.pushLog(`${target.name}: blast splash damages ${part.label}`);
        this.afterDamage(actor, target, result);
      }
    }

    for (const entity of this.entities) {
      if (entity.id === target.id || entity.id === actor.id || !entity.status.alive || entity.downed) continue;
      const d = dist(entity.position, impactPoint);
      const radius = (target.kind === "cover" ? 2.7 : 1.9) * eff.splashRadius;
      if (d > radius + entity.radius * 0.35) continue;
      const part = preferredPart(entity, entity.kind === "cover" ? "center" : "weakest");
      const falloff = clamp(1 - d / (radius + entity.radius), 0.18, 0.74);
      const splash = Math.round((entity.kind === "cover" ? 38 : 22) * falloff * eff.splashDamage);
      if (splash <= 0) continue;
      const result = applyDamage(entity, part.id, splash);
      if (result.amount > 0) {
        this.pushLog(`${entity.name} is caught in shell blast`);
        this.effect("impact", entity.position, entity.position, 0xffbf69, 0.42, entity.radius);
        this.afterDamage(actor, entity, result);
      }
    }
  }

  private applyExplosiveRadius(actor: CombatEntity, point: Vec2, radius: number, baseDamage: number, message: string): void {
    for (const entity of this.entities) {
      // Flyers ride above the blast plane — a GROUND explosion never reaches them (anti-air is
      // direct-fire only, not splash). The 2D distance below would otherwise hit them at altitude.
      if (entity.id === actor.id || !entity.status.alive || entity.flying || entity.downed) continue;
      const d = dist(entity.position, point);
      if (d > radius + entity.radius * 0.45) continue;
      const part = preferredPart(entity, entity.kind === "cover" ? "center" : "weakest");
      const falloff = clamp(1 - d / (radius + entity.radius), 0.22, 0.9);
      const amount = Math.round((entity.kind === "cover" ? baseDamage * 1.45 : baseDamage) * falloff * this.teamDamageScale(actor));
      if (amount <= 0) continue;
      const result = applyDamage(entity, part.id, amount);
      if (result.amount > 0) {
        this.pushLog(message.includes(entity.name) ? message : `${entity.name} is caught in the blast`);
        this.effect("impact", entity.position, entity.position, 0xffbf69, 0.42, entity.radius);
        this.afterDamage(actor, entity, result);
      }
      this.applyKnockback(actor, entity, point, baseDamage, falloff);
    }
  }

  /**
   * BLAST KNOCKBACK. A explosion throws what it does not kill. Infantry go furthest, armour barely
   * registers it, and structures do not move at all — so the same grenade reads as a shove against
   * a trooper and as a scratch against a tank, which is the whole point of having both on the field.
   *
   * The throw is marched in small steps and stops at the first thing that would stop a walk: the
   * arena edge or a terrain step it cannot clear. It does NOT stop at a shoreline — a body thrown
   * into a channel goes in, and drowns. That is the one place in the game where terrain kills
   * outright, so it is logged loudly and it cannot happen to a flyer.
   */
  /** Would a thrown body land inside another one? Mirrors the separation rule movement keeps. */
  private applyKnockback(actor: CombatEntity, entity: CombatEntity, point: Vec2, baseDamage: number, falloff: number): void {
    if (!entity.status.alive || entity.flying) return;
    const mass = blastMass(entity);
    if (!Number.isFinite(mass)) return; // bolted down: bases, defenses, cover
    const dx = entity.position.x - point.x;
    const dz = entity.position.z - point.z;
    const len = Math.hypot(dx, dz);
    // Dead centre of the blast has no direction to throw along; take one from the sim's own rng so
    // the result stays reproducible for a seed.
    const angle = len > 0.001 ? Math.atan2(dz, dx) : this.rng.range(0, Math.PI * 2);
    const dirX = len > 0.001 ? dx / len : Math.cos(angle);
    const dirZ = len > 0.001 ? dz / len : Math.sin(angle);
    const throwDistance = Math.min(KNOCKBACK_MAX, (baseDamage / 30) * falloff * KNOCKBACK_SCALE / mass);
    if (throwDistance < 0.12) return;

    const steps = Math.max(4, Math.ceil(throwDistance * 6));
    let footing = terrainHeightAt(entity.position);
    let landed = { ...entity.position };
    let drowned = false;
    // What cut the throw short, if anything. A body that was thrown INTO something is a slam:
    // the momentum it did not get to spend lands as damage, on it and on whatever it hit.
    let slammedInto: CombatEntity | "cliff" | "prop" | undefined;
    let travelled = 0;
    for (let i = 1; i <= steps; i += 1) {
      const t = (throwDistance * i) / steps;
      const next = clampToArena({ x: entity.position.x + dirX * t, z: entity.position.z + dirZ * t });
      if (pointInWater(next)) { landed = next; drowned = true; break; }
      const height = terrainHeightAt(next);
      if (height - footing > TERRAIN_STEP) { slammedInto = "cliff"; break; } // slammed into a cliff face; it stops here
      // ...and stops against another body. Without this the throw shoves units inside each other
      // and breaks the separation invariant the chaos bot asserts — it caught exactly that.
      const body = this.bodyAt(entity, next);
      if (body) { slammedInto = body; break; }
      const prop = this.solidPropAt(entity, next);
      if (prop) { slammedInto = "prop"; break; }
      footing = height;
      landed = next;
      travelled = t;
    }

    if (landed.x === entity.position.x && landed.z === entity.position.z && !drowned && !slammedInto) return;
    entity.position = landed;
    entity.elevation = terrainHeightAt(landed);
    this.effect("impact", landed, landed, 0xffd9a0, 0.3, entity.radius * 0.9);
    if (!drowned) {
      this.pushLog(`${entity.name} is thrown by the blast`);
      if (slammedInto) this.resolveSlam(actor, entity, slammedInto, (throwDistance - travelled) / throwDistance, baseDamage, dirX, dirZ);
      return;
    }
    // Into the channel. Everything is destroyed at once — there is no swimming in this game.
    for (const part of entity.parts) part.hp = 0;
    recomputeStatus(entity);
    this.effect("blast", landed, landed, 0x4f9fd0, 0.7, entity.radius + 1.2);
    this.pushLog(`${entity.name} is blasted into the water and drowns`);
    this.afterDamage(actor, entity, [`${entity.name} drowned`], "Drowning");
  }

  /** The unit standing where a thrown body wants to go, if any (cover is not a body). */
  private bodyAt(mover: CombatEntity, at: Vec2): CombatEntity | undefined {
    for (const other of this.entities) {
      if (other.id === mover.id || !other.status.alive || other.flying || other.kind === "cover") continue;
      if (dist(at, other.position) < (mover.radius + other.radius) * 0.95) return other;
    }
    return undefined;
  }

  /** Solid scenery a thrown body cannot pass through (walkable ridges are not solid). */
  private solidPropAt(mover: CombatEntity, at: Vec2): CombatEntity | undefined {
    for (const other of this.entities) {
      if (other.kind !== "cover" || !other.status.alive || other.coverKind === "ridge") continue;
      if (dist(at, other.position) < (mover.radius + other.radius) * 0.8) return other;
    }
    return undefined;
  }

  /**
   * SLAM. A thrown body that stops early hit something. The unspent share of the throw becomes
   * damage: into a cliff or a rock is the worst (nothing gives), into another unit is shared —
   * both take it, and the one that was hit is knocked back a step as well. Blasts already throw
   * what they do not kill; this is what makes WHERE they throw it matter.
   */
  private resolveSlam(actor: CombatEntity, thrown: CombatEntity, into: CombatEntity | "cliff" | "prop", unspent: number, baseDamage: number, dirX: number, dirZ: number): void {
    const force = Math.round(baseDamage * 0.45 * Math.max(0.15, unspent));
    if (force < 3) return;
    const hard = into === "cliff" || into === "prop";
    const selfResult = applyDamage(thrown, preferredPart(thrown, "center").id, hard ? force : Math.round(force * 0.6));
    const what = into === "cliff" ? "the cliff" : into === "prop" ? "cover" : into.name;
    this.pushLog(`${thrown.name} slams into ${what}`);
    this.effect("strike", { x: thrown.position.x - dirX, z: thrown.position.z - dirZ }, thrown.position, 0xffc07a, 0.45, thrown.radius + 0.6);
    this.afterDamage(actor, thrown, selfResult, "Slam");
    if (hard) return;
    // The body that was hit takes a share and is shoved a step along the throw.
    const otherResult = applyDamage(into, preferredPart(into, "center").id, Math.round(force * 0.5));
    if (!isBuildingKind(into.kind) && !isDefenseKind(into.kind) && !into.flying && Number.isFinite(blastMass(into))) {
      const shove = clampToArena({ x: into.position.x + dirX * 0.45, z: into.position.z + dirZ * 0.45 });
      if (!pointInWater(shove) && Math.abs(terrainHeightAt(shove) - terrainHeightAt(into.position)) <= TERRAIN_STEP && !this.bodyAt(into, shove)) {
        into.position = shove;
        into.elevation = terrainHeightAt(shove);
      }
    }
    this.afterDamage(actor, into, otherResult, "Slam");
  }

  private resolveRam(actor: CombatEntity, target: CombatEntity): void {
    const targetPart = preferredPart(target, target.kind === "tank" ? "mobility" : "center");
    const result = applyDamage(target, targetPart.id, Math.round(72 * this.teamDamageScale(actor)));
    const selfPart = actor.parts.find((p) => p.role === "armor" && p.hp > 0) ?? preferredPart(actor, "center");
    const selfResult = applyDamage(actor, selfPart.id, 14);
    this.effect("blast", target.position, target.position, 0xffb454, 0.55, target.radius + 1.4);
    this.afterDamage(actor, target, result);
    if (selfResult.amount > 0) this.afterDamage(actor, actor, selfResult, "Ram recoil");
  }

  private resolveMelee(actor: CombatEntity, target: CombatEntity, partId?: string): void {
    const { amount, part: targetPart } = this.meleeDamageEstimate(actor, target, partId);
    const result = applyDamage(target, targetPart.id, amount);
    this.effect("strike", actor.position, target.position, result.killed ? 0xfff1a6 : 0x9dfcff, 0.52, target.radius + 1.1);
    this.pushLog(`${actor.name} strikes ${target.name}'s ${targetPart.label}`);
    this.afterDamage(actor, target, result, "Strike");
  }

  private afterDamage(actor: CombatEntity, target: CombatEntity, resultOrMessages: DamageResult | string[], source?: string): void {
    // MEDIC STABILISE. An infantry kill with a friendly medic in reach is a DOWNED body instead.
    if (!Array.isArray(resultOrMessages) && resultOrMessages.killed && this.stabilise(target)) {
      resultOrMessages.killed = false;
      resultOrMessages.messages = resultOrMessages.messages.filter((m) => !m.includes("killed by"));
    }
    const messages = Array.isArray(resultOrMessages) ? resultOrMessages : resultOrMessages.messages;
    if (!Array.isArray(resultOrMessages)) this.recordDamage(actor, target, resultOrMessages, source);
    for (const message of messages) this.pushLog(message);
    if (messages.some((message) => message.includes("killed by"))) {
      // A blade kill is a second, harder strike, not a fireball.
      if (source === "Strike") this.effect("strike", actor.position, target.position, 0xfff1a6, 0.6, target.radius + 1.4);
      // A trooper dropped by a rifle round is not an explosion. Infantry get a tight flash; only
      // vehicles and structures go up with the big dome.
      else this.effect("blast", target.position, target.position, 0xffd166, isInfantryKind(target.kind) ? 0.5 : 0.78, target.radius + (isInfantryKind(target.kind) ? 0.5 : 2.1));
    } else if (messages.some((message) => message.includes("destroyed"))) {
      this.effect("impact", target.position, target.position, 0xffbf69, 0.5, target.radius + 0.75);
    }
    this.applyPartImplications(actor, target, messages);
    const volatileDestroyed = target.parts.some((p) => p.role === "volatile" && p.hp === 0);
    if (volatileDestroyed) this.resolveExplosion(actor, target);
    // Tall rigid cover (pillars, trees, girders, obelisks, towers) topples away from the killing blow and crushes
    // whatever it lands on — positioning next to them is a readable risk/reward.
    if (
      target.kind === "cover" &&
      !target.status.alive &&
      isToppleKind(target.coverKind) &&
      !this.toppled.has(target.id)
    ) {
      this.toppled.add(target.id);
      this.resolveTopple(actor, target);
    }
    // A destroyed span takes its crossing with it. This is the most consequential destructible on
    // the board: ground units on the far side have to find another way across or be airlifted,
    // and the loss persists through saves.
    if (target.kind === "cover" && !target.status.alive && target.coverKind === "span" && !this.toppled.has(target.id)) {
      this.toppled.add(target.id); // reuse the once-only ledger; it already serializes
      this.dropBridgeAt(target.position);
    }
    // Battlefield scars: a killed vehicle burns out into a wreck — hard neutral cover
    // that also holds salvage money for whichever team parks a unit beside it.
    if (isVehicleKind(target.kind) && !target.status.alive && !this.wrecked.has(target.id)) {
      this.wrecked.add(target.id);
      const wreck = createCover(`wreck-${target.id}`, `${target.name} Wreck`, { ...target.position }, { coverKind: "wreck" });
      wreck.yaw = target.yaw;
      this.entities.push(wreck);
      this.syncEntityElevation(wreck);
      // A rammer that killed on contact is standing on the spot the wreck now occupies; step aside.
      for (const other of this.entities) {
        if (other.id === wreck.id || !other.status.alive || other.flying || other.kind === "cover" || isBuildingKind(other.kind) || isDefenseKind(other.kind)) continue;
        if (dist(other.position, wreck.position) < other.radius + wreck.radius) this.separateFromUnits(other);
      }
      this.salvage.set(wreck.id, SALVAGE_PER_WRECK);
      this.pushLog(`${target.name} burns out — the wreck is hard cover and holds $${SALVAGE_PER_WRECK} salvage`);
    }
    this.checkEndState();
  }

  private medicInReach(target: CombatEntity): CombatEntity | undefined {
    return this.entities.find((e) =>
      e.kind === "medic" && e.team === target.team && e.id !== target.id && e.status.alive && !e.downed && !e.carriedById &&
      e.parts.some((p) => p.hp > 0 && p.tags?.includes("medic-aura")) &&
      dist(e.position, target.position) <= STABILISE_RANGE,
    );
  }

  /** Turn a just-killed infantry unit into a downed body if a friendly medic is in reach. */
  private stabilise(target: CombatEntity): boolean {
    if (!isInfantryKind(target.kind) || target.downed || target.status.alive || target.flying) return false;
    const medic = this.medicInReach(target);
    if (!medic) return false;
    for (const part of target.parts) if (part.critical) part.hp = Math.max(1, Math.min(part.hp, 1));
    target.downed = true;
    target.stance = "prone";
    recomputeStatus(target);
    target.commandPoints = 0;
    this.effect("ping", { ...target.position }, { ...target.position }, 0xff5c5c, 1.1, target.radius + 0.6);
    this.pushLog(`${target.name} is down — a medic can still reach them`);
    return true;
  }

  // Downed bodies at turn start: a medic still in reach brings them back at REVIVE_CORE_FRACTION
  // of their core; otherwise the body dies for real, through the ordinary death path.
  private runDownedTick(): void {
    for (const body of this.entities) {
      if (!body.downed) continue;
      const medic = this.medicInReach(body);
      body.downed = false;
      if (medic) {
        const core = body.parts.find((p) => p.role === "core") ?? preferredPart(body, "center");
        core.hp = Math.max(core.hp, Math.round(core.maxHp * REVIVE_CORE_FRACTION));
        body.stance = "crouched";
        recomputeStatus(body);
        repairForNewTurn(body);
        this.effect("ping", { ...body.position }, { ...body.position }, 0x8effa6, 1.0, body.radius + 0.6);
        this.pushLog(`${body.name} is back on their feet`);
      } else {
        for (const part of body.parts) if (part.critical) part.hp = 0;
        recomputeStatus(body);
        const corePart = body.parts.find((p) => p.role === "core") ?? body.parts[0];
        // A real DamageResult so the ordinary death path counts the loss and plays the death.
        this.afterDamage(body, body, {
          entityId: body.id, partId: corePart.id, amount: 0, overflow: 0, destroyed: false, killed: true,
          messages: [`${body.name} killed by ${body.status.deadReason ?? "wounds"} — no medic reached them`],
        }, "Bled out");
      }
    }
  }

  // Capturable neutral structures: at the start of each turn, an uncontested field unit
  // standing beside one flips it to their team (derelict turrets come online for the
  // captor next turn; depots start paying income on the following economy tick).
  private runCaptureTick(): void {
    for (const structure of this.entities) {
      if (!structure.capturable || !structure.status.alive) continue;
      const adjacentTeams = new Set<Team>();
      for (const unit of this.entities) {
        if (!unit.status.alive || unit.flying || unit.kind === "cover" || isBuildingKind(unit.kind) || isDefenseKind(unit.kind)) continue;
        if (unit.team !== "player" && unit.team !== "enemy") continue;
        if (dist(unit.position, structure.position) <= structure.radius + unit.radius + CAPTURE_REACH) adjacentTeams.add(unit.team);
      }
      if (adjacentTeams.size !== 1) continue; // contested or empty — no flip
      const [team] = adjacentTeams;
      if (structure.team === team) continue;
      structure.team = team;
      if (structure.kind === "turret") structure.commandPoints = 0; // comes online next turn
      this.effect("ping", { ...structure.position }, { ...structure.position }, team === "player" ? 0x75d8ff : 0xff765f, 0.9, structure.radius + 0.8);
      this.pushLog(`${this.sideName(team, team === "player" ? "You" : "The enemy")} captured ${structure.name}${structure.coverKind === "depot" ? ` (+$${DEPOT_INCOME}/turn)` : ""}`);
    }
  }

  // Auto-salvage at the start of each turn: every wreck with money left pays out to the
  // first team with a living field unit adjacent to it. Park a unit by a wreck to strip it.
  private runSalvageTick(): void {
    for (const [wreckId, remaining] of this.salvage) {
      if (remaining <= 0) {
        this.salvage.delete(wreckId);
        continue;
      }
      const wreck = this.entity(wreckId);
      if (!wreck || !wreck.status.alive) {
        this.salvage.delete(wreckId);
        continue;
      }
      for (const team of ["player", "enemy"] as const) {
        const scavenger = this.entities.find((e) =>
          e.team === team && e.status.alive && !e.flying && !isBuildingKind(e.kind) && !isDefenseKind(e.kind) && e.kind !== "cover" &&
          dist(e.position, wreck.position) <= wreck.radius + e.radius + SALVAGE_REACH,
        );
        if (!scavenger) continue;
        const take = Math.min(SALVAGE_PER_TURN, remaining);
        this.addMoney(team, take);
        this.salvage.set(wreckId, remaining - take);
        this.effect("ping", { ...wreck.position }, { ...wreck.position }, 0xffd166, 0.8, wreck.radius + 0.5);
        this.pushLog(`${scavenger.name} strips $${take} from ${wreck.name} ($${remaining - take} left)`);
        break; // one team per wreck per turn — first come, first served
      }
    }
  }

  // The falling column damages everything along its landing line (bases exempt, as ever).
  private resolveTopple(actor: CombatEntity, cover: CombatEntity): void {
    const dx = cover.position.x - actor.position.x;
    const dz = cover.position.z - actor.position.z;
    const len = Math.hypot(dx, dz);
    const dir = len > 0.01 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
    const reach = Math.max(1.6, cover.height * 1.1);
    const end = clampToArena({ x: cover.position.x + dir.x * reach, z: cover.position.z + dir.z * reach });
    this.effect("topple", { ...cover.position }, end, TOPPLE_COLOR[cover.coverKind ?? "pillar"] ?? 0xc8bca0, 1.0, cover.radius);
    this.pushLog(`${cover.name} topples!`);
    for (const e of this.entities) {
      if (!e.status.alive || e.downed || e.id === cover.id || e.kind === "base") continue;
      const d = pointToSegmentDistance(e.position, cover.position, end);
      if (d > cover.radius + e.radius * 0.6 + 0.25) continue;
      const part = preferredPart(e, "center");
      const result = applyDamage(e, part.id, 52);
      this.afterDamage(actor, e, result, `Crushed by ${cover.name}`);
    }
  }

  private applyPartImplications(actor: CombatEntity, target: CombatEntity, messages: string[]): void {
    if (messages.some((m) => m.includes("is ruptured"))) {
      this.commandShock(target.position, 2.8, target.team, `${target.name}'s pack shock disrupts nearby orders`);
      this.effect("blast", target.position, target.position, 0x6fffe0, 0.46, 2.2);
    }
    if (messages.some((m) => m.includes("optic relay is ruptured"))) {
      this.pushLog(`${target.name}'s spotter link is offline`);
      this.effect("ping", target.position, target.position, 0x9dfcff, 0.7, 2.6);
    }
    if (messages.some((m) => m.includes("comms are down"))) {
      this.pushLog(`${this.sideName(target.team, target.team === "enemy" ? "Enemy" : "Player")} command network degraded`);
      this.effect("blast", target.position, target.position, 0xb9f6ff, 0.58, 3.1);
    }
    if (messages.some((m) => m.includes("turret ring is jammed"))) {
      this.effect("blast", target.position, target.position, 0xffc166, 0.48, 1.9);
    }
    if (messages.some((m) => m.includes("core is exposed"))) {
      this.pushLog(`${actor.name} opened a weak point on ${target.name}`);
      this.effect("ping", target.position, target.position, 0xfff1a6, 0.75, target.radius + 0.6);
    }
  }

  private commandShock(position: { x: number; z: number }, radius: number, team: CombatEntity["team"], message: string): void {
    let affected = 0;
    for (const entity of this.entities) {
      if (entity.team !== team || !entity.status.alive || dist(entity.position, position) > radius) continue;
      if (entity.commandPoints > 0) {
        entity.commandPoints -= 1;
        affected += 1;
      }
    }
    if (affected > 0) this.pushLog(`${message}: ${affected} unit${affected === 1 ? "" : "s"} lose CP`);
  }

  private firstEntityHitBySegment(projectile: Projectile, from: Vec2, to: Vec2, fromHeight: number, toHeight: number): ProjectileHit | undefined {
    const hits: ProjectileHit[] = [];
    for (const entity of this.entities) {
      if (entity.id === projectile.actorId || projectile.ignoredEntityIds.includes(entity.id) || !entity.status.alive || entity.carriedById || entity.downed) continue;
      this.syncEntityElevation(entity);
      const parts = impactPartOrder(entity, projectile);
      for (const part of parts) {
        const partPoint = entity.kind === "cover" ? entity.position : aimPointFor(entity, part);
        const progress = segmentProgress(partPoint, from, to);
        if (progress <= 0.015 || progress > 1) continue;
        const linePoint = {
          x: from.x + (to.x - from.x) * progress,
          z: from.z + (to.z - from.z) * progress,
        };
        const lineHeight = fromHeight + (toHeight - fromHeight) * progress;
        if (lineHeight < entity.elevation - 0.16 || lineHeight > entity.elevation + entity.height + 0.28) continue;
        const verticalDistance = verticalBandDistance(entity, part, lineHeight);
        const maxVerticalMiss = part.role === "head" ? 0.12 : part.role === "weapon" ? 0.18 : 0.24;
        if (verticalDistance > maxVerticalMiss) continue;
        const distanceToLine = pointToSegmentDistance(partPoint, from, to);
        // A blast wall is a 2.3m SLAB, not a disc: flat rounds test against its oriented box, or
        // they sailed through its outer thirds (the "bullets go through items" report). Lobbed
        // shells keep the disc: plunging fire landing just behind a wall is the whole point of them.
        if (entity.kind === "wall" && part.role === "core" && projectile.arcHeight <= 0.5) {
          if (!segmentHitsOrientedBox(from, to, entity.position, entity.yaw, 1.17, 0.41 + (projectile.kind === "shell" || projectile.kind === "grenade" ? 0.2 : 0.08))) continue;
        } else {
          // The INTENDED target is hit by aim precision (unchanged); anything else in the way blocks
          // over its whole footprint, so a round never draws through a hull or a building it did
          // not hit.
          // Flat rounds only: a lobbed shell leaves low and would clip the friendly hull it is
          // parked beside on its way up.
          const bystanderHull = projectile.arcHeight <= 0.5 && entity.id !== projectile.targetId && part.role === "core" && (isVehicleKind(entity.kind) || isBuildingKind(entity.kind) || isDefenseKind(entity.kind));
          const radius = entity.kind === "cover"
            ? entity.radius + (projectile.kind === "shell" || projectile.kind === "grenade" ? 0.22 : 0.12)
            : bystanderHull ? entity.radius * 0.92 : projectilePartRadius(entity, part, projectile);
          if (distanceToLine > radius) continue;
        }
        hits.push({
          entity,
          part,
          point: linePoint,
          height: lineHeight,
          progress,
        });
        break;
      }
    }
    return hits.sort((a, b) => a.progress - b.progress)[0];
  }

  private firstExplosiveProximity(projectile: Projectile, from: Vec2, to: Vec2, fromHeight: number, toHeight: number): { entity: CombatEntity; point: Vec2; progress: number } | undefined {
    const radius = projectileProximityRadius(projectile.kind);
    if (radius <= 0) return undefined;
    const candidates = this.entities
      .filter((entity) => entity.id !== projectile.actorId && !projectile.ignoredEntityIds.includes(entity.id) && entity.status.alive && !entity.downed)
      .map((entity) => {
        const progress = segmentProgress(entity.position, from, to);
        const point = {
          x: from.x + (to.x - from.x) * progress,
          z: from.z + (to.z - from.z) * progress,
        };
        const lineHeight = fromHeight + (toHeight - fromHeight) * progress;
        return {
          entity,
          point,
          progress,
          distance: pointToSegmentDistance(entity.position, from, to),
          lineHeight,
        };
      })
      .filter((hit) => {
        if (hit.progress <= 0.04 || hit.progress > 1) return false;
        if (hit.distance > radius + hit.entity.radius * 0.35) return false;
        return hit.lineHeight <= hit.entity.elevation + hit.entity.height + 0.48;
      })
      .sort((a, b) => a.progress - b.progress);
    return candidates[0];
  }

  private accuracyForShot(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, movedBeforeShot: boolean, attackMode: AttackMode = "weapon"): AccuracyBreakdown {
    let spreadDegrees = baseAccuracySpread(actor.kind, attackMode);
    const notes: string[] = [`${kindAccuracyLabel(actor.kind, attackMode)} base`];

    if (targetPart.role === "head") {
      spreadDegrees += 1.75;
      notes.push("small head target");
    } else if (targetPart.role === "weapon" || targetPart.role === "mobility" || targetPart.role === "utility") {
      spreadDegrees += 0.72;
      notes.push("specific part");
    }

    if (isInfantryKind(actor.kind) && actor.stance === "crouched") {
      spreadDegrees *= 0.58;
      notes.push("crouched");
    } else if (isInfantryKind(actor.kind) && actor.stance === "prone") {
      spreadDegrees *= 0.58;
      notes.push("low stance");
    }

    if (movedBeforeShot) {
      spreadDegrees = spreadDegrees * 1.65 + 0.9;
      notes.push("moved before firing");
    }

    const elevationDelta = actor.elevation - target.elevation;
    if (elevationDelta > 0.45) {
      spreadDegrees *= 0.86;
      notes.push("high-ground angle");
    }

    // Flanking: a shot into the target's exposed side/rear is tighter (it isn't dodging/covering
    // toward you). Direct fire only — area grenades don't flank.
    const flank = attackMode === "weapon" ? this.flankFactor(actor, target) : 0;
    if (flank > 0.01) {
      spreadDegrees *= 1 - flank * 0.28;
      notes.push("flanking");
    }

    const assist = this.accuracyAssistMultiplier(actor);
    if (assist < 1) {
      spreadDegrees *= assist;
      notes.push("spotter relay");
    }

    // A sniper's mark tightens every OTHER friendly's aim on the target and stretches their
    // accurate band; the marker itself gets nothing from it.
    const marked = this.isMarkedFor(actor, target);
    if (marked) {
      spreadDegrees *= MARK_SPREAD_SCALE;
      notes.push("marked target");
    }

    const rangePenalty = rangeSpreadPenalty(actor.kind, attackMode, dist(actor.position, target.position), marked ? MARK_ACCURATE_BONUS : 0);
    if (rangePenalty > 0.01) {
      spreadDegrees += rangePenalty;
      notes.push("long range");
    }

    if (this.sandstormActive()) {
      spreadDegrees = spreadDegrees * 1.45 + 1.1;
      notes.push("sandstorm");
    }

    // Ghillie Doctrine: the defending team's units are simply harder to hit.
    const evasion = this.teamTech(target.team).evasion;
    if (evasion > 1) {
      spreadDegrees *= evasion;
      notes.push("evasive target");
    }

    spreadDegrees = Math.max(0, spreadDegrees);
    const rating = ratingForSpread(spreadDegrees);
    const effectiveSpreadDegrees = rating === "great" ? 0 : spreadDegrees;
    const distanceToTarget = Math.max(0.1, dist(actor.position, target.position));
    const targetAngle = Math.atan(impactRadius(target, targetPart) / distanceToTarget);
    const spreadRadians = effectiveSpreadDegrees * (Math.PI / 180);
    const hitChance = spreadRadians <= 0 ? 1 : clamp(targetAngle / spreadRadians, 0.05, 0.98);

    return {
      rating,
      label: `${ACCURACY_LABELS[rating]} / ${Math.round(hitChance * 100)}% ${targetPart.label}`,
      spreadRadians,
      spreadDegrees: effectiveSpreadDegrees,
      hitChance,
      notes,
    };
  }

  /** Whether `target` carries a live sniper mark that benefits `actor` (a friendly other than the marker). */
  isMarkedFor(actor: CombatEntity, target: CombatEntity): boolean {
    return (target.markedUntilTurn ?? 0) >= this.turn && target.markedById !== actor.id && target.team !== actor.team;
  }

  private accuracyAssistMultiplier(actor: CombatEntity): number {
    const spotter = this.entities.find((entity) =>
      entity.id !== actor.id &&
      entity.team === actor.team &&
      entity.status.alive &&
      dist(entity.position, actor.position) <= 6.2 &&
      entity.parts.some((part) => part.hp > 0 && part.tags?.includes("spotter-aura"))
    );
    if (!spotter) return 1;
    // Optics Array sharpens the spotter relay further.
    return this.teamTech(actor.team).spotterBoost ? 0.7 : 0.82;
  }

  private actorHasQueuedMove(actorId: string): boolean {
    return this.orders.some((order) => order.actorId === actorId && !order.done && (order.kind === "move" || order.kind === "ram"));
  }

  private actorMovedBeforeOrder(order: TacticalOrder): boolean {
    const orderIndex = this.orders.indexOf(order);
    if (orderIndex <= 0) return false;
    return this.orders
      .slice(0, orderIndex)
      .some((candidate) => candidate.actorId === order.actorId && (candidate.kind === "move" || candidate.kind === "ram"));
  }

  // Push a moving unit out of any unit/structure it overlaps so squads can't walk through
  // each other (or through walls/turrets). Only the mover is nudged, so two units closing in
  // slide past instead of stacking.
  private separateFromUnits(actor: CombatEntity, destination?: Vec2): void {
    if (actor.flying) return; // a flyer sits above the ground plane — it never jostles ground units
    // Relax over a few passes: pushing off one neighbour can shove the mover into another, so a
    // single pass leaves residual overlaps (units visually merged) in a crowd. Iterate until settled.
    for (let iter = 0; iter < 4; iter += 1) {
      let moved = false;
      for (const other of this.entities) {
        if (other.id === actor.id || !other.status.alive || other.carriedById) continue; // carried units aren't on the ground
        if (other.kind === "cover") {
          // Ridges are walkable high ground, and a low cover the unit has climbed ONTO is a valid
          // perch — skip those. If the unit's own move destination sits on this cover it is climbing
          // onto it (or ascending a cliff), so don't fight the climb. Every OTHER solid prop pushes
          // the mover out, so unit-vs-unit separation can't deflect someone into (and through) it.
          if (other.coverKind === "ridge") continue;
          if (destination && dist(other.position, destination) <= other.radius) continue;
          const onTop = isClimbableCover(other) && dist(actor.position, other.position) <= Math.max(0.35, other.radius * 0.65);
          if (onTop) continue;
        }
        const minDist = actor.radius + other.radius;
        let dx = actor.position.x - other.position.x;
        let dz = actor.position.z - other.position.z;
        let d = Math.hypot(dx, dz);
        // Exactly on top of another body (cargo dropped where its carrier died): pick a
        // deterministic direction from the ids rather than skipping the push.
        if (d <= 0.0001 && minDist > 0) {
          let h = 0;
          for (const ch of actor.id + other.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          const a = (h % 360) * (Math.PI / 180);
          dx = Math.cos(a) * 0.01;
          dz = Math.sin(a) * 0.01;
          d = 0.01;
        }
        if (d < minDist) {
          const push = minDist - d;
          actor.position.x += (dx / d) * push;
          actor.position.z += (dz / d) * push;
          moved = true;
        } else if (d <= 0.0001) {
          // Exactly coincident (two movers resolved to the same spot): the push direction is
          // undefined, so eject a FULL separation along a deterministic per-pair angle. A tiny
          // fixed nudge here was the "units stacked on top of each other" bug.
          const angle = pairAngle(actor.id, other.id);
          actor.position.x += Math.cos(angle) * minDist;
          actor.position.z += Math.sin(angle) * minDist;
          moved = true;
        }
      }
      actor.position = clampToArena(actor.position);
      // Separation is a POSITION EDIT that bypasses the movement rules, so it can shove a ground
      // unit off a bridge into the channel it was crossing -- the chaos bot caught exactly that,
      // a unit ending a turn 4mm outside a bridge edge and standing in water. Movement refuses to
      // enter water; every other way a unit's position changes has to refuse too.
      if (!actor.flying) actor.position = nearestDryPoint(actor.position);
      if (!moved) break; // fully separated — stop early
    }
  }

  private syncAllElevations(): void {
    for (const entity of this.entities) this.syncEntityElevation(entity);
  }

  private syncEntityElevation(entity: CombatEntity): void {
    entity.elevation = this.elevationForEntityAt(entity, entity.position);
  }

  private elevationForEntityAt(entity: CombatEntity, position: Vec2): number {
    // Flyers float a constant height above whatever is beneath them (clears mesas and valleys at
    // the same visible clearance) — the air layer's altitude axis.
    if (entity.flying) return terrainHeightAt(position) + (entity.agl ?? 6);
    let elevation = terrainHeightAt(position);
    if (entity.kind === "cover" || !isInfantryKind(entity.kind)) return elevation;
    const climbable = this.entities.find((candidate) =>
      candidate.kind === "cover" &&
      candidate.status.alive &&
      isClimbableCover(candidate) &&
      dist(position, candidate.position) <= Math.max(0.35, candidate.radius * 0.65)
    );
    if (climbable) elevation = Math.max(elevation, terrainHeightAt(climbable.position) + climbable.height + 0.04);
    return elevation;
  }

  private refreshDefendingStances(): void {
    this.defending.clear();
    for (const entity of this.entities) {
      if (entity.status.alive && entity.stance !== "standing") this.defending.add(entity.id);
    }
  }

  /**
   * A volatile prop going up. The three volatile kinds used to detonate identically -- same blast,
   * same radius, same damage -- so a fuel cell, an ammo cache and a power conduit were three names
   * for one event, and there was no reason to prefer shooting one over another. Each now has its
   * own consequence, which is what makes the scenery worth aiming at:
   *
   *   FUEL    a modest blast that LEAVES A FIRE. The denial lasts turns; the bang does not.
   *   AMMO    no single big blast -- a staggered cook-off that keeps going off around the wreck.
   *   CONDUIT barely damages anything, and knocks out nearby emplacements for a couple of turns.
   */
  /**
   * Is this emplacement blacked out by a cut power conduit? A browned-out turret keeps its armour
   * and its footprint -- it is still cover, still a target, still in the way -- it just cannot
   * shoot. That is what makes cutting the conduit a tactic rather than a slower way to kill things.
   */
  isPowerCut(entity: CombatEntity): boolean {
    return (entity.poweredUntilTurn ?? 0) > this.turn;
  }

  private resolveExplosion(actor: CombatEntity, source: CombatEntity): void {
    if (this.detonated.has(source.id)) return;
    this.detonated.add(source.id);
    const kind = source.coverKind;

    if (kind === "conduit") {
      this.effect("blast", source.position, source.position, 0x7fd7ff, 0.6, 2.2);
      const disabledUntil = this.turn + CONDUIT_OUTAGE_TURNS;
      let cut = 0;
      for (const entity of this.entities) {
        if (entity.id === source.id || !entity.status.alive) continue;
        if (dist(entity.position, source.position) > CONDUIT_RADIUS) continue;
        // Powered things only: emplacements and the base. Infantry are not on the grid.
        if (!isDefenseKind(entity.kind) && entity.kind !== "base") continue;
        entity.poweredUntilTurn = Math.max(entity.poweredUntilTurn ?? 0, disabledUntil);
        cut += 1;
      }
      this.pushLog(cut > 0
        ? `${source.name} ruptures — ${cut} emplacement${cut === 1 ? "" : "s"} lose power for ${CONDUIT_OUTAGE_TURNS} rounds`
        : `${source.name} ruptures, but nothing nearby was drawing power`);
      return;
    }

    if (kind === "gas") {
      // No bang yet. The canister leaks, and the cloud is the threat -- it grows every turn and
      // waits for a spark. Big enough from the start to matter, capped so a map never fills.
      this.gasClouds.push({ id: `gas-${++this.effectSeq}`, x: source.position.x, z: source.position.z, radius: GAS_START_RADIUS, maxRadius: GAS_MAX_RADIUS });
      this.effect("ping", source.position, source.position, 0xa6e05a, 0.8, GAS_START_RADIUS);
      this.pushLog(`${source.name} ruptures — gas is spreading. Keep fire away from it, or don't`);
      return;
    }

    if (kind === "ammo") {
      // Cook-off: a scatter of small detonations around the wreck over the next couple of seconds.
      // Individually survivable, collectively an area you do not want to be standing in.
      this.effect("blast", source.position, source.position, 0xffb845, 0.5, 1.8);
      for (let i = 0; i < AMMO_COOKOFF_COUNT; i += 1) {
        const angle = this.rng.next() * Math.PI * 2;
        const spread = 0.6 + this.rng.next() * AMMO_COOKOFF_SPREAD;
        this.pendingStrikes.push({
          at: 0.25 + i * 0.28,
          point: { x: source.position.x + Math.cos(angle) * spread, z: source.position.z + Math.sin(angle) * spread },
          radius: 1.5,
          damage: 20,
          kind: "barrage",
        });
      }
      this.pushLog(`${source.name} cooks off`);
      return;
    }

    // Fuel (and any future volatile without its own behaviour): a real bang, then a fire.
    this.effect("blast", source.position, source.position, 0xff7a35, 0.75, 3.4);
    for (const entity of this.entities) {
      if (entity.id === source.id || !entity.status.alive || entity.downed) continue;
      const d = dist(entity.position, source.position);
      if (d > 3.5) continue;
      const part = preferredPart(entity, "weakest");
      // CHAIN REACTIONS. A volatile prop next to an explosion goes with it: the blast hits its
      // volatile part at treble strength, so a fuel dump laid out in a row cascades from one shot.
      const volatileNeighbour = entity.kind === "cover" && entity.parts.some((p) => p.role === "volatile" && p.hp > 0);
      const result = applyDamage(entity, part.id, Math.round(42 * (1 - d / 4) * (volatileNeighbour ? 3 : 1)));
      this.afterDamage(actor, entity, result, `${source.name} explosion`);
    }
    if (kind === "fuel" || kind === "brazier") {
      this.burnZones.push({
        id: `burn-${++this.effectSeq}`,
        x: source.position.x,
        z: source.position.z,
        radius: FUEL_FIRE_RADIUS,
        turnsLeft: FUEL_FIRE_TURNS,
      });
      this.pushLog(`${source.name} ignites — the ground burns`);
    }
  }

  private firstCoverBetweenShot(from: Vec2, to: Vec2, fromHeight: number, toHeight: number, ignoreId?: string, arcHeight = 0): CombatEntity | undefined {
    const candidates = this.entities
      .filter((e) => e.kind === "cover" && e.status.alive && e.id !== ignoreId)
      .map((e) => ({
        entity: e,
        progress: segmentProgress(e.position, from, to),
        distance: pointToSegmentDistance(e.position, from, to),
      }))
      .filter((hit) => {
        // Arcing throws use a slightly wider window so an obstacle the lobbed round will clip
        // is flagged in the preview; flat shots keep the original tight thresholds.
        const arcing = arcHeight > 0.5;
        if (hit.progress <= 0.02 || hit.progress >= (arcing ? 0.95 : 0.98)) return false;
        if (hit.distance > hit.entity.radius + (arcing ? 0.22 : 0.18)) return false;
        const lineHeight = trajectoryHeight(fromHeight, toHeight, hit.progress, arcHeight);
        return lineHeight <= hit.entity.height + hit.entity.elevation + 0.18;
      })
      .sort((a, b) => a.progress - b.progress);
    return candidates[0]?.entity;
  }

  private firstEntityBetweenShot(from: Vec2, to: Vec2, fromHeight: number, toHeight: number, actorId: string, targetId: string, arcHeight = 0): CombatEntity | undefined {
    const candidates = this.entities
      .filter((entity) => entity.kind !== "cover" && entity.status.alive && !entity.downed && entity.id !== actorId && entity.id !== targetId)
      .map((entity) => {
        const part = preferredPart(entity, "center");
        const point = aimPointFor(entity, part);
        const progress = segmentProgress(point, from, to);
        const lineHeight = trajectoryHeight(fromHeight, toHeight, progress, arcHeight);
        return {
          entity,
          part,
          progress,
          distance: pointToSegmentDistance(point, from, to),
          lineHeight,
        };
      })
      .filter((hit) => {
        // Arcing throws look a bit wider/closer to the target so a unit the lobbed round will
        // clip is flagged; flat shots keep the original tighter check to avoid false blocks.
        const arcing = arcHeight > 0.5;
        if (hit.progress <= 0.02 || hit.progress >= (arcing ? 0.96 : 0.98)) return false;
        if (hit.distance > hit.entity.radius * (arcing ? 0.85 : 0.72)) return false;
        return hit.lineHeight >= hit.entity.elevation - 0.12 && hit.lineHeight <= hit.entity.elevation + hit.entity.height + 0.22;
      })
      .sort((a, b) => a.progress - b.progress);
    return candidates[0]?.entity;
  }

  // Which tactical behaviors the enemy commander uses, by difficulty. Easy is the original
  // greedy bot (nearest target, no focus-fire/cover/retreat). Normal and Hard share the smart
  // brain — the difference between them is the stat padding applied elsewhere, not the tactics,
  // so Normal is a *fair* test of skill rather than a dumb bot with a health bar.
  /**
   * THREE BRAINS (2026-09-22). Difficulty used to change only the bot's STATS between Normal and
   * Hard; both ran the same brain. Now:
   *   easy   -- shoots whatever is nearest, walks straight at you, ignores cover, spends greedily.
   *   normal -- focus fire, cover-biased advances, retreats the crippled, reactive economy.
   *   hard   -- all of that plus TACTICS: dodges telegraphed strikes / fire / gas, takes the shot
   *             that KILLS this turn and aims at the part that finishes or disarms, kites its
   *             fragile ranged units, pulls back to defend its base, throws grenades at clusters
   *             and dug-in targets, and runs a deterministic, income-first economy.
   * `brainOverride` lets self-play pit one brain against another at equal stats.
   */
  brainOverride?: Difficulty;
  /** Self-play knob: force individual brain traits on/off to measure what each one is worth. */
  debugAiTraits?: Partial<{ focusFire: boolean; useCover: boolean; retreat: boolean; smartEconomy: boolean; tactical: boolean }>;
  private aiProfile(): { focusFire: boolean; useCover: boolean; retreat: boolean; smartEconomy: boolean; tactical: boolean } {
    const brain = this.brainOverride ?? this.difficulty;
    const base = brain === "easy"
      ? { focusFire: false, useCover: false, retreat: false, smartEconomy: false, tactical: false }
      : { focusFire: true, useCover: true, retreat: true, smartEconomy: true, tactical: brain === "hard" };
    return this.debugAiTraits ? { ...base, ...this.debugAiTraits } : base;
  }

  /** Hard brain: is `pos` somewhere that gets hurt THIS turn -- a telegraphed strike, fire, gas? */
  private aiDangerAt(pos: Vec2, margin = 0.8): boolean {
    for (const z of this.eventZonesForTurn(this.turn)) if (dist(pos, z) <= z.radius + margin) return true;
    for (const z of this.burnZones) if (dist(pos, z) <= z.radius + margin) return true;
    for (const z of this.gasClouds) if (dist(pos, z) <= z.radius + margin) return true;
    return false;
  }

  /** Hard brain: the part of `target` whose hit does the most -- a kill first, then a disarm. */
  private aiBestPart(shooter: CombatEntity, target: CombatEntity): DamagePart {
    let best = preferredPart(target, "center");
    let bestScore = -Infinity;
    for (const part of target.parts) {
      if (part.hp <= 0) continue;
      const aim = aimForPart(part);
      const dmg = this.estimateShotDamage(shooter, target, part, aim, false);
      const lethal = (part.role === "core" || part.role === "head") && dmg >= part.hp;
      const disables = dmg >= part.hp && (part.role === "weapon" || part.role === "mobility");
      const score = (lethal ? 1000 : 0) + (disables ? (part.role === "weapon" ? 120 : 60) : 0) + dmg + (part.role === "core" ? 5 : 0);
      if (score > bestScore) { bestScore = score; best = part; }
    }
    return best;
  }

  // `dryRun` (recon preview): decide unit orders only — no repairs, no comms clamp, no base
  // purchases — so enemyIntents() can undo everything it touched.
  private queueEnemyOrders(dryRun = false): void {
    const profile = this.aiProfile();
    if (!dryRun) {
      for (const entity of this.living("enemy")) repairForNewTurn(entity);
      const enemyCommsOnline = this.entities.some((e) =>
        e.team === "enemy" &&
        e.kind === "base" &&
        e.status.alive &&
        Boolean(e.parts.find((p) => p.id === "comms" && p.hp > 0))
      );
      if (!enemyCommsOnline) {
        for (const entity of this.living("enemy")) {
          if (entity.kind !== "base") entity.commandPoints = Math.min(entity.commandPoints, 1);
        }
      }
      // The enemy Home Base reinforces or upgrades before its units act. Newly deployed
      // troops have 0 CP, so they simply hold position until the next turn.
      for (const base of this.living("enemy")) {
        if (base.kind === "base") this.enemyBaseAct(base);
      }
    }
    // Carried passengers are aboard a transport — not targetable and not on the ground.
    const players = this.living("player").filter((entity) => !isBuildingKind(entity.kind) && !entity.carriedById && !entity.downed);
    const allPlayers = this.living("player").filter((entity) => !entity.carriedById && !entity.downed);
    if (!allPlayers.length) return;
    const objective = this.enemyObjective();
    const home = this.enemyHomePosition();
    // Running tally of damage already committed to each player unit this turn. Focus-fire reads
    // it so shooters pile onto one target until it's predicted dead, then spill to the next.
    const committed = new Map<string, number>();
    const easyBrain = (this.brainOverride ?? this.difficulty) === "easy";
    for (const enemy of this.living("enemy")) {
      if (isBuildingKind(enemy.kind) || enemy.carriedById) continue; // carried units can't act
      // EASY hesitates: about a third of its units sit a turn out. It is the bot a new player
      // learns on, and at full activity it out-raced the "smart" brains in self-play.
      if (easyBrain && !dryRun && this.rng.chance(0.3)) continue;
      const target = nearest(enemy, players.length ? players : allPlayers);
      const range = projectileRange(enemy);
      const separation = target ? dist(enemy.position, target.position) : Infinity;
      // The hard brain throws on PURPOSE (a cluster, or a target dug in behind cover); the others
      // roll for it. The roll is drawn exactly where it always was, so easy/normal replays are unchanged.
      const canNade = Boolean(target) && enemy.kind === "soldier" && enemy.grenades > 0 && enemy.commandPoints > 0;
      const worthGrenade = canNade && (profile.tactical
        ? players.filter((p) => !p.flying && dist(p.position, target!.position) <= 2.4).length >= 2 || this.isShelteredAt(target!.position, enemy.position)
        : this.rng.chance(0.35));
      if (target && worthGrenade && !this.grenadeFailureReason(enemy, target)) {
        this.queueGrenadeFor(enemy, target, "center");
        continue;
      }
      // Melee units strike when adjacent instead of relying on a (nonexistent) gun.
      if (target && enemy.kind === "striker" && enemy.commandPoints > 0 && separation <= meleeRange(enemy) + enemy.radius + target.radius) {
        const part = preferredPart(target, target.kind === "cover" ? "center" : "weakest");
        this.addOrder({ actorId: enemy.id, kind: "melee", targetId: target.id, targetPartId: part.id, aim: aimForPart(part), duration: 0.78 });
        spendCommandPoint(enemy);
        continue;
      }
      // Air units: the autocannon is air-to-air ONLY, so a gunship guns enemy flyers but drops
      // BOMBS on ground targets (aimed at the spot, like a grenade). Deterministic — a gunship
      // commits rather than rolling for it.
      if (isAirKind(enemy.kind) && enemy.commandPoints > 0) {
        const flyers = (players.length ? players : allPlayers).filter((p) => p.flying && p.status.alive);
        const airTgt = flyers.length ? nearest(enemy, flyers) : undefined;
        if (airTgt && enemy.status.canShoot && dist(enemy.position, airTgt.position) <= range && this.queueShootFor(enemy, airTgt, "center")) continue;
        // Bombers drop STRAIGHT DOWN (like the player's), so they only bomb when a ground foe is
        // roughly beneath them — otherwise they fall through to the move block to fly over one.
        if (enemy.grenades > 0 && isAirBomber(enemy)) {
          const beneath = (players.length ? players : allPlayers).find((p) => !p.flying && p.status.alive && !isBuildingKind(p.kind) && dist(enemy.position, p.position) <= 2.6);
          if (beneath) {
            spendCommandPoint(enemy);
            enemy.grenades = Math.max(0, enemy.grenades - 1);
            this.addOrder({ actorId: enemy.id, kind: "grenade", destination: { x: enemy.position.x, z: enemy.position.z }, aim: "center", duration: 1.15 });
            continue;
          }
        }
      }
      // Fire when a target is in weapon range. Smart bots focus-fire the highest-value killable
      // unit they can reach; the greedy bot just shoots whatever is nearest and in range.
      const shootTarget = profile.focusFire
        ? this.pickShootTarget(enemy, players.length ? players : allPlayers, committed, range)
        : (target && separation <= range ? target : undefined);
      let fired = false;
      if (shootTarget && enemy.status.canShoot && enemy.commandPoints > 0) {
        const aim = enemy.kind === "sniper"
          ? (isInfantryKind(shootTarget.kind) ? "head" : "weapon")
          : enemy.kind === "grenadier" || enemy.kind === "mortar"
            ? "center"
            : isVehicleKind(shootTarget.kind) ? "mobility" : this.rng.chance(0.35) ? "weapon" : "center";
        // Line of sight: don't waste a shot on a target the round can't reach. If a DESTRUCTIBLE
        // blocker (cover, or an enemy-of-ours foe unit) is in the way, breach it instead — break it
        // down to open the lane. If terrain or a friendly blocks it, hold fire and advance for a
        // clean line. (rng was already drawn above, so this decision never shifts the RNG stream.)
        const block = profile.useCover ? this.aiShotBlocker(enemy, shootTarget) : undefined;
        let fireTarget: CombatEntity | undefined = shootTarget;
        let fireAim: AimMode = aim;
        if (block) {
          if (block.terrain || block.blocker?.team === enemy.team) fireTarget = undefined; // can't breach — reposition
          else if (block.blocker) { fireTarget = block.blocker; fireAim = "center"; } // shoot through the blocker
        }
        if (profile.tactical && fireTarget === shootTarget && !block) fireAim = aimForPart(this.aiBestPart(enemy, shootTarget));
        if (fireTarget && this.queueShootFor(enemy, fireTarget, fireAim)) {
          fired = true;
          const burst = enemy.kind === "heavy" ? 3 : 1;
          // Predict actual damage (folds in falloff, cover-less vsAir, flank, tech) so focus-fire
          // hands off only when the target is really dead — not when flat base damage says so.
          const perShot = this.estimateShotDamage(enemy, fireTarget, preferredPart(fireTarget, fireAim), fireAim, false);
          committed.set(fireTarget.id, (committed.get(fireTarget.id) ?? 0) + perShot * burst);
        }
      }
      // Artillery is a POSITION piece: once it has a target in reach it stays put and deploys
      // (it cannot fire until it has), and once deployed it does not pack up to chase.
      if (enemy.kind === "artillery" && (shootTarget || enemy.deployed) && enemy.status.canShoot) continue;
      // Otherwise advance: carriers run the flag home, crippled units fall back to base, others
      // push the objective or the nearest threat, routing around (and hugging) solid objects.
      if (enemy.status.canMove && enemy.commandPoints > 0) {
        const carrying = this.modeState.flags.some((f) => f.carrierId === enemy.id);
        const homeGoal = this.modeState.flags.find((f) => f.team === "enemy")?.home;
        const isMelee = enemy.kind === "striker";
        // A unit that has lost its weapon or is badly wounded retreats toward base instead of
        // feeding itself into fire — but only if it has somewhere to fall back to.
        // "Lost its weapon" is status.disarmed (had a weapon, it is gone), NOT !canShoot: a striker,
        // bomber or transport never CAN shoot, and reading that as crippled sent every one of them
        // home for the whole battle (found by balance.test.ts — 0 damage from 14 strikers).
        const crippled = profile.retreat && !carrying && Boolean(home) && (enemy.status.disarmed || coreHpFraction(enemy) < 0.3);
        // FEAR (flamer): infantry near burning ground run from it instead of pressing. A flag
        // carrier still runs the flag home; vehicles and flyers do not care.
        const fire = isInfantryKind(enemy.kind) && !carrying ? this.nearestBurnZone(enemy.position, FLAMER_FEAR_RADIUS) : undefined;
        // Shooters hold at weapon range; melee always close; carriers run the flag home;
        // in objective modes, idle units push the hill/flag rather than over-extending.
        const wantsTarget = Boolean(target) && (isMelee || separation > Math.min(range * 0.8, 6));
        let goal: Vec2 | undefined;
        let advancing = false;
        // HARD: an intruder near our base pulls the nearby defenders back onto it.
        const intruder = profile.tactical && home && !carrying
          ? (players.length ? players : allPlayers).find((p) => dist(p.position, home) < 11)
          : undefined;
        // HARD: fragile ranged units keep their distance instead of walking into melee range.
        const kites = profile.tactical && !carrying && target && (enemy.kind === "sniper" || enemy.kind === "mortar" || enemy.kind === "grenadier" || enemy.kind === "droneop" || enemy.kind === "medic")
          && separation < Math.max(4, range * 0.4);
        if (profile.tactical && !carrying && this.aiDangerAt(enemy.position)) {
          // Standing in a strike zone, fire or gas: step out first, whatever else is going on.
          goal = this.aiEscapePoint(enemy);
        } else if (carrying && homeGoal) {
          goal = homeGoal;
        } else if (intruder && dist(enemy.position, home!) < 18 && !isAirKind(enemy.kind)) {
          goal = intruder.position;
          advancing = true;
        } else if (kites && target) {
          const away = normalize({ x: enemy.position.x - target.position.x, z: enemy.position.z - target.position.z });
          goal = clampToArena({ x: enemy.position.x + away.x * moveRange(enemy), z: enemy.position.z + away.z * moveRange(enemy) });
        } else if (fire) {
          const away = dist(enemy.position, fire) > 0.05
            ? normalize({ x: enemy.position.x - fire.x, z: enemy.position.z - fire.z })
            : normalize({ x: enemy.position.x - (target?.position.x ?? 0), z: enemy.position.z - (target?.position.z ?? 0) });
          const flee = moveRange(enemy);
          goal = clampToArena({ x: enemy.position.x + away.x * flee, z: enemy.position.z + away.z * flee });
          this.pushLog(`${enemy.name} runs from the fire`);
        } else if (crippled) {
          goal = home;
        } else if (wantsTarget) {
          goal = target!.position;
          advancing = true;
        } else if (!fired) {
          // No shot landed and no target pulled us. First grab free economy the AI used to walk
          // past — a nearby cash cache or an uncaptured resource structure — then fall back to
          // pushing the mode objective. This ALSO applies in destroy mode (objective = the player
          // base) — without it a unit whose fire was blocked, or that idled just inside its range
          // band, had no goal at all and the whole army could stall at its own base.
          const loot = this.nearestLoot(enemy);
          if (loot) {
            goal = loot;
            advancing = true;
          } else if (objective && dist(enemy.position, objective) > 2.2) {
            goal = objective;
            advancing = true;
          }
        }
        if (goal) {
          const step = isVehicleKind(enemy.kind) ? Math.max(3.2, moveRange(enemy)) : moveRange(enemy);
          // When pushing toward a threat, prefer a tile that ends sheltered behind cover.
          let destination = profile.useCover && advancing && target
            ? this.coverBiasedDestination(enemy, goal, target, step)
            : this.navigateToward(enemy, goal, step);
          // HARD: never END a move inside this turn's strike zone, fire or gas -- stop short instead.
          if (profile.tactical && this.aiDangerAt(destination) && !this.aiDangerAt(enemy.position)) {
            for (const f of [0.66, 0.33]) {
              const shorter = { x: enemy.position.x + (destination.x - enemy.position.x) * f, z: enemy.position.z + (destination.z - enemy.position.z) * f };
              if (!this.aiDangerAt(shorter)) { destination = shorter; break; }
            }
            if (this.aiDangerAt(destination)) destination = enemy.position; // hold rather than walk in
          }
          if (dist(enemy.position, destination) > 0.2) {
            spendCommandPoint(enemy);
            this.addOrder({
              actorId: enemy.id,
              kind: "move",
              destination,
              aim: "center",
              duration: isVehicleKind(enemy.kind) ? 2.05 : 1.7,
            });
          }
        }
      }
    }
  }

  /** Hard brain: the reachable point that gets furthest out of every danger this turn. */
  private aiEscapePoint(actor: CombatEntity): Vec2 {
    const step = moveRange(actor);
    let best = actor.position;
    let bestScore = -Infinity;
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      const want = clampToArena({ x: actor.position.x + Math.sin(a) * step, z: actor.position.z + Math.cos(a) * step });
      const c = this.blockedMoveDestination(actor, actor.position, want, undefined, true);
      const home = this.enemyHomePosition();
      const score = (this.aiDangerAt(c) ? -100 : 0) + (home ? -dist(c, home) * 0.05 : 0) + dist(actor.position, c) * 0.1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /** The closest burning ground within `radius` of a point, if any. */
  private nearestBurnZone(point: Vec2, radius: number): Vec2 | undefined {
    let best: Vec2 | undefined;
    let bestDistance = radius;
    for (const zone of this.burnZones) {
      const d = dist(point, zone) - zone.radius;
      if (d <= bestDistance) { bestDistance = d; best = zone; }
    }
    return best;
  }

  // The position the enemy army falls back to when crippled (its living Home Base), if any.
  private enemyHomePosition(): Vec2 | undefined {
    return this.entities.find((e) => e.team === "enemy" && e.kind === "base" && e.status.alive)?.position;
  }

  // Focus-fire target picker: among the shooter's in-range options, concentrate fire on a
  // single unit until it is predicted dead (overkilled targets sink to the bottom), preferring
  // high-value units (support/siege) and finishing wounded ones first.
  // What the enemy's shot at `target` would actually hit if it isn't the target itself: terrain
  // (can't breach), or a blocking entity/cover (breach it). Undefined = clear line. Reuses the
  // player-facing shot preview (rng-free) so the AI "sees" the same block the player would.
  private aiShotBlocker(actor: CombatEntity, target: CombatEntity): { terrain: boolean; blocker?: CombatEntity } | undefined {
    const part = preferredPart(target, "center");
    const preview = this.previewAttack(actor.id, target.id, part.id, "weapon");
    if (!preview) return undefined;
    if (preview.blockedByGround || preview.blockedBySmoke) return { terrain: true };
    if (preview.impactEntityId && preview.impactEntityId !== target.id) {
      return { terrain: false, blocker: this.entity(preview.impactEntityId) };
    }
    return undefined;
  }

  private pickShootTarget(shooter: CombatEntity, candidates: CombatEntity[], committed: Map<string, number>, range: number): CombatEntity | undefined {
    const ranked = candidates
      .filter((t) => t.status.alive && dist(shooter.position, t.position) <= range + 0.01)
      .map((t) => {
        const com = committed.get(t.id) ?? 0;
        const hp = remainingHp(t);
        // What THIS shooter would actually land — so a rifleman won't waste shots on a flyer it
        // can barely scratch (vsAir ≈ 0.14) and units pass over targets they can't meaningfully hurt.
        const perShot = this.estimateShotDamage(shooter, t, preferredPart(t, "center"), "center", false);
        return {
          t,
          // A flyer the shooter can barely scratch (poor vsAir) drops below any target it can
          // actually kill — so riflemen stop wasting fire on aircraft the flak should handle.
          ineffective: t.flying && perShot < remainingHp(t) * 0.15 ? 1 : 0,
          saturated: com >= hp ? 1 : 0, // already getting enough fire to die — deprioritize
          engaged: com > 0 ? 0 : 1, // pile onto a unit we've already started on
          // HARD: a target this shot (plus fire already committed) finishes, first of all.
          // (Killing the CORE kills the unit, so "finishable" is measured against the core, not the
          // sum of every part.)
          finish: this.aiProfile().tactical && com + perShot >= Math.min(hp, t.parts.find((p) => p.role === "core" && p.hp > 0)?.hp ?? hp) ? 0 : 1,
          value: aiTargetValue(t.kind),
          hp,
        };
      })
      .sort((a, b) => a.ineffective - b.ineffective || a.saturated - b.saturated || a.finish - b.finish || a.engaged - b.engaged || b.value - a.value || a.hp - b.hp);
    return ranked[0]?.t;
  }

  // Advance toward a goal but prefer a reachable tile that ends behind sturdy cover relative to
  // the threat (and, all else equal, one that wraps into the target's exposed rear), so the bot
  // doesn't cross open ground when a flanking-but-covered step exists.
  private coverBiasedDestination(actor: CombatEntity, goal: Vec2, target: CombatEntity, step: number): Vec2 {
    const threat = target.position;
    const direct = this.navigateToward(actor, goal, step);
    const candidates: Vec2[] = [direct];
    const baseAngle = Math.atan2(goal.x - actor.position.x, goal.z - actor.position.z);
    for (const offset of [0.6, -0.6, 1.1, -1.1]) {
      const angle = baseAngle + offset;
      const cand = clampToArena({ x: actor.position.x + Math.sin(angle) * step, z: actor.position.z + Math.cos(angle) * step });
      candidates.push(this.blockedMoveDestination(actor, actor.position, cand, undefined, true));
    }
    let best = direct;
    let bestScore = -Infinity;
    const startToGoal = dist(actor.position, goal);
    for (const c of candidates) {
      if (dist(actor.position, c) < step * 0.3) continue; // didn't meaningfully move
      const progress = startToGoal - dist(c, goal); // positive = closer to the goal
      const sheltered = this.isShelteredAt(c, threat) ? 2.4 : 0;
      // Steer clear of live enemy overwatch cones: a tile inside one hands the player a free
      // reaction shot, so it's weighted below a slightly-less-direct route that stays out of arc.
      const exposed = this.standingInOverwatch(c, actor.team) ? 2.8 : 0;
      // Small pull toward the target's exposed rear — enough to circle when it costs little
      // progress, never enough to march the long way around.
      const flankBias = this.flankFactorAt(c, target) * 1.2;
      const score = progress + sheltered - exposed + flankBias;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  // True if standing at `pos` would trip a live hostile overwatch cone (same radius + arc test
  // checkOverwatch fires with). The AI routes around these so it doesn't feed itself free shots.
  private standingInOverwatch(pos: Vec2, moverTeam: Team): boolean {
    if (this.overwatching.size === 0) return false;
    for (const [watcherId, shots] of this.overwatching) {
      if (shots <= 0) continue;
      const watcher = this.entity(watcherId);
      if (!watcher || !watcher.status.alive || !watcher.status.canShoot || watcher.team === moverTeam) continue;
      if (dist(watcher.position, pos) > this.overwatchRadius(watcher)) continue;
      const facing = this.overwatchFacing.get(watcherId);
      if (facing !== undefined) {
        const bearing = Math.atan2(pos.x - watcher.position.x, pos.z - watcher.position.z);
        const delta = Math.abs(Math.atan2(Math.sin(bearing - facing), Math.cos(bearing - facing)));
        if (delta > OVERWATCH_ARC_HALF) continue;
      }
      return true;
    }
    return false;
  }

  // True if standing at `pos` puts sturdy cover between the unit and the threat.
  private isShelteredAt(pos: Vec2, threat: Vec2): boolean {
    return this.entities.some((e) =>
      e.kind === "cover" &&
      e.status.alive &&
      e.height >= 1 &&
      !isVolatileCover(e) &&
      dist(e.position, pos) <= e.radius + 1.1 &&
      coverIsTowardThreat(e.position, pos, threat)
    );
  }

  // A nearby cash cache or an uncaptured resource structure (depot / derelict turret) worth
  // diverting an idle unit to grab — the free economy the AI used to ignore. Ground units only.
  private nearestLoot(actor: CombatEntity): Vec2 | undefined {
    if (actor.flying) return undefined; // flyers can't grab pickups or hold captures
    const SEEK = 13;
    let best: Vec2 | undefined;
    let bestDist = SEEK;
    for (const p of this.pickups) {
      const d = dist(actor.position, p);
      if (d < bestDist) { bestDist = d; best = { x: p.x, z: p.z }; }
    }
    for (const s of this.entities) {
      if (!s.capturable || !s.status.alive || s.team === "enemy") continue; // already ours
      const d = dist(actor.position, s.position);
      if (d < bestDist) { bestDist = d; best = { ...s.position }; }
    }
    return best;
  }

  // The point the enemy army pushes toward, by mode.
  private enemyObjective(): Vec2 | undefined {
    if (this.mode === "hill") return this.modeState.hill;
    if (this.mode === "ctf") return this.modeState.flags.find((f) => f.team === "player")?.pos;
    const playerBase = this.entities.find((e) => e.team === "player" && isBuildingKind(e.kind) && e.status.alive);
    return playerBase?.position;
  }

  // Economy AI for an enemy Home Base: research toward variety, else reinforce with the
  // strongest troop it can currently field.
  private enemyBaseAct(base: CombatEntity): void {
    if (!base.status.alive || base.commandPoints <= 0) return;
    const money = this.money(base.team);
    const smart = this.aiProfile().smartEconomy;
    // What the bot *wants* to field given what the player has on the board (anti-armor when the
    // player rolls vehicles, splash against massed infantry, etc.). Greedy bots ignore this.
    const desired = smart ? this.enemyTroopPreference() : undefined;
    const research = TECH_TREE
      .filter((node) => !this.researchFailureReason(base, node.id))
      .sort((a, b) => a.cost - b.cost);
    // Smart bots research *toward* a doctrine they want a unit from; greedy bots take the cheapest.
    const researchPick = (smart && desired
      ? research.find((node) => desired.some((kind) => troopSpec(kind).tech === node.id))
      : undefined) ?? research[0];
    // SIGNATURE ARC: a smart bot works down its faction's research path, and SAVES for the next step
    // once it has a few units out -- otherwise it spent every turn's money on Recruits and never
    // researched anything, so every faction's bot played the same.
    // Only once it has an army worth the name and is not being out-built: saving for research
    // while outnumbered starved the army, and self-play measured the "smart" economy LOSING to the
    // greedy one 2-10 before this gate.
    const mine = this.fieldUnitCount(base.team);
    const theirs = this.fieldUnitCount(base.team === "enemy" ? "player" : "enemy");
    if (smart && mine >= 4 && mine >= theirs) {
      const path = this.factionOf(base.team).aiTechPath;
      // Next step on the path that is actually open (only money may stand in the way).
      const next = path.find((id) => {
        const why = this.researchFailureReason(base, id);
        return !why || why.startsWith("Not enough money");
      });
      if (next) {
        if (!this.researchFailureReason(base, next) && this.researchTechFor(base, next)) return;
        if (this.fieldUnitCount(base.team) >= 3) return; // save for it
      }
    }
    const hard = this.aiProfile().tactical;
    const incomeCost = incomeUpgradeCost(base);
    // HARD: bank the first income upgrades early -- compounding money is the whole economy game --
    // and never leaves research or income to a coin flip. (Rolls stay where they were for the others.)
    if (hard && incomeCost !== undefined && this.turn <= 8 && money >= incomeCost + 120 && this.upgradeIncomeFor(base)) return;
    if (researchPick && money >= researchPick.cost + 200 && (hard || this.rng.chance(0.45)) && this.researchTechFor(base, researchPick.id)) return;
    if (incomeCost !== undefined && money >= incomeCost + 340 && (hard || this.rng.chance(0.3)) && this.upgradeIncomeFor(base)) return;
    if (this.fieldUnitCount(base.team) >= POP_CAP) return;
    // Save for the most-wanted unit it has unlocked rather than buying the cheapest thing on the
    // list every turn (a Syndicate bot fielded nine Scouts and never a flamer; Vanguard never a tank).
    // Save for the most-wanted unlocked unit only when it is affordable NEXT turn; otherwise spend.
    if (smart && desired && mine >= 3) {
      const want = desired.find((kind) => {
        const why = this.spawnFailureReason(base, kind);
        return !why || why.startsWith("Not enough money");
      });
      if (want && this.spawnFailureReason(base, want)?.startsWith("Not enough money") && money + baseIncome(base) >= troopSpec(want).cost) return;
    }
    const affordable = TROOP_CATALOG.filter((spec) => !this.spawnFailureReason(base, spec.kind));
    if (!affordable.length) return;
    // Build the most-wanted affordable troop; fall back to the strongest the bot can field.
    // The priciest affordable unit ON the wishlist (the wishlist says WHAT, the budget says how much
    // of it); fall back to the priciest thing it can field. Buying the first cheap match every turn
    // was what lost the smart economy to the greedy one.
    // Rank by cost AND wishlist position: the reactive counters at the head of the list (splash vs a
    // crowd, AT vs armour) win unless something much better is affordable further down.
    const rank = (kind: TroopKind): number => Math.max(0.2, 1 - 0.2 * (desired?.indexOf(kind) ?? 0));
    const wanted = affordable.filter((spec) => desired?.includes(spec.kind)).sort((a, b) => b.cost * rank(b.kind) - a.cost * rank(a.kind));
    // Easy buys whatever it lands on; the others buy the best they can.
    const pick = (this.brainOverride ?? this.difficulty) === "easy"
      ? affordable[Math.floor(this.rng.next() * affordable.length)].kind
      : (wanted[0] ?? [...affordable].sort((a, b) => b.cost - a.cost)[0]).kind;
    this.spawnTroopFor(base, pick);
  }

  // Does this unit answer armour? Asked of its STATS, not a hardcoded kind list, so a faction whose
  // anti-armour answer is a unit this function has never heard of still counts. The shape -- an
  // explosive round, sustained fire, or a genuinely heavy gun -- reproduces the old hardcoded set
  // exactly (tank, artillery, heavy, grenadier, mortar) and is asserted to in factionAi.test.ts.
  private answersArmor(entity: CombatEntity): boolean {
    const stats = unitStats(entity.kind);
    // `burst >= 4` stood in for "sustained HEAVY fire". A scattergun is sustained LIGHT fire at
    // knife range, and adding one to the roster made this predicate quietly declare it an answer to
    // armour — which would have made the AI think it was already covered and stop building real
    // ones. Sustained fire only counts as an armour answer if it also has the reach to use it.
    return stats.groundShell || (stats.burst >= 4 && stats.weaponRange >= 14) || stats.shotDamage >= 60;
  }

  // Does this GROUND unit answer aircraft? A dedicated anti-air multiplier, or a flat-trajectory
  // weapon that can actually track a flyer -- precision or volume, but never an arcing shell.
  // Reproduces the old set (flak, heavy, sniper). Aircraft are excluded: owning a fighter is
  // tracked separately as haveAir, and conflating the two stops the AI ever building ground AA.
  private answersAir(entity: CombatEntity): boolean {
    if (isAirKind(entity.kind)) return false;
    if (entity.parts.some((part) => part.role === "weapon" && (part.vsAir ?? 1) > 1 && part.hp > 0)) return true;
    const stats = unitStats(entity.kind);
    // Same reach gate as answersArmor: a weapon that cannot reach 14m cannot engage aircraft,
    // however many rounds it puts out.
    return !stats.groundShell && (stats.shotDamage >= 40 || (stats.burst >= 4 && stats.weaponRange >= 14));
  }

  // Ordered troop wishlist for the enemy commander, reacting to the player's current army.
  // enemyBaseAct deploys the first entry it can afford and has teched, so earlier = higher want.
  private enemyTroopPreference(): TroopKind[] {
    const players = this.fieldUnits("player");
    const playerVehicles = players.filter((p) => isVehicleKind(p.kind)).length;
    const playerInfantry = players.filter((p) => isInfantryKind(p.kind)).length;
    const mine = this.fieldUnits("enemy");
    const faction = this.factionOf("enemy");
    const haveAntiArmor = mine.some((u) => this.answersArmor(u));
    const playerFlyers = players.filter((p) => p.flying).length;
    const haveAntiAir = mine.some((u) => this.answersAir(u));
    const haveAir = mine.some((u) => u.flying);
    const pref: TroopKind[] = [];
    // Contest the air lane: a Flak Track from the ground AND scramble an Interceptor to dogfight
    // enemy aircraft — this is also what finally gives a player gunship a real air-to-air target.
    if (playerFlyers > 0 && !haveAntiAir) pref.push("flak", "heavy", "sniper");
    if (playerFlyers > 0 && !haveAir) pref.push("interceptor", "flak");
    if (playerVehicles > 0 && !haveAntiArmor) pref.push("tank", "heavy", "grenadier", "artillery");
    if (playerInfantry >= 3) pref.push("grenadier", "mortar", "heavy");
    // Round out into a balanced force. The tail is the faction's own doctrine rather than a fixed
    // build order, so each side plays to its roster.
    pref.push(...faction.aiPreference);
    // Every clause above names concrete kinds and a faction need not have them, so drop the ones it
    // cannot field — this keeps the wishlist honest on its own terms. It is not what prevents a
    // stalled turn: enemyBaseAct already intersects this list with what spawnFailureReason actually
    // permits and falls back to the strongest affordable troop, so an empty result is handled there.
    return [...new Set(pref)].filter((kind) => faction.roster.includes(kind));
  }

  // Collision-aware step for AI units: try the direct line, then sidestep around
  // obstacles, returning the reachable destination closest to the goal.
  private navigateToward(actor: CombatEntity, goal: Vec2, step: number): Vec2 {
    const start = actor.position;
    const directDesired = clampToArena(moveToward(start, goal, step));
    const direct = this.blockedMoveDestination(actor, start, directDesired, undefined, true);
    if (dist(start, direct) >= step * 0.55) return direct;
    let best = direct;
    let bestScore = dist(direct, goal);
    const baseAngle = Math.atan2(goal.x - start.x, goal.z - start.z);
    for (const offset of [0.5, -0.5, 0.9, -0.9, 1.4, -1.4]) {
      const angle = baseAngle + offset;
      const candidate = clampToArena({
        x: start.x + Math.sin(angle) * step,
        z: start.z + Math.cos(angle) * step,
      });
      const reachable = this.blockedMoveDestination(actor, start, candidate, undefined, true);
      if (dist(start, reachable) < step * 0.35) continue;
      const score = dist(reachable, goal);
      if (score < bestScore) {
        bestScore = score;
        best = reachable;
      }
    }
    return best;
  }

  private finishResolve(): void {
    this.orders.splice(0);
    this.projectiles.splice(0);
    this.defending.clear();
    this.overwatching.clear(); // unspent reaction shots expire with the resolve
    this.overwatchFacing.clear();
    this.strikeDeflected.clear(); // next volley may report a deflection again
    this.refreshDefendingStances();
    this.finalizeTurnReport();
    // An elimination win/loss this turn takes precedence — don't also tick objectives.
    if (this.gameOver) return;
    this.resolveModeObjectives(); // may set victory/defeat by score
    if (this.gameOver) return;
    this.turn += 1;
    this.phase = "command";
    this.resolveClock = 0;
    this.runDownedTick();
    for (const entity of this.entities) {
      repairForNewTurn(entity);
      if (entity.markedUntilTurn !== undefined && entity.markedUntilTurn < this.turn) {
        entity.markedUntilTurn = undefined;
        entity.markedById = undefined;
      }
      if (entity.suppressedUntilTurn !== undefined) {
        if (entity.suppressedUntilTurn >= this.turn && entity.status.alive) {
          entity.commandPoints = Math.min(entity.commandPoints, 1);
          if (isInfantryKind(entity.kind)) { entity.stance = "crouched"; this.defending.add(entity.id); }
        } else {
          entity.suppressedUntilTurn = undefined;
        }
      }
    }
    this.runEconomyTick();
    this.runSalvageTick();
    this.runCaptureTick();
    this.runBurnTick();
    this.runGasTick();
    this.runSmokeTick();
    this.resolveSupportAuras();
    // Forced events are single-turn debug overrides; clear them, then announce the new turn's events.
    this.forcedZones = [];
    this.forcedSandstorm = false;
    this.forcedIonStorm = false;
    this.refreshEventNotice();
    this.applyIonStormClamp(); // scramble command points if an ion storm is raking the field
    this.pushLog(`Turn ${this.turn} command phase`);
    this.seatLogMark = this.logSeq;
    this.bus.emit("TURN_START", { turn: this.turn });
  }

  // Objective scoring for the active mode, evaluated on final end-of-turn positions.
  private resolveModeObjectives(): void {
    if (this.mode === "ctf") this.resolveCtf();
    else if (this.mode === "hill") this.resolveHill();
    else if (this.mode === "domination") this.resolveDomination();
    else if (this.mode === "survival" && this.turn >= this.modeState.target) {
      this.phase = "victory";
      this.pushLog(`You survived all ${this.modeState.target} rounds — the line held!`);
    }
  }

  // Domination: each of the three sectors banks a point per round for whichever side
  // holds it uncontested. First to the target wins.
  private resolveDomination(): void {
    const s = this.modeState;
    if (!s.hills) return;
    const radius = Math.max(3.0, s.hillRadius * 0.8);
    s.hillHolders = s.hills.map((sector, index) => {
      const playerHeld = this.fieldUnits("player").some((e) => dist(e.position, sector) <= radius);
      const enemyHeld = this.fieldUnits("enemy").some((e) => dist(e.position, sector) <= radius);
      if (playerHeld && !enemyHeld) {
        s.playerScore += 1;
        return "player";
      }
      if (enemyHeld && !playerHeld) {
        s.enemyScore += 1;
        return "enemy";
      }
      return playerHeld && enemyHeld ? undefined : s.hillHolders?.[index];
    });
    if (s.playerScore >= s.target) {
      this.phase = "victory";
      this.pushLog("Sectors dominated — victory!");
    } else if (s.enemyScore >= s.target) {
      this.phase = "defeat";
      this.pushLog("The enemy dominates the sectors — defeat.");
    } else {
      this.pushLog(`Sector score ${s.playerScore}–${s.enemyScore} of ${s.target}`);
    }
  }

  // Last Stand: spawn an escalating assault wave at the enemy map edge every other turn.
  private spawnSurvivalWave(): void {
    const wave = Math.ceil(this.turn / 2);
    const count = Math.min(6, 1 + wave);
    const ladder: TroopKind[] = ["soldier", "scout", "heavy", "striker", "grenadier", "sniper", "apc", "tank", "mortar", "artillery"];
    const pool = ladder.slice(0, Math.min(ladder.length, 2 + wave));
    const bounds = this.mapDef.terrain.bounds;
    for (let i = 0; i < count; i += 1) {
      const kind = pool[Math.floor(this.rng.range(0, pool.length)) % pool.length];
      const z = this.rng.range(bounds.minZ + 3, bounds.maxZ - 3);
      const unit = makeTroop(kind, `e-wave-${++this.troopSeq}`, `${troopSpec(kind).label} ${this.troopSeq}`, "enemy", clampToArena({ x: bounds.maxX - 2.5, z }));
      scaleEntityHp(unit, DIFFICULTY_MODS[this.difficulty].enemyHp);
      unit.commandPoints = 0; // arrives braced; acts next turn
      this.entities.push(unit);
      this.syncEntityElevation(unit);
    }
    this.effect("ping", { x: bounds.maxX - 2.5, z: 0 }, { x: bounds.maxX - 2.5, z: 0 }, 0xff765f, 1.0, 4);
    this.pushLog(`Wave ${wave} inbound — ${count} hostiles hit the east edge`);
  }

  // ---- Dynamic map events ---------------------------------------------------------------
  // All of this derives purely from the map config + current turn (plus single-turn debug
  // overrides), so it survives save/load for free and stays deterministic.

  private mapEvents(): readonly MapEventConfig[] {
    return this.mapDef.events ?? [];
  }

  // Whether reduced-accuracy sandstorm weather is in effect on a given turn.
  // Environmental forecast for the HUD bar: event kinds active now and over the next
  // `horizon` turns, so storms and barrages are plans instead of surprises.
  forecast(horizon = 2): { turn: number; kinds: MapEventKind[] }[] {
    const out: { turn: number; kinds: MapEventKind[] }[] = [];
    for (let offset = 0; offset <= horizon; offset += 1) {
      const t = this.turn + offset;
      const kinds: MapEventKind[] = [];
      if (this.sandstormActive(t)) kinds.push("sandstorm");
      if (this.ionStormActive(t)) kinds.push("ionstorm");
      for (const zone of this.eventZonesForTurn(t)) if (!kinds.includes(zone.kind)) kinds.push(zone.kind);
      out.push({ turn: t, kinds });
    }
    return out;
  }

  sandstormActive(turn: number = this.turn): boolean {
    return this.forcedSandstorm || this.mapEvents().some((e) => e.kind === "sandstorm" && eventOccursWindow(e, turn));
  }

  // Whether a command-scrambling ion storm is in effect on a given turn (clamps units to 1 CP).
  ionStormActive(turn: number = this.turn): boolean {
    return this.forcedIonStorm || this.mapEvents().some((e) => e.kind === "ionstorm" && eventOccursWindow(e, turn));
  }

  // Ion storm: every field unit (not bases) is scrambled down to a single command point.
  private applyIonStormClamp(): void {
    if (!this.ionStormActive()) return;
    for (const entity of this.entities) {
      if (entity.status.alive && entity.kind !== "base") entity.commandPoints = Math.min(entity.commandPoints, 1);
    }
  }

  private eventZone(e: MapEventConfig): { x: number; z: number; radius: number } {
    if (e.zone) return e.zone;
    const c = mapCenter(this.mapDef);
    return { x: c.x, z: c.z, radius: 6 };
  }

  // Barrage/collapse danger zones that fire during the given turn's resolve (for renderer rings).
  eventZonesForTurn(turn: number = this.turn): { kind: MapEventKind; x: number; z: number; radius: number }[] {
    const fromMap = this.mapEvents()
      .filter((e) => (e.kind === "barrage" || e.kind === "collapse" || e.kind === "lightning" || e.kind === "slag") && eventOccursWindow(e, turn))
      .map((e) => ({ kind: e.kind, ...(e.kind === "lightning" ? this.lightningZone(turn) : e.kind === "slag" ? this.slagZone(e, turn) : this.eventZone(e)) }));
    return [...fromMap, ...this.forcedZones];
  }

  // The slag spill alternates furnaces: every other occurrence floods the mirrored corner, so
  // neither side's foundry floor is permanently safe. Pure function of the turn (telegraph ==
  // strike == restored save).
  private slagZone(e: MapEventConfig, turn: number): { x: number; z: number; radius: number } {
    const zone = this.eventZone(e);
    const occurrence = Math.floor((turn - e.startTurn) / Math.max(1, e.period ?? 1));
    return occurrence % 2 ? { x: -zone.x, z: -zone.z, radius: zone.radius } : zone;
  }

  // Where the storm strikes this turn: somewhere new every turn, but a pure function of the map
  // and the turn number, so the telegraph the player sees during command is exactly where the
  // bolt lands during resolve and a restored save agrees with itself. Never on a base.
  private lightningZone(turn: number): { x: number; z: number; radius: number } {
    const b = this.mapDef.terrain.bounds;
    let seed = ((this.mapDef.seed ^ (turn * 0x9e3779b1)) >>> 0) || 1;
    const next = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const x = b.minX + 4 + next() * (b.maxX - b.minX - 8);
      const z = b.minZ + 3 + next() * (b.maxZ - b.minZ - 6);
      const nearBase = this.entities.some((e) => e.kind === "base" && dist(e.position, { x, z }) < 7);
      if (!nearBase) return { x, z, radius: LIGHTNING_RADIUS };
    }
    const c = mapCenter(this.mapDef);
    return { x: c.x, z: c.z, radius: LIGHTNING_RADIUS };
  }

  // Read-only environment snapshot for the renderer + HUD.
  environment(): { sandstorm: number; ionstorm: number; notice?: string; zones: { kind: MapEventKind; x: number; z: number; radius: number }[] } {
    return { sandstorm: this.sandstormActive() ? 1 : 0, ionstorm: this.ionStormActive() ? 1 : 0, notice: this.eventNotice, zones: this.eventZonesForTurn() };
  }

  // Set the banner/log for the new turn's events (and announce sandstorm transitions).
  private refreshEventNotice(): void {
    const t = this.turn;
    let notice: string | undefined;
    const stormNow = this.sandstormActive(t);
    const stormPrev = t > 1 && this.sandstormActive(t - 1);
    if (stormNow && !stormPrev) {
      this.pushLog("A sandstorm rolls in — fire is far less accurate until it clears.");
      notice = "⚠ Sandstorm — fire is far less accurate until it clears.";
    } else if (!stormNow && stormPrev) {
      this.pushLog("The sandstorm clears.");
    } else if (stormNow) {
      notice = "⚠ Sandstorm — fire is far less accurate.";
    }
    const ionNow = this.ionStormActive(t);
    const ionPrev = t > 1 && this.ionStormActive(t - 1);
    if (ionNow && !ionPrev) {
      this.pushLog("An ion storm scrambles command links — units are limited to one command point.");
      notice = "⚠ Ion storm — units are scrambled to a single command point.";
    } else if (ionNow) {
      notice = "⚠ Ion storm — units limited to one command point.";
    }
    const zones = this.eventZonesForTurn(t);
    if (zones.some((z) => z.kind === "barrage")) {
      this.pushLog("Incoming artillery barrage — clear the marked zone!");
      notice = "⚠ Incoming barrage — clear the marked zone before you end your turn.";
    }
    if (zones.some((z) => z.kind === "collapse")) {
      this.pushLog("Structures in the marked zone are about to collapse.");
      notice = notice ?? "⚠ Cover in the marked zone collapses this turn.";
    }
    if (zones.some((z) => z.kind === "slag")) {
      this.pushLog("The furnaces are venting — molten slag will flood the marked zone this turn.");
      notice = notice ?? "⚠ Slag spill — the marked zone floods and burns this turn.";
    }
    if (zones.some((z) => z.kind === "lightning")) {
      this.pushLog("The storm is building — lightning will strike the marked point this turn.");
      notice = notice ?? "⚠ Lightning strikes the marked point this turn — stay clear of it.";
    }
    if (!notice) {
      if (this.sandstormActive(t + 1) && !stormNow) notice = "A sandstorm is approaching next turn.";
      else if (this.eventZonesForTurn(t + 1).some((z) => z.kind === "barrage")) notice = "Artillery is ranging in — a barrage hits next turn.";
    }
    this.eventNotice = notice;
  }

  // At end-of-turn, turn this turn's barrage/collapse zones into staggered detonations that
  // play out during the resolve animation (so shells visibly walk across the zone).
  private scheduleMapStrikes(): void {
    this.pendingStrikes = [];
    this.strikeClock = 0;
    for (const zone of this.eventZonesForTurn(this.turn)) {
      if (zone.kind === "barrage") {
        for (let i = 0; i < 6; i += 1) {
          const angle = this.rng.range(0, Math.PI * 2);
          const r = Math.sqrt(this.rng.range(0, 1)) * zone.radius; // uniform across the disc
          const point = clampToArena({ x: zone.x + Math.sin(angle) * r, z: zone.z + Math.cos(angle) * r });
          this.pendingStrikes.push({ at: 0.25 + i * 0.26, point, radius: 2.6, damage: 34, kind: "barrage" });
        }
      } else if (zone.kind === "slag") {
        const power = this.mapEvents().find((e) => e.kind === "slag")?.power ?? 18;
        this.pendingStrikes.push({ at: 0.45, point: { x: zone.x, z: zone.z }, radius: zone.radius, damage: power, kind: "slag" });
      } else if (zone.kind === "lightning") {
        const power = this.mapEvents().find((e) => e.kind === "lightning")?.power ?? 46;
        this.pendingStrikes.push({ at: 0.6, point: { x: zone.x, z: zone.z }, radius: zone.radius, damage: power, kind: "lightning" });
      } else {
        const covers = this.entities.filter((e) => e.kind === "cover" && e.status.alive && dist(e.position, zone) <= zone.radius);
        covers.forEach((c, i) => this.pendingStrikes.push({ at: 0.25 + i * 0.2, point: { ...c.position }, radius: 1.7, damage: 999, kind: "collapse" }));
      }
    }
  }

  private updateMapStrikes(dt: number): void {
    if (!this.pendingStrikes.length && !this.pendingFx.length) return;
    this.strikeClock += dt;
    for (const fx of this.pendingFx) {
      if (fx.fired || this.strikeClock < fx.at) continue;
      fx.fired = true;
      this.effect(fx.type, fx.from, fx.to, fx.color, fx.duration, fx.radius);
    }
    this.pendingFx = this.pendingFx.filter((fx) => !fx.fired);
    let detonated = false;
    for (const strike of this.pendingStrikes) {
      if (strike.fired || this.strikeClock < strike.at) continue;
      strike.fired = true;
      detonated = true;
      this.detonateStrike(strike);
    }
    if (detonated) this.pendingStrikes = this.pendingStrikes.filter((s) => !s.fired);
  }

  // A single environmental detonation: a blast effect plus AoE damage to anything in range
  // (both teams — it's the battlefield, not a unit's attack). Bases are spared so the sky can't
  // hand someone the win.
  private detonateStrike(strike: { point: Vec2; radius: number; damage: number; kind: StrikeKind }): void {
    if (strike.kind === "lightning") {
      // The bolt: a beam effect from the sky to the point, then the blast. Sets gas off like any
      // other blast, and the ground burns briefly where it lands.
      this.effect("bolt", strike.point, strike.point, 0xd8ecff, 0.45, 0.4);
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: strike.point.x, z: strike.point.z, radius: 1.2, turnsLeft: 1 });
    }
    if (strike.kind === "slag") {
      // The spill leaves the floor burning for two turns (the flamer's burn zone, so the tick,
      // the render and the AI's fear of fire all come for free).
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: strike.point.x, z: strike.point.z, radius: strike.radius * 0.85, turnsLeft: 2 });
    }
    const color = strike.kind === "lightning" ? 0xd8ecff
      : strike.kind === "slag" ? 0xff7a2a
      : strike.kind === "barrage" ? 0xffac5a
      : strike.kind === "collapse" ? 0xb59a72
      : strike.kind === "laser" ? 0xff5a4d
      : strike.kind === "cluster" ? 0xffb02e
      : 0xff8c3a;
    this.effect("blast", strike.point, strike.point, color, 0.85, strike.radius);
    for (const e of this.entities) {
      if (!e.status.alive || e.flying) continue; // flyers ride above the strike plane
      // Hardened HQs shrug off strikes by design — but flash a shield + log it once per volley so
      // the strike never reads as a broken no-op ("I bombed the base and nothing happened").
      if (e.kind === "base") {
        if (dist(e.position, strike.point) <= strike.radius + e.radius * 0.5) {
          this.effect("ping", { ...e.position }, { ...e.position }, 0x8fd0ff, 0.75, e.radius + 1.1);
          if (!this.strikeDeflected.has(e.id)) {
            this.strikeDeflected.add(e.id);
            this.pushLog(`${e.name} weathers the strike — hardened HQ, no damage.`);
          }
        }
        continue;
      }
      const d = dist(e.position, strike.point);
      if (d > strike.radius + e.radius * 0.5) continue;
      const part = preferredPart(e, "center");
      const falloff = clamp01(1 - d / (strike.radius + 0.6));
      const damage = strike.kind === "collapse" ? strike.damage : Math.max(8, Math.round(strike.damage * Math.max(0.4, falloff)));
      applyDamage(e, part.id, damage);
    }
    // Environmental events log per shell (they threaten a marked zone); support strikes
    // logged once when tasked, so a 8-bomb cluster doesn't spam the feed.
    if (strike.kind === "barrage") this.pushLog("Shells hammer the marked zone.");
    else if (strike.kind === "collapse") this.pushLog("Cover collapses in the marked zone.");
    else if (strike.kind === "lightning") this.pushLog("Lightning strikes the marked point!");
    else if (strike.kind === "slag") this.pushLog("Molten slag floods the foundry floor!");
  }

  // Debug/test hook: force an environmental event onto the current turn (for screenshots/tests).
  debugForceEvent(kind: MapEventKind, zone?: { x: number; z: number; radius: number }): void {
    if (kind === "sandstorm") this.forcedSandstorm = true;
    else if (kind === "ionstorm") { this.forcedIonStorm = true; this.applyIonStormClamp(); }
    else this.forcedZones.push({ kind, ...(zone ?? this.eventZone({ kind, startTurn: this.turn })) });
    this.refreshEventNotice();
  }

  private fieldUnits(team: Team): CombatEntity[] {
    return this.entities.filter((e) => e.status.alive && e.team === team && !isBuildingKind(e.kind) && !isDefenseKind(e.kind) && e.kind !== "cover");
  }

  private resolveHill(): void {
    const s = this.modeState;
    const inZone = (team: Team): number => this.fieldUnits(team).filter((e) => dist(e.position, s.hill) <= s.hillRadius).length;
    const playerHeld = inZone("player");
    const enemyHeld = inZone("enemy");
    if (playerHeld > 0 && enemyHeld === 0) {
      s.playerScore += 1;
      s.hillHolder = "player";
      this.pushLog(`${this.sideName("player", "You")} hold${this.hotseat ? "s" : ""} the hill (${s.playerScore}/${s.target})`);
    } else if (enemyHeld > 0 && playerHeld === 0) {
      s.enemyScore += 1;
      s.hillHolder = "enemy";
      this.pushLog(`${this.sideName("enemy", "Enemy")} holds the hill (${s.enemyScore}/${s.target})`);
    } else {
      s.hillHolder = playerHeld > 0 && enemyHeld > 0 ? undefined : s.hillHolder;
      if (playerHeld === 0 && enemyHeld === 0) s.hillHolder = undefined;
    }
    if (s.playerScore >= s.target) {
      this.phase = "victory";
      this.pushLog(this.hotseat ? "Player 1 secures the hill and wins" : "Hill secured — victory!");
    } else if (s.enemyScore >= s.target) {
      this.phase = "defeat";
      this.pushLog(this.hotseat ? "Player 2 secures the hill and wins" : "Enemy held the hill — defeat.");
    }
  }

  private resolveCtf(): void {
    const s = this.modeState;
    const grab = 1.7;
    // Carried flags follow their carrier; drop at the carrier's spot if it falls.
    for (const flag of s.flags) {
      if (!flag.carrierId) continue;
      const carrier = this.entity(flag.carrierId);
      if (!carrier || !carrier.status.alive) {
        if (carrier) flag.pos = { ...carrier.position };
        flag.carrierId = undefined;
        flag.droppedTurns = 0;
        this.pushLog(`A flag carrier fell — the flag drops`);
      } else {
        flag.pos = { ...carrier.position };
      }
    }
    // Owning team returns its dropped flag by reaching it; a long-abandoned flag also
    // auto-returns so the mode can never soft-lock.
    for (const flag of s.flags) {
      if (flag.carrierId || dist(flag.pos, flag.home) <= 0.5) {
        flag.droppedTurns = 0;
        continue;
      }
      const returner = this.fieldUnits(flag.team).find((e) => dist(e.position, flag.pos) <= grab);
      flag.droppedTurns = (flag.droppedTurns ?? 0) + 1;
      if (returner || flag.droppedTurns >= 4) {
        flag.pos = { ...flag.home };
        flag.droppedTurns = 0;
        this.pushLog(`${this.hotseat ? `Player ${this.seatOf(flag.team)}'s` : flag.team === "player" ? "Your" : "Enemy"} flag is returned home`);
      }
    }
    // The opposing team grabs an unguarded flag.
    for (const flag of s.flags) {
      if (flag.carrierId) continue;
      const thief: Team = flag.team === "player" ? "enemy" : "player";
      const grabber = this.fieldUnits(thief).find((e) => dist(e.position, flag.pos) <= grab);
      if (grabber) {
        flag.carrierId = grabber.id;
        flag.pos = { ...grabber.position };
        this.pushLog(`${grabber.name} steals the ${this.hotseat ? `Player ${this.seatOf(flag.team)}` : flag.team === "player" ? "allied" : "enemy"} flag!`);
      }
    }
    const playerFlag = s.flags.find((f) => f.team === "player")!;
    const enemyFlag = s.flags.find((f) => f.team === "enemy")!;
    this.tryCapture(enemyFlag, playerFlag, "player");
    this.tryCapture(playerFlag, enemyFlag, "enemy");
    if (s.playerScore >= s.target) {
      this.phase = "victory";
      this.pushLog(this.hotseat ? "Player 1 wins on flag captures" : "Flag captured — victory!");
    } else if (s.enemyScore >= s.target) {
      this.phase = "defeat";
      this.pushLog(this.hotseat ? "Player 2 wins on flag captures" : "Enemy captured your flag — defeat.");
    }
  }

  // A carrier scores when it reaches its own flag's home while that flag is safe at home.
  private tryCapture(carried: FlagState, ownFlag: FlagState, scorer: Team): void {
    if (!carried.carrierId) return;
    const carrier = this.entity(carried.carrierId);
    if (!carrier) return;
    const ownHome = !ownFlag.carrierId && dist(ownFlag.pos, ownFlag.home) <= 0.5;
    if (ownHome && dist(carrier.position, ownFlag.home) <= 2.4) {
      if (scorer === "player") this.modeState.playerScore += 1;
      else this.modeState.enemyScore += 1;
      carried.carrierId = undefined;
      carried.pos = { ...carried.home };
      const score = scorer === "player" ? this.modeState.playerScore : this.modeState.enemyScore;
      this.pushLog(`${this.hotseat ? `Player ${this.seatOf(scorer)} captures` : scorer === "player" ? "You capture" : "Enemy captures"} the flag (${score}/${this.modeState.target})`);
    }
  }

  // Medics heal nearby infantry; engineers repair nearby vehicles and bases each round. The
  // heal is shown to the player with a green aura pulse on the medic and a tick on each ally.
  private resolveSupportAuras(): void {
    for (const source of this.entities) {
      if (!source.status.alive) continue;
      const heals = source.parts.some((p) => p.hp > 0 && p.tags?.includes("medic-aura"));
      const repairs = source.parts.some((p) => p.hp > 0 && p.tags?.includes("repair-aura"));
      if (!heals && !repairs) continue;
      let mended = 0;
      const eff = this.teamTech(source.team);
      for (const ally of this.entities) {
        if (ally.team !== source.team || ally.id === source.id || !ally.status.alive) continue;
        if (dist(ally.position, source.position) > 4.5) continue;
        let healed = false;
        if (heals && isInfantryKind(ally.kind)) healed = this.healEntity(ally, 8 + eff.healBonus);
        if (repairs && (isVehicleKind(ally.kind) || isBuildingKind(ally.kind))) healed = this.healEntity(ally, 12 + eff.repairBonus) || healed;
        if (healed) {
          this.effect("ping", ally.position, ally.position, 0x8effa6, 0.9, ally.radius + 0.5);
          mended += 1;
        }
      }
      if (mended > 0) {
        this.effect("blast", source.position, source.position, 0x8effa6, 0.7, 4.5);
        this.pushLog(`${source.name}'s ${heals ? "field aura heals" : "repair rig mends"} ${mended} ${mended === 1 ? "ally" : "allies"}`);
      }
    }
  }

  private healEntity(entity: CombatEntity, amount: number): boolean {
    const damaged = entity.parts
      .filter((p) => p.hp > 0 && p.hp < p.maxHp)
      .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
    if (!damaged) return false;
    damaged.hp = Math.min(damaged.maxHp, damaged.hp + amount);
    recomputeStatus(entity);
    return true;
  }

  private runEconomyTick(): void {
    // Held supply depots pay their owner every turn.
    for (const depot of this.entities) {
      if (depot.coverKind !== "depot" || !depot.status.alive) continue;
      if (depot.team !== "player" && depot.team !== "enemy") continue;
      this.addMoney(depot.team, DEPOT_INCOME);
    }
    for (const entity of this.entities) {
      if (!entity.status.alive || entity.kind !== "base") continue;
      // Home Base income, scaled by reactor health, upgrade level, and (for the bot) difficulty.
      const difficultyScale = entity.team === "enemy" ? DIFFICULTY_MODS[this.difficulty].enemyIncome : 1;
      const income = Math.round(baseIncome(entity) * difficultyScale);
      if (income > 0) this.addMoney(entity.team, income);
      // Tick down this base's per-troop deployment cooldowns.
      if (entity.spawnCooldowns) {
        for (const key of Object.keys(entity.spawnCooldowns) as TroopKind[]) {
          const remaining = (entity.spawnCooldowns[key] ?? 0) - 1;
          if (remaining > 0) entity.spawnCooldowns[key] = remaining;
          else delete entity.spawnCooldowns[key];
        }
      }
      // Tick down this base's support-power cooldowns the same way.
      if (entity.supportCooldowns) {
        for (const key of Object.keys(entity.supportCooldowns)) {
          const remaining = (entity.supportCooldowns[key] ?? 0) - 1;
          if (remaining > 0) entity.supportCooldowns[key] = remaining;
          else delete entity.supportCooldowns[key];
        }
      }
    }
  }

  private checkEndState(): void {
    // Last Stand has no enemy base: clearing a wave is breathing room, not victory.
    if (this.mode !== "survival" && !factionLiving(this.entities, "enemy").length) {
      this.phase = "victory";
      this.pushLog(this.hotseat ? "Player 2's force is disabled — Player 1 wins" : "Enemy force disabled");
    } else if (!factionLiving(this.entities, "player").length) {
      this.phase = "defeat";
      this.pushLog(this.hotseat ? "Player 1's force is disabled — Player 2 wins" : "Player force disabled");
    }
  }

  private requirePlayerActor(): CombatEntity | undefined {
    if (this.phase !== "command") {
      this.reject("Orders can only be queued during command phase");
      return undefined;
    }
    const actor = this.selected;
    if (!actor || actor.team !== "player") {
      this.reject("Select a player unit first");
      return undefined;
    }
    if (!actor.status.alive) {
      this.reject(`${actor.name} is disabled`);
      return undefined;
    }
    return actor;
  }

  private reject(text: string): false {
    this.pushLog(text);
    return false;
  }

  private pushLog(text: string): void {
    this.logSeq += 1;
    this.log.unshift(text);
    if (this.activeTurnReport && this.phase === "resolve") {
      this.activeTurnReport.notes.unshift(text);
      if (this.activeTurnReport.notes.length > 28) this.activeTurnReport.notes.pop();
    }
    if (this.log.length > 24) this.log.pop();
    this.bus.emit("LOG", { text });
  }

  private recordDamage(actor: CombatEntity, target: CombatEntity, result: DamageResult, source?: string): void {
    // Veterancy: credit player units with enemy unit kills (structures/cover excluded).
    if (result.killed && actor.team === "player" && target.team === "enemy" && target.kind !== "cover" && !isBuildingKind(target.kind)) {
      this.killsBy.set(actor.id, (this.killsBy.get(actor.id) ?? 0) + 1);
    }
    if (
      target.team === "player" && !target.status.alive && target.kind !== "cover" &&
      !isBuildingKind(target.kind) && !isDefenseKind(target.kind) && !this.countedDead.has(target.id)
    ) {
      this.countedDead.add(target.id);
      this.playerLosses += 1;
    }
    if (!this.activeTurnReport || result.amount <= 0) return;
    const part = target.parts.find((candidate) => candidate.id === result.partId);
    const partLabel = part?.label ?? result.partId;
    this.activeTurnReport.entries.push({
      id: `damage-${++this.damageSeq}`,
      actorName: actor.name,
      actorId: actor.id,
      targetName: target.name,
      targetId: target.id,
      targetTeam: target.team,
      partId: result.partId,
      partLabel,
      amount: result.amount,
      remainingHp: Math.max(0, part?.hp ?? 0),
      maxHp: part?.maxHp ?? Math.max(1, result.amount),
      killed: result.killed,
      destroyed: result.destroyed,
      source,
    });

    const color = target.team === "player" ? 0x7fe8ff : target.team === "enemy" ? 0xffd166 : 0xffbf69;
    this.effect("ping", target.position, target.position, color, 1.25, target.radius + 0.55);
  }

  private finalizeTurnReport(): void {
    if (!this.activeTurnReport) return;
    this.activeTurnReport.phase = "complete";
    this.turnReports.unshift(this.activeTurnReport);
    if (this.turnReports.length > 6) this.turnReports.pop();
    this.activeTurnReport = undefined;
  }

  private effect(type: VisualEvent["type"], from: Vec2, to: Vec2, color: number, duration: number, radius?: number): void {
    // A blast is a spark. Every explosion in the game goes through here, so this is the one place
    // that has to know about gas; the cloud's own detonation is a blast too, which is how one
    // canister sets off the next.
    if (type === "blast" && this.gasClouds.length) this.igniteGasAt(to, radius ?? 1);
    this.effects.push({
      id: `effect-${++this.effectSeq}`,
      type,
      from: { ...from },
      to: { ...to },
      color,
      duration,
      radius,
      age: 0,
    });
  }
}

// Scale every part's health by a multiplier (used for bot difficulty). 1 is a no-op.
function scaleEntityHp(entity: CombatEntity, multiplier: number): void {
  if (multiplier === 1) return;
  for (const part of entity.parts) {
    part.maxHp = Math.round(part.maxHp * multiplier);
    part.hp = part.maxHp;
  }
  recomputeStatus(entity);
}

function makeTroop(kind: TroopKind, id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const unit = makeTroopBase(kind, id, name, team, position);
  scaleEntityHp(unit, tierHpMultiplier(unit.kind));
  return unit;
}

function makeTroopBase(kind: TroopKind, id: string, name: string, team: Team, position: Vec2): CombatEntity {
  switch (kind) {
    case "tank": return createTank(id, name, team, position);
    case "apc": return createApc(id, name, team, position);
    case "artillery": return createArtillery(id, name, team, position);
    case "gunship": return createGunship(id, name, team, position);
    case "interceptor": return createInterceptor(id, name, team, position);
    case "bomber": return createBomber(id, name, team, position);
    case "transport": return createTransport(id, name, team, position);
    case "flak": return createFlak(id, name, team, position);
    case "scout": return createScout(id, name, team, position);
    case "sniper": return createSniper(id, name, team, position);
    case "striker": return createStriker(id, name, team, position);
    case "heavy": return createHeavy(id, name, team, position);
    case "grenadier": return createGrenadier(id, name, team, position);
    case "mortar": return createMortar(id, name, team, position);
    case "medic": return createMedic(id, name, team, position);
    case "engineer": return createEngineer(id, name, team, position);
    case "flamer": return createFlamer(id, name, team, position);
    case "droneop": return createDroneOp(id, name, team, position);
    case "jumper": return createJumper(id, name, team, position);
    case "sapper": return createSapper(id, name, team, position);
    default: return createSoldier(id, name, team, position);
  }
}

// Global mobility boost: every unit covers much more ground per order so the (now larger) maps
// don't turn into slow marches. Applied to both range AND animation speed, so a longer move still
// resolves in the same wall-clock time. Base per-kind values below stay the tuning surface.
export const MOVE_RANGE_SCALE = 2.0;

function moveRange(entity: CombatEntity): number {
  return baseMoveRange(entity) * MOVE_RANGE_SCALE;
}

function baseMoveRange(entity: CombatEntity): number {
  return unitStats(entity.kind).moveRange;
}

function defenseRadius(kind: DefenseKind): number {
  if (kind === "wall") return 1.15;
  if (kind === "exturret") return 1.0;
  return 0.95;
}

function ramRange(entity: CombatEntity): number {
  return unitStats(entity.kind).ramRange;
}

/** Jet-jump mover with an intact pack: its moves are arcs, not walks. */
function canJump(entity: CombatEntity): boolean {
  return Boolean(unitStats(entity.kind).jump) && entity.parts.some((p) => p.id === "pack" && p.hp > 0);
}

function meleeRange(entity: CombatEntity): number {
  return unitStats(entity.kind).meleeRange + (entity.kind === "striker" ? STRIKER_CHARGE : 0);
}

// Strikers hit at full melee power; other infantry only rifle-butt for a fraction, so melee
// stays a finisher for them rather than a replacement for shooting.
function meleeStrikeMultiplier(entity: CombatEntity): number {
  return unitStats(entity.kind).meleeMultiplier;
}

function grenadeThrowRange(entity: CombatEntity): number {
  return unitStats(entity.kind).grenadeRange;
}

function canUseHandGrenade(entity: CombatEntity): boolean {
  return (entity.kind === "soldier" || entity.kind === "gunship" || entity.kind === "bomber") && entity.status.alive && entity.grenades > 0;
}

// Aircraft that bomb (gunship, and later the Bomber): their bomb falls STRAIGHT DOWN from the
// aircraft instead of being lobbed at a distant point, so it's aimed by flying over the target.
/** Kinds that can take ground units aboard: the air transport and the APC. */
function isCarrierKind(kind: EntityKind): boolean {
  return kind === "transport" || kind === "apc";
}

function isAirBomber(entity: CombatEntity): boolean {
  return entity.flying === true && grenadeThrowRange(entity) > 0;
}

function limitMoveDestination(entity: CombatEntity, start: Vec2, destination: Vec2): Vec2 {
  const range = moveRange(entity);
  if (range <= 0) return { ...start };
  return moveToward(start, destination, range);
}

function muzzlePoint(entity: CombatEntity, attackMode: AttackMode = "weapon"): Vec2 {
  if (attackMode === "grenade") return localPoint(entity, { x: 0.5, z: 0.3 });
  if (isVehicleKind(entity.kind)) return localPoint(entity, { x: 0, z: 1.65 });
  if (entity.kind === "sniper") return localPoint(entity, { x: 0.5, z: 0.72 });
  if (entity.kind === "grenadier" || entity.kind === "mortar") return localPoint(entity, { x: 0.46, z: 0.58 });
  if (isInfantryKind(entity.kind)) return localPoint(entity, { x: 0.42, z: 0.4 });
  if (entity.kind === "turret" || entity.kind === "exturret") return localPoint(entity, { x: 0, z: 0.62 });
  if (entity.kind === "base") return localPoint(entity, { x: 0.2, z: 1.28 });
  return { ...entity.position };
}

function muzzleHeight(entity: CombatEntity, attackMode: AttackMode = "weapon"): number {
  if (attackMode === "grenade") return entity.elevation + stanceMuzzleHeight(entity, 1.18);
  if (isVehicleKind(entity.kind)) return entity.elevation + 1.2;
  if (entity.kind === "sniper") return entity.elevation + stanceMuzzleHeight(entity, 1.12);
  if (entity.kind === "grenadier" || entity.kind === "mortar") return entity.elevation + stanceMuzzleHeight(entity, 1.02);
  if (isInfantryKind(entity.kind)) return entity.elevation + stanceMuzzleHeight(entity, 1.05);
  if (entity.kind === "turret" || entity.kind === "exturret") return entity.elevation + 1.2;
  if (entity.kind === "base") return entity.elevation + 1.75;
  return entity.elevation + Math.max(0.22, entity.height * 0.55);
}

function aimPointFor(entity: CombatEntity, part: DamagePart): Vec2 {
  return localPoint(entity, partAimOffset(entity, part));
}

function aimHeightFor(entity: CombatEntity, part: DamagePart): number {
  const base = entity.elevation;
  if (isInfantryKind(entity.kind)) {
    if (part.role === "head") return base + 1.45;
    if (part.role === "weapon") return base + 0.98;
    if (part.role === "mobility") return base + 0.36;
    return base + 0.88;
  }
  if (isVehicleKind(entity.kind)) {
    if (part.role === "weapon" || part.id === "turret") return base + 1.18;
    if (part.role === "mobility") return base + 0.32;
    if (part.role === "armor") return base + 0.72;
    return base + 0.82;
  }
  if (entity.kind === "base") {
    if (part.id === "comms") return base + 2.75;
    if (part.role === "weapon") return base + 1.68;
    if (part.role === "volatile") return base + 0.76;
    return base + 1.08;
  }
  return base + Math.max(0.2, Math.min(entity.height * 0.68, 1.1));
}

function firstGroundBetweenShot(from: Vec2, to: Vec2, fromHeight: number, toHeight: number, arcHeight = 0): { point: Vec2; height: number; progress: number } | undefined {
  // Sample density scales with distance so a low shot reliably catches the vertical face of
  // a raised block instead of tunnelling through it.
  const samples = Math.max(10, Math.ceil(dist(from, to) * 4));
  for (let i = 1; i <= samples; i += 1) {
    const t = i / (samples + 1);
    const point = {
      x: from.x + (to.x - from.x) * t,
      z: from.z + (to.z - from.z) * t,
    };
    const lineHeight = trajectoryHeight(fromHeight, toHeight, t, arcHeight);
    const terrain = terrainHeightAt(point);
    if (terrain > 0.04 && lineHeight <= terrain + 0.05) return { point, height: terrain + 0.04, progress: t };
  }
  return undefined;
}

function trajectoryHeight(fromHeight: number, toHeight: number, t: number, arcHeight = 0): number {
  return fromHeight + (toHeight - fromHeight) * t + Math.sin(Math.PI * clamp01(t)) * arcHeight;
}

function adjacentPartIds(entity: CombatEntity, partId: string): string[] {
  if (isInfantryKind(entity.kind)) {
    const map: Record<string, string[]> = {
      body: ["head", "rifle", "legs", "pack"],
      head: ["body", "rifle"],
      rifle: ["body", "head"],
      legs: ["body", "pack"],
      pack: ["body", "legs"],
    };
    return map[partId] ?? [];
  }
  if (isVehicleKind(entity.kind)) {
    const map: Record<string, string[]> = {
      hull: ["turret", "front-plate", "left-tread", "right-tread"],
      turret: ["hull", "cannon"],
      cannon: ["turret", "front-plate"],
      "left-tread": ["hull", "front-plate"],
      "right-tread": ["hull", "front-plate"],
      "front-plate": ["hull", "cannon", "left-tread", "right-tread"],
    };
    return map[partId] ?? [];
  }
  if (entity.kind === "base") {
    const map: Record<string, string[]> = {
      core: ["comms", "power", "gate"],
      comms: ["core", "power"],
      power: ["core", "comms", "gate"],
      gate: ["core", "power"],
    };
    return map[partId] ?? [];
  }
  return entity.parts.filter((part) => part.id !== partId).map((part) => part.id);
}

function partAimOffset(entity: CombatEntity, part: DamagePart): Vec2 {
  if (isInfantryKind(entity.kind)) {
    if (part.id === "head") return { x: 0.05, z: 0.34 };
    if (part.id === "rifle") return { x: entity.kind === "sniper" ? 0.56 : 0.46, z: entity.kind === "sniper" ? 0.42 : 0.24 };
    if (part.id === "legs") return { x: -0.12, z: -0.08 };
    if (part.id === "pack") return { x: 0, z: -0.34 };
    return { x: 0, z: 0 };
  }
  if (isVehicleKind(entity.kind)) {
    if (part.id === "left-tread") return { x: -1.15, z: -0.05 };
    if (part.id === "right-tread") return { x: 1.15, z: -0.05 };
    if (part.id === "front-plate") return { x: 0, z: 0.88 };
    if (part.id === "cannon") return { x: 0, z: 1.26 };
    if (part.id === "turret") return { x: 0, z: 0.18 };
    return { x: 0, z: 0 };
  }
  if (entity.kind === "base") {
    if (part.id === "comms") return { x: -0.9, z: -0.12 };
    if (part.id === "power") return { x: 0.92, z: -0.62 };
    if (part.id === "gate") return { x: 0, z: 1.2 };
    return { x: 0, z: 0 };
  }
  return { x: 0, z: 0 };
}

function localPoint(entity: CombatEntity, offset: Vec2): Vec2 {
  const sin = Math.sin(entity.yaw);
  const cos = Math.cos(entity.yaw);
  return {
    x: entity.position.x + offset.x * cos + offset.z * sin,
    z: entity.position.z - offset.x * sin + offset.z * cos,
  };
}

function impactRadius(entity: CombatEntity, part: DamagePart): number {
  if (part.role === "head") return 0.28;
  if (part.role === "weapon") return 0.34;
  if (part.role === "mobility") return 0.42;
  return Math.max(0.32, Math.min(entity.radius * 0.55, 0.68));
}

function projectileKind(entity: CombatEntity, attackMode: AttackMode = "weapon"): ProjectileKind {
  if (attackMode === "grenade") return "grenade";
  return unitStats(entity.kind).projectile;
}

function moveSpeed(entity: CombatEntity): number {
  return baseMoveSpeed(entity) * MOVE_RANGE_SCALE; // match the range boost so moves resolve as fast
}

function baseMoveSpeed(entity: CombatEntity): number {
  return unitStats(entity.kind).moveSpeed;
}

function projectileSpeed(entity: CombatEntity, attackMode: AttackMode = "weapon"): number {
  if (attackMode === "grenade") return 2.15;
  return unitStats(entity.kind).projectileSpeed;
}

function projectileRange(entity: CombatEntity, attackMode: AttackMode = "weapon"): number {
  if (attackMode === "grenade") return grenadeThrowRange(entity);
  return unitStats(entity.kind).weaponRange;
}

function projectileMaxAge(maxTravel: number, speed: number): number {
  return maxTravel / Math.max(0.1, speed) + 2.2;
}

/**
 * How far a unit must stand from a terrain step so its model (a trooper's weapon, a tank's hull)
 * stays out of the face -- the same clearance the move footprint uses.
 */
function spawnClearance(unitRadius: number): number {
  // Infantry (radius < 1): up to 1.3m of weapon reach (the heavy's gun, the striker's blade) plus a
  // little of the drawn talus that flares past a block. Vehicles: most of the hull plus the talus.
  return unitRadius < 1 ? 1.4 : unitRadius * 0.95 + 0.3;
}

/**
 * A move must not END pressed against a rise (any step taller than a knee, walkable or not): the
 * unit's weapon or hull would sit inside it. Back the stop off along the path until the unit's
 * clearance is free of rises; if the whole path is tight, keep the original stop.
 */
function risesNear(point: Vec2, margin: number): boolean {
  const here = terrainHeightAt(point);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    if (terrainHeightAt({ x: point.x + Math.sin(a) * margin, z: point.z + Math.cos(a) * margin }) - here > 0.3) return true;
  }
  return false;
}
function settleClearOfRises(start: Vec2, stop: Vec2, margin: number): Vec2 {
  if (!risesNear(stop, margin)) return stop;
  const length = dist(start, stop);
  for (let back = 0.15; back < length; back += 0.15) {
    const t = (length - back) / length;
    const c = { x: start.x + (stop.x - start.x) * t, z: start.z + (stop.z - start.z) * t };
    if (!risesNear(c, margin)) return c;
  }
  return stop;
}

/** The nearest dry point within 4m that is clear of every terrain step by `margin` (or `point`). */
function clearOfTerrainEdge(point: Vec2, margin: number): Vec2 {
  if (!onTerrainEdge(point, margin)) return point;
  for (let r = 0.5; r <= 4; r += 0.5) {
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      const c = clampToArena({ x: point.x + Math.sin(a) * r, z: point.z + Math.cos(a) * r });
      if (!onTerrainEdge(c, margin) && !pointInWater(c)) return c;
    }
  }
  return point;
}

function projectileArcHeight(kind: ProjectileKind, distanceToTarget: number, source?: EntityKind): number {
  // SIEGE GUNS LOB. Artillery and the mortar battery fire "shells" like the tank, and inherited the
  // tank's near-flat 0.28 arc: the howitzer was drawn at 24 degrees and fired along the ground, and
  // it could not reach over the cover that indirect fire exists to reach over (2026-09-22 audit).
  if (kind === "shell" && (source === "artillery" || source === "exturret")) return clamp(2 + distanceToTarget * 0.2, 2.4, 5);
  if (kind === "grenade") return clamp(1.5 + distanceToTarget * 0.18, 1.8, 3.6);
  if (kind === "shell") return 0.28;
  return 0;
}

function projectileHeightAt(projectile: Projectile, travel: number): number {
  const linear = projectile.originHeight + projectile.verticalSlope * travel;
  if (projectile.arcHeight <= 0 || projectile.arcDistance <= 0) return linear;
  const t = clamp(travel / projectile.arcDistance, 0, 1);
  return linear + Math.sin(Math.PI * t) * projectile.arcHeight;
}

function projectileProximityRadius(kind: ProjectileKind): number {
  if (kind === "grenade") return 1.15;
  if (kind === "shell") return 0.55;
  return 0;
}

function baseShotDamage(kind: EntityKind, attackMode: AttackMode = "weapon"): number {
  // The grenade figure is a per-MODE constant, not a per-unit stat, so it stays out of the table.
  if (attackMode === "grenade") return 30;
  return unitStats(kind).shotDamage;
}

// Durability tier: heavy armor / siege / emplacements carry far more health than line troops,
// so they soak punishment in line with their cost. Applied to both teams at creation.
function tierHpMultiplier(kind: EntityKind): number {
  return unitStats(kind).hpMultiplier;
}

// Heavy gunners spray a machine-gun burst; everyone else fires one round per shot.
function burstCount(entity: CombatEntity): number {
  return unitStats(entity.kind).burst;
}

// Units whose weapon can be aimed at a bare ground spot (explosive direct/indirect fire).
function canGroundShellAttack(entity: CombatEntity): boolean {
  return unitStats(entity.kind).groundShell;
}

// Blast radius and base damage for an explosive round detonating on the ground.
function explosiveBlast(kind: ProjectileKind): { radius: number; damage: number } {
  if (kind === "grenade") return { radius: 2.55, damage: 34 };
  if (kind === "shell") return { radius: 2.25, damage: 40 };
  return { radius: 1.6, damage: 22 };
}

function stanceMuzzleHeight(entity: CombatEntity, standingHeight: number): number {
  if (entity.stance === "prone") return Math.max(0.72, standingHeight * 0.72);
  if (entity.stance === "crouched") return Math.max(0.72, standingHeight * 0.72);
  return standingHeight;
}

const ACCURACY_LABELS: Record<AccuracyRating, string> = {
  great: "Great accuracy",
  good: "Good accuracy",
  steady: "Steady accuracy",
  average: "Average accuracy",
  poor: "Poor accuracy",
  terrible: "Terrible accuracy",
};

function baseAccuracySpread(kind: EntityKind, attackMode: AttackMode = "weapon"): number {
  if (attackMode === "grenade") return 6.8;
  return unitStats(kind).spread;
}

// Extra spread added per metre of range beyond a per-unit comfortable distance. This is what
// stops marksmen from being pinpoint at the far end of the map while keeping them deadly up to
// medium range, and nudges heavy gunners to close in.
function rangeSpreadPenalty(kind: EntityKind, attackMode: AttackMode, range: number, accurateBonus = 0): number {
  if (attackMode === "grenade") return 0;
  const stats = unitStats(kind);
  // The accurate band is a share of the weapon's own reach, so changing a range moves its falloff
  // with it instead of silently leaving the unit pinpoint or penalized everywhere.
  const start = stats.weaponRange * Math.min(1, stats.accurateFraction + accurateBonus);
  return Math.max(0, range - start) * stats.spreadPerMeter;
}

function kindAccuracyLabel(kind: EntityKind, attackMode: AttackMode = "weapon"): string {
  if (attackMode === "grenade") return "thrown grenade";
  return unitStats(kind).accuracyLabel;
}

function isClimbableCover(entity: CombatEntity): boolean {
  return entity.kind === "cover" && entity.height <= 1.22 && entity.coverKind !== "wall" && entity.coverKind !== "ridge";
}

function isCliffCover(entity: CombatEntity): boolean {
  return entity.kind === "cover" && entity.coverKind === "cliff";
}

function canClimbCover(entity: CombatEntity): boolean {
  return isClimbableCover(entity) || isCliffCover(entity);
}

function hasIntactMeleeWeapon(entity: CombatEntity): boolean {
  return entity.parts.some((part) => part.role === "weapon" && part.hp > 0);
}

function ratingForSpread(spreadDegrees: number): AccuracyRating {
  if (spreadDegrees <= 0.42) return "great";
  if (spreadDegrees <= 1.35) return "good";
  if (spreadDegrees <= 2.45) return "steady";
  if (spreadDegrees <= 4.1) return "average";
  if (spreadDegrees <= 7.2) return "poor";
  return "terrible";
}

function impactPartOrder(entity: CombatEntity, projectile: Projectile): DamagePart[] {
  const intact = entity.parts.filter(isPartIntact);
  if (!intact.length) return [];
  if (entity.kind === "cover") return [preferredPart(entity, "center")];
  const preferred = entity.id === projectile.targetId
    ? intact.find((part) => part.id === projectile.targetPartId) ?? preferredPart(entity, projectile.aim)
    : undefined;
  if (preferred) return [preferred, ...intact.filter((part) => part.id !== preferred.id)];
  return [...intact].sort((a, b) => roleHitPriority(a.role) - roleHitPriority(b.role));
}

function roleHitPriority(role: DamagePart["role"]): number {
  if (role === "core") return 0;
  if (role === "head") return 1;
  if (role === "weapon") return 2;
  if (role === "mobility") return 3;
  if (role === "utility" || role === "volatile") return 4;
  return 5;
}

/** True when segment a→b crosses an axis-aligned box of half extents (hx, hz) rotated by yaw at c. */
function segmentHitsOrientedBox(a: Vec2, b: Vec2, c: Vec2, yaw: number, hx: number, hz: number): boolean {
  // Into the box's local frame (yaw = atan2(dx, dz) convention: local +z is the facing).
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const local = (p: Vec2): Vec2 => { const dx = p.x - c.x, dz = p.z - c.z; return { x: dx * cos - dz * sin, z: dx * sin + dz * cos }; };
  const p = local(a), q = local(b);
  // Slab test (Liang–Barsky) on both axes.
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dz = q.z - p.z;
  for (const [pp, d, h] of [[p.x, dx, hx], [p.z, dz, hz]] as const) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(pp) > h) return false; continue; }
    let tn = (-h - pp) / d, tf = (h - pp) / d;
    if (tn > tf) [tn, tf] = [tf, tn];
    t0 = Math.max(t0, tn); t1 = Math.min(t1, tf);
    if (t0 > t1) return false;
  }
  return true;
}

function projectilePartRadius(entity: CombatEntity, part: DamagePart, projectile: Projectile): number {
  const explosiveBoost = projectile.kind === "shell" || projectile.kind === "grenade" ? 0.14 : 0;
  if (part.role === "core") return Math.max(impactRadius(entity, part), entity.radius * 0.72) + explosiveBoost;
  if (part.role === "head") return impactRadius(entity, part) + explosiveBoost * 0.35;
  return impactRadius(entity, part) + explosiveBoost;
}

function verticalBandDistance(entity: CombatEntity, part: DamagePart, lineHeight: number): number {
  const band = partVerticalBand(entity, part);
  if (lineHeight >= band.min && lineHeight <= band.max) return 0;
  return Math.min(Math.abs(lineHeight - band.min), Math.abs(lineHeight - band.max));
}

function partVerticalBand(entity: CombatEntity, part: DamagePart): { min: number; max: number } {
  const e = entity.elevation;
  if (isInfantryKind(entity.kind)) {
    if (part.role === "head") return { min: e + 1.22, max: e + 1.72 };
    if (part.role === "weapon") return { min: e + 0.78, max: e + 1.16 };
    if (part.role === "mobility") return { min: e + 0.08, max: e + 0.58 };
    if (part.role === "utility" || part.role === "volatile") return { min: e + 0.58, max: e + 1.12 };
    return { min: e + 0.42, max: e + 1.24 };
  }
  if (isVehicleKind(entity.kind)) {
    if (part.role === "weapon" || part.id === "turret") return { min: e + 0.92, max: e + 1.42 };
    if (part.role === "mobility") return { min: e + 0.08, max: e + 0.55 };
    if (part.role === "armor") return { min: e + 0.42, max: e + 0.92 };
    return { min: e + 0.36, max: e + 1.16 };
  }
  if (entity.kind === "base") {
    if (part.id === "comms") return { min: e + 1.9, max: e + 3.05 };
    if (part.role === "weapon") return { min: e + 1.28, max: e + 2.02 };
    if (part.role === "volatile") return { min: e + 0.34, max: e + 1.14 };
    return { min: e + 0.28, max: e + 1.62 };
  }
  return { min: e, max: e + entity.height };
}

function nearest(origin: CombatEntity, candidates: CombatEntity[]): CombatEntity | undefined {
  return candidates
    .map((entity) => ({ entity, d: dist(origin.position, entity.position) }))
    .sort((a, b) => a.d - b.d)[0]?.entity;
}

// How keen the enemy commander is to shoot a given player unit. Soft, high-impact units
// (support, siege, snipers) rank above durable bruisers so focus-fire kills what matters.
// How badly the AI wants to shoot a given kind. Now UNIT_STATS.aiValue; kinds with no preference
// score 0, which is what the old Partial<Record> produced via its `?? 0` call sites.
function aiTargetValue(kind: EntityKind): number {
  return unitStats(kind).aiValue;
}

// Total HP across an entity's still-living parts — its effective remaining health.
function remainingHp(entity: CombatEntity): number {
  return entity.parts.reduce((sum, part) => sum + Math.max(0, part.hp), 0);
}

// Fraction of the entity's core (body/hull) HP remaining, 0..1. Drives the "retreat when
// crippled" decision; falls back to all parts for entities with no explicit core.
function coreHpFraction(entity: CombatEntity): number {
  const cores = entity.parts.filter((part) => part.role === "core");
  const pool = cores.length ? cores : entity.parts;
  const hp = pool.reduce((sum, part) => sum + Math.max(0, part.hp), 0);
  const max = pool.reduce((sum, part) => sum + part.maxHp, 0);
  return max > 0 ? hp / max : 0;
}

function isVolatileCover(entity: CombatEntity): boolean {
  return entity.parts.some((part) => part.role === "volatile");
}

// True if `cover` sits on the threat-facing side of a unit standing at `pos` (so it blocks LoS).
function coverIsTowardThreat(cover: Vec2, pos: Vec2, threat: Vec2): boolean {
  return (threat.x - pos.x) * (cover.x - pos.x) + (threat.z - pos.z) * (cover.z - pos.z) > 0;
}

// Whether a map event is active on a given turn, honoring its start turn, duration, and period.
function eventOccursWindow(e: MapEventConfig, turn: number): boolean {
  if (turn < e.startTurn) return false;
  const duration = Math.max(1, e.duration ?? 1);
  if (e.period && e.period > 0) {
    const phase = (turn - e.startTurn) % e.period;
    return phase >= 0 && phase < duration;
  }
  return turn < e.startTurn + duration;
}

function preferredPartByIdOrAim(entity: CombatEntity, partId: string, aim: AimMode) {
  return entity.parts.find((p) => p.id === partId && p.hp > 0) ?? preferredPart(entity, aim);
}

function aimForPart(part: DamagePart | undefined): AimMode {
  if (!part) return "center";
  if (part.role === "head") return "head";
  if (part.role === "weapon") return "weapon";
  if (part.role === "mobility") return "mobility";
  if (part.role === "utility" || part.role === "volatile") return "utility";
  if (part.role === "core" || part.role === "armor") return "core";
  return "center";
}
