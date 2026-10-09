// EVERYTHING ON THE BOARD IS HEARD (owner 2026-10-08: "audio is polished up"). Every kind of visual event the sim emits, and
// every effect colour it exports to name a sound, has a branch in main.ts's effect loop -- or is on the explicit silent list
// below with the reason. A new effect that ships without a sound fails here instead of in a playtest.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const sim = src("./game/sim.ts");
const main = src("./main.ts");

// Heard through another branch, or deliberately silent.
const NOT_OWN_BRANCH: Record<string, string> = {
  DUST_FX: "a dust blast: heard as the blast voice (sized by radius)",
  SHOCKWAVE_FX: "the shockwave's blast: heard as the blast voice",
  CAR_BOMB_FX: "the car bomb going up: heard as the blast voice",
};

describe("every sim effect has a sound", () => {
  it("every VisualEvent type has a branch in the effect loop", () => {
    const union = sim.match(/\n  type: ("[a-z]+"(?: \| "[a-z]+")*);/)?.[1];
    expect(union, "VisualEvent's type union").toBeTruthy();
    const types = [...union!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(8);
    for (const t of types) expect(main.includes(`effect.type === "${t}"`), `${t} has no sound branch in main.ts`).toBe(true);
  });

  it("every exported effect colour that names a sound is used by main.ts", () => {
    const names = [...sim.matchAll(/export const ([A-Z_]+_(?:FX|JET))\b/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(6);
    for (const n of names) {
      if (NOT_OWN_BRANCH[n]) continue;
      expect(new RegExp(`\\b${n}\\b`).test(main), `${n} is never heard (add a branch in main.ts or list it in NOT_OWN_BRANCH)`).toBe(true);
    }
  });

  it("every sweep kind has its own voice", () => {
    const sweeps = [...(sim.match(/export const SWEEP_FX: Record<SweepKind, number> = \{([^}]+)\}/)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]);
    const voiced = src("./audio.ts").match(/hazard\(kind: ([^,]+),/)?.[1] ?? "";
    expect(sweeps.length).toBeGreaterThanOrEqual(5);
    for (const k of sweeps) expect(voiced.includes(`"${k}"`), `${k} has no Sfx.hazard voice`).toBe(true);
  });
});
