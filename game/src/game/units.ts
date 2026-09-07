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
