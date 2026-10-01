# Game systems: factions, AI, hotseat

How the factions, the three AI brains and Local 2 Players work, with the measurements behind each.

## FACTIONS play, look and fight differently (2026-09-22)

- **THE FACTION READ IS MEASURED** (2026-09-24, owner: "infantry all look the same across factions and bases
  don't look different enough"): `npm run measure:factions` stages the HQ + rifleman / heavy / marksman / medic
  alone per faction on the real GPU (`shots:gpu factionmeasure`), then scores every faction PAIR: silhouette IoU
  (infantry <= 0.80, HQ <= 0.70) and saturation-weighted hue distance (>= 40 degrees). Baseline 0/15 pairs -> 15/15.
  `MEASURE_GATE=1` fails the run below the goal. What got it there, all in `worldRenderer.ts`:
  `factionInfantryDress` is a SILHOUETTE kit per faction on existing part ids (Vanguard crest fin + lit visor
  band + jet pack with swept fins + shoulder sensor pod + whip antenna; Syndicate pointed hood + face scarf +
  ankle-length duster; Bastion bucket helm + huge pauldrons + tassets + tower shield), `factionBaseDress` is
  architecture (Vanguard control tower + radar + helipad; Syndicate scrap palisade + crane; Bastion hex ring
  wall + glacis + dome + pillboxes), and `FACTION_CAMO` is three hue families (steel blue / rust / green) blended
  0.62 into troopers, 0.6 into machines.
  Silhouette mode hides contact shadows (they were a black disc in every shape test, `shots:silhouette` too).
  The heavy's Vanguard/Syndicate pair sits AT 0.80 -- the one to watch. Same-faction mirror matches still read
  by team (ring, trim, glow): `shots:gpu -- sameside`.
  **Extended to every unit (2026-09-24)**: the measure also compares the shared MACHINES (tank, flak, turret;
  turret held to the HQ's 0.70) and checks MEMBERSHIP -- every unit a faction fields is shot alone and must sit
  nearest its own faction's signature hue (mean of HQ + rifleman) by >= 15 degrees. `factionMachineDress` gives
  the Flak Track and Gun Turret a per-faction outline (Vanguard radome / sensor dome; Syndicate scrap-shield
  "technical" + pennant; Bastion casemate / hex pillbox) and the flyers a faction livery (fuselage band, wing
  panels, engine burn in the faction light -- the old shared orange burn made every jet read Syndicate; bombs
  are drab with a hazard band). Medics wear a NEUTRAL vest (faction camo carries it) with a smaller cross.
  Flyers are captured at agl 1.6 so the plane, not its shadow, is measured.
- **Infantry wear the ink rim** (`INFANTRY_INK` 1.6cm) on big silhouette parts only (longest side >= 0.3m,
  thinnest >= 0.08m, never the knee-split legs). **Faction stance** (`FACTION_STANCE`: torso lean, head
  counters) and **per-part hit reactions** (`partHitByEntity`: head snaps back, thigh buckles, pack spins,
  weapon knocked aside, chest rocks -- on the hit part even if the hit destroyed it) live in `paintPart`, torso
  and head only, so the distance-locked gait is untouched (`smoke:animation` skate unchanged). Evidence:
  `shots:gpu -- hitreactprobe` prints the swing (0.53 rad after a leg strike vs 0.06 idle). The perf baseline
  was rebased for this (+35% draw calls on the stress scene; real-GPU p95 ~21ms, unchanged).
- **Identity pass (2026-09-23, owner: "still too similar in look and gameplay")**. Rosters share
  only a CORE (rifleman, heavy gunner, marksman, medic, flak; tank on two) and each faction OWNS a
  block (`signatureUnits(id)`, derived): Vanguard = scout, jumper, gunship, interceptor, transport;
  Syndicate = striker, grenadier, flamer, sapper, drone op, APC; Bastion = mortar, engineer,
  artillery, bomber (+ Mortar Turret). The heavy gunner is core because the AI leans on it: any
  faction without it lost AI-vs-AI games outright (`npm run balance:factions`). THREE support powers each, never shared, starter first (owner 2026-10-01: "should start out with some starter thing and have more options in them based on your tech line ... differ per faction"): Vanguard Recon Sweep (start) / Airstrike (Support Wing) / Paradrop (Air Wing: two Troopers land at the point, field cap respected); Syndicate Smoke Screen (start) / Napalm (Assault: three firebombs, 2-turn burning ground) / Cluster Strike (Ordnance); Bastion Resupply Drop (start) / Orbital Lance (Armor Bay) / Barrage (Siege Works: six heavy shells walk a 4.5m circle). DEFENSES deck, 5-6 each: starters everyone has (Sandbags $60 = neutral low cover; Blast Wall $130), shared tech pieces (Gun Turret, Assault; Flak Nest $230, Armor Bay: the Flak Track's gun on a mount) and the faction's own: Vanguard Sensor Mast (Recon: a 10m spotter relay, no gun), Syndicate Minefield (Ordnance: three mines in a turnable triangle), Bastion Mortar Turret (Ordnance) + MG Bunker (Armor Bay: a Heavy Gunner's suppressing burst behind 150 HP of concrete). `doctrines.test.ts` pins starters / tech gates / one-of-its-own; `sim.test.ts` asserts every deck entry, on every map and faction, either REFUSES TO ARM (locked) or arms AND has a legal spot in its ring (the owner's locked-turret bug, fault-injection proven). The bot drops its strongest affordable DAMAGING power on a crowd (`DAMAGING_SUPPORT`, read top tier first); it does not build defenses or use the utility powers (not yet asked). The flat
  stat passives were replaced by a `doctrine` rule, each read by one clause in sim.ts:
  **Rapid Response** (Vanguard: `troopCooldownFor`/`supportCooldownFor` a turn shorter, min 1;
  deploy ring +4m), **Scavengers** (Syndicate: `recordDamage` pays 30% of a destroyed enemy troop's
  cost; it also keeps the old +15% splash `passive`), **Dig In** (Bastion: in `endTurn` a ground
  troop with no `MOVING_ORDERS` order is `digging` for that resolve and `dugIn = 0.8` from the next
  one it holds -- same-turn dig-in won Bastion 33 of 52 AI games; tanks excepted, they have
  hull-down; `applyDamage` scales ALL damage by it and the shot preview shows it; a knockback throw
  or boarding clears both; renderer shows a sandbag arc, HUD says "Digging in" / "Dug in").
  Shared units carry faction NAMES via `labels` / `sim.troopLabel(team, kind)` (Recruit = Trooper /
  Raider / Guardsman) -- use it, not `troopSpec(kind).label`, anywhere a player sees a unit name.
  Normal/Hard bots call their strike (`enemyStrikeAct`: 3+ weight of hostiles within 3m, no own unit
  within 6.5m). Tests: `doctrines.test.ts`. Look: faction HELMET colour (`FACTION_HELMET`, 0.55
  over the kind's), infantry camo 0.42, Syndicate hood, Bastion gorget + hazard chevrons, Vanguard
  tank smoke launchers + deck chevron, Syndicate ram plough, Bastion dozer blade. Evidence:
  `npm run shots:factions` (SwiftShader-safe sheet: shared units + signature units + a vehicle).
- **The bot plays its faction**: `aiTechPath` is its signature research arc (Vanguard armour →
  air wing, Syndicate ordnance → armour for the APC, Bastion armour → siege). With two or more units out it
  SAVES for the next doctrine and for its most-wanted unlocked unit. Before this it never
  researched past the free doctrine — a Vanguard bot fielded ten Recruits — so every faction played
  the same against the AI. Measured by `npm run balance:factions` (AI-vs-AI, 6 maps × 4 seeds
  × both seats per pairing, 2026-09-23): Vanguard 32 / Syndicate 30 / Bastion 25 wins, 57 draws.
  Not a gate; rerun it if you touch a roster, a doctrine or the AI economy. Known: the bots still
  field mostly riflemen and heavy gunners, so signature units show up more in a player's army.
- **Artillery and the mortar battery LOB** (`projectileArcHeight(..., source)`): they inherited the
  tank's 0.28 arc and fired flat. `projectiles.test.ts` asserts every family's flight (flat vs lobbed,
  never stalls, passes near its target, gone after the resolve) and gunship behaviour end to end.
- Set-up page: "Your faction" and "Enemy faction" (with Random, rolled in the app, not the sim) are
  equal card rows; in Local 2 Players the second row is Player 2. Modes offered: `PLAYABLE_MODES` —
  Annihilation, Capture the Flag, Hold the Hill (Domination and Last Stand stay in the sim, unoffered).
- **Tech is cheap and says what it is** (2026-09-24): doctrines $120 / ~$170-190 / ~$240, specializations
  ~$150-180, so every game explores a path. Each research card carries a tag — cyan **NEW UNITS** (a doctrine:
  lists every unit, defense and support power it opens for this faction) or amber **UPGRADE** (a
  specialization, pick one of each pair).
- Locked troops in the Deploy tab are NAMED, grouped by the doctrine that unlocks them ("Scout ·
  Marksman / 🔒 Recon Doctrine") — never a "▮▮▮ ×2" count.

## THREE AI BRAINS (2026-09-22) — difficulty is intelligence first, stats second

`aiProfile()` in sim.ts. Before this, Normal and Hard ran the SAME brain and differed only in stats.
- **Easy**: nearest-target fire, no cover, no retreat, random purchases, and ~30% of its units
  hesitate each turn (`easyBrain` skip) — the bot a new player learns on.
- **Normal**: focus fire, cover-biased advances, crippled units retreat, reactive economy (wishlist
  ranked by cost × position so counters at the head win; saves only for research once it has 4+ units
  and is not out-built, and for a wanted unit only if affordable next turn).
- **Hard** (`tactical`): Normal plus — dodges this turn's telegraphed strikes / burn zones / gas
  (`aiDangerAt`, `aiEscapePoint`, never ends a move in one), finishes what it can kill this turn
  (measured against the CORE, not summed part HP), aims at the part that kills or disarms
  (`aiBestPart`), kites fragile ranged units, pulls defenders onto intruders near its base, throws
  grenades at clusters / dug-in targets, and runs a deterministic income-first economy.
- Stat mods on Hard were cut (HP 1.3→1.15, damage 1.28→1.12, income 1.45→1.25): the brain carries it.
- Measured by one-off self-play at EQUAL stats (`brainOverride` + `debugCommandAsAi(brain)`, 6 maps ×
  2 seeds × both seats): Hard beat Normal 19-2, Normal beat Easy 18-5, Hard beat Easy 20-3.
  `debugAiTraits` toggles single traits — that is how the old "smart economy" was caught LOSING to the
  greedy one 2-10. Rerun that comparison after any AI change; it is not a gate (≈3 min).
- RNG discipline: every roll stays exactly where it was drawn for easy/normal (short-circuit order
  preserved), so their replays and seeded tests do not shift when Hard changes.
- `aiBrains.test.ts`: Hard dodges a barrage and finishes a killable target.

## LOCAL 2 PLAYERS (hotseat, 2026-09-22)

The Skirmish set-up page's **Opponent** row (vs Bot / Local 2 Players — not a main-menu button, owner 2026-09-22) switches to a Player 2 faction row (no difficulty —
forced Normal so the enemy-side difficulty modifiers are all 1).
`sim.hotseat` (serialized) stops `endTurn` from queueing AI orders. Both players start with
`START_MONEY_PLAYER` (the bot's smaller purse is a handicap for the human, not for Player 2).
Each command phase is planned TWICE: a handoff card ("Player N — your orders"), that player plans,
End Turn ("Pass to P2") hands to the other seat, the second End Turn resolves. **Who plans first
alternates by turn parity** (P1 odd, P2 even) because the second planner watched the first on the
same screen — except after a recon pulse: `revealedTeam` records whose drone flew, that seat plans
SECOND and `enemyIntents()` returns the other human's real queued orders (no AI dry-run).
**The second planner must not see the first one's plan** (2026-09-23 audit; `smoke:hotseat`
asserts it through `__rht.overlayCounts()` and is fault-injection proven): `syncOrders` draws only
`"player"`-side orders, and
`swapSides()` drops the outgoing seat's log lines (`logSeq` / `seatLogMark`) and its armed
intent / pending deploy / build / support. What a player builds or deploys is physically on the
board and stays visible; alternation is what keeps that fair. The HUD's turn chip names the seat
("Turn 3 Player 2"), the vs-bot INTEL toast is off (the handoff card lists the other side's tech as
of the turn start instead), each seat keeps its own camera (Player 2's first view is turned half
round), and `reset()` / Play Again flip the seats back before reconfiguring and reopen on Player 1.
Log lines and battle-log sections name "Player 1" / "Player 2", never "You" / "Enemy".
Player 2 plans through the ordinary UI via `sim.swapSides()` (`flipTeams`: entities, mines,
treasury, factions, mode scores / hill holders / flag owners). The sim always RESOLVES and SAVES
unswapped (`serialize` flips back around the write), so victory = Player 1, defeat = Player 2.
No medals or points from hotseat games. Tests: `hotseat.test.ts`; `npm run smoke:hotseat` (in
`smoke:core`); `shots:gpu versus`.
