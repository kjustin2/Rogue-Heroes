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
  | "sapper"
  | "jumper";

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
  mortar: true, medic: true, engineer: true, flamer: true, droneop: true, sapper: true, jumper: true,
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
  /** Jet-jump mover: a move ARCS over cliffs, water and cover and lands anywhere dry in range. */
  jump?: boolean;
  /** Rounds keep going through BODIES (cover still stops them), losing this fraction of damage per body. */
  pierce?: number;
  /** A landed hit SUPPRESSES: the target has one command point next turn and drops to a crouch. */
  suppresses?: boolean;
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
  /**
   * How much of a unit's OWN range it is accurate over, 0..1. Past weaponRange * accurateFraction
   * every further metre costs spreadPerMeter of extra cone.
   *
   * Authored as a fraction rather than an absolute distance because weaponRange spans 7.5 to 42:
   * a fixed "9 metres" meant the flamer (range 7.5) was pinpoint everywhere it could shoot while
   * the flak track (range 32) was penalized across almost its whole envelope -- not a decision
   * anyone made, just an artefact of two numbers being authored independently. Tying them together
   * means retuning a weapon's reach carries its accuracy with it.
   */
  accurateFraction: number;
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
  accurateFraction: 0.35,
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
  scout: foot({ moveRange: 11.5, moveSpeed: 11.8, shotDamage: 22, weaponRange: 22, spread: 3.0, accurateFraction: 0.41, spreadPerMeter: 0.12, accuracyLabel: "carbine", aiValue: 6 }),
  // RAIL MARKSMAN. The round does not stop at the first body: it goes through and hits every unit
  // on the line, losing a quarter of its punch per body. Cover and walls still stop it. Line the
  // enemy up and one shot is three -- the "wide beam" of the fun pass as one stat on one unit.
  sniper: foot({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 40, weaponRange: 34, projectileSpeed: 3.8, spread: 0.22, accurateFraction: 0.35, spreadPerMeter: 0.09, accuracyLabel: "marksman", pierce: 0.25, aiValue: 8 }),
  striker: foot({ moveRange: 10.8, moveSpeed: 11.5, shotDamage: 24, accuracyLabel: "sidearm", meleeRange: 0.72, meleeMultiplier: 1, aiValue: 5 }),
  // A four-round burst reads as a rifle with a stutter. Ten rounds at lower per-shot damage reads
  // as a machine gun: same weight of fire, but you SEE the volume, and the wide cone means stray
  // rounds rake whatever is standing near the target.
  heavy: foot({ moveRange: 4.8, moveSpeed: 4.8, shotDamage: 8, burst: 10, spread: 4.4, accurateFraction: 0.3, spreadPerMeter: 0.18, accuracyLabel: "machine gun", hpMultiplier: 1.18, suppresses: true, aiValue: 5 }),
  grenadier: foot({ moveRange: 6.3, moveSpeed: 5.8, shotDamage: 38, weaponRange: 22, projectile: "grenade", projectileSpeed: 2.05, spread: 7.4, accurateFraction: 0.41, accuracyLabel: "launcher", groundShell: true, aiValue: 7 }),
  mortar: foot({ moveRange: 5.0, moveSpeed: 5.2, shotDamage: 44, weaponRange: 30, projectile: "grenade", projectileSpeed: 2.05, spread: 7.0, accurateFraction: 0.67, accuracyLabel: "mortar", groundShell: true, hpMultiplier: 1.12, aiValue: 8 }),
  // THE THREE SUPPORTS USED TO BE ONE UNIT. Medic, engineer and drone operator all sat at 16-18
  // damage and 16-18 range and differed only by which passive aura they carried, which is invisible
  // in play — you could swap them and notice nothing until the numbers moved. They now differ in
  // SHAPE: the medic is a tough short-range body that has to hug the line it heals, the engineer is
  // the mid-range utility hand, and the drone operator is a long-eyed spotter that cannot fight.
  medic: foot({ moveRange: 7.0, moveSpeed: 7.0, shotDamage: 11, weaponRange: 11, accurateFraction: 0.55, hpMultiplier: 1.3, aiValue: 8 }),
  engineer: foot({ moveRange: 5.8, moveSpeed: 5.8, shotDamage: 18, weaponRange: 18, accurateFraction: 0.5, hpMultiplier: 1.1, aiValue: 7 }),
  flamer: foot({ shotDamage: 34, weaponRange: 7.5, accurateFraction: 0.9, aiValue: 4 }),
  droneop: foot({ moveRange: 6.8, moveSpeed: 6.8, shotDamage: 8, weaponRange: 26, accurateFraction: 0.62, spread: 1.4, spreadPerMeter: 0.08, hpMultiplier: 0.82, accuracyLabel: "marker carbine", aiValue: 4 }),
  // SCATTERGUN. Seven pellets, each rolling its own spread, on a short leash. Projectiles hit
  // whatever they cross rather than only their target, so a wide burst genuinely sweeps a clump —
  // this is a shotgun as a data change, not a new attack path. At 3m nearly every pellet connects
  // (~119); by 12m the cone is wider than a squad and most of it sails past. It is the only weapon
  // in the roster whose damage is a function of how close you dared to get.
  // The cone is the widest in the roster but still has to obey the scale rules in scale.test.ts:
  // spread at MAX range must stay under 12 degrees, or the top of the range is a lie. 8 + 9*0.65*0.22
  // lands at ~9.3, so every metre of its short reach is a metre it can actually shoot.
  sapper: foot({ shotDamage: 17, weaponRange: 9, burst: 7, spread: 8, accurateFraction: 0.35, spreadPerMeter: 0.22, accuracyLabel: "scattergun", aiValue: 5 }),
  // JUMP TROOPER. Vertical movement: its move is a jet-assisted arc that ignores cliffs, water and
  // cover and lands on any dry ground in range, then it fires a carbine from wherever it landed.
  // Mid-arc it is a flyer -- anti-air can pick it out of the sky and it can be shot by interceptors.
  jumper: foot({ jump: true, moveRange: 9.0, moveSpeed: 8.5, shotDamage: 26, weaponRange: 17, spread: 2.6, accurateFraction: 0.44, spreadPerMeter: 0.11, accuracyLabel: "carbine", hpMultiplier: 0.95, aiValue: 6 }),

  // --- Ground vehicles ---
  tank: u({ moveRange: 5.4, moveSpeed: 5.5, shotDamage: 66, weaponRange: 28, projectile: "shell", projectileSpeed: 2.45, spread: 2.65, accurateFraction: 0.5, accuracyLabel: "stabilized cannon", ramRange: 2.85, groundShell: true, hpMultiplier: 1.3, aiValue: 3 }),
  apc: u({ moveRange: 7.2, moveSpeed: 7.4, shotDamage: 30, weaponRange: 24, projectile: "bolt", projectileSpeed: 2.8, spread: 3.1, accurateFraction: 0.375, accuracyLabel: "autogun", hpMultiplier: 1.16, aiValue: 3 }),
  artillery: u({ moveRange: 4.2, moveSpeed: 4.4, shotDamage: 78, weaponRange: 42, projectile: "shell", projectileSpeed: 2.45, spread: 5.4, accurateFraction: 0.48, accuracyLabel: "siege gun", groundShell: true, hpMultiplier: 1.2, aiValue: 9 }),
  flak: u({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 16, weaponRange: 32, accurateFraction: 0.3, projectile: "bolt", accuracyLabel: "flak cannon", aiValue: 6 }),

  // --- Aircraft. Guns are air-to-air; bombs use the grenade path and fall straight down. ---
  gunship: u({ moveRange: 12.5, moveSpeed: 9.5, shotDamage: 22, weaponRange: 22, accurateFraction: 0.41, projectile: "bolt", accuracyLabel: "gunship autocannon", grenadeRange: 11, aiValue: 8 }),
  interceptor: u({ moveRange: 14, moveSpeed: 11.5, shotDamage: 26, projectile: "bolt", accuracyLabel: "interceptor cannon", aiValue: 4 }),
  bomber: u({ moveRange: 8, moveSpeed: 6.4, grenadeRange: 12, aiValue: 4 }),
  transport: u({ moveRange: 11, moveSpeed: 8.5, aiValue: 4 }),

  // --- Structures and scenery ---
  base: u({ shotDamage: 42, weaponRange: 30, accurateFraction: 0.3, projectile: "bolt", projectileSpeed: 2.8, spread: 1.25, accuracyLabel: "command relay", aiValue: 6 }),
  turret: u({ shotDamage: 30, weaponRange: 24, projectile: "bolt", projectileSpeed: 2.8, spread: 2.3, accurateFraction: 0.375, spreadPerMeter: 0.05, accuracyLabel: "turret autogun", aiValue: 4 }),
  exturret: u({ shotDamage: 58, projectile: "shell", projectileSpeed: 2.45, spread: 4.6, accurateFraction: 0.77, accuracyLabel: "mortar battery", groundShell: true, hpMultiplier: 1.25, aiValue: 5 }),
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
  { kind: "scout", label: "Scout", role: "Recon", cost: 110, cooldown: 1, tech: "recon", tip: "Fast, cheap eyes; its optic relay sharpens nearby allies' fire. DASH: too quick to track — its moves never trigger enemy overwatch." },
  { kind: "sniper", label: "Marksman", role: "Sniper", cost: 220, cooldown: 2, tech: "recon", tip: "Long-range rail rifle. The round goes THROUGH bodies and hits everyone on the line (a quarter weaker per body) — line them up. Cover and walls still stop it. Deadly to heads and exposed crews. MARK: whatever it fires at (hit or miss) is painted for the rest of the turn — every other friendly shoots it tighter." },
  { kind: "striker", label: "Striker", role: "Melee", cost: 180, cooldown: 2, tech: "assault", tip: "CHARGE: the strike order closes up to 5m for free before the blade lands, so anything within a lunge is already in reach." },
  { kind: "heavy", label: "Heavy Gunner", role: "Suppression", cost: 250, cooldown: 2, tech: "assault", tip: "Ten-round machine-gun bursts that SUPPRESS: anyone the burst hits is pinned — one command point next turn and forced to crouch. The cone is wide enough that strays rake whoever stands near the target." },
  { kind: "grenadier", label: "Grenadier", role: "Splash", cost: 250, cooldown: 3, tech: "ordnance", tip: "Arcing launcher with splash that clears cover and clusters. Airburst: a round that bursts on cover still lands half its hit on whoever hides behind it." },
  { kind: "mortar", label: "Mortar Team", role: "Indirect", cost: 300, cooldown: 3, tech: "ordnance", tip: "High-arc indirect fire that reaches over walls and ridges; hits hard and takes a beating. SMOKE: a second order lays a 3-turn smoke cloud that swallows every flat shot through it — mortars, artillery and grenades still arc over." },
  { kind: "medic", label: "Medic", role: "Frontline Support", cost: 180, cooldown: 2, tech: "support", tip: "Heals wounded infantry near it each round — and the aura is short, so it has to stand in the line it is keeping alive. STABILISE: infantry killed within 6m of a medic go DOWN instead of dying; a medic still within 6m at the next turn start brings them back at 30%. Tough for a support unit; barely armed." },
  { kind: "engineer", label: "Engineer", role: "Support", cost: 200, cooldown: 2, tech: "support", tip: "Repairs nearby vehicles and the Home Base, and its fire-control rig boosts nearby allies' damage." },
  { kind: "droneop", label: "Drone Operator", role: "Spotter", cost: 210, cooldown: 2, tech: "support", tip: "The longest eyes on the field: a 26m marker carbine and a drone whose optics sharpen nearby allies' fire. Recon pulse: spend its turn to see every enemy unit's next order before you give yours. Almost no punch and the thinnest armour in the roster — keep it behind everything." },
  { kind: "jumper", label: "Jump Trooper", role: "Vertical", cost: 270, cooldown: 2, tech: "assault", tip: "Jet pack. Its move is a jump: over cliffs, over water, over walls, onto the high ground — then it fires from up there. Land next to an enemy and the SLAM knocks it back and hurts. Airborne for the leap, so flak and interceptors can catch it mid-arc." },
  { kind: "flamer", label: "Flamer", role: "Burn", cost: 260, cooldown: 2, tech: "ordnance", tip: "Short-range flame projector. Every hit leaves burning ground for 2 turns — crouching won't help, RUN. Enemy infantry near the flames break and run from them. Shoot its fuel tanks at your peril." },
  { kind: "sapper", label: "Scattergun", role: "Breacher", cost: 240, cooldown: 2, tech: "ordnance", tip: "Seven-pellet scattergun: brutal inside 5m and useless past 10 — the spread sweeps a whole clump at once. Also plants proximity mines ($15 each) and BREACH: one demolition round takes any wall or cover piece down in a single shot." },
  { kind: "tank", label: "Tank", role: "Armor", cost: 400, cooldown: 3, tech: "armor", tip: "Heavily armored bruiser: massive HP, big gun, and can ram and crush cover. HULL DOWN: a turn spent not moving settles it in — 30% less damage taken until it moves again." },
  { kind: "apc", label: "APC", role: "Vehicle", cost: 250, cooldown: 2, tech: "armor", tip: "Fast armored flanker; durable and quick, shrugs off small arms. Carries two foot troops: load them from beside the hull, unload beside it." },
  { kind: "artillery", label: "Artillery", role: "Siege", cost: 440, cooldown: 4, tech: "siege", tip: "Long-range siege gun; devastating at distance and tough, but helpless up close. A position piece: it deploys (a turn, or any turn it holds still) before it can fire, and packing up to move costs a turn." },
  { kind: "flak", label: "Flak Track", role: "Anti-Air", cost: 260, cooldown: 2, tech: "armor", tip: "Dedicated anti-air: shreds aircraft at long range and its overwatch cone blankets the air lane. Weak against ground armor — it's a specialist, not a brawler." },
  { kind: "gunship", label: "Gunship", role: "Air", cost: 400, cooldown: 3, tech: "airwing", tip: "Fast flyer: overflies all terrain and cover. Its autocannon duels other aircraft; it drops bombs straight down on ground targets (fly over them, blast radius shown). Every move is a strafing run: one burst at each hostile within 4m of its path. Fragile — one flak burst threatens it — and it cannot capture." },
  { kind: "interceptor", label: "Interceptor", role: "Air Superiority", cost: 320, cooldown: 2, tech: "airwing", tip: "Fast, gun-only fighter that rules the air — its cannon shreds other aircraft. No bombs; it exists to win the dogfight. Fragile to ground flak." },
  { kind: "bomber", label: "Bomber", role: "Heavy Bomber", cost: 470, cooldown: 4, tech: "airwing", tip: "Slow, tough heavy bomber with a big bomb load: each drop is a carpet of three bombs in a line along its heading. No gun at all — helpless against interceptors, so send an escort." },
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
