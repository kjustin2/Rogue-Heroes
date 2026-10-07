import type { CombatEntity } from "./damageModel";
import type { TacticalOrder } from "./sim";

// ONE place that names an order for a player (2026-10-03: the queue said "Grenade / bomb drop" for a bomb; the log said "queued grenade";
// slam and smoke read "shoot target"). `OrderKind` is overloaded (grenade = hand grenade / air bomb, shoot = single shot / ground
// shell, melee = strike / push, move = move / jump), so a label is a function of the order AND its actor, never of the enum alone.
// The queue chip shows `title` and, only when it adds something, `detail`; the sim log and the Undo tooltip use `text`.
export interface OrderLabel {
  title: string;
  detail: string;
  text: string;
}

export function orderLabel(order: TacticalOrder, actor: CombatEntity | undefined, target: CombatEntity | undefined): OrderLabel {
  const part = target?.parts.find((candidate) => candidate.id === order.targetPartId);
  const who = target?.name ?? "";
  const withPart = who ? `${who}${part ? ` / ${part.label}` : ""}` : "";
  const make = (title: string, detail = ""): OrderLabel => ({ title, detail, text: detail ? `${title.toLowerCase()} ${detail}` : title.toLowerCase() });
  switch (order.kind) {
    case "move":
      if (order.leap) return make(actor?.kind === "hookshot" ? "Reel" : "Jump");
      return make(actor?.kind === "skater" ? "Boost" : actor?.kind === "mole" ? "Burrow" : "Move");
    case "shoot":
      return make(actor?.kind === "hookshot" ? "Hook" : actor?.kind === "molotov" ? "Throw" : "Shoot", withPart);
    case "grenade": {
      if (actor?.flying) return make("Bomb", withPart);
      return make("Grenade", withPart || (order.destination ? "ground" : ""));
    }
    case "melee":
      return order.shove ? make(actor?.kind === "breaker" ? "Punch" : "Push", who) : make("Strike", withPart);
    case "ram": return make("Ram", who);
    case "defend": return make("Crouch");
    case "load": return make("Board", who);
    case "unload": return make("Unload");
    case "smoke": return make("Smoke");
    case "deploy": return make("Deploy");
    case "man": return make("Man", who);
    case "slam": return make("Slam");
    case "detonate": return make("Detonate");
  }
}
