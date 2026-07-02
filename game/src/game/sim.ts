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
  createSoldier,
  createStriker,
  createTank,
  createTurret,
  createExTurret,
  createWall,
  factionLiving,
  isBuildingKind,
  isDefenseKind,
  isInfantryKind,
  isPartIntact,
  isVehicleKind,
  preferredPart,
  recomputeStatus,
  repairForNewTurn,
  spendCommandPoint,
  vulnerabilityMultiplier,
  type AimMode,
  type CombatEntity,
  type DamagePart,
  type DamageResult,
  type EntityKind,
  type InfantryStance,
  type Team,
} from "./damageModel";
import { createScenario } from "./scenario";
import { DEFAULT_TERRAIN, TERRAIN_STEP, clampToArena, setActiveTerrain, terrainHeightAt } from "./terrain";
import { TROOP_CATALOG, troopSpec, defenseSpec, supportPowerSpec, type TroopKind, type DefenseKind, type SupportPowerKind } from "./units";
import { TECH_TREE, techNode, aggregateTechEffect, type TechNode, type TechEffect } from "./tech";
import { modeDef, type ModeId } from "./modes";
import { MAPS, mapDef, mapCenter, flagPositions, type MapDef, type MapEventConfig, type MapEventKind } from "./maps";

export { TROOP_CATALOG, troopSpec, DEFENSE_CATALOG, defenseSpec, SUPPORT_POWERS, supportPowerSpec, type TroopKind, type TroopSpec, type DefenseKind, type DefenseSpec, type SupportPowerKind, type SupportPowerSpec } from "./units";
export { TECH_TREE, techNode, troopsUnlockedBy, type TechNode } from "./tech";
export { MODES, modeDef, type ModeId, type ModeDef } from "./modes";
export { MAPS, mapDef, flagPositions, mapCenter, type MapDef, type MapTheme } from "./maps";

export type Phase = "command" | "resolve" | "victory" | "defeat";
export type Intent = "select" | "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "interact" | "inspect" | "inspect-detail" | "build" | "support";
export type OrderKind = "move" | "shoot" | "grenade" | "ram" | "defend" | "melee";

// Hard cap on how many combat units one side can field at once.
export const POP_CAP = 8;

// Income paid each round at each upgrade level (scaled by reactor health). Tuned down from
// the early build so the opening turns aren't flooded with cash.
export const INCOME_BY_LEVEL = [85, 130, 185, 250] as const;
export const MAX_INCOME_LEVEL = INCOME_BY_LEVEL.length - 1;
// Cost to raise income from level i to level i+1.
export const INCOME_UPGRADE_COST = [200, 300, 420] as const;

// Income at level 0; retained as a named constant for clarity and tests.
export const BASE_INCOME = INCOME_BY_LEVEL[0];

// Treasury each side opens with. Lean enough that the first deployment is a real choice.
export const START_MONEY_PLAYER = 320;
export const START_MONEY_ENEMY = 280;

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
  easy: { label: "Recruit", enemyHp: 0.8, enemyDamage: 0.82, enemyIncome: 0.85 },
  normal: { label: "Veteran", enemyHp: 1, enemyDamage: 1, enemyIncome: 1 },
  hard: { label: "Elite", enemyHp: 1.3, enemyDamage: 1.28, enemyIncome: 1.45 },
};
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
}

export interface VisualEvent {
  id: string;
  // "jet" = a strike aircraft flying from->to; "beam" = an orbital lance burning the from->to line.
  type: "shot" | "impact" | "blast" | "ping" | "jet" | "beam";
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
  warningEntityId?: string;
  warningText?: string;
}

export type ProjectileKind = "rifle" | "shell" | "bolt" | "grenade";
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
  state: "flying" | "rolling";
  rollElapsed: number;
  rollDuration: number;
  rollSpeed: number;
  ignoredEntityIds: string[];
}

export interface TurnDamageEntry {
  id: string;
  actorName: string;
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
  readonly log: string[] = [];
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
  private pendingStrikes: { at: number; point: Vec2; radius: number; damage: number; kind: "barrage" | "collapse" | "airstrike" | "cluster" | "laser"; fired?: boolean }[] = [];
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
      setActiveTerrain(this.mapDef.terrain);
      this.entities = createScenario(this.mapDef, this.mode);
    }
    this.modeState = this.buildModeState();
    this.selectedId = this.entities.find((e) => e.team === "player" && isBuildingKind(e.kind))?.id ?? this.entities[0]?.id ?? "";
    this.syncAllElevations();
    this.pushLog("Turn 1 command phase");
  }

  // Restart on a (possibly new) map, mode, and difficulty, clearing all battle state.
  configure(map: MapDef, mode: ModeId, difficulty: Difficulty = this.difficulty): void {
    this.mapDef = map;
    this.mode = mode;
    this.difficulty = difficulty;
    setActiveTerrain(map.terrain);
    const fresh = createScenario(map, mode);
    this.entities.splice(0, this.entities.length, ...fresh);
    this.modeState = this.buildModeState();
    this.orders.splice(0);
    this.effects.splice(0);
    this.projectiles.splice(0);
    this.defending.clear();
    this.detonated.clear();
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
    this.economy.set("enemy", START_MONEY_ENEMY);
    this.economy.set("neutral", 0);
    this.pendingBuild = undefined;
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
  }

  private buildModeState(): ModeState {
    const def = modeDef(this.mode);
    const flags = flagPositions(this.mapDef);
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
    const start = this.projectedActorForPreview(actor).position;
    const desired = clampToArena(destination);
    const limitedByRange = limitMoveDestination(actor, start, desired);
    const limited = this.blockedMoveDestination(actor, start, limitedByRange, allowedCoverId);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    if (dist(desired, limited) > 0.05) this.pushLog(`${actor.name} move limited to ${moveRange(actor).toFixed(1)}m`);
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
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueGrenadeFor(actor, target, this.aim);
  }

  queueGrenadePart(targetId: string, partId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot target friendly units");
    return this.queueGrenadeFor(actor, target, aimForPart(target.parts.find((part) => part.id === partId)), partId);
  }

  queueGrenadeAt(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    const point = clampToArena(destination);
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

  // Fire a unit's explosive round (tank/artillery shell, mortar/grenadier round, turret) at a
  // ground spot rather than a specific enemy part.
  queueShootAt(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!canGroundShellAttack(actor)) return this.reject(`${actor.name} cannot fire at the ground`);
    if (!actor.status.canShoot) return this.reject(`${actor.name} cannot shoot`);
    const point = clampToArena(destination);
    const projected = this.projectedActorForPreview(actor);
    if (dist(muzzlePoint(projected, "weapon"), point) > projectileRange(actor, "weapon")) return this.reject("Ground target is out of range");
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({ actorId: actor.id, kind: "shoot", destination: point, aim: "center", duration: 1.35 });
    return true;
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
    const to = clampToArena(point);
    const projected = this.projectedActorForPreview(actor);
    projected.yaw = Math.atan2(to.x - projected.position.x, to.z - projected.position.z);
    const attackMode: AttackMode = grenade ? "grenade" : "weapon";
    const from = muzzlePoint(projected, attackMode);
    const fromHeight = muzzleHeight(projected, attackMode);
    const kind = grenade ? "grenade" : projectileKind(actor, "weapon");
    const horizontal = dist(from, to);
    const reachable = horizontal <= (grenade ? grenadeThrowRange(actor) : projectileRange(actor, "weapon"));
    const toHeight = terrainHeightAt(to) + 0.14;
    const arcHeight = grenade ? projectileArcHeight("grenade", horizontal) : Math.max(projectileArcHeight(kind, horizontal), 0.6);
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
    const amount = Math.round(base * (target.kind === "cover" ? 1 : vulnerabilityMultiplier(target, targetPart)) * this.teamDamageScale(actor));
    return { amount, part: targetPart };
  }

  projectedSelected(): { position: Vec2; elevation: number; stance: InfantryStance } | undefined {
    const actor = this.selected;
    if (!actor) return undefined;
    const projected = this.projectedActorForPreview(actor);
    return { position: { ...projected.position }, elevation: projected.elevation, stance: projected.stance };
  }

  selectedActionRange(): { kind: "ram" | "melee" | "grenade" | "move"; radius: number; position: Vec2; elevation: number } | undefined {
    const actor = this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command") return undefined;
    const projected = this.projectedActorForPreview(actor);
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
    if (this.intent === "melee" && actor.kind === "striker" && actor.status.canMove) {
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
    if (spec.tech && !isTechUnlocked(base, spec.tech)) {
      const node = techNode(spec.tech);
      return `${spec.label} needs ${node?.name ?? "research"} first`;
    }
    const cooldown = this.troopCooldown(base, kind);
    if (cooldown > 0) return `${spec.label} on cooldown (${cooldown} rd)`;
    if (this.fieldUnitCount(base.team) >= POP_CAP) return `Field is full (${POP_CAP} units)`;
    if (this.money(base.team) < spec.cost) return `Not enough money for ${spec.label} ($${spec.cost})`;
    if (base.commandPoints <= 0) return `${base.name} has no command points`;
    return undefined;
  }

  queueSpawnTroop(kind: TroopKind): boolean {
    const base = this.requirePlayerActor();
    if (!base) return false;
    return this.spawnTroopFor(base, kind);
  }

  private spawnTroopFor(base: CombatEntity, kind: TroopKind): boolean {
    const failure = this.spawnFailureReason(base, kind);
    if (failure) return this.reject(failure);
    const spec = troopSpec(kind);
    spendCommandPoint(base);
    this.addMoney(base.team, -spec.cost);
    const unit = this.createTroop(kind, base);
    this.entities.push(unit);
    this.syncEntityElevation(unit);
    // The deployed troop holds position until the next turn.
    unit.commandPoints = 0;
    base.spawnCooldowns = { ...(base.spawnCooldowns ?? {}), [kind]: spec.cooldown };
    this.pushLog(`${base.name} deploys ${unit.name}`);
    return true;
  }

  private createTroop(kind: TroopKind, base: CombatEntity): CombatEntity {
    const spec = troopSpec(kind);
    const prefix = base.team === "player" ? "p" : "e";
    const id = `${prefix}-spawn-${++this.troopSeq}`;
    const name = `${spec.label} ${this.troopSeq}`;
    const unit = makeTroop(kind, id, name, base.team, this.freeSpawnNear(base));
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
    this.pushLog(`${base.name} boosts income to tier ${base.incomeLevel} ($${baseIncomeRate(base)}/rd)`);
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
  }

  // ---- Off-map support powers (airstrike / cluster / orbital lance) ----

  setPendingSupport(kind: SupportPowerKind | undefined): void {
    this.pendingSupport = kind;
    this.intent = kind ? "support" : "select";
    if (kind) this.pendingBuild = undefined;
  }

  supportCooldown(base: CombatEntity, kind: SupportPowerKind): number {
    return base.supportCooldowns?.[kind] ?? 0;
  }

  // Why a support power can't be called right now, or undefined if it can.
  supportFailureReason(base: CombatEntity | undefined, kind: SupportPowerKind): string | undefined {
    if (!base || base.kind !== "base") return "Select your Home Base to call support";
    if (!base.status.alive) return `${base.name} is disabled`;
    const spec = supportPowerSpec(kind);
    if (spec.tech && !isTechUnlocked(base, spec.tech)) {
      const tech = techNode(spec.tech);
      return `Research ${tech?.name ?? "the required doctrine"} to unlock ${spec.label}`;
    }
    if (base.commandPoints <= 0) return `${base.name} has no command points`;
    const cooldown = this.supportCooldown(base, kind);
    if (cooldown > 0) return `${spec.label} is on cooldown (${cooldown} rd)`;
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
  private freeSpawnNear(base: CombatEntity): Vec2 {
    const ring = base.radius + 1.6;
    const forward = base.team === "player" ? 1 : -1;
    for (let radius = ring; radius <= ring + 3; radius += 0.8) {
      for (let i = 0; i < 8; i += 1) {
        const angle = (Math.PI * 2 * i) / 8 + (forward > 0 ? 0 : Math.PI);
        const point = clampToArena({
          x: base.position.x + Math.sin(angle) * radius,
          z: base.position.z + Math.cos(angle) * radius,
        });
        const blocked = this.entities.some((e) => e.id !== base.id && e.status.alive && dist(e.position, point) < e.radius + 0.8);
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
    const arcHeight = projectileArcHeight(kind, dist(from, aimPoint));
    const ground = firstGroundBetweenShot(from, aimPoint, fromHeight, aimHeight, arcHeight);
    const warning = ground ? undefined : this.firstEntityBetweenShot(from, aimPoint, fromHeight, aimHeight, actor.id, intendedTarget.id, arcHeight);
    const cover = ground || warning ? undefined : this.firstCoverBetweenShot(from, aimPoint, fromHeight, aimHeight, intendedTarget.id, arcHeight);
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
      amount: ground ? 0 : this.estimateShotDamage(actor, impactTarget, impactPart, aim, Boolean(cover), attackMode) * (attackMode === "weapon" ? burstCount(actor) : 1),
      accuracy: accuracy.rating,
      accuracyLabel: accuracy.label,
      hitChance: accuracy.hitChance,
      spreadDegrees: accuracy.spreadDegrees,
      accuracyNotes: accuracy.notes,
      projectileKind: kind,
      arcHeight,
      blockedById: cover?.id,
      blockedByGround: Boolean(ground),
      warningEntityId: friendlyWarning?.id,
      warningText: friendlyWarning ? `Friendly fire risk: ${friendlyWarning.name} is in the path` : undefined,
    };
  }

  endTurn(): void {
    if (this.phase !== "command") return;
    this.queueEnemyOrders();
    this.scheduleMapStrikes();
    this.scheduleSupportStrikes();
    this.phase = "resolve";
    this.resolveClock = 0;
    this.activeTurnReport = { turn: this.turn, phase: "active", entries: [], notes: [] };
    this.pushLog(`Turn ${this.turn} resolving`);
    this.bus.emit("RESOLVE_START", { turn: this.turn });
  }

  reset(): void {
    this.configure(this.mapDef, this.mode, this.difficulty);
  }

  // ---------------------------------------------------------------------------
  // Debug / scenario harness
  // ----------------------------------------------------------------------------
  // Deterministic state-setup primitives so automated tests and capture scripts can cut
  // straight to a specific situation (and screenshot it) instead of driving the whole UI.
  // These bypass the economy/CP rules on purpose — they are dev tooling, not gameplay.

  // Drop a combat unit straight onto the field, ready to act (no cost, no cooldown).
  debugSpawn(kind: TroopKind, team: Team, position: Vec2): CombatEntity {
    const id = `${team === "player" ? "p" : "e"}-dbg-${++this.troopSeq}`;
    const unit = makeTroop(kind, id, `${troopSpec(kind).label} ${this.troopSeq}`, team, clampToArena(position));
    if (team === "enemy") scaleEntityHp(unit, DIFFICULTY_MODS[this.difficulty].enemyHp);
    unit.commandPoints = unit.maxCommandPoints;
    this.entities.push(unit);
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
    return structure;
  }

  // Apply raw damage to a part (e.g. to stage a destroyed-part or near-dead state).
  debugDamage(entityId: string, partId: string, amount: number): void {
    const entity = this.entity(entityId);
    if (entity) applyDamage(entity, partId, amount);
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
    return JSON.stringify({
      map: this.mapDef.id,
      mode: this.mode,
      difficulty: this.difficulty,
      turn: this.turn,
      economy: [...this.economy],
      entities: this.entities,
      modeState: this.modeState,
      troopSeq: this.troopSeq,
      detonated: [...this.detonated],
    });
  }

  // Load a saved battle. Returns false on malformed data. Always resumes in the command phase.
  restore(raw: string): boolean {
    try {
      const data = JSON.parse(raw) as {
        map: string; mode: ModeId; difficulty?: Difficulty; turn?: number;
        economy: [Team, number][]; entities: CombatEntity[]; modeState: ModeState; troopSeq?: number;
        detonated?: string[];
      };
      const map = mapDef(data.map);
      setActiveTerrain(map.terrain);
      this.mapDef = map;
      this.mode = data.mode;
      this.difficulty = data.difficulty ?? "normal";
      this.entities.splice(0, this.entities.length, ...data.entities);
      this.economy.clear();
      for (const [team, amount] of data.economy) this.economy.set(team, amount);
      this.modeState = data.modeState;
      this.turn = data.turn ?? 1;
      this.troopSeq = data.troopSeq ?? 0;
      this.orders.splice(0);
      this.projectiles.splice(0);
      this.effects.splice(0);
      this.defending.clear();
      // Restore which volatile covers already blew up, so a destroyed-but-still-present cover
      // caught in a later blast doesn't detonate a second time after a save/load.
      this.detonated.clear();
      for (const id of data.detonated ?? []) this.detonated.add(id);
      this.log.splice(0);
      this.turnReports.splice(0);
      this.activeTurnReport = undefined;
      this.phase = "command";
      this.intent = "select";
      this.aim = "center";
      this.pendingBuild = undefined;
      this.pendingSupport = undefined;
      this.queuedSupport = [];
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

    const allDone = this.orders.every((o) => o.done);
    if (allDone && this.projectiles.length === 0 && this.pendingStrikes.length === 0 && this.pendingFx.length === 0 && this.resolveClock > 1.9) this.finishResolve();
    if (this.projectiles.length === 0 && this.pendingStrikes.length === 0 && this.resolveClock > 18) this.finishResolve();
  }

  private queueShootFor(actor: CombatEntity, target: CombatEntity, aim: AimMode, partId?: string): boolean {
    if (!actor.status.canShoot) return this.reject(`${actor.name} cannot shoot`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    const requestedPart = partId ? this.targetableParts(target).find((part) => part.id === partId) : undefined;
    if (partId && !requestedPart) return this.reject(`${target.name} does not have that targetable part`);
    const targetPart = requestedPart ?? preferredPart(target, aim);
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
      actor.position = moveToward(actor.position, order.destination, moveSpeed(actor) * crouchMoveSlow * dt);
      this.separateFromUnits(actor);
      this.syncEntityElevation(actor);
      actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
      if (dist(actor.position, order.destination) < 0.08 || order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "shoot" || order.kind === "grenade") {
      // Ground-targeted explosives (hand grenade, tank/artillery/turret shell) carry a
      // destination but no specific entity; they fly to the marked spot and detonate.
      if (order.destination && !order.targetId) {
        if (order.fired) {
          order.done = !this.projectiles.some((projectile) => projectile.orderId === order.id);
          return;
        }
        if (!actor.status.alive || (order.kind === "shoot" && !actor.status.canShoot)) {
          order.done = true;
          return;
        }
        actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
        if (order.elapsed >= 0.58) {
          order.fired = true;
          order.projectileId = order.kind === "grenade"
            ? this.launchGrenadeAtPoint(order, actor, order.destination)
            : this.launchExplosiveAtPoint(order, actor, order.destination);
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

    const target = this.entity(order.targetId);
    if (!target || !target.status.alive || !actor.status.canMove) {
      order.done = true;
      return;
    }

    if (order.kind === "melee") {
      actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
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
    if (!order.fired && dist(actor.position, target.position) <= actor.radius + target.radius + 0.25) {
      order.fired = true;
      this.resolveRam(actor, target);
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
    if (!actor || !target || actor.id === target.id) return "Select a striker and target first";
    if (target.team === "player") return "Cannot strike friendly units";
    if (actor.kind !== "striker") return "Only melee units can strike";
    if (!actor.status.canMove) return `${actor.name} cannot strike without mobility`;
    if (!hasIntactMeleeWeapon(actor)) return `${actor.name} has no melee weapon`;
    const projected = this.projectedActorForPreview(actor);
    const reach = meleeRange(actor) + actor.radius + target.radius;
    if (dist(projected.position, target.position) > reach) return `${target.name} is too far to strike`;
    return undefined;
  }

  private grenadeFailureReason(actor: CombatEntity | undefined, target: CombatEntity | undefined): string | undefined {
    if (!actor || !target || actor.id === target.id) return "Select a soldier and target first";
    if (actor.team === target.team) return "Cannot throw grenades at friendly units";
    if (actor.kind !== "soldier") return "Only soldiers carry hand grenades";
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
    if (!actor) return "Select a soldier first";
    if (actor.kind !== "soldier") return "Only soldiers carry hand grenades";
    if (!actor.status.alive) return `${actor.name} is disabled`;
    if (actor.grenades <= 0) return `${actor.name} is out of grenades`;
    if (actor.commandPoints <= 0) return `${actor.name} has no command points`;
    const projected = this.projectedActorForPreview(actor);
    const origin = muzzlePoint(projected, "grenade");
    if (dist(origin, point) > grenadeThrowRange(actor)) return "Ground target is outside grenade range";
    return undefined;
  }

  private blockedMoveDestination(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId?: string, silent = false): Vec2 {
    const pathLength = dist(start, destination);
    if (pathLength < 0.05) return destination;
    const terrainBlock = this.blockedBySteepTerrain(actor, start, destination, allowedCoverId, pathLength, silent);
    if (terrainBlock) return terrainBlock;
    // Solid objects that block ground movement: cover (except walkable ridges) and any
    // Home Base. Ridges are high ground you can stand on; the cover being taken is exempt.
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
    if (!blocker) return destination;
    const stopBack = (blocker.entity.radius + actor.radius + 0.28) / pathLength;
    const t = clamp(blocker.progress - stopBack, 0, 1);
    const stopped = {
      x: start.x + (destination.x - start.x) * t,
      z: start.z + (destination.z - start.z) * t,
    };
    if (!silent) this.pushLog(`${actor.name}'s move is blocked by ${blocker.entity.name}`);
    return clampToArena(stopped);
  }

  private blockedBySteepTerrain(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId: string | undefined, pathLength: number, silent = false): Vec2 | undefined {
    const allowedCover = this.entity(allowedCoverId);
    if (allowedCover && isCliffCover(allowedCover) && isInfantryKind(actor.kind)) return undefined;
    const samples = Math.max(12, Math.ceil(pathLength * 4));
    // A unit can step up onto a ledge no taller than TERRAIN_STEP, and can always drop down.
    // The first place the terrain rises by more than one step is a wall/cliff face: stop there.
    let footing = terrainHeightAt(start);

    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      const point = {
        x: start.x + (destination.x - start.x) * t,
        z: start.z + (destination.z - start.z) * t,
      };
      const height = terrainHeightAt(point);

      if (height - footing > TERRAIN_STEP) {
        const back = Math.min(0.34 / pathLength, t);
        const stopT = clamp(t - back, 0, 1);
        const stopped = clampToArena({
          x: start.x + (destination.x - start.x) * stopT,
          z: start.z + (destination.z - start.z) * stopT,
        });
        if (!silent) this.pushLog(`${actor.name} must use a cliff ascent`);
        return stopped;
      }

      footing = height;
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
    const errorSpread = accuracy.spreadRadians * spreadBoost;
    const baseYaw = Math.atan2(intendedPoint.x - origin.x, intendedPoint.z - origin.z);
    const horizontalDistance = Math.max(0.001, dist(origin, intendedPoint));
    const basePitch = Math.atan2(intendedHeight - originHeight, horizontalDistance);
    const yawError = errorSpread > 0 ? this.rng.range(-errorSpread, errorSpread) : 0;
    const pitchSpread = errorSpread * 0.62;
    const pitchError = pitchSpread > 0 ? this.rng.range(-pitchSpread, pitchSpread) : 0;
    const yaw = baseYaw + yawError;
    const pitch = clamp(basePitch + pitchError, -0.42, 0.42);
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
      arcHeight: projectileArcHeight(kind, horizontalDistance),
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
  private launchExplosiveAtPoint(order: TacticalOrder, actor: CombatEntity, point: Vec2): string {
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
    const arcHeight = Math.max(projectileArcHeight(kind, horizontalDistance), 0.6);
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
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    this.projectiles.push(projectile);
    this.pushLog(`${actor.name} fires at the marked spot`);
    return projectile.id;
  }

  private launchGrenadeAtPoint(order: TacticalOrder, actor: CombatEntity, point: Vec2): string {
    this.syncEntityElevation(actor);
    const origin = muzzlePoint(actor, "grenade");
    const originHeight = muzzleHeight(actor, "grenade");
    const intendedPoint = { ...point };
    const intendedHeight = terrainHeightAt(point) + 0.14;
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
      arcHeight: projectileArcHeight("grenade", horizontalDistance),
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
    this.pushLog(`${actor.name} throws a grenade at the ground`);
    return projectile.id;
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
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      if (intendedTarget) this.pushLog(`${actor.name} misses ${intendedTarget.name}`);
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
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private impactProjectile(projectile: Projectile, target: CombatEntity, targetPart: DamagePart, cover: boolean): void {
    const actor = this.entity(projectile.actorId);
    const intendedTarget = this.entity(projectile.targetId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
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

    const amount = this.estimateShotDamage(actor, target, targetPart, cover ? "center" : projectile.aim, cover, projectile.attackMode ?? "weapon");
    const result = applyDamage(target, targetPart.id, amount);
    if (cover && intendedTarget) this.pushLog(`${target.name} intercepts shot at ${intendedTarget.name}`);
    if (!cover && intendedTarget && target.id !== intendedTarget.id) this.pushLog(`${target.name} is hit by a stray shot at ${intendedTarget.name}`);
    if (projectile.kind === "shell" || projectile.kind === "grenade") {
      this.effect("impact", target.position, target.position, 0xffffff, 0.42, target.radius + 0.45);
      this.effect("blast", projectile.position, projectile.position, result.destroyed ? 0xffd166 : 0xffbf69, 0.7, target.radius + 1.05);
      this.resolveShellSplash(actor, target, targetPart, amount, projectile.position);
    } else {
      this.effect("impact", target.position, target.position, result.destroyed ? 0xffd166 : 0xffffff, 0.42, target.radius);
    }
    this.afterDamage(actor, target, result);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private removeProjectile(id: string): void {
    const index = this.projectiles.findIndex((projectile) => projectile.id === id);
    if (index >= 0) this.projectiles.splice(index, 1);
  }

  private estimateShotDamage(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, aim: AimMode, cover: boolean, attackMode: AttackMode = "weapon"): number {
    const base = baseShotDamage(actor.kind, attackMode);
    const range = dist(actor.position, target.position);
    const falloff = clamp(1.08 - range / 26, 0.65, 1);
    const vulnerability = cover ? 1 : vulnerabilityMultiplier(target, targetPart);
    const explosiveActor = actor.kind === "tank" || actor.kind === "artillery" || actor.kind === "grenadier" || actor.kind === "mortar" || actor.kind === "exturret";
    const shellObjectBoost = ((attackMode === "weapon" && explosiveActor) || attackMode === "grenade") && target.kind === "cover" ? 1.72 : 1;
    const aimMultiplier = attackMode === "grenade" ? 1 : aimDamageMultiplier(aim);
    return Math.round(base * falloff * (cover ? 1.05 : aimMultiplier) * vulnerability * shellObjectBoost * this.supportDamageMultiplier(actor) * this.teamDamageScale(actor) * this.techDamageScale(actor, target));
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
    return aggregateTechEffect(base?.unlockedTech ?? []);
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

  private applyExplosiveRadius(actor: CombatEntity, point: Vec2, radius: number, baseDamage: number, message: string): void {
    for (const entity of this.entities) {
      if (entity.id === actor.id || !entity.status.alive) continue;
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
    }
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
    this.effect("blast", target.position, target.position, result.killed ? 0xfff1a6 : 0x9dfcff, 0.52, target.radius + 1.1);
    this.pushLog(`${actor.name} strikes ${target.name}'s ${targetPart.label}`);
    this.afterDamage(actor, target, result);
  }

  private afterDamage(actor: CombatEntity, target: CombatEntity, resultOrMessages: DamageResult | string[], source?: string): void {
    const messages = Array.isArray(resultOrMessages) ? resultOrMessages : resultOrMessages.messages;
    if (!Array.isArray(resultOrMessages)) this.recordDamage(actor, target, resultOrMessages, source);
    for (const message of messages) this.pushLog(message);
    if (messages.some((message) => message.includes("killed by"))) {
      this.effect("blast", target.position, target.position, 0xffd166, 0.78, target.radius + 2.1);
    } else if (messages.some((message) => message.includes("destroyed"))) {
      this.effect("impact", target.position, target.position, 0xffbf69, 0.5, target.radius + 0.75);
    }
    this.applyPartImplications(actor, target, messages);
    const volatileDestroyed = target.parts.some((p) => p.role === "volatile" && p.hp === 0);
    if (volatileDestroyed) this.resolveExplosion(actor, target);
    this.checkEndState();
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
      this.pushLog(`${target.team === "enemy" ? "Enemy" : "Player"} command network degraded`);
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
      if (entity.id === projectile.actorId || projectile.ignoredEntityIds.includes(entity.id) || !entity.status.alive) continue;
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
        const radius = entity.kind === "cover"
          ? entity.radius + (projectile.kind === "shell" || projectile.kind === "grenade" ? 0.22 : 0.12)
          : projectilePartRadius(entity, part, projectile);
        if (distanceToLine > radius) continue;
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
      .filter((entity) => entity.id !== projectile.actorId && !projectile.ignoredEntityIds.includes(entity.id) && entity.status.alive)
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

    const assist = this.accuracyAssistMultiplier(actor);
    if (assist < 1) {
      spreadDegrees *= assist;
      notes.push("spotter relay");
    }

    const rangePenalty = rangeSpreadPenalty(actor.kind, attackMode, dist(actor.position, target.position));
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
  private separateFromUnits(actor: CombatEntity): void {
    for (const other of this.entities) {
      if (other.id === actor.id || !other.status.alive || other.kind === "cover") continue;
      const minDist = actor.radius + other.radius;
      const dx = actor.position.x - other.position.x;
      const dz = actor.position.z - other.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.0001 && d < minDist) {
        const push = minDist - d;
        actor.position.x += (dx / d) * push;
        actor.position.z += (dz / d) * push;
      } else if (d <= 0.0001) {
        actor.position.x += 0.06;
      }
    }
    actor.position = clampToArena(actor.position);
  }

  private syncAllElevations(): void {
    for (const entity of this.entities) this.syncEntityElevation(entity);
  }

  private syncEntityElevation(entity: CombatEntity): void {
    entity.elevation = this.elevationForEntityAt(entity, entity.position);
  }

  private elevationForEntityAt(entity: CombatEntity, position: Vec2): number {
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

  private resolveExplosion(actor: CombatEntity, source: CombatEntity): void {
    if (this.detonated.has(source.id)) return;
    this.detonated.add(source.id);
    this.effect("blast", source.position, source.position, 0xff7a35, 0.75, 3.4);
    for (const entity of this.entities) {
      if (entity.id === source.id || !entity.status.alive) continue;
      const d = dist(entity.position, source.position);
      if (d > 3.5) continue;
      const part = preferredPart(entity, "weakest");
      const result = applyDamage(entity, part.id, Math.round(42 * (1 - d / 4)));
      this.afterDamage(actor, entity, result, `${source.name} explosion`);
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
      .filter((entity) => entity.kind !== "cover" && entity.status.alive && entity.id !== actorId && entity.id !== targetId)
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
  private aiProfile(): { focusFire: boolean; useCover: boolean; retreat: boolean; smartEconomy: boolean } {
    if (this.difficulty === "easy") return { focusFire: false, useCover: false, retreat: false, smartEconomy: false };
    return { focusFire: true, useCover: true, retreat: true, smartEconomy: true };
  }

  private queueEnemyOrders(): void {
    const profile = this.aiProfile();
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
    const players = this.living("player").filter((entity) => !isBuildingKind(entity.kind));
    const allPlayers = this.living("player");
    if (!allPlayers.length) return;
    const objective = this.enemyObjective();
    const home = this.enemyHomePosition();
    // Running tally of damage already committed to each player unit this turn. Focus-fire reads
    // it so shooters pile onto one target until it's predicted dead, then spill to the next.
    const committed = new Map<string, number>();
    for (const enemy of this.living("enemy")) {
      if (isBuildingKind(enemy.kind)) continue;
      const target = nearest(enemy, players.length ? players : allPlayers);
      const range = projectileRange(enemy);
      const separation = target ? dist(enemy.position, target.position) : Infinity;
      if (target && enemy.kind === "soldier" && enemy.grenades > 0 && enemy.commandPoints > 0 && this.rng.chance(0.35) && !this.grenadeFailureReason(enemy, target)) {
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
        if (this.queueShootFor(enemy, shootTarget, aim)) {
          fired = true;
          const burst = enemy.kind === "heavy" ? 3 : 1;
          committed.set(shootTarget.id, (committed.get(shootTarget.id) ?? 0) + baseShotDamage(enemy.kind) * burst);
        }
      }
      // Otherwise advance: carriers run the flag home, crippled units fall back to base, others
      // push the objective or the nearest threat, routing around (and hugging) solid objects.
      if (enemy.status.canMove && enemy.commandPoints > 0) {
        const carrying = this.modeState.flags.some((f) => f.carrierId === enemy.id);
        const homeGoal = this.modeState.flags.find((f) => f.team === "enemy")?.home;
        const isMelee = enemy.kind === "striker";
        // A unit that has lost its weapon or is badly wounded retreats toward base instead of
        // feeding itself into fire — but only if it has somewhere to fall back to.
        const crippled = profile.retreat && !carrying && Boolean(home) && (!enemy.status.canShoot || coreHpFraction(enemy) < 0.3);
        // Shooters hold at weapon range; melee always close; carriers run the flag home;
        // in objective modes, idle units push the hill/flag rather than over-extending.
        const wantsTarget = Boolean(target) && (isMelee || separation > Math.min(range * 0.8, 6));
        let goal: Vec2 | undefined;
        let advancing = false;
        if (carrying && homeGoal) {
          goal = homeGoal;
        } else if (crippled) {
          goal = home;
        } else if (wantsTarget) {
          goal = target!.position;
          advancing = true;
        } else if (!fired && objective && dist(enemy.position, objective) > 2.2) {
          // No shot landed this turn and no target pulled us: push the mode objective.
          // This ALSO applies in destroy mode (objective = the player base) — without it,
          // a unit whose line of fire was blocked or that idled just inside its range
          // band had no goal at all and the whole army could stall at its own base.
          // Units that DID fire still hold at weapon range as designed.
          goal = objective;
          advancing = true;
        }
        if (goal) {
          const step = isVehicleKind(enemy.kind) ? Math.max(3.2, moveRange(enemy)) : moveRange(enemy);
          // When pushing toward a threat, prefer a tile that ends sheltered behind cover.
          const destination = profile.useCover && advancing && target
            ? this.coverBiasedDestination(enemy, goal, target.position, step)
            : this.navigateToward(enemy, goal, step);
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

  // The position the enemy army falls back to when crippled (its living Home Base), if any.
  private enemyHomePosition(): Vec2 | undefined {
    return this.entities.find((e) => e.team === "enemy" && e.kind === "base" && e.status.alive)?.position;
  }

  // Focus-fire target picker: among the shooter's in-range options, concentrate fire on a
  // single unit until it is predicted dead (overkilled targets sink to the bottom), preferring
  // high-value units (support/siege) and finishing wounded ones first.
  private pickShootTarget(shooter: CombatEntity, candidates: CombatEntity[], committed: Map<string, number>, range: number): CombatEntity | undefined {
    const ranked = candidates
      .filter((t) => t.status.alive && dist(shooter.position, t.position) <= range + 0.01)
      .map((t) => {
        const com = committed.get(t.id) ?? 0;
        const hp = remainingHp(t);
        return {
          t,
          saturated: com >= hp ? 1 : 0, // already getting enough fire to die — deprioritize
          engaged: com > 0 ? 0 : 1, // pile onto a unit we've already started on
          value: AI_TARGET_VALUE[t.kind] ?? 4,
          hp,
        };
      })
      .sort((a, b) => a.saturated - b.saturated || a.engaged - b.engaged || b.value - a.value || a.hp - b.hp);
    return ranked[0]?.t;
  }

  // Advance toward a goal but prefer a reachable tile that ends behind sturdy cover relative to
  // the threat, so the bot doesn't cross open ground when a flanking-but-covered step exists.
  private coverBiasedDestination(actor: CombatEntity, goal: Vec2, threat: Vec2, step: number): Vec2 {
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
      const score = progress + sheltered;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
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
    if (researchPick && money >= researchPick.cost + 200 && this.rng.chance(0.45) && this.researchTechFor(base, researchPick.id)) return;
    const incomeCost = incomeUpgradeCost(base);
    if (incomeCost !== undefined && money >= incomeCost + 340 && this.rng.chance(0.3) && this.upgradeIncomeFor(base)) return;
    if (this.fieldUnitCount(base.team) >= POP_CAP) return;
    const affordable = TROOP_CATALOG.filter((spec) => !this.spawnFailureReason(base, spec.kind));
    if (!affordable.length) return;
    // Build the most-wanted affordable troop; fall back to the strongest the bot can field.
    const pick =
      (desired?.find((kind) => affordable.some((spec) => spec.kind === kind))) ??
      [...affordable].sort((a, b) => b.cost - a.cost)[0].kind;
    this.spawnTroopFor(base, pick);
  }

  // Ordered troop wishlist for the enemy commander, reacting to the player's current army.
  // enemyBaseAct deploys the first entry it can afford and has teched, so earlier = higher want.
  private enemyTroopPreference(): TroopKind[] {
    const players = this.fieldUnits("player");
    const playerVehicles = players.filter((p) => isVehicleKind(p.kind)).length;
    const playerInfantry = players.filter((p) => isInfantryKind(p.kind)).length;
    const mine = this.fieldUnits("enemy");
    const haveAntiArmor = mine.some((u) => u.kind === "tank" || u.kind === "artillery" || u.kind === "heavy" || u.kind === "grenadier" || u.kind === "mortar");
    const pref: TroopKind[] = [];
    if (playerVehicles > 0 && !haveAntiArmor) pref.push("tank", "heavy", "grenadier", "artillery");
    if (playerInfantry >= 3) pref.push("grenadier", "mortar", "heavy");
    // Round out into a balanced force when there's nothing specific to counter.
    pref.push("heavy", "striker", "soldier", "scout", "apc", "tank", "sniper");
    return [...new Set(pref)];
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
    this.refreshDefendingStances();
    this.finalizeTurnReport();
    // An elimination win/loss this turn takes precedence — don't also tick objectives.
    if (this.gameOver) return;
    this.resolveModeObjectives(); // may set victory/defeat by score
    if (this.gameOver) return;
    this.turn += 1;
    this.phase = "command";
    this.resolveClock = 0;
    for (const entity of this.entities) repairForNewTurn(entity);
    this.runEconomyTick();
    this.resolveSupportAuras();
    // Forced events are single-turn debug overrides; clear them, then announce the new turn's events.
    this.forcedZones = [];
    this.forcedSandstorm = false;
    this.forcedIonStorm = false;
    this.refreshEventNotice();
    this.applyIonStormClamp(); // scramble command points if an ion storm is raking the field
    this.pushLog(`Turn ${this.turn} command phase`);
    this.bus.emit("TURN_START", { turn: this.turn });
  }

  // Objective scoring for the active mode, evaluated on final end-of-turn positions.
  private resolveModeObjectives(): void {
    if (this.mode === "ctf") this.resolveCtf();
    else if (this.mode === "hill") this.resolveHill();
  }

  // ---- Dynamic map events ---------------------------------------------------------------
  // All of this derives purely from the map config + current turn (plus single-turn debug
  // overrides), so it survives save/load for free and stays deterministic.

  private mapEvents(): readonly MapEventConfig[] {
    return this.mapDef.events ?? [];
  }

  // Whether reduced-accuracy sandstorm weather is in effect on a given turn.
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
      .filter((e) => (e.kind === "barrage" || e.kind === "collapse") && eventOccursWindow(e, turn))
      .map((e) => ({ kind: e.kind, ...this.eventZone(e) }));
    return [...fromMap, ...this.forcedZones];
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
  private detonateStrike(strike: { point: Vec2; radius: number; damage: number; kind: "barrage" | "collapse" | "airstrike" | "cluster" | "laser" }): void {
    const color = strike.kind === "barrage" ? 0xffac5a
      : strike.kind === "collapse" ? 0xb59a72
      : strike.kind === "laser" ? 0xff5a4d
      : strike.kind === "cluster" ? 0xffb02e
      : 0xff8c3a;
    this.effect("blast", strike.point, strike.point, color, 0.85, strike.radius);
    for (const e of this.entities) {
      if (!e.status.alive || e.kind === "base") continue;
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
      this.pushLog(`You hold the hill (${s.playerScore}/${s.target})`);
    } else if (enemyHeld > 0 && playerHeld === 0) {
      s.enemyScore += 1;
      s.hillHolder = "enemy";
      this.pushLog(`Enemy holds the hill (${s.enemyScore}/${s.target})`);
    } else {
      s.hillHolder = playerHeld > 0 && enemyHeld > 0 ? undefined : s.hillHolder;
      if (playerHeld === 0 && enemyHeld === 0) s.hillHolder = undefined;
    }
    if (s.playerScore >= s.target) {
      this.phase = "victory";
      this.pushLog("Hill secured — victory!");
    } else if (s.enemyScore >= s.target) {
      this.phase = "defeat";
      this.pushLog("Enemy held the hill — defeat.");
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
        this.pushLog(`${flag.team === "player" ? "Your" : "Enemy"} flag is returned home`);
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
        this.pushLog(`${grabber.name} steals the ${flag.team === "player" ? "allied" : "enemy"} flag!`);
      }
    }
    const playerFlag = s.flags.find((f) => f.team === "player")!;
    const enemyFlag = s.flags.find((f) => f.team === "enemy")!;
    this.tryCapture(enemyFlag, playerFlag, "player");
    this.tryCapture(playerFlag, enemyFlag, "enemy");
    if (s.playerScore >= s.target) {
      this.phase = "victory";
      this.pushLog("Flag captured — victory!");
    } else if (s.enemyScore >= s.target) {
      this.phase = "defeat";
      this.pushLog("Enemy captured your flag — defeat.");
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
      this.pushLog(`${scorer === "player" ? "You capture" : "Enemy captures"} the flag (${score}/${this.modeState.target})`);
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
    if (!factionLiving(this.entities, "enemy").length) {
      this.phase = "victory";
      this.pushLog("Enemy force disabled");
    } else if (!factionLiving(this.entities, "player").length) {
      this.phase = "defeat";
      this.pushLog("Player force disabled");
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
    this.log.unshift(text);
    if (this.activeTurnReport && this.phase === "resolve") {
      this.activeTurnReport.notes.unshift(text);
      if (this.activeTurnReport.notes.length > 28) this.activeTurnReport.notes.pop();
    }
    if (this.log.length > 24) this.log.pop();
    this.bus.emit("LOG", { text });
  }

  private recordDamage(actor: CombatEntity, target: CombatEntity, result: DamageResult, source?: string): void {
    if (!this.activeTurnReport || result.amount <= 0) return;
    const part = target.parts.find((candidate) => candidate.id === result.partId);
    const partLabel = part?.label ?? result.partId;
    this.activeTurnReport.entries.push({
      id: `damage-${++this.damageSeq}`,
      actorName: actor.name,
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
    case "scout": return createScout(id, name, team, position);
    case "sniper": return createSniper(id, name, team, position);
    case "striker": return createStriker(id, name, team, position);
    case "heavy": return createHeavy(id, name, team, position);
    case "grenadier": return createGrenadier(id, name, team, position);
    case "mortar": return createMortar(id, name, team, position);
    case "medic": return createMedic(id, name, team, position);
    case "engineer": return createEngineer(id, name, team, position);
    default: return createSoldier(id, name, team, position);
  }
}

function moveRange(entity: CombatEntity): number {
  if (entity.kind === "apc") return 7.2;
  if (entity.kind === "tank") return 5.4;
  if (entity.kind === "artillery") return 3.6;
  if (entity.kind === "scout") return 11.5;
  if (entity.kind === "striker") return 10.8;
  if (entity.kind === "heavy") return 4.8;
  if (entity.kind === "mortar") return 5.0;
  if (entity.kind === "sniper") return 6.0;
  if (entity.kind === "grenadier") return 6.3;
  if (entity.kind === "medic") return 6.4;
  if (entity.kind === "engineer") return 5.8;
  if (isInfantryKind(entity.kind)) return 6.7;
  return 0;
}

function defenseRadius(kind: DefenseKind): number {
  if (kind === "wall") return 1.15;
  if (kind === "exturret") return 1.0;
  return 0.95;
}

function ramRange(entity: CombatEntity): number {
  return entity.kind === "tank" ? 2.85 : 0;
}

function meleeRange(entity: CombatEntity): number {
  return entity.kind === "striker" ? 0.72 : 0;
}

function grenadeThrowRange(entity: CombatEntity): number {
  return entity.kind === "soldier" ? 9.2 : 0;
}

function canUseHandGrenade(entity: CombatEntity): boolean {
  return entity.kind === "soldier" && entity.status.alive && entity.grenades > 0;
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
  if (entity.kind === "tank" || entity.kind === "artillery" || entity.kind === "exturret") return "shell";
  if (entity.kind === "apc" || entity.kind === "base" || entity.kind === "turret") return "bolt";
  if (entity.kind === "grenadier" || entity.kind === "mortar") return "grenade";
  return "rifle";
}

function moveSpeed(entity: CombatEntity): number {
  if (entity.kind === "apc") return 7.4;
  if (entity.kind === "tank") return 5.5;
  if (entity.kind === "artillery") return 3.8;
  if (entity.kind === "scout") return 11.8;
  if (entity.kind === "striker") return 11.5;
  if (entity.kind === "heavy") return 4.8;
  if (entity.kind === "mortar") return 5.2;
  if (entity.kind === "sniper") return 6.2;
  if (entity.kind === "grenadier") return 5.8;
  if (entity.kind === "medic") return 6.4;
  if (entity.kind === "engineer") return 5.8;
  if (isInfantryKind(entity.kind)) return 6.5;
  return 0;
}

function projectileSpeed(entity: CombatEntity, attackMode: AttackMode = "weapon"): number {
  if (attackMode === "grenade") return 2.15;
  if (entity.kind === "tank" || entity.kind === "artillery" || entity.kind === "exturret") return 2.45;
  if (entity.kind === "apc" || entity.kind === "base" || entity.kind === "turret") return 2.8;
  if (entity.kind === "grenadier" || entity.kind === "mortar") return 2.05;
  if (entity.kind === "sniper") return 3.8;
  return 3.2;
}

function projectileRange(entity: CombatEntity, attackMode: AttackMode = "weapon"): number {
  if (attackMode === "grenade") return grenadeThrowRange(entity);
  if (entity.kind === "base") return 30;
  if (entity.kind === "artillery") return 42;
  if (entity.kind === "sniper") return 34;
  if (entity.kind === "mortar") return 30;
  if (entity.kind === "tank") return 28;
  if (entity.kind === "exturret") return 26;
  if (entity.kind === "apc") return 24;
  if (entity.kind === "heavy") return 26;
  if (entity.kind === "turret") return 24;
  if (entity.kind === "grenadier") return 22;
  if (entity.kind === "scout") return 22;
  if (entity.kind === "medic" || entity.kind === "engineer") return 18;
  return 26;
}

function projectileMaxAge(maxTravel: number, speed: number): number {
  return maxTravel / Math.max(0.1, speed) + 2.2;
}

function projectileArcHeight(kind: ProjectileKind, distanceToTarget: number): number {
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
  if (attackMode === "grenade") return 30;
  // Top-tier siege/armor hit much harder than line troops to justify their high cost + HP.
  if (kind === "artillery") return 78;
  if (kind === "tank") return 66;
  if (kind === "exturret") return 58; // mortar turret
  if (kind === "base") return 42;
  if (kind === "sniper") return 40;
  // Heavy gunner fires a 4-round burst; this is the per-round figure, so a full burst that
  // mostly connects out-damages a single rifle shot to reward closing the distance.
  if (kind === "heavy") return 18;
  if (kind === "mortar") return 44;
  if (kind === "grenadier") return 38;
  if (kind === "turret") return 30;
  if (kind === "apc") return 30;
  if (kind === "scout") return 22;
  if (kind === "striker") return 24;
  if (kind === "medic" || kind === "engineer") return 18;
  return 31;
}

// Durability tier: heavy armor / siege / emplacements carry far more health than line troops,
// so they soak punishment in line with their cost. Applied to both teams at creation.
function tierHpMultiplier(kind: EntityKind): number {
  switch (kind) {
    case "tank": return 1.3;
    case "artillery": return 1.2;
    case "exturret": return 1.25; // mortar turret
    case "heavy": return 1.18;
    case "apc": return 1.16;
    case "mortar": return 1.12;
    default: return 1;
  }
}

// Heavy gunners spray a machine-gun burst; everyone else fires one round per shot.
function burstCount(entity: CombatEntity): number {
  return entity.kind === "heavy" ? 4 : 1;
}

// Units whose weapon can be aimed at a bare ground spot (explosive direct/indirect fire).
function canGroundShellAttack(entity: CombatEntity): boolean {
  return entity.kind === "tank" || entity.kind === "artillery" || entity.kind === "grenadier" || entity.kind === "mortar" || entity.kind === "exturret";
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
  if (kind === "sniper") return 0.22;
  if (kind === "base") return 1.25;
  if (kind === "artillery") return 5.4;
  if (kind === "tank") return 2.65;
  if (kind === "exturret") return 4.6;
  if (kind === "apc") return 3.1;
  if (kind === "heavy") return 3.6;
  if (kind === "turret") return 2.3;
  if (kind === "scout") return 3.0;
  if (kind === "mortar") return 7.0;
  if (kind === "grenadier") return 7.4;
  return 2.15;
}

// Extra spread added per metre of range beyond a per-unit comfortable distance. This is what
// stops marksmen from being pinpoint at the far end of the map while keeping them deadly up to
// medium range, and nudges heavy gunners to close in.
function rangeSpreadPenalty(kind: EntityKind, attackMode: AttackMode, range: number): number {
  if (attackMode === "grenade") return 0;
  const start = kind === "sniper" ? 12 : kind === "artillery" || kind === "mortar" || kind === "exturret" ? 20 : kind === "tank" ? 14 : 9;
  const perMeter = kind === "sniper" ? 0.09 : kind === "heavy" ? 0.16 : kind === "scout" ? 0.12 : kind === "turret" ? 0.05 : 0.07;
  return Math.max(0, range - start) * perMeter;
}

function kindAccuracyLabel(kind: EntityKind, attackMode: AttackMode = "weapon"): string {
  if (attackMode === "grenade") return "thrown grenade";
  if (kind === "sniper") return "marksman";
  if (kind === "grenadier") return "launcher";
  if (kind === "mortar") return "mortar";
  if (kind === "striker") return "sidearm";
  if (kind === "artillery") return "siege gun";
  if (kind === "tank") return "stabilized cannon";
  if (kind === "exturret") return "mortar battery";
  if (kind === "turret") return "turret autogun";
  if (kind === "apc") return "autogun";
  if (kind === "heavy") return "auto-cannon";
  if (kind === "scout") return "carbine";
  if (kind === "base") return "command relay";
  return "rifle";
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
const AI_TARGET_VALUE: Partial<Record<EntityKind, number>> = {
  artillery: 9, mortar: 8, sniper: 8, medic: 8, engineer: 7, grenadier: 7,
  scout: 6, base: 6, heavy: 5, exturret: 5, striker: 5, soldier: 4, turret: 4,
  apc: 3, tank: 3, wall: 1, cover: 0,
};

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
