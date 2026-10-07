import { orderLabel } from "./orderLabel";
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
  createArtillery,
  createGrenadier,
  createHeavy,
  createMortar,
  createScout,
  createSniper,
  createCover,
  createBase,
  createJumper,
  createFlamer,
  createFlak,
  createGunship,
  createBomber,
  createGunPost,
  createMortarPit,
  createBazooka,
  createTurretTech,
  createSledge,
  createLancer,
  createIronclad,
  createRunabout,
  createHornet,
  createRocketPost,
  createCannonPost,
  createFlamePost,
  createSentry,
  createSoldier,
  createStriker,
  createBreaker,
  createBoomer,
  createJuggernaut,
  createTank,
  createTurret,
  COVER_PROFILES,
  createExTurret,
  createBunker,
  createSensor,
  createWall,
  factionLiving,
  isBuildingKind,
  isDefenseKind,
  isLandmarkKind,
  isToppleKind,
  isAirKind,
  isInfantryKind,
  isMountKind,
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
import { DEFAULT_TERRAIN, TERRAIN_STEP, ARENA_BOUNDS, clampToArena, discSamples, nearestDryPoint, onTerrainEdge, setActiveTerrain, terrainHeightAt, pointInWater } from "./terrain";
import { TROOP_CATALOG, TROOP_KINDS, troopSpec, defenseSpec, supportPowerSpec, baseUpgradeSpec, unitStats, placeSpecFor, type BaseUpgradeId, type PlaceSpec, type TroopKind, type DefenseKind, type SupportPowerKind, type ProjectileKind } from "./units";
import { TECH_TREE, techNode, aggregateTechEffect, type TechNode, type TechEffect } from "./tech";
import { modeDef, type ModeId } from "./modes";
import { DEFAULT_FACTION, factionDef, factionTroopLabel, type FactionDef, type FactionId } from "./factions";
import { MAPS, mapDef, mapCenter, flagPositions, type MapDef, type MapEventConfig, type MapEventKind } from "./maps";

export { TROOP_CATALOG, troopSpec, DEFENSE_CATALOG, defenseSpec, SUPPORT_POWERS, supportPowerSpec, BASE_UPGRADES, baseUpgradeSpec, type BaseUpgradeId, UNIT_STATS, unitStats, placeSpecFor, PLACEABLES, type PlaceSpec, type PlaceKind, type TroopKind, type TroopSpec, type DefenseKind, type DefenseSpec, type SupportPowerKind, type SupportPowerSpec, type ProjectileKind, type UnitStats } from "./units";
export { TECH_TREE, techNode, troopsUnlockedBy, type TechNode } from "./tech";
export { MODES, PLAYABLE_MODES, modeDef, type ModeId, type ModeDef } from "./modes";
export { FACTIONS, factionDef, DEFAULT_FACTION, type FactionId, type FactionDef } from "./factions";
export { MAPS, mapDef, flagPositions, mapCenter, mapSize, type MapDef, type MapTheme, type MapSize } from "./maps";

export type Phase = "command" | "resolve" | "victory" | "defeat";
// A placed deploy whose exact point is blocked slides to the nearest clear spot within this reach
// (measured from the click to the edge of the unit's footprint).
export const DEPLOY_SNAP = 1.5;

export type Intent = "select" | "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "push" | "interact" | "inspect" | "build" | "support" | "load" | "unload" | "smoke" | "deploy" | "place" | "man" | "dismount" | "leap" | "slam" | "detonate";
export type OrderKind = "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "load" | "unload" | "smoke" | "deploy" | "man" | "slam" | "detonate";

// Orders that carry a unit off its spot this resolve -- anything else leaves it dug in.
const MOVING_ORDERS: ReadonlySet<OrderKind> = new Set<OrderKind>(["move", "ram", "melee", "load", "unload", "slam"]);
const TROOP_KIND_SET: ReadonlySet<string> = new Set(TROOP_KINDS);
const isTroopKind = (kind: EntityKind): boolean => TROOP_KIND_SET.has(kind);

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
// Resolve-phase budgets, in simulated seconds. SETTLE is the graceful escape once nothing is
// airborne; HARD_CEILING is the unconditional one that guarantees the phase always ends.
const RESOLVE_SETTLE_TIMEOUT = 18;
const RESOLVE_HARD_CEILING = 20;

// Support powers that land damage (the bot's strike logic only drops these on a crowd).
const DAMAGING_SUPPORT: ReadonlySet<SupportPowerKind> = new Set<SupportPowerKind>(["airstrike", "cluster", "laser", "napalm", "barrage"]);
/** A Sensor Mast's spotter relay reaches this far (a spotter unit's reaches 6.2m). */
const SENSOR_REACH = 10;
const RESUPPLY_RADIUS = 4;
const RESUPPLY_HEAL = 40;
// Half-angle of a unit's FRONT: a shot from outside this ±60° wedge around its facing flanks it.
const FRONT_ARC_HALF = Math.PI / 3;
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
/** Seats per carrier: the Runabout seats four riders and a gunner. */
const carrierCapacity = (_kind: EntityKind): number => 5; // ponytail: the Runabout is the only carrier
const SLAM_RADIUS = 3.0; // the Sledge's hammer circle
const SLAM_DAMAGE = 30;
const SLAM_THROW = 8;
// BREAKER (owner 2026-10-06: "a unit that can move fast and punch people SUPER far"): the punch is a shove twice as hard that also hurts.
export const BREAKER_CHARGE = 7;
const PUNCH_FORCE = 225; // 225/30 x KNOCKBACK_SCALE = 18m on a trooper: the tooltip's number
const PUNCH_MAX = 18;
const PUNCH_DAMAGE = 26;
// BOOMER (owner: "a cheaper unit that Kamikazes"): it blows itself up; everything within BOOM_RADIUS is hurt and flung.
export const BOOM_RADIUS = 3.6;
const BOOM_DAMAGE = 112;
const BOOM_THROW = 7.5;
const BURN_STATUS_TURNS = 3; // a trooper set alight burns this many turns...
const BURN_STATUS_DAMAGE = 8; // ...for this much a turn
const CHAIN_RADIUS = 3.2; // the arc rifle jumps to foes this close to the one it hit
const SENTRY_COST_TURNS = 4;
// Runabout carry: the ground lift needs the passenger beside the hull, and unloads beside it too.
const APC_LOAD_REACH = 1.2;
const APC_UNLOAD_REACH = 3;
// STRIKER CHARGE: metres of free closing distance folded into the strike order.
export const STRIKER_CHARGE = 6.5;
// Hull-down tanks take this fraction of incoming shot damage.
const HULL_DOWN_DAMAGE = 0.7;
// AIRBURST (grenadier): a launcher round that bursts on cover still lands this share of its direct
// damage on the target sheltering right behind it — cover is half protection, not full.
const AIRBURST_SHARE = 0.5;
const AIRBURST_REACH = 2.7;
// FEAR (flamer): enemy infantry this close to burning ground at turn start run from it.
export const FLAMER_FEAR_RADIUS = 6;
// CARPET (bomber): three bombs in a line along the heading, this far apart.
export const CARPET_BOMBS = 3;
const CARPET_SPACING = 2.2;
// Seconds into a shoot / grenade / smoke order at which the round leaves (the attack pose's
// contact point is authored against this; the renderer's carpet-bomb fall ends on it).
export const ATTACK_FIRE_AT = 0.58;
// A jump trooper landing next to an enemy: damage before difficulty scaling.
const SLAM_LANDING_DAMAGE = 15;

// Metres a piercing round carries on past a body it went through.
const PIERCE_CARRY = 7;

type StrikeKind = "barrage" | "collapse" | "airstrike" | "cluster" | "laser" | "lightning" | "slag" | "smokedrop" | "resupply" | "napalm" | "paradrop" | "emp" | "minedrop" | "medevac" | "sentrydrop" | "railstrike";
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
// A trooper's hop: how fast it travels (m/s), the base reach and the base ledge it can clear (both scale with how light and quick the kind is).
const LEAP_SPEED = 7.5;
const LEAP_REACH = 3.6;
const LEAP_UP = 1.35;
const BURN_TURNS = 2;
const BURN_DAMAGE = 14;
// How many of each placement a side may keep standing at once.
// MANNED EMPLACEMENTS: a trooper this close (past both radii) is crewing it; farther and it has left.
const MOUNT_CREW_REACH = 1.4;
const PLACE_CAP: Record<string, number> = { charge: 4, barrier: 3 };
// Mortar smoke round: a cloud that blocks flat line of fire through it for a few turns.
const SMOKE_RADIUS = 3;
const SMOKE_TURNS = 3;
const SMOKE_COLOR = 0x9aa3a8;
// Sniper mark: every OTHER friendly shooter gets this spread multiplier and accurate-band bonus
// against a unit a sniper fired at, until the turn after.
const MARK_SPREAD_SCALE = 0.8;
const MARK_ACCURATE_BONUS = 0.2;
// Proximity mines (the Minefield defense and the Minefield Drop strike).
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
  /** A melee order that SHOVES instead of striking (the Push ability): same rush, a big throw. */
  shove?: boolean;
  /** A short hop every trooper can make: a move that arcs over low obstacles and up onto a ledge (see leapRange). */
  leap?: boolean;
  projectileId?: string;
}

/** One enemy unit's planned order for the coming resolve, as revealed by the Watch Radar. */
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
  // "shot" = a gun-run burst (gunship strafe): tracers from the aircraft's gun at `fromHeight`
  // down into `to`. It is resolved as direct damage, so it carries no Projectile of its own.
  // "clash" = two rounds meeting in mid-air at `fromHeight`; its colour names the family (CLASH_SPARK / CLASH_BOLT / CLASH_BLAST).
  type: "shot" | "impact" | "blast" | "ping" | "jet" | "beam" | "topple" | "strike" | "bolt" | "land" | "clash";
  from: Vec2;
  to: Vec2;
  color: number;
  age: number;
  duration: number;
  radius?: number;
  /** World height the effect starts at, when that is not the ground under `from`. */
  fromHeight?: number;
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
/** Two opposed rounds closer than this (metres, in 3D) meet in the air. */
/** What met in the air: small-arms sparks, a sniper bolt's shock ring, or a shell / rocket / grenade fireball. */
export const CLASH_SPARK = 0xffd27a;
export const CLASH_BOLT = 0xd8ecff;
export const CLASH_BLAST = 0xff9a3a;
/** Utility "blasts" that are a pulse, not an explosion: an EMP burst and a smoke shell opening. They draw a ring of light or a puff, never a fireball, a scorch or a shove. */
export const PULSE_EMP = 0x8de4ff;
export const PULSE_SMOKE = 0x9aa3a8; // SMOKE_COLOR
export const PULSE_WATER = 0x4f9fd0; // a trooper or vehicle going under: a ring and spray, never a fireball
export const isPulseBlast = (color: number | undefined): boolean => color === PULSE_EMP || color === PULSE_SMOKE || color === PULSE_WATER;
const PROJECTILE_COLLIDE_RADIUS = 0.42;
/** A bomb run closer than this drops where it hovers (no move to queue). */
const KNOCKBACK_SCALE = 2.4;
const KNOCKBACK_MAX = 6;
// PUSH (owner 2026-09-24): an infantry shove throws a body "super far" -- into water it drowns, over
// the arena edge it falls off the map. A vehicle's mass makes it budge a little and no more.
const SHOVE_FORCE = 90;
const SHOVE_MAX = 9;

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
  // Burning ground left by flamer hits (damages at turn start) and proximity mines.
  readonly burnZones: { id: string; x: number; z: number; radius: number; turnsLeft: number; damage?: number }[] = [];
  // GAS CLOUDS. A shot-out canister leaks a cloud that grows each turn until it hits its cap or
  // something lights it: any blast inside it (grenade, shell, mine, a flamer round, burning ground)
  // detonates the WHOLE cloud at once. Chokes whoever stands in it meanwhile. Rides serialize().
  readonly gasClouds: { id: string; x: number; z: number; radius: number; maxRadius: number }[] = [];
  // Mortar smoke: flat shots through a cloud are lost in it; shrinks a turn per turn start. Rides serialize().
  readonly smokeClouds: { id: string; x: number; z: number; radius: number; turnsLeft: number }[] = [];
  // REVEAL (Watch Radar): set when the radar reveals; the enemy's NEXT command is revealed, so
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
  /** The player's battle tallies for the live Achievements (deployed kinds, throws, slams, sentries ...). Not saved: a resumed battle counts from the resume. */
  readonly stats: Record<string, number> = {};
  private tally(team: Team, key: string, n = 1): void {
    if (team !== "player" || this.hotseat || n <= 0) return;
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }
  playerLosses = 0;
  private readonly countedDead = new Set<string>();
  readonly log: string[] = [];
  // Hotseat: how many lines have ever been logged, and the count when the current seat started
  // planning. swapSides() drops the outgoing seat's planning chatter so the next seat cannot read
  // the other human's orders off the log.
  private logSeq = 0;
  /** Lines ever pushed to the log (monotonic; the play log reads the new ones each frame). */
  get logTotal(): number { return this.logSeq; }
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
  private queuedSupport: { kind: SupportPowerKind; point: Vec2; dir: Vec2; team?: Team }[] = [];
  // Timed one-shot visual events (strike jets, orbital beams) played during a resolve.
  private pendingFx: { at: number; type: VisualEvent["type"]; from: Vec2; to: Vec2; color: number; duration: number; radius?: number; fired?: boolean }[] = [];

  private orderSeq = 0;
  private effectSeq = 0;
  private readonly clashLogTurn = new Map<string, number>(); // pair -> turn of its last "rounds collide" log line
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
  private pendingStrikes: { at: number; point: Vec2; radius: number; damage: number; kind: StrikeKind; team?: Team; fired?: boolean }[] = [];
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

  /** What `team`'s faction calls this troop (a Recruit is a Trooper / Raider / Guardsman). */
  troopLabel(team: Team, kind: TroopKind): string {
    return factionTroopLabel(this.factions[team], kind, troopSpec(kind).label);
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
    this.placeFieldMounts();
    this.killsBy.clear();
    for (const key of Object.keys(this.stats)) delete this.stats[key];
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
    if (intent === "place" && this.intent !== "place") this.placementTurn = 0;
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
    // Tab reaches everything you can command: the Home Base first, then every unit and gun emplacement you own (walls are not).
    const units = [...this.living("player").filter((e) => e.kind === "base"), ...this.living("player").filter((e) => !isBuildingKind(e.kind) && e.kind !== "wall")];
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

  /** Where a move toward `destination` would really stop (range + terrain + blockers), without
   *  queueing it or logging — the live path the renderer previews while Move is armed. */
  previewMoveTo(destination: Vec2): { from: Vec2; to: Vec2 } | undefined {
    const actor = this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command" || !actor.status.canMove || actor.commandPoints <= 0) return undefined;
    const from = this.projectedActorForPreview(actor).position;
    const limited = limitMoveDestination(actor, from, clampToArena(destination));
    return { from, to: this.blockedMoveDestination(actor, from, limited, undefined, true) };
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
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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

  /** How far a trooper can hop. Light, quick kinds (a scout) go farther and higher; a heavy gunner barely clears a crate. */
  leapRange(actor: CombatEntity): number {
    return LEAP_REACH * Math.sqrt(unitStats(actor.kind).moveSpeed / 6.5) * (actor.mods?.move ?? 1);
  }

  leapUp(actor: CombatEntity): number {
    return LEAP_UP * Math.sqrt(unitStats(actor.kind).moveSpeed / 6.5);
  }

  /** Where a hop toward `point` would land (clamped to range, nudged clear of solids) and whether it may. */
  leapPreview(point: Vec2, actorOverride?: CombatEntity): { from: Vec2; to: Vec2; ok: boolean; reason?: string } | undefined {
    const actor = actorOverride ?? this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command" || !isInfantryKind(actor.kind) || canJump(actor)) return undefined;
    return this.leapPlan(actor, point);
  }

  /** The hop itself, for either side: where it lands and whether the trooper may make it. */
  private leapPlan(actor: CombatEntity, point: Vec2): { from: Vec2; to: Vec2; ok: boolean; reason?: string } {
    const from = this.projectedActorForPreview(actor).position;
    const range = this.leapRange(actor);
    const d = dist(from, point);
    const wanted = d > range ? { x: from.x + ((point.x - from.x) / d) * range, z: from.z + ((point.z - from.z) / d) * range } : point;
    const to = this.jumpLanding(actor, nearestDryPoint(clampToArena(wanted)));
    const fail = (reason: string): { from: Vec2; to: Vec2; ok: boolean; reason: string } => ({ from, to, ok: false, reason });
    if (!actor.status.canMove) return fail(`${actor.name} cannot move`);
    if (dist(to, wanted) > 1.2) return fail("No room to land there");
    if (pointInWater(to)) return fail("Cannot land in the water");
    if (terrainHeightAt(to) - terrainHeightAt(from) > this.leapUp(actor)) return fail("Too high to jump up");
    if (!this.groundFits(actor, to)) return fail("No room to land there");
    return { from, to, ok: true };
  }

  /** Player API: HOP. Every trooper can leap a few metres: over a crate or a low wall, up onto a ledge, across a gap. 1 AP. */
  queueLeap(point: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isInfantryKind(actor.kind)) return this.reject("Only infantry can jump");
    if (canJump(actor)) return this.reject(`${actor.name} already jumps with its pack: use Move`);
    if (actor.commandPoints <= 0) return this.reject(`${actor.name} has no action points`);
    const preview = this.leapPreview(point);
    if (!preview) return false;
    if (!preview.ok) return this.reject(preview.reason ?? "Cannot jump there");
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    this.addOrder({ actorId: actor.id, kind: "move", destination: preview.to, leap: true, aim: this.aim, duration: 1.6 });
    this.tally(actor.team, "hops");
    return true;
  }

  queueMoveToCover(coverId: string): boolean {
    const actor = this.requirePlayerActor();
    const cover = this.entity(coverId);
    if (!actor || !cover || cover.kind !== "cover") return false;
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot move`);
    if (actor.commandPoints <= 0) return this.reject(`${actor.name} has no action points`);
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
    const target = this.entity(targetId);
    if (actor && target && isAirBomber(actor)) {
      if (target.team === actor.team) return this.reject("Cannot bomb friendly units");
      if (target.flying) return this.reject("Bombs can't hit aircraft — use guns on flyers");
      return this.queueBombRun(actor, target.position);
    }
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueGrenadeFor(actor, target, this.aim);
  }

  queueGrenadePart(targetId: string, partId: string): boolean {
    const actor = this.requirePlayerActor();
    if (actor && isAirBomber(actor)) return this.queueGrenade(targetId); // a bomb has no part to pick
    const target = this.entity(targetId);
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueGrenadeFor(actor, target, aimForPart(target.parts.find((part) => part.id === partId)), partId);
  }

  queueGrenadeAt(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    // An aircraft bombs straight down, so it FLIES to the clicked spot first (a bomb run) and drops
    // there; ground units lob to the clicked spot.
    if (isAirBomber(actor)) return this.queueBombRun(actor, clampToArena(destination));
    const point = clampToArena(destination);
    const failure = this.grenadeLocationFailureReason(actor, point);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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

  // The Confirm Bomb button: bomb the picked spot / target.
  queueBombDrop(at?: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isAirBomber(actor)) return this.reject(`${actor.name} can't drop bombs`);
    return this.queueBombRun(actor, at ? clampToArena(at) : this.projectedActorForPreview(actor).position);
  }

  /** Why a bomb at `point` cannot be queued (reach, bombs, action points), or undefined. The aircraft never moves for it: a bomb is released
   *  where the aircraft hovers and falls on any ground point inside its bomb reach (owner 2026-10-03: no auto "fly over, then drop"). */
  bombRunFailure(actor: CombatEntity, point: Vec2): string | undefined {
    if (actor.grenades <= 0) return `${actor.name} is out of bombs`;
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    const reach = grenadeThrowRange(actor);
    if (dist(this.projectedActorForPreview(actor).position, point) > reach) return `Out of reach: ${actor.name} bombs up to ${reach}m`;
    return undefined;
  }

  /** BOMB: one action point, no flight. Released at the aircraft, it falls on the picked spot. */
  private queueBombRun(actor: CombatEntity, point: Vec2): boolean {
    const failure = this.bombRunFailure(actor, point);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    actor.grenades = Math.max(0, actor.grenades - 1);
    this.addOrder({ actorId: actor.id, kind: "grenade", destination: { ...point }, aim: "center", duration: 1.15 });
    return true;
  }

  // ---- Runabout carry: load a friendly ground unit, carry it, and unload it ----
  // The air transport flies to its passenger and to the unload point; the Runabout is the ground
  // GROUND version — it takes aboard whoever is beside it and sets them down beside it.

  private loadFailureReason(actor: CombatEntity | undefined, passenger: CombatEntity | undefined): string | undefined {
    if (!actor || !isCarrierKind(actor.kind)) return "Only a Runabout can carry units";
    if (!actor.status.alive || !actor.status.canMove) return `${actor.name} can't move`;
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    if ((actor.passengerIds?.length ?? 0) >= carrierCapacity(actor.kind)) return `${actor.name} is full (${carrierCapacity(actor.kind)} aboard)`;
    if (!passenger || !passenger.status.alive) return "Pick a friendly unit to carry";
    if (passenger.id === actor.id || passenger.team !== actor.team) return "Can only carry your own units";
    if (passenger.flying || isBuildingKind(passenger.kind) || isDefenseKind(passenger.kind) || passenger.kind === "cover") return "That unit can't ride";
    if (passenger.carriedById) return `${passenger.name} is already aboard`;
    if (isGroundCarrier(actor.kind) && (!isInfantryKind(passenger.kind) || passenger.kind === "jumper")) return "A Runabout only carries foot troops";
    if (isGroundCarrier(actor.kind) && dist(actor.position, passenger.position) > actor.radius + passenger.radius + APC_LOAD_REACH) return `${passenger.name} must be beside the Runabout to board`;
    return undefined;
  }

  /** Whether the selected transport / Runabout could pick up the given unit (for HUD affordances). */
  canAirlift(passengerId: string): boolean {
    return !this.loadFailureReason(this.selected, this.entity(passengerId));
  }

  queueLoad(passengerId: string): boolean {
    const actor = this.requirePlayerActor();
    const passenger = this.entity(passengerId);
    const failure = this.loadFailureReason(actor, passenger);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor!)) return this.reject(`${actor!.name} has no action points`);
    this.addOrder({ actorId: actor!.id, kind: "load", targetId: passengerId, aim: "center", duration: isGroundCarrier(actor!.kind) ? 1.2 : 2.6 });
    return true;
  }

  queueUnload(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isCarrierKind(actor.kind)) return this.reject(`${actor.name} can't carry units`);
    if (!(actor.passengerIds?.length)) return this.reject(`${actor.name} isn't carrying anyone`);
    const point = clampToArena(destination);
    if (isGroundCarrier(actor.kind) && dist(actor.position, point) > actor.radius + APC_UNLOAD_REACH) return this.reject("A car sets its troops down beside itself — pick a spot next to it");
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    this.addOrder({ actorId: actor.id, kind: "unload", destination: point, aim: "center", duration: isGroundCarrier(actor.kind) ? 1.2 : 2.4 });
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
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    this.addOrder({ actorId: actor.id, kind: "shoot", destination: point, aim: "center", duration: 1.35 });
    return true;
  }

  // ---- Mortar smoke round ----

  smokeFailureReason(actor: CombatEntity | undefined, point?: Vec2): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "mortar") return "Only a mortar fires smoke rounds";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (!actor.status.canShoot) return `${actor.name} cannot fire — its tube is destroyed`;
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
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
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
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
    // An aircraft's bomb falls from its rack onto the picked spot: a steep straight drop, never a lob.
    const airDrop = grenade && isAirBomber(actor);
    const to = clampToArena(point);
    const projected = this.projectedActorForPreview(actor);
    projected.yaw = Math.atan2(to.x - projected.position.x, to.z - projected.position.z);
    const attackMode: AttackMode = grenade ? "grenade" : "weapon";
    const from = muzzlePoint(projected, attackMode);
    const fromHeight = muzzleHeight(projected, attackMode);
    const kind = grenade ? "grenade" : projectileKind(actor, "weapon");
    const horizontal = dist(from, to);
    const reachable = airDrop ? !this.bombRunFailure(actor, to) : horizontal <= (grenade ? grenadeThrowRange(actor) : projectileRange(actor, "weapon"));
    const toHeight = terrainHeightAt(to) + 0.14;
    const arcHeight = airDrop ? 0 : grenade ? projectileArcHeight("grenade", horizontal) : Math.max(projectileArcHeight(kind, horizontal, actor.kind), 0.6);
    const radius = explosiveBlast(kind, actor.kind).radius;
    // A bomb falls steeply on its point: nothing between "from" and "to" can intercept it.
    const ground = airDrop ? undefined : firstGroundBetweenShot(from, to, fromHeight, toHeight, arcHeight);
    const obstacle = ground || airDrop ? undefined : this.firstEntityBetweenShot(from, to, fromHeight, toHeight, actor.id, "", arcHeight);
    const cover = ground || obstacle || airDrop ? undefined : this.firstCoverBetweenShot(from, to, fromHeight, toHeight, undefined, arcHeight);
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
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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

  selectedActionRange(): { kind: "ram" | "melee" | "grenade" | "move" | "shoot"; radius: number; position: Vec2; elevation: number } | undefined {
    const actor = this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command") return undefined;
    const projected = this.projectedActorForPreview(actor);
    // Weapon reach while aiming. Without it the only way to learn a unit's range was to try
    // targets one by one and read "too far" — the single most asked "why can't I" in play.
    if (this.intent === "shoot" && actor.status.canShoot && projectileRange(actor, "weapon") > 0) {
      return { kind: "shoot", radius: projectileRange(actor, "weapon"), position: { ...projected.position }, elevation: projected.elevation };
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
    if (this.intent === "leap" && isInfantryKind(actor.kind) && !canJump(actor)) {
      return { kind: "move", radius: this.leapRange(actor), position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "man" && isInfantryKind(actor.kind)) {
      return { kind: "move", radius: moveRange(actor) + MOUNT_CREW_REACH, position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "place") {
      const spec = placeSpecFor(actor.kind);
      if (spec) return { kind: "grenade", radius: spec.reach + actor.radius, position: { ...projected.position }, elevation: projected.elevation };
    }
    if ((this.intent === "melee" || this.intent === "push") && isInfantryKind(actor.kind) && actor.status.canMove) {
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
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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

  /** Player API: PUSH -- rush like a strike, then shove the target hard (see SHOVE_FORCE). */
  queueShove(targetId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    const failure = this.meleeFailureReason(actor, target);
    if (failure) return this.reject(failure.replace(/strike/i, "push"));
    if (!actor || !target) return false;
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    const part = preferredPart(target, "center");
    this.addOrder({ actorId: actor.id, kind: "melee", shove: true, targetId, targetPartId: part.id, aim: "center", duration: 0.78 });
    this.pushLog(`${actor.name} moves to push ${target.name}`);
    return true;
  }

  queueDefend(stance: InfantryStance = "crouched"): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!isInfantryKind(actor.kind)) return this.reject("Only infantry can change stance");
    if (stance === "prone") return this.reject("Prone is unavailable in this slice");
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot change stance without mobility`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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
    const spec = { ...troopSpec(kind), label: this.troopLabel(base.team, kind) };
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
    if (base.commandPoints <= 0) return `${base.name} has no action points`;
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
    // A shattered Blast Gate: troops can only be set down right beside the base.
    if (this.gateDown(base)) return base.radius + 2.4;
    // RAPID RESPONSE (Vanguard doctrine) reaches further out from the base.
    return base.radius + 6 + (this.factionOf(base.team).doctrine.deployReach ?? 0);
  }

  // ---- BASE SYSTEMS (owner 2026-10-02: "some kind of impact if you destroy part of someone's base ...
  // otherwise no point of attacking it besides the main command core"). Each base part now costs its
  // owner something real, and the base panel says what.
  private gateDown(base: CombatEntity): boolean {
    return base.kind === "base" && base.parts.some((p) => p.id === "gate" && p.hp <= 0);
  }
  private commsDown(team: Team): boolean {
    return this.entities.some((e) => e.kind === "base" && e.team === team && e.status.alive && e.parts.some((p) => p.id === "comms" && p.hp <= 0));
  }
  /** What a base's damaged parts are costing it right now, as short labels (the base panel's chips). */
  baseSystemEffects(base: CombatEntity): { label: string; tip: string }[] {
    const out: { label: string; tip: string }[] = [];
    if (base.parts.some((p) => p.id === "comms" && p.hp <= 0)) out.push({ label: "Comms down · 1 AP per unit", tip: "The Comms Mast is destroyed: every unit refills at most 1 action point a turn" });
    if (this.gateDown(base)) out.push({ label: "Gate down · deploy beside base", tip: "The Blast Gate is destroyed: troops can only be set down right beside the base, and every reinforcement waits a turn longer." });
    const eff = generatorEfficiency(base);
    if (eff < 0.999) out.push({ label: `Reactor ${Math.round(eff * 100)}% · income cut`, tip: "The Reactor Core is damaged: income is scaled by its health." });
    return out;
  }

  /** A troop's deploy cooldown for this side, after its doctrine (Rapid Response cuts a turn). */
  troopCooldownFor(team: Team, kind: TroopKind): number {
    const gate = this.entities.some((e) => e.kind === "base" && e.team === team && this.gateDown(e)) ? 1 : 0;
    return Math.max(1, troopSpec(kind).cooldown - (this.factionOf(team).doctrine.cooldownCut ?? 0)) + gate;
  }

  /** A support power's cooldown for this side, after its doctrine. */
  supportCooldownFor(team: Team, kind: SupportPowerKind): number {
    return Math.max(1, supportPowerSpec(kind).cooldown - (this.factionOf(team).doctrine.cooldownCut ?? 0));
  }

  // The placement footprint for the armed deploy, or undefined if not placing a troop.
  deployPlacement(): { center: Vec2; radius: number } | undefined {
    if (this.intent !== "deploy" || !this.pendingDeploy) return undefined;
    const base = this.selected;
    if (!base || base.kind !== "base" || base.team !== "player") return undefined;
    return { center: { ...base.position }, radius: this.deployPlacementRadius(base) };
  }

  setPendingDeploy(kind: TroopKind | undefined): boolean {
    const blocked = kind && this.spawnFailureReason(this.selected, kind);
    if (blocked) return this.reject(blocked);
    this.pendingDeploy = kind;
    this.intent = kind ? "deploy" : "select";
    if (kind) {
      this.pendingBuild = undefined;
      this.pendingSupport = undefined;
    }
    return true;
  }

  // The footprint a troop of this kind needs on the ground (rng-free probe entity, never fielded).
  private troopFootprint(kind: TroopKind, team: Team): { radius: number; flying: boolean } {
    const probe = makeTroop(kind, "probe", "probe", team, { x: 0, z: 0 });
    return { radius: probe.radius, flying: Boolean(probe.flying) };
  }

  /** The body a deploy ghost draws: footprint radius, height, and altitude for a flyer. */
  deployBody(kind: TroopKind): { radius: number; height: number; agl: number } {
    const probe = makeTroop(kind, "probe", "probe", "player", { x: 0, z: 0 });
    return { radius: probe.radius, height: probe.height, agl: probe.flying ? probe.agl ?? 5 : 0 };
  }

  // Same clearance rules as `freeSpawnNear`: clear of the base and every living body (sized to
  // THIS unit), off a terrain step, and — for ground troops — dry.
  private deploySpotBlocked(base: CombatEntity, point: Vec2, unitRadius: number, flying: boolean): boolean {
    if (dist(point, base.position) < base.radius + unitRadius + 0.3) return true;
    if (this.entities.some((e) => e.id !== base.id && e.status.alive && !e.carriedById && dist(e.position, point) < e.radius + unitRadius + SPAWN_GAP)) return true;
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
    // finds the spot beside it (two 0.65 bodies plus SPAWN_GAP need 2.2 centre to centre).
    const reach = DEPLOY_SNAP + radius + SPAWN_GAP;
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
    const spec = { label: this.troopLabel(base.team, kind) };
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
    this.tally(base.team, `deploy:${kind}`);
    const unit = this.createTroop(kind, base, at);
    this.entities.push(unit);
    this.syncEntityElevation(unit);
    // The deployed troop holds position until the next turn.
    unit.commandPoints = 0;
    base.spawnCooldowns = { ...(base.spawnCooldowns ?? {}), [kind]: this.troopCooldownFor(base.team, kind) };
    this.pushLog(`${base.name} deploys ${unit.name}`);
    return true;
  }

  /** Stamp the unit's faction traits (health, speed, reach, damage, grenades) on it at deploy. */
  private applyFactionMods(unit: CombatEntity): void {
    const mods = this.factionOf(unit.team).unitMods?.[unit.kind as TroopKind];
    if (!mods) return;
    unit.mods = { ...mods };
    if (mods.hp) scaleEntityHp(unit, mods.hp);
    if (mods.grenades) { unit.maxGrenades += mods.grenades; unit.grenades += mods.grenades; }
  }

  private createTroop(kind: TroopKind, base: CombatEntity, at?: Vec2): CombatEntity {
    const prefix = base.team === "player" ? "p" : "e";
    const id = `${prefix}-spawn-${++this.troopSeq}`;
    const name = `${this.troopLabel(base.team, kind)} ${this.troopSeq}`;
    const spawnAt = makeTroop(kind, id, name, base.team, base.position);
    // Clearance is sized to THIS unit: a tank fielded with an infantry-sized gap sat inside the
    // nearest crate or wall. A placed deploy (`at`) was validated by deployPointPreview.
    spawnAt.position = at ? { ...at } : this.freeSpawnNear(base, spawnAt.radius);
    if (!spawnAt.flying) spawnAt.position = nearestDryPoint(spawnAt.position);
    // A spot found by the last-resort fallback (every ring crowded) must still stand clear of a step: the movement oracle caught a trooper
    // fielded with its hull in one. A validated, player-placed spot is left exactly where it was put.
    if (!at && !spawnAt.flying) spawnAt.position = clearOfTerrainEdge(spawnAt.position, spawnClearance(spawnAt.radius));
    const unit = spawnAt;
    this.applyFactionMods(unit);
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
    if (base.commandPoints <= 0) return this.reject(`${base.name} has no action points`);
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

  /** Why the base cannot buy this upgrade right now (undefined when it can). */
  baseUpgradeFailureReason(base: CombatEntity | undefined, id: BaseUpgradeId): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base";
    if (!base.status.alive) return `${base.name} is disabled`;
    const spec = baseUpgradeSpec(id);
    if (this.baseUpgradeOwned(base, id)) return `${spec.label} is already built`;
    if (spec.requires && !this.baseUpgradeOwned(base, spec.requires)) return `Needs ${baseUpgradeSpec(spec.requires).label} first`;
    if (!isTechUnlocked(base, spec.tech)) return `Research ${techNode(spec.tech)?.name ?? spec.tech} to build ${spec.label}`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    if (base.commandPoints <= 0) return `${base.name} has no action points`;
    return undefined;
  }

  baseUpgradeOwned(base: CombatEntity, id: BaseUpgradeId): boolean {
    if (id === "armor1") return (base.armorLevel ?? 0) >= 1;
    if (id === "armor2") return (base.armorLevel ?? 0) >= 2;
    if (id === "cannon") return base.parts.some((p) => p.id === "cannon");
    return Boolean(base.radarOnline);
  }

  /** Player API: buy a Home Base upgrade (1 base order + its cost). */
  upgradeBaseWith(id: BaseUpgradeId): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    return this.upgradeBaseFor(base, id);
  }

  upgradeBaseFor(base: CombatEntity, id: BaseUpgradeId): boolean {
    const failure = this.baseUpgradeFailureReason(base, id);
    if (failure) return this.reject(failure);
    const spec = baseUpgradeSpec(id);
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    if (id === "armor1" || id === "armor2") {
      base.armorLevel = (base.armorLevel ?? 0) + 1;
      for (const part of base.parts) { part.maxHp = Math.round(part.maxHp * 1.3); part.hp = Math.round(part.hp * 1.3); }
      recomputeStatus(base);
    } else if (id === "cannon") {
      base.parts.push({ id: "cannon", label: "Fortress Cannon", role: "weapon", maxHp: 90, hp: 90, exposed: true });
      base.cannonReadyTurn = this.turn + 1;
      recomputeStatus(base);
    } else {
      base.radarOnline = true;
    }
    this.tally(base.team, `upgrade:${id}`);
    this.pushLog(`${base.name} builds ${spec.label}`);
    return true;
  }

  /** The Fortress Cannon fires by itself every second turn at the most valuable ground foe in reach. Costs the base no order. */
  private queueBaseCannons(): void {
    for (const base of this.entities) {
      if (base.kind !== "base" || !base.status.alive || !base.status.canShoot || (base.cannonReadyTurn ?? Infinity) > this.turn) continue;
      if (this.orders.some((o) => o.actorId === base.id && !o.done)) continue;
      const range = projectileRange(base);
      const foe = this.entities
        .filter((e) => e.team !== base.team && e.team !== "neutral" && e.status.alive && !e.carriedById && !e.flying && e.kind !== "cover" && !isDefenseKind(e.kind) && !isBuildingKind(e.kind) && dist(e.position, base.position) <= range)
        .sort((a, b) => troopSpec(b.kind as TroopKind).cost - troopSpec(a.kind as TroopKind).cost)[0];
      if (foe && this.queueShootFor(base, foe, "center", undefined, true)) { base.cannonReadyTurn = this.turn + 2; this.tally(base.team, "cannon"); }
    }
  }

  private upgradeCommandFor(base: CombatEntity): boolean {
    if (base.kind !== "base") return this.reject("Only the Home Base can be upgraded");
    if (!base.status.alive) return this.reject(`${base.name} is disabled`);
    if (commandUpgradeCost(base) === undefined) return this.reject(`${base.name} command is already upgraded`);
    if (this.money(base.team) < COMMAND_UPGRADE_COST) return this.reject(`Not enough money to upgrade command ($${COMMAND_UPGRADE_COST})`);
    if (base.commandPoints <= 0) return this.reject(`${base.name} has no action points`);
    spendCommandPoint(base);
    this.addMoney(base.team, -COMMAND_UPGRADE_COST);
    base.maxCommandPoints = 2;
    this.pushLog(`${base.name} upgrades to 2 action points per turn`);
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

  // ROTATABLE PLACEMENT (owner 2026-09-24: "for a wall or an air strike a user can turn the direction
  // it goes in"). Quarter-eighths turned from the default (a line strike runs away from the base; a
  // wall faces out from it). Reset whenever a new placement is armed.
  placementTurn = 0;
  rotatePlacement(steps = 1): void {
    this.placementTurn = (((this.placementTurn + steps) % 8) + 8) % 8;
  }
  /** The facing a player placement at `point` will get: away from `from` (the base), plus the turn. */
  placementYaw(from: Vec2, point: Vec2): number {
    return Math.atan2(point.x - from.x, point.z - from.z) + (this.placementTurn * Math.PI) / 4;
  }

  // Arming a placement refuses up front when the order could not be placed ANYWHERE (owner 2026-10-01:
  // a locked Gun Turret armed anyway, then every click in the ring was silently rejected).
  setPendingBuild(kind: DefenseKind | undefined): boolean {
    const blocked = kind && this.buildBlockedReason(this.selected, kind);
    if (blocked) return this.reject(blocked);
    this.placementTurn = 0;
    this.pendingBuild = kind;
    this.intent = kind ? "build" : "select";
    if (kind) {
      this.pendingDeploy = undefined;
      this.pendingSupport = undefined;
    }
    return true;
  }

  // ---- Off-map support powers (airstrike / cluster / orbital lance) ----

  setPendingSupport(kind: SupportPowerKind | undefined): boolean {
    const blocked = kind && this.supportFailureReason(this.selected, kind);
    if (blocked) return this.reject(blocked);
    this.placementTurn = 0;
    this.pendingSupport = kind;
    this.intent = kind ? "support" : "select";
    if (kind) {
      this.pendingBuild = undefined;
      this.pendingDeploy = undefined;
    }
    return true;
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
      return `Research ${tech?.name ?? "the required tech"} to unlock ${spec.label}`;
    }
    if (base.commandPoints <= 0) return `${base.name} has no action points`;
    const cooldown = this.supportCooldown(base, kind);
    if (cooldown > 0) return `${spec.label} on cooldown (${cooldown} turn${cooldown === 1 ? "" : "s"})`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    if (kind === "paradrop" && this.fieldUnitCount(base.team) >= POP_CAP) return `Field is full (${POP_CAP} units)`;
    return undefined;
  }

  // Commit the pending support power at a ground point (the HUD targeting flow). The strike
  // itself flies in during the next resolve; line powers align away from the calling base.
  queueSupportAt(point: Vec2): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    const kind = this.pendingSupport;
    if (!kind) return this.reject("Choose a support power first");
    return this.queueSupportFor(base, kind, point, this.placementTurn);
  }

  // The one path a strike is committed through, for the player's targeting flow and the bot alike.
  private queueSupportFor(base: CombatEntity, kind: SupportPowerKind, point: Vec2, turn = 0): boolean {
    const failure = this.supportFailureReason(base, kind);
    if (failure) return this.reject(failure);
    const spec = supportPowerSpec(kind);
    const target = clampToArena(point);
    const dx = target.x - base.position.x;
    const dz = target.z - base.position.z;
    const len = Math.hypot(dx, dz);
    const straight = len > 0.01 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
    const a = (turn * Math.PI) / 4; // the player's turn of the line, about the target point
    const dir = { x: straight.x * Math.cos(a) + straight.z * Math.sin(a), z: -straight.x * Math.sin(a) + straight.z * Math.cos(a) };
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    base.supportCooldowns = { ...(base.supportCooldowns ?? {}), [kind]: this.supportCooldownFor(base.team, kind) };
    this.queuedSupport.push({ kind, point: target, dir, team: base.team });
    this.tally(base.team, `support:${kind}`);
    this.tally(base.team, "supportCalls");
    if (base.team === "player") {
      this.pendingSupport = undefined;
      this.intent = "select";
    }
    this.pushLog(
      kind === "airstrike" ? `${base.name} tasks a strike wing — bombs on the next resolve`
      : kind === "cluster" ? `${base.name} authorizes a cluster strike — saturation on the next resolve`
      : kind === "laser" ? `${base.name} requests the orbital lance — beam on the next resolve`
      : kind === "reconsweep" ? `${base.name} sends a spotter plane — the enemy's next orders will be revealed`
      : kind === "smokescreen" ? `${base.name} calls smoke on the point — it blooms on the next resolve`
      : kind === "paradrop" ? `${base.name} sends a paradrop — two troopers land on the next resolve`
      : kind === "napalm" ? `${base.name} orders napalm — the point burns on the next resolve`
      : kind === "barrage" ? `${base.name} calls a barrage — six shells on the next resolve`
      : kind === "emp" ? `${base.name} charges an EMP burst — machines in the zone go dark on the next resolve`
      : kind === "minedrop" ? `${base.name} seeds a minefield — mines drop on the next resolve`
      : kind === "medevac" ? `${base.name} scrambles a medevac — the point is patched up on the next resolve`
      : kind === "sentrydrop" ? `${base.name} drops a sentry — it lands on the next resolve`
      : kind === "railstrike" ? `${base.name} lines up a rail strike — three rods on the next resolve`
      : `${base.name} calls a resupply drop — crates land on the next resolve`,
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
      } else if (kind === "reconsweep") {
        // Pure intel: the same reveal the Watch Radar gives, for the caller's side. Set
        // here, after endTurn has cleared last turn's reveal, so it covers the NEXT command phase.
        this.revealedOrders = true;
        this.revealedTeam = call.team ?? "player";
        this.enemyIntentCache = undefined;
        // ...and every foe the spotter plane saw is MARKED for the next turn: the caller's shooters hit them straighter.
        for (const foe of this.entities) {
          if (foe.team === (call.team ?? "player") || foe.team === "neutral" || !foe.status.alive || foe.kind === "cover" || isBuildingKind(foe.kind)) continue;
          foe.markedUntilTurn = this.turn + 1;
          foe.markedById = `recon-${call.team ?? "player"}`;
        }
        const from = clampToArena({ x: point.x - dir.x * 16, z: point.z - dir.z * 16 });
        const to = clampToArena({ x: point.x + dir.x * 16, z: point.z + dir.z * 16 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0x9dd8ff, duration: 1.6 });
      } else if (kind === "smokescreen") {
        this.pendingStrikes.push({ at: 0.9, point, radius: SMOKE_RADIUS, damage: 0, kind: "smokedrop", team: call.team });
      } else if (kind === "paradrop") {
        const from = clampToArena({ x: point.x - dir.x * 16, z: point.z - dir.z * 16 });
        const to = clampToArena({ x: point.x + dir.x * 16, z: point.z + dir.z * 16 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0xbfe8ff, duration: 1.7 });
        this.pendingStrikes.push({ at: 1.0, point, radius: 0, damage: 0, kind: "paradrop", team: call.team });
      } else if (kind === "napalm") {
        // Three firebombs along the run; each leaves the flamer's burning ground (fear and tick free).
        const from = clampToArena({ x: point.x - dir.x * 15, z: point.z - dir.z * 15 });
        const to = clampToArena({ x: point.x + dir.x * 15, z: point.z + dir.z * 15 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0xff8a3a, duration: 1.5 });
        for (let i = 0; i < 3; i += 1) {
          const p = clampToArena({ x: point.x + dir.x * (i - 1) * 1.8, z: point.z + dir.z * (i - 1) * 1.8 });
          this.pendingStrikes.push({ at: 1.0 + i * 0.15, point: p, radius: 1.7, damage: 18, kind: "napalm", team: call.team });
        }
      } else if (kind === "barrage") {
        // Six heavy shells walk across a 4.5m circle, one after another (the map barrage's shell).
        for (let i = 0; i < 6; i += 1) {
          const angle = this.rng.range(0, Math.PI * 2);
          const r = Math.sqrt(this.rng.range(0, 1)) * 4.5;
          const p = clampToArena({ x: point.x + Math.sin(angle) * r, z: point.z + Math.cos(angle) * r });
          this.pendingStrikes.push({ at: 0.9 + i * 0.32, point: p, radius: 1.6, damage: 38, kind: "barrage", team: call.team });
        }
      } else if (kind === "emp") {
        const from = clampToArena({ x: point.x - dir.x * 14, z: point.z - dir.z * 14 });
        const to = clampToArena({ x: point.x + dir.x * 14, z: point.z + dir.z * 14 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0x8de4ff, duration: 1.5 });
        this.pendingStrikes.push({ at: 1.0, point, radius: 4, damage: 0, kind: "emp", team: call.team });
      } else if (kind === "minedrop") {
        const from = clampToArena({ x: point.x - dir.x * 14, z: point.z - dir.z * 14 });
        const to = clampToArena({ x: point.x + dir.x * 14, z: point.z + dir.z * 14 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0xffb02e, duration: 1.5 });
        this.pendingStrikes.push({ at: 1.0, point, radius: 3, damage: 0, kind: "minedrop", team: call.team });
      } else if (kind === "medevac") {
        this.pendingStrikes.push({ at: 1.0, point, radius: 5, damage: 0, kind: "medevac", team: call.team });
      } else if (kind === "sentrydrop") {
        this.pendingStrikes.push({ at: 1.0, point, radius: 1, damage: 0, kind: "sentrydrop", team: call.team });
      } else if (kind === "railstrike") {
        const from = clampToArena({ x: point.x - dir.x * 16, z: point.z - dir.z * 16 });
        const to = clampToArena({ x: point.x + dir.x * 16, z: point.z + dir.z * 16 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0xc9d3dc, duration: 1.4 });
        for (let i = 0; i < 3; i += 1) {
          const p = clampToArena({ x: point.x + dir.x * (i - 1) * 1.5, z: point.z + dir.z * (i - 1) * 1.5 });
          this.pendingStrikes.push({ at: 1.0 + i * 0.18, point: p, radius: 1.25, damage: 95, kind: "railstrike", team: call.team });
        }
      } else if (kind === "resupply") {
        const from = clampToArena({ x: point.x - dir.x * 14, z: point.z - dir.z * 14 });
        const to = clampToArena({ x: point.x + dir.x * 14, z: point.z + dir.z * 14 });
        this.pendingFx.push({ at: 0.2, type: "jet", from, to, color: 0x9ef0b8, duration: 1.5 });
        this.pendingStrikes.push({ at: 1.0, point, radius: RESUPPLY_RADIUS, damage: 0, kind: "resupply", team: call.team });
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

  // Why a structure can't be built ANYWHERE right now (locked, broke, no AP), or undefined if it can.
  buildBlockedReason(base: CombatEntity | undefined, kind: DefenseKind): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base to build defenses";
    if (!base.status.alive) return `${base.name} is disabled`;
    if (base.commandPoints <= 0) return `${base.name} has no action points`;
    const spec = defenseSpec(kind);
    const buildFaction = this.factionOf(base.team);
    if (!buildFaction.defenses.includes(kind)) return `${spec.label} is not a ${buildFaction.name} emplacement`;
    if (spec.tech && !isTechUnlocked(base, spec.tech)) return `Research ${techNode(spec.tech)?.name ?? "the required tech"} to unlock ${spec.label}`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    return undefined;
  }

  // Why a structure can't be placed at a point right now, or undefined if it can.
  buildFailureReason(base: CombatEntity | undefined, kind: DefenseKind, point: Vec2): string | undefined {
    const blockedReason = this.buildBlockedReason(base, kind);
    if (blockedReason || !base) return blockedReason;
    const spec = defenseSpec(kind);
    if (dist(point, base.position) > this.defensePlacementRadius(base)) return `Place ${spec.label} closer to the base`;
    if (terrainHeightAt(point) > 1.2) return "Cannot build on a cliff top";
    const radius = defenseRadius(kind);
    const blocked = this.entities.some((e) => e.status.alive && e.id !== base.id && dist(e.position, point) < e.radius + radius + 0.2);
    if (blocked) return "Spot is blocked by another object";
    if (pointInWater(point)) return "Cannot build in the water";
    if (kind === "minefield" && this.mines.some((m) => m.team === base.team && dist(m, point) < 2.4)) return "There is already a minefield here";
    return undefined;
  }

  // Place a defense for the player at a ground point (used by the HUD build flow).
  queueBuildStructure(point: Vec2): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    const kind = this.pendingBuild;
    if (!kind) return this.reject("Choose a defense to build first");
    const at = clampToArena(point);
    return this.buildStructureFor(base, kind, at, this.placementYaw(base.position, at));
  }

  private buildStructureFor(base: CombatEntity, kind: DefenseKind, point: Vec2, yaw?: number): boolean {
    const failure = this.buildFailureReason(base, kind, point);
    if (failure) return this.reject(failure);
    const spec = defenseSpec(kind);
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    if (kind === "minefield") {
      for (const p of minefieldPoints(point, yaw ?? 0)) this.mines.push({ id: `mine-${++this.effectSeq}`, x: p.x, z: p.z, team: base.team });
      this.pendingBuild = undefined;
      this.intent = "select";
      this.pushLog(`${base.name} lays a minefield`);
      return true;
    }
    if (kind === "sandbag") {
      // Sandbags are COVER, not an emplacement: neutral, so whoever crouches behind them gets the cover.
      const bags = createCover(`cover-sb-${++this.troopSeq}`, COVER_PROFILES.sandbag.label, { ...point }, { coverKind: "sandbag" });
      if (yaw !== undefined) bags.yaw = yaw;
      this.entities.push(bags);
      this.syncEntityElevation(bags);
      this.pendingBuild = undefined;
      this.intent = "select";
      this.pushLog(`${base.name} stacks a sandbag line`);
      return true;
    }
    const structure = this.createDefenseEntity(kind, base, point);
    if (yaw !== undefined) structure.yaw = yaw; // a wall spans across the facing the player turned it to
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
    const structure = makeEmplacement(kind, id, name, base.team, { ...point });
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
    if (!researchFaction.tech.includes(nodeId)) return `${node.name} is not in ${researchFaction.name} research`;
    if (isTechUnlocked(base, nodeId)) return `${node.name} already researched`;
    if (!techPrereqsMet(base, node)) {
      const missing = node.requires.find((req) => !isTechUnlocked(base, req));
      return `${node.name} requires ${techNode(missing ?? "")?.name ?? "a prerequisite"}`;
    }
    // Specializations come in mutually-exclusive pairs: picking one permanently locks the sibling.
    const lockedBy = (base.unlockedTech ?? []).find((owned) => techNode(owned)?.excludes?.includes(nodeId) || node.excludes?.includes(owned));
    if (lockedBy) return `${node.name} is locked out by ${techNode(lockedBy)?.name ?? "your pick"}`;
    if (this.money(base.team) < node.cost) return `Not enough money to research ${node.name} ($${node.cost})`;
    if (base.commandPoints <= 0) return `${base.name} has no action points`;
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
    this.tally(base.team, `research:${nodeId}`);
    this.pushLog(`${base.name} researches ${node.name}`);
    return true;
  }

  // A clear deployment spot just outside the base, fanning out on the unit's own side.
  private freeSpawnNear(base: CombatEntity, unitRadius = 0.5): Vec2 {
    return this.freeSpotNear(base.position, unitRadius, base.radius + unitRadius + 1.1, base.team === "player" ? 1 : -1, base.id);
  }

  /** The nearest clear ground for a unit of `unitRadius`, searched outward in rings from `ring`. */
  private freeSpotNear(center: Vec2, unitRadius: number, ring = 0, forward = 1, ignoreId = ""): Vec2 {
    for (let radius = ring; radius <= ring + 6; radius += 0.8) {
      for (let i = 0; i < 12; i += 1) {
        const angle = (Math.PI * 2 * i) / 12 + (forward > 0 ? 0 : Math.PI);
        const point = clampToArena({
          x: center.x + Math.sin(angle) * radius,
          z: center.z + Math.cos(angle) * radius,
        });
        const blocked = this.entities.some((e) => e.id !== ignoreId && e.status.alive && !e.carriedById && dist(e.position, point) < e.radius + unitRadius + SPAWN_GAP)
          || onTerrainEdge(point, spawnClearance(unitRadius));
        if (!blocked) return point;
        if (radius === 0) break; // the centre itself is one sample, not twelve
      }
    }
    return clampToArena({ x: center.x + forward * ring, z: center.z });
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

  /** Where a queued order's line should END: the part it was aimed at (a head shot ends at the head), not the unit's middle. */
  orderAimPoint(order: TacticalOrder): { point: Vec2; height: number } | undefined {
    const target = order.targetId ? this.entity(order.targetId) : undefined;
    const part = target && order.targetPartId ? target.parts.find((p) => p.id === order.targetPartId) : undefined;
    return target && part ? { point: aimPointFor(target, part), height: aimHeightFor(target, part) } : undefined;
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
      // A dug-in target (Bastion) takes its multiplier inside applyDamage; the preview shows it too.
      amount: ground || smoke ? 0 : Math.round(this.estimateShotDamage(actor, impactTarget, impactPart, aim, Boolean(cover), attackMode) * (attackMode === "weapon" ? burstCount(actor) : 1) * (impactTarget.dugIn ?? 1)),
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
    this.queueSentryOrders();
    this.queueBaseCannons();
    this.revealedOrders = false; // the pulse covered exactly this one enemy command
    this.enemyIntentCache = undefined;
    // HULL DOWN. A tank with no move/ram order this resolve settles in and takes 30% less damage
    // until it moves. Decided here so the enemy AI's tanks get it on the same terms.
    // DEPLOY. Artillery that does not move this resolve plants its outriggers (it can fire from
    // next turn); artillery that moves packs them up. Same terms for both sides.
    // DIG IN (Bastion doctrine). A ground unit of a digging faction that holds position (no order
    // that moves it) spends that resolve DIGGING, and from the next resolve it holds it is DUG IN;
    // any move climbs it out and it starts over. Digging takes a turn on purpose: dug in the same
    // turn it stopped, every Bastion unit that stood and fired was armoured, and AI-vs-AI games had
    // Bastion winning 33 of 52. Tanks have hull-down instead (the two never stack), and a thrown
    // body is dug out in applyKnockback.
    for (const e of this.entities) {
      if (!e.status.alive || e.flying || e.carriedById || e.kind === "tank" || !isTroopKind(e.kind)) continue;
      const digIn = this.factionOf(e.team).doctrine.digIn;
      const moving = this.orders.some((o) => o.actorId === e.id && !o.done && MOVING_ORDERS.has(o.kind));
      if (!digIn || moving) { e.dugIn = undefined; e.digging = undefined; continue; }
      if (e.digging && !e.dugIn) {
        e.dugIn = digIn;
        this.pushLog(`${e.name} digs in`);
      }
      e.digging = true;
    }
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
    const entity = kind === "base" ? createBase(id, "Home Base", team, at) : makeEmplacement(kind, id, defenseSpec(kind).label, team, at);
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
    // The outgoing seat's planning lines ("Recruit 3 queued move", "moves to cover ...") would tell
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
    const unit = makeTroop(kind, id, options.bossName ?? `${this.troopLabel(team, kind)} ${this.troopSeq}`, team, clampToArena(position));
    // Placement bypasses the movement rules, so a ground unit could otherwise be dropped into a
    // water channel that movement would never have let it enter.
    if (!unit.flying) unit.position = nearestDryPoint(unit.position);
    this.applyFactionMods(unit);
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
    const structure = makeEmplacement(kind, id, name, team, point);
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
        detonated?: string[]; toppled?: string[];
        wrecked?: string[]; salvage?: [string, number][];
        burnZones?: { id: string; x: number; z: number; radius: number; turnsLeft: number; damage?: number }[];
        gasClouds?: { id: string; x: number; z: number; radius: number; maxRadius: number }[];
        smokeClouds?: { id: string; x: number; z: number; radius: number; turnsLeft: number }[];
        revealedOrders?: boolean;
        revealedTeam?: Team;
        queuedSupport?: { kind: SupportPowerKind; point: Vec2; dir: Vec2; team?: Team }[];
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
      // A unit retired since the save was made (2026-10-06: Trencher, Drone Operator, Bounty Hunter, Transport, Fortifier,
      // Demolitionist) is dropped, not resurrected as a kind the game no longer knows how to run or draw.
      this.entities.splice(0, this.entities.length, ...data.entities.filter((e) => unitStats(e.kind) !== undefined));
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
      // Restore which volatile covers already blew up, so a destroyed-but-still-present cover
      // caught in a later blast doesn't detonate a second time after a save/load.
      this.detonated.clear();
      for (const id of data.detonated ?? []) this.detonated.add(id);
      this.toppled.clear();
      for (const id of data.toppled ?? []) this.toppled.add(id);
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
      this.queuedSupport = (data.queuedSupport ?? []).map((c) => ({ kind: c.kind, point: { ...c.point }, dir: { ...c.dir }, team: c.team }));
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
    // A crew faces where its gun faces.
    for (const post of this.entities) {
      const crew = post.occupantId ? this.entity(post.occupantId) : undefined;
      if (crew && post.status.alive) crew.yaw = post.yaw;
    }

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

  private queueShootFor(actor: CombatEntity, target: CombatEntity, aim: AimMode, partId?: string, free = false): boolean {
    if (!actor.status.canShoot) return this.reject(`${actor.name} cannot shoot`);
    if (actor.kind === "artillery" && !actor.deployed) return this.reject(`${actor.name} must deploy before it can fire`);
    if (actor.kind === "runabout" && !(actor.passengerIds?.length)) return this.reject(`${actor.name}'s gun needs a gunner aboard`);
    if (this.isPowerCut(actor)) return this.reject(`${actor.name} has no power — the conduit is cut`);
    // Ground units CAN shoot up at flyers -- that is the anti-air. (A gunship's autocannon also rakes ground targets; the bomber has no gun.)
    const requestedPart = partId ? this.targetableParts(target).find((part) => part.id === partId) : undefined;
    if (partId && !requestedPart) return this.reject(`${target.name} does not have that targetable part`);
    const targetPart = requestedPart ?? preferredPart(target, aim);
    if (this.previewAttack(actor.id, target.id, targetPart.id, "weapon")?.blockedBySmoke) return this.reject(`${target.name} is hidden by smoke`);
    if (!free && !spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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

  private queueGrenadeFor(actor: CombatEntity, target: CombatEntity, aim: AimMode, partId?: string): boolean {
    const failure = this.grenadeFailureReason(actor, target);
    if (failure) return this.reject(failure);
    const requestedPart = partId ? this.targetableParts(target).find((part) => part.id === partId) : undefined;
    if (partId && !requestedPart) return this.reject(`${target.name} does not have that targetable part`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
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
    this.pushLog(`${this.entity(order.actorId)?.name ?? "Unit"} queued ${orderLabel(order, this.entity(order.actorId), this.entity(order.targetId)).text}`);
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

    if (order.kind === "detonate") {
      if (!order.fired && order.elapsed >= 0.4) {
        order.fired = true;
        if (actor.status.alive) this.resolveExplosion(actor, actor);
      }
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "slam") {
      // THE HAMMER: at the top of the swing every foe within SLAM_RADIUS is hurt and flung (armour barely moves).
      if (!order.fired && order.elapsed >= 0.35) {
        order.fired = true;
        this.effect("land", { ...actor.position }, { ...actor.position }, 0xd9cfbf, 0.7, SLAM_RADIUS);
        this.effect("blast", { ...actor.position }, { ...actor.position }, 0xffc27a, 0.5, 1.4);
        let hit = 0;
        for (const e of this.entities) {
          if (e.team === actor.team || e.team === "neutral" || !e.status.alive || e.flying || e.carriedById || isBuildingKind(e.kind) || e.kind === "cover") continue;
          if (dist(e.position, actor.position) > SLAM_RADIUS + e.radius) continue;
          const part = preferredPart(e, "center");
          const result = applyDamage(e, part.id, Math.round(SLAM_DAMAGE * this.teamDamageScale(actor) * (isInfantryKind(e.kind) ? 1 : 0.45) * (e.dugIn ?? 1)));
          this.effect("strike", { ...actor.position }, { ...e.position }, 0xffd9a0, 0.5, e.radius + 0.4);
          this.afterDamage(actor, e, result, "Slam");
          this.applyKnockback(actor, e, actor.position, 150, 1, { ringOut: true, maxThrow: SLAM_THROW });
          this.tally(actor.team, "slams");
          hit += 1;
        }
        this.pushLog(hit ? `${actor.name} swings the hammer: ${hit} thrown` : `${actor.name} swings the hammer at the air`);
      }
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
      if (canJump(actor) || order.leap) {
        // THE JUMP. Airborne for the whole leap (so it is a flyer to targeting and mines), on a
        // sine arc whose height scales with the distance, and back on the ground the moment it
        // lands. The order's own progress drives the arc, so it can never desync from the move.
        const total = Math.max(0.01, dist(order.start, order.destination));
        // A trooper's hop is slower and lower than a jet pack's: a few metres, a bit over a second.
        actor.position = moveToward(actor.position, order.destination, order.leap ? LEAP_SPEED * dt : moveSpeed(actor) * 1.15 * dt);
        const progress = clamp(1 - dist(actor.position, order.destination) / total, 0, 1);
        const landed = dist(actor.position, order.destination) < 0.08;
        actor.flying = !landed;
        actor.agl = landed ? undefined : Math.sin(progress * Math.PI) * (order.leap ? Math.min(1.9, 0.7 + total * 0.22) : Math.min(4.2, 1.2 + total * 0.28));
        this.syncEntityElevation(actor);
        actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
        if (landed) {
          this.separateFromUnits(actor, order.destination);
          this.syncEntityElevation(actor);
          this.effect("land", actor.position, actor.position, 0xbfe9ff, 0.5, actor.radius * 1.3);
          // SLAM LANDING (the jump trooper's identity; an ordinary hop lands softly): anyone hostile within a stride is knocked back and hurt.
          for (const other of canJump(actor) ? this.entities : []) {
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
      this.checkMines(actor);
      this.checkPickups(actor);
      if (dist(actor.position, order.destination) < 0.08) {
        order.done = true;
        // A drop off a ledge can end flush against the face it dropped from (movement oracle, ironworks): back it off like a
        // halt, and if there is no clear spot on the way, it never left (a trooper does not walk into a wall to finish a move).
        if (!actor.flying && order.start) {
          this.settleHalt(actor, order.start);
          if (hullInRise(actor.position, actor.radius * 0.9) && !hullInRise(order.start, actor.radius * 0.9)) {
            actor.position = { ...order.start };
            this.syncEntityElevation(actor);
          }
        }
      }
      else if (order.elapsed >= order.duration) {
        // Out of time SHORT of the stop (shoved, or the move began late): that halt point was never
        // checked, so back it off a rise like the planned stop was (a hull ended half inside an
        // Ironworks step, movement.test.ts 2026-10-01).
        order.done = true;
        if (!actor.flying && order.start) this.settleHalt(actor, order.start);
      }
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
        // The aircraft turns to its target; a carpet is laid along that line.
        if (dist(order.destination, actor.position) > 0.05) actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
        if (order.elapsed >= ATTACK_FIRE_AT) {
          order.fired = true;
          if (order.kind === "grenade" && actor.kind === "bomber") {
            // CARPET: a bomber lays its load in a line across the picked spot, along its heading to it: one bomb short, one on it, one past.
            for (const point of carpetDropPoints(actor, order.destination)) order.projectileId = this.launchGrenadeAtPoint(order, actor, point);
            this.pushLog(`${actor.name} carpets the line with ${CARPET_BOMBS} bombs`);
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
      if (order.elapsed >= ATTACK_FIRE_AT) {
        order.fired = true;
        order.projectileId = this.launchProjectile(order, actor, target);
      }
      return;
    }

    // Airlift: fly to a friendly ground unit and take it aboard.
    if (order.kind === "load") {
      const passenger = this.entity(order.targetId);
      if (!passenger || !passenger.status.alive || passenger.carriedById || !actor.status.canMove || (actor.passengerIds?.length ?? 0) >= carrierCapacity(actor.kind)) {
        order.done = true;
        return;
      }
      actor.yaw = Math.atan2(passenger.position.x - actor.position.x, passenger.position.z - actor.position.z);
      if (dist(actor.position, passenger.position) <= actor.radius + passenger.radius + 0.7) {
        (actor.passengerIds ??= []).push(passenger.id);
        passenger.carriedById = actor.id;
        passenger.dugIn = undefined;
        passenger.digging = undefined;
        passenger.position = { ...actor.position };
        this.syncEntityElevation(passenger);
        this.pushLog(isGroundCarrier(actor.kind) ? `${passenger.name} boards ${actor.name}` : `${actor.name} airlifts ${passenger.name} aboard`);
        if (actor.kind === "runabout" && (actor.passengerIds?.length ?? 0) >= 5) this.tally(actor.team, "fullcar");
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
      // A Runabout does not drive to the point: the ramp drops where it stands, beside the hull.
      if (isGroundCarrier(actor.kind) || dist(actor.position, order.destination) <= actor.radius + 0.5 || order.elapsed >= order.duration) {
        this.dropPassengers(actor);
        order.done = true;
        return;
      }
      actor.position = moveToward(actor.position, order.destination, moveSpeed(actor) * dt);
      this.syncEntityElevation(actor);
      return;
    }

    const target = this.entity(order.targetId);
    if (order.kind === "man") {
      if (!target || !target.status.alive || !actor.status.canMove) { order.done = true; return; }
      actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
      // The crew stands BEHIND the gun (the post's back is -z of its facing), not wherever it happened to arrive.
      const behind = target.radius + actor.radius + 0.1;
      const seatAt = { x: target.position.x - Math.sin(target.yaw) * behind, z: target.position.z - Math.cos(target.yaw) * behind };
      if (!order.fired && dist(actor.position, seatAt) > 0.12) {
        actor.yaw = Math.atan2(seatAt.x - actor.position.x, seatAt.z - actor.position.z);
        const want = moveToward(actor.position, seatAt, Math.min(dist(actor.position, seatAt), moveSpeed(actor) * 1.3 * dt));
        if (this.blockedBySteepTerrain(actor, actor.position, want, undefined, dist(actor.position, want), true)) { order.done = true; this.pushLog(`${actor.name} cannot reach ${target.name}`); return; }
        actor.position = want;
        this.separateFromUnits(actor);
        this.syncEntityElevation(actor);
        this.checkMines(actor);
        this.checkPickups(actor);
        order.elapsed = 0;
        return;
      }
      if (!order.fired) {
        order.fired = true;
        const crew = this.entity(target.occupantId);
        if (crew && crew.id !== actor.id && crew.status.alive) { order.done = true; return; } // beaten to it
        target.occupantId = actor.id;
        target.team = actor.team;
        actor.position = seatAt;
        actor.yaw = target.yaw;
        actor.stance = "crouched";
        this.defending.add(actor.id);
        this.effect("ping", target.position, target.position, 0x8de4ff, 0.8, target.radius + 0.6);
        this.pushLog(`${actor.name} mans ${target.name}`);
      }
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }
    if (!target || !target.status.alive || !actor.status.canMove) {
      order.done = true;
      return;
    }

    if (order.kind === "melee") {
      if (!order.start) order.start = { ...actor.position };
      actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
      // CHARGE: a striker closes the gap first (a real move — mines apply) and the
      // swing clock only starts once the blade is in reach.
      const swingReach = unitStats(actor.kind).meleeRange + actor.radius + target.radius;
      if (!order.fired && dist(actor.position, target.position) > swingReach + 0.05) {
        const gap = dist(actor.position, target.position) - swingReach;
        const want = moveToward(actor.position, target.position, Math.min(gap, moveSpeed(actor) * 1.6 * dt));
        // A charge never runs into a rise: it stops at the foot of the step (the oracle caught a striker ending hull-deep in one).
        if (this.blockedBySteepTerrain(actor, actor.position, want, undefined, dist(actor.position, want), true)) {
          order.done = true;
          this.pushLog(`${actor.name}'s charge is stopped by the terrain`);
          return;
        }
        actor.position = want;
        this.separateFromUnits(actor);
        this.syncEntityElevation(actor);
          this.checkMines(actor);
        order.elapsed = 0;
        return;
      }
      if (!order.fired && order.elapsed >= 0.36) {
        order.fired = true;
        if (order.shove) this.resolveShove(actor, target);
        else this.resolveMelee(actor, target, order.targetPartId);
      }
      if (order.elapsed >= order.duration) { order.done = true; this.backOffRise(actor, order.start); }
      return;
    }

    // RAM. The tank charges to CONTACT and stops there. It used to keep driving at the target's centre
    // for the whole order, with no step check and no separation -- a ram that did not destroy its target
    // left the tank parked inside it (a wreck, a crate), and a charge could climb a cliff face
    // (movement.test.ts). Now it moves like every other mover: up to contact, never into a step.
    actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
    const contact = actor.radius + target.radius + 0.25;
    if (!order.fired) {
      const step = Math.min(Math.max(0, dist(actor.position, target.position) - contact), moveSpeed(actor) * 1.25 * dt);
      if (step > 0) {
        const want = moveToward(actor.position, target.position, step);
        if (this.blockedBySteepTerrain(actor, actor.position, want, undefined, step, true)) {
          order.fired = true; // the charge stalls against the step; nothing is hit
          order.done = true;
          this.pushLog(`${actor.name}'s ram is stopped by the terrain`);
          return;
        }
        actor.position = want;
        this.separateFromUnits(actor);
        this.syncEntityElevation(actor);
        this.checkMines(actor);
        this.checkPickups(actor);
      }
      if (dist(actor.position, target.position) <= contact + 0.05) {
        order.fired = true;
        this.resolveRam(actor, target);
      }
    }
    if (order.elapsed >= order.duration) order.done = true;
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
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
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
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    const projected = this.projectedActorForPreview(actor);
    const origin = muzzlePoint(projected, "grenade");
    if (dist(origin, point) > grenadeThrowRange(actor)) return `Out of range: it reaches ${grenadeThrowRange(actor)}m`;
    return undefined;
  }

  private blockedMoveDestination(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId?: string, silent = false): Vec2 {
    const stop = this.blockedMoveStop(actor, start, destination, allowedCoverId, silent);
    return actor.flying || canJump(actor) ? stop : settleClearOfRises(start, stop, spawnClearance(actor.radius), actor.radius * 0.9);
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
    const startHullIn = hullInRise(start, actor.radius * 0.9);
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

      // A unit already pressed against a face may walk AWAY or along it (the centre-line fallback), but
      // never walk its hull INTO the rock (movement.test.ts, 2026-10-02).
      if (!useFootprint && !startHullIn && hullInRise(point, actor.radius * 0.9)) {
        if (!silent) this.pushLog(`${actor.name} must use a cliff ascent`);
        return lastClear;
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

  private launchGrenadeAtPoint(order: TacticalOrder, actor: CombatEntity, point: Vec2): string {
    this.syncEntityElevation(actor);
    // An aircraft's bomb leaves the rack under the airframe and falls steeply onto the picked spot (it does not arc up, and it is too fast
    // to be shot down).
    const airDrop = isAirBomber(actor);
    const dropPoint = point;
    const origin = muzzlePoint(actor, "grenade");
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
      ignoredEntityIds: airDrop ? this.entities.filter((e) => e.flying).map((e) => e.id) : [], // a bomb can't hit aircraft: it falls past one hovering beside the rack
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
    this.collideProjectilesInAir();
  }

  // MID-AIR COLLISIONS (owner 2026-10-02): rounds from OPPOSED sides that cross each other this step
  // meet in the air. A grenade or shell that is hit goes off where it was hit; two plain rounds cancel.
  // (Bombs dropped from aircraft fall too steeply and fast to be shot down, and smoke rounds are inert.)
  private collideProjectilesInAir(): void {
    if (this.projectiles.length < 2) return;
    const team = (p: Projectile): Team | undefined => this.entity(p.actorId)?.team;
    const live = this.projectiles.filter((p) => p.state === "flying" && !p.smoke && !(p.kind === "grenade" && p.originHeight > 2));
    const gone = new Set<string>();
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i], b = live[j];
        if (gone.has(a.id) || gone.has(b.id)) continue;
        const ta = team(a), tb = team(b);
        if (!ta || !tb || ta === tb) continue;
        // Closest approach over this step, sampled (both rounds advanced by the same dt).
        let closest = Infinity;
        let meet: Vec2 = a.position;
        let meetHeight = a.height;
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
          const ax = a.previous.x + (a.position.x - a.previous.x) * t, az = a.previous.z + (a.position.z - a.previous.z) * t;
          const bx = b.previous.x + (b.position.x - b.previous.x) * t, bz = b.previous.z + (b.position.z - b.previous.z) * t;
          const ah = a.previousHeight + (a.height - a.previousHeight) * t, bh = b.previousHeight + (b.height - b.previousHeight) * t;
          const d = Math.hypot(ax - bx, az - bz, ah - bh);
          if (d < closest) { closest = d; meet = { x: (ax + bx) / 2, z: (az + bz) / 2 }; meetHeight = (ah + bh) / 2; }
        }
        if (closest > PROJECTILE_COLLIDE_RADIUS) continue;
        gone.add(a.id); gone.add(b.id);
        this.collideProjectiles(a, b, meet, meetHeight);
      }
    }
  }

  private collideProjectiles(a: Projectile, b: Projectile, meet: Vec2, height: number): void {
    const nameOf = (p: Projectile): string => this.entity(p.actorId)?.name ?? "A shot";
    if (this.entity(a.actorId)?.team === "player" || this.entity(b.actorId)?.team === "player") this.tally("player", "clashes");
    const explosive = (p: Projectile): boolean => p.kind === "grenade" || p.kind === "shell";
    const family = explosive(a) || explosive(b) ? CLASH_BLAST : a.kind === "bolt" || b.kind === "bolt" || a.sourceKind === "sniper" || b.sourceKind === "sniper" ? CLASH_BOLT : CLASH_SPARK;
    this.effect("clash", { ...meet }, { ...meet }, family, 0.7, family === CLASH_BLAST ? 1.6 : family === CLASH_BOLT ? 1.1 : 0.7, height);
    for (const p of [a, b]) {
      const actor = this.entity(p.actorId);
      const order = this.orders.find((o) => o.id === p.orderId);
      if (explosive(p) && actor) {
        const other = p === a ? b : a;
        this.pushLog(`${nameOf(other)}'s round shoots down ${nameOf(p)}'s ${this.roundWord(actor)} in mid-air`);
        // It goes off where it was hit: the same blast, at the point below the meeting.
        this.detonateGroundTarget(p, actor, order, { ...meet });
      } else {
        this.removeProjectile(p.id);
        if (order) order.done = true;
      }
    }
    if (!explosive(a) && !explosive(b)) {
      // A burst of rounds meeting is one line a turn per pair, not one line per bullet.
      const key = [a.actorId, b.actorId].sort().join("|");
      if (this.clashLogTurn.get(key) !== this.turn) {
        this.clashLogTurn.set(key, this.turn);
        this.pushLog(`${nameOf(a)}'s and ${nameOf(b)}'s rounds collide in mid-air`);
      }
    }
  }

  /** What a thrown or lobbed explosive is CALLED in the log: a bomber drops bombs, a soldier or grenadier throws grenades, everything else (mortar, artillery, tank, posts) fires shells. */
  private roundWord(actor: CombatEntity | undefined): "bomb" | "grenade" | "shell" {
    if (actor && isAirBomber(actor)) return "bomb";
    return actor && (actor.kind === "soldier" || actor.kind === "grenadier") ? "grenade" : "shell";
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
    // Off the board = a miss. A round that sailed past its target used to fly on over the outer plain
    // until its range ran out (12m+ past the rim, movement.test.ts).
    const { minX, maxX, minZ, maxZ } = ARENA_BOUNDS;
    if (next.x < minX - 1 || next.x > maxX + 1 || next.z < minZ - 1 || next.z > maxZ + 1) this.expireProjectile(projectile);
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
      this.pushLog(`${actor.name}'s ${this.roundWord(actor)} skips and rolls${intendedTarget ? ` short of ${intendedTarget.name}` : ""}`);
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
    const raw = {
      x: projectile.position.x + projectile.direction.x * speed * dt,
      z: projectile.position.z + projectile.direction.z * speed * dt,
    };
    // A grenade that rolls to the board edge goes off there. Clamping it back inside made it jump
    // BACKWARDS a step (movement.test.ts: "moved against its own direction").
    const next = clampToArena(raw);
    if (next.x !== raw.x || next.z !== raw.z) {
      this.detonateRollingGrenade(projectile, actor, intendedTarget, order);
      return;
    }
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
    this.pushLog(`${actor.name}'s ${this.roundWord(actor)} rolls and explodes${intendedTarget ? ` near ${intendedTarget.name}` : ""}`);
    const rolling = explosiveBlast("grenade", actor.kind);
    this.effect("blast", point, point, 0xffbf69, 0.78, rolling.radius - 0.2);
    this.applyExplosiveRadius(actor, point, rolling.radius, rolling.damage, `${actor.name}'s rolling blast`, rolling.maxThrow);
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
    const blast = explosiveBlast(projectile.kind, actor.kind);
    const word = this.roundWord(actor);
    const blastPoint = { ...point };
    this.pushLog(`${actor.name}'s ${word} explodes at the marked spot`);
    this.effect("blast", blastPoint, blastPoint, 0xffbf69, 0.78, blast.radius);
    this.applyExplosiveRadius(actor, blastPoint, blast.radius, blast.damage, `${actor.name}'s ${word} blast`, blast.maxThrow);
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
    const burst = explosiveBlast(projectile.kind, actor.kind);
    const big = projectile.kind === "grenade";
    this.pushLog(`${actor.name}'s ${this.roundWord(actor)} bursts near ${trigger.name}`);
    this.effect("blast", point, point, big ? 0xffbf69 : 0xffd166, 0.72, big ? burst.radius - 0.3 : 1.6);
    // The airburst reads where the sheltering target STANDS, so it comes before the blast throws that target away from the cover.
    if (trigger.kind === "cover") this.airburstBehindCover(actor, projectile, trigger);
    this.applyExplosiveRadius(actor, point, big ? burst.radius : 1.75, big ? burst.damage : 26, `${trigger.name} is caught in the blast`, big ? burst.maxThrow : undefined);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  // AIRBURST. A grenadier round that bursts on (or fuses beside) a cover piece still comes down on
  // whoever is sheltering right behind it: the intended target takes half of the direct hit the
  // cover just spared it. Cover is half protection against the launcher, not full.
  private airburstBehindCover(actor: CombatEntity, projectile: Projectile, cover: CombatEntity): void {
    if (actor.kind !== "grenadier") return;
    const target = this.entity(projectile.targetId);
    if (!target || target.id === cover.id || !target.status.alive || target.flying) return;
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
      // A rocket or shell that HITS a trooper throws it backwards, away from the shooter (a tank, a wall or a gun does not budge).
      if (!cover && target.status.alive && isInfantryKind(target.kind)) this.applyKnockback(actor, target, projectile.origin, Math.max(amount, 36) * 1.2, 1, { maxThrow: 7 });
    } else {
      this.effect("impact", target.position, target.position, result.destroyed ? 0xffd166 : 0xffffff, 0.42, target.radius);
    }
    // FLAMES: a flamethrower hit sets a trooper alight (three turns of fire); machines shrug it off.
    if (!cover && (actor.kind === "flamer" || actor.kind === "flamepost") && result.amount > 0) this.ignite(target, `${actor.name}'s flames`);
    // RICOCHET: the round glances on to up to two more foes near the first (60% then 40% of the hit).
    if (!cover && unitStats(actor.kind).chain && result.amount > 0) this.chainArc(actor, target, amount);
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

  /** The ricochet rifle's chain: from the foe it hit to the nearest two others within CHAIN_RADIUS. */
  private chainArc(actor: CombatEntity, first: CombatEntity, amount: number): void {
    const shares = [0.6, 0.4];
    const next = this.entities
      .filter((e) => e.id !== first.id && e.team !== actor.team && e.team !== "neutral" && e.status.alive && !e.carriedById && e.kind !== "cover" && !isBuildingKind(e.kind) && dist(e.position, first.position) <= CHAIN_RADIUS + e.radius)
      .sort((a, b) => dist(a.position, first.position) - dist(b.position, first.position))
      .slice(0, 2);
    let from = first;
    next.forEach((e, i) => {
      const result = applyDamage(e, preferredPart(e, "center").id, Math.max(4, Math.round(amount * shares[i])));
      this.effect("impact", { ...from.position }, { ...e.position }, 0xffd27a, 0.4, e.radius); // sparks fly back along the glancing line
      this.tally(actor.team, "ricochets");
      this.pushLog(`${actor.name}'s round ricochets on to ${e.name}`);
      this.afterDamage(actor, e, result);
      from = e;
    });
  }

  private removeProjectile(id: string): void {
    const index = this.projectiles.findIndex((projectile) => projectile.id === id);
    if (index < 0) return;
    const projectile = this.projectiles[index];
    // Flamer rounds torch the ground where they end: burning terrain for the next turns.
    if (projectile.sourceKind === "flamer" || projectile.sourceKind === "flamepost") {
      const point = clampToArena({ ...projectile.position });
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: point.x, z: point.z, radius: BURN_RADIUS, turnsLeft: BURN_TURNS });
      this.effect("blast", point, point, 0xff7a2a, 0.6, BURN_RADIUS);
    }
    this.projectiles.splice(index, 1);
  }

  // Burning ground: at the start of each turn, everything standing in a burn zone takes
  // fire damage (both teams — fire doesn't check dog tags). Crouching doesn't help; move.
  /** Sets a trooper alight (infantry only: machines, aircraft and structures do not burn). */
  private ignite(e: CombatEntity, why: string): void {
    if (!e.status.alive || e.flying || !isInfantryKind(e.kind) || pointInWater(e.position)) return;
    if (!e.burning) this.pushLog(`${e.name} is on fire (${why})`);
    if (!e.burning && e.team === "enemy") this.tally("player", "burned");
    e.burning = { turns: BURN_STATUS_TURNS, dmg: BURN_STATUS_DAMAGE };
    this.effect("ping", { ...e.position }, { ...e.position }, 0xff7a2a, 0.6, e.radius + 0.4);
  }

  /** Each burning trooper takes its fire damage at turn start; water puts it out. */
  private runBurningTick(): void {
    for (const e of this.entities) {
      if (!e.burning || !e.status.alive) { if (e.burning) e.burning = undefined; continue; }
      if (pointInWater(e.position)) { e.burning = undefined; this.pushLog(`${e.name} puts the fire out in the water`); continue; }
      applyDamage(e, preferredPart(e, "center").id, e.burning.dmg);
      this.effect("impact", { ...e.position }, { ...e.position }, 0xff7a2a, 0.5, e.radius + 0.3);
      this.pushLog(`${e.name} burns (${e.burning.dmg})`);
      e.burning.turns -= 1;
      if (e.burning.turns <= 0) e.burning = undefined;
      if (!e.status.alive) this.checkEndState();
    }
  }

  private runBurnTick(): void {
    this.runBurningTick();
    if (!this.burnZones.length) return;
    for (const zone of this.burnZones) {
      for (const e of this.entities) {
        if (!e.status.alive || e.kind === "base" || e.flying) continue; // flyers are above the flames
        if (dist(e.position, zone) > zone.radius + e.radius * 0.5) continue;
        const part = preferredPart(e, "center");
        const burn = zone.damage ?? BURN_DAMAGE;
        applyDamage(e, part.id, burn);
        this.effect("impact", { ...e.position }, { ...e.position }, 0xff7a2a, 0.5, e.radius + 0.3);
        this.pushLog(`${e.name} is burned by the fire (${burn})`);
        this.ignite(e, "standing in flames");
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
        if (!e.status.alive || e.kind === "cover" || e.kind === "base" || isDefenseKind(e.kind) || e.flying || isVehicleKind(e.kind)) continue;
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

  // ---- Manned emplacements: man, dismount ----

  /** Why `actor` cannot crew `mount` (undefined when it can). */
  manFailureReason(actor: CombatEntity | undefined, mount: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (!isInfantryKind(actor.kind)) return "Only infantry can crew an emplacement";
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    if (!actor.status.canMove) return `${actor.name} cannot move`;
    if (!mount || !isMountKind(mount.kind)) return "Pick a manned emplacement";
    if (!mount.status.alive) return `${mount.name} is wrecked`;
    if (mount.team !== "neutral" && mount.team !== actor.team) return `${mount.name} belongs to the enemy`;
    const crew = this.entity(mount.occupantId);
    if (crew && crew.status.alive && crew.id !== actor.id) return `${mount.name} is already crewed`;
    if (this.orders.some((o) => o.kind === "man" && o.targetId === mount.id && o.actorId !== actor.id && !o.done)) return `${mount.name} is already being manned`;
    const projected = this.projectedActorForPreview(actor);
    if (dist(projected.position, mount.position) > moveRange(actor) + mount.radius + actor.radius + MOUNT_CREW_REACH) return `${mount.name} is out of reach`;
    return undefined;
  }

  /** Player API: walk up to an emplacement and crew it. It fires from next turn, with the crew's turn spent on it. */
  queueMan(mountId: string): boolean {
    const actor = this.requirePlayerActor();
    const mount = this.entity(mountId);
    const failure = this.manFailureReason(actor, mount);
    if (failure) return this.reject(failure);
    if (!actor || !mount) return false;
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    this.addOrder({ actorId: actor.id, kind: "man", targetId: mountId, aim: "center", duration: 1.0 });
    return true;
  }

  private queueManFor(actor: CombatEntity, mount: CombatEntity): boolean {
    if (this.manFailureReason(actor, mount) || !spendCommandPoint(actor)) return false;
    this.addOrder({ actorId: actor.id, kind: "man", targetId: mount.id, aim: "center", duration: 1.0 });
    return true;
  }

  /** Player API: the selected, crewed emplacement lets its crew go (free; the crew rests this turn). */
  queueDismount(): boolean {
    const mount = this.selected;
    if (!mount || mount.team !== "player" || !isMountKind(mount.kind)) return this.reject("Select a crewed emplacement");
    if (!mount.occupantId) return this.reject(`${mount.name} has no crew`);
    const crew = this.entity(mount.occupantId);
    if (crew && crew.commandPoints <= 0) return this.reject(`${crew.name} has no action left to climb out`);
    if (crew) crew.commandPoints = Math.max(0, crew.commandPoints - 1); // leaving costs the crew one action
    this.freeMount(mount, true);
    return true;
  }

  private freeMount(mount: CombatEntity, log = false): void {
    const crew = this.entity(mount.occupantId);
    mount.occupantId = undefined;
    mount.commandPoints = 0;
    mount.maxCommandPoints = 1;
    if (crew && log) this.pushLog(`${crew.name} leaves ${mount.name}`);
  }

  /** Crews that died, fled or were thrown clear leave their post; a crewed post acts, its crew rests. Runs at turn start. */
  private refreshMounts(): void {
    for (const mount of this.entities) {
      if (!isMountKind(mount.kind)) continue;
      const crew = this.entity(mount.occupantId);
      const here = crew && crew.status.alive && !crew.carriedById
        && dist(crew.position, mount.position) <= mount.radius + crew.radius + MOUNT_CREW_REACH;
      if (!mount.status.alive || !here) { mount.occupantId = undefined; mount.commandPoints = 0; continue; }
      mount.team = crew!.team; // a post belongs to whoever crews it
      crew!.commandPoints = 1; // the crew keeps ONE action, for leaving; the gun's turn is its own
      mount.maxCommandPoints = 2; // a crewed post fires twice a turn
      mount.commandPoints = mount.status.canShoot ? 2 : 0;
    }
  }

  /** A mirrored pair of neutral Gun Posts on the flanks, free for whoever walks up and crews one. */
  private placeFieldMounts(): void {
    for (let i = this.entities.length - 1; i >= 0; i -= 1) {
      const e = this.entities[i];
      if (e.team === "neutral" && isMountKind(e.kind)) this.entities.splice(i, 1);
    }
    const c = mapCenter(this.mapDef);
    const a = this.entities.find((e) => e.kind === "base" && e.team === "player");
    const b = this.entities.find((e) => e.kind === "base" && e.team === "enemy");
    if (!a || !b) return;
    const axis = normalize({ x: b.position.x - a.position.x, z: b.position.z - a.position.z });
    const side = { x: -axis.z, z: axis.x };
    const clear = (p: Vec2): boolean => !pointInWater(p) && !onTerrainEdge(p, 2.4) && Math.abs(terrainHeightAt(p)) <= 0.5
      && !this.entities.some((e) => e.status.alive && dist(e.position, p) < e.radius + 2.2 + (isLandmarkKind(e.coverKind) ? 2 : 0))
      && !this.pickups.some((c) => dist(c, p) < 3); // never on top of a cash cache (owner 2026-10-06: "objects overlap")
    // A mirrored pair of each kind, on its own band of the board so they never crowd: Gun Posts on the flanks, Rocket Posts
    // far out where armour crosses, Flame Posts close to the centre line where infantry funnel.
    const place = (kind: "gunpost" | "rocketpost" | "flamepost" | "mortarpit" | "cannonpost", label: string, tag: string, laterals: number[], alongs: number[]): void => {
      for (const lateral of laterals) {
        for (const along of alongs) {
          const p = clampToArena({ x: c.x + side.x * lateral + axis.x * along, z: c.z + side.z * lateral + axis.z * along });
          const q = clampToArena({ x: 2 * c.x - p.x, z: 2 * c.z - p.z });
          if (!clear(p) || !clear(q) || dist(p, q) < 6) continue;
          for (const [at, n] of [[p, 1], [q, 2]] as const) {
            const post = kind === "gunpost" ? createGunPost(`field-${tag}-${n}`, label, "neutral", { ...at })
              : kind === "rocketpost" ? createRocketPost(`field-${tag}-${n}`, label, "neutral", { ...at })
              : kind === "mortarpit" ? createMortarPit(`field-${tag}-${n}`, label, "neutral", { ...at })
              : kind === "cannonpost" ? createCannonPost(`field-${tag}-${n}`, label, "neutral", { ...at })
              : createFlamePost(`field-${tag}-${n}`, label, "neutral", { ...at });
            post.yaw = Math.atan2(c.x - at.x, c.z - at.z) + Math.PI / 2; // facing along the front
            this.entities.push(post);
            this.syncEntityElevation(post);
          }
          return;
        }
      }
    };
    const alongs = [0, 3, -3, 6, -6, 12, -12, 18, -18, 24, -24];
    place("gunpost", "Gun Post", "post", [10, 8, 12, 6, 14, 5, 16, 18, 4, 3], alongs);
    place("rocketpost", "Rocket Post", "rocket", [15, 17, 13, 19, 11], [14, -14, 20, -20, 8, -8, 26, -26]);
    place("flamepost", "Flame Post", "flame", [4, 5, 6, 3, 7, 8, 2, 9, 11], [8, -8, 4, -4, 12, -12, 16, -16, 20, -20, 0]);
    // Heavier field pieces further back toward each side's half: a Mortar Pit to shell the middle and a Cannon Post that fires tank shells.
    place("mortarpit", "Mortar Pit", "mortar", [20, 22, 18, 24, 16], [-16, 16, -20, 20, -12, 12, -24, 24]);
    place("cannonpost", "Cannon Post", "cannon", [-16, -18, -14, -20, -12], [-10, 10, -14, 14, -6, 6, -18, 18]);
  }

  // ---- Field hands: place (demolitionist / turret tech / fortifier) ----




  /** The nearest free emplacement worth crewing: close, and with a foe inside its weapon's reach. */
  private aiMountTarget(actor: CombatEntity, foes: CombatEntity[]): CombatEntity | undefined {
    let best: CombatEntity | undefined;
    let bestD = 12;
    for (const e of this.entities) {
      if (!isMountKind(e.kind) || this.manFailureReason(actor, e)) continue;
      const reach = projectileRange(e);
      if (!foes.some((f) => !f.flying && dist(f.position, e.position) <= reach)) continue;
      const d = dist(actor.position, e.position);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }




  placeFailureReason(actor: CombatEntity | undefined, point?: Vec2): string | undefined {
    if (!actor) return "Select a unit first";
    const spec = placeSpecFor(actor.kind);
    if (!spec) return "This unit places nothing";
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    if (this.money(actor.team) < spec.cost) return `Not enough money for a ${spec.label.toLowerCase()} ($${spec.cost})`;
    if (!actor.parts.some((p) => p.id === "pack" && p.hp > 0)) return `${actor.name} has lost its kit`;
    if (!point) return undefined;
    const projected = this.projectedActorForPreview(actor);
    if (dist(projected.position, point) > spec.reach + actor.radius) return `Too far: ${spec.label} reaches ${spec.reach}m`;
    if (pointInWater(point)) return `Cannot place a ${spec.label.toLowerCase()} in the water`;
    if (Math.abs(terrainHeightAt(point) - terrainHeightAt(projected.position)) > TERRAIN_STEP) return "Not on level ground";
    if (this.placedCount(actor.team, spec.kind) >= (PLACE_CAP[spec.kind] ?? 3)) return `You already have ${PLACE_CAP[spec.kind]} ${spec.label.toLowerCase()}s down`;
    if (spec.kind === "sentry" && actor.grenades <= 0) return `${actor.name} has no sentries left`;
    const room = 0.9;
    if (this.entities.some((e) => e.status.alive && !e.carriedById && !e.flying && e.id !== actor.id && dist(e.position, point) < e.radius + room)) return "Spot is blocked by another object";
    return undefined;
  }

  private placedCount(team: Team, _kind: string): number {
    return this.entities.filter((e) => e.kind === "sentry" && e.status.alive && e.team === team).length; // ponytail: the sentry is the only placeable
  }

  /** The placement a selected utility unit would make (for the ghost and the HUD). */
  placeSpec(): PlaceSpec | undefined {
    const actor = this.selected;
    return actor && actor.team === "player" ? placeSpecFor(actor.kind) : undefined;
  }

  /** Player API: set the carried item down at a point (1 AP + its cost). Instant, like a mine. */
  queuePlace(point: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const at = clampToArena(point);
    const failure = this.placeFailureReason(actor, at);
    if (failure) return this.reject(failure);
    return this.placeFor(actor, at, this.placementYaw(this.projectedActorForPreview(actor).position, at));
  }

  private placeFor(actor: CombatEntity, at: Vec2, yaw: number): boolean {
    const spec = placeSpecFor(actor.kind);
    if (!spec) return false;
    spendCommandPoint(actor);
    this.addMoney(actor.team, -spec.cost);
    actor.grenades = Math.max(0, actor.grenades - 1);
    this.deploySentry(actor.team, at, yaw, `${actor.name}'s`);
    this.pushLog(`${actor.name} sets down a ${spec.label.toLowerCase()}`);
    return true;
  }

  /** A sentry stands where it is set (by a Turret Tech or a drop): it shoots by itself each turn and packs up after SENTRY_COST_TURNS. */
  private deploySentry(team: Team, at: Vec2, yaw: number, owner: string): CombatEntity {
    const sentry = createSentry(`sentry-${++this.effectSeq}`, "Sentry", team, { ...at });
    sentry.yaw = yaw;
    sentry.ownerTeam = team;
    sentry.sentryTtl = SENTRY_COST_TURNS;
    sentry.placedTurn = this.turn;
    this.entities.push(sentry);
    this.syncEntityElevation(sentry);
    this.effect("land", at, at, 0xbfe9ff, 0.5, 1.2);
    this.tally(team, "sentries");
    this.pushLog(`${owner} sentry deploys`);
    return sentry;
  }

  /** Sentries pack up when their time is out. Runs at turn start. */
  private runSentryTick(): void {
    for (const e of this.entities) {
      if (e.kind !== "sentry" || !e.status.alive || e.sentryTtl === undefined) continue;
      e.sentryTtl -= 1;
      if (e.sentryTtl <= 0) {
        for (const part of e.parts) part.hp = 0;
        recomputeStatus(e);
        this.effect("land", e.position, e.position, 0xbfe9ff, 0.5, 1.2);
        this.pushLog("A sentry packs up");
      }
    }
  }

  /** At end of turn every live sentry (both sides) shoots the nearest foe in reach, with no one to order it. */
  private queueSentryOrders(): void {
    for (const sentry of this.entities) {
      if (sentry.kind !== "sentry" || !sentry.status.alive || !sentry.status.canShoot || sentry.commandPoints <= 0) continue;
      if (this.orders.some((o) => o.actorId === sentry.id && !o.done)) continue;
      const range = projectileRange(sentry);
      const foe = this.entities
        .filter((e) => e.team !== sentry.team && e.team !== "neutral" && e.status.alive && !e.carriedById && e.kind !== "cover" && !isDefenseKind(e.kind) && !e.flying && dist(e.position, sentry.position) <= range)
        .sort((a, b) => dist(a.position, sentry.position) - dist(b.position, sentry.position))[0];
      if (foe) this.queueShootFor(sentry, foe, "center");
    }
  }





  /** Why `actor` cannot swing its hammer (undefined when it can). */
  slamFailureReason(actor: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "sledge") return "Only a Sledge swings a hammer";
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    if (!actor.status.canMove || !actor.parts.some((p) => p.id === "rifle" && p.hp > 0)) return `${actor.name} cannot swing`;
    return undefined;
  }

  /** Player API: SLAM. Every foe within 3m of the Sledge is hurt and flung. 1 AP. */
  /** Why `actor` cannot blow itself up (undefined when it can). */
  detonateFailureReason(actor: CombatEntity | undefined): string | undefined {
    if (!actor) return "Select a unit first";
    if (actor.kind !== "boomer") return "Only a Boomer detonates";
    if (actor.commandPoints <= 0) return `${actor.name} has no action points`;
    if (this.orders.some((o) => o.actorId === actor.id && o.kind === "detonate")) return `${actor.name} is already set to blow`;
    return undefined;
  }

  /** Player API: DETONATE. The Boomer explodes at the end of its queued orders (move first, then blow). 1 AP. */
  queueDetonate(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const failure = this.detonateFailureReason(actor);
    if (failure) return this.reject(failure);
    return this.detonateFor(actor);
  }

  private detonateFor(actor: CombatEntity): boolean {
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    this.addOrder({ actorId: actor.id, kind: "detonate", aim: "center", duration: 0.7 });
    this.pushLog(`${actor.name} lights the fuse`);
    return true;
  }

  queueSlam(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const failure = this.slamFailureReason(actor);
    if (failure) return this.reject(failure);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no action points`);
    this.addOrder({ actorId: actor.id, kind: "slam", aim: "center", duration: 0.9 });
    return true;
  }


  // Called while units move during resolve (same hook as pickups): a hostile stepping
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

  // Same move-resolve hook as mines: a unit that runs over a cash cache banks it.
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
      let point = { x: b.minX + w * (0.12 + fx * 0.76), z: b.minZ + d * (0.12 + fz * 0.76) };
      const amount = 45 + (seed % 4) * 15; // 45..90
      // A cache on a ledge edge reads as half-buried (owner 2026-10-02): nudge to open flat ground.
      for (let attempt = 0; attempt < 8 && !this.pickupSpotClear(point); attempt += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const a = ((seed >> 8) % 360) * (Math.PI / 180);
        point = clampToArena({ x: point.x + Math.cos(a) * (1.5 + attempt), z: point.z + Math.sin(a) * (1.5 + attempt) });
      }
      if (this.pickupSpotClear(point)) this.pickups.push({ id: `pickup-${i}`, x: point.x, z: point.z, amount });
    }
  }

  // A cache must sit on open ground a unit can actually reach — not inside a base/defense/solid
  // cover, and not adjacent to a base (loot is earned by taking ground, not handed out at spawn).
  private pickupSpotClear(p: Vec2): boolean {
    if (pointInWater(p) || onTerrainEdge(p, 1.6) || discSamples(p, 1.6).some(pointInWater)) return false; // flat, dry, the whole ring on one level and clear of the shore
    for (const e of this.entities) {
      if (e.kind === "base" && dist(p, e.position) < 14) return false; // outside every deploy ring
      // Landmarks draw past their footprint (the checkpoint's raised boom overhung a cache): 2m more for them.
      if ((e.kind === "cover" || e.kind === "base" || isDefenseKind(e.kind)) && dist(p, e.position) < e.radius + 1.3 + (isLandmarkKind(e.coverKind) ? 2 : 0)) return false;
    }
    return !this.pickups.some((c) => dist(c, p) < 3); // two caches never touch
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
      case "bunker": return 0.5;
      default: return 0.14;
    }
  }

  // Flanking: a shot from OUTSIDE the target's facing wedge (the ±60° FRONT_ARC_HALF wedge)
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
    if (delta <= FRONT_ARC_HALF) return 0; // inside the front 120° cone — facing the shooter
    return clamp((delta - FRONT_ARC_HALF) / (Math.PI - FRONT_ARC_HALF), 0, 1);
  }

  private estimateShotDamage(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, aim: AimMode, cover: boolean, attackMode: AttackMode = "weapon"): number {
    let base = baseShotDamage(actor.kind, attackMode);
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
    const antiArmor = isVehicleKind(target.kind) ? unitStats(actor.kind).antiArmor ?? 1 : 1;
    // SHIELD: a tower shield turns bullets from the front arc (blasts go round it).
    const shieldStat = unitStats(target.kind).shield;
    let shield = 1;
    if (shieldStat && attackMode === "weapon" && !unitStats(actor.kind).groundShell && target.parts.some((p) => p.id === "pack" && p.hp > 0)) {
      const toward = normalize({ x: actor.position.x - target.position.x, z: actor.position.z - target.position.z });
      if (toward.x * Math.sin(target.yaw) + toward.z * Math.cos(target.yaw) > 0.26) shield = shieldStat; // inside ~75 degrees of its facing
    }
    base *= actor.mods?.damage ?? 1;
    return Math.round(base * antiArmor * shield * falloff * (cover ? 1.05 : aimMultiplier) * vulnerability * shellObjectBoost * flank * vsAir * this.supportDamageMultiplier(actor) * this.teamDamageScale(actor) * this.techDamageScale(actor, target));
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
      if (entity.id === target.id || entity.id === actor.id || !entity.status.alive) continue;
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

  private applyExplosiveRadius(actor: CombatEntity, point: Vec2, radius: number, baseDamage: number, message: string, maxThrow?: number): void {
    for (const entity of this.entities) {
      // Flyers ride above the blast plane — a GROUND explosion never reaches them (anti-air is
      // direct-fire only, not splash). The 2D distance below would otherwise hit them at altitude.
      if (entity.id === actor.id || !entity.status.alive || entity.flying) continue;
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
      this.applyKnockback(actor, entity, point, baseDamage, falloff, maxThrow ? { maxThrow } : {});
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
  private applyKnockback(actor: CombatEntity, entity: CombatEntity, point: Vec2, baseDamage: number, falloff: number, opts: { ringOut?: boolean; maxThrow?: number } = {}): void {
    if (!entity.status.alive || entity.flying) return;
    // The Juggernaut's cannon throws harder (and further) than anything else that size.
    const kb = unitStats(actor.kind).knockback ?? 1;
    if (kb !== 1) { baseDamage *= kb; opts = { ...opts, maxThrow: (opts.maxThrow ?? KNOCKBACK_MAX) * Math.min(kb, 1.6) }; }
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
    let throwDistance = Math.min(opts.maxThrow ?? KNOCKBACK_MAX, (baseDamage / 30) * falloff * KNOCKBACK_SCALE / mass);
    // A trooper in any real explosion is blown back a visible way (owner 2026-10-03), at least a hop; armour (mass 5.5) barely moves.
    if (isInfantryKind(entity.kind) && baseDamage >= 18 && falloff >= 0.22) throwDistance = Math.max(throwDistance, Math.min(opts.maxThrow ?? KNOCKBACK_MAX, (1.2 + falloff * 2.4) * Math.min(kb, 1.6)));
    if (throwDistance < 0.12) return;

    const steps = Math.max(4, Math.ceil(throwDistance * 6));
    let footing = terrainHeightAt(entity.position);
    let landed = { ...entity.position };
    let drowned = false;
    let ringOut = false;
    // What cut the throw short, if anything. A body that was thrown INTO something is a slam:
    // the momentum it did not get to spend lands as damage, on it and on whatever it hit.
    let slammedInto: CombatEntity | "cliff" | "prop" | undefined;
    let travelled = 0;
    for (let i = 1; i <= steps; i += 1) {
      const t = (throwDistance * i) / steps;
      const free = { x: entity.position.x + dirX * t, z: entity.position.z + dirZ * t };
      const next = clampToArena(free);
      // Shoved over the arena edge: off the map (blasts still stop at the edge).
      if (opts.ringOut && (next.x !== free.x || next.z !== free.z)) { landed = free; ringOut = true; break; }
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

    if (landed.x === entity.position.x && landed.z === entity.position.z && !drowned && !slammedInto && !ringOut) return;
    // Thrown OFF a ledge, the body can land with its hull against the face it fell from; slide it to
    // the nearest ground its whole footprint fits on (movement.test.ts, 2026-10-01).
    // (A thrown body is a loose bundle of boxes, wider than its footprint: it needs a margin from the face it lands beside.)
    if (!drowned && !ringOut && !this.groundFits(entity, landed, 1.3)) {
      const fit = this.nearestFittingGround(entity, landed, 1.3);
      // No room to land beside the ledge: stay where it stood rather than sink into the face.
      landed = fit ?? { ...entity.position };
    }
    if (actor.team === "player" && entity.team === "enemy" && travelled >= 2) this.tally("player", "thrown");
    entity.position = landed;
    entity.dugIn = undefined; // thrown out of its foxhole
    entity.digging = undefined;
    entity.elevation = terrainHeightAt(landed);
    this.effect("impact", landed, landed, 0xffd9a0, 0.3, entity.radius * 0.9);
    if (ringOut) {
      if (actor.team === "player" && entity.team === "enemy") this.tally("player", "ringouts");
      for (const part of entity.parts) part.hp = 0;
      recomputeStatus(entity);
      this.pushLog(`${entity.name} is shoved clean off the battlefield!`);
      this.afterDamage(actor, entity, [`${entity.name} fell off the map`], "Ring-out");
      return;
    }
    if (!drowned) {
      this.pushLog(`${entity.name} is ${opts.ringOut ? "sent flying" : "thrown by the blast"}`);
      if (slammedInto) this.resolveSlam(actor, entity, slammedInto, (throwDistance - travelled) / throwDistance, baseDamage, dirX, dirZ);
      return;
    }
    // Into the channel. Everything is destroyed at once — there is no swimming in this game.
    for (const part of entity.parts) part.hp = 0;
    recomputeStatus(entity);
    this.effect("blast", landed, landed, PULSE_WATER, 0.7, entity.radius + 1.2);
    this.pushLog(`${entity.name} is blasted into the water and drowns`);
    this.afterDamage(actor, entity, [`${entity.name} drowned`], "Drowning");
  }

  /** Can this body stand here: dry, its hull clear of any taller-than-a-step rise, no unit or prop? */
  private groundFits(body: CombatEntity, at: Vec2, room = 1): boolean {
    if (pointInWater(at) || this.bodyAt(body, at) || this.solidPropAt(body, at)) return false;
    const here = terrainHeightAt(at);
    if (discSamples(at, body.radius * 0.9 * room).some((p) => terrainHeightAt(p) - here > TERRAIN_STEP * 0.9)) return false;
    // ...and a 16-way ring too: the 12-way disc can slip between a block's corner and a sample (0.4m slivers).
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      if (terrainHeightAt({ x: at.x + Math.sin(a) * body.radius * 0.92 * room, z: at.z + Math.cos(a) * body.radius * 0.92 * room }) - here > TERRAIN_STEP * 0.9) return false;
    }
    return true;
  }

  /** The nearest point (within 3m) where `groundFits`; `at` itself when nothing nearer fits. */
  private nearestFittingGround(body: CombatEntity, at: Vec2, room = 1): Vec2 | undefined {
    for (let r = 0.25; r <= 3; r += 0.25) {
      for (let i = 0; i < 16; i += 1) {
        const a = (i / 16) * Math.PI * 2;
        const c = clampToArena({ x: at.x + Math.sin(a) * r, z: at.z + Math.cos(a) * r });
        if (this.groundFits(body, c, room)) return c;
      }
    }
    return undefined;
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
      // ...unless that step is into a prop, a rise or a step (a tank was shoved into a boulder).
      if (Math.abs(terrainHeightAt(shove) - terrainHeightAt(into.position)) <= TERRAIN_STEP && this.groundFits(into, shove)) {
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

  private resolveShove(actor: CombatEntity, target: CombatEntity): void {
    // A long-duration impact from the pusher = the renderer's HEAVY flinch, so a body that dies from
    // the shove (water, the map edge) plays the THROWN death, tumbling away from the push.
    this.effect("impact", actor.position, target.position, 0xfff1a6, 0.95, target.radius + 0.6);
    if (actor.kind === "breaker") {
      // The rocket fist: a real hit, then a throw twice a shove's.
      const part = preferredPart(target, "center");
      const result = applyDamage(target, part.id, Math.round(PUNCH_DAMAGE * this.teamDamageScale(actor) * (target.dugIn ?? 1)));
      this.effect("blast", { ...target.position }, { ...target.position }, 0xffc27a, 0.45, 1.1);
      this.pushLog(`${actor.name} PUNCHES ${target.name}`);
      this.afterDamage(actor, target, result, "Punch");
      this.tally(actor.team, "punches");
      this.applyKnockback(actor, target, actor.position, PUNCH_FORCE, 1, { ringOut: true, maxThrow: PUNCH_MAX });
      return;
    }
    this.pushLog(`${actor.name} shoves ${target.name}`);
    this.applyKnockback(actor, target, actor.position, SHOVE_FORCE, 1, { ringOut: true, maxThrow: SHOVE_MAX });
  }

  private resolveMelee(actor: CombatEntity, target: CombatEntity, partId?: string): void {
    const { amount, part: targetPart } = this.meleeDamageEstimate(actor, target, partId);
    const result = applyDamage(target, targetPart.id, amount);
    this.effect("strike", actor.position, target.position, result.killed ? 0xfff1a6 : 0x9dfcff, 0.52, target.radius + 1.1);
    this.pushLog(`${actor.name} strikes ${target.name}'s ${targetPart.label}`);
    this.afterDamage(actor, target, result, "Strike");
  }

  private afterDamage(actor: CombatEntity, target: CombatEntity, resultOrMessages: DamageResult | string[], source?: string): void {
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
      // The hulk comes to rest on CLEAR ground: an aircraft shot down over a tank, or a vehicle killed
      // against another, used to leave its wreck on top of the survivor (and shoving the survivor out
      // could push it into a base). Move the wreck, not the living (movement.test.ts).
      wreck.position = this.clearWreckSpot(wreck, target.id);
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

  /** The nearest spot (within 6m) where a wreck overlaps no living body or solid, on dry level ground. */
  private clearWreckSpot(wreck: CombatEntity, deadId: string): Vec2 {
    const free = (p: Vec2): boolean =>
      !pointInWater(p) && !onTerrainEdge(p, wreck.radius * 0.8) &&
      !this.entities.some((e) => e.id !== deadId && e.id !== wreck.id && e.status.alive && !e.flying && !e.carriedById && dist(e.position, p) < e.radius + wreck.radius + 0.2);
    if (free(wreck.position)) return wreck.position;
    for (let r = 0.8; r <= 6; r += 0.8) {
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * Math.PI * 2;
        const p = clampToArena({ x: wreck.position.x + Math.sin(a) * r, z: wreck.position.z + Math.cos(a) * r });
        if (free(p)) return p;
      }
    }
    return wreck.position;
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
      const wasName = structure.name;
      if (structure.kind === "turret") {
        structure.commandPoints = 0; // comes online next turn
        structure.name = "Captured Turret"; // "Derelict" on a turret you now command read as still-dead
      }
      this.effect("ping", { ...structure.position }, { ...structure.position }, team === "player" ? 0x75d8ff : 0xff765f, 0.9, structure.radius + 0.8);
      this.pushLog(`${this.sideName(team, team === "player" ? "You" : "The enemy")} captured ${wasName}${structure.coverKind === "depot" ? ` (+$${DEPOT_INCOME}/turn)` : structure.kind === "turret" && team === "player" ? " — select it next turn to fire it" : ""}`);
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
      if (!e.status.alive || e.id === cover.id || e.kind === "base") continue;
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
      this.effect("blast", target.position, target.position, PULSE_EMP, 0.46, 2.2);
    }
    if (messages.some((m) => m.includes("optic relay is ruptured"))) {
      this.pushLog(`${target.name}'s spotter link is offline`);
      this.effect("ping", target.position, target.position, 0x9dfcff, 0.7, 2.6);
    }
    if (messages.some((m) => m.includes("comms are down"))) {
      this.pushLog(`${this.sideName(target.team, target.team === "enemy" ? "Enemy" : "Player")} command network degraded`);
      this.effect("blast", target.position, target.position, PULSE_EMP, 0.58, 3.1);
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
    if (affected > 0) this.pushLog(`${message}: ${affected} unit${affected === 1 ? "" : "s"} lose AP`);
  }

  private firstEntityHitBySegment(projectile: Projectile, from: Vec2, to: Vec2, fromHeight: number, toHeight: number): ProjectileHit | undefined {
    const hits: ProjectileHit[] = [];
    const crewId = this.entity(projectile.actorId)?.occupantId; // a post's crew is never in its own line of fire
    for (const entity of this.entities) {
      if (entity.id === projectile.actorId || entity.id === crewId || projectile.ignoredEntityIds.includes(entity.id) || !entity.status.alive || entity.carriedById) continue;
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
    const crewId = this.entity(projectile.actorId)?.occupantId;
    const candidates = this.entities
      .filter((entity) => entity.id !== projectile.actorId && entity.id !== crewId && !projectile.ignoredEntityIds.includes(entity.id) && entity.status.alive)
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
    // HIGH GROUND IS A BIG DEAL (owner 2026-10-02): fire from above is far tighter, fire up a slope
    // far wilder. A full mesa step (1.2m+) halves / more than doubles the spread. Aircraft fire down.
    // The edge GROWS with the height difference (no tiers): 1.2m above halves the cone, 3m above leaves a
    // fifth of it; 1.2m below doubles it, 3m below is a wild 3.7x. Aircraft shoot down at no penalty.
    if (elevationDelta > 0.3) {
      spreadDegrees *= Math.max(0.2, 1 / (1 + 1.1 * (elevationDelta - 0.3)));
      notes.push("high ground");
    } else if (elevationDelta < -0.3 && !actor.flying) {
      spreadDegrees *= Math.min(4, 1 + 1.3 * (-elevationDelta - 0.3));
      notes.push("shooting uphill");
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
      dist(entity.position, actor.position) <= (entity.kind === "sensor" ? SENSOR_REACH : 6.2) &&
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
  /** A ground move that halted short: back off along its path to the first spot clear of rises AND
   *  of solid props / emplacements (keeps the halt where it is when the whole path is tight). */
  /** A trooper that ended a charge with its body boxes against a step face backs off along the way it came (the blade and lean reach past the footprint). */
  private backOffRise(actor: CombatEntity, start: Vec2 | undefined): void {
    if (!start || actor.flying || !hullInRise(actor.position, actor.radius * 1.15) || hullInRise(start, actor.radius * 1.15)) return;
    const end = { ...actor.position };
    for (const f of [0.8, 0.6, 0.4, 0.2, 0]) {
      const c = { x: start.x + (end.x - start.x) * f, z: start.z + (end.z - start.z) * f };
      if (!hullInRise(c, actor.radius * 1.15) && !this.bodyAt(actor, c)) { actor.position = c; this.syncEntityElevation(actor); return; }
    }
  }

  private settleHalt(actor: CombatEntity, start: Vec2): void {
    const margin = spawnClearance(actor.radius);
    const solids = this.entities.filter((e) => e.id !== actor.id && e.status.alive && !e.flying && !e.carriedById &&
      ((e.kind === "cover" && e.coverKind !== "ridge") || e.kind === "base" || isDefenseKind(e.kind)));
    const bodies = this.entities.filter((e) => e.id !== actor.id && e.status.alive && !e.flying && !e.carriedById && e.kind !== "cover" && !isBuildingKind(e.kind) && !isDefenseKind(e.kind));
    const clear = (p: Vec2): boolean => !risesNear(p, margin) && !solids.some((e) => dist(e.position, p) < e.radius + actor.radius) && !bodies.some((e) => dist(e.position, p) < (e.radius + actor.radius) * 0.98);
    const stop = { ...actor.position };
    if (!risesNear(stop, margin)) return;
    const length = dist(start, stop);
    for (let back = 0.15; back < length; back += 0.15) {
      const t = (length - back) / length;
      const c = { x: start.x + (stop.x - start.x) * t, z: start.z + (stop.z - start.z) * t };
      if (clear(c)) {
        actor.position = c;
        this.syncEntityElevation(actor);
        return;
      }
    }
  }

  /** Push-out of overlapping bodies, but never INTO a rock face: a shove that would sink the hull into a
   *  step is undone (a brief overlap with a neighbour is the lesser evil; movement.test.ts 2026-10-02). */
  private separateFromUnits(actor: CombatEntity, destination?: Vec2): void {
    const before = { ...actor.position };
    this.separateFromUnitsRaw(actor, destination);
    if (actor.flying || !hullInRise(actor.position, actor.radius * 0.9) || hullInRise(before, actor.radius * 0.9)) return;
    // The shove would sink the hull into rock. Try the same push turned aside before giving it up.
    const pushed = { ...actor.position };
    const dx = pushed.x - before.x, dz = pushed.z - before.z;
    for (const turn of [0.9, -0.9, 1.8, -1.8, 2.7, -2.7]) {
      const c = Math.cos(turn), sn = Math.sin(turn);
      const cand = { x: before.x + dx * c - dz * sn, z: before.z + dx * sn + dz * c };
      if (!hullInRise(cand, actor.radius * 0.9) && !pointInWater(cand)) { actor.position = cand; return; }
    }
    // Still no: the largest PART of the push that keeps the hull clear (a sliver of overlap beats a rock).
    for (const frac of [0.85, 0.7, 0.5, 0.3, 0.15]) {
      const part = { x: before.x + dx * frac, z: before.z + dz * frac };
      if (!hullInRise(part, actor.radius * 0.9)) { actor.position = part; return; }
    }
    actor.position = before;
    // Nowhere for the actor to go: the neighbour steps aside instead, if it has the room.
    for (const other of this.entities) {
      if (other.id === actor.id || !other.status.alive || other.flying || other.carriedById || other.kind === "cover" || isBuildingKind(other.kind) || isDefenseKind(other.kind)) continue;
      const gap = actor.radius + other.radius;
      const d = dist(actor.position, other.position);
      if (d >= gap * 0.98 || d < 0.0001) continue;
      const push = gap - d;
      const cand = { x: other.position.x + ((other.position.x - actor.position.x) / d) * push, z: other.position.z + ((other.position.z - actor.position.z) / d) * push };
      if (!hullInRise(cand, other.radius * 0.9) && !pointInWater(cand)) other.position = cand;
    }
  }

  private separateFromUnitsRaw(actor: CombatEntity, destination?: Vec2): void {
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
          // Climbing onto cover is INFANTRY only: a tank whose move ended where a wreck had just appeared
          // (its target, killed mid-turn) drove into the hulk under this exemption (movement.test.ts).
          // And only onto cover it CAN climb: a tall wreck that appeared on the destination mid-turn (its
          // owner killed by a strike) let the walker step into the hulk (movement.test.ts, 2026-10-01).
          // The reach matches `onTop` below (where the unit is actually lifted onto it): a destination in the
          // ring between left the walker standing at ground level inside the cover.
          if (destination && isInfantryKind(actor.kind) && canClimbCover(other) && dist(other.position, destination) <= (isCliffCover(other) ? other.radius : Math.max(0.35, other.radius * 0.65))) continue;
          // Only INFANTRY climb onto cover (elevationForEntityAt lifts nobody else), so a vehicle "on top"
          // of a wreck is inside it -- an aircraft shot down onto an APC left it there (movement.test.ts).
          const onTop = isInfantryKind(actor.kind) && isClimbableCover(other) && dist(actor.position, other.position) <= Math.max(0.35, other.radius * 0.65);
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

    if (source.kind === "boomer") {
      // The kamikaze: one big bang where it stands, friend and foe alike, and the Boomer is gone.
      for (const part of source.parts) part.hp = 0;
      recomputeStatus(source);
      this.effect("blast", { ...source.position }, { ...source.position }, 0xffa53a, 1, BOOM_RADIUS + 0.4);
      this.pushLog(`${source.name} detonates!`);
      this.tally(source.team, "booms");
      this.applyExplosiveRadius(source, source.position, BOOM_RADIUS, BOOM_DAMAGE, `${source.name}'s blast`, BOOM_THROW);
      this.checkEndState();
      return;
    }

    if (kind === "conduit") {
      this.effect("blast", source.position, source.position, PULSE_EMP, 0.6, 2.2);
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
      if (entity.id === source.id || !entity.status.alive) continue;
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
    const crewId = this.entity(actorId)?.occupantId;
    const candidates = this.entities
      .filter((entity) => entity.kind !== "cover" && entity.status.alive && entity.id !== actorId && entity.id !== targetId && entity.id !== crewId)
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
  /** Self-play A/B switches for the Hard brain's newer behaviours (all on by default). */
  aiX: { standoff: boolean; bomb: boolean; econ: boolean; post: boolean; posture: boolean; moves: boolean } = { standoff: true, bomb: true, econ: true, post: true, posture: true, moves: true };
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

  // ---- Hard brain: the whole toolkit, not just move and shoot. Each helper is one move and the rule for when it pays. ----

  /** HOP: across a gap or up a ledge a walk cannot manage (or a high perch beside the fight), for 1 AP. */
  private aiHopAct(actor: CombatEntity, goal: Vec2 | undefined, foes: CombatEntity[], range: number): boolean {
    if (!isInfantryKind(actor.kind) || canJump(actor) || actor.commandPoints <= 0 || !actor.status.canMove) return false;
    const from = actor.position;
    const reach = this.leapRange(actor);
    const here = terrainHeightAt(from);
    const hereExposure = this.aiExposureAt(from, foes);
    const walk = goal ? this.navigateToward(actor, goal, moveRange(actor)) : from;
    const walkGain = goal ? dist(from, goal) - dist(walk, goal) : 0;
    let best: Vec2 | undefined;
    let bestScore = 2.5; // a hop has to clearly beat walking
    for (const r of [0.55, 1]) {
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * Math.PI * 2;
        const plan = this.leapPlan(actor, clampToArena({ x: from.x + Math.sin(a) * reach * r, z: from.z + Math.cos(a) * reach * r }));
        if (!plan.ok || this.aiDangerAt(plan.to)) continue;
        const gain = goal ? dist(from, goal) - dist(plan.to, goal) : 0;
        const rise = terrainHeightAt(plan.to) - here;
        let score = 0;
        if (gain >= 2.2 && gain > walkGain + 1.5) score += gain - walkGain; // the walk detours; the hop closes the ground
        if (rise > TERRAIN_STEP && foes.some((f) => dist(f.position, plan.to) <= range * 1.3) && this.aiExposureAt(plan.to, foes) <= hereExposure + 1) score += 2 + rise * 2; // a ledge no walk climbs
        if (score > bestScore) { bestScore = score; best = plan.to; }
      }
    }
    if (!best || !spendCommandPoint(actor)) return false;
    this.addOrder({ actorId: actor.id, kind: "move", destination: best, leap: true, aim: "center", duration: 1.6 });
    this.aiClaims.push({ at: { ...best }, radius: actor.radius });
    return true;
  }

  /** RAM: a tank with a soft target against its hull, or whose gun is gone, runs it down (72 damage, 14 to its own front plate). */
  private aiRamAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (actor.kind !== "tank" || actor.commandPoints <= 0 || !actor.status.canMove) return false;
    for (const f of foes) {
      if (f.flying || !f.status.alive || isBuildingKind(f.kind) || isDefenseKind(f.kind)) continue;
      if (dist(actor.position, f.position) > ramRange(actor) + actor.radius + f.radius) continue;
      const soft = isInfantryKind(f.kind) || f.parts.reduce((sum, p) => sum + Math.max(0, p.hp), 0) <= 90;
      if (!soft && actor.status.canShoot) continue;
      if (!spendCommandPoint(actor)) return false;
      this.addOrder({ actorId: actor.id, kind: "ram", targetId: f.id, aim: "center", duration: 1.85 });
      return true;
    }
    return false;
  }

  /** SMOKE: a mortar screens a friend that two or more guns are working over, a third of the way to the shooters. */
  private aiSmokeAct(actor: CombatEntity, foes: CombatEntity[], behind: boolean): boolean {
    if (actor.kind !== "mortar" || actor.commandPoints <= 0 || !actor.status.canShoot || this.smokeClouds.length >= 2) return false;
    let front: CombatEntity | undefined;
    let worst = behind ? 2 : 3;
    for (const u of this.fieldUnits("enemy")) {
      if (u.id === actor.id || u.flying || u.kind === "mortar") continue;
      const exposure = this.aiExposureAt(u.position, foes);
      if (exposure >= worst) { worst = exposure; front = u; }
    }
    if (!front) return false;
    const foe = nearest(front, foes);
    if (!foe || dist(front.position, foe.position) < 5) return false;
    const point = clampToArena({ x: front.position.x + (foe.position.x - front.position.x) * 0.35, z: front.position.z + (foe.position.z - front.position.z) * 0.35 });
    if (this.smokeClouds.some((c) => dist(c, point) < SMOKE_RADIUS * 1.2) || this.smokeFailureReason(actor, point)) return false;
    if (!spendCommandPoint(actor)) return false;
    this.addOrder({ actorId: actor.id, kind: "smoke", destination: point, aim: "center", duration: 1.35 });
    return true;
  }

  /** SLAM: a Sledge with foes inside the hammer's circle swings (two or more, or any trooper: it is a throw as much as a blow). */
  private aiSlamAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (actor.kind !== "sledge" || this.slamFailureReason(actor)) return false;
    const inReach = foes.filter((f) => !f.flying && f.status.alive && !isBuildingKind(f.kind) && dist(f.position, actor.position) <= SLAM_RADIUS + f.radius);
    if (!inReach.length) return false;
    const worth = inReach.length >= 2 || inReach.some((f) => isInfantryKind(f.kind));
    if (!worth || !spendCommandPoint(actor)) return false; // (the hammer only hits foes, so friends beside it are safe)
    this.addOrder({ actorId: actor.id, kind: "slam", aim: "center", duration: 0.9 });
    return true;
  }


  /** CROUCH: a trooper standing its ground under fire, with an action point to spare, drops low (tighter aim, no head shots). */
  private aiCrouchAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (!isInfantryKind(actor.kind) || actor.stance === "crouched" || actor.commandPoints <= 0 || !actor.status.canMove) return false;
    if (this.aiExposureAt(actor.position, foes) < 1 || this.orders.some((o) => o.actorId === actor.id && o.kind === "defend")) return false;
    if (!spendCommandPoint(actor)) return false;
    this.addOrder({ actorId: actor.id, kind: "defend", aim: "center", stance: "crouched", duration: 0.52 });
    return true;
  }

  /** CARRY: a Runabout or transport sets its troops down when the fight is close, and boards idle foot troops while it is far. */
  private aiCarryAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (!isCarrierKind(actor.kind) || actor.commandPoints <= 0 || !actor.status.canMove) return false;
    const foe = nearest(actor, foes);
    if (!foe) return false;
    const gap = dist(actor.position, foe.position);
    if (actor.passengerIds?.length) {
      if (gap > 15) return false; // still driving in
      const dir = normalize({ x: foe.position.x - actor.position.x, z: foe.position.z - actor.position.z });
      const out = actor.radius + APC_UNLOAD_REACH * 0.8;
      const point = isGroundCarrier(actor.kind) ? clampToArena({ x: actor.position.x + dir.x * out, z: actor.position.z + dir.z * out }) : { ...actor.position };
      if (!spendCommandPoint(actor)) return false;
      this.addOrder({ actorId: actor.id, kind: "unload", destination: point, aim: "center", duration: isGroundCarrier(actor.kind) ? 1.2 : 2.4 });
      return true;
    }
    if (gap < 18) return false;
    const rider = this.fieldUnits("enemy").find((u) => u.id !== actor.id && !u.carriedById && !this.aiBoarding.has(u.id) && u.status.canMove && isInfantryKind(u.kind)
      && !this.orders.some((o) => o.actorId === u.id) && !this.loadFailureReason(actor, u));
    if (!rider || !spendCommandPoint(actor)) return false;
    this.aiBoarding.add(rider.id);
    this.addOrder({ actorId: actor.id, kind: "load", targetId: rider.id, aim: "center", duration: isGroundCarrier(actor.kind) ? 1.2 : 2.6 });
    return true;
  }
  private aiBoarding = new Set<string>();

  /** BOOMER: the best clump it can reach this turn (armour counts double, never more friends than foes in the blast): run there and blow. */
  private aiBoomerAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (actor.kind !== "boomer" || actor.commandPoints <= 0 || this.detonateFailureReason(actor)) return false;
    const ground = foes.filter((f) => !f.flying && f.status.alive && !isBuildingKind(f.kind) && f.kind !== "cover");
    const weigh = (at: Vec2): number => ground.reduce((n, f) => n + (dist(f.position, at) <= BOOM_RADIUS + f.radius * 0.45 ? (isVehicleKind(f.kind) || isDefenseKind(f.kind) ? 2 : 1) : 0), 0);
    const friends = (at: Vec2): number => this.living(actor.team).filter((u) => u.id !== actor.id && !isBuildingKind(u.kind) && dist(u.position, at) <= BOOM_RADIUS).length;
    // Already in the middle of them: blow now.
    if (weigh(actor.position) >= 2 && friends(actor.position) * 2 <= weigh(actor.position)) return this.detonateFor(actor);
    if (!actor.status.canMove || actor.commandPoints < 2) return false;
    let best: { to: Vec2; score: number } | undefined;
    for (const f of ground) {
      if (dist(f.position, actor.position) > moveRange(actor) + BOOM_RADIUS) continue;
      const to = this.navigateToward(actor, f.position, moveRange(actor));
      const score = weigh(to);
      if (score === 0 || friends(to) * 2 > score) continue;
      if (!best || score > best.score) best = { to, score };
    }
    if (!best) return false;
    spendCommandPoint(actor);
    this.addOrder({ actorId: actor.id, kind: "move", destination: best.to, aim: "center", duration: 1.5 });
    return this.detonateFor(actor);
  }

  /** BREAKER: punch the foe in reach whose throw does the most (a ring-out first, then a trooper, then anything). */
  private aiPunchAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (actor.kind !== "breaker" || actor.commandPoints <= 0 || !actor.status.canMove || !hasIntactMeleeWeapon(actor)) return false;
    const reach = meleeRange(actor) + actor.radius;
    const inReach = foes.filter((f) => !f.flying && f.status.alive && !isBuildingKind(f.kind) && !isDefenseKind(f.kind) && f.kind !== "cover" && dist(f.position, actor.position) <= reach + f.radius);
    if (!inReach.length) return false;
    const score = (f: CombatEntity): number => {
      const dir = normalize({ x: f.position.x - actor.position.x, z: f.position.z - actor.position.z });
      let doom = 0;
      for (let t = 2; t <= PUNCH_MAX && !doom; t += 2) {
        const p = { x: f.position.x + dir.x * t, z: f.position.z + dir.z * t };
        const c = clampToArena(p);
        if (pointInWater(p) || c.x !== p.x || c.z !== p.z) doom = 1;
      }
      return doom * 100 + (isInfantryKind(f.kind) ? 10 : 0) - dist(f.position, actor.position);
    };
    const foe = inReach.reduce((a, b) => (score(a) >= score(b) ? a : b));
    if (!spendCommandPoint(actor)) return false;
    this.addOrder({ actorId: actor.id, kind: "melee", shove: true, targetId: foe.id, targetPartId: preferredPart(foe, "center").id, aim: "center", duration: 0.78 });
    return true;
  }

  /** Hard brain: shove a trooper that stands with water or the map edge behind it (the throw does the killing). */
  private aiShoveAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    if (!isInfantryKind(actor.kind) || actor.commandPoints <= 0 || !actor.status.canMove) return false;
    const reach = meleeRange(actor) + actor.radius + 1.5;
    for (const foe of foes) {
      if (!isInfantryKind(foe.kind) || foe.flying || !foe.status.alive) continue;
      const d = dist(actor.position, foe.position);
      if (d > reach) continue;
      const dir = normalize({ x: foe.position.x - actor.position.x, z: foe.position.z - actor.position.z });
      let doomed = false;
      for (let t = 1.5; t <= 8 && !doomed; t += 1) {
        const p = { x: foe.position.x + dir.x * t, z: foe.position.z + dir.z * t };
        const c = clampToArena(p);
        doomed = pointInWater(p) || c.x !== p.x || c.z !== p.z;
      }
      // ...or into our own trap: a mine, a burning patch or a gas cloud a shove or two away.
      for (let t = 1.5; t <= 4 && !doomed; t += 1) {
        const p = { x: foe.position.x + dir.x * t, z: foe.position.z + dir.z * t };
        doomed = this.mines.some((m) => m.team === actor.team && dist(m, p) < 1.2) || this.burnZones.some((z) => dist(z, p) <= z.radius) || this.gasClouds.some((z) => dist(z, p) <= z.radius);
      }
      // (meleeFailureReason is the PLAYER's check and refuses any foe of the player's; the bot's own: weapon, and in rush reach)
      if (!doomed || !hasIntactMeleeWeapon(actor) || d > meleeRange(actor) + actor.radius + foe.radius || !spendCommandPoint(actor)) continue;
      const part = preferredPart(foe, "center");
      this.addOrder({ actorId: actor.id, kind: "melee", shove: true, targetId: foe.id, targetPartId: part.id, aim: "center", duration: 0.78 });
      return true;
    }
    return false;
  }

  /** Hard brain: a Turret Tech sets a sentry down toward the foe. */
  private aiPlaceAct(actor: CombatEntity, foes: CombatEntity[]): boolean {
    const spec = placeSpecFor(actor.kind);
    if (!spec || actor.commandPoints <= 0) return false;
    if (this.money(actor.team) < spec.cost + 40) return false; // troops first
    const ground = foes.filter((f) => !f.flying && !isBuildingKind(f.kind) && f.status.alive);
    if (!ground.length) return false;
    const foe = ground.reduce((a, b) => (dist(a.position, actor.position) <= dist(b.position, actor.position) ? a : b));
    const d = dist(foe.position, actor.position);
    if (d > 20 || d < 4) return false;
    const dir = normalize({ x: foe.position.x - actor.position.x, z: foe.position.z - actor.position.z });
    const out = Math.min(spec.reach * 0.9, d * 0.45);
    const at = clampToArena({ x: actor.position.x + dir.x * out, z: actor.position.z + dir.z * out });
    // One sentry in an area is plenty.
    if (this.entities.some((e) => e.kind === "sentry" && e.team === actor.team && e.status.alive && dist(e.position, at) < 6)) return false;
    if (this.placeFailureReason(actor, at)) return false;
    return this.placeFor(actor, at, Math.atan2(dir.x, dir.z));
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
    this.aiClaims = [];
    this.aiBoarding.clear();
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
        if (!(base.kind === "base")) continue;
        this.enemyBaseAct(base);
        // HARD spends EVERY base order: with the AP upgrade the base has two a turn, and the old single
        // call left the second idle (a Hard bot sat on $800 with two units, researching the whole tree).
        if (profile.smartEconomy && this.aiX.econ) {
          for (let extra = 0; extra < 2 && base.commandPoints > 0; extra += 1) this.enemyBaseAct(base);
        }
      }
    }
    // Carried passengers are aboard a transport — not targetable and not on the ground.
    // A sentry the other side set down THIS turn is one of its orders: the bot plans blind to it, like any other order.
    const unseen = (e: CombatEntity): boolean => e.kind === "sentry" && e.placedTurn === this.turn;
    const players = this.living("player").filter((entity) => !isBuildingKind(entity.kind) && !entity.carriedById && !unseen(entity));
    const allPlayers = this.living("player").filter((entity) => !entity.carriedById && !unseen(entity));
    if (!allPlayers.length) return;
    const objective = this.enemyObjective();
    const home = this.enemyHomePosition();
    // Running tally of damage already committed to each player unit this turn. Focus-fire reads
    // it so shooters pile onto one target until it's predicted dead, then spill to the next.
    const committed = new Map<string, number>();
    // HARD reads the balance of forces: well behind, it holds a defensive line and lets the player walk into its guns.
    const ratio = profile.tactical ? this.aiStrengthRatio() : 1;
    const behind = ratio < 1;
    const holding = profile.tactical && this.aiX.posture && this.turn >= 2 && ratio < 0.75;
    const easyBrain = (this.brainOverride ?? this.difficulty) === "easy";
    for (const enemy of this.living("enemy")) {
      if (isBuildingKind(enemy.kind) || enemy.carriedById) continue; // carried units can't act
      if (this.aiBoarding.has(enemy.id)) continue; // told to board a carrier this turn
      // EASY hesitates: about a third of its units sit a turn out. It is the bot a new player
      // learns on, and at full activity it out-raced the "smart" brains in self-play.
      if (easyBrain && !dryRun && this.rng.chance(0.3)) continue;
      // The fun units act on every brain: a Boomer runs in and blows, a Breaker punches whatever it reaches.
      if (this.aiBoomerAct(enemy, players)) continue;
      if (this.aiPunchAct(enemy, players)) continue;
      // Push: a foe with water or the edge behind it is a free kill (Hard only).
      if (profile.tactical && this.aiShoveAct(enemy, players)) continue;
      // The rest of the toolkit (Hard only): carry troops, ram, screen with smoke, sow a mine.
      if (profile.tactical && this.aiX.moves) {
        if (this.aiCarryAct(enemy, players)) continue;
        if (this.aiRamAct(enemy, players)) continue;
        if (this.aiSlamAct(enemy, players)) continue;
        if (this.aiSmokeAct(enemy, players, behind)) continue;
      }
      // A Turret Tech sets a sentry down toward the foe before anything else (every brain: it is the unit's whole job).
      if (placeSpecFor(enemy.kind) && enemy.commandPoints > 0 && this.aiPlaceAct(enemy, players)) continue;
      // A trooper near a free emplacement with a foe in its reach goes and crews it (a Mortar Pit wants a mortarman).
      if (profile.tactical && enemy.commandPoints > 0 && isInfantryKind(enemy.kind)) {
        // ...but only a trooper with nothing to shoot yet: one already in the fight keeps fighting.
        const engaged = players.some((p) => !p.flying && dist(enemy.position, p.position) <= projectileRange(enemy));
        const post = engaged ? undefined : this.aiMountTarget(enemy, players);
        if (post && this.queueManFor(enemy, post)) continue;
      }
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
      if (target && (enemy.kind === "striker" || (profile.tactical && this.aiX.moves && isInfantryKind(enemy.kind) && !enemy.status.canShoot && hasIntactMeleeWeapon(enemy))) && enemy.commandPoints > 0 && separation <= meleeRange(enemy) + enemy.radius + target.radius) {
        const part = preferredPart(target, target.kind === "cover" ? "center" : "weakest");
        this.addOrder({ actorId: enemy.id, kind: "melee", targetId: target.id, targetPartId: part.id, aim: aimForPart(part), duration: 0.78 });
        spendCommandPoint(enemy);
        continue;
      }
      // Air units: the gunship guns flyers first; a bomber drops bombs when a ground foe is beneath it.
      if (isAirKind(enemy.kind) && enemy.commandPoints > 0) {
        const flyers = (players.length ? players : allPlayers).filter((p) => p.flying && p.status.alive);
        const airTgt = flyers.length ? nearest(enemy, flyers) : undefined;
        if (airTgt && enemy.status.canShoot && dist(enemy.position, airTgt.position) <= range && this.queueShootFor(enemy, airTgt, "center")) continue;
        // A bomber drops on the best clump inside its bomb reach, without moving.
        if (profile.tactical && this.aiX.bomb && enemy.grenades > 0 && isAirBomber(enemy) && enemy.commandPoints >= 1) {
          const run = this.aiBombTarget(enemy, players);
          if (run) {
            spendCommandPoint(enemy);
            enemy.grenades = Math.max(0, enemy.grenades - 1);
            this.addOrder({ actorId: enemy.id, kind: "grenade", destination: { ...run }, aim: "center", duration: 1.15 });
            continue;
          }
        }
        if (enemy.grenades > 0 && isAirBomber(enemy)) {
          const near = (players.length ? players : allPlayers).find((p) => !p.flying && p.status.alive && !isBuildingKind(p.kind) && dist(enemy.position, p.position) <= grenadeThrowRange(enemy) - 0.5);
          if (near) {
            spendCommandPoint(enemy);
            enemy.grenades = Math.max(0, enemy.grenades - 1);
            this.addOrder({ actorId: enemy.id, kind: "grenade", destination: { x: near.position.x, z: near.position.z }, aim: "center", duration: 1.15 });
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
        const isMelee = enemy.kind === "striker" || enemy.kind === "boomer" || enemy.kind === "breaker";
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
        const stand = profile.tactical && this.aiX.standoff ? Math.min(range * 0.8, Math.max(6, range * 0.55)) : Math.min(range * 0.8, 6);
        // HULL DOWN: a tank that has fired and still has the target in reach stays put (30% less damage taken until it moves).
        const hullHold = profile.tactical && this.aiX.moves && enemy.kind === "tank" && fired && Boolean(target) && separation <= range && ratio < 1.5;
        const wantsTarget = Boolean(target) && !hullHold && (isMelee || separation > stand);
        let goal: Vec2 | undefined;
        let advancing = false;
        // HARD: an intruder near our base pulls the nearby defenders back onto it.
        const intruder = profile.tactical && home && !carrying
          ? (players.length ? players : allPlayers).find((p) => dist(p.position, home) < 11)
          : undefined;
        // HARD: fragile ranged units keep their distance instead of walking into melee range.
        const kites = profile.tactical && !carrying && target && (enemy.kind === "sniper" || enemy.kind === "mortar" || enemy.kind === "grenadier")
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
        } else if (holding && !isMelee && !isAirKind(enemy.kind)) {
          // Outnumbered: fall back toward the base and hold there; anything that comes into reach gets shot.
          if (home && dist(enemy.position, home) > 14) goal = home;
          else if (target && separation <= range * 1.2) { goal = target.position; advancing = true; }
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
        // HARD: when pushing in, pick the post, not just the direction: height over the nearest foe, cover, how many guns
        // can reach the spot against how many friends stand by, and whether it can still shoot from there. (Measured
        // against the Normal bot: posts on the way in went 31-1 in wins/losses where plain marching went 30-6; letting a
        // unit that already fired scoot to a post lost ground 17-18, so firing units still hold and press.)
        const postable = profile.tactical && this.aiX.post && !carrying && !crippled && !fire && !isMelee && !isAirKind(enemy.kind) && !enemy.flying && !canJump(enemy);
        let posted: Vec2 | undefined;
        if (postable && advancing && !fired && allPlayers.length && !(this.aiDangerAt(enemy.position))) {
          const stepP = isVehicleKind(enemy.kind) ? Math.max(3.2, moveRange(enemy)) : moveRange(enemy);
          const pick = this.aiBestPost(enemy, goal, stepP, allPlayers, target, range, true);
          if (dist(pick, enemy.position) > 0.6) posted = pick;
        }
        // HOP: across a gap or up a ledge the walk cannot manage.
        if (profile.tactical && this.aiX.moves && !carrying && !crippled && !fire && isInfantryKind(enemy.kind) && enemy.commandPoints > 0 && allPlayers.length
          && this.aiHopAct(enemy, goal, allPlayers, range)) goal = undefined;
        if (goal) {
          const step = isVehicleKind(enemy.kind) ? Math.max(3.2, moveRange(enemy)) : moveRange(enemy);
          // When pushing toward a threat, prefer a tile that ends sheltered behind cover.
          let destination = posted ?? (profile.useCover && advancing && target
            ? this.coverBiasedDestination(enemy, goal, target, step)
            : this.navigateToward(enemy, goal, step));
          // A hull never ends its move brushing a sheer face: the drawn tread is wider than the clearance disc
          // (probe:terrain found a Karak tank 0.5m into a tower stump). Stop short instead.
          if (isVehicleKind(enemy.kind) && !enemy.flying && hullInRise(destination, enemy.radius * 1.2) && !hullInRise(enemy.position, enemy.radius * 1.2)) {
            let found: Vec2 | undefined;
            for (const f of [0.75, 0.5, 0.25]) {
              const shorter = { x: enemy.position.x + (destination.x - enemy.position.x) * f, z: enemy.position.z + (destination.z - enemy.position.z) * f };
              if (!hullInRise(shorter, enemy.radius * 1.2)) { found = shorter; break; }
            }
            destination = found ?? enemy.position;
          }
          // HARD: never END a move inside this turn's strike zone, fire or gas -- stop short instead.
          if (profile.tactical && this.aiDangerAt(destination) && !this.aiDangerAt(enemy.position)) {
            for (const f of [0.66, 0.33]) {
              const shorter = { x: enemy.position.x + (destination.x - enemy.position.x) * f, z: enemy.position.z + (destination.z - enemy.position.z) * f };
              if (!this.aiDangerAt(shorter)) { destination = shorter; break; }
            }
            if (this.aiDangerAt(destination)) destination = enemy.position; // hold rather than walk in
          }
          destination = this.spreadDestination(enemy, destination);
          if (dist(enemy.position, destination) > 0.2) {
            this.aiClaims.push({ at: { ...destination }, radius: enemy.radius });
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
        // CROUCH: holding a spot under fire with an action point to spare.
        if (profile.tactical && this.aiX.moves && enemy.commandPoints > 0 && allPlayers.length && !this.orders.some((o) => o.actorId === enemy.id && o.kind === "move")) this.aiCrouchAct(enemy, allPlayers);
      }
    }
  }

  /** Hard brain: the ground cluster worth a bomb run (fly over, drop): most foes (armour double) within the
   *  blast of a point the aircraft can reach, never with its own troops under it. */
  private aiBombTarget(actor: CombatEntity, foes: CombatEntity[]): Vec2 | undefined {
    const blast = explosiveBlast("grenade", actor.kind).radius;
    const friends = this.entities.filter((e) => e.team === actor.team && e.status.alive && !e.flying && e.kind !== "cover" && e.id !== actor.id);
    let best: Vec2 | undefined;
    let bestScore = 0;
    for (const f of foes) {
      if (f.flying || isBuildingKind(f.kind) || dist(f.position, actor.position) > grenadeThrowRange(actor) - 0.5) continue;
      if (friends.some((u) => dist(u.position, f.position) < blast + 0.8)) continue;
      const score = foes.reduce((sum, o) => sum + (!o.flying && dist(o.position, f.position) <= blast ? (isVehicleKind(o.kind) ? 2 : 1) : 0), 0);
      if (score > bestScore) { bestScore = score; best = f.position; }
    }
    return bestScore >= 2 ? { ...best! } : undefined;
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
      const blocker = this.entity(preview.impactEntityId);
      if (blocker?.kind === "sentry" && blocker.team !== actor.team && blocker.placedTurn === this.turn) return undefined; // not seen yet (an order)
      return { terrain: false, blocker };
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
      // Small pull toward the target's exposed rear — enough to circle when it costs little
      // progress, never enough to march the long way around.
      const flankBias = this.flankFactorAt(c, target) * 1.2;
      // HARD: high ground is worth a detour now that it halves a shooter's spread.
      const heightBias = this.aiProfile().tactical && !isMeleeKind(actor.kind) ? clamp(terrainHeightAt(c) - terrainHeightAt(actor.position), -1, 1.6) * 2.2 : 0;
      const score = progress + sheltered + flankBias + heightBias;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** Hard brain: how many of `foes` can shoot a unit standing at `pos` (height stretches or shrinks their reach). */
  private aiExposureAt(pos: Vec2, foes: CombatEntity[]): number {
    let n = 0;
    const here = terrainHeightAt(pos);
    for (const f of foes) {
      if (!f.status.alive || !f.status.canShoot || isMeleeKind(f.kind)) continue;
      const reach = projectileRange(f) + clamp((terrainHeightAt(f.position) - here) * 0.8, -2, 2);
      if (dist(f.position, pos) <= reach) n += 1;
    }
    return n;
  }

  /**
   * Hard brain: the best place to stand within one move. Scores height over the nearest foe (a shooter above its
   * target keeps its spread tight; below, it hangs open), cover toward that foe, how many foes can hit the spot
   * versus how many friends stand near to answer, whether the unit can still shoot from it, and (when pushing)
   * progress toward the goal. It stays put unless the best spot is clearly better, so units do not dance.
   */
  private aiBestPost(actor: CombatEntity, goal: Vec2 | undefined, step: number, foes: CombatEntity[], target: CombatEntity | undefined, range: number, pushing: boolean): Vec2 {
    const here = actor.position;
    const cands: Vec2[] = [here];
    for (const r of [0.5, 1]) {
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        const reach = this.blockedMoveDestination(actor, here, clampToArena({ x: here.x + Math.sin(a) * step * r, z: here.z + Math.cos(a) * step * r }), undefined, true);
        if (dist(reach, here) > 0.6) cands.push(reach);
      }
    }
    if (goal) cands.push(this.navigateToward(actor, goal, step));
    const friends = this.entities.filter((e) => e.team === actor.team && e.id !== actor.id && e.status.alive && e.status.canShoot && !isBuildingKind(e.kind));
    const score = (c: Vec2): number => {
      if (this.aiDangerAt(c)) return -50;
      const near = foes.filter((f) => f.status.alive && dist(f.position, c) <= range * 1.4).sort((a, b) => dist(a.position, c) - dist(b.position, c))[0];
      const heightEdge = near ? clamp(terrainHeightAt(c) - terrainHeightAt(near.position), -1.5, 2) * 2.4 : 0;
      const cover = near && this.isShelteredAt(c, near.position) ? 2.2 : 0;
      const backup = friends.filter((f) => dist(f.position, c) <= 7).length;
      const exposed = Math.max(0, this.aiExposureAt(c, foes) - backup * 0.8) * 0.9;
      const canFire = target && dist(c, target.position) <= range * 0.95 ? 2.5 : 0;
      const progress = goal ? (dist(here, goal) - dist(c, goal)) * (pushing ? 0.9 : 0.1) : 0;
      return heightEdge + cover - exposed + canFire + progress;
    };
    let best = here;
    let bestScore = score(here) + (pushing ? 1.2 : 2.5); // a new spot has to be clearly better; a unit already firing needs more reason to move
    for (const c of cands) {
      if (c === here) continue;
      const sc = score(c);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    return best;
  }

  /** Hard brain: army strength against the player's (cost x health). Below ~0.75 it holds its ground instead of marching in. */
  private aiStrengthRatio(): number {
    const value = (team: Team): number => this.fieldUnits(team).reduce((sum, e) => {
      const hp = e.parts.reduce((a, p) => a + p.hp, 0) / Math.max(1, e.parts.reduce((a, p) => a + p.maxHp, 0));
      return sum + troopSpec(e.kind as TroopKind).cost * hp;
    }, 0);
    return (value("enemy") + 60) / (value("player") + 60);
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
    // SIGNATURE STRIKE: a smart bot calls its faction's strike (Airstrike / Cluster / Lance) on a
    // clump of hostiles when it can spare the money, so the three factions also FEEL different from
    // the other side of the board. Never onto its own troops: strikes hit both teams.
    if (smart && this.fieldUnitCount(base.team) >= 2 && this.enemyStrikeAct(base)) return;
    // HARD: dig in -- a gun emplacement between the base and an approaching foe (owner 2026-10-02: smarter bots).
    if (this.aiProfile().tactical && this.enemyDefenseAct(base)) return;
    if (smart && this.aiX.econ && this.smartEconomyAct(base, desired)) return;
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
    // 30% per place: at 20% a $600 tank two places down outbid the $280 mortar at the head of the list.
    const rank = (kind: TroopKind): number => Math.max(0.2, 1 - 0.3 * (desired?.indexOf(kind) ?? 0));
    const wanted = affordable.filter((spec) => desired?.includes(spec.kind)).sort((a, b) => b.cost * rank(b.kind) - a.cost * rank(a.kind));
    // Easy buys whatever it lands on; the others buy the best they can.
    const pick = (this.brainOverride ?? this.difficulty) === "easy"
      ? affordable[Math.floor(this.rng.next() * affordable.length)].kind
      : (wanted[0] ?? [...affordable].sort((a, b) => b.cost - a.cost)[0]).kind;
    this.spawnTroopFor(base, pick);
  }

  /**
   * SMART ECONOMY (Normal and Hard). Army first, tempo second, tech last. The old rule researched whenever money allowed and the
   * base has ONE order a turn, so a Hard bot researched nine doctrines while fielding two troops. Now:
   * build to parity (and at least 3), take the AP upgrade (two base orders a turn) early, then income, then the
   * next doctrine on its path only with an army out, and otherwise buy the most-wanted troop.
   * Returns true when it spent the order.
   */
  private smartEconomyAct(base: CombatEntity, desired: TroopKind[] | undefined): boolean {
    const mine = this.fieldUnitCount(base.team);
    const theirs = this.fieldUnitCount(base.team === "enemy" ? "player" : "enemy");
    const money = this.money(base.team);
    const cheapest = Math.min(...TROOP_CATALOG.filter((t) => !this.spawnFailureReason(base, t.kind) || this.spawnFailureReason(base, t.kind)?.startsWith("Not enough money")).map((t) => t.cost), 999);
    const buy = (): boolean => {
      const options = TROOP_CATALOG.filter((spec) => !this.spawnFailureReason(base, spec.kind));
      if (!options.length) return false;
      const rank = (kind: TroopKind): number => Math.max(0.2, 1 - 0.3 * (desired?.indexOf(kind) ?? 0));
      const wanted = options.filter((spec) => desired?.includes(spec.kind)).sort((a, b) => b.cost * rank(b.kind) - a.cost * rank(a.kind));
      return this.spawnTroopFor(base, (wanted[0] ?? [...options].sort((a, b) => b.cost - a.cost)[0]).kind);
    };
    if (this.fieldUnitCount(base.team) >= POP_CAP) return false;
    // 1. Never fall behind: parity with the foe, and at least three.
    if (mine < Math.max(3, theirs) && buy()) return true;
    // 2. Two base orders a turn, once there is an army to use them on.
    if (base.maxCommandPoints < 2 && mine >= 3 && money >= COMMAND_UPGRADE_COST + 100 && this.upgradeCommandFor(base)) return true;
    // 3. Compounding income early.
    const incomeCost = incomeUpgradeCost(base);
    if (incomeCost !== undefined && this.turn <= 9 && mine >= 3 && money >= incomeCost + cheapest && this.upgradeIncomeFor(base)) return true;
    // 3b. Armour, then the cannon, once it has an army and the money (never at the cost of falling behind).
    if (mine >= 5 && mine >= theirs && this.turn >= 5) {
      for (const id of ["armor1", "cannon", "armor2"] as const) {
        const spec = baseUpgradeSpec(id);
        if (!this.baseUpgradeFailureReason(base, id) && money >= spec.cost + cheapest * 2 && this.upgradeBaseFor(base, id)) return true;
      }
    }
    // 4. The next doctrine on its path, only with an army out and money to spare.
    if (mine >= 4) {
      const next = this.factionOf(base.team).aiTechPath.find((id) => !this.researchFailureReason(base, id));
      const node = next ? techNode(next) : undefined;
      // The first doctrines are cheap and open the roster (a bot that never tops $300 sat on Assault for eleven turns): no spare-cash pad for them.
      const early = (base.unlockedTech?.length ?? 0) < 3 && this.aiProfile().tactical;
      if (node && money >= node.cost + (early ? 0 : cheapest) && this.researchTechFor(base, node.id)) return true;
    }
    // 5. Otherwise field the most-wanted troop.
    return buy();
  }

  /** Hard brain: with hostiles closing on the base and money to spare, field one of its gun defenses toward them. */
  private enemyDefenseAct(base: CombatEntity): boolean {
    const foe: Team = base.team === "enemy" ? "player" : "enemy";
    const near = this.fieldUnits(foe).filter((e) => !e.flying && dist(e.position, base.position) < 22);
    if (!near.length || this.defenseCount(base.team) >= 2 || this.money(base.team) < 480) return false;
    const kind = (["bunker", "exturret", "turret"] as const).find((k) => this.factionOf(base.team).defenses.includes(k) && !this.buildBlockedReason(base, k));
    if (!kind) return false;
    const closest = near.reduce((a, b) => (dist(a.position, base.position) <= dist(b.position, base.position) ? a : b));
    const dir = normalize({ x: closest.position.x - base.position.x, z: closest.position.z - base.position.z });
    for (let reach = base.radius + 3.5; reach <= this.defensePlacementRadius(base); reach += 1.2) {
      for (const swing of [0, 0.5, -0.5, 1.0, -1.0]) {
        const c = Math.cos(swing), sn = Math.sin(swing);
        const at = clampToArena({ x: base.position.x + (dir.x * c - dir.z * sn) * reach, z: base.position.z + (dir.x * sn + dir.z * c) * reach });
        if (!this.buildFailureReason(base, kind, at)) return this.buildStructureFor(base, kind, at, this.placementYaw(base.position, at));
      }
    }
    return false;
  }

  private enemyStrikeAct(base: CombatEntity): boolean {
    const foe: Team = base.team === "enemy" ? "player" : "enemy";
    // Only a STRIKE is worth dropping on a crowd; the utility powers (recon / smoke / resupply) are not bombs.
    // Its strongest strike it can afford with $150 to spare (the list runs from starter to top tier).
    const kind = [...this.factionOf(base.team).supports].reverse().find((k) =>
      DAMAGING_SUPPORT.has(k) && !this.supportFailureReason(base, k) && this.money(base.team) >= supportPowerSpec(k).cost + 150);
    if (!kind) return false;
    const hostiles = this.fieldUnits(foe).filter((e) => !e.flying && !e.carriedById);
    const friends = this.entities.filter((e) => e.team === base.team && e.status.alive && !e.flying && e.kind !== "base");
    let best: Vec2 | undefined;
    let bestScore = 0;
    for (const h of hostiles) {
      if (friends.some((f) => dist(f.position, h.position) < 6.5)) continue;
      // Worth: hostiles caught around this one, armour counting double.
      const score = hostiles.reduce((sum, o) => sum + (dist(o.position, h.position) <= 3 ? (isVehicleKind(o.kind) ? 2 : 1) : 0), 0);
      if (score > bestScore) { bestScore = score; best = h.position; }
    }
    if (!best || bestScore < 3) return false;
    return this.queueSupportFor(base, kind, best);
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
    const pref: TroopKind[] = [];
    // Contest the air lane with a Flak Track.
    if (playerFlyers > 0 && !haveAntiAir) pref.push("flak", "heavy", "sniper");
    if (playerVehicles > 0 && !haveAntiArmor) pref.push("bazooka", "tank", "heavy", "grenadier", "artillery");
    // A dug-in player (turrets, bunkers, manned guns) is shelled, not charged.
    if (this.entities.filter((e) => e.team === "player" && e.status.alive && isDefenseKind(e.kind) && e.kind !== "wall").length >= 2) pref.push("artillery", "mortar", "grenadier");
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
  // NO STACKING (owner 2026-10-02: "I see 2 standing right on each other"). Where each AI unit has
  // already claimed to END this turn; a later unit that would end within a body's width of a claim or
  // a friendly standing still slides to the nearest free spot beside it.
  private aiClaims: { at: Vec2; radius: number }[] = [];
  private spreadDestination(actor: CombatEntity, destination: Vec2): Vec2 {
    if (actor.flying) return destination;
    const taken = (p: Vec2): boolean =>
      this.aiClaims.some((c) => dist(c.at, p) < c.radius + actor.radius + SPAWN_GAP) ||
      this.entities.some((e) => e.id !== actor.id && e.team === actor.team && e.status.alive && !e.flying && !e.carriedById && e.kind !== "cover" && e.kind !== "base" &&
        !this.orders.some((o) => o.actorId === e.id && o.kind === "move" && !o.done) && dist(e.position, p) < e.radius + actor.radius + SPAWN_GAP);
    if (!taken(destination)) return destination;
    const start = actor.position;
    for (let r = 1.2; r <= 4.8; r += 1.2) {
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * Math.PI * 2;
        const cand = clampToArena({ x: destination.x + Math.sin(a) * r, z: destination.z + Math.cos(a) * r });
        if (taken(cand)) continue;
        const reachable = this.blockedMoveDestination(actor, start, cand, undefined, true);
        if (dist(reachable, cand) < 0.4 && !taken(reachable)) return reachable;
      }
    }
    return destination;
  }

  // ---- AI PATHFINDING (owner 2026-10-02: "it got stuck on something and then not know what to do at
  // all rather than going around it"). The old greedy sidestep dead-ends on any concave obstacle (a
  // mesa wall, a river bend). Ground units now plan a real A* route over a 1.2m grid of walkable
  // cells (dry, no hull in a rise, clear of solid props) and walk its first `step` metres.
  private aiGridCache?: { turn: number; sig: number; cells: Map<string, Uint8Array> };
  private static readonly GRID = 1.2;

  private aiWalkable(actor: CombatEntity): { cols: number; rows: number; x0: number; z0: number; ok: (c: number, r: number) => boolean } {
    const g = TacticalSim.GRID;
    const x0 = ARENA_BOUNDS.minX, z0 = ARENA_BOUNDS.minZ;
    const cols = Math.ceil((ARENA_BOUNDS.maxX - x0) / g), rows = Math.ceil((ARENA_BOUNDS.maxZ - z0) / g);
    const sig = this.entities.length * 31 + this.projectiles.length; // wrecks/defenses appearing changes the grid
    if (!this.aiGridCache || this.aiGridCache.turn !== this.turn || this.aiGridCache.sig !== sig) this.aiGridCache = { turn: this.turn, sig, cells: new Map() };
    const big = actor.radius >= 1;
    const key = `${this.mapDef.id}|${big}|${cols}x${rows}|${x0}`;
    let cells = this.aiGridCache.cells.get(key);
    if (!cells) { cells = new Uint8Array(cols * rows); this.aiGridCache.cells.set(key, cells); } // 0 unknown, 1 ok, 2 blocked
    const solids = this.entities.filter((e) => e.status.alive && !e.flying && (e.kind === "base" || isDefenseKind(e.kind) || (e.kind === "cover" && e.coverKind !== "ridge")));
    const reach = actor.radius * 0.9;
    const ok = (c: number, r: number): boolean => {
      if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
      const i = r * cols + c;
      if (cells![i]) return cells![i] === 1;
      const p = { x: x0 + (c + 0.5) * g, z: z0 + (r + 0.5) * g };
      // Clear of any wall-height face by the same margin movement itself keeps (spawnClearance): a route
      // hugging a mesa foot is one blockedBySteepTerrain refuses to walk.
      const here = terrainHeightAt(p);
      let walk = !pointInWater(p) && !hullInRise(p, reach) && !discSamples(p, spawnClearance(actor.radius) * 0.85).some((q) => terrainHeightAt(q) - here > TERRAIN_STEP);
      if (walk) for (const e of solids) if (e.id !== actor.id && dist(e.position, p) < e.radius + reach + 0.15) { walk = false; break; }
      cells![i] = walk ? 1 : 2;
      return walk;
    };
    return { cols, rows, x0, z0, ok };
  }

  /** The point `step` metres along a planned A* route to `goal`, or undefined when no route exists. */
  private aiPathStep(actor: CombatEntity, goal: Vec2, step: number): Vec2 | undefined {
    const grid = this.aiWalkable(actor);
    const g = TacticalSim.GRID;
    const cellOf = (p: Vec2): [number, number] => [Math.floor((p.x - grid.x0) / g), Math.floor((p.z - grid.z0) / g)];
    const center = (c: number, r: number): Vec2 => ({ x: grid.x0 + (c + 0.5) * g, z: grid.z0 + (r + 0.5) * g });
    const [sc, sr] = cellOf(actor.position);
    let [gc, gr] = cellOf(clampToArena(goal));
    if (!grid.ok(gc, gr)) {
      // The goal itself is blocked (a unit's position, a prop): aim at the nearest open cell to it.
      let found = false;
      for (let rad = 1; rad <= 6 && !found; rad += 1) {
        let bestD = Infinity;
        for (let dc = -rad; dc <= rad; dc += 1) for (let dr = -rad; dr <= rad; dr += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad || !grid.ok(gc + dc, gr + dr)) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) { bestD = d; found = true; var bc = gc + dc, br = gr + dr; }
        }
        if (found) { gc = bc!; gr = br!; }
      }
      if (!found) return undefined;
    }
    const cols = grid.cols;
    const idx = (c: number, r: number): number => r * cols + c;
    const open = new Map<number, number>(); // cell -> f
    const came = new Map<number, number>();
    const gScore = new Map<number, number>([[idx(sc, sr), 0]]);
    open.set(idx(sc, sr), Math.hypot(gc - sc, gr - sr));
    const h = (c: number, r: number): number => Math.hypot(gc - c, gr - r);
    let reached = -1;
    let guard = 0;
    while (open.size && guard++ < 6000) {
      let cur = -1, curF = Infinity;
      for (const [k, f] of open) if (f < curF) { curF = f; cur = k; }
      open.delete(cur);
      const c = cur % cols, r = Math.floor(cur / cols);
      if (c === gc && r === gr) { reached = cur; break; }
      const hereH = terrainHeightAt(center(c, r));
      for (let dc = -1; dc <= 1; dc += 1) for (let dr = -1; dr <= 1; dr += 1) {
        if (!dc && !dr) continue;
        const nc = c + dc, nr = r + dr;
        if (!grid.ok(nc, nr)) continue;
        if (dc && dr && (!grid.ok(c + dc, r) || !grid.ok(c, r + dr))) continue; // no corner cutting
        if (Math.abs(terrainHeightAt(center(nc, nr)) - hereH) > TERRAIN_STEP) continue;
        const ni = idx(nc, nr);
        const tentative = (gScore.get(cur) ?? 0) + (dc && dr ? 1.414 : 1);
        if (tentative < (gScore.get(ni) ?? Infinity)) {
          gScore.set(ni, tentative);
          came.set(ni, cur);
          open.set(ni, tentative + h(nc, nr));
        }
      }
    }
    if (reached < 0) return undefined;
    const route: Vec2[] = [];
    for (let k = reached; k !== undefined; k = came.get(k) as number) {
      route.push(center(k % cols, Math.floor(k / cols)));
      if (k === idx(sc, sr)) break;
    }
    route.reverse();
    route[0] = { ...actor.position };
    let left = step;
    for (let i = 1; i < route.length; i += 1) {
      const seg = dist(route[i - 1], route[i]);
      if (seg >= left) {
        const t = left / Math.max(seg, 0.0001);
        return { x: route[i - 1].x + (route[i].x - route[i - 1].x) * t, z: route[i - 1].z + (route[i].z - route[i - 1].z) * t };
      }
      left -= seg;
    }
    return route[route.length - 1];
  }

  private navigateToward(actor: CombatEntity, goal: Vec2, step: number): Vec2 {
    const start = actor.position;
    // Plan around obstacles first (ground units); fall back to the greedy sidestep when no route exists.
    if (!actor.flying && !canJump(actor) && dist(start, goal) > 1.5) {
      const waypoint = this.aiPathStep(actor, goal, step);
      if (waypoint) {
        const reachable = this.blockedMoveDestination(actor, start, clampToArena(waypoint), undefined, true);
        if (dist(start, reachable) >= Math.min(step, dist(start, goal)) * 0.35) return reachable;
      }
    }
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
    for (const entity of this.entities) {
      repairForNewTurn(entity);
      // A dead Comms Mast jams the whole force: one action point each (both sides, not just the bot).
      if (entity.kind !== "base" && entity.status.alive && (entity.team === "player" || entity.team === "enemy") && this.commsDown(entity.team)) {
        entity.commandPoints = Math.min(entity.commandPoints, 1);
      }
      if (entity.markedUntilTurn !== undefined && entity.markedUntilTurn < this.turn) {
        entity.markedUntilTurn = undefined;
        entity.markedById = undefined;
      }
      if (entity.disabledUntilTurn !== undefined) {
        if (entity.disabledUntilTurn >= this.turn && entity.status.alive) entity.commandPoints = 0;
        else entity.disabledUntilTurn = undefined;
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
    this.refreshMounts();
    if (!this.hotseat && this.entities.some((e) => e.kind === "base" && e.team === "player" && e.status.alive && e.radarOnline)) { this.revealedOrders = true; this.revealedTeam = "player"; this.enemyIntentCache = undefined; }
    this.runEconomyTick();
    this.runSalvageTick();
    this.runCaptureTick();
    this.runBurnTick();
    this.runGasTick();
    this.runSentryTick();
    this.runSmokeTick();
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
    const ladder: TroopKind[] = ["soldier", "scout", "heavy", "striker", "grenadier", "sniper", "runabout", "tank", "mortar", "artillery"];
    const pool = ladder.slice(0, Math.min(ladder.length, 2 + wave));
    const bounds = this.mapDef.terrain.bounds;
    for (let i = 0; i < count; i += 1) {
      const kind = pool[Math.floor(this.rng.range(0, pool.length)) % pool.length];
      const z = this.rng.range(bounds.minZ + 3, bounds.maxZ - 3);
      const unit = makeTroop(kind, `e-wave-${++this.troopSeq}`, `${this.troopLabel("enemy", kind)} ${this.troopSeq}`, "enemy", clampToArena({ x: bounds.maxX - 2.5, z }));
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
      .flatMap((e) => e.kind === "slag"
        ? this.slagZones(e).map((z) => ({ kind: e.kind, ...z }))
        : [{ kind: e.kind, ...(e.kind === "lightning" ? this.lightningZone(turn) : this.eventZone(e)) }]);
    return [...fromMap, ...this.forcedZones];
  }

  // BOTH furnaces vent on every spill, mirror-symmetric. It used to alternate, starting with the
  // player's corner on turn 3: the player's foundry floor flooded first (beside its deploy ring) and
  // one time more per 16 turns, and balance self-play read Ironworks 1 win to 13 for the enemy seat.
  private slagZones(e: MapEventConfig): { x: number; z: number; radius: number }[] {
    const zone = this.eventZone(e);
    return [zone, { x: -zone.x, z: -zone.z, radius: zone.radius }];
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
  // `soon` = map hazards that strike NEXT turn (a turn of warning: "what would kill you" is on the ground before it fires).
  environment(): { sandstorm: number; ionstorm: number; notice?: string; zones: { kind: MapEventKind; x: number; z: number; radius: number }[]; soon: { kind: MapEventKind; x: number; z: number; radius: number }[] } {
    const zones = this.eventZonesForTurn();
    const soon = this.eventZonesForTurn(this.turn + 1).filter((z) => !this.forcedZones.includes(z) && !zones.some((n) => n.kind === z.kind && dist(n, z) < 0.5));
    return { sandstorm: this.sandstormActive() ? 1 : 0, ionstorm: this.ionStormActive() ? 1 : 0, notice: this.eventNotice, zones, soon };
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
      this.pushLog("An ion storm scrambles command links — units are limited to one action point.");
      notice = "⚠ Ion storm — units are scrambled to a single action point.";
    } else if (ionNow) {
      notice = "⚠ Ion storm — units limited to one action point.";
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
    // No "next turn" banner: the forecast chip already shows a coming storm or barrage (fewest words on screen).
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

  // PARADROP: two of the caller's line troopers land around the point (dry, clear ground; never past
  // the field cap). They act from the next turn, like any deploy.
  private landParadrop(point: Vec2, team: Team): void {
    const base = this.entities.find((e) => e.kind === "base" && e.team === team && e.status.alive);
    if (!base) return;
    let landed = 0;
    for (let i = 0; i < 2 && this.fieldUnitCount(team) < POP_CAP; i += 1) {
      const unit = this.createTroop("soldier", base, nearestDryPoint(this.freeSpotNear(point, 0.5)));
      unit.commandPoints = 0;
      this.entities.push(unit);
      this.syncEntityElevation(unit);
      landed += 1;
    }
    this.effect("ping", point, point, 0xbfe8ff, 0.9, 2.2);
    this.pushLog(landed ? `Paradrop: ${landed} trooper${landed === 1 ? "" : "s"} on the ground` : "Paradrop aborted: the field is full");
  }

  // A single environmental detonation: a blast effect plus AoE damage to anything in range
  // (both teams — it's the battlefield, not a unit's attack). Bases are spared so the sky can't
  // hand someone the win.
  private detonateStrike(strike: { point: Vec2; radius: number; damage: number; kind: StrikeKind; team?: Team }): void {
    // Utility support powers land a payload, not a blast.
    if (strike.kind === "smokedrop") {
      this.smokeClouds.push({ id: `smoke-${++this.effectSeq}`, x: strike.point.x, z: strike.point.z, radius: SMOKE_RADIUS, turnsLeft: SMOKE_TURNS });
      this.effect("blast", strike.point, strike.point, SMOKE_COLOR, 0.9, SMOKE_RADIUS);
      this.pushLog("The smoke screen blooms — flat shots through it are lost");
      return;
    }
    if (strike.kind === "emp") {
      let hit = 0;
      for (const e of this.entities) {
        if (!e.status.alive || e.team === strike.team || (!isVehicleKind(e.kind) && !isDefenseKind(e.kind)) || e.kind === "wall") continue;
        if (dist(e.position, strike.point) > strike.radius + e.radius) continue;
        e.disabledUntilTurn = this.turn + 1;
        this.effect("ping", { ...e.position }, { ...e.position }, 0x8de4ff, 0.9, e.radius + 0.8);
        hit += 1;
      }
      this.effect("blast", strike.point, strike.point, PULSE_EMP, 0.7, strike.radius);
      this.tally(strike.team ?? "player", "empHits", hit);
      this.pushLog(hit ? `The EMP burst kills the power on ${hit} machine${hit === 1 ? "" : "s"}` : "The EMP burst fizzles on empty ground");
      return;
    }
    if (strike.kind === "minedrop") {
      for (let i = 0; i < 5; i += 1) {
        const angle = this.rng.range(0, Math.PI * 2);
        const r = Math.sqrt(this.rng.range(0, 1)) * strike.radius;
        const at = clampToArena({ x: strike.point.x + Math.sin(angle) * r, z: strike.point.z + Math.cos(angle) * r });
        if (pointInWater(at)) continue;
        this.mines.push({ id: `mine-${++this.effectSeq}`, x: at.x, z: at.z, team: strike.team ?? "player" });
      }
      this.effect("ping", strike.point, strike.point, 0xffb02e, 0.8, strike.radius);
      this.pushLog("Mines scatter across the point");
      return;
    }
    if (strike.kind === "medevac") {
      let helped = 0;
      for (const e of this.entities) {
        if (!e.status.alive) continue;
        if (e.team !== strike.team || !isInfantryKind(e.kind) || dist(e.position, strike.point) > strike.radius + e.radius) continue;
        for (const part of e.parts) part.hp = part.maxHp;
        e.burning = undefined;
        recomputeStatus(e);
        helped += 1;
      }
      this.effect("ping", strike.point, strike.point, 0x8effa6, 0.9, strike.radius);
      this.pushLog(helped ? `Medevac: ${helped} trooper${helped === 1 ? "" : "s"} patched to full` : "Medevac lands on empty ground");
      return;
    }
    if (strike.kind === "sentrydrop") {
      const team = strike.team ?? "player";
      const base = this.entities.find((e) => e.kind === "base" && e.team === team);
      const yaw = base ? Math.atan2(strike.point.x - base.position.x, strike.point.z - base.position.z) : 0;
      this.deploySentry(team, nearestDryPoint(this.freeSpotNear(strike.point, 0.6)), yaw, "A dropped");
      return;
    }
    if (strike.kind === "resupply") {
      let helped = 0;
      for (const e of this.entities) {
        if (!e.status.alive || e.team !== strike.team || e.kind === "base" || isDefenseKind(e.kind) || e.kind === "cover") continue;
        if (dist(e.position, strike.point) > strike.radius + e.radius) continue;
        this.healEntity(e, RESUPPLY_HEAL);
        e.grenades = e.maxGrenades;
        helped += 1;
      }
      this.effect("ping", strike.point, strike.point, 0x9ef0b8, 0.9, strike.radius);
      this.pushLog(helped ? `Resupply lands — ${helped} unit${helped === 1 ? "" : "s"} patched up and rearmed` : "Resupply lands on empty ground");
      return;
    }
    if (strike.kind === "lightning") {
      // The bolt: a beam effect from the sky to the point, then the blast. Sets gas off like any
      // other blast, and the ground burns briefly where it lands.
      this.effect("bolt", strike.point, strike.point, 0xd8ecff, 0.45, 0.4);
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: strike.point.x, z: strike.point.z, radius: 1.2, turnsLeft: 1 });
    }
    if (strike.kind === "paradrop") {
      this.landParadrop(strike.point, strike.team ?? "player");
      return;
    }
    if (strike.kind === "napalm") {
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: strike.point.x, z: strike.point.z, radius: strike.radius, turnsLeft: 2 });
    }
    if (strike.kind === "slag") {
      // The spill leaves the floor burning for two turns (the flamer's burn zone, so the tick,
      // the render and the AI's fear of fire all come for free).
      this.burnZones.push({ id: `burn-${++this.effectSeq}`, x: strike.point.x, z: strike.point.z, radius: strike.radius * 0.85, turnsLeft: 2 });
    }
    const color = strike.kind === "lightning" ? 0xd8ecff
      : strike.kind === "napalm" ? 0xff6a1c
      : strike.kind === "slag" ? 0xff7a2a
      : strike.kind === "barrage" ? 0xffac5a
      : strike.kind === "collapse" ? 0xb59a72
      : strike.kind === "laser" ? 0xff5a4d
      : strike.kind === "cluster" ? 0xffb02e
      : strike.kind === "railstrike" ? 0xc9d3dc
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
    if (strike.kind === "barrage" && !strike.team) this.pushLog("Shells hammer the marked zone."); // a called barrage logged once when tasked
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
      this.tally("player", `killer:${actor.kind}`);
    }
    // SCAVENGERS (Syndicate doctrine): a destroyed enemy troop pays a share of its cost back.
    if (result.killed && isTroopKind(target.kind) && actor.team !== target.team && actor.team !== "neutral" && target.team !== "neutral") {
      const bounty = this.factionOf(actor.team).doctrine.bounty;
      if (bounty) {
        const paid = Math.round(troopSpec(target.kind as TroopKind).cost * bounty);
        this.addMoney(actor.team, paid);
        this.pushLog(`Scavenged $${paid} from ${target.name}`);
        this.effect("ping", target.position, target.position, 0xffd24a, 1.4, target.radius + 0.9);
      }
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

  private effect(type: VisualEvent["type"], from: Vec2, to: Vec2, color: number, duration: number, radius?: number, fromHeight?: number): void {
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
      ...(fromHeight !== undefined ? { fromHeight } : {}),
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

/** What a troop is worth on paper, for the Deploy card: total HP (all parts) and damage per shot
 *  (a burst weapon's full volley). Built once per kind from the real unit factory, so it cannot
 *  drift from what actually spawns. */
const troopSheets = new Map<TroopKind, { hp: number; hit: number }>();
export function troopSheet(kind: TroopKind): { hp: number; hit: number } {
  let sheet = troopSheets.get(kind);
  if (!sheet) {
    const unit = makeTroop(kind, "sheet", "sheet", "player", { x: 0, z: 0 });
    const stats = unitStats(kind);
    sheet = { hp: Math.round(unit.parts.reduce((sum, p) => sum + p.maxHp, 0)), hit: Math.round(stats.shotDamage * (stats.burst ?? 1)) };
    troopSheets.set(kind, sheet);
  }
  return sheet;
}

function makeTroop(kind: TroopKind, id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const unit = makeTroopBase(kind, id, name, team, position);
  scaleEntityHp(unit, tierHpMultiplier(unit.kind));
  return unit;
}

function makeTroopBase(kind: TroopKind, id: string, name: string, team: Team, position: Vec2): CombatEntity {
  switch (kind) {
    case "tank": return createTank(id, name, team, position);
    case "artillery": return createArtillery(id, name, team, position);
    case "gunship": return createGunship(id, name, team, position);
    case "bomber": return createBomber(id, name, team, position);
    case "flak": return createFlak(id, name, team, position);
    case "scout": return createScout(id, name, team, position);
    case "sniper": return createSniper(id, name, team, position);
    case "striker": return createStriker(id, name, team, position);
    case "heavy": return createHeavy(id, name, team, position);
    case "grenadier": return createGrenadier(id, name, team, position);
    case "mortar": return createMortar(id, name, team, position);
    case "flamer": return createFlamer(id, name, team, position);
    case "jumper": return createJumper(id, name, team, position);
    case "bazooka": return createBazooka(id, name, team, position);
    case "turrettech": return createTurretTech(id, name, team, position);
    case "sledge": return createSledge(id, name, team, position);
    case "lancer": return createLancer(id, name, team, position);
    case "ironclad": return createIronclad(id, name, team, position);
    case "runabout": return createRunabout(id, name, team, position);
    case "hornet": return createHornet(id, name, team, position);
    case "breaker": return createBreaker(id, name, team, position);
    case "boomer": return createBoomer(id, name, team, position);
    case "juggernaut": return createJuggernaut(id, name, team, position);
    default: return createSoldier(id, name, team, position);
  }
}

// Global mobility boost: every unit covers much more ground per order so the (now larger) maps
// don't turn into slow marches. Applied to both range AND animation speed, so a longer move still
// resolves in the same wall-clock time. Base per-kind values below stay the tuning surface.
export const MOVE_RANGE_SCALE = 2.0;

function moveRange(entity: CombatEntity): number {
  return baseMoveRange(entity) * MOVE_RANGE_SCALE * (entity.mods?.move ?? 1);
}

function baseMoveRange(entity: CombatEntity): number {
  return unitStats(entity.kind).moveRange;
}

function defenseRadius(kind: DefenseKind): number {
  if (kind === "wall") return 1.15;
  if (kind === "exturret") return 1.0;
  if (kind === "bunker") return 1.2;
  if (isMountKind(kind)) return 1.0;
  if (kind === "sensor") return 0.7;
  if (kind === "sandbag") return COVER_PROFILES.sandbag.radius;
  if (kind === "minefield") return 1.4; // the triangle's reach
  return 0.95;
}

/** The emplacement entity for a defense kind (sandbags and minefields are not entities). */
function makeEmplacement(kind: DefenseKind, id: string, name: string, team: Team, at: Vec2): CombatEntity {
  switch (kind) {
    case "turret": return createTurret(id, name, team, at);
    case "exturret": return createExTurret(id, name, team, at);
    case "bunker": return createBunker(id, name, team, at);
    case "sensor": return createSensor(id, name, team, at);
    case "gunpost": return createGunPost(id, name, team, at);
    case "mortarpit": return createMortarPit(id, name, team, at);
    case "rocketpost": return createRocketPost(id, name, team, at);
    case "flamepost": return createFlamePost(id, name, team, at);
    default: return createWall(id, name, team, at);
  }
}

/** A minefield's three mines: a triangle 1.3m round the point, turned with the placement. */
export function minefieldPoints(point: Vec2, yaw: number): Vec2[] {
  return [0, 1, 2].map((i) => {
    const a = yaw + (i * Math.PI * 2) / 3;
    return clampToArena({ x: point.x + Math.sin(a) * 1.3, z: point.z + Math.cos(a) * 1.3 });
  });
}

function ramRange(entity: CombatEntity): number {
  return unitStats(entity.kind).ramRange;
}

/** Jet-jump mover with an intact pack: its moves are arcs, not walks. */
function canJump(entity: CombatEntity): boolean {
  return Boolean(unitStats(entity.kind).jump) && entity.parts.some((p) => p.id === "pack" && p.hp > 0);
}

/** Every infantry strike includes a RUSH: the order closes this far before the swing, in the same
 *  order and AP (owner 2026-09-24: the strike reach was "so close it's basically not usable", and a
 *  move-then-strike took two orders). The Striker's charge goes further. */
export const MELEE_RUSH = 3.5;
function meleeRange(entity: CombatEntity): number {
  const rush = entity.kind === "striker" ? STRIKER_CHARGE : entity.kind === "breaker" ? BREAKER_CHARGE : isInfantryKind(entity.kind) ? MELEE_RUSH : 0;
  return unitStats(entity.kind).meleeRange + rush;
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
/** Kinds that can take ground units aboard: the Runabout. */
function isCarrierKind(kind: EntityKind): boolean {
  return kind === "runabout";
}

/** A ground carrier (the Runabout): troops board from beside the hull and step off beside it. */
function isGroundCarrier(kind: EntityKind): boolean {
  return kind === "runabout";
}

function isAirBomber(entity: CombatEntity): boolean {
  return entity.flying === true && grenadeThrowRange(entity) > 0;
}

function limitMoveDestination(entity: CombatEntity, start: Vec2, destination: Vec2): Vec2 {
  const range = moveRange(entity);
  if (range <= 0) return { ...start };
  return moveToward(start, destination, range);
}

/**
 * WHERE EACH GUN REALLY IS (2026-10-03: "gunship bullets appear to fire from above the gunship"). Every round, preview line and muzzle flash
 * starts at this one point, so it has to be the barrel tip on the model, in the unit's own frame: x to its right, z forward, y above its
 * `elevation` (the feet for ground units, the BODY CENTRE for aircraft, whose model hangs about the group origin). Numbers are read off the
 * builders in worldRenderer.ts; `muzzles.test.ts` pins the aircraft ones and the shots-gpu `muzzles` case frames the rest.
 */
const MUZZLE_LOCAL: Partial<Record<string, { x: number; z: number; y: number }>> = {
  // aircraft: chin gun / wing cannons / bomb rack under the airframe
  gunship: { x: 0, z: 1.4, y: -0.3 }, bomber: { x: 0, z: 1.2, y: -0.3 },
  // ground vehicles
  tank: { x: 0, z: 2.0, y: 1.1 }, artillery: { x: 0, z: 2.2, y: 1.6 }, hornet: { x: 0, z: 1.65, y: 1.02 },
  runabout: { x: 0, z: 0.7, y: 1.4 }, flak: { x: 0, z: 0.7, y: 2.0 },
  // emplacements
  turret: { x: 0, z: 1.45, y: 0.95 }, exturret: { x: 0, z: 1.1, y: 1.5 }, bunker: { x: 0, z: 1.5, y: 0.72 },
  gunpost: { x: 0, z: 1.1, y: 0.8 }, mortarpit: { x: 0, z: 0.7, y: 0.6 }, rocketpost: { x: 0, z: 1.15, y: 1.1 }, flamepost: { x: 0, z: 1.05, y: 0.62 }, cannonpost: { x: 0, z: 1.75, y: 0.95 },
  sentry: { x: 0, z: 0.8, y: 0.66 }, base: { x: 0.2, z: 2.6, y: 3.8 },
  // long guns carry the muzzle further out front than a carbine does
  sniper: { x: 0.5, z: 1.0, y: 1.12 }, bazooka: { x: 0.45, z: 1.0, y: 1.1 }, flamer: { x: 0.42, z: 0.9, y: 1.0 },
  lancer: { x: 0.42, z: 0.8, y: 1.05 }, grenadier: { x: 0.46, z: 0.7, y: 1.02 }, mortar: { x: 0.46, z: 0.58, y: 1.02 },
  // the Breaker's wrist gun rides the gauntlet; the Juggernaut's cannon sits over its shoulder (builds are 1.12x / 1.5x wide)
  breaker: { x: 0.56, z: 0.85, y: 1.0 }, juggernaut: { x: 0.68, z: 1.15, y: 1.62 },
  ironclad: { x: 0.7, z: 0.6, y: 0.95 }, turrettech: { x: 0.49, z: 0.5, y: 0.95 },
};
/** The bomb rack under a gunship or bomber: a bomb leaves from beneath the airframe. */
const BOMB_RACK_LOCAL = { x: 0, z: 0.2, y: -0.55 };

function muzzleLocal(entity: CombatEntity, attackMode: AttackMode): { x: number; z: number; y: number } {
  if (attackMode === "grenade") {
    if (entity.flying) return BOMB_RACK_LOCAL;
    return { x: 0.5, z: 0.3, y: 1.18 };
  }
  const row = MUZZLE_LOCAL[entity.kind];
  if (row) return row;
  if (isInfantryKind(entity.kind)) return { x: 0.42, z: 0.7, y: 1.05 };
  if (isMountKind(entity.kind)) return { x: 0, z: 0.7, y: 0.7 };
  return { x: 0, z: 0, y: Math.max(0.22, entity.height * 0.55) };
}

/** The barrel tip of `entity` (as if standing at its own position) and its height: the one place every shot, preview and queued-order line starts. */
export function muzzleFor(entity: CombatEntity, attackMode: AttackMode = "weapon"): { point: Vec2; height: number } {
  return { point: muzzlePoint(entity, attackMode), height: muzzleHeight(entity, attackMode) };
}

function muzzlePoint(entity: CombatEntity, attackMode: AttackMode = "weapon"): Vec2 {
  const m = muzzleLocal(entity, attackMode);
  return m.x === 0 && m.z === 0 ? { ...entity.position } : localPoint(entity, { x: m.x, z: m.z });
}

function muzzleHeight(entity: CombatEntity, attackMode: AttackMode = "weapon"): number {
  const m = muzzleLocal(entity, attackMode);
  // Standing troops lower the gun when they crouch or go prone; everything else is a fixed barrel.
  return isInfantryKind(entity.kind) ? entity.elevation + stanceMuzzleHeight(entity, m.y) : entity.elevation + m.y;
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
    // ANY ground stops a round, flat ground included (2026-09-24). This used to test `terrain > 0.04`,
    // so only raised blocks counted: a shot fired DOWN off a mesa that missed kept descending through the
    // flat floor until its range ran out -- a tracer diving into the dirt and flying on underground
    // (movement.test.ts, the projectile oracle, caught it on four maps).
    if (lineHeight <= terrain + 0.05) return { point, height: terrain + 0.04, progress: t };
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

/** Where a bomber's CARPET lands: CARPET_BOMBS points CARPET_SPACING apart on the line from the aircraft to `center`, centred on it. */
export function carpetDropPoints(actor: CombatEntity, center: Vec2): Vec2[] {
  const len = Math.hypot(center.x - actor.position.x, center.z - actor.position.z);
  const heading = len > 0.01 ? { x: (center.x - actor.position.x) / len, z: (center.z - actor.position.z) / len } : { x: Math.sin(actor.yaw), z: Math.cos(actor.yaw) };
  return Array.from({ length: CARPET_BOMBS }, (_, i) => {
    const along = (i - (CARPET_BOMBS - 1) / 2) * CARPET_SPACING;
    return clampToArena({ x: center.x + heading.x * along, z: center.z + heading.z * along });
  });
}

function projectileKind(entity: CombatEntity, attackMode: AttackMode = "weapon"): ProjectileKind {
  if (attackMode === "grenade") return "grenade";
  return unitStats(entity.kind).projectile;
}

function moveSpeed(entity: CombatEntity): number {
  return baseMoveSpeed(entity) * MOVE_RANGE_SCALE * (entity.mods?.move ?? 1); // match the range boost so moves resolve as fast
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
  return unitStats(entity.kind).weaponRange * (entity.mods?.range ?? 1);
}

function projectileMaxAge(maxTravel: number, speed: number): number {
  return maxTravel / Math.max(0.1, speed) + 2.2;
}

/**
 * How far a unit must stand from a terrain step so its model (a trooper's weapon, a tank's hull)
 * stays out of the face -- the same clearance the move footprint uses.
 */
/** Open ground between a newly fielded unit and anything already standing there, edge to edge (owner
 *  2026-09-24: "you can't try to spawn two units right on top of each other ... basic spacing so it doesn't
 *  seem jammed"). It was 0.3m: two troopers deployed shoulder to shoulder. Deploys snap to the nearest
 *  spot that keeps this gap (deployPointPreview); base spawns ring out until they find one (freeSpawnNear). */
export const SPAWN_GAP = 0.9;

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
  return discSamples(point, margin).some((p) => terrainHeightAt(p) - here > 0.3);
}
function settleClearOfRises(start: Vec2, stop: Vec2, margin: number, hull?: number): Vec2 {
  if (!risesNear(stop, margin)) return stop;
  const length = dist(start, stop);
  const along = (fits: (p: Vec2) => boolean): Vec2 | undefined => {
    for (let back = 0.15; back < length; back += 0.15) {
      const t = (length - back) / length;
      const c = { x: start.x + (stop.x - start.x) * t, z: start.z + (stop.z - start.z) * t };
      if (fits(c)) return c;
    }
    return undefined;
  };
  const clear = along((c) => !risesNear(c, margin));
  if (clear) return clear;
  // The whole path hugs a rise (a walk along a mesa foot): settle for the HULL being clear of any
  // taller-than-a-step face, so at least nothing ends inside the rock (movement.test.ts, 2026-10-01).
  if (hull === undefined || !hullInRise(stop, hull)) return stop;
  return along((c) => !hullInRise(c, hull)) ?? stop;
}
function hullInRise(point: Vec2, hull: number): boolean {
  const here = terrainHeightAt(point);
  if (discSamples(point, hull).some((p) => terrainHeightAt(p) - here > TERRAIN_STEP * 0.9)) return true;
  for (let i = 0; i < 16; i += 1) { // 16-way ring: the 12-way disc can slip past a block corner
    const a = (i / 16) * Math.PI * 2;
    if (terrainHeightAt({ x: point.x + Math.sin(a) * hull * 1.02, z: point.z + Math.cos(a) * hull * 1.02 }) - here > TERRAIN_STEP * 0.9) return true;
  }
  return false;
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
// EXPENSIVE UNITS HIT HARDER (owner 2026-10-02): a $420 gunship's bomb is a huge blast that throws
// troops flying; the Bomber's three-bomb carpet, the tank and the siege guns also out-hit a grenade.
function explosiveBlast(kind: ProjectileKind, source?: EntityKind): { radius: number; damage: number; maxThrow?: number } {
  if (kind === "grenade") {
    if (source === "gunship") return { radius: 4.4, damage: 96, maxThrow: 9 };
    if (source === "bomber") return { radius: 3.4, damage: 78, maxThrow: 7 };
    return { radius: 2.55, damage: 34 };
  }
  if (kind === "shell") {
    if (source === "artillery") return { radius: 3.0, damage: 62, maxThrow: 6 };
    if (source === "exturret") return { radius: 2.6, damage: 50, maxThrow: 5.5 };
    return { radius: 2.25, damage: 40 };
  }
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

function isMeleeKind(kind: EntityKind): boolean {
  return kind === "striker";
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
