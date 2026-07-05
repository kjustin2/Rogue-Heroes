import { TROOP_CATALOG, type TroopKind } from "./units";

// A branching research tree. Each node costs money + the base's command point to research,
// requires its prerequisites first, and unlocks one or more troop types. Players cannot
// afford everything quickly, so they choose which paths to invest in.
// A team-wide combat modifier granted by a specialization node. Multipliers default to 1,
// flat bonuses to 0; the sim aggregates a base's researched effects via aggregateTechEffect().
export interface TechEffect {
  infantryDamage?: number; // ×weapon damage dealt by infantry
  vsVehicleDamage?: number; // ×damage dealt to vehicles
  infantryHp?: number; // ×HP infantry deploy with
  vehicleHp?: number; // ×HP vehicles deploy with
  healBonus?: number; // +HP per medic aura tick
  repairBonus?: number; // +HP per engineer aura tick
  splashDamage?: number; // ×explosive / grenade splash damage
  splashRadius?: number; // ×explosive splash radius
  evasion?: number; // ×spread of shots fired AT this team (>1 = harder to hit)
  spotterBoost?: number; // 1 = spotter relays sharpen allied fire further
}

export interface TechNode {
  id: string;
  name: string;
  branch: "recon" | "assault" | "support" | "armor";
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
  { id: "recon", name: "Recon Doctrine", branch: "recon", cost: 220, requires: [], tier: 1, blurb: "Scouts and Marksmen — vision and precision." },
  { id: "assault", name: "Assault Doctrine", branch: "assault", cost: 220, requires: [], tier: 1, blurb: "Strikers and Heavy Gunners — close-quarters pressure." },
  { id: "support", name: "Support Wing", branch: "support", cost: 280, requires: ["recon"], tier: 2, blurb: "Medics and Engineers — keep your force in the fight." },
  { id: "ordnance", name: "Ordnance Lab", branch: "assault", cost: 300, requires: ["assault"], tier: 2, blurb: "Grenadiers and Mortar Teams — area denial." },
  { id: "armor", name: "Armor Bay", branch: "armor", cost: 340, requires: ["assault"], tier: 2, blurb: "Tanks and APCs — rolling steel." },
  { id: "siege", name: "Siege Works", branch: "armor", cost: 380, requires: ["armor"], tier: 3, blurb: "Artillery — break fortified positions from afar." },
  { id: "airwing", name: "Air Wing", branch: "armor", cost: 420, requires: ["armor"], tier: 3, blurb: "Gunships — open the vertical axis (Flak Track counters enemy air)." },
  // Assault specialization — offense vs. durability.
  { id: "breach", name: "Breaching Rounds", branch: "assault", cost: 260, requires: ["assault"], tier: 4, excludes: ["bulwark"], effect: { infantryDamage: 1.18 }, blurb: "+18% infantry weapon damage. Locks out Bulwark Training." },
  { id: "bulwark", name: "Bulwark Training", branch: "assault", cost: 260, requires: ["assault"], tier: 4, excludes: ["breach"], effect: { infantryHp: 1.15 }, blurb: "Infantry deploy with +15% HP. Locks out Breaching Rounds." },
  // Armor specialization — tank survivability vs. anti-armor punch.
  { id: "plating", name: "Reactive Plating", branch: "armor", cost: 300, requires: ["armor"], tier: 4, excludes: ["hunter"], effect: { vehicleHp: 1.15 }, blurb: "Vehicles deploy with +15% HP. Locks out Hunter Rounds." },
  { id: "hunter", name: "Hunter Rounds", branch: "armor", cost: 300, requires: ["armor"], tier: 4, excludes: ["plating"], effect: { vsVehicleDamage: 1.2 }, blurb: "+20% damage dealt to vehicles. Locks out Reactive Plating." },
  // Support specialization — keep infantry alive vs. keep armor rolling.
  { id: "triage", name: "Triage Protocol", branch: "support", cost: 260, requires: ["support"], tier: 4, excludes: ["welding"], effect: { healBonus: 6 }, blurb: "Medic auras heal far more each round. Locks out Field Welding." },
  { id: "welding", name: "Field Welding", branch: "support", cost: 260, requires: ["support"], tier: 4, excludes: ["triage"], effect: { repairBonus: 8 }, blurb: "Engineer rigs repair far more each round. Locks out Triage Protocol." },
  // Recon specialization — sharper eyes vs. staying unseen.
  { id: "optics", name: "Optics Array", branch: "recon", cost: 240, requires: ["recon"], tier: 4, excludes: ["ghillie"], effect: { spotterBoost: 1 }, blurb: "Scout/Marksman relays sharpen nearby allied fire far more. Locks out Ghillie Doctrine." },
  { id: "ghillie", name: "Ghillie Doctrine", branch: "recon", cost: 240, requires: ["recon"], tier: 4, excludes: ["optics"], effect: { evasion: 1.3 }, blurb: "Shots fired at your units scatter wider — your force is harder to hit. Locks out Optics Array." },
  // Ordnance specialization — bigger blasts vs. wider blasts.
  { id: "thermobarics", name: "Thermobarics", branch: "assault", cost: 300, requires: ["ordnance"], tier: 4, excludes: ["cluster"], effect: { splashDamage: 1.3 }, blurb: "+30% explosive and grenade splash damage. Locks out Cluster Munitions." },
  { id: "cluster", name: "Cluster Munitions", branch: "assault", cost: 300, requires: ["ordnance"], tier: 4, excludes: ["thermobarics"], effect: { splashRadius: 1.45 }, blurb: "Explosive blasts cover far more ground. Locks out Thermobarics." },
];

export function techNode(id: string): TechNode | undefined {
  return TECH_TREE.find((node) => node.id === id);
}

// Troop kinds unlocked by a given tech node.
export function troopsUnlockedBy(id: string): TroopKind[] {
  return TROOP_CATALOG.filter((spec) => spec.tech === id).map((spec) => spec.kind);
}

// Combine every specialization a base has researched into one set of modifiers.
export function aggregateTechEffect(ids: readonly string[]): Required<TechEffect> {
  const acc: Required<TechEffect> = {
    infantryDamage: 1, vsVehicleDamage: 1, infantryHp: 1, vehicleHp: 1, healBonus: 0, repairBonus: 0,
    splashDamage: 1, splashRadius: 1, evasion: 1, spotterBoost: 0,
  };
  for (const id of ids) {
    const eff = techNode(id)?.effect;
    if (!eff) continue;
    if (eff.infantryDamage) acc.infantryDamage *= eff.infantryDamage;
    if (eff.vsVehicleDamage) acc.vsVehicleDamage *= eff.vsVehicleDamage;
    if (eff.infantryHp) acc.infantryHp *= eff.infantryHp;
    if (eff.vehicleHp) acc.vehicleHp *= eff.vehicleHp;
    if (eff.healBonus) acc.healBonus += eff.healBonus;
    if (eff.repairBonus) acc.repairBonus += eff.repairBonus;
    if (eff.splashDamage) acc.splashDamage *= eff.splashDamage;
    if (eff.splashRadius) acc.splashRadius *= eff.splashRadius;
    if (eff.evasion) acc.evasion *= eff.evasion;
    if (eff.spotterBoost) acc.spotterBoost = 1;
  }
  return acc;
}
