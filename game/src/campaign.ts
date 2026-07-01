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
  },
];

const KEY = "rht.campaign.v1";

export class Campaign {
  completed = new Set<string>();
  // The mission the current in-progress save belongs to (so Continue resumes campaign context).
  activeMissionId: string | undefined;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as { completed?: string[]; active?: string };
      this.completed = new Set(state.completed ?? []);
      this.activeMissionId = state.active ?? undefined;
    } catch {
      // ignore corrupt/unavailable storage
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ completed: [...this.completed], active: this.activeMissionId }));
    } catch {
      // ignore
    }
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

  // A mission is playable if it's the first, already cleared, or its predecessor is cleared.
  isUnlocked(index: number): boolean {
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
    this.save();
  }
}

export const campaign = new Campaign();
