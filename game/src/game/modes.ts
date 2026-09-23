// Game modes. The win/lose logic lives in the sim; this is the shared metadata.

export type ModeId = "destroy" | "ctf" | "hill" | "domination" | "survival";

export interface ModeDef {
  id: ModeId;
  name: string;
  blurb: string;
  scoreTarget: number; // captures needed (ctf) or control points to bank (hill)
}

export const MODES: readonly ModeDef[] = [
  {
    id: "destroy",
    name: "Annihilation",
    blurb: "Wipe out the enemy: destroy their Home Base and every unit they field.",
    scoreTarget: 0,
  },
  {
    id: "ctf",
    name: "Capture the Flag",
    blurb: "Carry the enemy flag back to your base. First side to 2 captures wins.",
    scoreTarget: 2,
  },
  {
    id: "hill",
    name: "Hold the Hill",
    blurb: "Hold the central zone. Bank 8 turns of uncontested control to win.",
    scoreTarget: 8,
  },
  {
    id: "domination",
    name: "Domination",
    blurb: "Three marked sectors score every turn you hold them. First to 12 points wins.",
    scoreTarget: 12,
  },
  {
    id: "survival",
    name: "Last Stand",
    blurb: "No enemy base — just escalating assault waves. Keep your Home Base alive through turn 12 to win.",
    scoreTarget: 12,
  },
];

/**
 * The modes offered on the set-up page: three tight ones (owner, 2026-09-22 — "just 3 tight good
 * ones for now"). Domination and Last Stand stay in the sim and its tests, unoffered, until asked.
 */
export const PLAYABLE_MODES: readonly ModeDef[] = MODES.filter((m) => m.id === "destroy" || m.id === "ctf" || m.id === "hill");

export function modeDef(id: ModeId): ModeDef {
  return MODES.find((mode) => mode.id === id) ?? MODES[0];
}
