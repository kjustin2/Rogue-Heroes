import type { Vec2 } from "../core/math";
import type { EntityKind, GroundVehicleKind, InfantryKind } from "./units";
import { isAir, isGroundOrAirVehicle, isInfantry } from "./units";

// Entity kinds live in units.ts (pure data, no engine deps). Re-exported here so the ~40 modules
// that already import EntityKind from damageModel keep working unchanged.
export type { EntityKind } from "./units";

export type Team = "player" | "enemy" | "neutral";
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
  | "container"
  | "bunker"
  | "wreck"
  | "depot"
  | "span"
  | "gas"
  | "stump" | "log" | "bush" | "cactus" | "tent" | "pipe" | "silo" | "statue"
  // Biome props (2026-09-23): the furniture that says WHICH map this is, so no kind is shared by
  // accident (a Roman column in a foundry, a sandbag wall in a hay field).
  | "girder" | "coil" | "ingot" // Ironworks: steel column, coil on a cradle, billet stack
  | "haybale" | "fence" | "grave" // Verdant: round bales, split-rail fence, chapel-yard headstones
  | "boat" | "rack" | "iceblock" // Frozen Causeway: upturned boat, fish-drying rack, heaved ice
  | "obelisk" | "urn" | "brazier" // Karak: obelisk, amphorae, temple oil brazier (volatile)
  | "hedgehog" | "tower" // Crossfire: anti-tank hedgehog, border watchtower
  | "bones" // Dust Bowl: a bleached carcass
  // Landmarks (2026-09-20): each map's own big authored pieces — the things you point at.
  | "convoy" | "derrick" | "furnace" | "railcar" | "chapel" | "mill" | "hull" | "hut" | "colossus" | "cistern" | "gate" | "radar";
export type PartRole = "core" | "head" | "weapon" | "mobility" | "armor" | "utility" | "volatile";

const LANDMARK_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(["convoy", "derrick", "furnace", "railcar", "chapel", "mill", "hull", "hut", "colossus", "cistern", "gate", "radar"]);
/** A map landmark: authored at world scale, placed with an authored yaw, never jittered or re-spun. */
export function isLandmarkKind(kind: CoverKind | undefined): boolean {
  return kind !== undefined && LANDMARK_KINDS.has(kind);
}
/** Tall rigid cover that falls away from the killing blow and crushes what it lands on. */
const TOPPLE_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(["pillar", "tree", "girder", "obelisk", "tower"]);
export function isToppleKind(kind: CoverKind | undefined): boolean {
  return kind !== undefined && TOPPLE_KINDS.has(kind);
}
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
  // Anti-air: ×damage this weapon part deals to a FLYING target (1 = normal, <1 barely scratches
  // air, >1 = purpose-built AA). Only read when the target is flying.
  vsAir?: number;
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
  /**
   * Turn number until which this emplacement is browned out by a cut power conduit: it holds
   * position and keeps its armour but cannot shoot. Lives on the entity so it round-trips through
   * serialize() with everything else rather than needing a save field of its own.
   */
  poweredUntilTurn?: number;
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
  // Elites/bosses: tougher, gold-trimmed, tracked by the top-of-screen HP bar. Only debugSpawn
  // makes them since the campaign was cut -- kept for a future Skirmish set piece.
  elite?: boolean;
  bossName?: string;
  // Optional cosmetic accent (hex color) for the player's unit markings — purely visual.
  accent?: number;
  // Air layer: a flyer floats at terrain height + `agl` and ignores ground terrain/cover for
  // movement, forfeits terrain defense, and cannot capture. Undefined/false = a ground unit.
  flying?: boolean;
  agl?: number;
  // Air transport: units this aircraft is currently carrying (moved with it, hidden, inert). The
  // carried unit points back via `carriedById`. Both ride serialize() inside the entity list.
  passengerIds?: string[];
  carriedById?: string;
  // SUPPRESSED: a machine-gun burst that lands leaves the target with one command point next
  // turn and drops it to a crouch. Set to the turn it wears off; read at turn start.
  suppressedUntilTurn?: number;
  // HULL DOWN: a tank that did not move this resolve takes 30% less damage until it moves.
  hullDown?: boolean;
  // DUG IN (Bastion doctrine): a ground unit that held position through the last resolve takes
  // `dugIn` x damage from every source until it moves or is thrown. The multiplier itself, so
  // applyDamage needs no faction lookup and a restored save carries it.
  dugIn?: number;
  // DIGGING: held position through one resolve; if it holds through the next too it is dug in.
  digging?: boolean;
  // DEPLOYED (artillery): outriggers down. The gun only fires deployed; deploying costs a turn
  // (an explicit order, or automatically when it does not move), and moving undeploys it.
  deployed?: boolean;
  // MARKED (sniper): after a sniper fires at this unit, every other friendly shooter is more
  // accurate against it until the turn stamped here has passed.
  markedUntilTurn?: number;
  markedById?: string;
  // Who set this down (a sentry), for the log and pop-in.
  ownerTeam?: Team;
  /** A Mole Sapper under the ground (mid-move): not shot, not blocked, not drawn; it erupts when the move ends. */
  burrowed?: boolean;
  // A manned emplacement (gun post, mortar pit): the trooper crewing it. It fires only while crewed.
  occupantId?: string;
  // HOME BASE UPGRADES (see BASE_UPGRADES): armour level 0-2, the Fortress Cannon, the Watch Radar.
  armorLevel?: number;
  cannonReadyTurn?: number;
  radarOnline?: boolean;
  // BURNING (flamethrower, napalm, oil fire): infantry only. `dmg` to the body at the start of each of its next `turns` turns.
  /** On fire: turns left, damage a turn, and who lit it (credited with the burn, like any hit). */
  burning?: { turns: number; dmg: number; by?: string };
  // A sentry (set down by a Turret Tech or dropped): turns left before it packs up. It fires on its own each turn.
  sentryTtl?: number;
  // EMP: no actions for this entity until the turn stamped here has passed.
  disabledUntilTurn?: number;
  // FACTION TRAITS (factions.ts unitMods), stamped at deploy: the same Recruit is quicker for Vanguard and sturdier for Bastion.
  mods?: { hp?: number; move?: number; range?: number; damage?: number; grenades?: number };
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
  const defenseShooter = kind === "turret" || kind === "exturret" || kind === "bunker" || kind === "sentry";
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
  kind: Exclude<GroundVehicleKind, "flak">,
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
    // Radii cover the HULL's half-length (models.ts TARGET_SIZE / 2): a circle smaller than the
    // hull let tanks park inside crates and walls.
    radius: 1.6,
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

export function createRunabout(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createVehicle(id, name, "runabout", team, position, {
    radius: 1.2, height: 1.15, hullHp: 70, turretHp: 30, cannonHp: 24, treadHp: 30, frontHp: 26,
    hullLabel: "Chassis", turretLabel: "Gun Mount", cannonLabel: "Mounted MG",
  });
}

export function createHornet(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createVehicle(id, name, "hornet", team, position, {
    radius: 1.35, height: 1.3, hullHp: 78, turretHp: 38, cannonHp: 30, treadHp: 28, frontHp: 36,
    hullLabel: "Hull", turretLabel: "Turret Ring", cannonLabel: "Light Cannon",
  });
}

export function createArtillery(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createVehicle(id, name, "artillery", team, position, {
    radius: 1.75,
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

// Gunship: a flying attack craft. It floats at +agl, ignores ground terrain/cover for movement,
// forfeits all terrain defense, and CANNOT capture. It attacks in two modes (driven by the sim):
// its autocannon is air-to-air (strong vsAir; only fires on other flyers), and it carries bombs
// (modeled as grenades) it drops on GROUND spots with a visible blast radius. Deliberately fragile.
export function createGunship(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const entity: CombatEntity = {
    id,
    name,
    kind: "gunship",
    team,
    position,
    yaw: team === "player" ? Math.PI * 0.5 : -Math.PI * 0.5,
    radius: 1.15,
    height: 0.95,
    elevation: 0,
    stance: "standing",
    commandPoints: 2,
    maxCommandPoints: 2,
    grenades: 3, // bombs
    maxGrenades: 3,
    flying: true,
    agl: 6,
    status: statusFor("gunship"),
    parts: [
      part("hull", "Airframe", "core", 56, { critical: true }),
      part("rotor", "Rotor", "mobility", 26),
      part("gun", "Autocannon", "weapon", 30, { vsAir: 1.4 }),
      part("pack", "Bomb Rack", "volatile", 22),
    ],
  };
  recomputeStatus(entity);
  return entity;
}

// Bomber: a slow, tough heavy bomber. No gun at all — it only drops bombs (straight down), carries a
// big load, and soaks hits, and needs an escort.
export function createBomber(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const entity: CombatEntity = {
    id,
    name,
    kind: "bomber",
    team,
    position,
    yaw: team === "player" ? Math.PI * 0.5 : -Math.PI * 0.5,
    radius: 1.4,
    height: 1.05,
    elevation: 0,
    stance: "standing",
    commandPoints: 2,
    maxCommandPoints: 2,
    grenades: 4, // heavy bomb load
    maxGrenades: 4,
    flying: true,
    agl: 8,
    status: statusFor("bomber"),
    parts: [
      part("hull", "Fuselage", "core", 78, { critical: true }),
      part("engine", "Engines", "mobility", 32),
      part("pack", "Bomb Bay", "volatile", 30),
    ],
  };
  recomputeStatus(entity);
  return entity;
}


// Flak Track: the dedicated ground anti-air specialist — devastating vs flyers (high vsAir), long
// range so it blankets the air lane, but thin and weak against ground armor.
export function createFlak(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const entity: CombatEntity = {
    id,
    name,
    kind: "flak",
    team,
    position,
    yaw: team === "player" ? Math.PI * 0.5 : -Math.PI * 0.5,
    radius: 1.3,
    height: 1.5,
    elevation: 0,
    stance: "standing",
    commandPoints: 2,
    maxCommandPoints: 2,
    grenades: 0,
    maxGrenades: 0,
    status: statusFor("flak"),
    parts: [
      part("hull", "Chassis", "core", 76, { critical: true }),
      part("gun", "Flak Cannon", "weapon", 40, { vsAir: 2.4 }),
      part("left-tread", "Left Tread", "mobility", 30),
      part("right-tread", "Right Tread", "mobility", 30),
      part("radar", "Tracking Radar", "utility", 24),
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


export function createJumper(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "jumper", team, position, {
    radius: 0.58,
    height: 1.66,
    bodyHp: 38,
    headHp: 14,
    weaponHp: 18,
    legsHp: 22,
    packHp: 20,
    weaponLabel: "Jump Carbine",
    packLabel: "Jet Pack",
    packRole: "utility", // lose the pack and the jumps stop (see canJump)
    grenades: 1,
  });
}


export const createSledge = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "sledge", team, position, {
  radius: 0.7, height: 1.74, bodyHp: 40, headHp: 14, weaponHp: 22, legsHp: 22, packHp: 18, weaponLabel: "Sledgehammer", packLabel: "Counterweight", packRole: "utility", grenades: 0,
});
export const createIronclad = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "ironclad", team, position, {
  radius: 0.74, height: 1.7, bodyHp: 56, headHp: 20, weaponHp: 22, legsHp: 30, packHp: 34, weaponLabel: "Carbine", packLabel: "Tower Shield", packRole: "utility", grenades: 0,
});

// ROUND 6 (2026-10-06): the fun units.
export const createBreaker = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "breaker", team, position, {
  radius: 0.66, height: 1.72, bodyHp: 44, headHp: 15, weaponHp: 30, legsHp: 26, packHp: 22, weaponLabel: "Rocket Gauntlet", packLabel: "Thruster Pack", packRole: "utility", grenades: 0,
});
/** No gun at all: the Boomer's weapon is the barrel on its back (volatile: shoot it and it goes up where it stands). */
export function createBoomer(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const e = createInfantry(id, name, "boomer", team, position, {
    radius: 0.6, height: 1.5, bodyHp: 30, headHp: 12, weaponHp: 1, legsHp: 20, packHp: 16, weaponLabel: "Detonator", packLabel: "Barrel Charge", packRole: "volatile", grenades: 0,
  });
  e.parts = e.parts.filter((p) => p.role !== "weapon");
  recomputeStatus(e);
  return e;
}
export const createJuggernaut = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "juggernaut", team, position, {
  radius: 0.8, height: 1.84, bodyHp: 64, headHp: 22, weaponHp: 30, legsHp: 34, packHp: 30, weaponLabel: "Blast Cannon", packLabel: "Shell Hopper", packRole: "utility", grenades: 0,
});

// ROUND 7 (2026-10-07): the second fun audit.
export const createHookshot = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "hookshot", team, position, {
  radius: 0.62, height: 1.68, bodyHp: 40, headHp: 14, weaponHp: 24, legsHp: 24, packHp: 22, weaponLabel: "Harpoon Gun", packLabel: "Cable Reel", packRole: "utility", grenades: 0,
});
export const createSkater = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "skater", team, position, {
  radius: 0.58, height: 1.62, bodyHp: 36, headHp: 13, weaponHp: 16, legsHp: 24, packHp: 18, weaponLabel: "Carbine", packLabel: "Rocket Boots", packRole: "volatile", grenades: 0,
});
export const createMolotov = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "molotov", team, position, {
  radius: 0.6, height: 1.64, bodyHp: 38, headHp: 14, weaponHp: 18, legsHp: 22, packHp: 18, weaponLabel: "Fire Bottles", packLabel: "Bottle Crate", packRole: "volatile", grenades: 0,
});
export const createMole = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createInfantry(id, name, "mole", team, position, {
  radius: 0.64, height: 1.6, bodyHp: 46, headHp: 16, weaponHp: 18, legsHp: 26, packHp: 26, weaponLabel: "Sidearm", packLabel: "Drill Pack", packRole: "utility", grenades: 0,
});

export function createBazooka(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createInfantry(id, name, "bazooka", team, position, {
    radius: 0.66, height: 1.66, bodyHp: 42, headHp: 14, weaponHp: 26, legsHp: 22, packHp: 24,
    weaponLabel: "Rocket Launcher", packLabel: "Rocket Pack", packRole: "volatile", grenades: 0,
  });
}

function createInfantry(
  id: string,
  name: string,
  kind: InfantryKind,
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
  kind: "turret" | "exturret" | "bunker" | "sensor" | "wall" | "gunpost" | "mortarpit" | "rocketpost" | "flamepost" | "cannonpost" | "sentry",
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

// MANNED EMPLACEMENTS (2026-10-03): a weapon on a sandbag ring that acts only while a trooper crews it.
// Born uncrewed with no action points; the sim hands it one a turn while its crew stands beside it.
function createMount(id: string, name: string, kind: "gunpost" | "mortarpit" | "rocketpost" | "flamepost" | "cannonpost", team: Team, position: Vec2): CombatEntity {
  const gun = kind === "gunpost" ? "Heavy MG" : kind === "mortarpit" ? "Mortar Tube" : kind === "rocketpost" ? "Rocket Launcher" : kind === "cannonpost" ? "Field Gun" : "Flame Projector";
  const mount = createDefense(id, name, kind, team, position, {
    radius: 1.0,
    height: 1.0,
    canAct: true,
    parts: [
      part("ring", "Sandbag Ring", "core", 90, { critical: true }),
      part("gun", gun, "weapon", kind === "flamepost" ? 32 : 36),
    ],
  });
  mount.commandPoints = 0;
  return mount;
}
export const createGunPost = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createMount(id, name, "gunpost", team, position);
export const createMortarPit = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createMount(id, name, "mortarpit", team, position);
export const createRocketPost = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createMount(id, name, "rocketpost", team, position);
export const createCannonPost = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createMount(id, name, "cannonpost", team, position);
export const createFlamePost = (id: string, name: string, team: Team, position: Vec2): CombatEntity => createMount(id, name, "flamepost", team, position);

// A sentry: a small auto-turret a Turret Tech sets down. Light, fragile, fires by itself each turn.
export function createSentry(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  const sentry = createDefense(id, name, "sentry", team, position, {
    radius: 0.6,
    height: 1.0,
    canAct: true,
    parts: [
      part("mount", "Tripod", "core", 40, { critical: true }),
      part("gun", "Sentry Gun", "weapon", 22),
    ],
  });
  sentry.sentryTtl = 4;
  return sentry;
}

// A concrete machine-gun nest: low, wide and very tough; its gun pokes through a slit.
export function createBunker(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createDefense(id, name, "bunker", team, position, {
    radius: 1.2,
    height: 1.25,
    canAct: true,
    parts: [
      part("shell", "Concrete Shell", "core", 150, { critical: true }),
      part("gun", "Bunker MG", "weapon", 44),
    ],
  });
}

// A sensor mast: no gun. Its array is a spotter relay for every ally around it (sim reads the tag).
export function createSensor(id: string, name: string, team: Team, position: Vec2): CombatEntity {
  return createDefense(id, name, "sensor", team, position, {
    radius: 0.7,
    height: 3.2,
    canAct: false,
    parts: [
      part("mast", "Mast", "core", 70, { critical: true }),
      part("array", "Sensor Array", "utility", 30, { tags: ["spotter-aura"] }),
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
  gas: { hp: 28, radius: 0.7, height: 1.3, volatile: true, label: "Gas Canister" },
  // Theme props (2026-09-16): each map's own furniture, so a forest is not rocks and crates.
  stump: { hp: 60, radius: 0.7, height: 0.7, volatile: false, label: "Stump" },
  log: { hp: 44, radius: 1.3, height: 0.55, volatile: false, label: "Fallen Log" },
  bush: { hp: 18, radius: 0.85, height: 0.9, volatile: false, label: "Bush" },
  cactus: { hp: 26, radius: 0.5, height: 2.0, volatile: false, label: "Cactus" },
  tent: { hp: 30, radius: 1.2, height: 1.4, volatile: false, label: "Tent" },
  pipe: { hp: 80, radius: 1.4, height: 0.9, volatile: false, label: "Pipe Run" },
  silo: { hp: 130, radius: 1.1, height: 2.6, volatile: false, label: "Storage Silo" },
  statue: { hp: 110, radius: 0.8, height: 2.4, volatile: false, label: "Broken Statue" },
  // Biome props (2026-09-23). A tall one (girder, obelisk, tower) topples like a pillar; the brazier
  // is a fuel drum in temple dress: it bursts and leaves the ground burning.
  girder: { hp: 120, radius: 0.7, height: 2.6, volatile: false, label: "Steel Girder" },
  coil: { hp: 90, radius: 0.85, height: 1.1, volatile: false, label: "Steel Coil" },
  ingot: { hp: 80, radius: 0.9, height: 0.8, volatile: false, label: "Billet Stack" },
  haybale: { hp: 30, radius: 0.85, height: 1.0, volatile: false, label: "Hay Bales" },
  fence: { hp: 24, radius: 1.2, height: 0.9, volatile: false, label: "Field Fence" },
  grave: { hp: 50, radius: 0.75, height: 0.9, volatile: false, label: "Gravestones" },
  boat: { hp: 40, radius: 1.2, height: 0.8, volatile: false, label: "Upturned Boat" },
  rack: { hp: 28, radius: 1.0, height: 1.6, volatile: false, label: "Drying Rack" },
  iceblock: { hp: 70, radius: 0.95, height: 1.3, volatile: false, label: "Pressure Ice" },
  obelisk: { hp: 130, radius: 0.7, height: 3.0, volatile: false, label: "Obelisk" },
  urn: { hp: 30, radius: 0.7, height: 1.0, volatile: false, label: "Amphorae" },
  brazier: { hp: 30, radius: 0.6, height: 1.2, volatile: true, label: "Oil Brazier" },
  hedgehog: { hp: 110, radius: 0.8, height: 0.95, volatile: false, label: "Tank Trap" },
  tower: { hp: 90, radius: 1.0, height: 3.4, volatile: false, label: "Watchtower" },
  bones: { hp: 40, radius: 1.0, height: 0.8, volatile: false, label: "Bleached Bones" },
  // Landmarks (2026-09-20): one or two per map, placed as signature pieces. Radii cover the whole
  // footprint (a unit must never park inside a truck); the big ones are tough enough that they
  // shape the fight for its whole length rather than vanishing to the first mortar round.
  convoy: { hp: 90, radius: 2.0, height: 1.9, volatile: true, label: "Wrecked Truck" },
  derrick: { hp: 150, radius: 1.6, height: 4.5, volatile: false, label: "Derrick" },
  furnace: { hp: 320, radius: 2.6, height: 4.4, volatile: false, label: "Blast Furnace" },
  railcar: { hp: 130, radius: 1.9, height: 1.8, volatile: false, label: "Rail Car" },
  chapel: { hp: 300, radius: 2.4, height: 3.65, volatile: false, label: "Chapel Ruin" },
  mill: { hp: 180, radius: 1.9, height: 3.2, volatile: false, label: "Old Mill" },
  hull: { hp: 360, radius: 3.6, height: 4.2, volatile: false, label: "Beached Hull" },
  hut: { hp: 60, radius: 1.1, height: 1.9, volatile: false, label: "Fishing Hut" },
  colossus: { hp: 340, radius: 2.8, height: 1.7, volatile: false, label: "Fallen Colossus" },
  cistern: { hp: 200, radius: 2.1, height: 1.8, volatile: false, label: "Cistern" },
  gate: { hp: 170, radius: 2.3, height: 2.55, volatile: false, label: "Checkpoint Gate" },
  radar: { hp: 160, radius: 1.5, height: 3.5, volatile: false, label: "Radar Station" },
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
  // Shipping container: a long metal box — great line-of-sight blocker, fairly tough.
  container: { hp: 96, radius: 1.1, height: 1.55, volatile: false, label: "Shipping Container" },
  // Concrete bunker: low, wide, and very tough — a hard point to fight around, not through.
  bunker: { hp: 140, radius: 1.15, height: 1.05, volatile: false, label: "Bunker" },
  // Burnt-out vehicle hull left behind when armor dies: hard cover + a salvage prize.
  wreck: { hp: 70, radius: 1.05, height: 0.95, volatile: false, label: "Burnt Wreck" },
  // Capturable supply depot: pays income each turn to whichever team holds it.
  depot: { hp: 110, radius: 1.1, height: 1.4, volatile: false, label: "Supply Depot" },
  // A bridge span. Tough enough that dropping one is a deliberate investment rather than
  // incidental splash damage, and low enough that it never blocks a shot across the crossing it
  // carries. Destroying it removes the crossing for the rest of the battle.
  span: { hp: 150, radius: 1.0, height: 0.5, volatile: false, label: "Bridge Span" },
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

export function isInfantryKind(kind: EntityKind): boolean {
  return isInfantry(kind);
}

export function isVehicleKind(kind: EntityKind): boolean {
  // Aircraft are hard-surface vehicle chassis (they get vehicle move/shoot plumbing); flight is an
  // extra flag on the entity, not a separate class. So isAirKind is a SUBSET of isVehicleKind.
  return isGroundOrAirVehicle(kind);
}

// Air units. The `flying`/`agl` entity fields are authoritative at runtime; this is the by-kind
// default used when building a unit and when the sim needs the intent from the catalog.
export function isAirKind(kind: EntityKind): boolean {
  return isAir(kind);
}

// Infantry that fight in melee rather than with ranged weapons.
export function isPartIntact(part: DamagePart): boolean {
  return part.hp > 0;
}

export function findPart(entity: CombatEntity, partId: string): DamagePart | undefined {
  return entity.parts.find((p) => p.id === partId);
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
  if (entity.dugIn && amount > 0) amount = Math.max(1, Math.round(amount * entity.dugIn));
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
  if (entity.kind === "cover" || entity.kind === "wall") entity.status.canShoot = false;
  // The Home Base has no gun until it buys the Fortress Cannon (a "cannon" weapon part): then it can shoot like any other shooter.
  if (entity.kind === "base") entity.status.canShoot = alive && entity.parts.some((p) => p.id === "cannon" && isPartIntact(p));
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
/** A defense a trooper crews to make it fire: it acts only while someone stands at the gun. */
export function isMountKind(kind: string): boolean {
  return kind === "gunpost" || kind === "mortarpit" || kind === "rocketpost" || kind === "flamepost" || kind === "cannonpost";
}

export function isDefenseKind(kind: EntityKind): boolean {
  return kind === "turret" || kind === "exturret" || kind === "bunker" || kind === "sensor" || kind === "wall" || kind === "gunpost" || kind === "mortarpit" || kind === "rocketpost" || kind === "flamepost" || kind === "cannonpost" || kind === "sentry";
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
