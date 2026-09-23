// The three playable factions. Data only — no engine dependencies, same shape as units.ts/modes.ts.
//
// A faction is a FILTER over the single shared TROOP_CATALOG / TECH_TREE / DEFENSE_CATALOG /
// SUPPORT_POWERS, never a parallel copy of them. That keeps one place to tune a unit and preserves
// tech.ts's "every doctrine unlocks at least one troop" invariant for free.

import type { TechEffect } from "./tech";
import type { DefenseKind, EntityKind, SupportPowerKind, TroopKind } from "./units";

export type FactionId = "vanguard" | "syndicate" | "bastion";

export interface FactionDef {
  id: FactionId;
  name: string;
  /** One short line, sized to fit on a setup-screen card without wrapping past a few lines. */
  blurb: string;
  /** The full trade-off, for the hover tooltip. */
  detail: string;
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
  /**
   * The doctrines the bot researches, in order -- its signature arc. Without one the bot never
   * saved up for research at all and a Vanguard bot fielded ten Recruits and nothing else, so the
   * three factions played identically against the AI (2026-09-22 faction audit).
   */
  aiTechPath: readonly string[];
  /** A built-in modifier, always on (same shape as a specialization's effect), and its one-liner. */
  passive?: TechEffect;
  passiveText?: string;
  /** Per-faction target priority overrides on top of UNIT_STATS.aiValue. */
  aiTargetBias?: Partial<Record<EntityKind, number>>;
}

// ROSTER DESIGN.
//
// A faction is defined as much by what it CANNOT build as by what it can. Each one is missing a
// whole answer to something, so the matchup asks a real question:
//   Vanguard  has no indirect fire at all -- it cannot shell a dug-in position, it has to go take it.
//   Syndicate has no tank and no artillery -- it cannot win a slugging match, only a faster one.
//   Bastion   has no scout, no striker and no interceptor -- it cannot chase anything down.
// Every faction keeps the tech-free Recruit, an engineer or medic, and at least one answer to air,
// so none of them has an unanswerable hole. `tech` lists what a faction may RESEARCH, which is
// wider than its roster wherever a node is only a prerequisite: Syndicate researches Armor Bay to
// reach the Air Wing behind it, and still only fields the APC from it.
export const FACTIONS: readonly FactionDef[] = [
  {
    id: "vanguard",
    name: "Vanguard",
    blurb: "Armour and a full air wing, but no indirect fire.",
    detail: "Combined-arms regulars: the honest baseline. Tanks, APCs, flak and the whole air wing, with no glaring weakness — except that it fields no mortar, grenadier or artillery at all. A dug-in enemy has to be taken, not shelled.",
    roster: ["soldier", "scout", "sniper", "striker", "heavy", "jumper", "medic", "engineer", "tank", "apc", "flak", "gunship", "interceptor", "transport"],
    tech: ["recon", "assault", "support", "armor", "airwing", "breach", "bulwark", "plating", "hunter", "triage", "welding", "optics", "ghillie"],
    defenses: ["wall", "turret"],
    supports: ["airstrike"],
    accent: 0x8cefff,
    skin: "standard",
    aiPreference: ["tank", "apc", "heavy", "sniper", "soldier"],
    aiTechPath: ["assault", "armor", "plating"],
    passiveText: "Combined arms: the fullest roster, tanks to air wing.",
  },
  {
    id: "syndicate",
    name: "Syndicate",
    blurb: "Cheap and fast — burn, mines and area denial, but no tank.",
    detail: "Fast, cheap and attritional. Flamers, sappers, mortars and cluster munitions deny ground, and scouts and strikers take it early. No tank and no siege gun, so it cannot win a slugging match — only a quicker one.",
    roster: ["soldier", "scout", "sniper", "striker", "jumper", "grenadier", "mortar", "medic", "flamer", "droneop", "sapper", "apc", "gunship"],
    tech: ["recon", "assault", "support", "ordnance", "armor", "airwing", "breach", "bulwark", "thermobarics", "cluster", "triage", "welding", "optics", "ghillie"],
    defenses: ["wall", "turret"],
    supports: ["airstrike", "cluster"],
    accent: 0xffca6b,
    skin: "standard",
    aiPreference: ["flamer", "striker", "sapper", "grenadier", "mortar", "scout", "jumper"],
    aiTechPath: ["assault", "ordnance", "recon"],
    passive: { splashRadius: 1.15 },
    passiveText: "Area denial: every blast covers 15% more ground.",
  },
  {
    id: "bastion",
    name: "Bastion",
    blurb: "Siege and fortification — longest guns, but nothing fast.",
    detail: "Siege and fortification. Artillery, mortars, the heavy bomber and the only Mortar Turret, plus an Orbital Lance. No scout, no striker, no interceptor: nothing it fails to kill will be caught.",
    roster: ["soldier", "sniper", "heavy", "grenadier", "mortar", "medic", "engineer", "sapper", "tank", "artillery", "flak", "bomber", "transport"],
    tech: ["recon", "assault", "support", "ordnance", "armor", "siege", "airwing", "bulwark", "plating", "thermobarics", "cluster", "triage", "welding", "optics", "ghillie"],
    defenses: ["wall", "turret", "exturret"],
    supports: ["airstrike", "laser"],
    accent: 0x9ef0b8,
    skin: "standard",
    aiPreference: ["tank", "artillery", "heavy", "mortar", "grenadier", "engineer"],
    aiTechPath: ["assault", "armor", "siege"],
    passive: { infantryHp: 1.1, vehicleHp: 1.1 },
    passiveText: "Fortified: infantry and vehicles deploy with 10% more HP.",
  },
];

export const DEFAULT_FACTION: FactionId = "vanguard";

export function factionDef(id: FactionId): FactionDef {
  return FACTIONS.find((faction) => faction.id === id) ?? FACTIONS[0];
}
