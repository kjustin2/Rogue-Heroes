import type { Vec2 } from "../core/math";

export type Team = "player" | "enemy" | "neutral";
export type EntityKind =
  | "soldier"
  | "scout"
  | "sniper"
  | "striker"
  | "heavy"
  | "grenadier"
  | "mortar"
  | "medic"
  | "engineer"
  | "flamer"
  | "droneop"
  | "sapper"
  | "tank"
  | "apc"
  | "artillery"
  | "base"
  | "turret"
  | "exturret"
  | "wall"
  | "cover";
export type CoverKind =
  | "wall"
  | "barricade"
  | "fuel"
  | "ammo"
  | "conduit"
  | "ridge"
  | "cliff"
  | "rock"
  | "tree"
  | "crate"
  | "sandbag"
  | "rubble"
  | "pillar"
  | "wreck"
  | "depot";
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
  canProduce: boolean;
  equipmentOnline: boolean;
  upgradeOnline: boolean;
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
  grenades: number;
  maxGrenades: number;
  parts: DamagePart[];
  status: EntityStatus;
  // Home Base economy state (only set on `base` entities).
  incomeLevel?: number;
  unlockedTech?: string[];
  spawnCooldowns?: Partial<Record<EntityKind, number>>;
  // Rounds until each off-map support power can be called again (Home Base only).
  supportCooldowns?: Partial<Record<string, number>>;
  // Neutral field structures (derelict turrets, supply depots) that flip to the team
  // with units standing beside them at the start of a turn.
  capturable?: boolean;
  // Campaign elites/bosses: tougher, gold-trimmed, and tracked by the top-of-screen HP bar.
  elite?: boolean;
  bossName?: string;
  // Optional cosmetic accent (hex color) for the player's unit markings — purely visual.
  accent?: number;
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
  const defenseShooter = kind === "turret" || kind === "exturret";
  return {
    alive: true,
    canMove: isInfantryKind(kind) || isVehicleKind(kind),
    canShoot: (isInfantryKind(kind) && kind !== "striker") || isVehicleKind(kind) || defenseShooter,
    immobilized: false,
    disarmed: false,
    exposedCore: false,
    commandLimited: false,
    canProduce: kind === "base",
    equipmentOnline: true,
    upgradeOnline: true,
    systemsDown: [],
  };
}

function createVehicle(
  id: string,
  name: string,
  kind: "tank" | "apc" | "artillery",
  team: Team,
  position: Vec2,
  config: {
    radius: number;
    height: number;
    hullHp: number;
    turretHp: number;
    cannonHp: number;
    treadHp: number;
    frontHp: number;
    hullLabel: string;
    turretLabel: string;
    cannonLabel: string;
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
    grenades: 0,
    maxGrenades: 0,
    status: statusFor(kind),
    parts: [
      part("hull", config.hullLabel, "core", config.hullHp, { critical: true }),
      part("turret", config.turretLabel, "utility", config.turretHp),
      part("cannon", config.cannonLabel, "weapon", config.cannonHp),
      part("left-tread", "Left Tread", "mobility", config.treadHp),
      part("right-tread", "Right Tread", "mobility", config.treadHp),
      part("front-plate", "Front Plate", "armor", config.frontHp),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

export function createTank(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createVehicle(id, name, "tank", team, position, {
    radius: 1.45,
    height: 1.55,
    hullHp: 120,
    turretHp: 55,
    cannonHp: 42,
    treadHp: 34,
    frontHp: 70,
    hullLabel: "Hull",
    turretLabel: "Turret Ring",
    cannonLabel: "Cannon",
  });
}

export function createApc(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createVehicle(id, name, "apc", team, position, {
    radius: 1.25,
    height: 1.4,
    hullHp: 92,
    turretHp: 40,
    cannonHp: 32,
    treadHp: 40,
    frontHp: 48,
    hullLabel: "Chassis",
    turretLabel: "Cupola",
    cannonLabel: "Autogun",
  });
}

export function createArtillery(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createVehicle(id, name, "artillery", team, position, {
    radius: 1.4,
    height: 1.5,
    hullHp: 86,
    turretHp: 44,
    cannonHp: 50,
    treadHp: 28,
    frontHp: 40,
    hullLabel: "Carriage",
    turretLabel: "Traverse Ring",
    cannonLabel: "Siege Gun",
  });
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
    grenades: 2,
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
    grenades: 0,
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
    grenades: 0,
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
    grenades: 0,
  });
}

export function createScout(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "scout", team, position, {
    radius: 0.55,
    height: 1.6,
    bodyHp: 34,
    headHp: 12,
    weaponHp: 16,
    legsHp: 22,
    packHp: 16,
    weaponLabel: "Carbine",
    packLabel: "Recon Optics",
    packRole: "utility",
    packTags: ["spotter-aura"],
    grenades: 0,
  });
}

export function createHeavy(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "heavy", team, position, {
    radius: 0.74,
    height: 1.72,
    bodyHp: 78,
    headHp: 18,
    weaponHp: 34,
    legsHp: 30,
    packHp: 26,
    weaponLabel: "Auto-Cannon",
    packLabel: "Ammo Drum",
    packRole: "volatile",
    grenades: 0,
  });
}

export function createMortar(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "mortar", team, position, {
    radius: 0.72,
    height: 1.6,
    bodyHp: 44,
    headHp: 15,
    weaponHp: 26,
    legsHp: 24,
    packHp: 26,
    weaponLabel: "Mortar Tube",
    packLabel: "Shell Rack",
    packRole: "volatile",
    grenades: 0,
  });
}

export function createMedic(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "medic", team, position, {
    radius: 0.62,
    height: 1.64,
    bodyHp: 44,
    headHp: 15,
    weaponHp: 16,
    legsHp: 24,
    packHp: 24,
    weaponLabel: "Sidearm",
    packLabel: "Med Kit",
    packRole: "utility",
    packTags: ["medic-aura"],
    grenades: 0,
  });
}

export function createFlamer(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "flamer", team, position, {
    radius: 0.66,
    height: 1.64,
    bodyHp: 52,
    headHp: 15,
    weaponHp: 20,
    legsHp: 26,
    packHp: 24,
    weaponLabel: "Flame Projector",
    packLabel: "Fuel Tanks",
    packRole: "volatile", // shoot the tanks and the flamer goes up
    grenades: 0,
  });
}

export function createDroneOp(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "droneop", team, position, {
    radius: 0.62,
    height: 1.64,
    bodyHp: 42,
    headHp: 15,
    weaponHp: 16,
    legsHp: 24,
    packHp: 26,
    weaponLabel: "Machine Pistol",
    packLabel: "Recon Drone",
    packRole: "utility",
    packTags: ["spotter-aura"], // the hovering drone spots for everyone nearby
    grenades: 0,
  });
}

export function createSapper(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "sapper", team, position, {
    radius: 0.64,
    height: 1.64,
    bodyHp: 46,
    headHp: 15,
    weaponHp: 18,
    legsHp: 24,
    packHp: 24,
    weaponLabel: "Demo Launcher",
    packLabel: "Mine Satchel",
    packRole: "utility",
    grenades: 0,
  });
}

export function createEngineer(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "engineer", team, position, {
    radius: 0.64,
    height: 1.64,
    bodyHp: 46,
    headHp: 15,
    weaponHp: 18,
    legsHp: 24,
    packHp: 26,
    weaponLabel: "Repair Gun",
    packLabel: "Tool Rig",
    packRole: "utility",
    packTags: ["repair-aura", "support-aura"],
    grenades: 0,
  });
}

function createInfantry(
  id: string,
  name: string,
  kind: "soldier" | "scout" | "sniper" | "striker" | "heavy" | "grenadier" | "mortar" | "medic" | "engineer" | "flamer" | "droneop" | "sapper",
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
    grenades?: number;
  }
): CombatEntity {
  const grenades = config.grenades ?? 0;
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
    grenades,
    maxGrenades: grenades,
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
    grenades: 0,
    maxGrenades: 0,
    incomeLevel: 0,
    unlockedTech: [],
    spawnCooldowns: {},
    status: statusFor("base"),
    parts: [
      // A Home Base earns money and deploys troops; it carries no weapon.
      part("core", "Command Core", "core", 160, { critical: true }),
      part("comms", "Comms Mast", "utility", 35),
      part("power", "Reactor Core", "volatile", 50),
      part("gate", "Blast Gate", "armor", 80),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

// ---- Buildable defensive structures: stationary, base-owned, balanced cost ----

function createDefense(
  id: string,
  name: string,
  kind: "turret" | "exturret" | "wall",
  team: Team,
  position: Vec2,
  config: { radius: number; height: number; parts: DamagePart[]; canAct: boolean }
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
    commandPoints: config.canAct ? 1 : 0,
    maxCommandPoints: config.canAct ? 1 : 0,
    grenades: 0,
    maxGrenades: 0,
    status: statusFor(kind),
    parts: config.parts,
  };
  recomputeStatus(entity);
  return entity;
}

// A static gun emplacement: shoots, cannot move.
export function createTurret(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createDefense(id, name, "turret", team, position, {
    radius: 0.95,
    height: 1.55,
    canAct: true,
    parts: [
      part("mount", "Turret Base", "core", 86, { critical: true }),
      part("gun", "Auto-Cannon", "weapon", 40),
      part("sensor", "Targeting Array", "utility", 26),
    ],
  });
}

// A static explosive battery: lobs splash shells, cannot move, blows up when its magazine goes.
export function createExTurret(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createDefense(id, name, "exturret", team, position, {
    radius: 1.0,
    height: 1.6,
    canAct: true,
    parts: [
      part("mount", "Battery Base", "core", 92, { critical: true }),
      part("gun", "Mortar Battery", "weapon", 44),
      part("ammo", "Shell Magazine", "volatile", 30),
    ],
  });
}

// A tall blast wall: tall enough to block a shot at the base; carries no weapon and never moves.
export function createWall(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createDefense(id, name, "wall", team, position, {
    radius: 1.15,
    height: 2.65,
    canAct: false,
    parts: [part("barrier", "Blast Wall", "core", 150, { critical: true })],
  });
}

interface CoverProfile {
  hp: number;
  radius: number;
  height: number;
  volatile: boolean;
  label: string;
}

export const COVER_PROFILES: Record<CoverKind, CoverProfile> = {
  wall: { hp: 70, radius: 1.05, height: 1.55, volatile: false, label: "Wall Block" },
  barricade: { hp: 42, radius: 0.82, height: 0.82, volatile: false, label: "Barricade" },
  fuel: { hp: 36, radius: 0.7, height: 1.2, volatile: true, label: "Fuel Cell" },
  ammo: { hp: 34, radius: 0.7, height: 1.2, volatile: true, label: "Ammo Cache" },
  conduit: { hp: 44, radius: 0.7, height: 1.2, volatile: true, label: "Power Conduit" },
  ridge: { hp: 95, radius: 1.2, height: 1.85, volatile: false, label: "High Ground" },
  cliff: { hp: 160, radius: 1.28, height: 2.15, volatile: false, label: "Cliff Face" },
  rock: { hp: 90, radius: 1.0, height: 1.25, volatile: false, label: "Boulder" },
  tree: { hp: 48, radius: 0.66, height: 2.2, volatile: false, label: "Tree" },
  crate: { hp: 40, radius: 0.78, height: 0.95, volatile: false, label: "Crate Stack" },
  sandbag: { hp: 54, radius: 0.95, height: 0.72, volatile: false, label: "Sandbag Wall" },
  rubble: { hp: 66, radius: 1.0, height: 0.9, volatile: false, label: "Rubble Pile" },
  pillar: { hp: 120, radius: 0.7, height: 2.6, volatile: false, label: "Stone Pillar" },
  // Burnt-out vehicle hull left behind when armor dies: hard cover + a salvage prize.
  wreck: { hp: 70, radius: 1.05, height: 0.95, volatile: false, label: "Burnt Wreck" },
  // Capturable supply depot: pays income each turn to whichever team holds it.
  depot: { hp: 110, radius: 1.1, height: 1.4, volatile: false, label: "Supply Depot" },
};

export function createCover(id: string, name: string, position: Vec2, options: boolean | CoverOptions = false): CombatEntity {
  const settings: CoverOptions = typeof options === "boolean" ? { volatile: options } : options;
  const coverKind = settings.coverKind ?? (settings.volatile ? "fuel" : name.toLowerCase().includes("barricade") ? "barricade" : "wall");
  const profile = COVER_PROFILES[coverKind];
  const volatile = Boolean(settings.volatile || profile.volatile);
  const hp = settings.hp ?? profile.hp;
  const highGround = coverKind === "ridge" || coverKind === "cliff";
  const entity: CombatEntity = {
    id,
    name,
    kind: "cover",
    coverKind,
    team: "neutral",
    position,
    yaw: 0,
    radius: settings.radius ?? profile.radius,
    height: settings.height ?? profile.height,
    elevation: 0,
    stance: "standing",
    commandPoints: 0,
    maxCommandPoints: 0,
    grenades: 0,
    maxGrenades: 0,
    status: statusFor("cover"),
    parts: [
      part(volatile ? "cell" : "wall", volatile ? profile.label : profile.label, volatile ? "volatile" : "core", hp, {
        critical: true,
        tags: highGround ? ["high-ground"] : undefined,
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
    spawnCooldowns: entity.spawnCooldowns ? { ...entity.spawnCooldowns } : undefined,
    parts: entity.parts.map((p) => ({ ...p, tags: p.tags ? [...p.tags] : undefined })),
  };
}

export function isInfantryKind(kind: EntityKind): boolean {
  return (
    kind === "soldier" ||
    kind === "scout" ||
    kind === "sniper" ||
    kind === "striker" ||
    kind === "heavy" ||
    kind === "grenadier" ||
    kind === "mortar" ||
    kind === "medic" ||
    kind === "engineer" ||
    kind === "flamer" ||
    kind === "droneop" ||
    kind === "sapper"
  );
}

export function isVehicleKind(kind: EntityKind): boolean {
  return kind === "tank" || kind === "apc" || kind === "artillery";
}

// Infantry that fight in melee rather than with ranged weapons.
export function isMeleeKind(kind: EntityKind): boolean {
  return kind === "striker";
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
  if (isVehicleKind(entity.kind) && armorDestroyed) return 1.35;
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
  const turretLocked = isVehicleKind(entity.kind) && utilityDestroyed.some((p) => p.id === "turret");
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
  entity.status.canMove = alive && (isInfantryKind(entity.kind) || isVehicleKind(entity.kind)) && allMobilityIntact;
  entity.status.canShoot = alive && hasWeapon && intactWeapon && !turretLocked && entity.kind !== "striker";

  if (!alive) {
    entity.commandPoints = 0;
    entity.status.canMove = false;
    entity.status.canShoot = false;
  }
  // Structures never move; the Home Base, walls, and cover carry no weapon.
  if (isStructureKind(entity.kind)) entity.status.canMove = false;
  if (entity.kind === "base" || entity.kind === "cover" || entity.kind === "wall") {
    entity.status.canShoot = false;
  }
  if (entity.kind === "base") {
    // The base can deploy troops while alive; its income scales with reactor health
    // (see generatorEfficiency in sim.ts).
    entity.status.canProduce = alive;
  }
}

export function isStructureKind(kind: EntityKind): boolean {
  return kind === "base" || kind === "cover" || isDefenseKind(kind);
}

export function isBuildingKind(kind: EntityKind): boolean {
  return kind === "base";
}

// Player/enemy-built defensive emplacements (turret, explosive turret, wall).
export function isDefenseKind(kind: EntityKind): boolean {
  return kind === "turret" || kind === "exturret" || kind === "wall";
}

function utilityMessages(entity: CombatEntity, part: DamagePart): string[] {
  if (isVehicleKind(entity.kind) && part.id === "turret") return [`${entity.name}'s turret ring is jammed`];
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
