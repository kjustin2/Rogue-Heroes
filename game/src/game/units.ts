// Catalog of every troop the Home Base can deploy. Data only — no engine dependencies.

// THE single source of truth for entity kinds. damageModel re-exports EntityKind, so there is one
// list, not four (TroopKind, EntityKind, and the two inline unions in the create* factories used to
// drift independently — a missed list was a silent runtime fallthrough, now it is a compile error).
export type InfantryKind =
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
  | "sapper";

export type GroundVehicleKind = "tank" | "apc" | "artillery" | "flak";

export type AirKind = "gunship" | "interceptor" | "bomber" | "transport";

/** Everything the Home Base can deploy onto the field. */
export type TroopKind = InfantryKind | GroundVehicleKind | AirKind;

/** Emplacements and scenery: never deployed as troops, but they are damageable entities. */
export type StructureKind = "base" | "turret" | "exturret" | "wall" | "cover";

/** Every kind that can exist as a CombatEntity. */
export type EntityKind = TroopKind | StructureKind;

// Runtime membership, kept exhaustive BY THE COMPILER: Record<K, true> rejects both a missing
// member and a stray one, so these can never drift from the unions above the way the hand-written
// `kind === "a" || kind === "b" || ...` predicates used to.
const INFANTRY_SET: Record<InfantryKind, true> = {
  soldier: true, scout: true, sniper: true, striker: true, heavy: true, grenadier: true,
  mortar: true, medic: true, engineer: true, flamer: true, droneop: true, sapper: true,
};
const GROUND_VEHICLE_SET: Record<GroundVehicleKind, true> = { tank: true, apc: true, artillery: true, flak: true };
const AIR_SET: Record<AirKind, true> = { gunship: true, interceptor: true, bomber: true, transport: true };

export const INFANTRY_KINDS = Object.keys(INFANTRY_SET) as readonly InfantryKind[];
export const GROUND_VEHICLE_KINDS = Object.keys(GROUND_VEHICLE_SET) as readonly GroundVehicleKind[];
export const AIR_KINDS = Object.keys(AIR_SET) as readonly AirKind[];
export const TROOP_KINDS: readonly TroopKind[] = [...INFANTRY_KINDS, ...GROUND_VEHICLE_KINDS, ...AIR_KINDS];

export const isInfantry = (kind: EntityKind): boolean => kind in INFANTRY_SET;
/** Aircraft ride the vehicle chassis plumbing; flight is an extra flag, not a separate class. */
export const isGroundOrAirVehicle = (kind: EntityKind): boolean => kind in GROUND_VEHICLE_SET || kind in AIR_SET;
export const isAir = (kind: EntityKind): boolean => kind in AIR_SET;

// ---- Per-kind combat statistics. ----
//
// These used to be ~13 separate `if (kind === "x") return N;` ladders at the bottom of sim.ts.
// Collapsed here so a unit is described in ONE place and a faction roster can be reasoned about as
// data. The sim's ladder functions are now one-line lookups into this table; their signatures and
// values are unchanged.
//
// Deliberately NOT here: defenseRadius (keyed by DefenseKind), explosive blast / arc / proximity
// (keyed by ProjectileKind), and muzzle geometry (structured by movement class with two overrides,
// not a per-kind ladder). Tabling those would widen the record without making it more useful.

export type ProjectileKind = "rifle" | "shell" | "bolt" | "grenade";

export interface UnitStats {
  /** Board distance per order, before MOVE_RANGE_SCALE. 0 = immobile. */
  moveRange: number;
  /** World units per second while resolving a move, before MOVE_RANGE_SCALE. */
  moveSpeed: number;
  shotDamage: number;
  weaponRange: number;
  projectile: ProjectileKind;
  projectileSpeed: number;
  /** Rounds per shoot order. Only the heavy gunner sprays. */
  burst: number;
  /** Base cone in degrees before range, stance, cover and tech modifiers. */
  spread: number;
  /** Metres of range that cost no extra spread; past this, spreadPerMeter applies. */
  spreadStart: number;
  spreadPerMeter: number;
  accuracyLabel: string;
  /** 0 = cannot melee. */
  meleeRange: number;
  /** Strikers hit at full power; other infantry rifle-butt for a fraction. */
  meleeMultiplier: number;
  /** 0 = cannot ram. */
  ramRange: number;
  /** Hand-grenade throw or straight-down bomb reach. 0 = neither. */
  grenadeRange: number;
  /** Weapon can be aimed at a bare ground spot (explosive direct/indirect fire). */
  groundShell: boolean;
  /** Durability tier applied to every part at creation. */
  hpMultiplier: number;
  /** How badly the AI wants to shoot this. 4 is the neutral middle, not 0. */
  aiValue: number;
}

// Fallthrough values from the old ladders' trailing `return`s. Infantry mobility is a class default
// (6.7 / 6.5) rather than a global one, so it is spelled out per infantry entry below.
const UNIT_DEFAULTS: UnitStats = {
  moveRange: 0,
  moveSpeed: 0,
  shotDamage: 31,
  weaponRange: 26,
  projectile: "rifle",
  projectileSpeed: 3.2,
  burst: 1,
  spread: 2.15,
  spreadStart: 9,
  spreadPerMeter: 0.07,
  accuracyLabel: "rifle",
  meleeRange: 0,
  meleeMultiplier: 0.5,
  ramRange: 0,
  grenadeRange: 0,
  groundShell: false,
  hpMultiplier: 1,
  aiValue: 0,
};

const u = (overrides: Partial<UnitStats>): UnitStats => ({ ...UNIT_DEFAULTS, ...overrides });
/** Every infantry kind shares mobility and bayonet reach unless it overrides them. */
const foot = (overrides: Partial<UnitStats>): UnitStats => u({ moveRange: 6.7, moveSpeed: 6.5, meleeRange: 0.5, ...overrides });

export const UNIT_STATS: Record<EntityKind, UnitStats> = {
  // --- Infantry ---
  soldier: foot({ shotDamage: 31, grenadeRange: 9.2, aiValue: 4 }),
  scout: foot({ moveRange: 11.5, moveSpeed: 11.8, shotDamage: 22, weaponRange: 22, spread: 3.0, spreadPerMeter: 0.12, accuracyLabel: "carbine", aiValue: 6 }),
  sniper: foot({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 40, weaponRange: 34, projectileSpeed: 3.8, spread: 0.22, spreadStart: 12, spreadPerMeter: 0.09, accuracyLabel: "marksman", aiValue: 8 }),
  striker: foot({ moveRange: 10.8, moveSpeed: 11.5, shotDamage: 24, accuracyLabel: "sidearm", meleeRange: 0.72, meleeMultiplier: 1, aiValue: 5 }),
  heavy: foot({ moveRange: 4.8, moveSpeed: 4.8, shotDamage: 18, burst: 4, spread: 3.6, spreadPerMeter: 0.16, accuracyLabel: "auto-cannon", hpMultiplier: 1.18, aiValue: 5 }),
  grenadier: foot({ moveRange: 6.3, moveSpeed: 5.8, shotDamage: 38, weaponRange: 22, projectile: "grenade", projectileSpeed: 2.05, spread: 7.4, accuracyLabel: "launcher", groundShell: true, aiValue: 7 }),
  mortar: foot({ moveRange: 5.0, moveSpeed: 5.2, shotDamage: 44, weaponRange: 30, projectile: "grenade", projectileSpeed: 2.05, spread: 7.0, spreadStart: 20, accuracyLabel: "mortar", groundShell: true, hpMultiplier: 1.12, aiValue: 8 }),
  medic: foot({ moveRange: 6.4, moveSpeed: 6.4, shotDamage: 18, weaponRange: 18, aiValue: 8 }),
  engineer: foot({ moveRange: 5.8, moveSpeed: 5.8, shotDamage: 18, weaponRange: 18, aiValue: 7 }),
  flamer: foot({ shotDamage: 34, weaponRange: 7.5, aiValue: 4 }),
  droneop: foot({ shotDamage: 16, weaponRange: 16, aiValue: 4 }),
  sapper: foot({ shotDamage: 26, weaponRange: 14, aiValue: 4 }),

  // --- Ground vehicles ---
  tank: u({ moveRange: 5.4, moveSpeed: 5.5, shotDamage: 66, weaponRange: 28, projectile: "shell", projectileSpeed: 2.45, spread: 2.65, spreadStart: 14, accuracyLabel: "stabilized cannon", ramRange: 2.85, groundShell: true, hpMultiplier: 1.3, aiValue: 3 }),
  apc: u({ moveRange: 7.2, moveSpeed: 7.4, shotDamage: 30, weaponRange: 24, projectile: "bolt", projectileSpeed: 2.8, spread: 3.1, accuracyLabel: "autogun", hpMultiplier: 1.16, aiValue: 3 }),
  artillery: u({ moveRange: 3.6, moveSpeed: 3.8, shotDamage: 78, weaponRange: 42, projectile: "shell", projectileSpeed: 2.45, spread: 5.4, spreadStart: 20, accuracyLabel: "siege gun", groundShell: true, hpMultiplier: 1.2, aiValue: 9 }),
  flak: u({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 16, weaponRange: 32, projectile: "bolt", accuracyLabel: "flak cannon", aiValue: 6 }),

  // --- Aircraft. Guns are air-to-air; bombs use the grenade path and fall straight down. ---
  gunship: u({ moveRange: 12.5, moveSpeed: 9.5, shotDamage: 22, weaponRange: 22, projectile: "bolt", accuracyLabel: "gunship autocannon", grenadeRange: 11, aiValue: 8 }),
  interceptor: u({ moveRange: 14, moveSpeed: 11.5, shotDamage: 26, projectile: "bolt", accuracyLabel: "interceptor cannon", aiValue: 4 }),
  bomber: u({ moveRange: 8, moveSpeed: 6.4, grenadeRange: 12, aiValue: 4 }),
  transport: u({ moveRange: 11, moveSpeed: 8.5, aiValue: 4 }),

  // --- Structures and scenery ---
  base: u({ shotDamage: 42, weaponRange: 30, projectile: "bolt", projectileSpeed: 2.8, spread: 1.25, accuracyLabel: "command relay", aiValue: 6 }),
  turret: u({ shotDamage: 30, weaponRange: 24, projectile: "bolt", projectileSpeed: 2.8, spread: 2.3, spreadPerMeter: 0.05, accuracyLabel: "turret autogun", aiValue: 4 }),
  exturret: u({ shotDamage: 58, projectile: "shell", projectileSpeed: 2.45, spread: 4.6, spreadStart: 20, accuracyLabel: "mortar battery", groundShell: true, hpMultiplier: 1.25, aiValue: 5 }),
  wall: u({ aiValue: 1 }),
  cover: u({}),
};

export function unitStats(kind: EntityKind): UnitStats {
  return UNIT_STATS[kind];
}

export interface TroopSpec {
  kind: TroopKind;
  label: string;
  role: string;
  cost: number;
  cooldown: number; // rounds before this troop type can be deployed again
  tech?: string; // tech node id that unlocks it (undefined = available from the start)
  tip: string;
}

export const TROOP_CATALOG: readonly TroopSpec[] = [
  { kind: "soldier", label: "Recruit", role: "Rifle", cost: 150, cooldown: 1, tip: "Versatile rifle infantry with hand grenades. Always available." },
  { kind: "scout", label: "Scout", role: "Recon", cost: 110, cooldown: 1, tech: "recon", tip: "Fast, cheap eyes; its optic relay sharpens nearby allies' fire." },
  { kind: "sniper", label: "Marksman", role: "Sniper", cost: 220, cooldown: 2, tech: "recon", tip: "Long-range precision; deadly to heads and exposed crews." },
  { kind: "striker", label: "Striker", role: "Melee", cost: 180, cooldown: 2, tech: "assault", tip: "Rushes in and strikes hard at close range." },
  { kind: "heavy", label: "Heavy Gunner", role: "Gunner", cost: 250, cooldown: 2, tech: "assault", tip: "Tough, hard-hitting infantry that anchors a push." },
  { kind: "grenadier", label: "Grenadier", role: "Splash", cost: 250, cooldown: 3, tech: "ordnance", tip: "Arcing launcher with splash that clears cover and clusters." },
  { kind: "mortar", label: "Mortar Team", role: "Indirect", cost: 300, cooldown: 3, tech: "ordnance", tip: "High-arc indirect fire that reaches over walls and ridges; hits hard and takes a beating." },
  { kind: "medic", label: "Medic", role: "Support", cost: 180, cooldown: 2, tech: "support", tip: "Field aura that heals wounded infantry near it each round." },
  { kind: "engineer", label: "Engineer", role: "Support", cost: 200, cooldown: 2, tech: "support", tip: "Repairs nearby vehicles and the Home Base, and its fire-control rig boosts nearby allies' damage." },
  { kind: "droneop", label: "Drone Operator", role: "Recon", cost: 210, cooldown: 2, tech: "support", tip: "Fields a hovering recon drone whose optics sharpen nearby allies' fire. Lightly armed." },
  { kind: "flamer", label: "Flamer", role: "Burn", cost: 260, cooldown: 2, tech: "ordnance", tip: "Short-range flame projector. Every hit leaves burning ground for 2 turns — crouching won't help, RUN. Shoot its fuel tanks at your peril." },
  { kind: "sapper", label: "Sapper", role: "Demo", cost: 240, cooldown: 2, tech: "ordnance", tip: "Plants proximity mines ($15 each) and fires demolition rounds that hit cover and walls 3x harder — fell pillars onto the enemy." },
  { kind: "tank", label: "Tank", role: "Armor", cost: 400, cooldown: 3, tech: "armor", tip: "Heavily armored bruiser: massive HP, big gun, and can ram and crush cover." },
  { kind: "apc", label: "APC", role: "Vehicle", cost: 250, cooldown: 2, tech: "armor", tip: "Fast armored flanker; durable and quick, shrugs off small arms." },
  { kind: "artillery", label: "Artillery", role: "Siege", cost: 440, cooldown: 4, tech: "siege", tip: "Long-range siege gun; devastating at distance and tough, but helpless up close." },
  { kind: "flak", label: "Flak Track", role: "Anti-Air", cost: 260, cooldown: 2, tech: "armor", tip: "Dedicated anti-air: shreds aircraft at long range and its overwatch cone blankets the air lane. Weak against ground armor — it's a specialist, not a brawler." },
  { kind: "gunship", label: "Gunship", role: "Air", cost: 400, cooldown: 3, tech: "airwing", tip: "Fast flyer: overflies all terrain and cover. Its autocannon duels other aircraft; it drops bombs straight down on ground targets (fly over them, blast radius shown). Fragile — one flak burst threatens it — and it cannot capture." },
  { kind: "interceptor", label: "Interceptor", role: "Air Superiority", cost: 320, cooldown: 2, tech: "airwing", tip: "Fast, gun-only fighter that rules the air — its cannon shreds other aircraft. No bombs; it exists to win the dogfight. Fragile to ground flak." },
  { kind: "bomber", label: "Bomber", role: "Heavy Bomber", cost: 470, cooldown: 4, tech: "airwing", tip: "Slow, tough heavy bomber with a big bomb load (drops straight down). No gun at all — helpless against interceptors, so send an escort." },
  { kind: "transport", label: "Transport", role: "Airlift", cost: 240, cooldown: 3, tech: "airwing", tip: "Unarmed helicopter that airlifts friendly ground units: Load one nearby, fly it across the map, and Unload it anywhere. Overflies everything; if it's shot down, its passengers fall out where it dies." },
];

export function troopSpec(kind: TroopKind): TroopSpec {
  return TROOP_CATALOG.find((spec) => spec.kind === kind) ?? TROOP_CATALOG[0];
}

// ---- Buildable base defenses. Placed near the Home Base; balanced for cost. ----

export type DefenseKind = "turret" | "wall" | "exturret";

export interface DefenseSpec {
  kind: DefenseKind;
  label: string;
  role: string;
  cost: number;
  tip: string;
}

export const DEFENSE_CATALOG: readonly DefenseSpec[] = [
  { kind: "wall", label: "Blast Wall", role: "Barrier", cost: 130, tip: "Tall, tough barrier that blocks shots aimed at your base. Cannot be walked or built through." },
  { kind: "turret", label: "Gun Turret", role: "Defense", cost: 210, tip: "Stationary auto-cannon. Fires each turn for 1 CP; solid range and accuracy, but cannot move." },
  { kind: "exturret", label: "Mortar Turret", role: "Siege", cost: 360, tip: "Heavy stationary splash battery: hits much harder than a gun turret and soaks far more punishment. Lobs explosive shells that clear cover and clusters; detonates if its magazine is hit." },
];

export function defenseSpec(kind: DefenseKind): DefenseSpec {
  return DEFENSE_CATALOG.find((spec) => spec.kind === kind) ?? DEFENSE_CATALOG[0];
}

// ---- Off-map support powers the Home Base can call in (cost money + the base CP). ----

export type SupportPowerKind = "airstrike" | "cluster" | "laser";

export interface SupportPowerSpec {
  kind: SupportPowerKind;
  label: string;
  role: string;
  cost: number;
  cooldown: number; // rounds before this power can be called again
  tech?: string; // tech node id that unlocks it (undefined = available from the start)
  tip: string;
}

export const SUPPORT_POWERS: readonly SupportPowerSpec[] = [
  { kind: "airstrike", label: "Airstrike", role: "Line", cost: 320, cooldown: 3, tip: "A strike wing carpets a line of bombs through the target point, aligned away from your base. Hardened HQs are unaffected." },
  { kind: "cluster", label: "Cluster Strike", role: "Area", cost: 300, cooldown: 3, tech: "ordnance", tip: "Bomblets saturate a wide area around the target point. Hardened HQs are unaffected." },
  { kind: "laser", label: "Orbital Lance", role: "Beam", cost: 420, cooldown: 4, tech: "siege", tip: "An orbital beam cuts a burning line through the target point. Hardened HQs are unaffected." },
];

export function supportPowerSpec(kind: SupportPowerKind): SupportPowerSpec {
  return SUPPORT_POWERS.find((spec) => spec.kind === kind) ?? SUPPORT_POWERS[0];
}
