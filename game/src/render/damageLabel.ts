// The text that floats over a unit when it is hit. Pure, so a test can hold it to its one rule (owner 2026-10-03: "we said KIA over
// someone's head when they're hit but they didn't die, they just had a part break"): K.I.A. / DESTROYED / DEMOLISHED mean the UNIT is gone;
// a part that broke is named ("WEAPON DOWN"); an ordinary hit is its damage number.

export interface DamageLabelInput {
  /** The unit died from this hit. */
  killed: boolean;
  /** A part (not necessarily the unit) was destroyed. */
  destroyed: boolean;
  amount: number;
  partLabel: string;
}

export function damageLabel(entry: DamageLabelInput, target: { isInfantry: boolean; isCover: boolean }): string {
  if (entry.killed) return target.isInfantry ? "K.I.A." : target.isCover ? "DEMOLISHED" : "DESTROYED";
  if (entry.destroyed) return `${entry.partLabel.toUpperCase()} DOWN`.slice(0, 18);
  return `${entry.amount}`;
}
