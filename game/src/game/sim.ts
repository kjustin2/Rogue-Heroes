import { EventBus } from "../core/events";
import {
  clamp,
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
  type DamagePart,
  type AimMode,
  type CombatEntity,
} from "./damageModel";
import { createScenario } from "./scenario";

export type Phase = "command" | "resolve" | "victory" | "defeat";
export type Intent = "select" | "move" | "shoot" | "ram" | "defend";
export type OrderKind = "move" | "shoot" | "ram" | "defend";

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
  start?: Vec2;
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
  blockedById?: string;
  blockedByGround?: boolean;
}

export type ProjectileKind = "rifle" | "shell" | "bolt";

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
  height: number;
  previousHeight: number;
  originHeight: number;
  speed: number;
  age: number;
  maxAge: number;
  color: number;
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

  phase: Phase = "command";
  intent: Intent = "select";
  aim: AimMode = "center";
  selectedId = "p-tank-1";
  turn = 1;

  private orderSeq = 0;
  private effectSeq = 0;
  private projectileSeq = 0;
  private resolveClock = 0;

  constructor(entities = createScenario()) {
    this.entities = entities;
    this.pushLog("Turn 1 command phase");
  }

  get selected(): CombatEntity | undefined {
    return this.entity(this.selectedId);
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

  cyclePlayer(): void {
    const units = this.living("player").filter((e) => e.kind !== "base");
    if (!units.length) return;
    const index = Math.max(0, units.findIndex((e) => e.id === this.selectedId));
    this.selectedId = units[(index + 1) % units.length].id;
  }

  queueMove(destination: Vec2): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot move`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    const start = this.projectedActorForPreview(actor).position;
    const desired = clampToArena(destination);
    const limited = limitMoveDestination(actor, start, desired);
    if (dist(desired, limited) > 0.05) this.pushLog(`${actor.name} move limited to ${moveRange(actor).toFixed(1)}m`);
    this.addOrder({
      actorId: actor.id,
      kind: "move",
      destination: limited,
      aim: this.aim,
      duration: actor.kind === "tank" ? 2.35 : 2.05,
    });
    return true;
  }

  queueMoveToCover(coverId: string): boolean {
    const actor = this.requirePlayerActor();
    const cover = this.entity(coverId);
    if (!actor || !cover || cover.kind !== "cover") return false;
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot move`);
    if (actor.commandPoints <= 0) return this.reject(`${actor.name} has no command points`);
    const destination = this.coverDestination(actor, cover);
    const queued = this.queueMove(destination);
    if (queued) this.pushLog(`${actor.name} moves to cover at ${cover.name}`);
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
    if (!actor || !target || actor.id === target.id) return false;
    if (target.team === "player") return this.reject("Cannot ram friendly units");
    if (actor.kind !== "tank") return this.reject("Only tanks can ram");
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot ram without mobility`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({
      actorId: actor.id,
      kind: "ram",
      targetId,
      aim: "center",
      duration: 2.45,
    });
    return true;
  }

  queueDefend(): boolean {
    const actor = this.requirePlayerActor();
    if (!actor) return false;
    if (actor.kind !== "soldier") return this.reject("Only soldiers can duck");
    if (!actor.status.canMove) return this.reject(`${actor.name} cannot duck without mobility`);
    if (!spendCommandPoint(actor)) return this.reject(`${actor.name} has no command points`);
    this.addOrder({
      actorId: actor.id,
      kind: "defend",
      aim: "center",
      duration: 2.05,
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
    const ground = firstGroundBetweenShot(from, aimPoint, fromHeight, aimHeight);
    const cover = ground ? undefined : this.firstCoverBetweenShot(from, aimPoint, fromHeight, aimHeight, intendedTarget.id);
    const impactTarget = cover ?? intendedTarget;
    const impactPart = cover ? preferredPart(cover, "center") : intendedPart;
    const aim = cover ? "center" : aimForPart(intendedPart);
    const impactPoint = ground?.point ?? (cover ? aimPointFor(cover, impactPart) : aimPoint);
    const impactHeight = ground?.height ?? (cover ? aimHeightFor(cover, impactPart) : aimHeight);

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
      blockedById: cover?.id,
      blockedByGround: Boolean(ground),
    };
  }

  endTurn(): void {
    if (this.phase !== "command") return;
    this.queueEnemyOrders();
    this.phase = "resolve";
    this.resolveClock = 0;
    this.pushLog(`Turn ${this.turn} resolving`);
    this.bus.emit("RESOLVE_START", { turn: this.turn });
  }

  reset(): void {
    const fresh = createScenario();
    this.entities.splice(0, this.entities.length, ...fresh);
    this.orders.splice(0);
    this.effects.splice(0);
    this.projectiles.splice(0);
    this.defending.clear();
    this.detonated.clear();
    this.log.splice(0);
    this.phase = "command";
    this.intent = "select";
    this.aim = "center";
    this.selectedId = "p-tank-1";
    this.turn = 1;
    this.orderSeq = 0;
    this.effectSeq = 0;
    this.projectileSeq = 0;
    this.resolveClock = 0;
    this.pushLog("Turn 1 command phase");
  }

  update(dt: number): void {
    for (const effect of this.effects) effect.age += dt;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].age >= this.effects[i].duration) this.effects.splice(i, 1);
    }

    this.defending.clear();
    if (this.phase !== "resolve") return;
    this.resolveClock += dt;
    for (let index = 0; index < this.orders.length; index += 1) {
      const order = this.orders[index];
      if (!order.done) this.updateOrder(order, dt);
    }
    this.updateProjectiles(dt);

    const allDone = this.orders.every((o) => o.done);
    if ((allDone && this.projectiles.length === 0 && this.resolveClock > 1.35) || this.resolveClock > 7.4) this.finishResolve();
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
      this.defending.add(actor.id);
      if (order.elapsed >= order.duration) order.done = true;
      return;
    }

    if (order.kind === "move") {
      if (!order.destination || !actor.status.canMove) {
        order.done = true;
        return;
      }
      if (!order.start) order.start = { ...actor.position };
      actor.position = moveToward(actor.position, order.destination, moveSpeed(actor) * dt);
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
    actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
    actor.position = moveToward(actor.position, target.position, moveSpeed(actor) * 1.25 * dt);
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
      parts: actor.parts,
    };
    for (const order of this.orders) {
      if (order.actorId !== actor.id || order.done) continue;
      if (order.kind === "move" && order.destination) {
        projected.position = { ...order.destination };
      } else if (order.kind === "ram") {
        const target = this.entity(order.targetId);
        if (target) projected.position = moveToward(projected.position, target.position, Math.max(0, dist(projected.position, target.position) - actor.radius - target.radius - 0.25));
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
      x: cover.position.x + direction.x * (cover.radius + actor.radius + 0.55),
      z: cover.position.z + direction.z * (cover.radius + actor.radius + 0.55),
    });
  }

  private launchProjectile(order: TacticalOrder, actor: CombatEntity, target: CombatEntity): string {
    const origin = muzzlePoint(actor);
    const originHeight = muzzleHeight(actor);
    const projectile: Projectile = {
      id: `projectile-${++this.projectileSeq}`,
      orderId: order.id,
      actorId: actor.id,
      targetId: target.id,
      targetPartId: order.targetPartId,
      aim: order.aim,
      kind: projectileKind(actor),
      position: { ...origin },
      previous: { ...origin },
      origin,
      height: originHeight,
      previousHeight: originHeight,
      originHeight,
      speed: actor.kind === "tank" ? 4.8 : actor.kind === "base" ? 5.2 : 6.2,
      age: 0,
      maxAge: 5.4,
      color: actor.team === "player" ? 0x75d8ff : 0xff765f,
    };
    this.projectiles.push(projectile);
    this.pushLog(`${actor.name} fires at ${target.name}`);
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

    if (!actor || !intendedTarget || !actor.status.alive || projectile.age > projectile.maxAge) {
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      if (intendedTarget && projectile.age > projectile.maxAge) this.pushLog(`${actor?.name ?? "Shot"} misses ${intendedTarget.name}`);
      return;
    }

    projectile.previous = { ...projectile.position };
    projectile.previousHeight = projectile.height;
    const targetPart = projectile.targetPartId
      ? preferredPartByIdOrAim(intendedTarget, projectile.targetPartId, projectile.aim)
      : preferredPart(intendedTarget, projectile.aim);
    const desired = aimPointFor(intendedTarget, targetPart);
    const desiredHeight = aimHeightFor(intendedTarget, targetPart);
    const next = moveToward(projectile.position, desired, projectile.speed * dt);
    const segmentLength = dist(projectile.position, desired);
    const segmentT = segmentLength > 0.0001 ? clamp(dist(projectile.position, next) / segmentLength, 0, 1) : 1;
    const nextHeight = projectile.height + (desiredHeight - projectile.height) * segmentT;
    const ground = firstGroundBetweenShot(projectile.position, next, projectile.height, nextHeight);
    if (ground) {
      projectile.position = { ...ground.point };
      projectile.height = ground.height;
      this.groundImpactProjectile(projectile, intendedTarget, ground.point);
      return;
    }
    const cover = this.firstCoverBetweenShot(projectile.position, next, projectile.height, nextHeight, intendedTarget.kind === "cover" ? undefined : intendedTarget.id);
    if (cover) {
      projectile.position = { ...cover.position };
      projectile.height = Math.min(cover.height + cover.elevation, Math.max(0.2, nextHeight));
      this.impactProjectile(projectile, cover, preferredPart(cover, "center"), true);
      return;
    }

    projectile.position = next;
    projectile.height = nextHeight;
    if (dist(projectile.position, desired) <= impactRadius(intendedTarget, targetPart)) {
      this.impactProjectile(projectile, intendedTarget, targetPart, false);
    }
  }

  private groundImpactProjectile(projectile: Projectile, intendedTarget: CombatEntity, point: Vec2): void {
    const actor = this.entity(projectile.actorId);
    const order = this.orders.find((candidate) => candidate.id === projectile.orderId);
    if (actor) this.pushLog(`${actor.name}'s shot hits high ground short of ${intendedTarget.name}`);
    this.effect(projectile.kind === "shell" ? "blast" : "ping", point, point, projectile.kind === "shell" ? 0xffbf69 : 0xffffff, 0.58, projectile.kind === "shell" ? 1.3 : 0.5);
    if (actor && projectile.kind === "shell") {
      for (const entity of this.entities) {
        if (entity.id === actor.id || !entity.status.alive || dist(entity.position, point) > 1.85 + entity.radius * 0.25) continue;
        const part = preferredPart(entity, entity.kind === "cover" ? "center" : "weakest");
        const result = applyDamage(entity, part.id, entity.kind === "cover" ? 28 : 16);
        if (result.amount > 0) {
          this.pushLog(`${entity.name} is rocked by the ground burst`);
          this.afterDamage(actor, entity, result.messages);
        }
      }
    }
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

    if (!cover && target.id === intendedTarget?.id && targetPart.role === "head" && this.defending.has(target.id)) {
      this.pushLog(`${target.name} ducks under ${actor.name}'s head shot`);
      this.effect("ping", target.position, target.position, 0x8de4ff, 0.45, target.radius + 0.45);
      this.removeProjectile(projectile.id);
      if (order) order.done = true;
      return;
    }

    const amount = this.estimateShotDamage(actor, target, targetPart, cover ? "center" : projectile.aim, cover);
    const result = applyDamage(target, targetPart.id, amount);
    if (cover && intendedTarget) this.pushLog(`${target.name} intercepts shot at ${intendedTarget.name}`);
    if (projectile.kind === "shell") {
      this.effect("blast", projectile.position, projectile.position, result.destroyed ? 0xffd166 : 0xffbf69, 0.7, target.radius + 1.05);
      this.resolveShellSplash(actor, target, targetPart, amount, projectile.position);
    } else {
      this.effect("impact", target.position, target.position, result.destroyed ? 0xffd166 : 0xffffff, 0.42, target.radius);
    }
    this.afterDamage(actor, target, result.messages);
    this.removeProjectile(projectile.id);
    if (order) order.done = true;
  }

  private removeProjectile(id: string): void {
    const index = this.projectiles.findIndex((projectile) => projectile.id === id);
    if (index >= 0) this.projectiles.splice(index, 1);
  }

  private estimateShotDamage(actor: CombatEntity, target: CombatEntity, targetPart: DamagePart, aim: AimMode, cover: boolean): number {
    const base = actor.kind === "tank" ? 58 : actor.kind === "base" ? 42 : 31;
    const range = dist(actor.position, target.position);
    const falloff = clamp(1.08 - range / 26, 0.65, 1);
    const vulnerability = cover ? 1 : vulnerabilityMultiplier(target, targetPart);
    const shellObjectBoost = actor.kind === "tank" && target.kind === "cover" ? 1.72 : 1;
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
        this.afterDamage(actor, target, result.messages);
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
        this.afterDamage(actor, entity, result.messages);
      }
    }
  }

  private resolveRam(actor: CombatEntity, target: CombatEntity): void {
    const targetPart = preferredPart(target, target.kind === "tank" ? "mobility" : "center");
    const result = applyDamage(target, targetPart.id, 72);
    const selfPart = actor.parts.find((p) => p.role === "armor" && p.hp > 0) ?? preferredPart(actor, "center");
    applyDamage(actor, selfPart.id, 14);
    this.effect("blast", target.position, target.position, 0xffb454, 0.55, target.radius + 1.4);
    this.afterDamage(actor, target, result.messages);
  }

  private afterDamage(actor: CombatEntity, target: CombatEntity, messages: string[]): void {
    for (const message of messages) this.pushLog(message);
    this.applyPartImplications(actor, target, messages);
    const volatileDestroyed = target.parts.some((p) => p.role === "volatile" && p.hp === 0);
    if (volatileDestroyed) this.resolveExplosion(actor, target);
    this.checkEndState();
  }

  private applyPartImplications(actor: CombatEntity, target: CombatEntity, messages: string[]): void {
    if (messages.some((m) => m.includes("power pack is ruptured"))) {
      this.commandShock(target.position, 2.8, target.team, `${target.name}'s pack shock disrupts nearby orders`);
      this.effect("blast", target.position, target.position, 0x6fffe0, 0.46, 2.2);
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
      this.afterDamage(actor, entity, result.messages);
    }
  }

  private firstCoverBetweenShot(from: Vec2, to: Vec2, fromHeight: number, toHeight: number, ignoreId?: string): CombatEntity | undefined {
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
        const lineHeight = fromHeight + (toHeight - fromHeight) * hit.progress;
        return lineHeight <= hit.entity.height + hit.entity.elevation + 0.18;
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
        const aim = target.kind === "tank" ? "mobility" : this.rng.chance(0.35) ? "weapon" : "center";
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
    if (this.log.length > 8) this.log.pop();
    this.bus.emit("LOG", { text });
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

function clampToArena(v: Vec2): Vec2 {
  return {
    x: clamp(v.x, -12.5, 12.5),
    z: clamp(v.z, -7.5, 7.5),
  };
}

function moveRange(entity: CombatEntity): number {
  if (entity.kind === "tank") return 4.1;
  if (entity.kind === "soldier") return 3.7;
  return 0;
}

function limitMoveDestination(entity: CombatEntity, start: Vec2, destination: Vec2): Vec2 {
  const range = moveRange(entity);
  if (range <= 0) return { ...start };
  return moveToward(start, destination, range);
}

function muzzlePoint(entity: CombatEntity): Vec2 {
  if (entity.kind === "tank") return localPoint(entity, { x: 0, z: 1.65 });
  if (entity.kind === "soldier") return localPoint(entity, { x: 0.42, z: 0.4 });
  if (entity.kind === "base") return localPoint(entity, { x: 0.2, z: 1.28 });
  return { ...entity.position };
}

function muzzleHeight(entity: CombatEntity): number {
  if (entity.kind === "tank") return entity.elevation + 1.2;
  if (entity.kind === "soldier") return entity.elevation + 1.05;
  if (entity.kind === "base") return entity.elevation + 1.75;
  return entity.elevation + Math.max(0.22, entity.height * 0.55);
}

function aimPointFor(entity: CombatEntity, part: DamagePart): Vec2 {
  return localPoint(entity, partAimOffset(entity, part));
}

function aimHeightFor(entity: CombatEntity, part: DamagePart): number {
  const base = entity.elevation;
  if (entity.kind === "soldier") {
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

function terrainHeightAt(point: Vec2): number {
  const ridgeX = 1.1;
  const ridgeZ = 5.3;
  const dx = Math.abs(point.x - ridgeX);
  const dz = Math.abs(point.z - ridgeZ);
  if (dx < 2.1 && dz < 0.78) return 0.9 * (1 - Math.max(dx / 2.1, dz / 0.78) * 0.28);
  return 0;
}

function firstGroundBetweenShot(from: Vec2, to: Vec2, fromHeight: number, toHeight: number): { point: Vec2; height: number } | undefined {
  for (let i = 1; i <= 10; i += 1) {
    const t = i / 11;
    const point = {
      x: from.x + (to.x - from.x) * t,
      z: from.z + (to.z - from.z) * t,
    };
    const lineHeight = fromHeight + (toHeight - fromHeight) * t;
    const terrain = terrainHeightAt(point);
    if (terrain > 0.04 && lineHeight <= terrain + 0.05) return { point, height: terrain + 0.04 };
  }
  return undefined;
}

function adjacentPartIds(entity: CombatEntity, partId: string): string[] {
  if (entity.kind === "soldier") {
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
  if (entity.kind === "soldier") {
    if (part.id === "head") return { x: 0.05, z: 0.34 };
    if (part.id === "rifle") return { x: 0.46, z: 0.24 };
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
  return "rifle";
}

function moveSpeed(entity: CombatEntity): number {
  if (entity.kind === "tank") return 5.5;
  if (entity.kind === "soldier") return 6.5;
  return 0;
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
