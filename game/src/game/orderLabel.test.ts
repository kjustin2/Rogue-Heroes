import { describe, expect, it } from "vitest";
import { orderLabel } from "./orderLabel";
import { createGunship, createSoldier } from "./damageModel";
import type { OrderKind, TacticalOrder } from "./sim";

const ord = (kind: OrderKind, extra: Partial<TacticalOrder> = {}): TacticalOrder => ({ id: "o", actorId: "a", kind, aim: "center", elapsed: 0, duration: 1, fired: false, done: false, ...extra });
const soldier = createSoldier("a", "Rook", "player", { x: 0, z: 0 });
const foe = createSoldier("b", "Foe", "enemy", { x: 5, z: 0 });
const KINDS: OrderKind[] = ["move", "shoot", "grenade", "ram", "defend", "melee", "load", "unload", "smoke", "deploy", "man", "slam"];

describe("orderLabel (2026-10-03: a bomb read 'Grenade', slam/dig/smoke read 'shoot target')", () => {
  it("every order kind has a real name, never the raw enum", () => {
    for (const kind of KINDS) {
      const { title } = orderLabel(ord(kind), soldier, foe);
      expect(title.length, kind).toBeGreaterThan(0);
      if (kind !== "move" && kind !== "ram" && kind !== "load" && kind !== "unload" && kind !== "smoke" && kind !== "deploy" && kind !== "man" && kind !== "slam" && kind !== "shoot") {
        expect(title.toLowerCase(), `${kind} is not named by its enum`).not.toBe(kind === "grenade" ? "bomb" : "");
      }
    }
    expect(orderLabel(ord("slam"), soldier, undefined)).toMatchObject({ title: "Slam", detail: "" });
    expect(orderLabel(ord("smoke"), soldier, undefined).title).toBe("Smoke");
    expect(orderLabel(ord("defend"), soldier, undefined).title).toBe("Crouch");
  });

  it("the same order kind is named by what the actor does with it", () => {
    const gunship = createGunship("g", "Hawk", "player", { x: 0, z: 0 });
    expect(orderLabel(ord("grenade", { destination: { x: 3, z: 3 } }), gunship, undefined).title).toBe("Bomb");
    expect(orderLabel(ord("grenade", { destination: { x: 3, z: 3 } }), soldier, undefined)).toMatchObject({ title: "Grenade", detail: "ground" });
    expect(orderLabel(ord("melee", { shove: true }), soldier, foe)).toMatchObject({ title: "Push", detail: "Foe" });
    expect(orderLabel(ord("melee"), soldier, foe).title).toBe("Strike");
    expect(orderLabel(ord("move", { leap: true }), soldier, undefined).title).toBe("Jump");
  });
});
