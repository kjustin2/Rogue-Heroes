// The three playable factions. Data only — no engine dependencies, same shape as units.ts/modes.ts.
//
// A faction is a FILTER over the single shared TROOP_CATALOG / TECH_TREE / DEFENSE_CATALOG /
// SUPPORT_POWERS, never a parallel copy of them. That keeps one place to tune a unit and preserves
// tech.ts's "every doctrine unlocks at least one troop" invariant for free.

import type { DefenseKind, EntityKind, SupportPowerKind, TroopKind } from "./units";

export type FactionId = "vanguard" | "syndicate" | "bastion";

export interface FactionDef {
  id: FactionId;
  name: string;
  blurb: string;
  /** Which troops this faction may deploy. Filters TROOP_CATALOG. */
  roster: readonly TroopKind[];
  /** Which tech node ids it may research. Filters TECH_TREE. */
  tech: readonly string[];
  defenses: readonly DefenseKind[];
  supports: readonly SupportPowerKind[];
  /** Team colour accent, also used for the UI chrome. */
  accent: number;
  /** models.ts skin key, so hulls read differently per faction. */
  skin: string;
  /** Tail of the AI's build wishlist, after its reactive counter-picks. */
  aiPreference: readonly TroopKind[];
  /** Per-faction target priority overrides on top of UNIT_STATS.aiValue. */
  aiTargetBias?: Partial<Record<EntityKind, number>>;
}

const ALL_TROOPS: readonly TroopKind[] = [
  "soldier", "scout", "sniper", "striker", "heavy", "grenadier", "mortar", "medic", "engineer",
  "flamer", "droneop", "sapper", "tank", "apc", "artillery", "flak", "gunship", "interceptor",
  "bomber", "transport",
];

const ALL_TECH: readonly string[] = [
  "recon", "assault", "support", "ordnance", "armor", "siege", "airwing",
  "breach", "bulwark", "plating", "hunter", "triage", "welding", "optics", "ghillie",
  "thermobarics", "cluster",
];

const ALL_DEFENSES: readonly DefenseKind[] = ["wall", "turret", "exturret"];
const ALL_SUPPORTS: readonly SupportPowerKind[] = ["airstrike", "cluster", "laser"];

// NOTE ON ROSTERS: all three currently carry the full catalog. Faction IDENTITY (the narrowing that
// makes them play differently) lands in the balance pass, together with the test updates it forces.
// Shipping the wiring first, unnarrowed, keeps every existing battle and every existing test
// behaving exactly as before while the plumbing is proven.
export const FACTIONS: readonly FactionDef[] = [
  {
    id: "vanguard",
    name: "Vanguard",
    blurb: "Combined-arms regulars. Armour and air depth, no glaring weakness — the honest baseline.",
    roster: ALL_TROOPS,
    tech: ALL_TECH,
    defenses: ALL_DEFENSES,
    supports: ALL_SUPPORTS,
    accent: 0x8cefff,
    skin: "standard",
    aiPreference: ["soldier", "heavy", "tank", "apc", "sniper"],
  },
  {
    id: "syndicate",
    name: "Syndicate",
    blurb: "Fast, cheap and attritional. Recon and ordnance depth, mines and burn, the thinnest armour.",
    roster: ALL_TROOPS,
    tech: ALL_TECH,
    defenses: ALL_DEFENSES,
    supports: ALL_SUPPORTS,
    accent: 0xffca6b,
    skin: "standard",
    aiPreference: ["scout", "striker", "sapper", "flamer", "grenadier"],
  },
  {
    id: "bastion",
    name: "Bastion",
    blurb: "Siege and fortification. The best emplacements and the longest guns, and the slowest legs.",
    roster: ALL_TROOPS,
    tech: ALL_TECH,
    defenses: ALL_DEFENSES,
    supports: ALL_SUPPORTS,
    accent: 0x9ef0b8,
    skin: "standard",
    aiPreference: ["heavy", "mortar", "artillery", "flak", "engineer"],
  },
];

export const DEFAULT_FACTION: FactionId = "vanguard";

export function factionDef(id: FactionId): FactionDef {
  return FACTIONS.find((faction) => faction.id === id) ?? FACTIONS[0];
}
