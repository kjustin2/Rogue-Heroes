// Catalog of every troop the Home Base can deploy. Data only — no engine dependencies.

export type TroopKind =
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
  | "flak"
  | "gunship";

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
  { kind: "gunship", label: "Gunship", role: "Air", cost: 400, cooldown: 3, tech: "airwing", tip: "Fast flyer: overflies all terrain and cover. Its autocannon duels other aircraft; it drops bombs on ground targets (aim a spot, blast radius shown). Fragile — one flak burst threatens it — and it cannot capture." },
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
