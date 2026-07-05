// Commander profile: lifetime stats, medals, and doctrine mastery, persisted across
// battles in localStorage. Purely a trophy case — no gameplay effect.

export interface CommanderStats {
  battles: number;
  wins: number;
  losses: number;
  kills: number;
  killsByKind: Record<string, number>;
  doctrineUse: Record<string, number>;
  medals: string[];
}

export interface MedalDef {
  id: string;
  name: string;
  blurb: string;
}

export const MEDALS: readonly MedalDef[] = [
  { id: "first-victory", name: "First Blood", blurb: "Win your first battle." },
  { id: "flawless", name: "Flawless Command", blurb: "Win a battle without losing a single unit." },
  { id: "blitz", name: "Blitz", blurb: "Win a battle in 5 turns or fewer." },
  { id: "demolitionist", name: "Demolitionist", blurb: "Topple a pillar or tree during a winning battle." },
  { id: "warlord", name: "Warlord", blurb: "Win 10 battles." },
  { id: "centurion", name: "Centurion", blurb: "Reach 100 lifetime unit kills." },
];

const KEY = "rht.commander.v1";

export class Commander {
  stats: CommanderStats = { battles: 0, wins: 0, losses: 0, kills: 0, killsByKind: {}, doctrineUse: {}, medals: [] };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.stats = { ...this.stats, ...(JSON.parse(raw) as Partial<CommanderStats>) };
    } catch {
      // ignore
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.stats));
    } catch {
      // ignore
    }
  }

  recordResearch(nodeId: string): void {
    this.stats.doctrineUse[nodeId] = (this.stats.doctrineUse[nodeId] ?? 0) + 1;
    this.save();
  }

  /** Mastery tier for a doctrine: I at 3 lifetime researches, II at 6, III at 10. */
  masteryTier(nodeId: string): number {
    const uses = this.stats.doctrineUse[nodeId] ?? 0;
    return uses >= 10 ? 3 : uses >= 6 ? 2 : uses >= 3 ? 1 : 0;
  }

  /** Total mastery "stars" summed across every doctrine — drives slow cosmetic unlocks. */
  totalMastery(): number {
    return Object.keys(this.stats.doctrineUse).reduce((sum, id) => sum + this.masteryTier(id), 0);
  }

  /**
   * Record a finished battle and return any NEWLY earned medals (for toasts).
   * `killsByKind` is this battle's player kills grouped by victim kind.
   */
  recordBattle(input: { victory: boolean; turns: number; losses: number; killsByKind: Record<string, number>; toppleHappened: boolean }): MedalDef[] {
    const s = this.stats;
    s.battles += 1;
    if (input.victory) s.wins += 1;
    else s.losses += 1;
    for (const [kind, n] of Object.entries(input.killsByKind)) {
      s.killsByKind[kind] = (s.killsByKind[kind] ?? 0) + n;
      s.kills += n;
    }
    const fresh: MedalDef[] = [];
    const earn = (id: string, condition: boolean): void => {
      if (!condition || s.medals.includes(id)) return;
      s.medals.push(id);
      const def = MEDALS.find((m) => m.id === id);
      if (def) fresh.push(def);
    };
    earn("first-victory", input.victory);
    earn("flawless", input.victory && input.losses === 0);
    earn("blitz", input.victory && input.turns <= 5);
    earn("demolitionist", input.victory && input.toppleHappened);
    earn("warlord", s.wins >= 10);
    earn("centurion", s.kills >= 100);
    this.save();
    return fresh;
  }

  /** The player's deadliest unit kind by lifetime kills. */
  topUnitKind(): string | undefined {
    const entries = Object.entries(this.stats.killsByKind);
    if (!entries.length) return undefined;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  reset(): void {
    this.stats = { battles: 0, wins: 0, losses: 0, kills: 0, killsByKind: {}, doctrineUse: {}, medals: [] };
    this.save();
  }
}

export const commander = new Commander();
