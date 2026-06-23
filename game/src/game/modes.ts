// Game modes. The win/lose logic lives in the sim; this is the shared metadata.

export type ModeId = "destroy" | "ctf" | "hill";

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
    blurb: "Dominate the central zone. Bank 8 rounds of uncontested control to win.",
    scoreTarget: 8,
  },
];

export function modeDef(id: ModeId): ModeDef {
  return MODES.find((mode) => mode.id === id) ?? MODES[0];
}
