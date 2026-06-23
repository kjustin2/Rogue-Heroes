import { TROOP_CATALOG, type TroopKind } from "./units";

// A branching research tree. Each node costs money + the base's command point to research,
// requires its prerequisites first, and unlocks one or more troop types. Players cannot
// afford everything quickly, so they choose which paths to invest in.
export interface TechNode {
  id: string;
  name: string;
  branch: "recon" | "assault" | "support" | "armor";
  cost: number;
  requires: string[]; // all of these node ids must be researched first
  tier: number; // for layout / ordering only
  blurb: string;
}

export const TECH_TREE: readonly TechNode[] = [
  { id: "recon", name: "Recon Doctrine", branch: "recon", cost: 220, requires: [], tier: 1, blurb: "Scouts and Marksmen — vision and precision." },
  { id: "assault", name: "Assault Doctrine", branch: "assault", cost: 220, requires: [], tier: 1, blurb: "Strikers and Heavy Gunners — close-quarters pressure." },
  { id: "support", name: "Support Wing", branch: "support", cost: 280, requires: ["recon"], tier: 2, blurb: "Medics and Engineers — keep your force in the fight." },
  { id: "ordnance", name: "Ordnance Lab", branch: "assault", cost: 300, requires: ["assault"], tier: 2, blurb: "Grenadiers and Mortar Teams — area denial." },
  { id: "armor", name: "Armor Bay", branch: "armor", cost: 340, requires: ["assault"], tier: 2, blurb: "Tanks and APCs — rolling steel." },
  { id: "siege", name: "Siege Works", branch: "armor", cost: 380, requires: ["armor"], tier: 3, blurb: "Artillery — break fortified positions from afar." },
];

export function techNode(id: string): TechNode | undefined {
  return TECH_TREE.find((node) => node.id === id);
}

// Troop kinds unlocked by a given tech node.
export function troopsUnlockedBy(id: string): TroopKind[] {
  return TROOP_CATALOG.filter((spec) => spec.tech === id).map((spec) => spec.kind);
}
