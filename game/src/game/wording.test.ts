// WORDS MATCH THE GAME. Every number a player reads in a tip is checked against the constant that
// does the work, and no text names a unit or system that was cut. (Owner 2026-10-07: "the right
// words in their action menus and descriptions".)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOOM_RADIUS, BREAKER_CHARGE, BURN_STATUS_TURNS, BURN_TURNS, ERUPT_RADIUS, HOOK_REEL, HULL_DOWN_DAMAGE, JUMP_SLAM_RADIUS, MELEE_RUSH,
  PUNCH_MAX, RESUPPLY_HEAL, RESUPPLY_RADIUS, SENSOR_REACH, SENTRY_COST_TURNS, SLAM_RADIUS, SMOKE_TURNS, STRIKER_CHARGE,
} from "./sim";
import { DEFENSE_CATALOG, SUPPORT_POWERS, TROOP_CATALOG, unitStats } from "./units";

const troop = (kind: string): string => TROOP_CATALOG.find((t) => t.kind === kind)!.tip;
const defense = (kind: string): string => DEFENSE_CATALOG.find((t) => t.kind === kind)!.tip;
const support = (kind: string): string => SUPPORT_POWERS.find((t) => t.kind === kind)!.tip;
const src = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const hud = src("../ui/hud.ts");
/** The tip text of a hud.ts card: `<key>: { label: "<label>", tip: "..."` (UNIT_VERBS) or `id: "<key>", label: ..., tip: "..."` (ORDER_ACTIONS). */
const card = (label: string): string[] => [...hud.matchAll(new RegExp(`label: "${label}", tip: "([^"]+)"`, "g"))].map((m) => m[1]);
const m = (n: number): string => `${n}m`;

describe("tips quote the numbers the sim uses", () => {
  it("unit catalog", () => {
    expect(troop("breaker")).toContain(m(BREAKER_CHARGE));
    expect(troop("breaker")).toContain(`~${m(PUNCH_MAX)}`);
    expect(troop("boomer")).toContain(m(BOOM_RADIUS));
    expect(troop("mole")).toContain(m(ERUPT_RADIUS));
    expect(troop("hookshot")).toContain(m(HOOK_REEL));
    expect(troop("molotov")).toContain(m(unitStats("molotov").weaponRange));
    expect(troop("molotov")).toContain(`${BURN_TURNS} turns`);
    expect(troop("flamer")).toContain(`${BURN_TURNS} turns`);
    expect(troop("jumper")).toContain(m(JUMP_SLAM_RADIUS));
    expect(troop("sledge")).toContain(m(SLAM_RADIUS));
    expect(troop("striker")).toContain(m(STRIKER_CHARGE));
    expect(troop("mortar")).toContain(`${SMOKE_TURNS}-turn`);
    expect(troop("tank")).toContain(`${Math.round((1 - HULL_DOWN_DAMAGE) * 100)}% less`);
    const bz = unitStats("bazooka");
    expect(troop("bazooka")).toContain(`${Math.round(bz.shotDamage * (bz.antiArmor ?? 1))} against armour`);
  });
  it("action cards", () => {
    expect(card("Punch")[0]).toContain(m(BREAKER_CHARGE));
    expect(card("Punch")[0]).toContain(`~${m(PUNCH_MAX)}`);
    expect(card("Detonate")[0]).toContain(m(BOOM_RADIUS));
    expect(card("Burrow")[0]).toContain(m(ERUPT_RADIUS));
    expect(card("Reel")[0]).toContain(m(HOOK_REEL));
    expect(card("Hook")[0]).toContain(m(unitStats("hookshot").weaponRange));
    expect(card("Throw")[0]).toContain(m(unitStats("molotov").weaponRange));
    expect(card("Throw")[0]).toContain(`${BURN_TURNS} turns`);
    expect(card("Slam")[0]).toContain(m(SLAM_RADIUS));
    expect(card("Strike")[0]).toContain(m(MELEE_RUSH));
    expect(card("Strike")[0]).toContain(m(STRIKER_CHARGE));
    expect(card("Smoke")[0]).toContain(`${SMOKE_TURNS}-turn`);
    expect(card("Jump").some((t) => t.includes(m(JUMP_SLAM_RADIUS)))).toBe(true);
  });
  it("defenses and support powers", () => {
    expect(defense("flamepost")).toContain(`${BURN_STATUS_TURNS} turns`);
    expect(defense("sensor")).toContain(m(SENSOR_REACH));
    expect(support("resupply")).toContain(m(RESUPPLY_RADIUS));
    expect(support("resupply")).toContain(`heals ${RESUPPLY_HEAL}`);
    expect(support("sentrydrop")).toContain(`after ${SENTRY_COST_TURNS}`);
    expect(support("smokescreen")).toContain(`${SMOKE_TURNS}-turn`);
  });
});

describe("no text names something that was cut", () => {
  // Units and systems removed 2026-10-04..07, plus the hard-rule bans (CLAUDE.md).
  const CUT = /\b(Turret Tech|Trencher|Scout(?! Car)|Grenadier|Hornet|Ironclad|Fortifier|Drone Operator|Bounty Hunter|Ricochet|Lancer|Orbital|laser beam|overwatch|Command Points?)/i;
  const texts: Array<[string, string]> = [
    ...TROOP_CATALOG.map((t) => [`troop ${t.kind}`, `${t.label} ${t.role} ${t.tip}`] as [string, string]),
    ...DEFENSE_CATALOG.map((t) => [`defense ${t.kind}`, `${t.label} ${t.role} ${t.tip}`] as [string, string]),
    ...SUPPORT_POWERS.map((t) => [`support ${t.kind}`, `${t.label} ${t.role} ${t.tip}`] as [string, string]),
  ];
  // Only the player-facing string literals of each file (comments are history, not text on screen).
  const strings = (file: string): string => [...src(file).replace(/^\s*\/\/.*$/gm, "").matchAll(/"([^"\n]{12,})"|`([^`]{12,})`/g)].map((x) => x[1] ?? x[2]).join("\n");
  for (const file of ["../ui/hud.ts", "../main.ts", "./tech.ts", "./factions.ts", "../commander.ts"]) texts.push([file, strings(file)]);
  it.each(texts)("%s", (_name, text) => {
    expect([...text.matchAll(new RegExp(CUT, "gi"))].map((x) => x[0])).toEqual([]);
    expect(text.match(/\bCP\b/)?.[0], "AP, never CP").toBeUndefined();
  });
});

describe("fewest words", () => {
  it("every card label is one or two words", () => {
    const labels = [...hud.matchAll(/label: "([^"]+)", tip:/g)].map((x) => x[1]);
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) expect(label.split(" ").length, label).toBeLessThanOrEqual(2);
  });
});
