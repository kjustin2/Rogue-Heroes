# Architecture: engine and renderer facts

Repo-specific facts about the sim, the renderer, Electron and saves. Read the section for the system you are touching.

## Architecture (repo-specific facts)

Standard three-layer split (pure sim → read-only renderer → DOM HUD, composition root
`src/main.ts`). What's specific here:

- **`src/game/sim.ts` (~3200 lines) is authoritative** — the most important file.
  Phases `command` → `resolve` → `victory`/`defeat`. Seeded `Rng`; no `Math.random()`
  in sim code.
- **Per-part damage** (`damageModel.ts`): entities are bags of parts; `applyDamage`
  hits a part, `recomputeStatus` derives `canMove`/`canShoot`/`alive`.
- **Terrain is a mutable singleton** (`src/game/terrain.ts`): `setActiveTerrain` swaps
  global blocks + `ARENA_BOUNDS` (+ `water`/`bridges`); `configure()`-ing a map mutates shared
  state. Tests building `TacticalSim` from raw entities rely on `DEFAULT_TERRAIN`'s fixed mesa —
  a test that needs water/bigger bounds must `setActiveTerrain(...)` AFTER constructing the sim
  (the constructor resets terrain) and restore `DEFAULT_TERRAIN` at the end.
- **Impassable terrain** is emergent, not tile-flagged: a stacked terrain step >`TERRAIN_STEP`
  (0.95) reads as a cliff/wall, and `water` rects block ground movement (via `pointInWater` in
  `blockedBySteepTerrain`) unless a `bridge` rect crosses (flyers overfly both). Water sits at
  ground height so it does NOT block flat line-of-fire. "Large hills"/"walls" reuse stacked
  `TerrainBlock`s or the `wall`/`cliff` cover kinds — no new primitive.
- **Every map is enlarged at load** by `scaleMapDef` in `maps.ts` (large ~2×, medium ~1.5×,
  small ~1.3× area; authored `RAW_MAPS` literals stay at base scale). Only positions/extents
  scale — object sizes and terrain heights are fixed; prop counts do NOT grow (see MAPS ARE MINIMAL). `MapDef.size`
  is stamped from the authored area so `mapSize()` stays correct. Arena-dependent render constants
  (shadow frustum, max zoom, fill-light range, particle count) are sized for the largest map.
- **Unit move distances carry a global `MOVE_RANGE_SCALE`** (`sim.ts`, on both `moveRange` and
  `moveSpeed`) so the bigger maps don't slog. Changing it shifts move-distance test expectations.
- **Air layer** (`flying`/`agl` on the entity; `isAirKind` lists the flyers): gunship (helicopter,
  air-to-air gun + bombs), interceptor (jet, air-to-air gun only), bomber (jet, bombs
  only, no gun), transport (helicopter, unarmed airlift). Aircraft GUNS are air-to-air ONLY
  (`isAirKind(actor) && !target.flying` rejects); BOMBS fall from the rack onto any ground point in
  bomb reach, no flight (`isAirBomber` → `queueBombRun`/`launchGrenadeAtPoint`; docs/game-systems.md, Air bombing). Ground units
  CAN hit flyers (that's the anti-air). The enemy `enemyTroopPreference` scrambles air when the
  player flies, which is what gives a player gunship air-to-air targets. New flyer = the full
  add-air-unit checklist (create*, `isAirKind`/`isVehicleKind`, catalog, per-kind fns, `build*`
  model + dispatch, bomb gating, `carriable`).
- **Air transport carry** (`passengerIds`/`carriedById` on entities → rides `serialize()`): `load`/
  `unload` order kinds; carried units are hidden + inert + untargetable (excluded in render/targeting/
  separation), snapped to the transport each frame, dropped on unload or when the transport dies.
- **Debug/Sandbox mode**: launch with `?debug` (dev URL) or `--debug`/`RHT_DEBUG=1` (Electron appends
  `?debug`); `DEBUG_UNLOCKED` reveals a Debug section in Settings (infinite money, free cooldowns),
  applied each command frame via `applyDebugCheats`. See `game/README.md`.
- **The AI checks line of sight before firing** (`aiShotBlocker` reuses the rng-free player shot
  preview): it breaches a destructible blocker (cover/wall) rather than wasting the shot, or holds
  fire on terrain/friendly blocks. Keep the aim rng draw ahead of the block decision (determinism).
- **Thrown bodies FLY on screen** (`flyThrownBody`, renderer-only): the sim moves a thrown body in one step; a living ground unit whose position jumps >0.8m in a resolve frame is flown from where it was — infantry arc and tumble backwards (full flip past 3m), vehicles hop and rock — with landing dust. Evidence `shots:gpu -- thrown`. The seam's `endTurn()` skips the unused-AP prompt (scripts drive turns).
- **Blasts THROW what they don't kill** (`applyKnockback` in `sim.ts`). Direction is away from the
  blast, distance scales with damage x falloff / `blastMass` — infantry 1, vehicles 5.5, anything
  bolted down is Infinity and does not move. The throw marches in steps and stops at the arena edge
  or a terrain step it cannot clear, but NOT at a shoreline: a body thrown into water drowns
  outright, the one place terrain kills in this game. Flyers are exempt. Tests in
  `knockback.test.ts` — mind the staging: victims are PLAYER units taking friendly-fire splash,
  because an enemy victim is moved by the enemy AI in the same turn and swamps the measurement.
  Also: the grenade order is gated on KIND (soldier/gunship/bomber — a "grenadier" fires a launcher,
  not a thrown grenade) and `debugSpawn` hands out `maxGrenades: 0`.
- **`serialize()`/`restore()`** JSON round-trip the battle; always resumes in `command`.
- Data catalogs are the tuning surface: `units.ts` (troops/defenses/support powers),
  `tech.ts`, `modes.ts`, `maps.ts`, `scenario.ts` (bases + cover only — no starting units).
- **Part materials and part geometry are POOLED.** `partMaterial()` in `worldRenderer.ts` hands
  every part mesh a SHARED `MeshToonMaterial` (same ramp as the hulls) keyed on a quantized version of its painted
  appearance, and `paintPart` re-resolves each mesh to the right one every frame. So:
  **never write to a part mesh's `material`** — you would repaint every other mesh that currently
  looks the same. Change `mesh.userData.baseColor` (or the spec paintPart builds) instead; that is
  what `tintPropToMap` does. Pooled materials and geometry carry `userData.shared`, which is how
  `disposeSubtree` knows to leave them alone. There are no per-instance GLB materials any more
  (the vehicles kit is pooled parts too).
- **The ground texture is a neutral MULTIPLIER, not an albedo.** `makeGroundTexture` draws around
  white and the material's own `color` supplies the hue, so the arena floor, the mesa caps and the
  outer plain share one texture at three tints. Baking `theme.ground` into the texture *and* setting
  the material colour to `theme.ground` squares the map's own colour — that was why every map read
  muddy and flat. It is also seamless (all marks stamped through `wrapped`), which is what lets it
  tile at ~11 world units; it ships a sobel-derived normal map alongside.
- **A faction accent is a UI colour and must be deepened before it touches a hull.** Blending one
  straight in bleached units — the enemy tint defaulted to white and the enemy role blend repainted
  68% of every surface with a light salmon, so enemy armour, walls and HQs all came out pale pink.
  The team read is carried by the marker ring, the accent trim and the emissive glow; a hull only
  has to sit in the right hue family. See `setFactionTints`/`roleColor`.
- **THE OUTER PLAIN CARRIES NO TILED TEXTURE.** It is nine times the arena's extent; tiling the
  ground detail across it minifies the texture into aliasing hash, which reads as fine dashed
  hatching over half the board. That artefact was in every screenshot of this game and survived
  three rounds of texture tuning, two shadow-bias changes and a shadow-frustum rewrite, because
  none of those were where it lived. `npm run probe:ground <scenario>` is what found it: it strips
  the albedo, then the normal map, then the particle bed, one at a time — the arena went clean and
  the surround did not, which named the culprit in one run. A surface meant to recede into fog
  wants a flat tone anyway.
- **The shadow frustum FOLLOWS THE CAMERA FOCUS** (`syncShadowFrustum` in `stage.ts`), snapped to
  whole shadow texels so edges don't crawl when the camera pans. `SHADOW_RADIUS` must cover
  everything on screen: three clamps the shadow map at its edges, so anything outside the window
  gets border texels smeared across it as long parallel streaks.
- **Infantry value hierarchy lives in `paintPart`, not in the twelve kit branches.** `bodyValueAt`
  ramps value with height (dark boots -> mid torso -> lit chest/weapon band) and `accentValueAt`
  confines the saturated identity colour to ONE zone at chest height. Authoring it per kit is how
  twelve independently-tuned kits ended up flat. Same rule: a cue that paints a whole weapon (the
  "has orders left" pulse did) breaks the one-accent zone — cues go on accent meshes only.
- **The right-hand rail stacks two panels.** `.topbar.compact-top` and `.target-panel` share
  `right: 16px`; the target panel starts at `top: 268px` to clear the tallest the command stack can
  get (End Turn + Menu + four chips). If you add a chip to that stack, re-check the number.
- `src/render/stage.ts` owns the composer; call `warmUp()` after staging new material
  kinds or the menu↔battle flip stalls on a shader relink. Tear down per-frame/per-swap
  groups via `disposeAndClear()`; `userData.shared` geometry is skipped.
- **PAINTED TERRAIN** (2026-09-24, overhaul option 5). Every ground surface -- floor, plates, mesa tops -- shares
  one world-space paint in the `applyCloudShadows` shader patch (`groundPaintUniforms`, set per map by
  `setGroundPaint` from `GROUND_PAINT[theme.surface]`): two biome patch colours in soft noise blobs (one of them a
  real DARK -- oil, wet mud, shadowed paving -- for the value plan), a worn LANE meandering base to base and a
  trampled apron round each base. The plates keep off the lane via `laneDistance()`, which is the same curve as
  the shader's -- change both together. The floor's vertex colours add CONTACT darkening at the foot of every
  rise (`paintGround`), and the merged mesa side mesh wears an inverted-hull INK rim (`TERRAIN_INK`, one draw
  call). Measured by `npm run measure:maps` (board region of `shots:gpu maps`: contrast, range, one-hue share;
  `SHOT_PREFIX=before-` for a baseline): one-hue share fell from up to 68% to <= 59% on every map; contrast rose
  on five of six, Ironworks flat (its frame is mostly grey slab tops). Goal (contrast >= 0.10) met on Verdant,
  Causeway; Dust Bowl 0.100 edge; Crossfire 0.096, Ironworks 0.093, Karak 0.092 short. Ground PLATES are tested
  PER BLOB against water at their full jittered reach (1.52x radius): a patch-centre test painted ground over
  water on Verdant, Causeway and Karak; `smoke:ground` asserts no plate vertex over water (fault-injection proven).
- **LIGHT IS PER MAP** (2026-09-24): `MapTheme.light` (`LightRig`: sun colour / strength / elevation / azimuth,
  hemi sky + bounce, rim) is applied to the stage's EXISTING three lights by `stage.setLightRig` — always through
  `applyMapLook()` in main.ts, which pairs it with `world.applyMap` (never call one without the other). Sun
  elevation is clamped >= 28 degrees (lower grows acne on the flat arena, ledger #4). Ironworks keeps a NEUTRAL key
  with the furnace orange only on the rim: an orange key turned the steel yard into one brown (97% one hue).
- **N8AO contact shading** (`n8ao` 2.0.1, `src/n8ao.d.ts` types): `N8AOPostPass` after the RenderPass on the
  Quality ("Performance") and Ultra ("Low") tiers only; half-res, radius 1.6m, intensity 2.2, gammaCorrection off.
  **DEPTH WIRING (2026-10-01)**: postprocessing 6.39.2's "stable depth" blit after the RenderPass failed EVERY
  frame under three r170 (same GL image on both ends; 144 GL errors/s, found by the play log). The RenderPass
  has `needsDepthBlit = false` and N8AO is handed the composer's LIVE depth texture (`ao.setDepthTexture`):
  attached to the input it reads, never the output it writes. postprocessing is pinned at **exactly 6.39.2**:
  6.39.5 fixes the blit but N8AO then renders the scene BLACK. Any bump of postprocessing / n8ao / three runs
  `npm run shots:gpu -- glprobe maps` (glprobe must print all zeros; the maps must not be black). `three-good-godrays` was considered and rejected (tactical pitch — the
  sky is a sliver).
- **Faction light pools**: every living HQ throws a slow-breathing draped disc of `FACTION_GLOW` (shared with the
  aircraft engine burn) in `syncEnvironment` — a disc, not a light.
- **Map life** (renderer clock only): `makeChimneySmoke` (projectileFx — continuous-phase toon puff column, no pop)
  over the furnace and huts; `PROP_LIFE` particle bursts (furnace embers, derrick flare-off, brazier sparks); dust
  devils on the Dust Bowl. Evidence `shots:gpu -- life`.
- **Faction HQ architecture is Blender** (vehicles kit `vb-*` / `sb-*` / `bb-*`): once-used pieces via `vpart`
  (authored in base-relative game coordinates), repeated pieces (scrap slab, wall run, tent, pillbox) via
  `box({ geometry })`. The radar dish spins through `userData.spinY` (any part mesh can use it). Bastion pillboxes
  sit ON the wall corners (they were inside the wall, painted yellow by the `power` part).
- **Hero props** (`art/props/author_hero_props.py`, overhaul option 7): girder, coil, hedgehog, boat, obelisk, urn,
  iceblock, haybale, grave — one shaped body each via `heroBody()` in `buildBiomeProp`, accents stay TS, box build
  is the fallback. Only boat + obelisk are placed by the current minimal maps; the rest are ready. `shots:gpu --
  heroprops`. **Faction dress** (`art/infantry/author_dress.py`): hood, duster, bucket helm, pauldron, tower
  shield, jet pack as `kit:` parts on the same boxes. `measure:factions` GOAL MET after both.
- **The ground detail layer** (`makeGroundDetail`) is one InstancedMesh per element kind (grass fans, pebbles, snow clumps, cinders, weeds), placed only on dry flat ground, bending in `windUniforms` (the same clock the cloud deck and tree sway use). Pebbles are 8-triangle octahedra on purpose — the 36-triangle version was 130k triangles on a large map. Costs are in `perf-baseline.json`; rebase after an intentional change.
- **MAPS ARE MINIMAL, AND THERE IS ALWAYS ROOM FOR TWO TANKS** (owner, 2026-09-23: "way too many items on the board so it
  blocks movement... make each unique impactful and relevant"; "ensure enough space for 2 tanks to get through any space").
  Each map is 6–14 props (was 42–78), authored as `signature` pieces in PRIORITY order — landmark, then the thing that blows,
  then the rest; `scatter` is empty everywhere. `buildMapObjects` places each at the nearest spot to its authored one where
  it and its mirror twin keep **`WALK_GAP` (7.2m = four radii of the widest ground vehicle) of open ground edge-to-edge**
  from every base, prop, landmark and capturable, and do not PINCH a lane against a cliff step or water
  (`pinchesTerrain`: a wall within `FLUSH` 1.2m is hugging it, which is fine; the arena border is not a pinch)
  — `findRoom`, a deterministic ring search out to 8m. Nothing solid sits inside a base's deploy ring
  either: `BASE_CLEAR` (the widest ring, Vanguard's, + 1m) from each base centre, capturables included. A piece with no room is LEFT OUT, never crammed in; so a
  listed kind that never places fails `props.test.ts` and must be cut from the list. Prop counts do NOT grow with
  map area any more. `props.test.ts` pins: biome kinds stay home (the `HOME` table), every listed kind places,
  ≤ 20 props, one landmark and one volatile per map, WALK_GAP between every pair, no terrain pinches.
  The fifteen biome props are box-built in `buildBiomeProp`; tall ones (girder, obelisk, tower, pillar, tree)
  topple; the brazier burns like fuel. Evidence: `npm run shots:gpu -- maps`, `npm run shots:props`.
- **Stone takes the map's hue**: rock / rubble / statue props are tinted 0.5 toward `rockTint` (the ground's own hue at a slightly higher value); wood, foliage and hardware only 0.3 toward `propTint`. A tint into an already-saturated albedo only ever darkens it — which is why the Meshy rock had to be greyscaled first, and why it is gone.
- **INFANTRY LOCOMOTION IS DISTANCE-LOCKED** (`src/render/gait.ts`, 2026-09-22). The gait phase
  advances by `metres moved / stride`, never by wall time, and a planted boot is placed from that
  phase alone — so while it is on the ground it slides back under the body at exactly the body's
  speed and its world velocity is ZERO. Foot skate is impossible by construction, not tuned away;
  `gait.ts` is pure (no three) and `gait.test.ts` proves the contract. Shape of it:
  - `footAt` gives the ankle target (stance = the stride lock, with a heel-strike → flat → toe-off
    ROLL about the heel/toe, so the contact point is pinned inside each phase; swing = an arc that
    starts where toe-off left the ankle and ends where the heel strike puts it).
  - `hipBob` is an AUTHORED four-key curve per half cycle (contact / mid-stance / toe-off / the peak
    between steps) and the KNEE is whatever `solveLeg` (two-bone IK, law of cosines) needs to reach
    the ground under it. The test asserts the curve never rises above `hipCeiling` — a hip authored
    too high hovers the foot, which is the skate bug wearing a different hat.
  - The authored one-piece leg mesh is **split at the knee at load** (`legSplit.ts`, Sutherland-
    Hodgman clip + capped cut, cached per source geometry, `userData.shared`): thigh / shin / boot
    are three part meshes tagged `userData.segment`, all still part id `legs`, so per-part damage,
    pooled paint and the kit contract are untouched. `getComponent` (not the raw array) reads the
    cut vertices — glTF `COLOR_0` is normalised Uint8 and copying raw integers painted the legs as
    a white-hot ball.
  - **Speed tiers** (`GAIT_TIERS`, picked by `gaitTier(kind)`): walk (line troops), march
    (scout/striker: longer stride, more lean, pumping arms), trudge (heavy/mortar/flamer: short
    stride, long contact, wide stance, roll). `CROUCH_GAIT` is the one walk-length gait — the sim
    stands a crouched unit up when it moves, so the renderer keeps it low off `order.startedCrouched`.
  - The free arm counter-swings the opposite thigh; the weapon arm keeps its carry; the torso leans
    and counter-rotates against the pelvis twist; the head counters half the bob and stays level.
  - **Evidence**: `npm run shots:step -- walk | march | trudge | crouch | step` (side profile, HUD
    hidden, one stride per strip) and the skate metric in `smoke:animation` — FAULT-INJECTION
    PROVEN: locked = p90 0.07 cm/frame and 0.02 m slide per metre travelled, phase driven off wall
    time instead = 2.00 cm/frame and 1.33 m/m. Thresholds (1 cm, 0.15) sit between those two
    measured states. The gate reads the renderer's own per-frame boot track (`__rht.trackFeet` /
    `footTrack`) because a headless sample step is a third of a stride — by the next sample the
    planted foot is a different one.
- **Idle liveness is gated** (`smoke:animation`: head scan + body turn over 6s of standing — the
  scan's cycle is ~10s, so a 3s window legitimately measured 0.13 of a 0.42-rad sweep and failed).
  Whole-body idle lives at group level next to the flinch; per-part breathing in `paintPart`. Both
  are phased by `hash(entity.id)`.
- **Attack choreography follows the ORDER** (`attackFamilyForOrder` — the ONE place that says which
  orders animate their actor and how; `computeAttackPhases` and `attackCoverage.test.ts` both read
  it): shoot/smoke = the unit's weapon family, melee = `melee`, an infantry hand grenade = `throw`
  (a procedural overhand windmill of the FREE arm, `throwArmAngle`, released at the sim's 0.58s),
  an aircraft bomb = nothing (a bay, not a gun). A bomber's CARPET lands on the tick it is
  released (sim unchanged — its timing is balance-tested); the renderer draws the fall before
  release off the order's clock (`makeCarpetFall` onto `carpetDropPoints`, ending on `ATTACK_FIRE_AT`). **Arms are meshes of the `"body"` part (role core)**,
  so in the pose code any `limb === "arm-*"` test placed AFTER the `part.role === "core"` branch
  never runs — the throw branch sits before it for that reason (see next-steps for the Blender
  banks' arm channels, which are still behind it).
- **Melee**: the pose family follows the ORDER (`meleeTargetByActor`), the blade is carried by the shoulder about a grip pivot (it is a separate part with no authored motion), the group lunges, and the sim emits a `strike` effect (slash arc + flash + shards), never a blast. `__rht.setResolveScale(0.25)` slows the resolve clock for filmstrips.
- **Jump Trooper** (`jumper`, `UNIT_STATS.jump`): its move is an arc (`canJump` → `jumpLanding` picks a dry, unoccupied landing; the order sets `flying`/`agl` on a sine until it lands). Mid-arc it IS a flyer to targeting. Pack destroyed = walks. Tests find a real cliff by measurement (`jumper.test.ts`).
- **Gas** (`CoverKind "gas"`): rupture pushes a `gasClouds` entry (grows per turn, chokes infantry at turn start); **every `sim.effect("blast")` calls `igniteGasAt`** — that is the one place that knows about gas, and a cloud's detonation is a blast, so canisters chain. Rides `serialize()`.
- **Slams** (`resolveSlam`): a knockback throw that stops early (cliff / solid prop / another body) lands its unspent share as damage; unit-into-unit is shared and shoves the hit unit a step.
- **Piercing** (`UNIT_STATS.pierce`, marksman): the round goes through bodies (cover still stops it), `-pierce` damage per body, carries `PIERCE_CARRY` metres past the first hit and the order completes there.
- **Smoke** (`smokeClouds`, mortar-only `queueSmokeAt`, OrderKind/Intent `"smoke"`): a 3-turn cloud
  (radius 3) that swallows any FLAT round (`arcHeight <= 0.5`) whose line passes within its radius —
  in `previewAttack` (`blockedBySmoke`, `queueShootFor` rejects, `aiShotBlocker` holds fire) and
  in flight (`smokeEntryProgress` in `updateProjectile`). Mortar/artillery/grenade arcs sail over.
- **Stabilise** (`downed` on the entity): the ONE place a kill becomes a body is `afterDamage` →
  `stabilise()` — infantry, friendly medic within 6, critical parts pinned to 1 HP,
  `recomputeStatus` zeroes move/shoot while `downed`. Downed bodies are skipped by every hit /
  splash / tick loop and by the AI target list; `runDownedTick` (first thing in `finishResolve`)
  revives at 30% core or kills through the ordinary death path. Direct `applyDamage` calls that
  bypass `afterDamage` (burn/gas ticks) still kill outright.
- **Mark** (`markedUntilTurn`/`markedById`): stamped in `spawnShotProjectile` when a sniper fires
  (hit or miss); `isMarkedFor(actor, target)` gives every OTHER friendly `MARK_SPREAD_SCALE` and
  `MARK_ACCURATE_BONUS` in `accuracyForShot`; cleared in `finishResolve` the turn after.
- **Lightning** (`MapEventKind "lightning"`): one strike per turn at `lightningZone(turn)` — a pure function of map seed + turn, so command telegraph == resolve strike == restored save; never within 7 of a base.
- **Title diorama** (`stageMenuDiorama` in `main.ts`): the main menu sits over a live Verdant scene with `stage.menuDrift`; `body.in-battle` mirrors `inBattle` so CSS hides the HUD outside a battle; `stage.resetView()` restores the tactical camera only when leaving the diorama.
- **`stage.warmUp()` extras must be visible AND unculled** (parked at y=-5000 in a wrapper): `renderer.compile()` walks `traverseVisible`, and only a composer DRAW compiles the post-chain variant (linear output, tone mapping off) — the lean path's key differs. It was a silent no-op for every GLB until `soak:gpu` diffed programs across a resolve. The warm-up also clones a transparent twin of every opaque standard material (death fades flip the `opaque` program bit). Any mid-resolve hitch report: run `soak:gpu` first; it names the compiling program.
- **Abilities on entities** (all serialized): `suppressedUntilTurn` (heavy hits; one CP + crouch next turn, applied at turn start), `hullDown` (tank with no move/ram order this resolve, decided in `endTurn`, 0.7x shot damage), slam landing in the jump-landing block.
- **Deaths are per family** (`poseDeath`, renderer-only, seeded by entity id; `deathMs()` per family): infantry killed by a big blow (flinch mag >= 0.6) are THROWN (arc + flip + bounce + dust), otherwise CRUMPLE or SPIN; ground vehicles WRECK (hop, roll, turret thrown clear by `blowOffTurret`, charred + smoking, then sink); aircraft SPIRAL nose-down and explode on impact. Group-level transforms (plus the turret throw after `paintPart`), so pooled paint / per-part damage never know. Evidence: `shots:gpu deaths` (`DEATH_VIEW='{...}'` to reframe; `__rht.debugKill(id, blow)` is the capture seam).
- **Every procedural machine wears the ink rim** (`defaultInk` in `box()`/`cylinder()`): aircraft, flak and the fallback hulls. The flyers were the one rimless family and read as blurry. Accent lamps stay rimless; infantry and scenery keep their own rules. Pale steel/glass (>~180 luminance) on machines blooms into smears — keep barrels gunmetal.
- **EVERY ground overlay is DRAPED** on the drawn ground (`drawnGroundAt`). Static rings/discs — pickups, mines, map-event telegraphs, burn/gas/smoke skirts, downed markers, objective rings — come from `drapedDisc()` (cached per map, `userData.shared`, cleared in `applyMap`); the aim splash disc is draped per build. Never add a flat `RingGeometry`/`CircleGeometry` at `terrainHeightAt` again (glitch sweep #5: a pickup ring buried in a plate read as a tan comma). Cover props stand on the drawn ground too.
- **GROUND CIRCLES (2026-09-24, owner: "the circle around your base ... sticks out the back of the map",
  "being cut off ... look closely at each")**. Every draped overlay is clamped to the arena AND drops triangles
  wholly outside it (`clipToArena`), so a circle ends at the board edge; `drapedDisc` drapes conservatively too.
  A thin ring takes ONE height per angle (`pairRingHeights`) so it never twists into teeth at a step. The BIG
  zone rings (deploy ring + its fill, weapon reach) are laid FLAT at the actor's ground (`drapeToTerrain(...,
  flatAt)`) -- draped over a stepped mesa they zigzagged -- and the ring OUTLINES (selection, reach, deploy)
  draw on top of everything (`depthTest: false`, renderOrder 19-21) so towers, smoke and motes never hide them.
  Every ground overlay material carries `overlayDepthBias` (polygonOffset -4) to beat the plates' -2. The
  selection pulse is opacity only (scaling a draped ring lifted it off the ground). Gate: `smoke:ground`'s
  overlay invariant (`__rht.auditOverlays()`, all six maps, fault-injection proven). Close-up evidence:
  `npm run shots:gpu -- baseclose` (both bases, every map, selected / deploy / from behind, HUD hidden).
- **A picked base frames its deploy circle above the command panel** (2026-10-01). The panel covers the lower
  half of the screen and hid over half the circle. `syncCameraAssist` (main.ts) calls `stage.frameDisc` once
  per pick (compared by entity OBJECT: ids repeat across battles), after the HUD has drawn the panel so its
  real top is measured; `frameDisc` grid-searches the smallest zoom + a focus slide toward the camera that puts
  16 circle points on screen above it, and eases there UNCLAMPED (a base sits near the back edge; the board
  grows a circle's width behind it). `guideTo` returns false while the player's own pan holds guides off; the
  pick retries for 1.5 s, then gives up rather than yank the view late. Gate: `smoke:ground`'s fifth
  invariant (fault-injection proven: 6/16 points hidden without it). Evidence: `shots:gpu -- basesel`.
- **Toon rim + lit mesa lip** (2026-10-01): unit parts (`spec.rim`, everything but cover) take a narrow
  `smoothstep` fresnel rim (`applyToonRim`, program key "toon-rim", its own pool so scenery parts never get
  it: on big flat props it bleached the faces). Mesa caps wear a lighter vertex tone on their rounded rim
  (bevel CAP*0.45) so each rise is outlined in light at its top, in dark ink at its foot.
- **A base's ring lies on flat, dry ground** (2026-10-02): a base whose widest deploy ring touches terrain slides
  `RING_SHIFT` (3m) toward its back edge; blocks still touching are dropped (`DEPLOY_RING_CLEAR`); `maps.test.ts`
  asserts every map's ring has no step and no water. Pickups avoid water, ledge edges and every ring; props keep
  1.0m off a ledge (`steepHere`).
- **NO-GO tiles**: while Move is armed `syncBlockedCells` tints every 1m cell inside the reach the unit cannot stand
  on (water, wall-height faces and the strip hugging them, solid props) red, over the drawn ground.
- **Movement hardening** (oracle-found): a unit pressed on a face cannot walk its hull in; push-out never sinks a hull
  into rock (turned aside, partial, or the neighbour steps aside); a thrown body lands on ground its whole footprint
  fits (`groundFits`, 16-way ring) or stays put; a timed-out move halts clear of rises AND bodies (`settleHalt`).
- **The board grows behind the bases** (`fitBases` in `maps.ts`): every base keeps `DEPLOY_RING_FIT` (the
  Vanguard's deploy ring + 0.8m) of board on every side, so the whole deploy ring is placeable. The bases did
  not move (moving them in shrank Ironworks' no-man's land by 17m); `scale.test.ts` measures crossings base to
  base, and `maps.test.ts` asserts the fit.
- **Spawn spacing**: a newly fielded unit keeps `SPAWN_GAP` (0.9m, was 0.3) of open ground from every body,
  for placed deploys (snapping to the nearest spot that keeps it) and base spawns alike (`deploy.test.ts`).
- **Drape is CONSERVATIVE and CLAMPED** (2026-09-23, the "teeth" beside the Ironworks base): `drapeToTerrain`
  clamps every vertex to `ARENA_BOUNDS`, and a filled `PlaneGeometry` overlay lifts each vertex to the highest
  drawn ground within half a grid cell — a triangle spanning a talus lip otherwise cuts UNDER the slope and is
  hidden in a stripe per cell (sawtooth). Bisected with `PROBE=1 npm run shots:gpu -- basedeploy` (the teeth
  vanished with the overlay hidden and survived shadows off). Move orders and the live Move preview are draped
  too (`addDrapedMovePath`): a straight tube between endpoint heights sliced through slabs.
- **Selection is a ring, never a light.** The old selection point light (+ a translucent cyan cone round the
  body) blew the selected unit into a glowing white blob and changed the scene's light count on every
  select/deselect. The body gets a small lift in `paintPart` only. Evidence: `shots:gpu -- climb`.
- **▲ CLIMB tags** mark every step UP a move path takes (`climbsAlong` in terrain.ts — sim terrain, so the
  cue matches the walk), on queued moves and on the live preview while Move is armed.
- **Units stand on the ground as DRAWN, not as simulated.** `visualGroundAt` mirrors the talus tiers
  `makeTerrainBlocks` flares past a block's footprint (same constants — change both together); the
  rendered elevation is the footprint-sampled max of it (capped at one `TERRAIN_STEP` above the sim
  ground) plus `plateLiftAt` (ground plates record their discs). Sim elevation is untouched.
  `npm run shots:step` films a walk up a step — judge feet there.
- **Vehicle radii cover the hull half-length** (`createTank/Apc/Artillery` ↔ the kit hull's authored
  length × `VEHICLE_KIT_SCALE`, ~2.4 for the tank): a circle smaller than the hull let tanks park inside crates. Spawn clearance
  (`freeSpawnNear`) is sized to the unit; `debugSpawn` separates from what is there and a staged wall
  pushes standing units aside. `scatter.test.ts` audits every map: no prop overlap, no prop
  straddling a step (`findRoom` moves an authored piece off a step, mirror-aware).
- **Push** (2026-09-24): `queueShove` is a melee order with `shove: true` (same rush); it resolves in
  `resolveShove` → `applyKnockback(..., { ringOut: true, maxThrow: SHOVE_MAX })`: a body shoved past the arena
  edge falls off the map and dies, into water drowns; vehicles' mass keeps them near. The shove's impact has a
  long duration, which the renderer reads as a heavy flinch, so a shove kill plays the THROWN death.
- **Rotatable placement**: `placementTurn` (45° steps, `rotatePlacement`, T key / Rotate ⟳ button) turns a
  line strike about its target point and a wall's facing; reset when a new placement is armed.
- **Charge / dash / breach**: `meleeRange()` adds `MELEE_RUSH` (3.5m) for all infantry and `STRIKER_CHARGE` (6.5m) for the striker; the melee
  order closes the gap first (a real move: mines + separation apply; the swing clock
  starts in reach); a sapper round vs cover/wall is 9999.
- **Airburst** (grenadier): `airburstBehindCover` — a launcher round that strikes or proximity-fuses
  on a COVER piece lands `AIRBURST_SHARE` (0.5) of its direct damage on the intended target within
  `AIRBURST_REACH` of the burst. Cover is half protection against the launcher, never full.
- **Fear** (flamer): in `queueEnemyOrders`, enemy INFANTRY within `FLAMER_FEAR_RADIUS` (6) of a
  `burnZones` entry flee straight away from it (ahead of the retreat/press goals; a flag carrier
  still runs the flag home).
- **Recon** (drone op, OrderKind/Intent `"recon"`, whole turn): sets `revealedOrders` (serialized)
  when it resolves; next command phase `enemyIntents()` DRY-RUNS `queueEnemyOrders(dryRun)` and
  restores CP/grenades/yaw/orders/log/rng (`Rng.save/load`) so the preview equals the real command;
  `addOrder` is silent while `previewingEnemy`. Cleared in `endTurn` after the real command.
- **APC carry**: `isCarrierKind` (transport | apc) shares the airlift machinery; an APC boards only
  foot troops standing beside it (`APC_LOAD_REACH`) and drops the ramp where it stands
  (`APC_UNLOAD_REACH`, it does not drive to the point).
- **Artillery deploy** (`deployed` on the entity, serialized): `queueShootFor`/`queueShootAt` refuse
  an undeployed artillery; `endTurn` deploys one with no move/ram order (next to hull-down, both
  sides) and undeploys one that moves; a move while deployed needs the whole turn (`"deploy"` order
  = explicit whole-turn version). The AI holds an artillery once it has a target in reach.
- **Strafe** (gunship): `strafeAlongPath` from the move order — one 0.75x autocannon burst as direct
  damage at each hostile within `STRAFE_RADIUS` (4) of the aircraft as it passes, once per unit
  (`order.strafed`). The air-to-air rule is for aimed fire; the gun run is the exception.
- **Carpet** (bomber): the bomb order lays `CARPET_BOMBS` (3) bombs `CARPET_SPACING` apart along the
  yaw, each released where it falls (`launchGrenadeAtPoint(…, airDropAt)` puts the origin at the drop
  point so a bomb never flies through a flyer between the nose and the spot); a straight-down drop
  keeps the aircraft's heading. One bomb load per run.
- **Balance self-play** (`balance.test.ts`, 24 seeds, ~5 min — six seeds made the seat gate a coin flip): `sim.debugCommandAsAi()` hotseats the enemy AI
  onto the player's army (swaps entity teams, economy, mines; runs `queueEnemyOrders`; swaps back).
  6 maps x 24 seeds, same 8-kind seeded roster both seats, prints a per-kind damage-per-$ table and
  gates combat kinds to 0.5x-2.5x of the median (`UNGATED` lists the exceptions and why) and the
  player seat to 40-60% of decided games. The AI's "crippled" retreat reads `status.disarmed`, not
  `!canShoot` — strikers/bombers/transports never can shoot and used to retreat all game.
- **Projectile / muzzle / impact FX live in `src/render/projectileFx.ts`** (2026-09-18), in the toon
  language: opaque flat colour + an INVERTED-HULL ink rim (the same pooled geometry drawn again
  BackSide, slightly larger), layered hulls for a white-hot core inside a warm tracer sleeve, and NO
  additive blending anywhere in a shot (the only additive light is the pooled flash light). Fades
  shrink, never dim toward black. `projectileFamily()` maps the sim's four projectile kinds × the
  firing unit to fifteen visual families; `syncProjectiles` only feeds it a position history.
  On top of the family, `UNIT_ROUND` gives each infantry kind its own round shape (tandem burst beads,
  twin side-by-side rounds, spinning brass rings, needle/collar, stubby slug); still warm-only. Check
  with `KINDS=soldier,sniper npm run shots:gpu -- projfollow`.
  Rules: (1) trails are sampled by WORLD DISTANCE (`pushTrailPoint`/`trailStep`), never per render
  frame — a frame-sampled history is a different length at every refresh rate and resolve speed
  (at quarter speed nine flame blobs stacked in 20cm and read as a balloon); (2) blast shapes scale
  by `effect.radius / 0.22` (the blob geometry's width) and the column climbs at most
  `min(radius, 1.3)` — a wide blast is not a tall one (grenade smoke was floating in the sky);
  (3) every shape/material comes from the module's bounded caches and is `userData.shared`; the
  opaque front/back programs are registered in `warmUpSamplers` via `projectileFxWarmUpMaterials()`;
  (4) HIT REACTION is keyed off the visual event, not the damage report: `shoveNear` flinches every
  body within a blast/impact/bolt radius, so a shell bursting beside a trooper, a burn tick or a bomb
  can never land silently (rifle/melee still flinch through the damage report as well).
  (5) **NOTHING IN A SHOT APPEARS OR DISAPPEARS AT FULL SIZE** (2026-09-21, from "every frame they
  appear to splotch out"). A trail element is placed by CONTINUOUS quantities only: `TrailPoint`
  carries `born` (ease-in over `EASE_IN`) and `seq` (a STABLE phase key), and size/colour follow
  DISTANCE BEHIND THE HEAD (`easeOut` to zero by `trailReach`). Never key a size, jitter or stage
  on the array index — the history array rolls on every push, so an index-keyed element changes
  identity between two frames and pops. Smoke puffs are born ≤0.3 scale, rise on their OWN age so
  nothing hangs at head height after the round passes, and never exceed ~0.45 of the flame head.
  A rim-less white ball is banned outright (the flash frame is the POW cut-out star). Per-family shows: comet-tipped DASH tracers, a 3-petal flat muzzle
  flash (a per-round changing fan for the MG, a 7-petal cone for the scattergun), brass casings on
  every small-arms round, a ripple-ring half-beat then a long tracer + vapour trail for the marksman, flat
  ink-rimmed cut-out stars facing the camera for every hit, ground chew where a small-arms round
  stopped, POW + debris + multi-ring + dust crown for shells, a sabot streak and a spark-fan cone
  for tank AP, and a smoke-column afterlife on the renderer's own clock (`blastAfterlife`).
  Evidence is `shots:filmstrip -- all` (SwiftShader) + `shots:gpu volley` (real GPU) + **`shots:gpu
  temporal`** — twelve CONSECUTIVE real-GPU frames at full resolve speed; read neighbours, and a
  shape absent in frame N and full-size in N+1 is a fail. (`shots:filmstrip artillery` only fires
  because the stage plants the outriggers first — an undeployed piece refuses the order.)
  (5b) **BULLETS ARE BURNING STREAKS** (2026-09-24, owner: "the main bullet ones look not amazing"): the small-arms
  tracer is four layers (white-hot core, tracer sleeve, `TRACER_DEEP` burn sleeve, ink) 2.7x long with a tapered
  `spike` tail, and trails an OPAQUE inked tube tapering to nothing (`solidTube`, radius quantised to 4mm so the
  tube cache stays bounded) instead of a hair-thin translucent one. **Blasts are drawn at most `BLAST_DRAW_MAX`
  (2m) radius** (a vehicle kill's ~4m blast covered half a squad; the sim radius is untouched), and the shell
  dust CROWN is a low thin ring (it hovered at 0.9m, 2.4x thick and inked, and read as a beige plate).
  Evidence: `shots:gpu -- volley temporal`.
  (6) **ONE BALLISTIC LANGUAGE** (2026-09-22, owner: "some projectiles look like laser beams"): every round is a physical bullet, tracer or shell in WARM colours. No team-colour tracers, no energy darts, no muzzle-to-target lance tubes, no electric impact stars. The sim's `bolt` rounds (APC/turret/aircraft/flak) draw as the `mg` family; the base relay's as a `tank` shell. The only electric visual left is the lightning map event (`makeLightning`); the old orbital-lance beam is gone too (2026-10-07: it is the Gun Run, a jet strafe).
- **Frame loop is guarded** (`frame` → `frameBody` in try/catch, `__rht.frameErrors()`); one bad frame never kills rAF again.
- **`dt` is floored at 0.** rAF's timestamp is the frame's START and can predate the boot-time `last`, so the first frame's delta was negative — and `trauma - dt*1.7` turned it into a full-strength camera shake on the title screen (the "earthquake before the slow pan"). `npm run probe:intro` (real GPU) measures camera jitter from boot: 1.48 before, 0.03 after; it fails above 0.2.
- **`window.__rht`** is the entire test/debug surface (sim + `endTurn`/`reset`/
  `scenario(id)`/`perf()`/`diagnostics()`/`describeScene()` …). **Keep it in sync with
  the smokes** when adding sim features they need to drive.

## Electron packaging

`electron-main.cjs` serves the built `dist/` over the custom **`app://rht`** scheme
(`protocol.handle`, explicit MIME table, path-traversal guard) in a sandboxed
`BrowserWindow`. **Never regress to a random-port http server: localStorage is
origin-keyed, so a new port every launch silently wipes all saves** (real 06-24 bug).
`npm run desktop` runs against an existing `dist/`; `standalone` builds first.

**PLAY LOG** (owner 2026-10-01: "when I run the game locally ... sends logs to a file so afterwards when I make
references to what happened while I tested you know what I mean"). Run from the repo (never the packaged
.exe), the shell copies the page console to `game/logs/play-<time>.log` and `game/logs/latest.log` (last 20
kept, git-ignored; `RHT_NO_PLAYLOG=1` off). The game writes a `[play]` trail (`src/debug/playLog.ts`): every
button clicked (label + data-*, DISABLED flagged), every ground click with what was armed, battle starts, each
turn's phase, every sim log line during a battle (orders, refusals WITH their reason, hits, kills), toasts,
uncaught errors -- plus every console warning/error and renderer crash. **When the owner refers to his
playtest, read `game/logs/latest.log` first.** `RHT_HIDDEN=1` launches the shell without showing a window.

## Persistence

All localStorage, keyed `rht.*`: `rht.settings.v1` (incl. `keybinds`,
`highContrastTeams`, `debugInfiniteMoney`/`debugFreeCooldown`), `rht.progression.v1` (purely cosmetic),
`rht.savedBattle.v1`, `rht.commander.v1` (battle stats, medals + the distinct map/mode/faction wins the
Achievements page counts, doctrine mastery — cosmetic).
