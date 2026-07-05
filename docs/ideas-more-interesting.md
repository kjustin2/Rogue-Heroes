# Ideas to Make Rogue-Heroes More Interesting

Concrete, cherry-pickable ideas that deepen tactical interest, moment-to-moment decisions, replayability, and personality. Every item hooks into a system that already exists in the codebase — verified symbols, real files. Prefer polishing/extending over new pillars: most of these are tuning-surface or one-funnel changes. Pick by number. Line references are to `game/src/game/sim.ts` unless noted; treat them as anchors, not addresses (the file is ~4200 lines and shifts).

---

## A. Tactical depth on existing verbs (cover, flanking, suppression, morale, timing)

**1. Flanking bonus off the shot geometry we already compute.** `previewAttack` (the shared body behind `previewShot`/`previewGrenade`, sim.ts:1300) already builds the muzzle→`aimPoint` line and the sim tracks every entity's `yaw`. Grant an accuracy + damage bump when the bearing from target to shooter falls *outside* the target's facing wedge (rear/side hits). Reuse `OVERWATCH_ARC_HALF` (sim.ts:114, `Math.PI/3` = the 120° cone) as the "front" wedge so the rule matches the overwatch language players already read. Hook: `estimateShotDamage` (sim.ts:2454) for the damage side, `baseAccuracySpread` (sim.ts:4175) for the accuracy side. Scope: **medium**.

**2. Cover as a legible defense stat, not just a block flag.** Today cover surfaces only as `blockedById` ("hits X first") on `ShotPreview`. Add a *partial-cover* state: when a cover part sits between shooter and target but the arced line clears its top, apply a defense/accuracy penalty instead of a full block, and print it in the `partButton` status text (hud.ts:1668) as "40% cover." Hook: `firstCoverBetweenShot` (sim.ts:2947), `ShotPreview`. Note: the air doc's item 3 reworks this same function into an elevation-aware version — if both land, do this on top of that, not in parallel. Scope: **medium**.

**3. Suppression as a soft debuff, not a kill.** A near-miss or a hit on a non-vital part sets a transient `suppressed` flag on the target for one round (widened `baseAccuracySpread`, −1 effective `moveRange`), cleared in the same per-resolve sweep that expires overwatch (`this.overwatching.clear()`). No new damage type — it rides the per-part hit data already flowing through `applyDamage`. Hook: `applyDamage`/`recomputeStatus` (damageModel.ts), the resolve loop; add the flag to `serialize()`/`restore()` (sim.ts:1461/1475) or it desyncs on resume. Scope: **medium**.

**4. Overwatch should cost something when it fires — and refund when it doesn't.** Arming overwatch already spends 1 CP and grants exactly one reaction (`overwatching.set(id, 1)`; `armOverwatch` sim.ts:1608, consumed in `checkOverwatch` sim.ts:1622). Make an *unfired* overwatch refund partial CP next turn, so holding a lane vs. spending it now is a real trade instead of a free option. Hook: `armOverwatch`, `checkOverwatch`, the per-turn CP reset. Scope: **small**.

**5. Focus-fire callouts on wounded parts.** When a target already has a destroyed part (the greyed chips in the `.part-options` list, hud.ts:984), rank the remaining `partButton`s by "finish" value and tag the part whose loss would flip `canMove` or `canShoot` false. Turns per-part damage into a readable plan instead of a guess. Hook: `targetableParts`, `recomputeStatus`, `shootState` (hud.ts:941). Scope: **small**.

**6. Morale / rout on the AI side.** When a base loses its last vehicle or `fieldUnitCount` (sim.ts:933) drops below a threshold, its surviving troops take a temporary accuracy penalty and prefer retreat pathing for a round — an emergent "we broke their line" beat built from existing status derivation. Hook: `fieldUnitCount`, the AI command phase. Scope: **medium**.

**7. Reinforcement-timing pressure via full cooldown visibility.** The Deploy tab already prints `"N rd"` on cooling-down troops (`troopDeckHtml`, hud.ts:1320) via `troopCooldown` (sim.ts:937). Show the next-available countdown on *all* troop buttons, including affordable ones, so the player sequences deploys around cooldown windows, not just cash. Hook: `troopCooldown`, `troopDeckHtml`. Scope: **small**.

**8. The second command point should be a doctrine fork, not a flat ×2.** `COMMAND_UPGRADE_COST` (sim.ts:90, `540`) currently just sets `maxCommandPoints = 2`, doubling base actions. Offer two mutually-exclusive command upgrades — "deploy twice" vs. "deploy + free overwatch/defense" — so the base build branches. Hook: the Base tab (`baseCommandBody`, hud.ts:1282), `spendCommandPoint` (damageModel.ts:853). Scope: **medium**.

**9. Melee as a deliberate risk verb.** Infantry melee-when-adjacent already exists. Make it high-damage but expose the attacker to a free reaction from any adjacent enemy (a `checkOverwatch`-style trigger), so closing distance is a gamble that flanking (idea 1) can de-risk. Hook: the melee resolve path, a reaction modeled on `checkOverwatch`. Scope: **medium**.

---

## B. Economy & risk/reward (depots, salvage, escalating stakes)

**10. Depots that ramp if never contested.** `DEPOT_INCOME` (sim.ts:122, `25`/turn via `runCaptureTick` sim.ts:2608) is flat. Make a held-and-uncontested depot's payout climb over the turns it stays yours, then reset on flip — rewarding aggressive map control and making a late-game depot steal genuinely swingy. Hook: `runCaptureTick`, `DEPOT_INCOME`. Scope: **small**.

**11. Salvage as a contested race, not a passive drip.** Vehicle-wreck salvage runs through `runSalvageTick` (sim.ts:2629). Make a fresh wreck worth the most the turn it dies and decay each round, so both sides race the corpse and killing an expensive tank spawns a mini-objective on the wreckage. Hook: `runSalvageTick`. Scope: **small**.

**12. Overextension cost on the income upgrade.** Give the income upgrade a visible risk posture: it raises base income but, for a round, degrades base resilience — e.g. temporarily forces `commandLimited` (damageModel.ts:63) or knocks a base part's HP — so greeding economy has a real defensive downside the player can see. Hook: the Base-tab upgrade, base parts, `canProduce`/`commandLimited` (damageModel.ts:63-64). Scope: **medium**.

**13. Support powers on an earned charge, not only cash+cooldown.** `SUPPORT_POWERS` (units.ts:88 — `airstrike`/`cluster`/`laser`) already gate on cost **and** a per-power `cooldown`. Add an optional per-battle charge meter that fills from damage dealt, so the big off-map hit is a payoff earned across the fight rather than a wallet check gated only by turns. Hook: `SUPPORT_POWERS`, the support-call path, `rht.commander.v1` if you want the meter to persist a session stat. Scope: **medium**.

**14. Pop-cap trade-offs.** `POP_CAP = 8` (sim.ts:72), enforced through `fieldUnitCount` (sim.ts:933) and reported by `spawnFailureReason`, is a hard wall. Let the player over-cap by one unit at the price of an income penalty (a "mercenary" slot), turning the cap into a decision instead of a stop sign. Hook: `fieldUnitCount`, `spawnFailureReason`. Scope: **small**.

**15. Bounty targets.** Flag one enemy unit each battle as "marked" (a visible chip) worth bonus salvage/income on death, nudging the player toward a specific silhouette. Hook: an entity flag + `runSalvageTick`, HUD chip. Scope: **small**.

---

## C. Replayability (seeded modifiers, daily, run structure, unlock cadence)

**16. Seeded skirmish modifiers.** The sim is already seeded and deterministic (one `Rng`, no `Math.random()`). Add a modifier deck — "cheap tanks / expensive infantry," "fog every 3 rounds," "double depot income" — rolled from the battle seed and shown pre-match. Huge replayability for near-zero art cost. Hook: the seeded `Rng`, `modes.ts`, the dynamic map-event system. Scope: **medium**.

**17. Daily challenge.** Because seeds reproduce, a date-derived seed hands everyone the same map + modifiers + starting cash for the day, with a local best-turns/score. `serialize()` already gives you resumeable state. Hook: seed derivation, `rht.commander.v1` for the local record. Scope: **medium**.

**18. Roguelike skirmish run.** String 3–5 auto-generated battles with carry-over: surviving units keep temporary veterancy (already modeled in Operation Vanguard), cash carries, difficulty ramps. A lightweight run layer over the existing battle, not a new mode engine — reuse the campaign's veterancy/requisition and `serialize()`. Hook: campaign veterancy/requisition, `serialize()`. Scope: **large**.

**19. Slow cosmetic unlock cadence tied to doctrine mastery.** Doctrine mastery (`rht.commander.v1`) + cosmetic progression (`rht.progression.v1`) already track unlocks. Gate skin packs / team palettes behind mastery milestones so there's a visible reason to keep playing — respecting the "meta unlocks slow" bar. Hook: doctrine mastery, `setModelSkin`. Scope: **small**.

**20. Map-event intensity as a chosen difficulty dial.** Sandstorm / ionstorm / barrage / collapse already fire dynamically. Expose their frequency as a pre-match slider ("calm ↔ chaotic") that also feeds a score multiplier — replayability and difficulty in one knob. Hook: the dynamic map-event system, `modes.ts`. Scope: **small**.

---

## D. Readability & juice payoffs (make outcomes feel good)

**21. Part-destruction reads at the target.** When a part crosses 0 HP and flips `canMove`/`canShoot`, punch a localized effect on *that part* (track snap, turret droop, dropped weapon) — never a full-screen flash (the owner's single most-repeated complaint class; audit FX screen-coverage). Hook: `recomputeStatus`, the renderer's per-part meshes. Scope: **medium**.

**22. Confirmed-kill / cause-and-effect callouts.** Surface a one-line combat log tying a shot to its consequence ("Rear hit → engine dead → can't move"), reinforcing that per-part damage is *legible* — the repo's explicit cause-and-effect bar. Hook: the damage-funnel events, HUD. Scope: **small**.

**23. Arc/trajectory preview line.** The preview already computes `arcHeight` (via `projectileArcHeight`) and `blockedByGround`, and the pitch aims at true elevation. Draw the predicted arc as a ghost trajectory during aiming so "will it clear the ridge?" is answered before Confirm — directly leverages `blockedByGround` on `ShotPreview`. Hook: `previewAttack`, a renderer overlay. Scope: **medium**.

**24. Overwatch cone visible on arming.** The 120° watch cone (`OVERWATCH_ARC_HALF`) is invisible until it fires. Draw the cone + radius when overwatch is set, using `overwatchFacing` (sim.ts:362) and `overwatchRadius` (sim.ts:1579), so denial zones become readable terrain the player reads and enemies visibly walk into. This same cone data is what makes AI idea 29 possible. Hook: `overwatchFacing`, `overwatchRadius`, renderer. Scope: **small**.

**25. Friendly-fire warning made loud.** `previewAttack` already sets `warningEntityId`/`warningText` (sim.ts:1350-1351) when a friendly sits in the path, and the confirm path narrates it. Escalate it to a red confirm-gate so the player can't fat-finger a shot through their own line. Hook: `ShotPreview.warningText`, the HUD confirm button (hud.ts:1804). Scope: **small**.

**26. Ground-target blast footprint as a stable decal.** `groundAimPreview` (sim.ts:767) already returns blast `radius` + `reachable` for explosive/ground shots (`queueShootAt`, sim.ts:746). Render it as a persistent ground decal while aiming so splash decisions are precise instead of eyeballed. Hook: `queueShootAt`, `groundAimPreview`, renderer decal. Scope: **small**.

---

## E. Enemy AI personality, named threats, escalation

**27. Named enemy commanders with a doctrine bias.** Give each AI base a named commander whose bias tilts its deploy deck (armor-heavy, recon-swarm, artillery-camp) — pure `TROOP_CATALOG` weighting on the AI command phase. Personality for almost no cost. Hook: the AI deploy logic, `TROOP_CATALOG` (units.ts:30). Scope: **medium**.

**28. Named elite units as mid-battle escalation.** When the AI hits a threshold, it fields one named elite (the elite/boss flag + top-of-screen HP bar already exist) with a distinct silhouette — a threat that gets buildup before it lands. Hook: the elite/boss flags, the top HP-bar path. Scope: **medium**.

**29. AI that respects overwatch and cover.** Teach the AI to path around known overwatch cones (idea 24's `overwatchFacing`/`overwatchRadius` data already exists) and to prefer cover tiles. The single biggest "the enemy feels smart" upgrade, and it makes the player's overwatch investment pay off. Hook: AI pathing, `checkOverwatch`, `firstCoverBetweenShot`. Scope: **large**.

**30. Adaptive-difficulty telegraph.** Enemy-difficulty scaling is currently invisible. Give escalating AI aggression a readable tell (a reinforcement radio beat, a "they're pushing" banner) so ramps feel authored, not cheap. Hook: the difficulty scaling, the campaign radio-beat system. Scope: **small**.

**31. Persistent named rivals in the campaign.** Operation Vanguard already tracks a veteran roster + doctrine mastery in `rht.campaign.v1`. Mirror it on the enemy: a rival commander who survives a mission returns next mission tougher, and the game remembers the grudge. Hook: `rht.campaign.v1`, the campaign mission chain. Scope: **large**.

---

## F. Air layer (only if you want the vertical axis — defer to the air doc)

**32. Don't re-derive air here — build it from the air doc.** `docs/ideas-new-unit-types-air.md` (items 1–27, continuously numbered and cherry-pickable) already fully specifies the vertical axis against real symbols: a `flying` flag + `agl` altitude added to `CombatEntity` *without* hijacking `elevation`; the terrain-cost bypass (`blockedBySteepTerrain`, `separateFromUnits`); elevation-aware cover (`firstCoverBetweenShot`); the keystone flyers-can't-capture rule (`!entity.flying` in `runCaptureTick`/`runSalvageTick`, sim.ts:2608/2629); and anti-air as a multi-sourced `vsAir` tag resolved in `estimateShotDamage` (sim.ts:2454) — **none of which exist in code yet.** If air is wanted, ship its verified vertical-slice rollout in order — **Skywatcher (`skywatch`) → Flak Track (`flak`) → Gunship (`gunship`)** (air doc item 26) — so the counter (`vsAir` + air-lane overwatch) lands before the first offensive flyer. Everything in sections A–E above is deliberately air-agnostic, so it lands with or without the vertical axis. Scope: **large** (its own project; procedural-only, zero external spend per air doc item 27).

---

## If you only build three

- **#16 Seeded skirmish modifiers** — the biggest replayability-per-effort win; the sim is already seeded and deterministic, so this is mostly a modifier deck + a pre-match panel.
- **#1 Flanking bonus** — deepens every shot using the muzzle→aim geometry `previewAttack` already computes, and rewards positioning without a new system (`estimateShotDamage` + `baseAccuracySpread`, reusing `OVERWATCH_ARC_HALF` as the facing wedge).
- **#27 Named enemy commanders** — personality and variety from pure deploy-deck weighting on the existing AI (`TROOP_CATALOG`), no art and no new pillar.

**Cost posture:** all three (and every A–E item) are procedural/logic-only — **zero external spend**: no Meshy credits, GLBs, MP3s, or fonts, and no AI text-to-image. Infantry stay procedural and the sanctioned Meshy hull scope is not widened. The real cost is sim complexity and test surface: each should ship with a regression smoke driving it through `window.__rht`, and any new transient per-unit state (suppression #3, bounty #15, charge #13) must round-trip through `serialize()`/`restore()` or resume desyncs.
