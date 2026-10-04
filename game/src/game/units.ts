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
  | "flamer"
  | "droneop"
  | "jumper"
  | "bazooka"
  | "builder"
  | "demo"
  | "turrettech"
  | "sledge"
  | "lancer"
  | "bounty"
  | "ironclad"
  | "trencher";

export type GroundVehicleKind = "tank" | "artillery" | "flak" | "runabout" | "hornet";

export type AirKind = "gunship" | "bomber" | "transport";

/** Everything the Home Base can deploy onto the field. */
export type TroopKind = InfantryKind | GroundVehicleKind | AirKind;

/** Emplacements and scenery: never deployed as troops, but they are damageable entities. */
export type StructureKind = "base" | "turret" | "exturret" | "bunker" | "sensor" | "wall" | "cover" | "gunpost" | "mortarpit" | "rocketpost" | "flamepost" | "sentry";

/** Every kind that can exist as a CombatEntity. */
export type EntityKind = TroopKind | StructureKind;

// Runtime membership, kept exhaustive BY THE COMPILER: Record<K, true> rejects both a missing
// member and a stray one, so these can never drift from the unions above the way the hand-written
// `kind === "a" || kind === "b" || ...` predicates used to.
const INFANTRY_SET: Record<InfantryKind, true> = {
  soldier: true, scout: true, sniper: true, striker: true, heavy: true, grenadier: true,
  mortar: true, flamer: true, droneop: true, jumper: true,
  bazooka: true, builder: true, demo: true,
  turrettech: true, sledge: true, lancer: true, bounty: true, ironclad: true, trencher: true,
};
const GROUND_VEHICLE_SET: Record<GroundVehicleKind, true> = { tank: true, artillery: true, flak: true, runabout: true, hornet: true };
const AIR_SET: Record<AirKind, true> = { gunship: true, bomber: true, transport: true };

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
  /** The ricochet rifle: a landed hit glances on to up to two more foes within 3.2m (60% then 40% of the damage). */
  chain?: boolean;
  /** A tower shield: damage from the front arc is multiplied by this (bullets only; blasts go round it). */
  shield?: number;
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
  scout: foot({ moveRange: 11.5, moveSpeed: 11.8, shotDamage: 26, weaponRange: 22, spread: 3.0, accurateFraction: 0.41, spreadPerMeter: 0.12, accuracyLabel: "carbine", aiValue: 6 }),
  // RAIL MARKSMAN. The round does not stop at the first body: it goes through and hits every unit
  // on the line, losing a quarter of its punch per body. Cover and walls still stop it. Line the
  // enemy up and one shot is three -- the "wide beam" of the fun pass as one stat on one unit.
  sniper: foot({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 54, weaponRange: 34, projectileSpeed: 3.8, spread: 0.22, accurateFraction: 0.35, spreadPerMeter: 0.09, accuracyLabel: "marksman", pierce: 0.25, aiValue: 8 }),
  striker: foot({ moveRange: 10.8, moveSpeed: 11.5, shotDamage: 24, accuracyLabel: "sidearm", meleeRange: 0.72, meleeMultiplier: 1, aiValue: 5 }),
  // A four-round burst reads as a rifle with a stutter. Ten rounds at lower per-shot damage reads
  // as a machine gun: same weight of fire, but you SEE the volume, and the wide cone means stray
  // rounds rake whatever is standing near the target.
  heavy: foot({ moveRange: 4.8, moveSpeed: 4.8, shotDamage: 8, burst: 10, spread: 4.4, accurateFraction: 0.3, spreadPerMeter: 0.18, accuracyLabel: "machine gun", hpMultiplier: 1.18, suppresses: true, aiValue: 5 }),
  grenadier: foot({ moveRange: 6.3, moveSpeed: 5.8, shotDamage: 38, weaponRange: 22, projectile: "grenade", projectileSpeed: 2.05, spread: 7.4, accurateFraction: 0.41, accuracyLabel: "launcher", groundShell: true, aiValue: 7 }),
  mortar: foot({ moveRange: 5.0, moveSpeed: 5.2, shotDamage: 44, weaponRange: 30, projectile: "grenade", projectileSpeed: 2.05, spread: 7.0, accurateFraction: 0.67, accuracyLabel: "mortar", groundShell: true, hpMultiplier: 1.12, aiValue: 8 }),
  // BAZOOKA. A flat rocket that bursts: 64 on a trooper, half again against a hull. The cheapest way for
  // infantry to hurt armour, and slow and short-ranged enough that armour can hunt it back.
  bazooka: foot({ moveRange: 5.2, moveSpeed: 5.2, shotDamage: 64, weaponRange: 21, projectile: "shell", projectileSpeed: 2.7, spread: 2.8, accurateFraction: 0.5, accuracyLabel: "rocket launcher", groundShell: true, antiArmor: 1.5, aiValue: 7 }),
  // THE FIELD HANDS: each has a sidearm and one placing verb (see PLACEABLES) -- their worth is the verb.
  builder: foot({ moveRange: 5.8, moveSpeed: 5.8, shotDamage: 16, weaponRange: 12, accurateFraction: 0.55, hpMultiplier: 1.15, accuracyLabel: "sidearm", aiValue: 4 }),
  demo: foot({ moveRange: 6.0, moveSpeed: 6.0, shotDamage: 17, weaponRange: 14, accurateFraction: 0.5, accuracyLabel: "sidearm", aiValue: 5 }),
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
  // JUMP TROOPER. Vertical movement: its move is a jet-assisted arc that ignores cliffs, water and
  // cover and lands on any dry ground in range, then it fires a carbine from wherever it landed.
  // Mid-arc it is a flyer -- anti-air can pick it out of the sky and.
  jumper: foot({ jump: true, moveRange: 9.0, moveSpeed: 8.5, shotDamage: 36, weaponRange: 17, spread: 2.6, accurateFraction: 0.44, spreadPerMeter: 0.11, accuracyLabel: "carbine", hpMultiplier: 0.95, aiValue: 6 }),

  // --- batch 3 (2026-10-03): the new troopers ---
  // TURRET TECH: a field hand that sets down two sentries a sortie (a counter like grenades).
  turrettech: foot({ moveRange: 5.8, moveSpeed: 5.8, shotDamage: 16, weaponRange: 12, accurateFraction: 0.55, hpMultiplier: 1.05, accuracyLabel: "sidearm", aiValue: 5 }),
  // SLEDGE: a huge hammer. Fast, brittle, and every foe within 3m of it is flung when it swings (see queueSlam).
  sledge: foot({ moveRange: 10.5, moveSpeed: 11.2, shotDamage: 14, weaponRange: 10, accurateFraction: 0.5, hpMultiplier: 0.92, accuracyLabel: "sidearm", meleeRange: 0.9, meleeMultiplier: 1, aiValue: 6 }),
  // RICOCHET GUNNER: a hit glances on to the next two foes within 3.2m (a warm bullet, not a beam): the answer to a clump.
  lancer: foot({ moveRange: 6.4, moveSpeed: 6.4, shotDamage: 30, weaponRange: 22, projectileSpeed: 3.0, spread: 2.6, accurateFraction: 0.45, spreadPerMeter: 0.1, accuracyLabel: "ricochet rifle", chain: true, aiValue: 7 }),
  // BOUNTY HUNTER: a long rifle and a price on every head: each kill pays cash.
  bounty: foot({ moveRange: 6.2, moveSpeed: 6.3, shotDamage: 50, weaponRange: 36, projectileSpeed: 3.8, spread: 0.3, accurateFraction: 0.35, spreadPerMeter: 0.09, accuracyLabel: "long rifle", aiValue: 7 }),
  // IRONCLAD: a tower shield. Slow and tough; bullets from the front arc barely hurt it.
  ironclad: foot({ moveRange: 5.0, moveSpeed: 5.2, shotDamage: 36, weaponRange: 18, spread: 3.0, accurateFraction: 0.5, accuracyLabel: "carbine", hpMultiplier: 1.45, shield: 0.4, aiValue: 6 }),
  // TRENCHER: digs a whole squad in (see queueDig).
  trencher: foot({ moveRange: 6.2, moveSpeed: 6.2, shotDamage: 17, weaponRange: 14, accurateFraction: 0.5, hpMultiplier: 1.1, accuracyLabel: "sidearm", aiValue: 5 }),

  // --- Ground vehicles ---
  tank: u({ moveRange: 5.4, moveSpeed: 5.5, shotDamage: 78, weaponRange: 28, projectile: "shell", projectileSpeed: 2.45, spread: 2.65, accurateFraction: 0.5, accuracyLabel: "stabilized cannon", ramRange: 2.85, groundShell: true, hpMultiplier: 1.6, aiValue: 3 }),
  artillery: u({ moveRange: 4.2, moveSpeed: 4.4, shotDamage: 88, weaponRange: 42, projectile: "shell", projectileSpeed: 2.45, spread: 4.6, accurateFraction: 0.55, accuracyLabel: "siege gun", groundShell: true, hpMultiplier: 1.2, aiValue: 9 }),
  flak: u({ moveRange: 6.0, moveSpeed: 6.2, shotDamage: 18, weaponRange: 32, accurateFraction: 0.3, projectile: "bolt", accuracyLabel: "flak cannon", aiValue: 6 }),
  // RUNABOUT: a light car that drives far (13m a move), seats four riders and a gunner, and its mounted MG fires only with a gunner aboard.
  runabout: u({ moveRange: 13, moveSpeed: 11.5, shotDamage: 16, weaponRange: 22, burst: 3, spread: 3.4, accurateFraction: 0.4, spreadPerMeter: 0.12, accuracyLabel: "mounted MG", hpMultiplier: 0.8, aiValue: 3 }),
  // HORNET: a light tank: quick, accurate, thin-skinned.
  hornet: u({ moveRange: 8.2, moveSpeed: 8.4, shotDamage: 52, weaponRange: 24, projectile: "shell", projectileSpeed: 2.6, spread: 2.3, accurateFraction: 0.55, accuracyLabel: "light cannon", groundShell: true, hpMultiplier: 0.95, aiValue: 4 }),

  // --- Aircraft. The gunship's gun hits ground and air; bombs use the grenade path and fall steeply onto the picked spot. ---
  gunship: u({ moveRange: 12.5, moveSpeed: 9.5, shotDamage: 22, weaponRange: 22, accurateFraction: 0.41, projectile: "bolt", accuracyLabel: "gunship autocannon", grenadeRange: 11, aiValue: 8 }),
  bomber: u({ moveRange: 8, moveSpeed: 6.4, grenadeRange: 12, aiValue: 4 }),
  transport: u({ moveRange: 11, moveSpeed: 8.5, aiValue: 4 }),

  // --- Structures and scenery ---
  // The Home Base has no gun until it buys the Fortress Cannon (BASE_UPGRADES): one heavy shell, far reach.
  base: u({ shotDamage: 120, weaponRange: 40, accurateFraction: 0.55, projectile: "shell", projectileSpeed: 2.45, spread: 2.2, accuracyLabel: "fortress cannon", groundShell: true, aiValue: 6 }),
  turret: u({ shotDamage: 30, weaponRange: 24, projectile: "bolt", projectileSpeed: 2.8, spread: 2.3, accurateFraction: 0.375, spreadPerMeter: 0.05, accuracyLabel: "turret autogun", aiValue: 4 }),
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
  // FLAME POST: a flame projector on a sandbag ring (crewed). Short reach, sets infantry alight.
  flamepost: u({ shotDamage: 34, weaponRange: 8, accurateFraction: 0.9, accuracyLabel: "flame post", hpMultiplier: 1.1, aiValue: 5 }),
  // SENTRY: a small auto-turret set down by a Turret Tech. Fires on its own each turn, packs up after a few.
  sentry: u({ shotDamage: 20, weaponRange: 20, projectile: "bolt", projectileSpeed: 2.8, spread: 2.6, accurateFraction: 0.4, accuracyLabel: "sentry gun", hpMultiplier: 0.8, aiValue: 3 }),
  sensor: u({ aiValue: 3 }),
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
  { kind: "scout", label: "Scout", role: "Recon", cost: 100, cooldown: 1, tech: "recon", tip: "Fast, cheap eyes; its optic relay sharpens nearby allies' fire." },
  { kind: "sniper", label: "Marksman", role: "Sniper", cost: 185, cooldown: 2, tech: "recon", tip: "Rail rifle that pierces every body on its line (cover still stops it). Whatever it fires at is MARKED: allies hit it easier this turn." },
  { kind: "striker", label: "Striker", role: "Melee", cost: 470, cooldown: 2, tech: "assault", tip: "CHARGE: the strike order closes up to 6.5m for free before the blade lands, so anything within a lunge is already in reach." },
  { kind: "heavy", label: "Heavy Gunner", role: "Suppression", cost: 250, cooldown: 2, tech: "assault", tip: "Machine-gun bursts SUPPRESS whoever they hit: one action point and a forced crouch next turn. Strays rake nearby targets." },
  { kind: "grenadier", label: "Grenadier", role: "Splash", cost: 250, cooldown: 3, tech: "ordnance", tip: "Arcing launcher with splash that clears cover and clusters. AIRBURST: a round that bursts on cover still lands half its hit on whoever hides behind it." },
  { kind: "mortar", label: "Mortar Team", role: "Indirect", cost: 260, cooldown: 3, tech: "ordnance", tip: "High-arc fire over walls and ridges. SMOKE order: a 3-turn cloud that swallows flat shots; arcing rounds sail over." },
  { kind: "droneop", label: "Drone Operator", role: "Spotter", cost: 210, cooldown: 2, tech: "recon", tip: "26m marker carbine and a spotter drone that sharpens nearby allies' fire. RECON: spend its turn to see every enemy unit's next order. Paper-thin armour: keep it behind everything." },
  { kind: "jumper", label: "Jump Trooper", role: "Vertical", cost: 240, cooldown: 2, tech: "shock", tip: "Jet pack: its move is a leap over cliffs, water and walls. Landing beside an enemy SLAMS it. Flak can catch it mid-arc." },
  { kind: "flamer", label: "Flamer", role: "Burn", cost: 260, cooldown: 2, tech: "incendiary", tip: "Short-range flame projector. Hits leave burning ground for 2 turns: run, don't crouch. FEAR: enemy infantry near the flames break and run from them. Its fuel tanks explode when shot." },
  { kind: "bazooka", label: "Rocketeer", role: "Anti-Armor", cost: 300, cooldown: 2, tech: "shock", tip: "Shoulder-fired rocket: hits vehicles half again as hard (96 against armour). Slow, short-ranged and fragile: armour will hunt it." },
  { kind: "demo", label: "Demolitionist", role: "Charges", cost: 230, cooldown: 2, tech: "demolition", tip: "CHARGE ($45): sets a satchel bomb beside itself. It does not throw anyone when placed; it blows after 3 turns, or the moment anything shoots it. Huge blast. Anyone can set it off, you included." },
  { kind: "builder", label: "Fortifier", role: "Barriers", cost: 210, cooldown: 2, tech: "support", tip: "BARRIER ($40): raises a short, tough wall within reach. Walls stop shots and walkers; a cheap way to wall off a flank or seal a doorway." },
  { kind: "turrettech", label: "Turret Tech", role: "Sentries", cost: 200, cooldown: 2, tech: "fieldworks", tip: "SENTRY ($70): sets down an auto-turret that fires on its own each turn and packs up after 4. Carries two a sortie." },
  { kind: "sledge", label: "Sledge", role: "Hammer", cost: 360, cooldown: 3, tech: "shock", tip: "SLAM: swings a huge hammer in a circle: every foe within 3m is hurt and flung. Fast, brittle, brutal against a clump or a ledge." },
  { kind: "lancer", label: "Ricochet Gunner", role: "Chain", cost: 260, cooldown: 2, tech: "marksman", tip: "Ricochet rifle: a hit glances on to up to two more foes within 3m of the first. Wasted on armour, deadly on a clump." },
  { kind: "bounty", label: "Bounty Hunter", role: "Long Rifle", cost: 230, cooldown: 2, tech: "marksman", tip: "A 36m rifle and a price on every head: each kill pays $50." },
  { kind: "ironclad", label: "Ironclad", role: "Shield", cost: 300, cooldown: 3, tech: "shock", tip: "A tower shield: bullets from the front arc do 40% damage. Slow and tough: it walks point. Blasts and shots from the flank still hurt." },
  { kind: "trencher", label: "Trencher", role: "Dig In", cost: 210, cooldown: 2, tech: "fieldworks", tip: "DIG: every friendly trooper within 4m digs in at once (less damage until it moves)." },
  { kind: "runabout", label: "Runabout", role: "Scout Car", cost: 300, cooldown: 2, tech: "motorpool", tip: "A light car: drives 13m a move, seats four riders and a gunner. Its MG fires only with a gunner aboard." },
  { kind: "hornet", label: "Hornet", role: "Light Tank", cost: 450, cooldown: 2, tech: "motorpool", tip: "A light tank: fast, accurate and thin-skinned. Hunts what the Tank is too slow to catch." },
  { kind: "tank", label: "Tank", role: "Armor", cost: 760, cooldown: 3, tech: "armor", tip: "Massive HP, big gun, rams and crushes cover. HULL DOWN: a turn spent still takes 30% less damage until it moves." },
  { kind: "artillery", label: "Artillery", role: "Siege", cost: 380, cooldown: 3, tech: "siege", tip: "Long-range siege gun; devastating at distance and tough, but helpless up close. DEPLOY: fires only with outriggers down (a turn, or any turn it holds still); packing up to move costs a turn." },
  { kind: "flak", label: "Flak Track", role: "Anti-Air", cost: 240, cooldown: 2, tech: "recon", tip: "Anti-air specialist: shreds aircraft at range. Weak against ground armour." },
  { kind: "gunship", label: "Gunship", role: "Air", cost: 420, cooldown: 3, tech: "airwing", tip: "Overflies all terrain. Its autocannon rakes ground troops and aircraft alike; BOMB drops a huge blast on any spot in reach, no flight needed, that throws troops flying. Fragile to flak; cannot capture." },
  { kind: "bomber", label: "Bomber", role: "Heavy Bomber", cost: 470, cooldown: 4, tech: "airwing", tip: "Slow, tough heavy bomber. CARPET: each drop is three bombs in a line across the spot. No gun at all, so send an escort." },
  { kind: "transport", label: "Transport", role: "Airlift", cost: 240, cooldown: 3, tech: "airwing", tip: "Unarmed airlift: Load a ground unit, fly anywhere, Unload it. Shot down, its passengers fall out where it dies." },
];

export function troopSpec(kind: TroopKind): TroopSpec {
  return TROOP_CATALOG.find((spec) => spec.kind === kind) ?? TROOP_CATALOG[0];
}

// ---- Field placements: what a utility infantry unit sets down beside itself (1 AP + the cost). ----

export type PlaceKind = "charge" | "pad" | "oil" | "barrier" | "sentry";

export interface PlaceSpec {
  kind: PlaceKind;
  /** The infantry kind that carries it. */
  by: InfantryKind;
  label: string;
  cost: number;
  /** How far from the unit it can be set down. */
  reach: number;
  /** T turns it before it is set down. */
  rotatable: boolean;
}

export const PLACEABLES: readonly PlaceSpec[] = [
  { kind: "charge", by: "demo", label: "Charge", cost: 45, reach: 3.2, rotatable: false },
  { kind: "barrier", by: "builder", label: "Barrier", cost: 40, reach: 3.5, rotatable: true },
  { kind: "sentry", by: "turrettech", label: "Sentry", cost: 70, reach: 3.5, rotatable: true },
];

export function placeSpecFor(kind: EntityKind): PlaceSpec | undefined {
  return PLACEABLES.find((spec) => spec.by === kind);
}

// ---- Buildable base defenses. Placed near the Home Base; balanced for cost. ----

/** Buildable from the base's Defenses deck. Sandbags become cover and a minefield becomes mines;
 *  every other kind is an emplacement entity of the same name. */
export type DefenseKind = "wall" | "sandbag" | "turret" | "exturret" | "bunker" | "sensor" | "minefield" | "gunpost" | "mortarpit" | "rocketpost" | "flamepost";

export interface DefenseSpec {
  kind: DefenseKind;
  label: string;
  role: string;
  cost: number;
  tech?: string; // tech node id that unlocks it (undefined = buildable from the start)
  tip: string;
}

// DEFENSES (owner 2026-10-01: "not a lot in them ... should start out with some starter thing and have
// more options based on your tech line and possibly differ per faction"). Two starters everyone has
// (Sandbags, Blast Wall), a shared tech piece (Gun Turret) and each faction's own:
// Vanguard's Sensor Mast, the Syndicate's Minefield, Bastion's Mortar Turret and MG Bunker.
// Prices sit against the troops they replace: a Gun Turret ($210) is a Recruit's gun that cannot move
// or be flanked; the Bunker is a Heavy Gunner
// with three times the armour that cannot advance. Which faction gets which: factions.ts.
export const DEFENSE_CATALOG: readonly DefenseSpec[] = [
  { kind: "sandbag", label: "Sandbags", role: "Cover", cost: 60, tip: "A low sandbag line: infantry crouched behind it take far less fire. Anyone can use it, enemy included." },
  { kind: "wall", label: "Blast Wall", role: "Barrier", cost: 130, tip: "Tall, tough barrier that blocks shots aimed at your base. Cannot be walked or built through." },
  { kind: "turret", label: "Gun Turret", role: "Defense", cost: 210, tech: "assault", tip: "Stationary auto-cannon. Fires each turn for 1 AP; solid range and accuracy, but cannot move." },
  { kind: "gunpost", label: "Gun Post", role: "Manned", cost: 90, tip: "A sandbag ring with a heavy machine gun: it fires only while a trooper crews it (Man it). Out-ranges and out-shoots a Bunker; it dies if the gunner does." },
  { kind: "mortarpit", label: "Mortar Pit", role: "Manned", cost: 140, tech: "ordnance", tip: "A dug-in mortar that fires only while a trooper crews it (Man it). Longer reach and harder hits than a Mortar Team, behind sandbags." },
  { kind: "rocketpost", label: "Rocket Post", role: "Manned", cost: 170, tech: "shock", tip: "A sandbag ring with an anti-armour launcher: it fires only while a trooper crews it (Man it). One heavy rocket a shot, long reach, hard on hulls." },
  { kind: "flamepost", label: "Flame Post", role: "Manned", cost: 150, tech: "incendiary", tip: "A sandbag ring with a flame projector: it fires only while a trooper crews it (Man it). Short reach; whoever it hits burns for three turns." },
  { kind: "sensor", label: "Sensor Mast", role: "Spotter", cost: 150, tech: "recon", tip: "No gun. Every ally within 10m shoots straighter, like a spotter standing beside them." },
  { kind: "minefield", label: "Minefield", role: "Trap", cost: 110, tech: "ordnance", tip: "Three hidden mines in a small triangle. The first enemy to step on each sets it off." },
  { kind: "exturret", label: "Mortar Turret", role: "Siege", cost: 360, tech: "ordnance", tip: "Stationary splash battery: hits harder and soaks more than a gun turret. Clears cover and clusters; detonates if its magazine is hit." },
  { kind: "bunker", label: "MG Bunker", role: "Hold", cost: 300, tech: "armor", tip: "A concrete machine-gun nest: a long suppressing burst, short reach, very hard to crack." },
];

export function defenseSpec(kind: DefenseKind): DefenseSpec {
  return DEFENSE_CATALOG.find((spec) => spec.kind === kind) ?? DEFENSE_CATALOG[0];
}

// ---- Home Base upgrades (beyond income and the second order): armour, a cannon, a radar. Each is gated by tech. ----

export type BaseUpgradeId = "armor1" | "armor2" | "cannon" | "radar";

export interface BaseUpgradeSpec {
  id: BaseUpgradeId;
  label: string;
  cost: number;
  tech: string;
  requires?: BaseUpgradeId;
  tip: string;
}

export const BASE_UPGRADES: readonly BaseUpgradeSpec[] = [
  { id: "armor1", label: "Base Armor I", cost: 260, tech: "assault", tip: "+30% health on every part of the Home Base." },
  { id: "armor2", label: "Base Armor II", cost: 380, tech: "shock", requires: "armor1", tip: "+30% health again: a fortress." },
  { id: "cannon", label: "Fortress Cannon", cost: 850, tech: "shock", tip: "The base fires a 120-damage shell at the most valuable foe in 40m, every second turn, on its own. It is a part: shoot it out and it stops." },
  { id: "radar", label: "Watch Radar", cost: 300, tech: "radar", tip: "Every turn begins with the enemy's next orders drawn on the board." },
];

export function baseUpgradeSpec(id: BaseUpgradeId): BaseUpgradeSpec {
  return BASE_UPGRADES.find((u) => u.id === id) ?? BASE_UPGRADES[0];
}

// ---- Off-map support powers the Home Base can call in (cost money + the base CP). ----

export type SupportPowerKind = "airstrike" | "cluster" | "laser" | "reconsweep" | "smokescreen" | "resupply" | "paradrop" | "napalm" | "barrage" | "emp" | "minedrop" | "medevac" | "sentrydrop" | "railstrike";

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
  // Each faction has THREE, all its own (owner 2026-10-01, replacing "nothing on turn 1"): a cheap
  // UTILITY it starts with, and two researched powers. Vanguard: Recon Sweep / Airstrike / Paradrop.
  // Syndicate: Smoke Screen / Napalm / Cluster Strike. Bastion: Resupply / Orbital Lance / Barrage.
  { kind: "airstrike", label: "Airstrike", role: "Line", cost: 320, cooldown: 3, tech: "support", tip: "A strike wing carpets a line of bombs through the target point, aligned away from your base. Hardened HQs are unaffected." },
  { kind: "cluster", label: "Cluster Strike", role: "Area", cost: 300, cooldown: 3, tech: "ordnance", tip: "Bomblets saturate a wide area around the target point. Hardened HQs are unaffected." },
  { kind: "laser", label: "Orbital Lance", role: "Beam", cost: 420, cooldown: 4, tech: "armor", tip: "An orbital beam cuts a burning line through the target point. Hardened HQs are unaffected." },
  { kind: "reconsweep", label: "Recon Sweep", role: "Intel", cost: 60, cooldown: 2, tip: "A spotter plane maps the enemy: you see every enemy unit's next order in red, and every foe is MARKED so your shooters hit them straighter next turn. Click anywhere to call it." },
  { kind: "smokescreen", label: "Smoke Screen", role: "Cover", cost: 90, cooldown: 2, tip: "Smoke shells land on the point: a 3-turn cloud that swallows flat shots through it. Arcing fire sails over. Cover an advance." },
  { kind: "resupply", label: "Resupply Drop", role: "Sustain", cost: 140, cooldown: 3, tip: "A crate drop at the point: every one of your units within 4m heals 40 and refills its grenades." },
  { kind: "paradrop", label: "Paradrop", role: "Insert", cost: 320, cooldown: 4, tech: "airwing", tip: "A transport drops two Troopers on the point at the end of the turn. They act from next turn. Needs room in your 10-unit field." },
  { kind: "napalm", label: "Napalm", role: "Burn", cost: 240, cooldown: 3, tech: "incendiary", tip: "Firebombs set a wide patch alight: a light blast, then burning ground for 2 turns that infantry flee." },
  { kind: "emp", label: "EMP Burst", role: "Disable", cost: 200, cooldown: 3, tech: "radar", tip: "A pulse over the point: every vehicle and aircraft within 4m is dead in the water next turn (no actions). Troopers do not care." },
  { kind: "minedrop", label: "Minefield Drop", role: "Trap", cost: 170, cooldown: 3, tech: "demolition", tip: "Five mines scattered across the point at the end of the turn. Hidden; the first foes to step on them set them off." },
  { kind: "medevac", label: "Medevac", role: "Heal", cost: 220, cooldown: 3, tech: "support", tip: "A rescue chopper over the point: every one of your troopers within 5m is restored to full and the downed get back up." },
  { kind: "sentrydrop", label: "Sentry Drop", role: "Defence", cost: 190, cooldown: 3, tech: "fieldworks", tip: "A sentry parachutes onto the point: an auto-turret that fires on its own each turn and packs up after 4." },
  { kind: "railstrike", label: "Rail Strike", role: "Pierce", cost: 280, cooldown: 3, tech: "marksman", tip: "Three tungsten rods in a tight line: huge damage in a thin column. Built for tanks and bunkers. Hardened HQs are unaffected." },
  { kind: "barrage", label: "Barrage", role: "Siege", cost: 340, cooldown: 4, tech: "siege", tip: "Six heavy shells walk across a wide circle around the point, one after another. Hardened HQs are unaffected." },
];

export function supportPowerSpec(kind: SupportPowerKind): SupportPowerSpec {
  return SUPPORT_POWERS.find((spec) => spec.kind === kind) ?? SUPPORT_POWERS[0];
}
