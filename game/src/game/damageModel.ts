import type { Vec2 } from "../core/math";

export type Team = "player" | "enemy" | "neutral";
export type EntityKind = "soldier" | "sniper" | "grenadier" | "striker" | "tank" | "base" | "cover";
export type CoverKind = "wall" | "barricade" | "fuel" | "ammo" | "conduit" | "ridge" | "cliff";
export type PartRole = "core" | "head" | "weapon" | "mobility" | "armor" | "utility" | "volatile";
export type AimMode = "center" | "head" | "weapon" | "mobility" | "utility" | "core" | "weakest";
export type InfantryStance = "standing" | "crouched" | "prone";

export interface DamagePart {
  id: string;
  label: string;
  role: PartRole;
  maxHp: number;
  hp: number;
  exposed: boolean;
  critical?: boolean;
  tags?: string[];
}

export interface EntityStatus {
  alive: boolean;
  canMove: boolean;
  canShoot: boolean;
  immobilized: boolean;
  disarmed: boolean;
  exposedCore: boolean;
  commandLimited: boolean;
  systemsDown: string[];
  deadReason?: string;
}

export interface CombatEntity {
  id: string;
  name: string;
  kind: EntityKind;
  coverKind?: CoverKind;
  team: Team;
  position: Vec2;
  yaw: number;
  radius: number;
  height: number;
  elevation: number;
  stance: InfantryStance;
  commandPoints: number;
  maxCommandPoints: number;
  parts: DamagePart[];
  status: EntityStatus;
}

export interface CoverOptions {
  volatile?: boolean;
  coverKind?: CoverKind;
  hp?: number;
  radius?: number;
  height?: number;
}

export interface DamageResult {
  entityId: string;
  partId: string;
  amount: number;
  overflow: number;
  destroyed: boolean;
  killed: boolean;
  messages: string[];
}

export const AIM_LABELS: Record<AimMode, string> = {
  center: "Center Mass",
  head: "Head",
  weapon: "Weapon",
  mobility: "Mobility",
  utility: "Systems",
  core: "Core",
  weakest: "Weak Point",
};

function part(id: string, label: string, role: PartRole, maxHp: number, extras: Partial<DamagePart> = {}): DamagePart {
  return {
    id,
    label,
    role,
    maxHp,
    hp: maxHp,
    exposed: true,
    ...extras,
  };
}

function statusFor(kind: EntityKind): EntityStatus {
  return {
    alive: true,
    canMove: isInfantryKind(kind) || kind === "tank",
    canShoot: (isInfantryKind(kind) && kind !== "striker") || kind === "tank" || kind === "base",
    immobilized: false,
    disarmed: false,
    exposedCore: false,
    commandLimited: false,
    systemsDown: [],
  };
}

export function createTank(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const entity: CombatEntity = {
    id,
    name,
    kind: "tank",
    team,
    position,
    yaw: team === "player" ? Math.PI * 0.5 : -Math.PI * 0.5,
    radius: 1.45,
    height: 1.55,
    elevation: 0,
    stance: "standing",
    commandPoints: 2,
    maxCommandPoints: 2,
    status: statusFor("tank"),
    parts: [
      part("hull", "Hull", "core", 120, { critical: true }),
      part("turret", "Turret Ring", "utility", 55),
      part("cannon", "Cannon", "weapon", 42),
      part("left-tread", "Left Tread", "mobility", 34),
      part("right-tread", "Right Tread", "mobility", 34),
      part("front-plate", "Front Plate", "armor", 70),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

export function createSoldier(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "soldier", team, position, {
    radius: 0.65,
    height: 1.65,
    bodyHp: 46,
    headHp: 16,
    weaponHp: 18,
    legsHp: 24,
    packHp: 22,
    weaponLabel: "Rifle",
    packLabel: "Power Pack",
    packRole: "utility",
  });
}

export function createSniper(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const entity = createInfantry(id, name, "sniper", team, position, {
    radius: 0.62,
    height: 1.68,
    bodyHp: 38,
    headHp: 13,
    weaponHp: 28,
    legsHp: 20,
    packHp: 18,
    weaponLabel: "Marksman Rifle",
    packLabel: "Optic Relay",
    packRole: "utility",
    packTags: ["spotter-aura"],
  });
  return entity;
}

export function createGrenadier(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "grenadier", team, position, {
    radius: 0.72,
    height: 1.66,
    bodyHp: 52,
    headHp: 16,
    weaponHp: 24,
    legsHp: 24,
    packHp: 24,
    weaponLabel: "Grenade Launcher",
    packLabel: "Ammo Satchel",
    packRole: "volatile",
  });
}

export function createStriker(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "striker", team, position, {
    radius: 0.58,
    height: 1.62,
    bodyHp: 42,
    headHp: 14,
    weaponHp: 30,
    legsHp: 26,
    packHp: 18,
    weaponLabel: "Arc Blade",
    packLabel: "Sprint Rig",
    packRole: "utility",
  });
}

function createInfantry(
  id: string,
  name: string,
  kind: "soldier" | "sniper" | "grenadier" | "striker",
  team: Team,
  position: Vec2,
  config: {
    radius: number;
    height: number;
    bodyHp: number;
    headHp: number;
    weaponHp: number;
    legsHp: number;
    packHp: number;
    weaponLabel: string;
    packLabel: string;
    packRole: "utility" | "volatile";
    packTags?: string[];
  }
): CombatEntity {
  const entity: CombatEntity = {
    id,
    name,
    kind,
    team,
    position,
    yaw: team === "player" ? Math.PI * 0.5 : -Math.PI * 0.5,
    radius: config.radius,
    height: config.height,
    elevation: 0,
    stance: "standing",
    commandPoints: 2,
    maxCommandPoints: 2,
    status: statusFor(kind),
    parts: [
      part("body", "Body", "core", config.bodyHp, { critical: true }),
      part("head", "Head", "head", config.headHp, { critical: true }),
      part("rifle", config.weaponLabel, "weapon", config.weaponHp),
      part("legs", "Legs", "mobility", config.legsHp),
      part("pack", config.packLabel, config.packRole, config.packHp, { tags: config.packTags }),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

export function createBase(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const entity: CombatEntity = {
    id,
    name,
    kind: "base",
    team,
    position,
    yaw: team === "player" ? Math.PI * 0.5 : -Math.PI * 0.5,
    radius: 2.2,
    height: 3.1,
    elevation: 0,
    stance: "standing",
    commandPoints: 1,
    maxCommandPoints: 1,
    status: statusFor("base"),
    parts: [
      part("core", "Command Core", "core", 150, { critical: true }),
      part("turret", "Defense Turret", "weapon", 55),
      part("comms", "Comms Mast", "utility", 35),
      part("power", "Power Cell", "volatile", 45),
      part("gate", "Gate Section", "armor", 75),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

export function createCover(id: string, name: string, position: Vec2, options: boolean | CoverOptions = false): CombatEntity {
  const settings: CoverOptions = typeof options === "boolean" ? { volatile: options } : options;
  const coverKind = settings.coverKind ?? (settings.volatile ? "fuel" : name.toLowerCase().includes("barricade") ? "barricade" : "wall");
  const volatile = Boolean(settings.volatile || coverKind === "fuel" || coverKind === "ammo" || coverKind === "conduit");
  const hp = settings.hp ?? (coverKind === "barricade" ? 42 : coverKind === "ammo" ? 34 : coverKind === "conduit" ? 44 : volatile ? 36 : coverKind === "ridge" ? 95 : coverKind === "cliff" ? 160 : 70);
  const entity: CombatEntity = {
    id,
    name,
    kind: "cover",
    coverKind,
    team: "neutral",
    position,
    yaw: 0,
    radius: settings.radius ?? (coverKind === "barricade" ? 0.82 : volatile ? 0.7 : coverKind === "ridge" ? 1.2 : coverKind === "cliff" ? 1.28 : 1.05),
    height: settings.height ?? (coverKind === "barricade" ? 0.82 : volatile ? 1.2 : coverKind === "ridge" ? 1.85 : coverKind === "cliff" ? 2.15 : 1.55),
    elevation: 0,
    stance: "standing",
    commandPoints: 0,
    maxCommandPoints: 0,
    status: statusFor("cover"),
    parts: [
      part(volatile ? "cell" : "wall", volatile ? (coverKind === "ammo" ? "Ammo Cache" : coverKind === "conduit" ? "Power Conduit" : "Fuel Cell") : coverKind === "cliff" ? "Cliff Face" : coverKind === "ridge" ? "High Ground" : coverKind === "barricade" ? "Barricade" : "Wall Block", volatile ? "volatile" : "core", hp, {
        critical: true,
        tags: coverKind === "ridge" || coverKind === "cliff" ? ["high-ground"] : undefined,
      }),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

export function cloneEntity(entity: CombatEntity): CombatEntity {
  return {
    ...entity,
    position: { ...entity.position },
    status: { ...entity.status },
    stance: entity.stance,
    parts: entity.parts.map((p) => ({ ...p, tags: p.tags ? [...p.tags] : undefined })),
  };
}

export function isInfantryKind(kind: EntityKind): boolean {
  return kind === "soldier" || kind === "sniper" || kind === "grenadier" || kind === "striker";
}

export function isPartIntact(part: DamagePart): boolean {
  return part.hp > 0;
}

export function findPart(entity: CombatEntity, partId: string): DamagePart | undefined {
  return entity.parts.find((p) => p.id === partId);
}

export function partsByRole(entity: CombatEntity, role: PartRole): DamagePart[] {
  return entity.parts.filter((p) => p.role === role && isPartIntact(p));
}

export function preferredPart(entity: CombatEntity, aim: AimMode): DamagePart {
  const intact = entity.parts.filter(isPartIntact);
  if (!intact.length) return entity.parts[0];

  const byRole = (role: PartRole): DamagePart | undefined => intact.find((p) => p.role === role);
  if (aim === "head") return byRole("head") ?? byRole("core") ?? intact[0];
  if (aim === "weapon") return byRole("weapon") ?? byRole("utility") ?? byRole("core") ?? intact[0];
  if (aim === "mobility") return byRole("mobility") ?? byRole("core") ?? intact[0];
  if (aim === "utility") return byRole("utility") ?? byRole("volatile") ?? byRole("weapon") ?? byRole("core") ?? intact[0];
  if (aim === "core") return byRole("core") ?? intact[0];
  if (aim === "weakest") {
    return [...intact].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
  }
  return byRole("core") ?? intact[0];
}

export function aimDamageMultiplier(aim: AimMode): number {
  if (aim === "head") return 1.35;
  if (aim === "core") return 1.08;
  if (aim === "weakest") return 1.05;
  if (aim === "weapon" || aim === "mobility" || aim === "utility") return 0.92;
  return 1;
}

export function vulnerabilityMultiplier(entity: CombatEntity, part: DamagePart): number {
  if (part.role !== "core") return 1;
  const armorDestroyed = entity.parts.some((p) => p.role === "armor" && !isPartIntact(p));
  if (entity.kind === "tank" && armorDestroyed) return 1.35;
  if (entity.kind === "base" && armorDestroyed) return 1.25;
  return 1;
}

export function applyDamage(entity: CombatEntity, partId: string, amount: number): DamageResult {
  const target = findPart(entity, partId) ?? preferredPart(entity, "center");
  const beforeHp = target.hp;
  target.hp = Math.max(0, target.hp - Math.max(0, amount));
  const destroyed = beforeHp > 0 && target.hp === 0;
  const overflow = Math.max(0, amount - beforeHp);
  const wasAlive = entity.status.alive;

  recomputeStatus(entity);

  const messages: string[] = [];
  if (destroyed) {
    messages.push(`${entity.name}: ${target.label} destroyed`);
    if (target.role === "weapon") messages.push(`${entity.name} lost its weapon`);
    if (target.role === "mobility") messages.push(`${entity.name} is immobilized`);
    if (target.role === "armor") messages.push(`${entity.name}'s core is exposed`);
    if (target.role === "utility") messages.push(...utilityMessages(entity, target));
    if (target.role === "volatile") messages.push(`${entity.name} detonated`);
    if (target.critical && !entity.status.alive) messages.push(`${entity.name} killed by ${target.label}`);
  }

  return {
    entityId: entity.id,
    partId: target.id,
    amount: beforeHp - target.hp,
    overflow,
    destroyed,
    killed: wasAlive && !entity.status.alive,
    messages,
  };
}

export function repairForNewTurn(entity: CombatEntity): void {
  if (!entity.status.alive) {
    entity.commandPoints = 0;
    return;
  }
  entity.commandPoints = entity.status.commandLimited ? Math.max(1, entity.maxCommandPoints - 1) : entity.maxCommandPoints;
}

export function recomputeStatus(entity: CombatEntity): void {
  const destroyedCritical = entity.parts.find((p) => p.critical && !isPartIntact(p));
  const hasWeapon = entity.parts.some((p) => p.role === "weapon");
  const hasMobility = entity.parts.some((p) => p.role === "mobility");
  const intactWeapon = entity.parts.some((p) => p.role === "weapon" && isPartIntact(p));
  const allMobilityIntact = !hasMobility || entity.parts.every((p) => p.role !== "mobility" || isPartIntact(p));
  const armorDestroyed = entity.parts.some((p) => p.role === "armor" && !isPartIntact(p));
  const utilityDestroyed = entity.parts.filter((p) => p.role === "utility" && !isPartIntact(p));
  const turretLocked = entity.kind === "tank" && utilityDestroyed.some((p) => p.id === "turret");
  const packDown = isInfantryKind(entity.kind) && utilityDestroyed.some((p) => p.id === "pack");
  const commsDown = entity.kind === "base" && utilityDestroyed.some((p) => p.id === "comms");
  const alive = !destroyedCritical;

  entity.status.alive = alive;
  entity.status.deadReason = destroyedCritical ? destroyedCritical.label : undefined;
  entity.status.disarmed = alive && hasWeapon && (!intactWeapon || turretLocked);
  entity.status.immobilized = alive && hasMobility && !allMobilityIntact;
  entity.status.exposedCore = alive && armorDestroyed;
  entity.status.commandLimited = alive && (packDown || commsDown);
  entity.status.systemsDown = utilityDestroyed.map((p) => p.label);
  entity.status.canMove = alive && (isInfantryKind(entity.kind) || entity.kind === "tank") && allMobilityIntact;
  entity.status.canShoot = alive && hasWeapon && intactWeapon && !turretLocked && entity.kind !== "striker";

  if (!alive) {
    entity.commandPoints = 0;
    entity.status.canMove = false;
    entity.status.canShoot = false;
  }
  if (entity.kind === "base" || entity.kind === "cover") entity.status.canMove = false;
  if (entity.kind === "cover") entity.status.canShoot = false;
}

function utilityMessages(entity: CombatEntity, part: DamagePart): string[] {
  if (entity.kind === "tank" && part.id === "turret") return [`${entity.name}'s turret ring is jammed`];
  if (isInfantryKind(entity.kind) && part.id === "pack") return [`${entity.name}'s ${part.label.toLowerCase()} is ruptured`];
  if (entity.kind === "base" && part.id === "comms") return [`${entity.name}'s comms are down`];
  return [`${entity.name} lost ${part.label}`];
}

export function factionLiving(entities: readonly CombatEntity[], team: Team): CombatEntity[] {
  return entities.filter((e) => e.team === team && e.status.alive);
}

export function spendCommandPoint(entity: CombatEntity): boolean {
  if (!entity.status.alive || entity.commandPoints <= 0) return false;
  entity.commandPoints -= 1;
  return true;
}
