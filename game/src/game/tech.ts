import { TROOP_CATALOG, type TroopKind } from "./units";

// A branching research tree. Each node costs money + the base's command point to research,
// and it is CHEAP on purpose (owner 2026-09-24): new units are the exciting part of a game, and a
// first doctrine that took three turns of saving made players feel stuck. First tier $100, second ~$150-200, third ~$240-260, specializations ~$130-160.
// requires its prerequisites first, and unlocks troop types -- and defenses and support powers
// (their `tech` field in units.ts). Players cannot
// afford everything quickly, so they choose which paths to invest in.
// A team-wide combat modifier granted by a specialization node. Multipliers default to 1,
// flat bonuses to 0; the sim aggregates a base's researched effects via aggregateTechEffect().
export interface TechEffect {
  infantryDamage?: number; // ×weapon damage dealt by infantry
  vsVehicleDamage?: number; // ×damage dealt to vehicles
  infantryHp?: number; // ×HP infantry deploy with
  vehicleHp?: number; // ×HP vehicles deploy with
  splashDamage?: number; // ×explosive / grenade splash damage
  splashRadius?: number; // ×explosive splash radius
  evasion?: number; // ×spread of shots fired AT this team (>1 = harder to hit)
}

export interface TechNode {
  id: string;
  name: string;
  branch: "recon" | "assault" | "support" | "armor";
  /** Layer in the tree (1 = a root). Upgrades sit on layer 4 and carry an `effect` instead of units. */
  cost: number;
  requires: string[]; // all of these node ids must be researched first
  tier: number; // for layout / ordering only
  blurb: string;
  excludes?: string[]; // sibling specializations this choice locks out (and that lock it out)
  effect?: TechEffect; // a specialization's combat payoff (doctrines that unlock troops have none)
}

// Two layers:
//  • Doctrines (tier 1–3) unlock troop types — the build order that decides what you can field.
//  • Specializations (tier 4) are mutually-exclusive side-grades behind each doctrine: a real
//    decision (you can never have both halves of a pair), with a concrete combat payoff.
export const TECH_TREE: readonly TechNode[] = [
  // ===== RECON: eyes, precision, the answer to air =====
  { id: "recon", name: "Recon Doctrine", branch: "recon", cost: 100, requires: [], tier: 1, blurb: "Marksmen and the Flak Track: precision, and the answer to air." },
  // ===== ASSAULT: pressure, shock, the answer to armour =====
  { id: "assault", name: "Assault Doctrine", branch: "assault", cost: 100, requires: [], tier: 1, blurb: "Strikers, Heavy Gunners and the Gun Turret: pressure." },
  { id: "shock", name: "Shock Troops", branch: "assault", cost: 150, requires: ["assault"], tier: 2, blurb: "Jump Troopers, Breakers, Hookshots, Rocket Skaters, Rocketeers and Sledges: the answer to armour, and a fist for the front." },
  { id: "ordnance", name: "Ordnance Lab", branch: "assault", cost: 160, requires: ["assault"], tier: 2, blurb: "Mortars, the Mortar Turret, Minefields and the Barrage: area denial." },
  { id: "incendiary", name: "Fire Discipline", branch: "assault", cost: 170, requires: ["ordnance"], tier: 3, excludes: ["demolition"], blurb: "Flamers, Molotovs and Napalm: set them alight. Locks out Demolitions." },
  { id: "demolition", name: "Demolitions", branch: "assault", cost: 170, requires: ["ordnance"], tier: 3, excludes: ["incendiary"], blurb: "Boomers: break and bury. Locks out Fire Discipline." },
  // ===== ARMOR: wheels, steel, then the deep end =====
  { id: "motorpool", name: "Motor Pool", branch: "armor", cost: 140, requires: ["assault"], tier: 2, blurb: "Runabouts and Chop Bikes: fast light machines that carry the fight." },
  { id: "armor", name: "Armor Bay", branch: "armor", cost: 200, requires: ["motorpool"], tier: 3, blurb: "Tanks, the Gun Run and the Tank Drop: rolling steel." },
  { id: "siege", name: "Siege Works", branch: "armor", cost: 240, requires: ["armor", "recon"], tier: 4, blurb: "Artillery: needs armour to haul it and Recon to spot for it." },
  { id: "airwing", name: "Air Wing", branch: "armor", cost: 260, requires: ["armor", "recon"], tier: 4, blurb: "Aircraft: needs Armor Bay for the airfield and Recon for the radar." },
  // ===== SUPPORT: keep them fighting, then pick a school =====
  { id: "support", name: "Support Wing", branch: "support", cost: 150, requires: ["recon"], tier: 2, blurb: "The Airstrike: a wing of bombers on call." },
  { id: "fieldworks", name: "Field Works", branch: "support", cost: 150, requires: ["assault"], tier: 2, blurb: "Juggernauts, Mole Sappers and Bulldozers: dig in and hold." },
];


export function techNode(id: string): TechNode | undefined {
  return TECH_TREE.find((node) => node.id === id);
}

// Troop kinds unlocked by a given tech node.
export function troopsUnlockedBy(id: string): TroopKind[] {
  return TROOP_CATALOG.filter((spec) => spec.tech === id).map((spec) => spec.kind);
}

// Combine every specialization a base has researched into one set of modifiers.
/** `passive` is a faction's built-in modifier, folded in like one more researched effect. */
export function aggregateTechEffect(ids: readonly string[], passive?: TechEffect): Required<TechEffect> {
  const acc: Required<TechEffect> = {
    infantryDamage: 1, vsVehicleDamage: 1, infantryHp: 1, vehicleHp: 1,
    splashDamage: 1, splashRadius: 1, evasion: 1,
  };
  const effects = ids.map((id) => techNode(id)?.effect).concat(passive ? [passive] : []);
  for (const eff of effects) {
    if (!eff) continue;
    if (eff.infantryDamage) acc.infantryDamage *= eff.infantryDamage;
    if (eff.vsVehicleDamage) acc.vsVehicleDamage *= eff.vsVehicleDamage;
    if (eff.infantryHp) acc.infantryHp *= eff.infantryHp;
    if (eff.vehicleHp) acc.vehicleHp *= eff.vehicleHp;
    if (eff.splashDamage) acc.splashDamage *= eff.splashDamage;
    if (eff.splashRadius) acc.splashRadius *= eff.splashRadius;
    if (eff.evasion) acc.evasion *= eff.evasion;
  }
  return acc;
}
