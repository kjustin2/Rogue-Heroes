import { EventBus } from "../core/events";
import {
  clamp,
  dist,
  moveToward,
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
export type Intent = "select" | "move" | "shoot" | "ram";
export type OrderKind = "move" | "shoot" | "ram";

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
  impactEntityId: string;
  impactPartId: string;
  amount: number;
  blockedById?: string;
}

export interface Projectile {
  id: string;
  orderId: string;
  actorId: string;
  targetId: string;
  targetPartId?: string;
  aim: AimMode;
  position: Vec2;
  previous: Vec2;
  origin: Vec2;
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
    this.addOrder({
      actorId: actor.id,
      kind: "move",
      destination: clampToArena(destination),
      aim: this.aim,
      duration: actor.kind === "tank" ? 1.55 : 1.15,
    });
    return true;
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
      duration: 1.8,
    });
    return true;
  }

  targetableParts(target: CombatEntity): DamagePart[] {
    return target.parts.filter(isPartIntact);
  }

  previewShot(actorId: string, targetId: string, partId: string): ShotPreview | undefined {
    const actor = this.entity(actorId);
    const intendedTarget = this.entity(targetId);
    if (!actor || !intendedTarget || actor.id === intendedTarget.id) return undefined;
    const intendedPart = this.targetableParts(intendedTarget).find((part) => part.id === partId);
    if (!intendedPart) return undefined;

    const cover = this.firstCoverBetween(actor, intendedTarget);
    const impactTarget = cover ?? intendedTarget;
    const impactPart = cover ? preferredPart(cover, "center") : intendedPart;
    const aim = cover ? "center" : aimForPart(intendedPart);

    return {
      actorId,
      targetId,
      targetPartId: partId,
      impactEntityId: impactTarget.id,
      impactPartId: impactPart.id,
      amount: this.estimateShotDamage(actor, impactTarget, impactPart, aim, Boolean(cover)),
      blockedById: cover?.id,
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

    if (this.phase !== "resolve") return;
    this.resolveClock += dt;
    for (const order of this.orders) {
      if (!order.done) this.updateOrder(order, dt);
    }
    this.updateProjectiles(dt);

    const allDone = this.orders.every((o) => o.done);
    if ((allDone && this.projectiles.length === 0 && this.resolveClock > 0.9) || this.resolveClock > 4.8) this.finishResolve();
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
      duration: 0.95,
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
    const actor = this.entity(order.actorId);
    if (!actor || !actor.status.alive) {
      order.done = true;
      return;
    }
    order.elapsed += dt;

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
      actor.yaw = Math.atan2(target.position.x - actor.position.x, target.position.z - actor.position.z);
      if (!order.fired && order.elapsed >= 0.32) {
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

  private launchProjectile(order: TacticalOrder, actor: CombatEntity, target: CombatEntity): string {
    const projectile: Projectile = {
      id: `projectile-${++this.projectileSeq}`,
      orderId: order.id,
      actorId: actor.id,
      targetId: target.id,
      targetPartId: order.targetPartId,
      aim: order.aim,
      position: { ...actor.position },
      previous: { ...actor.position },
      origin: { ...actor.position },
      speed: actor.kind === "tank" ? 8.2 : 6.2,
      age: 0,
      maxAge: 3.1,
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
    const desired = { ...intendedTarget.position };
    const next = moveToward(projectile.position, desired, projectile.speed * dt);
    const cover = this.firstCoverBetweenPoints(projectile.position, next, intendedTarget.kind === "cover" ? undefined : intendedTarget.id);
    if (cover) {
      projectile.position = { ...cover.position };
      this.impactProjectile(projectile, cover, preferredPart(cover, "center"), true);
      return;
    }

    projectile.position = next;
    if (dist(projectile.position, intendedTarget.position) <= intendedTarget.radius + 0.2) {
      const targetPart = projectile.targetPartId
        ? preferredPartByIdOrAim(intendedTarget, projectile.targetPartId, projectile.aim)
        : preferredPart(intendedTarget, projectile.aim);
      this.impactProjectile(projectile, intendedTarget, targetPart, false);
    }
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

    const amount = this.estimateShotDamage(actor, target, targetPart, cover ? "center" : projectile.aim, cover);
    const result = applyDamage(target, targetPart.id, amount);
    if (cover && intendedTarget) this.pushLog(`${target.name} intercepts shot at ${intendedTarget.name}`);
    this.effect("impact", target.position, target.position, result.destroyed ? 0xffd166 : 0xffffff, 0.42, target.radius);
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
    return Math.round(base * falloff * (cover ? 0.95 : aimDamageMultiplier(aim)) * vulnerability);
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

  private firstCoverBetween(actor: CombatEntity, target: CombatEntity): CombatEntity | undefined {
    return this.firstCoverBetweenPoints(actor.position, target.position, target.id);
  }

  private firstCoverBetweenPoints(from: Vec2, to: Vec2, ignoreId?: string): CombatEntity | undefined {
    const candidates = this.entities
      .filter((e) => e.kind === "cover" && e.status.alive && e.id !== ignoreId)
      .map((e) => ({
        entity: e,
        progress: segmentProgress(e.position, from, to),
        distance: pointToSegmentDistance(e.position, from, to),
      }))
      .filter((hit) => hit.progress > 0.02 && hit.progress < 0.98 && hit.distance <= hit.entity.radius + 0.18)
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
          duration: 1.35,
        });
      }
    }
  }

  private finishResolve(): void {
    this.orders.splice(0);
    this.projectiles.splice(0);
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
