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
    blurb: "Destroy their base and every unit.",
    scoreTarget: 0,
  },
  {
    id: "ctf",
    name: "Capture the Flag",
    blurb: "Bring their flag home twice.",
    scoreTarget: 2,
  },
  {
    id: "hill",
    name: "Hold the Hill",
    blurb: "Hold the centre for 8 turns.",
    scoreTarget: 8,
  },
  {
    id: "domination",
    name: "Domination",
    blurb: "Hold sectors. First to 12 points.",
    scoreTarget: 12,
  },
  {
    id: "survival",
    name: "Last Stand",
    blurb: "Survive the waves to turn 12.",
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
