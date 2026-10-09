// Catalog of every troop the Home Base can deploy. Data only — no engine dependencies.

// THE single source of truth for entity kinds. damageModel re-exports EntityKind, so there is one
// list, not four (TroopKind, EntityKind, and the two inline unions in the create* factories used to
// drift independently — a missed list was a silent runtime fallthrough, now it is a compile error).
export type InfantryKind =
  | "soldier"
  | "sniper"
  | "striker"
  | "heavy"
  | "mortar"
  | "flamer"
  | "jumper"
  | "bazooka"
  | "sledge"
  | "breaker"
  | "boomer"
  | "juggernaut"
  | "hookshot"
  | "skater"
  | "molotov"
  | "mole";

export type GroundVehicleKind = "tank" | "artillery" | "flak" | "chopbike" | "bulldozer";

export type AirKind = "gunship" | "bomber";

/** Everything the Home Base can deploy onto the field. */
export type TroopKind = InfantryKind | GroundVehicleKind | AirKind;

/** Emplacements and scenery: never deployed as troops, but they are damageable entities. */
export type StructureKind = "base" | "turret" | "exturret" | "bunker" | "wall" | "cover" | "gunpost" | "mortarpit" | "rocketpost" | "flamepost" | "cannonpost" | "harpoon";

/** Every kind that can exist as a CombatEntity. */
export type EntityKind = TroopKind | StructureKind;

// Runtime membership, kept exhaustive BY THE COMPILER: Record<K, true> rejects both a missing
// member and a stray one, so these can never drift from the unions above the way the hand-written
// `kind === "a" || kind === "b" || ...` predicates used to.
const INFANTRY_SET: Record<InfantryKind, true> = {
  soldier: true, sniper: true, striker: true, heavy: true,
  mortar: true, flamer: true, jumper: true, bazooka: true,
  sledge: true,
  breaker: true, boomer: true, juggernaut: true,
  hookshot: true, skater: true, molotov: true, mole: true,
};
const GROUND_VEHICLE_SET: Record<GroundVehicleKind, true> = { tank: true, artillery: true, flak: true, chopbike: true, bulldozer: true };
const AIR_SET: Record<AirKind, true> = { gunship: true, bomber: true };

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
  /** The Hookshot's harpoon: a landed hit DRAGS the target to the shooter's feet (light vehicles barely budge; heavies never move). */
  pull?: boolean;
  /** The Rocket Skater: its move bowls over every foe trooper near the line it boosts along. */
  bowl?: boolean;
  /** The Bulldozer: everything in front of its blade is shoved along with it (props and wrecks included). */
  plow?: boolean;
  /** The Mole Sapper: its move is underground (untargetable, unblockable) and it erupts where it surfaces. */
  burrow?: boolean;
  /** Multiplies the throw of every blast or hit this unit causes (the Juggernaut's blast cannon). */
  knockback?: number;
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
  /** Rocket launcher: damage multiplier against vehicles (1 = none). */
  antiArmor?: number;
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
  // RAIL MARKSMAN. The round does not stop at the first body: it goes through and hits every unit
  // on the line, losing a quarter of its punch per body. Cover and walls still stop it. Line the
  // enemy up and one shot is three -- the "wide beam" of the fun pass as one stat on one unit.
  sniper: foot({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 54, weaponRange: 34, projectileSpeed: 3.8, spread: 0.22, accurateFraction: 0.55, spreadPerMeter: 0.09, accuracyLabel: "marksman", pierce: 0.25, aiValue: 8 }),
  striker: foot({ moveRange: 10.8, moveSpeed: 11.5, shotDamage: 24, accuracyLabel: "sidearm", meleeRange: 0.72, meleeMultiplier: 1, aiValue: 5 }),
  // A four-round burst reads as a rifle with a stutter. Ten rounds at lower per-shot damage reads
  // as a machine gun: same weight of fire, but you SEE the volume, and the wide cone means stray
  // rounds rake whatever is standing near the target.
  heavy: foot({ moveRange: 4.8, moveSpeed: 4.8, shotDamage: 8, burst: 10, spread: 4.4, accurateFraction: 0.3, spreadPerMeter: 0.18, accuracyLabel: "machine gun", hpMultiplier: 1.18, suppresses: true, aiValue: 5 }),
  mortar: foot({ moveRange: 5.0, moveSpeed: 5.2, shotDamage: 44, weaponRange: 30, projectile: "grenade", projectileSpeed: 2.05, spread: 7.0, accurateFraction: 0.67, accuracyLabel: "mortar", groundShell: true, hpMultiplier: 1.12, aiValue: 8 }),
  // BAZOOKA. A flat rocket that bursts: 64 on a trooper, half again against a hull. The cheapest way for
  // infantry to hurt armour, and slow and short-ranged enough that armour can hunt it back.
  bazooka: foot({ moveRange: 5.2, moveSpeed: 5.2, shotDamage: 64, weaponRange: 21, projectile: "shell", projectileSpeed: 2.7, spread: 2.8, accurateFraction: 0.5, accuracyLabel: "rocket launcher", groundShell: true, antiArmor: 1.5, aiValue: 7 }),
  flamer: foot({ shotDamage: 34, weaponRange: 7.5, accurateFraction: 0.9, aiValue: 4 }),
  // SCATTERGUN. Seven pellets, each rolling its own spread, on a short leash. Projectiles hit
  // whatever they cross rather than only their target, so a wide burst genuinely sweeps a clump —
  // this is a shotgun as a data change, not a new attack path. At 3m nearly every pellet connects
  // (~119); by 12m the cone is wider than a squad and most of it sails past. It is the only weapon
  // in the roster whose damage is a function of how close you dared to get.
  // The cone is the widest in the roster but still has to obey the scale rules in scale.test.ts:
  // spread at MAX range must stay under 12 degrees, or the top of the range is a lie. 8 + 9*0.65*0.22
  // lands at ~9.3, so every metre of its short reach is a metre it can actually shoot.
  // JUMP TROOPER. Vertical movement: its move is a jet-assisted arc that ignores cliffs, water and
  // cover and lands on any dry ground in range, then it fires a carbine from wherever it landed.
  // Mid-arc it is a flyer -- anti-air can pick it out of the sky and.
  jumper: foot({ jump: true, moveRange: 9.0, moveSpeed: 8.5, shotDamage: 36, weaponRange: 17, spread: 2.6, accurateFraction: 0.44, spreadPerMeter: 0.11, accuracyLabel: "carbine", hpMultiplier: 0.95, aiValue: 6 }),

  // --- batch 3 (2026-10-03): the new troopers ---
  // SLEDGE: a huge hammer. Fast, brittle, and every foe within 3m of it is flung when it swings (see queueSlam).
  sledge: foot({ moveRange: 10.5, moveSpeed: 11.2, shotDamage: 14, weaponRange: 10, accurateFraction: 0.5, hpMultiplier: 0.92, accuracyLabel: "sidearm", meleeRange: 0.9, meleeMultiplier: 1, aiValue: 6 }),

  // --- Round 6 (2026-10-06, owner: "only FUN units") ---
  // BREAKER: a rocket gauntlet. Fast; its Punch dashes in 7m and sends one foe ~18m (into water, off a ledge, into a wall).
  breaker: foot({ moveRange: 10.5, moveSpeed: 10.8, shotDamage: 22, weaponRange: 14, spread: 2.8, accurateFraction: 0.5, accuracyLabel: "carbine", meleeRange: 0.8, meleeMultiplier: 1, aiValue: 6 }),
  // BOOMER: a sprinting kamikaze with a barrel charge. No gun: it runs in and DETONATEs (it dies).
  boomer: foot({ moveRange: 12, moveSpeed: 12.5, shotDamage: 0, weaponRange: 0, hpMultiplier: 0.6, aiValue: 3 }),
  // JUGGERNAUT: slow armoured trooper with a shoulder blast cannon whose hits throw troops far.
  juggernaut: foot({ moveRange: 4.6, moveSpeed: 4.8, shotDamage: 44, weaponRange: 16, projectile: "shell", projectileSpeed: 2.6, spread: 2.4, accurateFraction: 0.6, accuracyLabel: "blast cannon", groundShell: true, hpMultiplier: 1.6, knockback: 2.2, aiValue: 7 }),

  // --- Round 7 (2026-10-07, second fun audit) ---
  // HOOKSHOT: a harpoon gun. A hit drags the foe to its feet; its hop is a 10m grapple reel (see leapRange).
  hookshot: foot({ moveRange: 7.2, moveSpeed: 7.4, shotDamage: 34, weaponRange: 14, projectileSpeed: 2.6, spread: 1.6, accurateFraction: 0.6, accuracyLabel: "harpoon", pull: true, aiValue: 6 }),
  // ROCKET SKATER: the fastest trooper; a move is a straight boost that bowls over troopers on its line.
  skater: foot({ moveRange: 13, moveSpeed: 14, shotDamage: 18, weaponRange: 14, spread: 3.0, accurateFraction: 0.45, spreadPerMeter: 0.12, accuracyLabel: "carbine", hpMultiplier: 0.85, bowl: true, aiValue: 5 }),
  // MOLOTOV: lobs a fire bottle 16m that leaves burning ground and sets troopers alight.
  molotov: foot({ shotDamage: 18, weaponRange: 16, projectile: "grenade", projectileSpeed: 2.0, spread: 5.5, accurateFraction: 0.5, accuracyLabel: "fire bottle", groundShell: true, hpMultiplier: 0.9, aiValue: 5 }),
  // MOLE SAPPER: moves underground and erupts under a foe, throwing everything within 2m.
  mole: foot({ moveRange: 8, moveSpeed: 6.5, shotDamage: 16, weaponRange: 12, accurateFraction: 0.55, accuracyLabel: "sidearm", hpMultiplier: 1.05, burrow: true, aiValue: 6 }),

  // --- Ground vehicles ---
  tank: u({ moveRange: 5.4, moveSpeed: 5.5, shotDamage: 78, weaponRange: 28, projectile: "shell", projectileSpeed: 2.45, spread: 2.65, accurateFraction: 0.5, accuracyLabel: "stabilized cannon", ramRange: 2.85, groundShell: true, hpMultiplier: 1.6, bowl: true, aiValue: 3 }),
  artillery: u({ moveRange: 4.2, moveSpeed: 4.4, shotDamage: 88, weaponRange: 42, projectile: "shell", projectileSpeed: 2.45, spread: 4.6, accurateFraction: 0.55, accuracyLabel: "siege gun", groundShell: true, hpMultiplier: 1.2, aiValue: 9 }),
  flak: u({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 20, weaponRange: 32, accurateFraction: 0.3, projectile: "bolt", accuracyLabel: "flak cannon", aiValue: 6 }),

  // ROUND 8 (2026-10-07): CHOP BIKE (Syndicate) rides THROUGH a line of troopers, slashing every one it passes (the Skater's sweep,
  // wider and harder); BULLDOZER (Bastion) shoves everything ahead of its blade -- troopers, vehicles, even props and wrecks.
  chopbike: u({ moveRange: 14, moveSpeed: 13, shotDamage: 16, weaponRange: 14, spread: 3.2, accurateFraction: 0.45, spreadPerMeter: 0.12, accuracyLabel: "sidearm", hpMultiplier: 0.75, bowl: true, aiValue: 4 }),
  bulldozer: u({ moveRange: 6.5, moveSpeed: 5.2, shotDamage: 12, weaponRange: 16, burst: 3, spread: 3.4, accurateFraction: 0.4, spreadPerMeter: 0.12, accuracyLabel: "cab MG", hpMultiplier: 1.8, plow: true, aiValue: 4 }), // burst 3: a cab MG is no anti-air or armour answer

  // --- Aircraft. The gunship's gun hits ground and air; bombs use the grenade path and fall steeply onto the picked spot. ---
  gunship: u({ moveRange: 12.5, moveSpeed: 9.5, shotDamage: 22, weaponRange: 22, accurateFraction: 0.41, projectile: "bolt", accuracyLabel: "gunship autocannon", grenadeRange: 11, aiValue: 8 }),
  bomber: u({ moveRange: 8, moveSpeed: 6.4, grenadeRange: 12, aiValue: 4 }),

  // --- Structures and scenery ---
  // The Home Base has no gun until it buys the Fortress Cannon (BASE_UPGRADES): one heavy shell, far reach.
  base: u({ shotDamage: 120, weaponRange: 40, accurateFraction: 0.55, projectile: "shell", projectileSpeed: 2.45, spread: 2.2, accuracyLabel: "fortress cannon", groundShell: true, aiValue: 6 }),
  turret: u({ shotDamage: 30, weaponRange: 24, projectile: "bolt", projectileSpeed: 2.8, spread: 2.3, accurateFraction: 0.375, spreadPerMeter: 0.05, accuracyLabel: "turret autogun", aiValue: 4 }),
  // HARPOON TOWER (2026-10-07): fires a harpoon at the nearest ground foe in reach every turn by itself and drags it to its foot.
  harpoon: u({ shotDamage: 14, weaponRange: 14, projectileSpeed: 2.6, spread: 1.6, accurateFraction: 0.6, accuracyLabel: "harpoon", pull: true, aiValue: 3 }),
  exturret: u({ shotDamage: 58, projectile: "shell", projectileSpeed: 2.45, spread: 4.6, accurateFraction: 0.77, accuracyLabel: "mortar battery", groundShell: true, hpMultiplier: 1.25, aiValue: 5 }),
  // MG Bunker: a Heavy Gunner's ten-round burst behind concrete. Short reach, suppresses, very tough.
  bunker: u({ shotDamage: 8, weaponRange: 22, burst: 10, spread: 4.4, accurateFraction: 0.32, spreadPerMeter: 0.16, accuracyLabel: "bunker MG", suppresses: true, hpMultiplier: 1.3, aiValue: 5 }),
  // MANNED EMPLACEMENTS. A heavy weapon on a sandbag ring that fires only while a trooper crews it (the
  // crew walks up and mans it; see sim.queueMan). Better than the self-firing versions, because a body
  // is spending its turn on it: the Gun Post out-ranges and out-shoots a Bunker, the Mortar Pit a Mortar Team.
  gunpost: u({ shotDamage: 11, weaponRange: 26, burst: 8, spread: 3.2, accurateFraction: 0.45, spreadPerMeter: 0.1, accuracyLabel: "mounted MG", suppresses: true, hpMultiplier: 1.1, aiValue: 5 }),
  mortarpit: u({ shotDamage: 52, weaponRange: 34, projectile: "grenade", projectileSpeed: 2.05, spread: 6, accurateFraction: 0.67, accuracyLabel: "mortar pit", groundShell: true, hpMultiplier: 1.1, aiValue: 6 }),
  // ROCKET POST: an anti-armour launcher on a sandbag ring (crewed). One heavy rocket, long reach, hard on hulls.
  rocketpost: u({ shotDamage: 70, weaponRange: 30, projectile: "shell", projectileSpeed: 2.7, spread: 2.2, accurateFraction: 0.55, accuracyLabel: "rocket post", groundShell: true, antiArmor: 1.6, hpMultiplier: 1.1, aiValue: 6 }),
  // CANNON POST: a field gun on a sandbag ring (crewed) that fires a tank shell: long reach, splash, hard on hulls. Map-only.
  cannonpost: u({ shotDamage: 54, weaponRange: 32, projectile: "shell", projectileSpeed: 2.9, spread: 2.0, accurateFraction: 0.55, accuracyLabel: "field gun", groundShell: true, antiArmor: 1.3, hpMultiplier: 1.2, aiValue: 6 }),
  // FLAME POST: a flame projector on a sandbag ring (crewed). Short reach, sets infantry alight.
  flamepost: u({ shotDamage: 34, weaponRange: 8, accurateFraction: 0.9, accuracyLabel: "flame post", hpMultiplier: 1.1, aiValue: 5 }),
  // SENTRY: a small auto-turret set down by a Turret Tech. Fires on its own each turn, packs up after a few.
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
  { kind: "soldier", label: "Recruit", role: "Rifle", cost: 150, cooldown: 1, tip: "Rifle infantry with hand grenades. Always available." },
  { kind: "sniper", label: "Marksman", role: "Sniper", cost: 160, cooldown: 2, tech: "recon", tip: "Long-range rifle. Each shot pierces every body on its line, but cover still stops it." },
  { kind: "striker", label: "Striker", role: "Melee", cost: 470, cooldown: 2, tech: "assault", tip: "Melee fighter. Its Strike charges up to 6.5m before the blade lands." },
  { kind: "heavy", label: "Heavy Gunner", role: "Suppression", cost: 250, cooldown: 2, tech: "assault", tip: "Machine gun. A unit it hits is suppressed: next turn it has 1 AP and crouches." },
  { kind: "mortar", label: "Mortar Team", role: "Indirect", cost: 260, cooldown: 3, tech: "ordnance", tip: "Lobs shells over walls and ridges. Salvo fires three lighter shells down a line: short, on target and long." },
  { kind: "jumper", label: "Jump Trooper", role: "Vertical", cost: 170, cooldown: 2, tech: "assault", tip: "Its move is a jet-pack leap over cliffs, water and walls. It lands hard, hurting and throwing every foe within 2.5m." },
  { kind: "flamer", label: "Flamer", role: "Burn", cost: 260, cooldown: 2, tech: "incendiary", tip: "Short-range flamethrower: burning ground for 2 turns that enemy infantry run from. Its fuel tanks explode when shot." },
  { kind: "bazooka", label: "Rocketeer", role: "Anti-Armor", cost: 300, cooldown: 2, tech: "shock", tip: "Rocket launcher that hits vehicles harder (96 against armour). Slow, short-ranged and fragile." },
  { kind: "sledge", label: "Sledge", role: "Hammer", cost: 300, cooldown: 3, tech: "shock", tip: "Swings a hammer in a circle: every foe within 3m is hurt and thrown. Fast but fragile." },
  { kind: "breaker", label: "Breaker", role: "Rocket Fist", cost: 300, cooldown: 2, tech: "shock", tip: "Punch dashes up to 7m and knocks one foe ~18m, into water, off a ledge or off the map. Light vehicles slide; tanks don't budge." },
  { kind: "boomer", label: "Boomer", role: "Kamikaze", cost: 110, cooldown: 1, tech: "demolition", tip: "Fast and fragile, with no gun. Detonate blows it up, wrecking and throwing everything within 3.6m." },
  { kind: "juggernaut", label: "Juggernaut", role: "Blast Cannon", cost: 340, cooldown: 3, tech: "fieldworks", tip: "Slow and tough. Its cannon's blasts throw troopers far." },
  { kind: "hookshot", label: "Hookshot", role: "Grapple", cost: 170, cooldown: 2, tech: "shock", tip: "Its harpoon drags whatever it hits to its feet; tanks don't budge. Reel pulls it 10m onto a ledge." },
  { kind: "skater", label: "Rocket Skater", role: "Bowler", cost: 240, cooldown: 2, tech: "motorpool", tip: "Fastest trooper. Each move is a rocket dash that knocks over troopers on its line." },
  { kind: "molotov", label: "Molotov", role: "Fire Bottles", cost: 170, cooldown: 2, tech: "incendiary", tip: "Throws a fire bottle 16m, over cover. It leaves burning ground for 2 turns that sets troopers alight." },
  { kind: "mole", label: "Mole Sapper", role: "Burrower", cost: 320, cooldown: 2, tech: "fieldworks", tip: "Tunnels underground, where it can't be shot, and bursts up throwing every foe within 2m." },
  { kind: "chopbike", label: "Chop Bike", role: "Raider", cost: 260, cooldown: 2, tech: "motorpool", tip: "Fast bike. Each move rides through troopers, slashing and scattering them." },
  { kind: "bulldozer", label: "Bulldozer", role: "Shover", cost: 380, cooldown: 3, tech: "motorpool", tip: "Slow and armoured. Each move shoves everything ahead of its blade into walls, water or off the map; tanks don't budge." },
  { kind: "tank", label: "Tank", role: "Armor", cost: 760, cooldown: 3, tech: "armor", tip: "Heavy armour and a big gun. It rams, and runs over troopers in its path." },
  { kind: "artillery", label: "Artillery", role: "Siege", cost: 380, cooldown: 3, tech: "siege", tip: "Long-range gun, weak up close. It can fire or move in a turn, not both." },
  { kind: "flak", label: "Flak Track", role: "Anti-Air", cost: 240, cooldown: 2, tech: "recon", tip: "Anti-air gun: strong against aircraft, weak against ground armour." },
  { kind: "gunship", label: "Gunship", role: "Air", cost: 420, cooldown: 3, tech: "airwing", tip: "Flies over all terrain, but flak hurts it. Its cannon hits ground and air; Bomb drops a big blast on a spot in reach." },
  { kind: "bomber", label: "Bomber", role: "Heavy Bomber", cost: 560, cooldown: 4, tech: "airwing", tip: "Slow, tough bomber with no gun. Each drop is three bombs in a line." },
];

export function troopSpec(kind: TroopKind): TroopSpec {
  return TROOP_CATALOG.find((spec) => spec.kind === kind) ?? TROOP_CATALOG[0];
}

// ---- Buildable base defenses. Placed near the Home Base; balanced for cost. ----

/** Buildable from the base's Defenses deck. Barrel Stacks become volatile cover and a minefield becomes mines;
 *  every other kind is an emplacement entity of the same name. */
export type DefenseKind = "wall" | "barrels" | "exturret" | "bunker" | "springtrap" | "harpoon" | "minefield" | "gunpost" | "mortarpit" | "rocketpost" | "flamepost";

export interface DefenseSpec {
  kind: DefenseKind;
  label: string;
  role: string;
  cost: number;
  tech?: string; // tech node id that unlocks it (undefined = buildable from the start)
  tip: string;
}

// DEFENSES (owner 2026-10-01: "not a lot in them ... should start out with some starter thing and have
// more options based on your tech line and possibly differ per faction"). One starter everyone has
// (the Barrel Stack: Sandbags and the Gun Turret were cut as not fun, 2026-10-08) and each faction's own:
// Vanguard's Spring Trap, the Syndicate's Minefield, Bastion's Mortar Turret, everyone's Harpoon Tower.
// Prices sit against the troops they replace: the Bunker is a Heavy Gunner
// with three times the armour that cannot advance. Which faction gets which: factions.ts.
export const DEFENSE_CATALOG: readonly DefenseSpec[] = [
  { kind: "barrels", label: "Barrel Stack", role: "Bomb", cost: 70, tip: "A stack of red fuel barrels. Shoot it and it explodes, setting off any barrels nearby." },
  { kind: "wall", label: "Blast Wall", role: "Barrier", cost: 130, tip: "A tall barrier that blocks shots and movement." },
  { kind: "gunpost", label: "Gun Post", role: "Manned", cost: 90, tip: "A machine gun in a sandbag ring. It fires while a trooper stands in it." },
  { kind: "mortarpit", label: "Mortar Pit", role: "Manned", cost: 140, tech: "ordnance", tip: "A dug-in mortar that fires while a trooper stands in it. Longer reach and harder hits than a Mortar Team." },
  { kind: "rocketpost", label: "Rocket Post", role: "Manned", cost: 170, tech: "shock", tip: "An anti-armour launcher in a sandbag ring. It fires one heavy rocket a shot while a trooper stands in it." },
  { kind: "flamepost", label: "Flame Post", role: "Manned", cost: 150, tech: "incendiary", tip: "A flamethrower in a sandbag ring. It fires while a trooper stands in it; whoever it hits burns for 3 turns." },
  { kind: "harpoon", label: "Harpoon Tower", role: "Grapple", cost: 180, tech: "shock", tip: "Fires on its own each turn at the nearest foe within 14m and drags it to the tower. Tanks don't budge." },
  { kind: "springtrap", label: "Spring Trap", role: "Launcher", cost: 100, tip: "A hidden plate: the first foe to step on it is launched far, into water, off a ledge or off the map. One use." },
  { kind: "minefield", label: "Minefield", role: "Trap", cost: 110, tech: "ordnance", tip: "Three hidden mines in a triangle. Each goes off under the first enemy to step on it." },
  { kind: "exturret", label: "Mortar Turret", role: "Siege", cost: 360, tech: "ordnance", tip: "A fixed mortar battery that clears cover and groups. It explodes if its ammo is hit." },
  { kind: "bunker", label: "MG Bunker", role: "Hold", cost: 300, tech: "armor", tip: "A concrete machine-gun nest: long bursts, short reach, very tough." },
];

export function defenseSpec(kind: DefenseKind): DefenseSpec {
  return DEFENSE_CATALOG.find((spec) => spec.kind === kind) ?? DEFENSE_CATALOG[0];
}

// ---- Home Base upgrades (beyond income): the Fortress Cannon. Armour and the Watch Radar were cut as not fun (owner
// 2026-10-07), the second base order too (2026-10-08). ----

export type BaseUpgradeId = "cannon";

export interface BaseUpgradeSpec {
  id: BaseUpgradeId;
  label: string;
  cost: number;
  tech: string;
  requires?: BaseUpgradeId;
  tip: string;
}

export const BASE_UPGRADES: readonly BaseUpgradeSpec[] = [
  { id: "cannon", label: "Fortress Cannon", cost: 850, tech: "shock", tip: "The base fires a 120-damage shell at the most valuable foe within 40m every other turn. Destroy its cannon to stop it." },
];

export function baseUpgradeSpec(id: BaseUpgradeId): BaseUpgradeSpec {
  return BASE_UPGRADES.find((u) => u.id === id) ?? BASE_UPGRADES[0];
}

// ---- Off-map support powers the Home Base can call in (cost money + the base CP). ----

export type SupportPowerKind = "laser" | "shockwave" | "tankdrop" | "commando" | "napalm" | "barrage" | "carbomb" | "boulder";

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
  // Each faction starts with one power and researches the rest (decks: factions.ts). Scans, heals and soft utility were
  // cut as not fun (owner 2026-10-07): every power now does something loud on the board.
  { kind: "laser", label: "Gun Run", role: "Strafe", cost: 420, cooldown: 4, tech: "armor", tip: "A jet strafes a line through the point with seven cannon shells. HQs take no damage." },
  { kind: "shockwave", label: "Shockwave", role: "Fling", cost: 130, cooldown: 2, tip: "A blast of air on the point: little damage, but every trooper within 4m is thrown far. Tanks don't budge." },
  { kind: "tankdrop", label: "Tank Drop", role: "Crush", cost: 460, cooldown: 4, tech: "armor", tip: "A tank lands on the point, crushing troopers under it. It fights for you for 3 turns, then its crew scuttles it." },
  { kind: "commando", label: "Commando Drop", role: "Slam", cost: 300, cooldown: 4, tech: "support", tip: "A Jump Trooper parachutes onto the point, hurting and throwing everyone within 2.5m. He fights for you from next turn." },
  { kind: "napalm", label: "Napalm", role: "Burn", cost: 240, cooldown: 3, tip: "Firebombs set a wide patch alight: a light blast, then burning ground for 2 turns." },
  { kind: "carbomb", label: "Car Bomb", role: "Ram", cost: 220, cooldown: 3, tech: "demolition", tip: "A driverless car rolls down a line through the point, knocking troopers aside, and explodes where it stops." },
  { kind: "boulder", label: "Boulder Roll", role: "Bowl", cost: 150, cooldown: 2, tip: "A boulder rolls down a line through the point, knocking every trooper aside. Tanks and walls stop it." },
  { kind: "barrage", label: "Barrage", role: "Siege", cost: 340, cooldown: 4, tech: "ordnance", tip: "Six heavy shells land one after another across a wide circle around the point. HQs take no damage." },
];

export function supportPowerSpec(kind: SupportPowerKind): SupportPowerSpec {
  return SUPPORT_POWERS.find((spec) => spec.kind === kind) ?? SUPPORT_POWERS[0];
}
