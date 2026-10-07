import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GROUP_GAIN, GUN_VOICES, SAMPLE_GROUPS, blastGroup, impactClass, voiceFor } from "./audio";
import { MAP_TRACKS, MENU_TRACKS } from "./music";
import { MAPS } from "./game/maps";
import { UNIT_STATS, TROOP_KINDS, isInfantry } from "./game/units";

// THE SOUND DESIGN, held to its promises (owner 2026-10-03: polished, balanced, with variety across units).
const AUDIO = join(__dirname, "..", "public", "audio");

describe("weapon voices", () => {
  const shooters = [...TROOP_KINDS, "turret", "exturret", "bunker", "base", "gunpost", "mortarpit"].filter(
    (k) => UNIT_STATS[k as keyof typeof UNIT_STATS].shotDamage > 0 && !["striker", "bomber", "sensor", "wall", "cover"].includes(k),
  );

  it("every armed unit has its own voice (nothing falls through to the recruit's rifle)", () => {
    for (const kind of shooters) {
      if (kind === "soldier") continue;
      expect(GUN_VOICES[kind], `${kind} has no voice`).toBeTruthy();
    }
  });

  it("the roster sounds varied: at least 20 distinct (sample, pitch) voices", () => {
    const set = new Set(shooters.map((k) => `${voiceFor(UNIT_STATS[k as keyof typeof UNIT_STATS].projectile, k).group}@${voiceFor("rifle", k).rate}`));
    expect(set.size).toBeGreaterThanOrEqual(20);
  });

  it("is loud where it should be: boom > cannon = blast, marksman rifle > recruit rifle > scout SMG > pistols, siege gun > tank", () => {
    expect(GROUP_GAIN.boomdeep).toBeGreaterThan(GROUP_GAIN.cannon);
    expect(GROUP_GAIN.cannon).toBeGreaterThanOrEqual(GROUP_GAIN.blast);
    const loud = (k: string): number => (GROUP_GAIN[GUN_VOICES[k].group] ?? 0) * GUN_VOICES[k].m;
    expect(loud("sniper")).toBeGreaterThan(loud("soldier"));
    expect(loud("soldier")).toBeGreaterThan(loud("scout"));
    expect(loud("scout")).toBeGreaterThan(loud("turrettech") * 0.8);
    expect(loud("artillery")).toBeGreaterThan(loud("tank"));
    // headroom: every sample is peak-normalised to -3 dBFS, so a gain past ~1.41 clips
    for (const g of Object.values(GROUP_GAIN)) expect(g).toBeLessThanOrEqual(1.4);
  });

  it("the marksman, the heavy gunner and the recruit are three different recorded guns (owner 2026-10-03)", () => {
    const g = (k: string): string => voiceFor("rifle", k).group;
    expect(new Set([g("soldier"), g("sniper"), g("heavy")]).size).toBe(3);
    expect(voiceFor("rifle", "heavy").burst).toBe(true); // one burst clip per order, not ten overlapping shots
    expect(voiceFor("rifle", "sniper").alt?.length).toBeGreaterThanOrEqual(2); // a marksman rotates between bolt rifles
  });

  it("every infantry kind owns a recording of its own: at least 12 distinct guns across the roster", () => {
    const infantry = TROOP_KINDS.filter((k) => isInfantry(k) && UNIT_STATS[k].shotDamage > 0 && k !== "striker" || k === "striker");
    const groups = new Set(infantry.map((k) => voiceFor("rifle", k).group).filter(Boolean));
    expect(groups.size).toBeGreaterThanOrEqual(12); // the roster is leaner since the fun-unit cuts (2026-10-07)
  });

  it("heavier weapons play lower, lighter ones higher", () => {
    expect(GUN_VOICES.artillery.rate).toBeLessThan(GUN_VOICES.tank.rate);
    expect(GUN_VOICES.tank.rate).toBeLessThan(GUN_VOICES.base.rate);
    expect(GUN_VOICES.heavy.rate).toBeLessThan(GUN_VOICES.scout.rate);
    expect(GUN_VOICES.scout.rate).toBeGreaterThan(GUN_VOICES.soldier.rate);
  });

  it("a hand grenade is thrown (a swish), a bomb is dropped, neither is a gunshot", () => {
    expect(voiceFor("grenade", "soldier").synth).toBe("whoosh");
    expect(voiceFor("grenade", "gunship").group).toBe("pop");
  });
});

describe("impacts and blasts", () => {
  it("a hit sounds like what it hit", () => {
    expect(impactClass("soldier")).toBe("hitsoft");
    expect(impactClass("tank")).toBe("hitmetal");
    expect(impactClass("gunship")).toBe("hitmetal");
    expect(impactClass("base")).toBe("hitplate");
    expect(impactClass("cover", "tree")).toBe("hitwood");
    expect(impactClass("cover", "rock")).toBe("hitplate");
  });

  it("an explosion's size picks pop, blast or deep boom", () => {
    expect(blastGroup(0.8)).toBe("pop");
    expect(blastGroup(2.2)).toBe("blast");
    expect(blastGroup(3.4)).toBe("boomdeep");
  });
});

describe("audio files", () => {
  it("every sample the table names is on disk", () => {
    for (const [group, stems] of Object.entries(SAMPLE_GROUPS)) {
      for (const stem of stems) expect(existsSync(join(AUDIO, "sfx", `${stem}.ogg`)), `${group}: ${stem}`).toBe(true);
      expect(GROUP_GAIN[group], `${group} has no gain`).toBeGreaterThan(0);
    }
  });

  it("every map has three distinct tracks of its own, all on disk, and the menus have a pool", () => {
    for (const map of MAPS) {
      const tracks = MAP_TRACKS[map.id];
      expect(tracks, `${map.id} has no playlist`).toBeTruthy();
      expect(new Set(tracks).size, `${map.id} repeats a track`).toBe(3);
      for (const t of tracks) expect(existsSync(join(AUDIO, "music", `${t}.ogg`)), `${map.id}: ${t}`).toBe(true);
    }
    expect(MENU_TRACKS.length).toBeGreaterThanOrEqual(2);
    for (const t of MENU_TRACKS) expect(existsSync(join(AUDIO, "music", `${t}.ogg`))).toBe(true);
  });

  it("neighbouring maps do not share a whole playlist", () => {
    const lists = MAPS.map((m) => [...MAP_TRACKS[m.id]].sort().join());
    expect(new Set(lists).size).toBe(lists.length);
  });
});
