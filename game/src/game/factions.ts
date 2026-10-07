// The three playable factions. Data only — no engine dependencies, same shape as units.ts/modes.ts.
//
// A faction is a FILTER over the single shared TROOP_CATALOG / TECH_TREE / DEFENSE_CATALOG /
// SUPPORT_POWERS, never a parallel copy of them. That keeps one place to tune a unit and preserves
// tech.ts's "every doctrine unlocks at least one troop" invariant for free.

import type { TechEffect } from "./tech";
import type { DefenseKind, EntityKind, SupportPowerKind, TroopKind } from "./units";

export type FactionId = "vanguard" | "syndicate" | "bastion";

export interface UnitMod { hp?: number; move?: number; range?: number; damage?: number; grenades?: number }

/**
 * A faction's DOCTRINE: the one rule that changes how it plays, always on. Each field is read by
 * exactly one place in sim.ts, so a doctrine is data here and a single clause there.
 */
export interface FactionDoctrine {
  name: string;
  /** One line for the set-up card and the base panel. */
  text: string;
  /** Vanguard: every troop and support cooldown is this many turns shorter (a troop never drops below 1). */
  cooldownCut?: number;
  /** Vanguard: extra metres on the deploy ring around the Home Base. */
  deployReach?: number;
  /** Syndicate: fraction of a destroyed enemy unit's cost paid to the side that destroyed it. */
  bounty?: number;
  /** Bastion: damage multiplier for a ground unit that held position through the last resolve. */
  digIn?: number;
}

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
  /** Its Defenses deck: the two starters, the shared tech pieces, and its own. Filters DEFENSE_CATALOG. */
  defenses: readonly DefenseKind[];
  /** Its three off-map support powers, all its own (no two factions share one): a utility it starts
   *  with, then two unlocked by doctrines in its own tree. */
  supports: readonly SupportPowerKind[];
  /** Team colour accent, also used for the UI chrome. */
  accent: number;
  /** Tail of the AI's build wishlist, after its reactive counter-picks. */
  aiPreference: readonly TroopKind[];
  /**
   * The doctrines the bot researches, in order -- its signature arc. Without one the bot never
   * saved up for research at all and a Vanguard bot fielded ten Recruits and nothing else, so the
   * three factions played identically against the AI (2026-09-22 faction audit).
   */
  aiTechPath: readonly string[];
  doctrine: FactionDoctrine;
  /** Faction names for the SHARED units, so a Recruit is a Trooper / Raider / Guardsman. */
  labels?: Partial<Record<TroopKind, string>>;
  /**
   * UNIT TRAITS (owner 2026-10-03: "how each faction plays and what units they have should have more variety"). The same
   * unit is not the same unit: each faction tilts its shared troops one way (Vanguard quick and light, Syndicate hard-hitting
   * and brittle, Bastion tough, slow and long-ranged). hp / move / range / damage are multipliers, grenades a flat extra.
   * Stamped on the unit at deploy (`CombatEntity.mods`); the Deploy card names them.
   */
  unitMods?: Partial<Record<TroopKind, UnitMod>>;
  /** A built-in combat modifier, always on (same shape as a specialization's effect). */
  passive?: TechEffect;
  /** Per-faction target priority overrides on top of UNIT_STATS.aiValue. */
  aiTargetBias?: Partial<Record<EntityKind, number>>;
}

// ROSTER DESIGN (2026-09-23, owner: "the factions still feel too similar in look and gameplay").
//
// The first faction pass filtered ONE shared roster, and every faction kept most of it -- three
// decks of fourteen with ten cards in common, all calling the same Airstrike. They now share only
// a CORE (the rifleman, the heavy gunner, the marksman and the flak track, so each keeps
// an answer to air; the two regular armies also share the tank)
// and each owns a block of units nobody else fields:
//   Vanguard  -- air cavalry: Scout, Jump Trooper, Breaker, Hornet, Gunship. No indirect fire.
//   Syndicate -- raiders: Striker, Grenadier, Flamer, Sledge, Boomer, the Runabout. No tank.
//   Bastion   -- fortress: Mortar, Ironclad, Juggernaut, Artillery, Bomber, Mortar Turret. Nothing fast.
// The Heavy Gunner is CORE: whoever lacked it lost AI-vs-AI games outright (Bastion-only, Bastion
// beat Vanguard 22-3; with Vanguard and Bastion only, the Syndicate won 10 of 96).
// Each also has one doctrine rule (see FactionDoctrine) and three support powers of its own. Every faction
// keeps a tech-free opener, an answer to armour and an answer to air -- factions.test.ts asserts
// all three. `tech` lists what a faction may RESEARCH, which is wider than its roster wherever a
// node is only a prerequisite.
export const FACTIONS: readonly FactionDef[] = [
  {
    id: "vanguard",
    name: "Vanguard",
    blurb: "Full air wing. No artillery.",
    detail: "Air-mobile regulars. Scouts, jump troopers, rocket-fisted Breakers, Hornets and the only gunships, with Rocketeers and Ricochet Gunners for armour and crowds. No mortar, grenadier or artillery: a dug-in enemy has to be taken, not shelled.",
    roster: ["soldier", "scout", "sniper", "jumper", "heavy", "bazooka", "lancer", "turrettech", "breaker", "tank", "hornet", "runabout", "flak", "gunship"],
    tech: ["recon", "marksman", "radar", "assault", "shock", "motorpool", "armor", "airwing", "support", "fieldworks", "breach", "bulwark", "plating", "hunter", "optics", "ghillie"],
    defenses: ["sandbag", "wall", "turret", "sensor", "gunpost", "rocketpost"],
    supports: ["reconsweep", "airstrike", "paradrop", "emp", "medevac", "sentrydrop"],
    accent: 0x8cefff,
    aiPreference: ["tank", "gunship", "hornet", "breaker", "heavy", "jumper", "lancer", "sniper", "scout"],
    aiTechPath: ["assault", "motorpool", "armor", "recon", "airwing", "shock", "breach"],
    doctrine: {
      name: "Rapid Response",
      text: "Every troop and strike cooldown is a turn shorter, and the deploy ring reaches 4m further.",
      cooldownCut: 1,
      deployReach: 4,
    },
    labels: { soldier: "Trooper", flak: "Skyguard" },
    // Quick and light: it gets there first and pays for it in armour.
    unitMods: {
      soldier: { move: 1.12, hp: 0.95 }, scout: { move: 1.1 }, sniper: { range: 1.08 }, jumper: { move: 1.1, hp: 0.95 },
      heavy: { move: 1.12 }, bazooka: { move: 1.1 }, breaker: { move: 1.08 },
      tank: { move: 1.1, hp: 0.92 }, flak: { range: 1.06 }, gunship: { damage: 1.08, hp: 0.92 },
    },
  },
  {
    id: "syndicate",
    name: "Syndicate",
    blurb: "Fire and blades. Kills pay.",
    detail: "Fast, cheap and attritional. Strikers, flamers, grenadiers, the Sledge and kamikaze Boomers, carried in by Runabouts, with tank-hunting rocketeers behind them. No tank and no siege gun, so it cannot win a slugging match -- only a quicker one.",
    roster: ["soldier", "sniper", "heavy", "striker", "grenadier", "flamer", "boomer", "bazooka", "sledge", "turrettech", "runabout", "flak"],
    tech: ["recon", "marksman", "radar", "assault", "shock", "motorpool", "fieldworks", "ordnance", "incendiary", "demolition", "breach", "bulwark", "thermobarics", "cluster", "optics", "ghillie"],
    defenses: ["sandbag", "wall", "turret", "minefield", "mortarpit", "rocketpost", "flamepost"],
    supports: ["smokescreen", "napalm", "cluster", "minedrop", "railstrike"],
    accent: 0xffca6b,
    aiPreference: ["flamer", "sledge", "boomer", "striker", "grenadier", "runabout", "heavy", "bazooka"],
    aiTechPath: ["assault", "ordnance", "incendiary", "motorpool", "shock", "recon", "marksman", "thermobarics"],
    doctrine: {
      name: "Scavengers",
      text: "Every enemy unit it destroys pays back 30% of that unit's cost, and its blasts reach 15% wider.",
      bounty: 0.3,
    },
    // Kept from the first faction pass: the Syndicate's wider splash is its answer to dug-in lines.
    passive: { splashRadius: 1.15 },
    labels: { soldier: "Raider", sniper: "Longshot", flak: "Flak Technical", bazooka: "Tank Hunter" },
    // Hard-hitting and brittle: it wins the first exchange or loses the war.
    unitMods: {
      soldier: { grenades: 1, hp: 0.92 }, striker: { damage: 1.1 }, heavy: { damage: 1.08, hp: 0.92 }, grenadier: { range: 1.06, hp: 0.92 },
      flamer: { damage: 1.1, hp: 0.92 }, sniper: { damage: 1.06, hp: 0.92 },
      bazooka: { damage: 1.06 }, boomer: { move: 1.08 },
    },
  },
  {
    id: "bastion",
    name: "Bastion",
    blurb: "Siege guns. Troops dig in.",
    detail: "Siege and fortification. Mortars, artillery, Ironclads, cannon-armed Juggernauts, the heavy bomber and the only Mortar Turret. No scout, no striker, no fighter: nothing it fails to kill will be caught.",
    roster: ["soldier", "sniper", "heavy", "mortar", "ironclad", "juggernaut", "turrettech", "tank", "artillery", "runabout", "flak", "bomber"],
    tech: ["recon", "marksman", "radar", "assault", "shock", "motorpool", "armor", "siege", "airwing", "support", "fieldworks", "ordnance", "bulwark", "plating", "thermobarics", "cluster", "optics", "ghillie"],
    defenses: ["sandbag", "wall", "turret", "exturret", "bunker", "gunpost", "rocketpost"],
    supports: ["resupply", "laser", "barrage", "railstrike", "medevac", "sentrydrop"],
    accent: 0x9ef0b8,
    aiPreference: ["tank", "heavy", "artillery", "juggernaut", "ironclad", "mortar", "sniper"],
    aiTechPath: ["assault", "motorpool", "armor", "shock", "recon", "siege", "plating"],
    doctrine: {
      name: "Dig In",
      text: "A ground unit that holds its ground for a full turn digs in: 20% less damage until it moves.",
      digIn: 0.8,
    },
    labels: { soldier: "Guardsman", sniper: "Sentinel" },
    // Tough, slow and long-ranged: nothing it fields is quick, and everything outlasts its price.
    unitMods: {
      soldier: { hp: 1.12, move: 0.92 }, heavy: { hp: 1.1, move: 0.92 }, sniper: { range: 1.06, move: 0.95 }, mortar: { range: 1.1, move: 0.9 },
      juggernaut: { hp: 1.08 }, tank: { hp: 1.12, move: 0.94 }, artillery: { range: 1.1, hp: 1.1 }, flak: { hp: 1.1 }, bomber: { hp: 1.1 },
    },
  },
];

export const DEFAULT_FACTION: FactionId = "vanguard";

export function factionDef(id: FactionId): FactionDef {
  return FACTIONS.find((faction) => faction.id === id) ?? FACTIONS[0];
}

/** What this faction calls a troop: its own name for a shared unit, else the catalog label. */
export function factionTroopLabel(id: FactionId, kind: TroopKind, catalogLabel: string): string {
  return factionDef(id).labels?.[kind] ?? catalogLabel;
}

/** The units only this faction fields -- its signature block, derived so it can never drift. */
export function signatureUnits(id: FactionId): TroopKind[] {
  const others = FACTIONS.filter((f) => f.id !== id);
  return factionDef(id).roster.filter((kind) => !others.some((f) => f.roster.includes(kind)));
}

/** "+12% speed, -5% HP": what this faction does to a unit, for the Deploy card. Empty when it does nothing. */
export function unitModText(id: FactionId, kind: TroopKind): string {
  const m = factionDef(id).unitMods?.[kind];
  if (!m) return "";
  const pct = (v: number | undefined, name: string): string => (v && v !== 1 ? `${v > 1 ? "+" : "-"}${Math.round(Math.abs(v - 1) * 100)}% ${name}` : "");
  return [pct(m.damage, "damage"), pct(m.hp, "HP"), pct(m.move, "speed"), pct(m.range, "range"), m.grenades ? `+${m.grenades} grenade` : ""].filter(Boolean).join(", ");
}
