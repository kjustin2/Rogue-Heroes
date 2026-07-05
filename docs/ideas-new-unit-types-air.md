# New Unit Types & the Air Layer — Ideas

## Framing: the constraints any new unit must survive

Rogue-Heroes is a **pure deterministic sim** (`src/game/sim.ts`) feeding a read-only renderer and a DOM HUD. Every new unit must be a *rule exception + a matching vulnerability*, never a stat bump or a recolor — that is the only way it survives the owner's black-silhouette test and this sim's audits. Symbol names below are real; line numbers are omitted on purpose because they drift — grep the symbol. Hard constraints every idea respects:

- **Per-part damage** (`damageModel.ts`): a unit is a bag of `DamagePart[]`, each with a `role` (`core|head|weapon|mobility|armor|utility|volatile`); a new unit needs a `createX` factory and `recomputeStatus`-friendly parts, not an HP integer.
- **Elevation is ground-following today.** `syncEntityElevation`/`elevationForEntityAt` (`sim.ts`) set `entity.elevation` from `terrainHeightAt(pos)`. Crucially, `elevationForEntityAt` **early-returns plain terrain height for anything that is `"cover"` or not infantry** (`if (entity.kind === "cover" || !isInfantryKind(entity.kind)) return elevation;`) — only infantry get the cover-climb `Math.max`. There is **no altitude axis**: the air layer is a genuinely new dimension, not a tweak.
- **Pop cap** `POP_CAP = 8` via `fieldUnitCount(team)` (`sim.ts`) — air units compete for the same 8 slots, so they must earn one.
- **No enemy base-speed above the player's** (bursts OK) — a flyer's high `moveRange` is a balance liability the AI must not abuse into un-catchable kiting.
- **Distinct silhouette + moveset** per kind; **cause-and-effect must be visible** (a unit that can't act yet must show why).
- **Slow meta-progression** — air is a *late* tech unlock, never a starter; "too much from one run" is the recurring correction.
- **Determinism**: seeded `Rng`, no `Math.random()`; any new transient per-unit state must round-trip through `serialize()`/`restore()` (`sim.ts`) or resume desyncs. (A header comment in `sim.ts` marks which state deliberately *recomputes* on restore instead of serializing — match that convention rather than growing the save blob.)

Numbering runs continuously **1–44** so any item can be cherry-picked. Items **1–27** are the original design; items **28–44** are the requested depth pass on **Deployment (A)**, **Capabilities in Play (B)**, and **Targeting & Shooting Down Air (C)**, all grounded in the *real* deploy/shoot code.

---

## The Air Layer — how flight works in THIS sim

**1. Add a `flying` flag + `agl` altitude to `CombatEntity`; do not hijack `elevation`.**
Keep `elevation` as the ground-follow value; add a boolean `flying` and a fixed `agl` offset (propose `AGL = 6` in the same units as `terrainHeightAt`). The composite render/aim height becomes `terrainHeightAt(pos) + agl`, so a flyer floats a constant amount over whatever is beneath it (clears mesas *and* valleys at the same visible clearance). *Hooks:* new fields on `CombatEntity`; a `flying` branch **inserted before the `cover`/non-infantry early return** in `elevationForEntityAt`, returning `terrainHeightAt(pos) + agl`; add both fields to `serialize()`/`restore()`. *Risk:* a flyer over a tall mesa can become un-shootable by short units — cap the *effective* target height used by AA math (item 10) or ground fire can never reach it.

**2. Flight = terrain-cost immunity, bounded by the arena (Advance Wars rule).**
Flyers ignore block height for movement and skip `blockedBySteepTerrain` and the unit-overlap push in `separateFromUnits` — cliffs, ridges, and cover are all "flat" to them. They still obey `clampToArena`/`ARENA_BOUNDS` on XY. *Hooks:* early-return the steep-terrain blocker and skip `separateFromUnits` against grounded units when `entity.flying`; leave `clampToArena` intact. *Risk:* skipping separation lets two flyers overlap in XY — keep a **flyer-vs-flyer** XY separation so silhouettes don't merge, but never re-anchor a flyer to terrain.

**3. Cover becomes elevation-aware: it blocks an attacker only at or below the cover's height.**
The single richest change — it upgrades the *whole* game, not just flyers. Rework `firstCoverBetweenShot` (`sim.ts`) so a cover profile blocks a shot only when the shooter's muzzle height falls within the cover's height span; a flyer firing *down* over waist-high sandbags is unblocked, but a tall `wall`/`base` still blocks it. *Hooks:* `firstCoverBetweenShot`, cross-referenced with `COVER_PROFILES` heights (`damageModel.ts`) and `muzzleHeight`/`aimHeightFor` (`sim.ts`). *Risk:* this touches grounded combat too — regression-test that low sandbags still protect *grounded* infantry from *grounded* fire (the common case), or you silently nerf all cover.

**4. LOS from a flyer clears low ground/cover for free — mostly a verification task.**
Because `firstGroundBetweenShot`, `firstEntityBetweenShot`, `firstEntityHitBySegment`, and `firstExplosiveProximity` all gate against an entity's `elevation … elevation+height`, a shot originating at `+agl` already sails over low ground and low units. Confirm and document this rather than adding "arc over" code. *Risk:* the *reverse* — a grounded unit shooting **up** at the flyer — must still compute a valid path to `+agl`; if `firstGroundBetweenShot` blocks the upward shot on a near hill, ground AA can't fire back. Pair with item 10.

**5. Flyers get NO defensive terrain (Fire Emblem rule).**
A flyer never gains cover/height defense — it forfeits ground-plane protection as the price of overflight. In the damage funnel `estimateShotDamage` (`sim.ts`), skip the cover/aim leniency (the `cover` bonus branch and any height defense) when the *target* is `flying`; likewise in `baseAccuracySpread` don't grant a flyer cover-based spread. *Risk:* none if consistent — this fragility tax is the point. Keep flyer part HP modest so they stay glass scalpels.

**6. Meter range with fragility, not fuel (skip a fuel economy).**
Fuel is a whole new economy and a serialize burden. Price flight with **high `moveRange` + low part HP + high cost** instead. Add a per-kind case to `moveRange` (`sim.ts`) above ground units, but keep the flyer's `body`/`hull` core HP low so one AA burst or overwatch trigger threatens it. *Hooks:* the `moveRange` ladder, the `createX` factory part HP, `TROOP_CATALOG` cost. *Risk:* violates "no enemy speed above the player's" if the AI kites — mitigate with item 8 (overwatch tax) and by making AI flyers commit toward objectives instead of retreating infinitely.

**7. Flyers CANNOT capture — decouple mobility from scoring.**
The reason Advance Wars air isn't broken: only foot units score. Add `!entity.flying` to the eligibility filter in `runCaptureTick` and `runSalvageTick` (`sim.ts`; both already exclude buildings/defenses/cover). Flyers *contest/deny* a point by killing whoever stands on it, but never flip it — instant combined-arms depth with zero new art. *Risk:* skip this and the fast unit also wins the objective, making air mandatory. This is the keystone rule.

**8. Overwatch is the flyer's entry tax; whether a flyer can *set* overwatch is per-kind.**
Any moving unit already trips ground overwatch: the `overwatching` map, the reaction radius `overwatchRadius(actor) = projectileRange(actor) * 0.9` (`sim.ts`), and the mover-trigger `checkOverwatch(mover)` call in the move/resolve path. Flyers are covered as *movers* automatically. Decide per-kind whether a flyer can itself go on overwatch — recommend gunship yes (loiter), transport/bomber no. *Risk:* if AA can't reach the air lane, flight has no reactive check — give the dedicated AA unit (item 15) a generously large `projectileRange` (hence overwatch radius) and a `vsAir` reaction.

**9. Landing / grounding as an optional verb (deferred, not v1).**
The dropship (item 13) is the only unit that *needs* to touch down; model "land" as temporarily clearing `flying` for one resolve to deliver cargo — the flyer still never scores itself. Keep this out of the first slice. *Hooks:* a transient `landed` flag added to `serialize()`/`restore()`; `elevationForEntityAt` returns terrain height while landed. *Risk:* state-leak across turns if `landed` isn't cleared — clear it in the same per-resolve sweep that expires overwatch (the end-of-resolve `this.overwatching.clear()`).

**10. Anti-air as a damage-type tag in the funnel, not a bespoke unit-vs-unit check.**
Implement AA generically: a `vsAir` multiplier on weapon parts + the `flying` flag on targets, resolved inside `estimateShotDamage` (`sim.ts`) alongside the existing `teamDamageScale`/`techDamageScale`/`supportDamageMultiplier` stack. Most units get `vsAir: 0` or a steep penalty (barely scratch air); the dedicated AA unit gets the top multiplier; a few ground units (item 17) get partial AA, so *any* future unit can carry some. *Hooks:* a `vsAir` field on weapon parts; the upward-shot path from item 4. *Risk:* the 40k anti-pattern — pure gating ("only AA can hit air") feels oppressive when AA is rare. Make AA **multi-sourced and cheap** so bringing it is opportunity cost, not a bespoke tax.

---

## Air Unit Roster

All procedural: a new branch in `buildSoldier` (`worldRenderer.ts`) or a fresh `buildX`; leave `modelKeyFor` (`worldRenderer.ts`) returning `null` so **no GLB is required**. The cheapest, clearest "this is flying" tell is a cast ground shadow via `makeProjectileShadow` (`worldRenderer.ts`) under the hull, which doubles as the targeting marker.

**11. Gunship (`gunship`) — the over-cover strafer.**
*Role:* loiter-and-suppress attack flyer. *Silhouette:* stubby armored fuselage with a counter-rotating rotor disc (blow up the `droneop` overhead-rotor motif), hovering at `agl` with a hard shadow. *Moveset:* a **strafing run** — moves *through* a line and hits every ground unit under the path, ignoring low cover (item 3), as a downward burst of `bolt` rounds. Distinct verb, not a floating tank. *Hard counter:* the Flak Track (item 15) and the sniper's `vsAir` (item 16); forfeits all terrain defense (item 5). *Cost/tech:* expensive (~440), tier-3/4 `armor` or a new `air` branch off `assault`; late unlock per the slow-meta rule. *Hooks:* `moveRange`, `projectileKind`, `burstCount` (`sim.ts`), a new branch in `makeProjectileModel` (`worldRenderer.ts`).

**12. Recon Drone → Skywatcher evolution (`skywatch`) — the mobile high-ground spotter.**
*Role:* hover-and-spot; a moving "permanent high ground" that extends team vision and marks targets for indirect fire. *Silhouette:* small quad-rotor at a higher `agl` than the gunship, thin profile — reads as a dot with a shadow. *Moveset:* almost no direct damage; projects the existing `spotter-aura` (carried today by `droneop`/`scout`/`sniper` as a **part `tag`** — `part.tags?.includes("spotter-aura")` in `sim.ts`, drawn as an aura ring in `worldRenderer.ts`), letting `mortar`/`artillery`/`airstrike` fire at what it sees. *Hard counter:* any `vsAir` source; most fragile flyer (one hit). *Cost/tech:* cheap-ish (~230), `recon` branch — the natural evolution of `droneop`. *Risk:* spotting + indirect can enable un-counterable backline sniping; leash it by keeping the drone trivially killable and non-capturing (item 7).

**13. Dropship / Transport (`dropship`) — mobility-as-a-service for the scorer.**
*Role:* carries one ground unit (ideally a *capturing* infantry) across the map and disgorges it — the perfect partner to the non-capturing flyers. *Silhouette:* boxy twin-boom lifter with an open cargo bay; visibly heavier and slower than the gunship. *Moveset:* unarmed; **load/unload** verb; briefly *lands* (item 9) to deposit cargo, which then captures on foot. A protect-the-cargo mini-objective. *Hard counter:* AA murders it while loaded (double value); it can't shoot back. *Cost/tech:* moderate (~300), `support`/`armor` tier-3. *Risk:* the carried-unit reference **must** round-trip in `serialize()`/`restore()`; a dropped-cargo desync is a resume bug. *Hooks:* a `cargoId` field on `CombatEntity`, `serialize`/`restore`, the troop-spawn path (`createTroop`/`makeTroop`, `spawnFailureReason` `sim.ts`).

**14. Bomber (`bomber`) — the telegraphed line-payload striker.**
*Role:* one devastating pass, then vulnerable. *Silhouette:* delta wing — the airstrike already emits a `jet` VisualEvent (handled in `main.ts`, sfx in `audio.ts`); build a matching procedural aircraft body and reuse that motif for a real unit. *Moveset:* commits a turn early to a **telegraphed impact line** (dodgeable per the telegraph rule), then drops a row of `blast` events on resolve, reusing the existing scorch-decal + `explosiveBlast` pipeline (`sim.ts`). It cannot effectively move-and-bomb; a big commitment. *Hard counter:* AA + overwatch during the slow approach; forfeits terrain defense. *Cost/tech:* high (~460), tier-4 `siege`/`ordnance`. *Risk:* area payload + air mobility is oppressive if untelegraphed — the one-turn wind-up and visible impact line are non-negotiable.

---

## Anti-Air & Counterplay

Air stays honest only if AA is **accessible and multi-sourced**, never a rare bespoke gate.

**15. Dedicated AA unit — "Flak Track" (`flak`) — strong up, weak sideways.**
*Role:* the specialist that murders air and folds to ground armor (Advance Wars AA). *Silhouette:* light wheeled/tracked chassis with an elevated multi-barrel mount that visibly *points up*. *Moveset:* top `vsAir` multiplier (item 10) and a long `projectileRange` so its overwatch radius (`= projectileRange * 0.9`) blankets the air lane (item 8), but low anti-ground damage and thin armor — a tank eats it. *Hard counter:* ground armor/infantry, so bringing AA is real opportunity cost. *Cost/tech:* moderate (~250), `armor` tier-2. *Hooks:* a `createVehicle`-style factory (`damageModel.ts`), `projectileRange`, the `vsAir` weapon tag.

**16. Give the existing Sniper effective damage vs air — the common cheap check.**
Fire Emblem's archer lesson: a common unit with bonus damage vs fliers reshapes where air dares go, no new class. Give `sniper` a moderate `vsAir` on its weapon part plus the ability to draw the upward arc (item 4). Now a single Marksman already on the field taxes careless air. *Hard counter to the counter:* snipers are fragile and slow — air can bait or bomb them. *Cost/tech:* no new unit; a `vsAir` value on the existing `sniper` in `TROOP_CATALOG`/its factory. *Risk:* don't overtune — the sniper should *discourage* hovering, not delete flyers.

**17. Partial AA on `heavy` and `turret` — multi-source the counter.**
Per item 10, give the `heavy` gunner and the static `turret` a small `vsAir` (they can *look up*, not specialize), so an army without dedicated AA still isn't helpless and static defenses gain a reason to exist against air. *Hooks:* `vsAir` on `heavy`'s `rifle` part and `turret`'s gun part; the upward-arc LOS check. *Risk:* if too many units carry `vsAir`, the Flak Track loses its niche — keep partial values well below the specialist's.

**18. Terrain interplay: tall structures as air denial.**
Tall `wall`/`base` structures still block flyer LOS (item 3), so a defender can raise a screen the gunship can't shoot *through* even from above — combined-arms map authoring. Optionally add a soft "flak nest" cover profile that grants nearby *ground* units a `vsAir` aura. *Hooks:* `COVER_PROFILES` (`damageModel.ts`), the `firstCoverBetweenShot` height check, an aura part `tag` (like `medic-aura`). *Risk:* keep it readable — the player must see *why* the gunship's shot was blocked (cause-and-effect bar).

**19. EW / pin as the clean telegraphed hard-counter (Into the Breach lesson).**
Give the air advantage one clean answer: a support power or the jammer (item 21) that projects a zone which **grounds/pins flyers** (no move/act, or loss of overflight bonuses) inside it — the solvable-puzzle valve. *Hooks:* a new `SupportPowerKind` in `SUPPORT_POWERS` (`units.ts`) or the jammer's aura; a `pinned` transient flag on `CombatEntity` that round-trips in `serialize` and clears each resolve. *Risk:* transient-state leak — clear it in the same per-resolve sweep as overwatch.

---

## Non-Air New Unit Types (roster depth without flight)

**20. Deployable Sapper-Builder evolution — author the battlefield.**
Extend `sapper` (or add a `builder`) to spend an action *creating* cover: drop `sandbag`/`barricade` cover (both already exist in `CoverKind` + `COVER_PROFILES`) or a temporary `turret`. Turns a mobile unit into fixed map control, reusing the scenario cover system entirely. *Silhouette/moveset:* kneels and plants a structure (visible build animation). *Counter:* artillery/bomber flatten the deployables. *Hooks:* spawn a `cover`/`defense` entity mid-battle via the generic build path (`buildStructureFor`, guarded by `spawnFailureReason` `sim.ts`), `DEFENSE_CATALOG`. *Cost/tech:* `ordnance` tier-2.

**21. EW / Jammer (`jammer`) — information & reaction denial.**
*Role:* suppresses enemy overwatch, blocks their vision/spotting, and can pin air (item 19) in a radius — the direct counter to the skywatcher and the overwatch-AA meta. *Silhouette:* antenna/dish backpack rig, hunched. *Moveset:* projects a jam aura (reuse the part-`tag` aura plumbing that carries `spotter-aura`); no direct damage. *Counter:* fragile, and must move into range to matter. *Hooks:* a new pack `tag` read by the overwatch/spotting checks (the `overwatching` map, the aura consumer in `worldRenderer.ts`); alternatively a `SUPPORT_POWERS` entry. *Cost/tech:* `support` tier-3. *Risk:* denial stacking — cap aura radius, single-source it.

**22. Shield / Guardian (`guardian`) — mobile cover, the inverse of the flyer.**
*Role:* grants a one-hit bubble (or damage-share) to adjacent allies (Into the Breach shield-projector). Positioning becomes protection. *Silhouette:* riot-shield/barrier frame with a translucent shell that *pops* on hit (clear readable channel). *Moveset:* slow; parks beside a key unit. *Counter:* splash/`artillery` bypasses single-target shields; the `striker`'s melee forces it to commit. *Hooks:* a `shield` utility part in the `createX` factory + a pre-damage intercept in `applyDamage` (`damageModel.ts`); the pop is a `blast`/`impact` VisualEvent. *Cost/tech:* `support`/`assault` tier-3. *Risk:* the "bubble already spent" state must round-trip in `serialize`; a stale-bubble desync is a resume bug.

**23. Indirect variant — Rocket Battery (`rockets`) — area denial that can't move-and-fire.**
A heavier `mortar`/`artillery` cousin: min-range lockout, cannot move and fire the same turn, telegraphed impact a turn early, arcs over walls. Soft counter to clustered units and grounded AA nests. *Silhouette:* multi-tube launcher rack, distinct from the single-barrel artillery. *Counter:* fast flankers close the min-range gap; its telegraph makes it dodgeable. *Hooks:* a min-range case in `projectileRange`, `explosiveBlast`, `burstCount`, a move-lock enforced in the command phase. *Cost/tech:* `siege` tier-3, high cost (~460).

**24. Push/Pull disruptor — "Concussion Striker" (`shover`) — the board-state verb.**
The single richest expansion to a tactics sim (ItB's whole identity): an attack that *forces movement* — shove a unit off a cliff (into `blockedBySteepTerrain` fall territory), off an objective, or into a friendly's fire lane. *Silhouette:* riot/hammer melee frame, distinct from the `striker`'s Arc Blade. *Moveset:* a short-range shove resolved as **intentional displacement**, reusing the push math in `separateFromUnits` (`sim.ts`) as a directed nudge rather than an overlap fix. *Counter:* ranged units kite it; heavy vehicles resist the push. *Hooks:* a displacement step in the melee path (`meleeRange`/`meleeStrikeMultiplier`, `sim.ts`), fall damage from `terrainHeightAt` deltas. *Risk:* forced movement must be fully deterministic and serialize-safe — test that a shove off a mesa reproduces on resume.

**25. Ground spotter — cheap vision-economy unit.**
A cheap, high-`moveRange`, low-combat foot unit that extends team vision and marks for indirect — the ground twin of the skywatcher (item 12), keeping the information economy playable without committing to air tech. Likely a tuning variant of `scout` with a stronger `spotter-aura` part `tag`. *Counter:* dies to anything it spots for. *Hooks:* a `TROOP_CATALOG` entry or `scout` retune, the `spotter-aura` `tag`. *Cost/tech:* `recon` tier-1, cheap (~110).

---

## Rollout order & cost posture

**26. Build these three as the vertical slice, in order — prove the air axis end-to-end before expanding:**

1. **Skywatcher (item 12)** — *first*, the lowest-risk way to stand up the whole altitude machinery (the `flying` flag, `agl` in `elevationForEntityAt`, the steep-terrain bypass, the serialize round-trip) with almost no combat balance to get wrong. It evolves an existing unit, so render work is minimal. Validates items 1, 2, 7, and `serialize`/`restore`.
2. **Flak Track (item 15)** — *second and immediately*, so air never ships without its counter. Stands up the `vsAir` tag in `estimateShotDamage` (item 10) and air-lane overwatch (item 8). Never let a flyer reach players before its hard counter exists.
3. **Gunship (item 11)** — *third*, the first *offensive* flyer, once spotting, altitude, AA, and elevation-aware cover (item 3) are proven. It most needs the over-cover and no-terrain-defense rules working correctly.

Defer the bomber, dropship/landing, and the non-air archetypes until the triangle (air ↔ AA ↔ ground) is verified in a smoke.

**27. Cost posture — procedural, zero external spend.**
Every unit here is **procedural mesh work** (`buildSoldier`-style branches or a `buildX` in `worldRenderer.ts`) with silent-skip fallbacks: **no Meshy credits, no GLBs, no MP3s, no fonts, no AI text-to-image.** Air units leave `modelKeyFor` returning `null` and stay procedural, consistent with the repo's "infantry/characters stay procedural" rule. The sanctioned Meshy scope (hard-surface vehicle/structure/prop hulls) is **not** widened by any idea in this doc; item 15's Flak Track and any air *vehicle* could optionally reuse that scope later, but must ship procedural-first with a fallback, so dev/CI never depend on an asset. The real cost is **sim complexity and test surface**: the altitude axis touches `elevationForEntityAt`, `blockedBySteepTerrain`, `separateFromUnits`, `firstCoverBetweenShot`/`firstGroundBetweenShot`, `estimateShotDamage`, `runCaptureTick`/`runSalvageTick`, the overwatch map, and `serialize()`/`restore()`. Budget the engineering there, add a regression smoke that flies a Skywatcher over a mesa and asserts it (a) clears the ridge, (b) cannot capture, and (c) round-trips through save/reload, and keep `window.__rht` in sync so the smokes can drive the new `flying` state.

---

# A. Deployment — how each air unit enters the base-deck flow

This section maps every air unit onto the **exact deployment path that already ships**, so air deploys through the same UI and the same gate chain as any troop — no bespoke spawner. The reference flow (all symbols real):

> The Home Base (`kind === "base"`) is the only deployer and spends one **command point** to do it. A base regenerates `commandPoints` up to `maxCommandPoints` each turn, starting at **1**; the **Base** deck tab can pay `COMMAND_UPGRADE_COST = 540` (`sim.ts`) to raise `base.maxCommandPoints = 2` — so a base does **at most 2 actions/turn**, and deploy/tech/defense/support/upgrade all draw from that same pool via `spendCommandPoint(base)`.
>
> `spawnFailureReason(base, kind)` (`sim.ts`) is the single gate; it returns the **first** failing reason (else `undefined` = deployable), in this exact order: (1) base is your Home Base, `status.alive`, and `status.canProduce`; (2) **tech gate** `spec.tech && !isTechUnlocked(base, spec.tech)`; (3) **cooldown** `this.troopCooldown(base, kind) > 0` (from `base.spawnCooldowns[kind]`); (4) **pop cap** `this.fieldUnitCount(base.team) >= POP_CAP` (`POP_CAP = 8`; `fieldUnitCount` counts only alive **field** units — not buildings/defenses/cover); (5) **cost** `this.money(base.team) < spec.cost`; (6) **CP** `base.commandPoints <= 0`. `queueSpawnTroop(kind)` → `spawnTroopFor` (`sim.ts`) re-checks, then `spendCommandPoint(base)`, `addMoney(team, -spec.cost)`, `createTroop(kind, base)` (via `makeTroop` at `freeSpawnNear(base)`), sets **`unit.commandPoints = 0`** (the fresh unit *holds* one turn), and sets `base.spawnCooldowns[kind] = spec.cooldown`. The **Deploy** tab (`troopDeckHtml`, `hud.ts`) renders one `data-spawn="<kind>"` button per `TROOP_CATALOG` entry; a tech-locked kind renders as a **CLASSIFIED** button (redacted bar + doctrine name, no cost/role) until `isTechUnlocked`, then shows label + a sub-line that is the **cooldown (`"N rd"`) when on cooldown, else the price (`"$cost"`)**.

**Design rule for air: no special spawner in v1.** Air units are ordinary `TROOP_CATALOG` entries with `flying: true` and an `agl`; they deploy from the same **Deploy** tab, cost 1 CP, obey the same 6-step gate, occupy one of the 8 `POP_CAP` slots, appear at `freeSpawnNear(base)` (then get `terrainHeightAt(pos) + agl` applied by the new `elevationForEntityAt` branch, item 1), and **hold their first turn** (`commandPoints = 0`) — the fresh-flyer hover, visibly idle over the base, *is* the cause-and-effect tell that it can't act yet. An "airfield/launch pad" structure is a **deferred** idea only (item 32c), never a v1 requirement.

**28. Shared air-deploy contract (applies to every flyer).**
- **Deck placement:** append to `TROOP_CATALOG` (`units.ts`) so each air unit is a `data-spawn` button on the Deploy tab; **tech-gated**, so each first appears as a **CLASSIFIED** reveal until its doctrine is researched (a deliberate late-game moment). No new tab — air lives beside infantry/vehicles.
- **CP & economy:** exactly 1 CP per deploy via `spendCommandPoint(base)`; with the 540-cost 2nd CP (the Base tab upgrade) a base can deploy an air unit *and* one other action, or two units, in a turn. Air's high `cost` (below) is the throttle, not a new resource.
- **Pop cap:** every flyer counts toward `POP_CAP = 8` (`fieldUnitCount`), so committing to air means fewer boots on objectives — the intended tension, since flyers can't capture (item 7).
- **Where it appears + hold-one-turn:** `createTroop` places it at `freeSpawnNear(base)` with `commandPoints = 0`; it hovers at `agl` over the base and **cannot act until next turn**. Do **not** special-case air to act immediately — that would break the visible "deployed, holding" convention.
- **Cooldown:** each air kind sets `base.spawnCooldowns[kind] = spec.cooldown`; expensive flyers get long cooldowns so you can't chain-spawn an air wing.

**29. Skywatcher (`skywatch`) deploy — the drone-op evolution.**
- **Gate:** `tech: "recon"` — appears as CLASSIFIED until Recon is researched (natural upgrade past `droneop`/`scout`). **Cost ~230, cooldown 2** (in line with the `sniper` band). Cheapest way onto the air layer.
- **Deploy behavior:** spawns at `freeSpawnNear(base)`, floats to the highest `agl` of any flyer (thin dot + shadow), holds turn 1. Because it is `flying`, it is **excluded** from `runCaptureTick`/`runSalvageTick` (item 7) the instant it exists — deploying it never contests a depot.
- **Special rule:** none — deliberately the plainest deploy, so it can be the first air unit shipped (item 26.1) and validate the whole altitude/serialize path with almost no balance surface.

**30. Flak Track (`flak`) deploy — ship it right after the Skywatcher.**
- **Gate:** `tech: "armor"`, **tier-2**, **cost ~250, cooldown 2**. A *ground* vehicle (not `flying`), so it deploys and captures like any tracked unit; its only exotic data is the top `vsAir` weapon tag (item 10) and a long `projectileRange` for a wide air-lane overwatch radius (item 8).
- **Deploy behavior:** ordinary ground spawn at `freeSpawnNear(base)`, holds turn 1. Deploying it is the player's declared answer to enemy air — and per the rollout rule it must exist in the catalog **before** any offensive flyer reaches players.

**31. Gunship (`gunship`) deploy — the first offensive flyer, gated hard.**
- **Gate:** the latest air unlock — `tech: "armor"` tier-3/4 **or** a dedicated `air` node branching off `assault`. **Cost ~440 (top of the band), cooldown 4** (the longest, so the strafer is a committed investment, not spam).
- **Deploy behavior:** spawns at `freeSpawnNear(base)` at strafing `agl`, holds turn 1 (hovers, rotor spun-up but no run yet — the visible "armed, waiting" read). It is the one flyer that may itself **set overwatch** (item 8: gunship = loiter yes).
- **Cause-and-effect:** while CLASSIFIED, its button shows the doctrine name only; once unlocked and off cooldown its sub-line flips price↔`"N rd"` exactly like every troop, so the player always sees *why* they can/can't field one.

**32. Dropship (`dropship`) & Bomber (`bomber`) deploy — deferred, with the only two special deploy rules.**
- **32a. Dropship** — `tech: "support"`/`armor` tier-3, **cost ~300, cooldown 3**. Deploys empty at `freeSpawnNear(base)` and holds turn 1; its extra state is a `cargoId` that must round-trip in `serialize`/`restore` (item 13). **Special deploy rule:** loading is a *separate action next turn* (move adjacent to a friendly foot unit, then a load verb), and unload briefly clears `flying` (`landed`, item 9) to disgorge the capturing unit — the flyer itself still never scores. This is the one air unit whose full loop needs the landing verb, hence deferred past the slice.
- **32b. Bomber** — `tech: "siege"`/`ordnance` **tier-4**, **cost ~460, cooldown 4**. Deploys at `freeSpawnNear(base)`, holds turn 1. **Special deploy rule:** it *cannot move-and-bomb* — its attack is a one-turn **telegraphed impact line** committed a turn early (item 14), so deploying it is a two-turn tell the enemy can react to. No new spawner; the telegraph lives in the command/resolve phase, not the deploy path.
- **32c. Optional launch pad / airfield (explicitly deferred, not required).** If playtesting wants air to feel "based," a buildable `airfield` **defense/structure** (via `DEFENSE_CATALOG` + `buildStructureFor`) could be a *prerequisite* whose presence unlocks the air `data-spawn` buttons — but this is strictly optional flavor. The v1 recommendation is **tech-gate only**, deploying air straight from the Base's Deploy tab like every other unit; do not build a bespoke air spawner or a mandatory pad.

---

# B. Capabilities in Play — what each air unit DOES on a turn

Each entry is a concrete play-by-play using the **real** move/shoot verbs: `moveRange` (`sim.ts`) for reach, `projectileRange` (`sim.ts`) for weapon reach, the select→Shoot→pick-part→confirm funnel (`previewShot`/`queueShootPart`), `queueShootAt`/`groundAimPreview` for explosive ground-targeting, and overwatch (`armOverwatch`, 120° cone). Ground ladders below are approximate — grep the actual `moveRange`/`projectileRange` switch before tuning — `moveRange`: scout ≈ 11.5, striker ≈ 10.8, apc ≈ 7.2, infantry ≈ 6.7, sniper ≈ 6.0, tank ≈ 5.4, artillery ≈ 3.6; `projectileRange`: artillery ≈ 42, sniper ≈ 34, mortar ≈ 30, base ≈ 30, tank ≈ 28, heavy ≈ 26, turret ≈ 24, apc ≈ 24, flamer ≈ 7.5.

**33. Skywatcher (`skywatch`) — hover, spot, enable the backline.**
- **Verb:** *reposition + project vision.* Highest `moveRange` on the board (propose **~12**, just above `scout`'s ~11.5, and it ignores terrain cost per item 2 — it flies straight over the mesa the scout must go around). Almost **no** direct weapon; its output is the `spotter-aura` part `tag` (consumed in `sim.ts`, drawn in `worldRenderer.ts`).
- **A turn:** select → move to a ridge-overlook position at `agl`; end turn. Now its `spotter-aura` lets the friendly `mortar`/`artillery`/`airstrike` draw a `previewShot`/`groundAimPreview` on units they couldn't otherwise see, converting the drone's altitude LOS (item 4) into indirect kills from safety.
- **What it threatens:** nothing directly — it threatens *by revelation*. The counter-tension: it's the most fragile flyer (one AA burst) and cannot capture (item 7), so it's pure information economy. It may **not** set overwatch (recon, not a shooter).

**34. Flak Track (`flak`) — the air-lane wall (a ground unit that plays "up").**
- **Verb:** *shoot up / overwatch the sky.* Ground mobility (~`tank`-class, `moveRange` ~5.4) but a **long `projectileRange`** (propose ~30+, base/mortar band) so its overwatch radius `projectileRange * 0.9` (`sim.ts`) blankets a wide air lane.
- **A turn — reactive (the main mode):** select → **Overwatch** toward the lane the enemy air must cross (`queueOverwatchToward`); `armOverwatch` spends 1 CP and sets `overwatching[id]=1` + the watch facing. When an enemy flyer *moves* through the 120° cone (`OVERWATCH_ARC_HALF = Math.PI/3`, checked in `checkOverwatch`), it fires one snap shot with its top `vsAir` multiplier (item 10) — the flyer's **entry tax**.
- **A turn — active:** select → Shoot → pick the flyer's `mobility`/`body` part → Confirm; huge damage vs air.
- **What it threatens:** everything airborne, almost nothing on the ground — a `tank` eats it (item 15), so fielding AA is real opportunity cost, exactly the intended triangle.

**35. Gunship (`gunship`) — the over-cover strafing run.**
- **Verb:** *strafe a lane.* High `moveRange` (propose ~9–10, below `striker`'s ~10.8 so it's not un-catchable, per "no enemy speed above the player's"), and it moves *through* a line rather than to a point.
- **A turn:** select → declare a strafing run *through* a lane of ground units; on resolve it fires a downward `bolt` burst (`burstCount`, `projectileKind`) at every ground unit under the path, **ignoring low cover** because its muzzle is at `+agl` and cover is now elevation-aware (item 3) — waist-high sandbags don't save the infantry beneath it, but a tall `wall`/`base` still blocks it (item 18). It may also **set overwatch** to punish movers on the enemy's turn (item 8).
- **What it threatens:** clustered/entrenched infantry that ground fire can't dig out — its whole reason to exist. Its price: forfeits *all* terrain defense (item 5) and is a glass hull, so a single Flak Track overwatch or sniper `vsAir` shot can gut it mid-run.

**36. Dropship (`dropship`) — protect-the-cargo mobility.**
- **Verb:** *ferry a scorer.* Moderate `moveRange` (~7, `apc`-class), **unarmed** — it never enters the Shoot funnel.
- **A turn (multi-turn play):** T1 deploy empty and hold; T2 move adjacent to a friendly capturing infantry and **load** (stores `cargoId`); T3 fly the cargo across the map ignoring terrain (item 2); T4 **unload** — briefly `landed` (item 9) to set the foot unit down on/near an objective, where *it* captures via `runCaptureTick`. The dropship itself still can't score.
- **What it threatens:** nothing offensively; it threatens the *map* by teleporting a scorer past a stalled front. It is a walking bounty — AA kills two units for the price of one while it's loaded — so it's a high-risk tempo swing, deferred past the slice.

**37. Bomber (`bomber`) — one telegraphed devastating pass.**
- **Verb:** *commit a line strike.* It **cannot move-and-bomb** — the pass is the whole turn.
- **A turn (two-turn tell):** T1 select → commit a **telegraphed impact line** (a visible marker the enemy can dodge, per the telegraph rule); T2 on resolve it drops a row of `blast` events along that line, reusing the scorch-decal + `explosiveBlast` pipeline (`sim.ts`) — conceptually the same ground-targeted arc as `queueShootAt`/`groundAimPreview` (`sim.ts`) but as a *row*, not a point.
- **What it threatens:** dense formations and grounded AA nests — a hard answer to turtling. Its price: the one-turn wind-up, no terrain defense (item 5), and full exposure to AA + overwatch during the slow approach. An untelegraphed area-air unit would be oppressive; the visible impact line is non-negotiable.

---

# C. Targeting & Shooting Down Air — the select→Shoot→pick-part→confirm flow, against a target that's in the sky

Air must be shot down through the **exact same funnel** grounded units already use — no separate "AA mode." The reference flow (all symbols real):

> Select a unit → **Shoot** intent → the HUD (`shootState`, `hud.ts`) lists `targetableParts(target)` (`sim.ts` = `target.parts.filter(isPartIntact)`, HP>0) as `data-part` buttons (`partButton`, `hud.ts`); each calls `previewShot(actorId, targetId, partId)` → `previewAttack(…, "weapon")` (`sim.ts`), returning a `ShotPreview` whose face shows **`<accuracy%> / <amount> dmg`** and `<part.label> / <role> / <HP>`. **Confirm Shoot** (`data-confirm="shoot"`) → `queueShootPart(targetId, partId)` (`sim.ts`) → `queueShootFor`, which requires `actor.status.canShoot`, spends the actor's CP (`spendCommandPoint`), and adds a `shoot` order. `ShotPreview` also carries the block signals `blockedByGround` (`firstGroundBetweenShot` — high ground intercepts, amount forced to 0), `blockedById`/`impactEntityId`/`impactPartId` (`firstCoverBetweenShot` — cover resolves first), and `warningEntityId`/`warningText` (a **friendly** in the path). Muzzle direction comes from `aimPointFor`/`aimHeightFor`; arc height from `projectileArcHeight(kind, dist)`, so the pitch aims at the part's true elevation and arcs over intervening low ground/units.

**38. Targeting an airborne unit is the identical funnel — the only new thing is the aim height.**
Select a ground unit → **Shoot** → the flyer's intact parts (`mobility`/rotor, `body`/hull, `weapon`) list exactly as `targetableParts` already produces them; pick a part → the `partButton` shows the same `<acc%> / <amount> dmg`; **Confirm** → `queueShootPart`. No new UI, no "target air" toggle. The player learns air is "just another target you pick a part on," which is the whole point of doing this in the shared funnel. Killing the flyer's `mobility` part (its rotor) should down it even at partial HP — per-part damage makes "shoot the rotor" a legible, satisfying kill, distinct from grinding its hull.

**39. What the shot preview MUST show for an airborne target (the three air-specific reads).**
Extend `ShotPreview` presentation, not a new preview:
- **39a. The upward arc.** `aimHeightFor`/`aimPointFor` must resolve the target's composite height `terrainHeightAt(pos) + agl` (item 1), and `projectileArcHeight` must draw the shot **arcing up** to it. Critically, `firstGroundBetweenShot` (the upward path, item 4) must compute a valid path to `+agl` — if a near hill sits between a grounded shooter and the flyer, the preview should honestly show `blockedByGround` (amount 0, "High ground blocks this line"), so the player repositions rather than firing into a ridge.
- **39b. The `vsAir` modifier, surfaced in the number.** The `amount` shown must already fold in the shooter's `vsAir` multiplier from `estimateShotDamage` (item 10): a Flak Track's button reads a big number vs the flyer, a plain rifleman's reads a scratch. That single differing number *is* the AA UI — no separate indicator. Optionally annotate the accuracy tooltip with "vs Air" so cause-and-effect is explicit.
- **39c. Reduced/absent cover for the flyer.** Because flyers get **no** defensive terrain (item 5), the preview against an airborne target should **not** show a cover/height leniency, and the elevation-aware `firstCoverBetweenShot` (item 3) means low cover between shooter and flyer usually does **not** produce a `blockedById` — the shot goes up over the sandbags. (Tall `wall`/`base` still *can* block and must still surface `blockedById`, item 18.) The net read: air is easy to *hit* (no cover) but might be out of *reach* (arc/`vsAir`), which is the correct fragility-vs-specialization tension.

**40. Which existing units can "look up" — and which barely scratch air.**
The multi-sourced `vsAir` tag (item 10) decides who has a real preview number against a flyer:
- **Full:** **Flak Track** (`flak`, item 15) — top `vsAir`, the specialist; its `previewShot` vs air reads lethal.
- **Effective:** **Sniper** (`sniper`, item 16) — moderate `vsAir`; a Marksman already on the field taxes careless hovering. Its long `projectileRange` (~34) also means it can reach a flyer loitering deep.
- **Partial:** **Heavy** (`heavy`) and static **Turret** (`turret`) (item 17) — small `vsAir` so an army without dedicated AA isn't helpless and static defenses matter vs air. Kept well below the specialist so `flak` keeps its niche.
- **Negligible:** everyone else — their `previewShot` against a flyer shows a tiny `amount` (the steep `vsAir` penalty), teaching "bring AA" without a hard "cannot target" gate (avoiding the 40k anti-pattern). Note tall `wall`/`base` structures still block flyer LOS entirely (item 18), so terrain can also deny air without a shot.

**41. Overwatch is the reactive AA — the air-lane cone.**
The strongest way to shoot down air is **not** on your turn — it's the enemy flyer tripping your overwatch as it *moves* (item 8):
- Select an AA-capable unit → **Overwatch** → `queueOverwatchToward(point)` (`sim.ts`) faces it at the air lane; `armOverwatch` checks `overwatchFailureReason`, spends 1 CP, sets `overwatching[id]=1` + the watch facing. The HUD (`overwatchState`, `hud.ts`) shows the **radius** (`overwatchRadius = projectileRange * 0.9`) and "Pick a watch direction."
- On the enemy turn, `checkOverwatch(mover)` (`sim.ts`) fires **one** snap shot iff the flyer is an enemy inside the radius **and** the bearing to it is within `OVERWATCH_ARC_HALF = Math.PI/3` of the watched facing — the **120° total cone**. The reaction targets `preferredPart(mover, "center")` with widened spread, and applies the watcher's `vsAir` (item 10).
- **Why this is the keystone counter:** the Flak Track's long range → wide overwatch radius means a single AA unit can *deny an entire air lane* reactively, making a careless strafing run (item 35) or bomber approach (item 37) trip a `vsAir` snap shot before it even acts. The gunship may itself set overwatch (loiter); the transport/bomber may not.

**42. Jammer / EW pin — the clean telegraphed hard-answer.**
When overwatch and `vsAir` aren't enough, the solvable-puzzle valve (items 19, 21): a support power or the `jammer`'s aura projects a zone that sets a transient `pinned` flag on flyers inside it (no move/act, or loss of overflight bonuses). A pinned flyer can't kite out of your `flak`/`sniper` fire lane and can't complete its strafing run — you *solve* the air threat rather than trading shots. The `pinned` flag round-trips in `serialize` and clears in the same per-resolve sweep as overwatch (the end-of-resolve `this.overwatching.clear()`) so it never leaks across turns.

**43. Ground-targeting and splash generally will NOT down a flyer (by design).**
Explosive shooters can aim at a *ground spot* via `selectedCanGroundTarget()` (`sim.ts`) → `queueShootAt(destination)`, previewed by `groundAimPreview` with blast radius and reachability. But a ground `blast` detonates at terrain height, and a flyer sits at `+agl` (item 1) with **no** terrain-defense leniency but also **out of the blast's vertical reach** — so `queueShootAt`/`queueGrenadeAt` splash should *not* be a reliable way to hit air. This is intentional: air is downed by **aimed `vsAir` part shots and overwatch**, not by carpet-bombing the ground under it, which keeps the AA counter deliberate and readable rather than incidental. (The bomber, item 37, is the *inverse* — it uses this same ground-`blast` pipeline to strike the ground *from* the air.)

**44. Regression-audit the whole targeting class when air lands.**
Per the owner's collision/aim-fidelity bars, adding the upward-arc path (item 39a) touches the shared `firstGroundBetweenShot`/`firstCoverBetweenShot`/`aimHeightFor` code that *all* shots use. Re-run the aim-fidelity audit: (a) grounded-vs-grounded shots over low cover still `blockedById` correctly (cover not silently nerfed, item 3); (b) high-ground still `blockedByGround` for level shots; (c) the new upward shot honestly reports block on a near ridge; (d) friendly-in-path `warningEntityId` still fires for upward shots. Add a smoke that places a `flak` and an enemy `gunship`, asserts the `previewShot` `amount` is high (vsAir applied), Confirms the kill, and that an overwatching `flak` snap-fires when the flyer moves through its 120° cone.

---

# Cost posture & first playable air slice

**Cost posture (unchanged from item 27): procedural, zero external spend.** Every unit and every mechanic above is procedural mesh + sim code with silent-skip fallbacks — **no Meshy credits, no GLBs, no MP3s, no fonts, no AI text-to-image.** Air leaves `modelKeyFor` returning `null` and stays procedural per the repo rule ("infantry/characters stay procedural"); the sanctioned Meshy hull scope is **not** widened. The only real cost is **sim complexity + test surface** across `elevationForEntityAt`, `blockedBySteepTerrain`, `separateFromUnits`, `firstCoverBetweenShot`/`firstGroundBetweenShot`, `estimateShotDamage`, `runCaptureTick`/`runSalvageTick`, the overwatch map, and `serialize()`/`restore()`.

**First playable air slice — the buildable checklist (deploy → capability → counter, proven end-to-end):**

1. **Altitude axis (items 1, 2, 4, 5).** Add `flying` + `agl` to `CombatEntity`; branch `elevationForEntityAt` before its `cover`/non-infantry early return; skip `blockedBySteepTerrain` + grounded `separateFromUnits`; keep `clampToArena`; skip flyer terrain-defense in `estimateShotDamage`/`baseAccuracySpread`; round-trip both fields in `serialize`/`restore`.
2. **Non-capture keystone (item 7).** Add `!entity.flying` to `runCaptureTick`/`runSalvageTick`.
3. **Deploy the Skywatcher (items 28, 29).** `TROOP_CATALOG` entry `skywatch`, `tech:"recon"`, ~230/cd2; deploys from the Deploy tab through `spawnFailureReason`→`spawnTroopFor`, holds turn 1 at `agl`. Verify the CLASSIFIED→price/cooldown button states.
4. **`vsAir` tag + the Flak Track (items 10, 15, 30).** Add `vsAir` to `estimateShotDamage`'s multiplier stack; catalog `flak`, `tech:"armor"` tier-2, ~250/cd2, long `projectileRange`. Confirm `previewShot` vs a flyer shows a big `amount` and negligible for a plain rifleman.
5. **Shoot-down flow (items 38–41).** Verify select→Shoot→pick the flyer's `mobility` part→Confirm downs it; the preview shows the **upward arc**, honest `blockedByGround` on a near ridge, and **no** low-cover block; overwatch (`queueOverwatchToward`) snap-fires when the flyer crosses the 120° cone with `vsAir` applied.
6. **Gunship last (items 11, 31, 35).** Only after 1–5: catalog `gunship`, top-tier gate, ~440/cd4; strafing run ignores low cover (item 3) but is blocked by tall `wall`/`base` (item 18) and gutted by the Flak Track's overwatch.
7. **Regression smoke (items 27, 44).** Fly a Skywatcher over a mesa and assert it (a) clears the ridge, (b) cannot capture, (c) round-trips through save/reload; plus the flak-vs-gunship targeting/overwatch smoke. Keep `window.__rht` in sync so the smokes can drive `flying`/`agl`/`vsAir`.

Defer the **bomber**, **dropship/landing verb**, the optional **airfield/launch pad**, and every non-air archetype (items 20–25) until this air ↔ AA ↔ ground triangle is green in a smoke.
