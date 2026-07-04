# New Unit Types & the Air Layer — Ideas

## Framing: the constraints any new unit must survive

Rogue-Heroes is a **pure deterministic sim** (`src/game/sim.ts`) feeding a read-only renderer and a DOM HUD. Every new unit must be a *rule exception + a matching vulnerability*, never a stat bump or a recolor — that is the only way it survives the owner's black-silhouette test and this sim's audits. Hard constraints every idea below respects:

- **Per-part damage** (`damageModel.ts`): a unit is a bag of `DamagePart[]`, each with a `role` (`core|head|weapon|mobility|armor|utility|volatile`, verified at `damageModel.ts:41`); a new unit needs a `createX` factory and `recomputeStatus`-friendly parts, not an HP integer.
- **Elevation is ground-following today.** `syncEntityElevation`/`elevationForEntityAt` (`sim.ts:~2857`/`~2861`) set `entity.elevation` from `terrainHeightAt(pos)`. Crucially, `elevationForEntityAt` **early-returns plain terrain height for anything that isn't infantry** (`sim.ts:~2863`) — only infantry get the cover-climb `Math.max`. There is **no altitude axis**: the air layer is a genuinely new dimension, not a tweak.
- **Pop cap** `POP_CAP = 8` via `fieldUnitCount(team)` (`sim.ts:72`/`886`) — air units compete for the same 8 slots, so they must earn one.
- **No enemy base-speed above the player's** (bursts OK) — a flyer's high `moveRange` is a balance liability the AI must not abuse into un-catchable kiting.
- **Distinct silhouette + moveset** per kind; **cause-and-effect must be visible** (a unit that can't act yet must show why).
- **Slow meta-progression** — air is a *late* tech unlock, never a starter; "too much from one run" is the recurring correction.
- **Determinism**: seeded `Rng`, no `Math.random()`; any new transient per-unit state must round-trip through `serialize()`/`restore()` (`sim.ts:1401`/`1422`) or resume desyncs. (The header comment at `sim.ts:395` marks which state deliberately recomputes on restore instead — match that convention.)

Numbering runs continuously 1–27 so any item can be cherry-picked.

---

## The Air Layer — how flight works in THIS sim

**1. Add a `flying` flag + `agl` altitude to `CombatEntity`; do not hijack `elevation`.**
Keep `elevation` as the ground-follow value; add a boolean `flying` and a fixed `agl` offset (e.g. `AGL = 6` in `TERRAIN_STEP` units). The composite render/aim height becomes `terrainHeightAt(pos) + agl`, so a flyer floats a constant amount over whatever is beneath it (clears mesas *and* valleys at the same visible clearance). *Hooks:* new fields on `CombatEntity`; a `flying` branch in `elevationForEntityAt` **inserted before its non-infantry early return** (`sim.ts:~2861-2863`), returning `terrainHeightAt(pos) + agl`; add both fields to `serialize()`/`restore()`. *Risk:* a flyer over a tall mesa can become un-shootable by short units — cap the *effective* target height used by AA math (item 10) or ground fire can never reach it.

**2. Flight = terrain-cost immunity, bounded by the arena (Advance Wars rule).**
Flyers ignore block height for movement and skip `blockedBySteepTerrain` (`sim.ts:1863`) and the unit-overlap push in `separateFromUnits` (`sim.ts:2835`) — cliffs, ridges, and cover are all "flat" to them. They still obey `clampToArena`/`ARENA_BOUNDS` on XY. *Hooks:* early-return the steep-terrain blocker and skip `separateFromUnits` against grounded units when `entity.flying`; leave `clampToArena` intact. *Risk:* skipping separation lets two flyers overlap in XY — keep a **flyer-vs-flyer** XY separation so silhouettes don't merge, but never re-anchor a flyer to terrain.

**3. Cover becomes elevation-aware: it blocks an attacker only at or below the cover's height.**
The single richest change — it upgrades the *whole* game, not just flyers. Rework `firstCoverBetweenShot` (`sim.ts:~2860`) so a cover profile blocks a shot only when the shooter's muzzle height falls within the cover's height span; a flyer firing *down* over waist-high sandbags is unblocked, but a tall `wall`/`base` still blocks it. *Hooks:* `firstCoverBetweenShot`, cross-referenced with `COVER_PROFILES` heights (`damageModel.ts:613`) and `muzzleHeight`/`aimHeightFor` (`sim.ts:3806`/`3821`). *Risk:* this touches grounded combat too — regression-test that low sandbags still protect *grounded* infantry from *grounded* fire (the common case), or you silently nerf all cover.

**4. LOS from a flyer clears low ground/cover for free — mostly a verification task.**
Because `firstGroundBetweenShot` (`sim.ts:3844`), `firstEntityBetweenShot` (`2881`), `firstEntityHitBySegment` (`2633`), and `firstExplosiveProximity` (`2670`) all gate against `entity.elevation … elevation+height`, a shot originating at `+agl` already sails over low ground and low units. Confirm and document this rather than adding "arc over" code. *Risk:* the *reverse* — a grounded unit shooting **up** at the flyer — must still compute a valid path to `+agl`; if `firstGroundBetweenShot` blocks the upward shot on a near hill, ground AA can't fire back. Pair with item 10.

**5. Flyers get NO defensive terrain (Fire Emblem rule).**
A flyer never gains cover/height defense — it forfeits ground-plane protection as the price of overflight. In the damage funnel `estimateShotDamage` (`sim.ts:2412`), skip the cover/aim leniency (the `cover ? 1.05` branch and any height defense) when the *target* is `flying`; likewise in `baseAccuracySpread` (`sim.ts:2735`) don't grant a flyer cover-based spread. *Risk:* none if consistent — this fragility tax is the point. Keep flyer part HP modest so they stay glass scalpels.

**6. Meter range with fragility, not fuel (skip a fuel economy).**
Fuel is a whole new economy and a serialize burden. Price flight with **high `moveRange` + low part HP + high cost** instead. Add a per-kind case to `moveRange` (`sim.ts:3743`) above ground units, but keep the flyer's `body`/`hull` core HP low so one AA burst or overwatch trigger threatens it. *Hooks:* the `moveRange` ladder, the `createX` factory part HP, `TROOP_CATALOG` cost. *Risk:* violates "no enemy speed above the player's" if the AI kites — mitigate with item 8 (overwatch tax) and by making AI flyers commit toward objectives instead of retreating infinitely.

**7. Flyers CANNOT capture — decouple mobility from scoring.**
The reason Advance Wars air isn't broken: only foot units score. Add `!entity.flying` to the eligibility filter in `runCaptureTick` (`sim.ts:2531`) and `runSalvageTick` (`2552`) (both already exclude buildings/defenses/cover). Flyers *contest/deny* a point by killing whoever stands on it, but never flip it — instant combined-arms depth with zero new art. *Risk:* skip this and the fast unit also wins the objective, making air mandatory. This is the keystone rule.

**8. Overwatch is the flyer's entry tax; whether a flyer can *set* overwatch is per-kind.**
Any moving unit already trips ground overwatch: the `overwatching` map (`sim.ts:354`), the reaction-radius `overwatchRadius` (`sim.ts:1564`, currently `projectileRange(actor) * 0.9`), and the mover-trigger loop (`sim.ts:~1558-1572`). Flyers are covered as *movers* automatically. Decide per-kind whether a flyer can itself go on overwatch — recommend gunship yes (loiter), transport/bomber no. *Risk:* if AA can't reach the air lane, flight has no reactive check — give the dedicated AA unit (item 15) a generously large `projectileRange` (hence overwatch radius) and a `vsAir` reaction.

**9. Landing / grounding as an optional verb (deferred, not v1).**
The dropship (item 13) is the only unit that *needs* to touch down; model "land" as temporarily clearing `flying` for one resolve to deliver cargo — the flyer still never scores itself. Keep this out of the first slice. *Hooks:* a transient `landed` flag added to `serialize()`/`restore()`; `elevationForEntityAt` returns terrain height while landed. *Risk:* state-leak across turns if `landed` isn't cleared — clear it in the same per-resolve sweep that expires overwatch (`this.overwatching.clear()`, `sim.ts:3179`).

**10. Anti-air as a damage-type tag in the funnel, not a bespoke unit-vs-unit check.**
Implement AA generically: a `vsAir` multiplier on weapon parts + the `flying` flag on targets, resolved inside `estimateShotDamage` (`sim.ts:2412`) alongside the existing `teamDamageScale`/`techDamageScale`/`supportDamageMultiplier` stack. Most units get `vsAir: 0` or a steep penalty (barely scratch air); the dedicated AA unit gets the top multiplier; a few ground units (item 17) get partial AA, so *any* future unit can carry some. *Hooks:* a `vsAir` field on weapon parts; the upward-shot path from item 4. *Risk:* the 40k anti-pattern — pure gating ("only AA can hit air") feels oppressive when AA is rare. Make AA **multi-sourced and cheap** so bringing it is opportunity cost, not a bespoke tax.

---

## Air Unit Roster

All procedural: a new branch in `buildSoldier` (`worldRenderer.ts:1125`) or a fresh `buildX`; leave `modelKeyFor` (`worldRenderer.ts:3085`) returning `null` so **no GLB is required**. The cheapest, clearest "this is flying" tell is a cast ground shadow via `makeProjectileShadow` (`worldRenderer.ts:2847`) under the hull, which doubles as the targeting marker.

**11. Gunship (`gunship`) — the over-cover strafer.**
*Role:* loiter-and-suppress attack flyer. *Silhouette:* stubby armored fuselage with a counter-rotating rotor disc (blow up the `droneop` overhead-rotor motif), hovering at `agl` with a hard shadow. *Moveset:* a **strafing run** — moves *through* a line and hits every ground unit under the path, ignoring low cover (item 3), as a downward burst of `bolt` rounds. Distinct verb, not a floating tank. *Hard counter:* the Flak Track (item 15) and the sniper's `vsAir` (item 16); forfeits all terrain defense (item 5). *Cost/tech:* expensive (~440), tier-3/4 `armor` or a new `air` branch off `assault`; late unlock per the slow-meta rule. *Hooks:* `moveRange`, `projectileKind` (`sim.ts:3940`), `burstCount` (`sim.ts:4055`), a new branch in `makeProjectileModel` (`worldRenderer.ts:2663`).

**12. Recon Drone → Skywatcher evolution (`skywatch`) — the mobile high-ground spotter.**
*Role:* hover-and-spot; a moving "permanent high ground" that extends team vision and marks targets for indirect fire. *Silhouette:* small quad-rotor at a higher `agl` than the gunship, thin profile — reads as a dot with a shadow. *Moveset:* almost no direct damage; projects the existing `spotter-aura` (already carried by `droneop`, `scout`, `sniper` via `packTags`; consumed in `worldRenderer.ts:1976`), letting `mortar`/`artillery`/`airstrike` fire at what it sees. *Hard counter:* any `vsAir` source; most fragile flyer (one hit). *Cost/tech:* cheap-ish (~230), `recon` branch — the natural evolution of `droneop`. *Risk:* spotting + indirect can enable un-counterable backline sniping; leash it by keeping the drone trivially killable and non-capturing (item 7).

**13. Dropship / Transport (`dropship`) — mobility-as-a-service for the scorer.**
*Role:* carries one ground unit (ideally a *capturing* infantry) across the map and disgorges it — the perfect partner to the non-capturing flyers. *Silhouette:* boxy twin-boom lifter with an open cargo bay; visibly heavier and slower than the gunship. *Moveset:* unarmed; **load/unload** verb; briefly *lands* (item 9) to deposit cargo, which then captures on foot. A protect-the-cargo mini-objective. *Hard counter:* AA murders it while loaded (double value); it can't shoot back. *Cost/tech:* moderate (~300), `support`/`armor` tier-3. *Risk:* the carried-unit reference **must** round-trip in `serialize()`/`restore()`; a dropped-cargo desync is a resume bug. *Hooks:* a `cargoId` field on `CombatEntity`, `serialize`/`restore`, the troop-spawn path (`makeTroop`, `spawnFailureReason` `sim.ts:895`).

**14. Bomber (`bomber`) — the telegraphed line-payload striker.**
*Role:* one devastating pass, then vulnerable. *Silhouette:* delta wing — the airstrike already emits a `jet` VisualEvent (handled in `main.ts:1661`, sfx in `audio.ts:74`); build a matching procedural aircraft body and reuse that motif for a real unit. *Moveset:* commits a turn early to a **telegraphed impact line** (dodgeable per the telegraph rule), then drops a row of `blast` events on resolve, reusing the existing scorch-decal + `explosiveBlast` pipeline (`sim.ts:4065`). It cannot effectively move-and-bomb; a big commitment. *Hard counter:* AA + overwatch during the slow approach; forfeits terrain defense. *Cost/tech:* high (~460), tier-4 `siege`/`ordnance`. *Risk:* area payload + air mobility is oppressive if untelegraphed — the one-turn wind-up and visible impact line are non-negotiable.

---

## Anti-Air & Counterplay

Air stays honest only if AA is **accessible and multi-sourced**, never a rare bespoke gate.

**15. Dedicated AA unit — "Flak Track" (`flak`) — strong up, weak sideways.**
*Role:* the specialist that murders air and folds to ground armor (Advance Wars AA). *Silhouette:* light wheeled/tracked chassis with an elevated multi-barrel mount that visibly *points up*. *Moveset:* top `vsAir` multiplier (item 10) and a long `projectileRange` so its overwatch radius (`= projectileRange*0.9`, `sim.ts:1564`) blankets the air lane (item 8), but low anti-ground damage and thin armor — a tank eats it. *Hard counter:* ground armor/infantry, so bringing AA is real opportunity cost. *Cost/tech:* moderate (~250), `armor` tier-2. *Hooks:* a `createVehicle`-style factory (`damageModel.ts:162`), `projectileRange`, the `vsAir` weapon tag.

**16. Give the existing Sniper effective damage vs air — the common cheap check.**
Fire Emblem's archer lesson: a common unit with bonus damage vs fliers reshapes where air dares go, no new class. Give `sniper` a moderate `vsAir` on its weapon part plus the ability to draw the upward arc (item 4). Now a single Marksman already on the field taxes careless air. *Hard counter to the counter:* snipers are fragile and slow — air can bait or bomb them. *Cost/tech:* no new unit; a `vsAir` value on the existing `sniper` in `TROOP_CATALOG`/its factory. *Risk:* don't overtune — the sniper should *discourage* hovering, not delete flyers.

**17. Partial AA on `heavy` and `turret` — multi-source the counter.**
Per item 10, give the `heavy` gunner and the static `turret` a small `vsAir` (they can *look up*, not specialize), so an army without dedicated AA still isn't helpless and static defenses gain a reason to exist against air. *Hooks:* `vsAir` on `heavy`'s `rifle` part and `turret`'s gun part; the upward-arc LOS check. *Risk:* if too many units carry `vsAir`, the Flak Track loses its niche — keep partial values well below the specialist's.

**18. Terrain interplay: tall structures as air denial.**
Tall `wall`/`base` structures still block flyer LOS (item 3), so a defender can raise a screen the gunship can't shoot *through* even from above — combined-arms map authoring. Optionally add a soft "flak nest" cover profile that grants nearby *ground* units a `vsAir` aura. *Hooks:* `COVER_PROFILES` (`damageModel.ts:613`), the `firstCoverBetweenShot` height check, an aura tag on the pack (like `medic-aura`). *Risk:* keep it readable — the player must see *why* the gunship's shot was blocked (cause-and-effect bar).

**19. EW / pin as the clean telegraphed hard-counter (Into the Breach lesson).**
Give the air advantage one clean answer: a support power or the jammer (item 21) that projects a zone which **grounds/pins flyers** (no move/act, or loss of overflight bonuses) inside it — the solvable-puzzle valve. *Hooks:* a new `SupportPowerKind` in `SUPPORT_POWERS` (`units.ts`) or the jammer's aura; a `pinned` transient flag on `CombatEntity` that round-trips in `serialize` and clears each resolve. *Risk:* transient-state leak — clear it in the same per-resolve sweep as overwatch (`sim.ts:3179`).

---

## Non-Air New Unit Types (roster depth without flight)

**20. Deployable Sapper-Builder evolution — author the battlefield.**
Extend `sapper` (or add a `builder`) to spend an action *creating* cover: drop `sandbag`/`barricade` cover (both already exist in `CoverKind` + `COVER_PROFILES`) or a temporary `turret`. Turns a mobile unit into fixed map control, reusing the scenario cover system entirely. *Silhouette/moveset:* kneels and plants a structure (visible build animation). *Counter:* artillery/bomber flatten the deployables. *Hooks:* spawn a `cover`/`defense` entity mid-battle via the generic build path (`buildStructureFor`, guarded by `spawnFailureReason` `sim.ts:895`), `DEFENSE_CATALOG`. *Cost/tech:* `ordnance` tier-2.

**21. EW / Jammer (`jammer`) — information & reaction denial.**
*Role:* suppresses enemy overwatch, blocks their vision/spotting, and can pin air (item 19) in a radius — the direct counter to the skywatcher and the overwatch-AA meta. *Silhouette:* antenna/dish backpack rig, hunched. *Moveset:* projects a jam aura (reuse the pack-aura plumbing that carries `spotter-aura`); no direct damage. *Counter:* fragile, and must move into range to matter. *Hooks:* a new pack `tag` read by the overwatch/spotting checks (`overwatching` map, the aura consumer at `worldRenderer.ts:1976`); alternatively a `SUPPORT_POWERS` entry. *Cost/tech:* `support` tier-3. *Risk:* denial stacking — cap aura radius, single-source it.

**22. Shield / Guardian (`guardian`) — mobile cover, the inverse of the flyer.**
*Role:* grants a one-hit bubble (or damage-share) to adjacent allies (Into the Breach shield-projector). Positioning becomes protection. *Silhouette:* riot-shield/barrier frame with a translucent shell that *pops* on hit (clear readable channel). *Moveset:* slow; parks beside a key unit. *Counter:* splash/`artillery` bypasses single-target shields; the `striker`'s melee forces it to commit. *Hooks:* a `shield` utility part in the `createX` factory + a pre-damage intercept in `applyDamage` (`damageModel.ts:749`); the pop is a `blast`/`impact` VisualEvent. *Cost/tech:* `support`/`assault` tier-3. *Risk:* the "bubble already spent" state must round-trip in `serialize`; a stale-bubble desync is a resume bug.

**23. Indirect variant — Rocket Battery (`rockets`) — area denial that can't move-and-fire.**
A heavier `mortar`/`artillery` cousin: min-range lockout, cannot move and fire the same turn, telegraphed impact a turn early, arcs over walls. Soft counter to clustered units and grounded AA nests. *Silhouette:* multi-tube launcher rack, distinct from the single-barrel artillery. *Counter:* fast flankers close the min-range gap; its telegraph makes it dodgeable. *Hooks:* a min-range case in `projectileRange`, `explosiveBlast`, `burstCount`, a move-lock enforced in the command phase. *Cost/tech:* `siege` tier-3, high cost (~460).

**24. Push/Pull disruptor — "Concussion Striker" (`shover`) — the board-state verb.**
The single richest expansion to a tactics sim (ItB's whole identity): an attack that *forces movement* — shove a unit off a cliff (into `blockedBySteepTerrain` fall territory), off an objective, or into a friendly's fire lane. *Silhouette:* riot/hammer melee frame, distinct from the `striker`'s Arc Blade. *Moveset:* a short-range shove resolved as **intentional displacement**, reusing the push math in `separateFromUnits` (`sim.ts:2835`) as a directed nudge rather than an overlap fix. *Counter:* ranged units kite it; heavy vehicles resist the push. *Hooks:* a displacement step in the melee path (`meleeRange`/`meleeStrikeMultiplier`, `sim.ts:3769`/`3777`), fall damage from `terrainHeightAt` deltas. *Risk:* forced movement must be fully deterministic and serialize-safe — test that a shove off a mesa reproduces on resume.

**25. Ground spotter — cheap vision-economy unit.**
A cheap, high-`moveRange`, low-combat foot unit that extends team vision and marks for indirect — the ground twin of the skywatcher (item 12), keeping the information economy playable without committing to air tech. Likely a tuning variant of `scout` with a stronger `spotter-aura`. *Counter:* dies to anything it spots for. *Hooks:* a `TROOP_CATALOG` entry or `scout` retune, the `spotter-aura` tag. *Cost/tech:* `recon` tier-1, cheap (~110).

---

## Rollout order & cost posture

**26. Build these three as the vertical slice, in order — prove the air axis end-to-end before expanding:**

1. **Skywatcher (item 12)** — *first*, the lowest-risk way to stand up the whole altitude machinery (the `flying` flag, `agl` in `elevationForEntityAt`, the steep-terrain bypass, the serialize round-trip) with almost no combat balance to get wrong. It evolves an existing unit, so render work is minimal. Validates items 1, 2, 7, and `serialize`/`restore`.
2. **Flak Track (item 15)** — *second and immediately*, so air never ships without its counter. Stands up the `vsAir` tag in `estimateShotDamage` (item 10) and air-lane overwatch (item 8). Never let a flyer reach players before its hard counter exists.
3. **Gunship (item 11)** — *third*, the first *offensive* flyer, once spotting, altitude, AA, and elevation-aware cover (item 3) are proven. It most needs the over-cover and no-terrain-defense rules working correctly.

Defer the bomber, dropship/landing, and the non-air archetypes until the triangle (air ↔ AA ↔ ground) is verified in a smoke.

**27. Cost posture — procedural, zero external spend.**
Every unit here is **procedural mesh work** (`buildSoldier`-style branches or a `buildX` in `worldRenderer.ts`) with silent-skip fallbacks: **no Meshy credits, no GLBs, no MP3s, no fonts.** Air units leave `modelKeyFor` returning `null` and stay procedural, consistent with the repo's "infantry/characters stay procedural" rule — and nothing here proposes AI text-to-image. The sanctioned Meshy scope (hard-surface vehicle/structure/prop hulls) is **not** widened by any idea in this doc; item 15's Flak Track and any air *vehicle* could optionally reuse that scope later, but must ship procedural-first with a fallback, so dev/CI never depend on an asset. The real cost is **sim complexity and test surface**: the altitude axis touches `elevationForEntityAt`, `blockedBySteepTerrain`, `separateFromUnits`, `firstCoverBetweenShot`/`firstGroundBetweenShot`, `estimateShotDamage`, `runCaptureTick`/`runSalvageTick`, the overwatch map, and `serialize()`/`restore()`. Budget the engineering there, add a regression smoke that flies a Skywatcher over a mesa and asserts it (a) clears the ridge, (b) cannot capture, and (c) round-trips through save/reload, and keep `window.__rht` in sync so the smokes can drive the new `flying` state.