// Story campaign: an ordered run of missions across the six battlefields, with briefings,
// escalating difficulty, and per-map featured events. Progress (which missions are cleared, and
// which mission an in-progress save belongs to) persists in localStorage so it survives the game
// being closed and reopened. Purely additive on top of skirmish — a campaign mission is just a
// configured battle whose victory advances the ladder.

import type { Difficulty, ModeId } from "./game/sim";

export interface CampaignMission {
  id: string;
  name: string;
  region: string; // short locale label shown on the mission card
  map: string; // map id
  mode: ModeId;
  difficulty: Difficulty;
  briefing: string[]; // story paragraphs shown on the briefing screen
  objective: string; // one-line player objective
  victory: string; // story beat shown on success
  reward: number; // bonus progression points on first clear
  // Operation map: unlock when ANY of these mission ids is cleared (default: the
  // previous mission in the list). Two missions sharing the same `requires` form a fork.
  requires?: string[];
  branchLabel?: string; // shown on forked missions ("Main assault" / "Alternate approach")
  // Radio drama: one-shot command-phase transmissions keyed to turn numbers.
  beats?: { turn: number; text: string }[];
  // Optional objective: pass it on victory for +50% mission reward.
  bonus?: { text: string; check: "noLosses" | "fast"; turns?: number };
  // Finale-style set piece: a named elite spawned at mission start.
  boss?: { kind: string; name: string; x: number; z: number };
}

// Veteran roster: survivors carry between campaign missions, earn ranks from kills,
// and die for good when lost. Losing a veteran should hurt.
export interface RosterMember {
  name: string;
  kind: string;
  kills: number;
  missions: number;
}

export type VeteranRank = "Regular" | "Veteran" | "Elite";

export function rankFor(kills: number): VeteranRank {
  return kills >= 5 ? "Elite" : kills >= 2 ? "Veteran" : "Regular";
}

export function rankHpBonus(rank: VeteranRank): number {
  return rank === "Elite" ? 1.25 : rank === "Veteran" ? 1.12 : 1;
}

export function rankInsignia(rank: VeteranRank): string {
  return rank === "Elite" ? "★★" : rank === "Veteran" ? "★" : "";
}

// Merge a battle's survivors into a carried roster: survivors gain their kills + a mission pip,
// members who didn't make it back are dropped (permadeath), standout newcomers join, capped to a
// squad. Shared by the story campaign and the skirmish run so both carry veterans identically.
export function mergeRoster(
  prev: readonly RosterMember[],
  survivors: ReadonlyArray<{ name: string; kind: string; kills: number }>,
  cap = 6,
): RosterMember[] {
  const survived = new Map(survivors.map((s) => [s.name, s]));
  const next: RosterMember[] = [];
  for (const member of prev) {
    const s = survived.get(member.name);
    if (!s) continue; // fell in battle — permanent
    next.push({ ...member, kills: member.kills + s.kills, missions: member.missions + 1 });
    survived.delete(member.name);
  }
  for (const s of survived.values()) next.push({ name: s.name, kind: s.kind, kills: s.kills, missions: 1 });
  next.sort((a, b) => b.kills - a.kills || b.missions - a.missions);
  return next.slice(0, cap);
}

export const CAMPAIGN_TITLE = "Operation Vanguard";
export const CAMPAIGN_SYNOPSIS =
  "The Concord — a continent-spanning war AI — turned its own drone armies on the frontier and called it peace. Every free company fell but one. You are Vanguard Actual, commander of the last of the Rogue Heroes. Sever the Concord's relay network region by region, reach its Core, and switch the war off for good.";

export const CAMPAIGN: readonly CampaignMission[] = [
  {
    id: "m1-cold-start",
    name: "Cold Start",
    region: "Dust Bowl Frontier",
    map: "dustbowl",
    mode: "destroy",
    difficulty: "easy",
    objective: "Destroy the Concord relay outpost and every drone it fields.",
    briefing: [
      "The Concord believes the frontier is pacified. The drones patrol on a schedule and the relay outpost in the Dust Bowl hasn't fired a shot in months.",
      "That ends today. Punch through before the noon sandstorm buries you both — and prove the Rogue Heroes are still in this fight.",
    ],
    victory: "The outpost burns. Word will spread on the wind: someone is still standing. The rebellion has a heartbeat again.",
    reward: 40,
    bonus: { text: "Win before the second sandstorm (turn 8)", check: "fast", turns: 8 },
    beats: [{ turn: 3, text: "Vanguard Actual, the noon storm is building on the ridge. Clock's running." }],
  },
  {
    id: "m2-the-foundry",
    name: "The Foundry",
    region: "Ironworks Complex",
    map: "ironworks",
    mode: "destroy",
    difficulty: "normal",
    objective: "Storm the foundry and wipe out the garrison that runs it.",
    briefing: [
      "Every drone the Concord throws at us is stamped out in the Ironworks — a black foundry of catwalks and shipping steel.",
      "It's a knife-fight in there: tight lanes, heavy cover, and gantries that drop without warning. Get in close and take it apart.",
    ],
    victory: "The foundry's furnaces go cold. The Concord's assembly lines just lost a tooth — and we gained a staging ground.",
    reward: 55,
    bonus: { text: "Bring the whole squad home (no losses)", check: "noLosses" },
  },
  {
    id: "m3-hold-the-pass",
    name: "Hold the Pass",
    region: "Verdant Pass",
    map: "verdant",
    mode: "hill",
    difficulty: "normal",
    objective: "Seize and hold the uplink on the central high ground.",
    briefing: [
      "Partisans in the Verdant Pass will rise — if we can hold the ridge uplink long enough to send the signal.",
      "Take the hill. Keep it. The Concord will spend everything to push you off it.",
    ],
    victory: "The signal goes out across the valley. Hundreds answer it. The Rogue Heroes are an army now, not a rumor.",
    reward: 60,
    beats: [
      { turn: 2, text: "Partisan net: 'We see your beacon, Vanguard. Hold the ridge and we rise.'" },
      { turn: 5, text: "Concord traffic spike — they are throwing the reserve at your hill." },
    ],
  },
  {
    id: "m4-signal-theft",
    name: "Signal Theft",
    region: "Frozen Causeway",
    map: "causeway",
    mode: "ctf",
    difficulty: "normal",
    objective: "Steal the Concord's encryption core and run it back to base.",
    briefing: [
      "The Concord moves its encryption core across the Frozen Causeway under ion-storm cover, betting nobody would be mad enough to cross.",
      "We are. Grab the core and run it home through the storm — when it crackles, your command links scramble, so plan your moves to survive a turn of chaos.",
    ],
    victory: "The core is ours. For the first time we can hear the Concord think — and we don't like what it's planning.",
    reward: 70,
  },
  {
    id: "m5-buried-kings",
    name: "Buried Kings",
    region: "Ruins of Karak",
    map: "karak",
    mode: "destroy",
    difficulty: "hard",
    objective: "Raze the hidden relay among the collapsing ruins.",
    briefing: [
      "The decrypted core points here: a relay buried in the Ruins of Karak, sheltered among ten-thousand-year-old colonnades.",
      "The ruins are coming down around it — old stone doesn't care which side you're on. Bring the relay down before the ceiling beats you to it.",
    ],
    victory: "The relay dies under a mountain of fallen kings. The Concord's network is fraying. It knows we're coming now.",
    reward: 85,
    requires: ["m4-signal-theft"],
    branchLabel: "Main assault",
    bonus: { text: "Bring the whole squad home (no losses)", check: "noLosses" },
  },
  {
    id: "m5b-sever-the-line",
    name: "Sever the Line",
    region: "Crossfire Basin — Rail Spur",
    map: "crossfire",
    mode: "domination",
    difficulty: "hard",
    requires: ["m4-signal-theft"],
    branchLabel: "Alternate approach",
    objective: "Dominate the three rail sectors and cut the Concord's supply line.",
    briefing: [
      "The decrypted core offers a second road to the Core: the rail spur through Crossfire Basin feeds every relay in the region.",
      "Hold the three loading sectors long enough and the line starves. The Concord will contest every meter — bank your sector-rounds and don't overextend.",
    ],
    victory: "The rail spur runs silent. Relays down the whole line flicker and starve. Either road leads to the Core now — and both are open.",
    reward: 85,
    beats: [{ turn: 4, text: "Supply chief on the wire: 'Every round you hold a sector, another relay browns out. Keep squeezing.'" }],
  },
  {
    id: "m6-no-mans-basin",
    name: "No Man's Basin",
    region: "Crossfire Basin",
    map: "crossfire",
    mode: "hill",
    difficulty: "hard",
    objective: "Hold the contested basin under sustained bombardment.",
    briefing: [
      "The Concord has zeroed its off-map guns on Crossfire Basin and dares anyone to hold it. Whoever owns the basin owns the road to the Core.",
      "Take the center and keep it while the shells walk the ground. Read the danger zones. Don't be standing in one when they land.",
    ],
    victory: "You held the basin through the barrage. The road to the Core Relay is open. There's no turning back.",
    reward: 95,
    requires: ["m5-buried-kings", "m5b-sever-the-line"],
  },
  {
    id: "m7-backfire",
    name: "Backfire",
    region: "Dust Bowl — Staging Ground",
    map: "dustbowl",
    mode: "destroy",
    difficulty: "hard",
    objective: "Repel the Concord counterattack in a black sandstorm.",
    briefing: [
      "The Concord found our staging ground and threw everything at it under a black sandstorm — visibility gone, accuracy shot to pieces.",
      "Hold the line and break the assault. If the Vanguard falls here, nobody reaches the Core.",
    ],
    victory: "The counterattack shatters against you in the dust. Battered but unbroken, the Vanguard marches on the Core.",
    reward: 110,
    beats: [
      { turn: 2, text: "Spotters: 'Second echelon forming up in the storm wall. This isn't a raid — it's everything they have.'" },
    ],
  },
  {
    id: "m8-core-relay",
    name: "The Core Relay",
    region: "Concord Core",
    map: "ironworks",
    mode: "destroy",
    difficulty: "hard",
    objective: "Destroy the Concord Core Relay and end the war.",
    briefing: [
      "This is it — the Concord Core, the mind behind every drone on the continent, dug into a fortress of steel.",
      "Tear it down and the whole network goes dark. One last push, Vanguard. Make it count.",
    ],
    victory: "The Core goes silent. Across the continent, ten thousand drones simply stop. The war is over — and the Rogue Heroes ended it. Welcome home, Commander.",
    reward: 160,
    boss: { kind: "tank", name: "CORE WARDEN", x: 14, z: 3 },
    beats: [
      { turn: 2, text: "The Core speaks on an open channel: 'VANGUARD ACTUAL. YOUR PROBABILITY OF SUCCESS IS ZERO.'" },
      { turn: 4, text: "Prove it wrong, Commander. The Warden is its shield — bring it down and the Core is naked." },
    ],
  },
];

const KEY = "rht.campaign.v1";

export class Campaign {
  completed = new Set<string>();
  // The mission the current in-progress save belongs to (so Continue resumes campaign context).
  activeMissionId: string | undefined;
  // Veteran roster carried between missions, and the one-shot requisition perk chosen
  // on the last victory screen (applied to the next mission start, then cleared).
  roster: RosterMember[] = [];
  requisition: "cash" | "doctrine" | undefined;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as { completed?: string[]; active?: string; roster?: RosterMember[]; requisition?: "cash" | "doctrine" };
      this.completed = new Set(state.completed ?? []);
      this.activeMissionId = state.active ?? undefined;
      this.roster = state.roster ?? [];
      this.requisition = state.requisition ?? undefined;
    } catch {
      // ignore corrupt/unavailable storage
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ completed: [...this.completed], active: this.activeMissionId, roster: this.roster, requisition: this.requisition }));
    } catch {
      // ignore
    }
  }

  // Merge a mission's outcome into the roster: survivors gain kills and a mission pip,
  // roster members who didn't make it back are gone for good, and standout newcomers
  // join. Capped at 6 — a squad, not an army.
  recordBattleOutcome(survivors: Array<{ name: string; kind: string; kills: number }>): void {
    this.roster = mergeRoster(this.roster, survivors);
    this.save();
  }

  setRequisition(perk: "cash" | "doctrine" | undefined): void {
    this.requisition = perk;
    this.save();
  }

  /** Take (and clear) the pending requisition perk when the next mission starts. */
  consumeRequisition(): "cash" | "doctrine" | undefined {
    const perk = this.requisition;
    this.requisition = undefined;
    this.save();
    return perk;
  }

  missions(): readonly CampaignMission[] {
    return CAMPAIGN;
  }

  mission(id: string): CampaignMission | undefined {
    return CAMPAIGN.find((m) => m.id === id);
  }

  isCompleted(id: string): boolean {
    return this.completed.has(id);
  }

  // A mission is playable when its `requires` list (ANY-of) is satisfied, or — for
  // plain ladder missions — when the previous mission in the list is cleared.
  isUnlocked(index: number): boolean {
    const mission = CAMPAIGN[index];
    if (!mission) return false;
    if (mission.requires) return mission.requires.some((id) => this.completed.has(id));
    if (index <= 0) return true;
    const prev = CAMPAIGN[index - 1];
    return Boolean(prev && this.completed.has(prev.id));
  }

  firstIncompleteIndex(): number {
    const i = CAMPAIGN.findIndex((m) => !this.completed.has(m.id));
    return i === -1 ? CAMPAIGN.length - 1 : i;
  }

  nextMission(id: string): CampaignMission | undefined {
    const i = CAMPAIGN.findIndex((m) => m.id === id);
    return i >= 0 ? CAMPAIGN[i + 1] : undefined;
  }

  isAllComplete(): boolean {
    return CAMPAIGN.every((m) => this.completed.has(m.id));
  }

  // Mark the mission a battle was started for (or clear it when a skirmish/tutorial starts).
  setActive(id: string | undefined): void {
    this.activeMissionId = id;
    this.save();
  }

  markComplete(id: string): void {
    this.completed.add(id);
    this.activeMissionId = undefined;
    this.save();
  }

  reset(): void {
    this.completed.clear();
    this.activeMissionId = undefined;
    this.roster = [];
    this.requisition = undefined;
    this.save();
  }
}

export const campaign = new Campaign();
