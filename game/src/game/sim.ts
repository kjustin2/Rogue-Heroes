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
  factionLiving,
  isPartIntact,
  preferredPart,
  repairForNewTurn,
  spendCommandPoint,
  vulnerabilityMultiplier,
  type DamageResult,
  type DamagePart,
  type AimMode,
  type CombatEntity,
  type EntityKind,
  type InfantryStance,
  isInfantryKind,
} from "./damageModel";
import { createScenario } from "./scenario";
import { clampToArena, terrainHeightAt } from "./terrain";

export type Phase = "command" | "resolve" | "victory" | "defeat";
export type Intent = "select" | "move" | "shoot" | "ram" | "defend" | "melee" | "interact" | "inspect" | "inspect-detail";
export type OrderKind = "move" | "shoot" | "ram" | "defend" | "melee";

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
  type: "shot" | "impact" | "blast" | "ping";
  from: Vec2;
  to: Vec2;
  color: number;
  age: number;
  duration: number;
  radius?: number;
  label?: string;
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
  targetId: string;
  targetPartId?: string;
  aim: AimMode;
  kind: ProjectileKind;
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
  targetTeam: CombatEntity["team"];
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

  phase: Phase = "command";
  intent: Intent = "select";
  aim: AimMode = "center";
  selectedId = "p-tank-1";
  turn = 1;

  private orderSeq = 0;
  private effectSeq = 0;
  private projectileSeq = 0;
  private damageSeq = 0;
  private resolveClock = 0;
  private activeTurnReport: TurnReport | undefined;

  constructor(entities = createScenario()) {
    this.entities = entities;
    this.syncAllElevations();
    this.pushLog("Turn 1 command phase");
  }

  get selected(): CombatEntity | undefined {
    return this.entity(this.selectedId);
  }

  get currentTurnReport(): TurnReport | undefined {
    return this.activeTurnReport;
  }

  entity(id: string | undefined): CombatEntity | undefined {
    return id ? this.entities.find((e) => e.id === id) : undefined;
  }

  living(team?: CombatEntity["team"]): CombatEntity[] {
    return this.entities.filter((e) => e.status.alive && (!team || e.team === team));
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

  cyclePlayer(): void {
    const units = this.living("player").filter((e) => e.kind !== "base");
    if (!units.length) return;
    const index = units.findIndex((e) => e.id === this.selectedId);
    this.selectedId = units[index >= 0 ? (index + 1) % units.length : 0].id;
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
      duration: actor.kind === "tank" ? 2.85 : 2.55,
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

  queueTakeCover(coverId: string): boolean {
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

  projectedSelected(): { position: Vec2; elevation: number; stance: InfantryStance } | undefined {
    const actor = this.selected;
    if (!actor) return undefined;
    const projected = this.projectedActorForPreview(actor);
    return { position: { ...projected.position }, elevation: projected.elevation, stance: projected.stance };
  }

  selectedActionRange(): { kind: "ram" | "melee"; radius: number; position: Vec2; elevation: number } | undefined {
    const actor = this.selected;
    if (!actor || actor.team !== "player" || this.phase !== "command") return undefined;
    const projected = this.projectedActorForPreview(actor);
    if (this.intent === "ram" && actor.kind === "tank" && actor.status.canMove) {
      return { kind: "ram", radius: ramRange(actor) + actor.radius, position: { ...projected.position }, elevation: projected.elevation };
    }
    if (this.intent === "melee" && actor.kind === "striker" && actor.status.canMove) {
      return { kind: "melee", radius: meleeRange(actor) + actor.radius, position: { ...projected.position }, elevation: projected.elevation };
    }
    return undefined;
  }

  queueMelee(targetId: string): boolean {
    const actor = this.requirePlayerActor();
    const target = this.entity(targetId);
    const failure = this.meleeFailureReason(actor, target);
    if (failure) return this.reject(failure);
    if (!actor) return false;
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({
      actorId: actor.id,
      kind: "melee",
      targetId,
      aim: "weakest",
      duration: 1.55,
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

  cancelOrder(orderId: string): boolean {
    if (this.phase !== "command") return this.reject("Orders can only be changed during command phase");
    let index = this.orders.findIndex((order) => order.id === orderId);
    if (index < 0) index = this.orders.findIndex((order) => order.actorId === orderId && this.entity(order.actorId)?.team === "player");
    const order = this.orders[index];
    const actor = this.entity(order?.actorId);
    if (!actor || actor.team !== "player" || index < 0) return false;
    this.orders.splice(index, 1);
    actor.commandPoints = Math.min(actor.maxCommandPoints, actor.commandPoints + 1);
    this.pushLog(`${actor.name} order cancelled`);
    return true;
  }

  targetableParts(target: CombatEntity): DamagePart[] {
    return target.parts.filter(isPartIntact);
  }

  previewShot(actorId: string, targetId: string, partId: string): ShotPreview | undefined {
    this.syncAllElevations();
    const sourceActor = this.entity(actorId);
    const intendedTarget = this.entity(targetId);
    if (!sourceActor || !intendedTarget || sourceActor.id === intendedTarget.id) return undefined;
    const intendedPart = this.targetableParts(intendedTarget).find((part) => part.id === partId);
    if (!intendedPart) return undefined;

    const actor = this.projectedActorForPreview(sourceActor);
    const aimPoint = aimPointFor(intendedTarget, intendedPart);
    const aimHeight = aimHeightFor(intendedTarget, intendedPart);
    actor.yaw = Math.atan2(aimPoint.x - actor.position.x, aimPoint.z - actor.position.z);
    const from = muzzlePoint(actor);
    const fromHeight = muzzleHeight(actor);
    const accuracy = this.accuracyForShot(actor, intendedTarget, intendedPart, this.actorHasQueuedMove(actor.id));
    const kind = projectileKind(actor);
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
      amount: ground ? 0 : this.estimateShotDamage(actor, impactTarget, impactPart, aim, Boolean(cover)),
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
    this.phase = "resolve";
    this.resolveClock = 0;
    this.activeTurnReport = { turn: this.turn, phase: "active", entries: [], notes: [] };
    this.pushLog(`Turn ${this.turn} resolving`);
    this.bus.emit("RESOLVE_START", { turn: this.turn });
  }

  reset(): void {
    const fresh = createScenario();
    this.entities.splice(0, this.entities.length, ...fresh);
    this.syncAllElevations();
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
    this.selectedId = "p-tank-1";
    this.turn = 1;
    this.orderSeq = 0;
    this.effectSeq = 0;
    this.projectileSeq = 0;
    this.damageSeq = 0;
    this.resolveClock = 0;
    this.pushLog("Turn 1 command phase");
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

    const allDone = this.orders.every((o) => o.done);
    if ((allDone && this.projectiles.length === 0 && this.resolveClock > 1.9) || this.resolveClock > 13.5) this.finishResolve();
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
      this.syncEntityElevation(actor);
      actor.yaw = Math.atan2(order.destination.x - actor.position.x, order.destination.z - actor.position.z);
      if (dist(actor.position, order.destination) < 0.08 || order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "shoot") {
      const target = this.entity(order.targetId);
      if (order.projectileId) {
        order.done = !this.projectiles.some((projectile) => projectile.id === order.projectileId);
        return;
      }
      if (!target || !target.status.alive || !actor.status.canShoot) {
        order.done = true;
        return;
      }
      const targetPart = order.targetPartId
        ? preferredPartByIdOrAim(target, order.targetPartId, order.aim)
        : preferredPart(target, order.aim);
      const aimPoint = aimPointFor(target, targetPart);
      actor.yaw = Math.atan2(aimPoint.x - actor.position.x, aimPoint.z - actor.position.z);
      if (!order.fired && order.elapsed >= 0.58) {
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
      actor.position = moveToward(actor.position, target.position, moveSpeed(actor) * 2.05 * dt);
      this.syncEntityElevation(actor);
      if (!order.fired && dist(actor.position, target.position) <= actor.radius + target.radius + 0.32) {
        order.fired = true;
        this.resolveMelee(actor, target);
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
        const target = this.entity(order.targetId);
        if (target) projected.position = moveToward(projected.position, target.position, Math.max(0, dist(projected.position, target.position) - actor.radius - target.radius - 0.3));
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

  private blockedMoveDestination(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId?: string): Vec2 {
    const pathLength = dist(start, destination);
    if (pathLength < 0.05) return destination;
    const terrainBlock = this.blockedBySteepTerrain(actor, start, destination, allowedCoverId, pathLength);
    if (terrainBlock) return terrainBlock;
    const blockers = this.entities
      .filter((entity) => entity.kind === "cover" && entity.status.alive && entity.id !== allowedCoverId && entity.coverKind !== "ridge")
      .map((entity) => ({
        entity,
        progress: segmentProgress(entity.position, start, destination),
        distance: pointToSegmentDistance(entity.position, start, destination),
      }))
      .filter((hit) => hit.progress > 0.02 && hit.progress <= 1 && hit.distance <= hit.entity.radius + actor.radius * 0.62)
      .sort((a, b) => a.progress - b.progress);
    const blocker = blockers[0];
    if (!blocker) return destination;
    const stopBack = (blocker.entity.radius + actor.radius + 0.28) / pathLength;
    const t = clamp(blocker.progress - stopBack, 0, 1);
    const stopped = {
      x: start.x + (destination.x - start.x) * t,
      z: start.z + (destination.z - start.z) * t,
    };
    this.pushLog(`${actor.name}'s move is blocked by ${blocker.entity.name}`);
    return clampToArena(stopped);
  }

  private blockedBySteepTerrain(actor: CombatEntity, start: Vec2, destination: Vec2, allowedCoverId: string | undefined, pathLength: number): Vec2 | undefined {
    const allowedCover = this.entity(allowedCoverId);
    if (allowedCover && isCliffCover(allowedCover) && isInfantryKind(actor.kind)) return undefined;
    const samples = Math.max(12, Math.ceil(pathLength * 3.5));
    let previous = start;
    let previousHeight = terrainHeightAt(start);

    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      const point = {
        x: start.x + (destination.x - start.x) * t,
        z: start.z + (destination.z - start.z) * t,
      };
      const height = terrainHeightAt(point);
      const stepDistance = Math.max(0.01, dist(previous, point));
      const rise = height - previousHeight;
      const grade = Math.abs(rise) / stepDistance;

      if (Math.abs(rise) > 0.16 && grade > 0.72) {
        const back = Math.min(0.32 / pathLength, t);
        const stopT = clamp(t - back, 0, 1);
        const stopped = clampToArena({
          x: start.x + (destination.x - start.x) * stopT,
          z: start.z + (destination.z - start.z) * stopT,
        });
        this.pushLog(`${actor.name} must use a cliff ascent`);
        return stopped;
      }

      previous = point;
      previousHeight = height;
    }

    return undefined;
  }

  private launchProjectile(order: TacticalOrder, actor: CombatEntity, target: CombatEntity): string {
    this.syncEntityElevation(actor);
    this.syncEntityElevation(target);
    const targetPart = order.targetPartId
      ? preferredPartByIdOrAim(target, order.targetPartId, order.aim)
      : preferredPart(target, order.aim);
    const origin = muzzlePoint(actor);
    const originHeight = muzzleHeight(actor);
    const intendedPoint = aimPointFor(target, targetPart);
    const intendedHeight = aimHeightFor(target, targetPart);
    const movedBeforeShot = this.actorMovedBeforeOrder(order);
    const accuracy = this.accuracyForShot(actor, target, targetPart, movedBeforeShot);
    const baseYaw = Math.atan2(intendedPoint.x - origin.x, intendedPoint.z - origin.z);
    const horizontalDistance = Math.max(0.001, dist(origin, intendedPoint));
    const basePitch = Math.atan2(intendedHeight - originHeight, horizontalDistance);
    const yawError = accuracy.spreadRadians > 0 ? this.rng.range(-accuracy.spreadRadians, accuracy.spreadRadians) : 0;
    const pitchSpread = accuracy.spreadRadians * 0.62;
    const pitchError = pitchSpread > 0 ? this.rng.range(-pitchSpread, pitchSpread) : 0;
    const yaw = baseYaw + yawError;
    const pitch = clamp(basePitch + pitchError, -0.42, 0.42);
    const direction = normalize({ x: Math.sin(yaw), z: Math.cos(yaw) });
    const maxTravel = Math.max(horizontalDistance + 10, projectileRange(actor));
    const kind = projectileKind(actor);
    const projectile: Projectile = {
      id: `projectile-${++this.projectileSeq}`,
      orderId: order.id,
      actorId: actor.id,
      targetId: target.id,
      targetPartId: order.targetPartId,
      aim: order.aim,
      kind,
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
      speed: projectileSpeed(actor),
      age: 0,
      maxAge: projectileMaxAge(actor),
      color: actor.team === "player" ? 0x75d8ff : 0xff765f,
      accuracy: accuracy.rating,
      spreadRadians: accuracy.spreadRadians,
      yawErrorRadians: yawError,
      pitchErrorRadians: pitchError,
      arcHeight: projectileArcHeight(kind, horizontalDistance),
      arcDistance: horizontalDistance,
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    this.projectiles.push(projectile);
    this.pushLog(`${actor.name} fires at ${target.name} (${accuracy.label})`);
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

    const proximity = this.firstExplosiveProximity(projectile, projectile.position, next, projectile.height, nextHeight);
    if (proximity) {
      projectile.travel += step * proximity.progress;
      projectile.position = { ...proximity.point };
      projectile.height = projectile.height + (nextHeight - projectile.height) * proximity.progress;
      this.proximityDetonateProjectile(projectile, proximity.entity, proximity.point);
      return;
    }

    projectile.travel = nextTravel;
    projectile.position = next;
    projectile.height = nextHeight;
  }

  private groundImpactProjectile(projectile: Projectile, intendedTarget: CombatEntity | undefined, point: Vec2): void {
    const actor = this.entity(projectile.actorId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
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

    const amount = this.estimateShotDamage(actor, target, targetPart, cover ? "center" : projectile.aim, cover);
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

  private estimateShotDamage(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, aim: AimMode, cover: boolean): number {
    const base = baseShotDamage(actor.kind);
    const range = dist(actor.position, target.position);
    const falloff = clamp(1.08 - range / 26, 0.65, 1);
    const vulnerability = cover ? 1 : vulnerabilityMultiplier(target, targetPart);
    const shellObjectBoost = (actor.kind === "tank" || actor.kind === "grenadier") && target.kind === "cover" ? 1.72 : 1;
    return Math.round(base * falloff * (cover ? 1.05 : aimDamageMultiplier(aim)) * vulnerability * shellObjectBoost * this.supportDamageMultiplier(actor));
  }

  private supportDamageMultiplier(actor: CombatEntity): number {
    if (actor.team !== "player") return 1;
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
    const localSplash = Math.max(10, Math.round(amount * 0.34));
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
      const radius = target.kind === "cover" ? 2.7 : 1.9;
      if (d > radius + entity.radius * 0.35) continue;
      const part = preferredPart(entity, entity.kind === "cover" ? "center" : "weakest");
      const falloff = clamp(1 - d / (radius + entity.radius), 0.18, 0.74);
      const splash = Math.round((entity.kind === "cover" ? 38 : 22) * falloff);
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
      const amount = Math.round((entity.kind === "cover" ? baseDamage * 1.45 : baseDamage) * falloff);
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
    const result = applyDamage(target, targetPart.id, 72);
    const selfPart = actor.parts.find((p) => p.role === "armor" && p.hp > 0) ?? preferredPart(actor, "center");
    const selfResult = applyDamage(actor, selfPart.id, 14);
    this.effect("blast", target.position, target.position, 0xffb454, 0.55, target.radius + 1.4);
    this.afterDamage(actor, target, result);
    if (selfResult.amount > 0) this.afterDamage(actor, actor, selfResult, "Ram recoil");
  }

  private resolveMelee(actor: CombatEntity, target: CombatEntity): void {
    const targetPart = preferredPart(target, target.kind === "cover" ? "center" : "weakest");
    const amount = target.kind === "cover" ? 54 : 86;
    const result = applyDamage(target, targetPart.id, amount);
    this.effect("blast", target.position, target.position, result.killed ? 0xfff1a6 : 0x9dfcff, 0.52, target.radius + 1.1);
    this.pushLog(`${actor.name} strikes ${target.name}`);
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

  private accuracyForShot(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, movedBeforeShot: boolean): AccuracyBreakdown {
    let spreadDegrees = baseAccuracySpread(actor.kind);
    const notes: string[] = [`${kindAccuracyLabel(actor.kind)} base`];

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
    if (actor.team !== "player") return 1;
    const spotter = this.entities.find((entity) =>
      entity.id !== actor.id &&
      entity.team === actor.team &&
      entity.status.alive &&
      dist(entity.position, actor.position) <= 6.2 &&
      entity.parts.some((part) => part.hp > 0 && part.tags?.includes("spotter-aura"))
    );
    return spotter ? 0.82 : 1;
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
        if (hit.progress <= 0.02 || hit.progress >= 0.98) return false;
        if (hit.distance > hit.entity.radius + 0.18) return false;
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
        if (hit.progress <= 0.02 || hit.progress >= 0.98) return false;
        if (hit.distance > hit.entity.radius * 0.72) return false;
        return hit.lineHeight >= hit.entity.elevation - 0.12 && hit.lineHeight <= hit.entity.elevation + hit.entity.height + 0.22;
      })
      .sort((a, b) => a.progress - b.progress);
    return candidates[0]?.entity;
  }

  private queueEnemyOrders(): void {
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
    const players = this.living("player");
    if (!players.length) return;
    for (const enemy of this.living("enemy")) {
      const target = nearest(enemy, players);
      if (!target) continue;
      if (enemy.status.canShoot && enemy.commandPoints > 0) {
        const aim = enemy.kind === "sniper"
          ? (isInfantryKind(target.kind) ? "head" : "weapon")
          : enemy.kind === "grenadier"
            ? "center"
            : target.kind === "tank" ? "mobility" : this.rng.chance(0.35) ? "weapon" : "center";
        this.queueShootFor(enemy, target, aim);
      }
      if (enemy.kind === "tank" && enemy.status.canMove && enemy.commandPoints > 0 && dist(enemy.position, target.position) > 5) {
        spendCommandPoint(enemy);
        this.addOrder({
          actorId: enemy.id,
          kind: "move",
          destination: moveToward(enemy.position, target.position, 3.3),
          aim: "center",
          duration: 2.05,
        });
      }
    }
  }

  private finishResolve(): void {
    this.orders.splice(0);
    this.projectiles.splice(0);
    this.defending.clear();
    this.refreshDefendingStances();
    this.finalizeTurnReport();
    if (this.phase === "victory" || this.phase === "defeat") return;
    this.turn += 1;
    this.phase = "command";
    this.resolveClock = 0;
    for (const entity of this.entities) repairForNewTurn(entity);
    this.pushLog(`Turn ${this.turn} command phase`);
    this.bus.emit("TURN_START", { turn: this.turn });
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
    this.activeTurnReport.entries.push({
      id: `damage-${++this.damageSeq}`,
      actorName: actor.name,
      targetName: target.name,
      targetTeam: target.team,
      partLabel: part?.label ?? result.partId,
      amount: result.amount,
      remainingHp: Math.max(0, part?.hp ?? 0),
      maxHp: part?.maxHp ?? Math.max(1, result.amount),
      killed: result.killed,
      destroyed: result.destroyed,
      source,
    });
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

function moveRange(entity: CombatEntity): number {
  if (entity.kind === "tank") return 4.1;
  if (entity.kind === "striker") return 8.4;
  if (entity.kind === "sniper") return 4.55;
  if (entity.kind === "grenadier") return 4.85;
  if (isInfantryKind(entity.kind)) return 5.15;
  return 0;
}

function ramRange(entity: CombatEntity): number {
  return entity.kind === "tank" ? 2.85 : 0;
}

function meleeRange(entity: CombatEntity): number {
  return entity.kind === "striker" ? 8.2 : 0;
}

function limitMoveDestination(entity: CombatEntity, start: Vec2, destination: Vec2): Vec2 {
  const range = moveRange(entity);
  if (range <= 0) return { ...start };
  return moveToward(start, destination, range);
}

function muzzlePoint(entity: CombatEntity): Vec2 {
  if (entity.kind === "tank") return localPoint(entity, { x: 0, z: 1.65 });
  if (entity.kind === "sniper") return localPoint(entity, { x: 0.5, z: 0.72 });
  if (entity.kind === "grenadier") return localPoint(entity, { x: 0.46, z: 0.58 });
  if (isInfantryKind(entity.kind)) return localPoint(entity, { x: 0.42, z: 0.4 });
  if (entity.kind === "base") return localPoint(entity, { x: 0.2, z: 1.28 });
  return { ...entity.position };
}

function muzzleHeight(entity: CombatEntity): number {
  if (entity.kind === "tank") return entity.elevation + 1.2;
  if (entity.kind === "sniper") return entity.elevation + stanceMuzzleHeight(entity, 1.12);
  if (entity.kind === "grenadier") return entity.elevation + stanceMuzzleHeight(entity, 1.02);
  if (isInfantryKind(entity.kind)) return entity.elevation + stanceMuzzleHeight(entity, 1.05);
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
  if (entity.kind === "tank") {
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
  for (let i = 1; i <= 10; i += 1) {
    const t = i / 11;
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
  if (entity.kind === "tank") {
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
      core: ["turret", "comms", "power", "gate"],
      turret: ["core", "gate"],
      comms: ["core", "power"],
      power: ["core", "comms"],
      gate: ["core", "turret"],
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
  if (entity.kind === "tank") {
    if (part.id === "left-tread") return { x: -1.15, z: -0.05 };
    if (part.id === "right-tread") return { x: 1.15, z: -0.05 };
    if (part.id === "front-plate") return { x: 0, z: 0.88 };
    if (part.id === "cannon") return { x: 0, z: 1.26 };
    if (part.id === "turret") return { x: 0, z: 0.18 };
    return { x: 0, z: 0 };
  }
  if (entity.kind === "base") {
    if (part.id === "turret") return { x: 0.2, z: 0.95 };
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

function projectileKind(entity: CombatEntity): ProjectileKind {
  if (entity.kind === "tank") return "shell";
  if (entity.kind === "base") return "bolt";
  if (entity.kind === "grenadier") return "grenade";
  return "rifle";
}

function moveSpeed(entity: CombatEntity): number {
  if (entity.kind === "tank") return 5.5;
  if (entity.kind === "striker") return 11.5;
  if (entity.kind === "sniper") return 6.2;
  if (entity.kind === "grenadier") return 5.8;
  if (isInfantryKind(entity.kind)) return 6.5;
  return 0;
}

function projectileSpeed(entity: CombatEntity): number {
  if (entity.kind === "tank") return 2.45;
  if (entity.kind === "base") return 2.8;
  if (entity.kind === "grenadier") return 2.05;
  if (entity.kind === "sniper") return 3.8;
  return 3.2;
}

function projectileRange(entity: CombatEntity): number {
  if (entity.kind === "base") return 30;
  if (entity.kind === "sniper") return 34;
  if (entity.kind === "grenadier") return 22;
  if (entity.kind === "tank") return 28;
  return 26;
}

function projectileMaxAge(entity: CombatEntity): number {
  return projectileRange(entity) / Math.max(0.1, projectileSpeed(entity)) + 1.6;
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

function baseShotDamage(kind: EntityKind): number {
  if (kind === "tank") return 58;
  if (kind === "base") return 42;
  if (kind === "sniper") return 38;
  if (kind === "grenadier") return 34;
  if (kind === "striker") return 24;
  return 31;
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

function baseAccuracySpread(kind: EntityKind): number {
  if (kind === "sniper") return 0.22;
  if (kind === "base") return 1.25;
  if (kind === "tank") return 2.65;
  if (kind === "grenadier") return 7.4;
  return 2.15;
}

function kindAccuracyLabel(kind: EntityKind): string {
  if (kind === "sniper") return "marksman";
  if (kind === "grenadier") return "launcher";
  if (kind === "striker") return "sidearm";
  if (kind === "tank") return "stabilized cannon";
  if (kind === "base") return "turret";
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
  if (entity.kind === "tank") {
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
