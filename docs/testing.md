# Testing, QA gates and the glitch ledgers

Every command, smoke, probe and oracle, and the hard-won ledgers behind them. Run commands from `game/`.

## Commands (from `game/`)

| Task | Command |
| --- | --- |
| Dev server (port **5175**) | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Unit tests (vitest) | `npm test` (single file: `npx vitest run src/game/sim.test.ts`) |
| Build | `npm run build` (tsc + vite build) |
| **Gate before commit** | `npm run verify` (typecheck → script syntax check → test → build) |
| Full gate + smokes | `npm run test:full` |
| Every smoke, serially (buttons flow economy deep ground ui-audit faction animation attacks director hotseat) | `npm run smoke:core` |
| Movement + projectile oracle (AI vs AI, all maps; part of `npm test`) | `npx vitest run src/game/movement.test.ts` |
| Collision filmstrip (fling into crates, boulder on a base) / sim radius vs drawn footprint | `npm run shots:gpu -- collisions` / `-- footprints` |
| Every sim effect has a sound (types and `*_FX` colours vs main.ts; part of `npm test`) | `npx vitest run src/audioCoverage.test.ts` |
| Map fit per unit class (tank routes, drive, cover, high ground, ring-out) | `npm run probe:map-fit` |
| Map layout: no props/posts overlap, nothing straddles a step (part of `npm test`) | `npx vitest run src/game/mapLayout.test.ts` |
| Fun units close up + their verbs mid-action (real GPU; `FUN=faction:kind,...` to pick) | `npm run shots:gpu -- fununits` |
| Map features: rails + train, launch pad, thin ice, barrels (real GPU) | `npm run shots:gpu -- mapfx` |
| Map features through the sim (train, pads, ice, barrels) | `npx vitest run src/game/mapFeatures.test.ts` |
| Round origin vs the drawn weapon, every shooter (data, real GPU) | `npm run shots:gpu -- muzzlecheck` |
| Faction look measure (silhouette IoU + hue per faction pair, every roster unit's membership; `MEASURE_GATE=1` fails below goal) | `npm run measure:factions` |
| Map look measure (board contrast / range / one-hue share; `SHOT_PREFIX=before-` for a baseline) | `npm run measure:maps` |
| CPU profile of the stress scene / scene census | `npm run perf:profile`, `npm run perf:census` |
| AI-vs-AI faction matchups (not a gate, ~5 min) | `npm run balance:factions` |

**The wording gate (`wording.test.ts`, inside `npm test`, 2026-10-07)**: every number a tip quotes (catalog tips, action cards in
`hud.ts`, defenses, support powers) is asserted against the constant that does the work (`BOOM_RADIUS`, `PUNCH_MAX`, `HOOK_REEL`, ...);
the player-facing strings of the catalogs, `hud.ts`, `main.ts`, `tech.ts`, `factions.ts` and `commander.ts` may not name a cut unit or
system (`CUT`) or say "CP"; every card label is one or two words. Fault-injected: a 3.5m Boomer tip and a "Hornets" tech blurb both fail it.
A new number in a tip gets a line here; a cut unit gets added to `CUT`.

**`npm run shots:gpu -- fundeck`** (2026-10-07): the Shockwave on a squad beside a tank, a Spring Trap launch and a Tank Drop, each
framed before the resolve (`-pre`) and in four slow-motion frames with the camera held (`__rht.holdCamera(true)`: the resolve director
otherwise pans away). Victims are PLAYER units hit by an enemy call: the enemy AI walks its own troopers off before a strike lands.

**`npm run shots:gpu -- corners`** (2026-10-07): the four corners of every map at play zoom, HUD hidden, Hill mode. It found the ground
PLATES (the soft value patches, `makeGroundPlates`) running across the rim into the dark surround: blobs centred near the edge reached
~23m. Plate vertices are now clamped to the board. `mapLayout.test.ts` "every drawn ring is on the board" holds the hill zone, hazard
zones, pads and landing rings inside the bounds (fault-injected).

**`npm run probe:mix`** (2026-10-07): every Sfx voice (guns, verbs, deaths, booms, moments, UI) rendered offline in a hidden muted
browser (`__rht.measureMix()`), peak + loudest-400ms RMS in dBFS. Gates: no clip (peak <= +0.5), nothing silent (peak > -40), UI >= 5 dB
under the combat median, verbs within 9 dB of the gun median (targets 6 / 8; a run's random picks move a median ~2 dB). Fault-injected
(the old 0.6 confirm gain fails). `smoke:buttons` also fails if any real click makes no sound of its own (the hover whisper does not count: it once hid nine
silent controls) or the wrong family's sound (`__rht.sfxUiLog`). `npm run shots:gpu -- sweeps` films every lane hazard and rolling
strike at fixed points of its run (injected effect, pinned age).

**The balance gate (`balance.test.ts`, inside `npm test`)** measures damage per dollar against the median kind. Two crediting rules
(2026-10-06), both measured, not tuned: a KILLING blow also counts the health it denied (a Marksman's one-shot head kill used to count as
16 damage and read as a dead buy), and a Turret Tech is credited with its sentries' damage and charged their $70. The player seat lean (~60-69%) was
the unmirrored supply caches (cut 2026-10-08); it reads ~53%.
| Perf bench + leak probe | `npm run perf` (`-- --update-baseline` to rebase) |
| AI vision inspector | `npm run vision` (`-- <scenario>` or `-- all`) |
| Scenario screenshot gallery | `npm run improve:gallery` |
| Review contact sheet → `shots/` | `npm run screens` |
| Quick gameplay-zoom look per scenario (`-- firefight siege`, `:select`/`:shoot`/`:base` HUD states) | `npm run shots:look` |
| Per-map prop census + HUD-less close frame of every map section (`-- karak verdant`; `SHOT_PREFIX=before-` for a baseline) | `npm run shots:props` |
| 12-frame attack filmstrip at half/quarter speed (`-- melee`, `kill`, `jump`, or a projectile family: `shoot heavy sniper sapper pistol flame grenade launcher mortar tank artillery apc turret gunship`, the audit stages `smoke carpet strafe throw`, `all` for every family; `FILM_SLOW=<n>` stretches the gaps on a software GPU) — judge motion here, not in stills | `npm run shots:filmstrip` |
| Depth-fight repro (hide plates / kill shadows / lift plates / old near plane) | `npm run probe:depth <scenario>` |
| Infantry lineup, near + far, for kit/proportion review | `npm run shots:lineup` |
| Rebuild the Blender kits (validated, AO-baked) | `npm run art:kit`, `npm run art:props`, `npm run art:vehicles`, `npm run art:validate:selftest` |
| A/B two screenshots (hottest region, 3× crop) / inspect a GLB | `npm run shots:diff a.png b.png out.png`, `npm run art:inspect <glb>` |
| Start one map headless and print the in-page error | `npm run probe:map <id>` |
| Boot camera steadiness on the real GPU (the title "earthquake" regression) | `npm run probe:intro` |
| Units inside the terrain (title diorama + 5 AI turns on every map, ~3 min) | `npm run probe:terrain [map]` |
| **Real-GPU frame-time probe** (hidden Electron, diffs compiled programs across resolves) | `npm run soak:gpu [scenario]` |
| **Real-GPU screenshots** (`-- menu firefight lineup rings abilities direction nowalk maps volley vehicles structures …`; `vehicles` / `structures` = the vehicles-kit review frames, both teams; `maps` = one gameplay frame per battlefield (`volley` = a seven-family firing line mid-resolve: rounds, trails, flashes, blasts on the real GPU); UI screens `deploy settings armory achievements tech tutorial pause victory defeat hover hover-deck`; `air` = the four flyers, both teams; `deaths` = every death family filmed (16 frames); `climb` = the Move preview up an Ironworks slab (▲ CLIMB tag, draped path, three consecutive frames of the selected unit); `basedeploy` = the base's deploy ring at the Ironworks rim (`PROBE=1` adds no-overlay / no-shadow bisect frames); `tech` = the research table fresh + mid-game; `heroprops` = the nine Blender hero props in two rows; `life` = each map's living prop (smoke, flare, sparks, chimney); `movefield` = the no-go tiles on three maps; `airghost` = the Skyguard / Gunship / Tank deploy ghosts and the gunship bomb-run preview; `defenses` = each faction's Defenses + Support decks fresh and fully researched, a turret placement ghost legal / refused, the top strike's reticle, and every emplacement close; `glprobe` = GL errors per frame in a battle (must print all zeros; run after any postprocessing / n8ao / three bump); `basesel` = the real base pick on every map, camera untouched, HUD on (the deploy circle must sit above the command panel); `baseclose` / `baserings` = close base-circle frames; `factions` / `sameside` / `factionmeasure` = the faction-look frames; `mapselect` shoots the Skirmish page at 1280×720 / 1600×900 / 2560×1080; `SHOT_PREFIX=before-` for a baseline build) | `npm run shots:gpu` |
| Locomotion filmstrips (`-- walk` flat-ground stride in profile, `march` scout, `trudge` heavy, `crouch`, `step` = up a terrain step vs talus / plates) | `npm run shots:step` |
| Build + Electron gameplay smoke | `npm run test:play` |
| Desktop app (build + Electron) | `npm run standalone` |
| **One-command shareable .exe** | `npm run dist:exe` (portable, → `release/`) |

**Stop dev servers before ending the turn.** The owner only tests via the standalone build
(`npm run standalone` / the `.exe`) — never hand back with `npm run dev` (or any server/watcher)
still running. Kill the process tree (`taskkill /T` on win32, as `harness.mjs close()` does) so no
orphan squats the port and serves stale code.

### Smokes (Playwright, `scripts/smoke-*.mjs`)

**Shared harness: `improve/lib/harness.mjs`.** New smokes/shots MUST import it, not re-inline the
server+Chromium boilerplate: `launchGame({port,query,viewport,init})` boots a muted headless page
and returns `{page, errors, close}`; `close()` **process-tree-kills** the Vite server (`taskkill /T`
on win32) so no orphan survives to serve stale code (the recurring Windows bug). `assertLit(page,label)`
is the black-frame guard; `endTurnAndSettle`/`waitForCommand` step the sim. The 3 wired smokes +
`smoke:deep` use it; the legacy `shot-*.mjs` still re-inline theirs (migrate on touch).

Each smoke owns a dedicated `--strictPort` (a sibling project squats 5175): flow `5179`, economy
`5176`, buttons `5191`, deep `5206`, attacks `5212`, screenshots `5177`/`5178`, perf `5182`, vision `5183`. They
drive headless Chromium via `window.__rht`.

- `npm run smoke:flow` — menu → deploy → multi-turn battle → reset
- `npm run smoke:economy`, `npm run smoke:buttons`
- `npm run smoke:deep` — consolidated regression net for the air/transport features through the
  full sim→render→HUD path: air fleet render, air-to-air, transport load/carry/unload, straight-down
  bomb, serialize round-trip, victory screen. Wired into `test:full`.
- `npm run smoke:attacks` (in `smoke:core`; `-- <case>...` for a subset) stages EVERY attack — 21
  guns, grenade throw, mortar smoke, melee, both bomb drops, the gunship gun run, the tank ram — in a
  live battle and watches each frame: the attacker's weapon (the free arm for a throw) must leave
  rest, a round must be drawn where one flies (`__rht.fxCounts()`), the landing must be drawn, no
  frame error. Its sim-side twin is `src/render/attackCoverage.test.ts` (keyed on `TroopKind`, so a
  new troop without an attack case is a compile error). Below 20 fps (a software GPU) it runs the
  resolve clock x2; there it takes ~10 min, on a real GPU ~2.
- `npm run smoke:electron` (wrapped by `test:play`) boots the BUILT app in Electron: menu, GLB MIME,
  menu-driven battle start, a resolve round-trip. It sat "hanging" for weeks because the script
  itself had a regex syntax error — an Electron main-process error raises a MODAL DIALOG instead of
  exiting, so the run just stalls. `npm run check:scripts` (inside `verify`) now `node --check`s
  every harness script so that can never ship again.
- Gameplay smokes that test the MENU navigate it (`[data-menu="play"]` → `[data-map]` →
  `[data-start]`) and usually grant cash via `sim.economy.set("player", N)`.
- **`[data-start]` deploys are DEFERRED** (loading veil + two rAFs), and the sim sits in phase
  `command` with a full default scenario from page load — so waiting on `phase === "command"`
  after the click proves nothing, and `configure()` then splices the entity list. Anything spawned
  in that window vanishes and the next order is rejected (the intermittent "could not queue a move
  order" in `smoke:animation`). A smoke that seeds state right after deploying uses
  `deployBattle(page, {map, mode})` from the harness (calls `__rht.startBattle()` synchronously and
  pins the map), or waits on `sim.mapDef.id === <map>` as well as the phase.
- **`?lowfx=1`** forces the composer-free render path — functional smokes and perf use it
  (SwiftShader stalls on the bloom chain); `vision`/gallery run full-FX.
- `npm run shots:gpu -- fieldhands mounts audioprobe`: the 2026-10-03 units and placements, crewing a gun post (Man armed,
  walk-up, crewed), and a probe that each map picks one of its own three tracks and every audio file is served (200).
  `src/game/fieldhands.test.ts` covers heal / repair, charges, pads (incl. ring-out), oil, barriers, the rocket and the posts.
- `npm run shots:gpu -- newunits techui posts toast slamfilm clash knockfilm` = the batch-3 look: the eight new troop types per faction, the four-column tech tree + Base / Support / Defenses / Deploy decks, the field posts, the achievement toast, the Sledge's swing, mid-air clashes and the fly-back throw. `newunits.test.ts` proves every new unit, strike, post and base upgrade through the real sim.
- `npm run shots:gpu -- review strikes` (2026-10-03 harsh review): `review` selects each new kind with the real HUD up (order panel, base Upgrades deck); `strikes` films EMP, Medevac, Smoke, Minefield, Rail Strike and Sentry Drop. Foes staged with their weapons zeroed throw part debris (the orange chunks in those frames), that is the stage, not a bug.
- `npm run shots:gpu -- hopflow` is the real Hop flow on Karak: J arms it, hovering the far bank draws the arc and landing ring, a click queues it, and the scout must end standing on the far bank (not in the ravine); `leap.test.ts` covers ledges, water, save/restore, cancel and landing collisions on the map's real (scaled) terrain.
- `npm run shots:gpu -- groundaim` arms Shoot on a tank, clicks a ground spot, moves the cursor away and checks the line stays and Confirm queues that spot.
- `npm run shots:gpu -- projectiles circles controls3 treatanim`: every round in flight, rings across ledges on all six maps, the base deck numbers /
  Tab / hop preview / all-set button, and a medic's aid pose.
- **Audio is auto-muted under automation** (`navigator.webdriver`/`?mute` gate in `main.ts`, mirrored
  by Chromium `--mute-audio` and the Electron smoke's `setAudioMuted(true)`) so background runs never
  blare. `window.__rht.audioMuted()` asserts it; `smoke:flow` guards it.
- Needs the Playwright Chromium cache or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## THE GROUND-HATCHING LEDGER — read this before touching the ground, shadows, or terrain

A fine dashed/striped hatching across the ground has been reported **five separate times** in this
repo. Each report was a DIFFERENT cause that looked identical on screen, and each was chased with
guesses before anyone measured. Every fix below is load-bearing; if hatching is reported again,
work this list first and **do not start by tuning the ground texture** — three rounds were lost
that way and the cause was never once in it.

| # | Cause | Fix (do not undo) | Detector |
|---|---|---|---|
| 1 | **Outer plain tiled a detail texture across 9× the arena** — minified into aliasing hash. This was the big one and the last one found. | The distance gets a FLAT TONE. No tiled map on any ground surface materially larger than the arena. | `npm run smoke:ground` (in `smoke:core`) — asserts it directly, and is **fault-injection proven**: re-add the map and it fails all five maps. |
| 2 | **Terrain-block CAPS overhang their block by 1cm**, so neighbouring caps in a stepped mesa overlap and two coplanar surfaces fight in the shadow depth pass. | `cap.castShadow = false`. The body beneath casts the same footprint. | `npm run probe:shadow <scenario>` — bisects casting off one group at a time. |
| 3 | **Coplanar z-fight between ground plates** — overlapping slabs of one patch all topped out at exactly y=0. | Each slab staggered ~2mm in depth. | Survives `probe:shadow` (it is a main-pass depth issue, not a shadow one) — that is how #3 is told apart from #2. |
| 4 | **Shadow acne** on the near-flat arena under a low sun. | `shadow.normalBias` sized to the shadow TEXEL (~4cm at the current frustum), not a tenth of one. | `npm run probe:ground` — strips albedo, then normal map, then particles, one at a time. |
| 5 | **Ground PLATES coplanar with each other and with water** (2026-09-15). The three plate variants are separate meshes whose blobs sat at identical heights, and all of them sat 3mm above the water surface; with the camera near plane at 0.1 the depth buffer could not separate any of it at tactical distance. Read as dashed "teeth" along patch rims and as hatching over water — and it survived a full shadow-caster bisection because it was never a shadow. | Camera `near` = 1 (it never gets within 4 units of the board); plates on a 5mm ladder per blob AND per variant, lowest 2cm above grade. | `npm run smoke:ground` asserts every plate height is distinct and clear of the floor/water (fault-injection proven: make two variants share heights and all five maps fail). `npm run probe:depth <scenario>` reproduces it on demand (hides plates, kills shadows, lifts plates, restores near=0.1). |

Two rules that fall out of this and apply beyond hatching:

- **A screenshot gate you have not fault-injected is a decoration.** The first version of
  **Placement can never arm and then refuse everywhere** (2026-10-01, owner: a locked Gun Turret armed, then
  every click in the ring failed): `sim.test.ts` "every defense and support either refuses to arm, or arms and
  can be placed in its ring" walks every deck entry for every faction on every map, locked and unlocked
  (fault-injection proven: drop the arm guard and Vanguard's turret fails). The movement oracle that round also
  caught three latent bugs the new AI strikes reached: a walker stepping into a mid-turn wreck (climb exemption
  wider than the lift), a timed-out move halting with its hull in a step (`settleHalt`), and thrown bodies landing
  against a ledge face or shoving a unit into a boulder (`groundFits`).
  `smoke:ground` also asserts (2026-10-01) that a picked base's whole deploy circle lands on screen above the command panel on every map.
  `smoke:ground` passed the exact bug it was written for: it measured a mesh's LOCAL bounding box,
  and a ground plane is a PlaneGeometry rotated flat, so its depth sits on Y and its Z extent is
  zero — every plane in the scene was skipped. It only became a gate after the bug was deliberately
  re-added and the gate was made to fail.
- **A dark shape on the ground is not necessarily a shadow.** #5 was bisected as a shadow for an hour
  because it sat exactly where the mesa's shadow should be. Turn the key light's `castShadow` off FIRST:
  if the artefact is still there, stop touching the shadow pass.
- **Bisect before you tune.** Every one of these five was found by turning things off one at a time
  (`probe:shadow`, `probe:ground`), and none was found by adjusting a number and looking.

## Perf / vision / gallery

Documented in **`game/improve/README.md`**. Commands: `npm run perf`, `npm run vision`,
`npm run improve:gallery`. (The old screenshot-goal loop `improve:cycle` was retired 2026-09-23 —
its goals targeted a UI that no longer exists; smokes + `auditUI()` + `shots:gpu` do that job.)
Repo gotchas:

- **FPS is advisory only** — the hard perf gate is deterministic draw-work signals
  (draw calls, triangles, objects, leak growth) vs `improve/perf-baseline.json`.
  Rebase with `npm run perf -- --update-baseline` after an intentional cost change.
- The debug overlay mounts on `<body>`, **not** `#ui` (HUD rewrites `#ui` each frame).
- **Attribute before you optimise.** `npm run perf:profile` records a V8 CPU profile of the
  stress scenario and prints the heaviest self-time functions; `npm run perf:census` counts
  what is actually in the scene (visible meshes, shadow casters, unique materials/geometries).
  The 2026-09 perf round was won by the profile, not by guessing: the frame was dominated by
  three's per-material uniform machinery, not by triangles or fill.
- **`npm run smoke:ui-audit`** (wired into `smoke:core`, so `test:full` runs it) asserts
  `window.__rht.auditUI()` finds nothing across four viewports x eight screens (title, Skirmish
  set-up, settings, pause, victory, battle, roster, targeting), then FAULT-INJECTS a strip over the
  Skirmish choices and demands the `occluded` rule name it (the gate is decorative otherwise). Every rule is a
  geometric fact — rect intersection, `scrollWidth` vs `clientWidth`, `elementFromPoint` — so a
  failure is never a matter of taste. It exists because three real UI bugs shipped in one session
  and every one was caught by a human squinting at a screenshot. Two rules carry hard-won caveats:
  boxes are CLIPPED to their scroll ancestors before any comparison (a roster card scrolled out of
  its panel otherwise "overlaps" the treasury bar two hundred pixels below), and `clipped` needs an
  absolute tolerance as well as a ratio (a 9px inline `<em>` loses 15% of its area to integer rect
  rounding alone). Deliberate stacks opt out with `data-allow-overlap`; the battle HUD under a menu
  is `inert`, which is both the correct focus behaviour and what lets the audit tell "under a menu"
  apart from "under a sibling panel".
- **`npm run probe:shadow`** turns shadow casting off one scene group at a time and screenshots
  each step. It exists because a striped-hatching artefact across the ground survived three rounds
  of texture tuning, two bias changes and a shadow-frustum rewrite before anyone measured it: the
  cause was **terrain-block CAPS**, which overhang their block by 1cm so the top edge reads, which
  makes neighbouring caps in a stepped mesa overlap, which makes two coplanar surfaces fight in the
  shadow depth pass. `cap.castShadow` is now false and must stay false — the body beneath casts the
  same footprint. Bisect first; a ground artefact is not necessarily in the ground.
- **`npm run shots:silhouette`** renders every unit as a flat black shape on white
  (`window.__rht.silhouette(true)`, which also hides everything that is not a unit). The test is
  "can you NAME each unit from its outline alone" — it is how medic/engineer/sapper were caught
  sharing one silhouette. Shoot the rank **in profile**: head-on foreshortens the long rifles, tool
  rigs and blades that distinguish kits, and the first version of the sheet failed four kits that
  were fine.
- **`npm run audit:unit <kind>`** sorts a trooper's resolved part colours by luminance. Run it
  after any palette work: the recurring failure here is a *large* surface creeping above ~180
  luminance (it was the bare HEAD at 214, brighter than the unit's own glowing ammo), which is
  what makes the roster read as pale plastic. Small emissive lamps at high luminance are fine.

## Units never stand INSIDE the terrain (2026-09-22)

Owner report: a striker's blade stuck into a step on the title screen. `npm run probe:terrain` runs
`__rht.auditTerrainClip()` (every living ground unit's part boxes sampled against `drawnGroundAt`)
on the title diorama and after five AI-vs-AI turns on every map; it found the title units, tanks
parked with hull / cannon in mesas, and zero after the fix. The rules it proved:
- **Clearance** `spawnClearance(radius)` in sim.ts: infantry 1.4m (weapon reach up to ~1.3m + talus),
  vehicles 0.95×radius + 0.3 (hull + barrel + talus). Used by deploy spots, `freeSpawnNear`, the
  move FOOTPRINT, and the settle.
- **Move footprint**: `blockedBySteepTerrain` samples the clearance ahead and to both sides, not just
  the centre line (a unit already touching a face falls back to the centre line so it can leave).
- **Settle**: every ordered move (`blockedMoveDestination`) backs off along its path until no rise
  taller than 0.3m (walkable OR cliff) is inside the clearance — a weapon must not end in a step.
- `debugSpawn(..., { clearTerrain: true })` for staged scenes (the title diorama); tests and scenarios
  keep literal positions.
- Intentionally sunk dressing (Syndicate tents) is `userData.sunk` and skipped by the audit.

## THE MOVEMENT + PROJECTILE ORACLE (2026-09-24) — read before touching movement, rams, wrecks or rounds

Owner: "most of the bugs I've seen is from units moving through the map or clipping or projectiles moving in
the wrong way". `src/game/movement.test.ts` plays AI vs AI on all six real maps, three faction matchups, each
side fielding its WHOLE roster from turn 1, 12 turns, and checks every tick / turn end: rounds finite, moving
forward along their own direction, fired toward their aim, never underground for 2+ ticks, never past the
board rim, never outliving their life; ground units never inside a prop / base / defense, never with a hull
in a step, never sunk. Fault-injection proven (re-adding the flat-ground hole fails Dust Bowl; re-adding the
vehicle climb exemption fails Verdant + Karak). Bugs it found and the fixes (do not undo):
- **Rounds tunnelled through FLAT ground**: `firstGroundBetweenShot` only counted raised terrain
  (`terrain > 0.04`), so a downhill miss dove into the floor and flew on underground. Any ground stops a round.
- **Rounds flew off the board**: a miss now expires 1m past `ARENA_BOUNDS`; a rolling grenade that reaches the
  edge detonates there (clamping it inward made it jump BACKWARDS).
- **Vehicles inside wrecks**: only INFANTRY climb onto cover, so both `separateFromUnits` exemptions (perched
  on top, move destination on the cover) are infantry-only now; a wreck comes to rest on clear ground
  (`clearWreckSpot`) instead of on the survivor beside it.
- **Rams**: the tank charges to CONTACT and stops, with the step check and separation every mover has (it used
  to drive at the target's centre for the whole order — into a surviving target or up a cliff).
- **Clearance sampling**: `onTerrainEdge` (four diagonal corners) and `risesNear` (one ring) both sample a disc
  now (`discSamples`: two rings of 12) — a step corner could sit inside a unit's clearance unseen.
- **`auditTerrainClip` measures real vertices**, not the world AABB (a rotated tread's box juts past the
  tread: the "tank 0.57m in a Verdant step" report was the box). `probe:terrain` = 0 on every map,
  fault-injection proven (tanks drawn 0.6m low → caught).
- `projectiles.test.ts` asserts a round's HEADING at its target, not "passes within 2.2m" (that proxy only
  passed because a dipping round burrowed on past the target).

## Move orders that go nowhere are REFUSED (2026-09-22)

`queueMoveToDestination` refuses (no CP spent) a move whose blocked stop is within 0.3 of the start,
leaving the block reason as the newest log line; the "move limited to Nm" line now only appears when
RANGE was the limit. It used to accept a zero-length order and charge a CP — a tank "ignored" its
order at the Ironworks ramp. `edgecases.test.ts` walks climbing and order edge cases end to end on the
real maps (mesa steps, the overpass deck, climb-on/off cover, floating/sunk units after 5 AI turns on
every map, cancel refunds, dead-before-order, shared destinations, water).
- `npm run shots:gpu -- airaim muzzlecheck` (2026-10-03): `airaim` = gunship Bomb armed, ground spot picked 6m off (line + splash stay put as the cursor wanders, no move queued), Confirm, the fall filmed; `muzzlecheck` prints, per shooter, the gap between its round origin and its drawn weapon mesh. `muzzles.test.ts` pins the aircraft values; `orderLabel.test.ts` pins every order's name.
- The `treatanim` shot case, the medic/engineer/sapper/apc/interceptor smoke attacks and the pad/oil fieldhands frames were removed with those units (2026-10-04). `ui-audit` gained a `clipped-text` rule (text poking past a clipping box) and a 1366x768 viewport.
- `ui-audit` also has a `blurred-glow` rule (toon UI: hard offset shadows only; it found AP pips, faction pips, the log toggle, the end-screen title and the detail card still glowing). `chaosRoster.test.ts` fuzzes every troop kind with every order on all six maps with save/restore round trips.


**Smoke staging (2026-10-09).** A smoke that stages a battle must wait for the BATTLE, not just `phase === "command"`: the menu's
sim is in a command phase too, and the real battle is configured a few frames later under the `.battle-loading` veil. Staging before
it was silently wiped. `smoke:director` failed about half its runs for exactly this reason (no shot ever fired, and the check passed
only when the camera's idle sweep happened to pass the kill). Wait for the veil to come and go, then stage.
