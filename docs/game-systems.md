# Game systems: factions, AI, hotseat

How the factions, the three AI brains and Local 2 Players work, with the measurements behind each.

## Rosters: only FUN units (2026-10-07; supersedes every older section that names a removed unit or system)
Owner: "Any unit that isn't super FUN and exciting to use should be removed." Three cuts so far:
- **2026-10-04:** Medic/Corpsman, Engineer/Mechanic, Pad Tech, Interceptor, Oil Rigger, Sapper, APC, the Flak Nest defense, and what only they
  used (`treat`, auras, DOWNED/revives, bounce pads, oil slicks, the sapper mines order, Triage / Welding / Field Hospital). The **Medevac**
  strike is the only heal (Support Wing).
- **2026-10-06:** Trencher (`dig`), Drone Operator (`recon`; the Watch Radar still reveals orders), Bounty Hunter, Transport, Fortifier and
  Demolitionist (`charge` / `barrier`).
- **2026-10-07:** Scout, Ricochet Gunner (`lancer`, the `chain` stat), Turret Tech and with it the whole placement system (`place` intent,
  `PLACEABLES`, `queuePlace`; the sentry entity stays for the Sentry Drop strike). The **Runabout** lost its gunner seat: its MG always fires.
- An old save holding a retired kind loads without it (`restore()` drops unknown kinds).

## Fun audit, round 3 (2026-10-08; supersedes every older deck list)
Owner: "I don't want any support or defense or base upgrade or units or things on map that aren't fun". CUT: Paradrop, Minefield Drop,
Airstrike (supports), Sandbags and the Gun Turret (defenses), the Runabout (unit), the supply/cash caches (`pickups`, `placePickups`,
`checkPickups`, the cache render and click) and the second base order (`upgradeBaseCommand`, `COMMAND_UPGRADE_COST`). The map's
derelict turrets and its sandbag walls stay (map neutrals / cover, not buildables). ADDED, each on an existing engine:
- **Commando Drop** (support, $300, Support Wing, Vanguard, `landCommando`): one Jump Trooper parachutes onto the point and lands with
  the jet-pack slam (`slamLanding`, shared with the Jump Trooper's own landing: `SLAM_LANDING_DAMAGE`, thrown within
  `JUMP_SLAM_RADIUS`). He acts from next turn (`chuted` marks him for the renderer's fall); a full field gets the slam only.
- **Car Bomb** (support, $220, Demolitions, Syndicate): a driverless wreck rolls `CAR_BOMB_LENGTH` (14m) down the line as a sweep
  (`queueSweep("carbomb")`, ramming 16 and throwing 3m), then a `carblast` (62 damage, `CAR_BOMB_RADIUS` 3m) where it ends; a heavy in
  its path stops it and it goes up against the heavy there.
- **Barrel Stack** (defense, $70, every faction's starter): the map's red-barrel cover (`coverKind: "barrels"`), neutral and volatile,
  so whoever shoots it sets off the chain.
- **Napalm** is now the Syndicate's starter (no tech). The Support Wing tech unlocks the Commando Drop; Demolitions the Boomer and
  the Car Bomb; Motor Pool the Chop Bike.
- **Decks:**
  - Vanguard: Barrel Stack / Spring Trap / Harpoon Tower; Shockwave (start) / Commando Drop / Tank Drop.
  - Syndicate: Barrel Stack / Minefield / Harpoon Tower; Napalm (start) / Car Bomb / Barrage.
  - Bastion: Barrel Stack / Mortar Turret / Harpoon Tower; Boulder Roll (start) / Gun Run / Tank Drop / Barrage.
  - Base: income and the Fortress Cannon.
  - Rosters: 11 each.
- Every support power now damages (`DAMAGING_SUPPORT` holds them all, `attackCoverage.test` asserts each lands and hurts).
- **Balance (self-play, 2026-10-08):** player seat 53% of decided. Per map: Dust Bowl 4-6, Ironworks 11-9, Verdant 9-8, Causeway 9-5,
  Karak 6-8, Crossfire 9-7. The Flak Track's shot went 18 -> 20: it sat at 0.48x the median once the Gun Turret stopped being a
  target.
- **Movement fix found by the oracle:** a ground move that runs out of time on a bent (shoved) path could stop with its hull in a step. `settleHalt`
  now falls back to the nearest ground the hull fits on (`nearestFittingGround`).

## Tech that makes sense (2026-10-08, audit pass)
- Rule (`tech.test` "every faction's tech list is all signal"): every node in a faction's list gives THAT faction a troop, defense,
  strike or base upgrade, or is the road to one that does; everything in its roster and decks is reachable through its own list.
- Motor Pool is each faction's light machine (Rocket Skater / Chop Bike / Bulldozer) and stays the road to Armor Bay. Vanguard's
  Jump Trooper moved to Assault (its Shock node held five units, its Assault one). Field Works is Bastion's alone (Juggernaut,
  Mole). Bastion's bot now researches Field Works. The Bulldozer tip no longer claims it shoves tanks.
- Faction matchups (`SEEDS=11,23,37,59,71,83,97,101 npm run balance:factions`, 288 games): Vanguard over Syndicate 35-24, over
  Bastion 37-22; Syndicate over Bastion 30-18: all inside 35-65%. Bastion troopers lost their 8% move penalty, Vanguard's
  their speed bonus dropped 12% -> 6%. The Jump Trooper stays $170: at $185 the Normal bot stops buying it and Vanguard falls to
  ~30% (a buying threshold, not a smooth knob). The Bomber went $470 -> $560 (it sat at 2.35x the median damage per dollar).

## Maps fit the units (2026-10-08, audit pass)
`npm run probe:map-fit` (src/game/mapFit.probe.ts, pure, ~3s) measures what each map offers each unit class:

| map | tank routes | tank drive | cover (centre) | high ground | ring-out on the route |
| --- | --- | --- | --- | --- | --- |
| Dust Bowl | 4 | 83m | 46% | 541 m2 | 0% |
| Ironworks | 3 | 42m | 58% | 74 m2 | 44% |
| Verdant | 4 | 49m | 53% | 441 m2 | 6% |
| Causeway | 3 | 95m | 27% | 83 m2 | 0% |
| Karak | 4 | 50m | 43% | 185 m2 | 52% |
| Crossfire | 2 | 58m | 58% | 121 m2 | 15% |

Every map has 2+ tank-width routes and infantry cover in the middle. The draw-heavy maps (Dust Bowl 14/24, Causeway ~9/24 in
the 16-turn self-play) are the two long drives. MEASURED AND REJECTED: shortening them (large-map scale 1.41 -> 1.25/1.33 and
bases pulled in: drives 83 -> 64-75m) left Dust Bowl at 14 draws and cost three props to the walking-gap rule, so it was
reverted. Those two maps simply deal less damage per game (~1,220 vs ~1,500 elsewhere); lanes are not the cause (a no-lane run
changed nothing). Their pace is a design call for the owner, not a bug.
- **Causeway drawbridges**: each bridge deck is a leaf hinged at one bank (`makeWaterAndBridges`, `bridgeLeaves`); while the
  icebreaker passes, a crossing within ~4.5m of its hull swings up ~70 degrees and drops back after (`liftBridges`, renderer only).

## Visual + audio QA pass (2026-10-08, independent visual-qa agent on fresh real-GPU shots)
Fixed (ranked majors): the boulder tore into loose triangles (`boulderGeometry` lumped an unwelded icosahedron per index:
now `mergeVertices` first); the transport jet's contrail drew a white band over a low camera (it fades within ~7-14m of the
camera; the engine dots are no longer additive); the Car Bomb drove through props (it now goes up against the first solid
prop / post / wall: `sweepStep`; a stopped sweep stops being drawn, `stopSweep`, so a boulder no longer rolls on through the
tank that broke it); the icebreaker left the ice whole (it opens a dark channel with floes over `terrainIce`); the NEXT TURN
banner covered the last blast (it waits for blasts / sweeps / landings to finish, up to 2s); the parachute canopy hung out of
frame (lower canopy, 6m drop); the devil's wireframe tumbleweed is solid. `npm run screens` works again (its settings selector).
Audio: `src/audioCoverage.test.ts` fails if a VisualEvent type or an exported `*_FX` colour has no sound branch in main.ts
(fault-injection proven); the dead "shot" effect (gun run) was removed. Every map has its music set and ambience bed.
Deferred minors (not bugs): cattle carry no ink outline; Vanguard artillery foot-pads read apart from the legs; part-debris chunks
linger into the next turn; the resolve camera can frame a commando at the edge.

## Map events look and sound right (2026-10-08)
- **Drawn** by `src/render/sweepFx.ts` (`drawSweep`, keyed by the roll effect's `SWEEP_FX` colour), all shared geometry, nothing additive,
  deterministic from the sweep's progress (a dust trail is the puffs kicked at earlier t): the DUST DEVIL is a twisted, banded lathe
  funnel that spins, leans and weaves, with a churning dust skirt and debris (clods, a plank, a tumbleweed) orbiting up it; the
  STAMPEDE is six low-poly cattle (horns, ears, muzzle, hide patches, swishing tail) in a loose wedge whose rotary gallop is driven by
  distance travelled; the BOULDER hops, flings grit and leaves a plume; the ICEBREAKER throws bow spray and ice shards, leaves a foam V
  wake and funnel smoke; the CAR BOMB is a rusty car with lashed red barrels, a fizzing fuse and exhaust. The Commando falls under a
  chute (`makeChute`). Conveyors got end rollers. `sweepWarmUp()` compiles them at load.
- **No prop sits in a lane**: `onLane` (maps.ts) is part of the layout's `fits` and the sim's `onMapFeature`; Karak's colossus moved
  off the boulder's centre lane; `mapLayout.test` "map features are clear" covers every lane map. Known: the Causeway icebreaker
  still sails across the low bridge spans.
- **Heard** (`Sfx.hazard`, for the sweep's whole length): devil wind howl over a rumble; stampede gallop-pair hoof drum swelling and
  fading plus three moos; boulder grinding rumble with a thud each turn; icebreaker horn, engine chug, ice cracking; car bomb engine
  through its gears and a fuse fizz. A conveyor ride clanks (`CONVEYOR_FX`), the commando jet brings a chute flutter (`COMMANDO_JET`).
  `probe:mix` gates them as group `event` (within 9 dB of the combat median).
- **Buttons, one voice per family**: click `ui`, deck card armed `arm` (new rising double tick), order confirmed `select`, deploy /
  research `deploy`, build / base upgrade `build`, back `back`, toggle/chip `toggle`, start / End Turn `turn`, refused `error`.
  Controls with their own voice no longer also play the click (`OWN_VOICE` in main.ts).

## The fun deck (2026-10-07)
Owner: "the sensor scans are not super cool or fun ... audit across base actions, defenses, support". CUT: Recon Sweep, Sensor Mast,
Watch Radar (and the whole enemy-orders preview: `enemyIntents`, `revealedOrders`, the hotseat recon seat), Medevac, Resupply Drop,
Base Armor I/II, Smoke Screen (the support; the Mortar's own Smoke order stays), EMP Burst (`disabledUntilTurn`), the Radar Net tech.
ADDED:
- **Shockwave** (support, $130, Vanguard starter, `landShockwave`): a 4m air-burst, ~15 damage, every ground unit thrown up to 12m
  away from the point (ring-out at the edge, drowning in water). A dust ring, no fire (`isDustBlast`). Medal "Gone With the Wind".
- **Spring Trap** (defense, $100, Vanguard, no tech): a hidden plate in the `mines` list (`spring: true`). The first foe to step on it is
  thrown `SPRING_THROW` (13m) away from the owner's base (`springLaunch`), its move ended. Friendly ones draw as a hazard-yellow plate.
- **Tank Drop** (support, $460, Armor Bay, Vanguard + Bastion, `landTankDrop`): troopers under the chute take 60 and are shoved clear,
  then a tank lands for the caller (it falls the last 14m in the renderer) and fights `TANK_DROP_TURNS` (3) turns before it is
  scuttled into a wreck (`dropTtl`, `runSentryTick`). Medal "Special Delivery".
Decks: Vanguard Shockwave (start) / Airstrike / Paradrop / Tank Drop; Syndicate Minefield Drop (start, no tech now) / Napalm / Cluster /
Rail Strike; Bastion Sentry Drop (start, no tech now) / Gun Run / Tank Drop / Barrage / Rail Strike. Vanguard's Defenses: Sandbags,
Wall, Turret, Spring Trap, Gun Post, Rocket Post. Base upgrades: the Fortress Cannon only. Decks hold 4-6 powers (`doctrines.test.ts`).

## Focus cut, round 2 (2026-10-07, owner: "a focused set of only fun things"; picks in docs/fun-ideas.md)
- **Gone:** launch pads (Karak, Crossfire) and every carrying rule (Runabout Load / Unload, `passengerIds`, `carriedById`, the AI
  ferry); the Crouch card (the stance stays: cover and suppression still crouch a trooper); the Marksman's Mark; the Man / Leave
  cards (a trooper ordered onto a free post crews it, walking away leaves it); the buildable Gun Post, Mortar Pit, Rocket Post, Flame
  Post, MG Bunker and Blast Wall (the posts stay on the maps); the four stat-bump tech pairs and Sharpshooters; Cluster Strike, Rail
  Strike and the Sentry Drop (with the whole sentry entity).
- **Every Strike throws** (`STRIKE_FORCE` / `STRIKE_MAX` 6m); the Push card is the Breaker's Punch only.
- **A hop is a dodge**: shots at a trooper that jumped this resolve scatter `DODGE_SPREAD` (1.7x) wider (`dodgeTurn`).
- **Boulder Roll** (Bastion's starter, $150, `queueBoulder` / `boulderStep`): a stone the width of a lane rolls 18m down the line,
  bowling every unit aside (34 damage to troopers, thrown 4m off the lane); a heavy breaks it and ends the roll. Drawn as one `roll`
  effect (`boulderGeometry`), heard as a rumble.
- **Artillery** fires or moves in a turn, never both (the Deploy card, outrigger state and auto-deploy are gone; the outriggers are
  always drawn down). **Tanks RUN OVER troopers** in their path (the bowling path, `RUN_OVER_*`; Hull Down is gone).
- **Mortar SALVO (Walking Fire)** replaces the smoke round: three half-damage shells land short, on and long down the mortar's
  line (`queueSalvoAt`, `SALVO_*`); smoke clouds no longer exist. The Hard bot walks a salvo across a clump (`aiSalvoAct`).
- **Harpoon Tower** (defense, $180, Shock Troops, Vanguard + Syndicate): fires by itself at end of turn at the nearest ground foe in
  14m (`queueHarpoonTowers`) and its hit drags the foe to the tower (the Hookshot's `pull`); heavies never move.
- **Decks now:** Vanguard Sandbags / Gun Turret / Spring Trap / Harpoon Tower, Shockwave / Airstrike / Paradrop / Tank Drop; Syndicate Sandbags / Gun
  Turret / Minefield / Harpoon Tower, Minefield Drop / Napalm / Barrage (now Ordnance Lab); Bastion Sandbags / Gun Turret / Mortar Turret, Boulder Roll /
  Gun Run / Tank Drop / Barrage. Tech: 12 nodes, one either/or (Fire Discipline vs Demolitions).

## Maps made their own (2026-10-07, focus round)
- **Themed field posts** (`MapDef.posts`): two kinds per map in mirrored pairs, not all five everywhere. Dust Bowl rocket + gun,
  Ironworks cannon + flame, Verdant flame + mortar, Causeway cannon + gun, Karak mortar + rocket, Crossfire gun + mortar.
- **Lane hazards** (`MapDef.lanes`, `lanesOn`, `queueSweep` / `sweepStep`, shared with the Boulder Roll): something big sweeps a
  marked lane on a timer, warned the turn before by a draped band + chevrons (`drapedRibbon`), hits and throws everything on it
  aside once (heavies dented, never moved; only the boulder stops on one). Dust Bowl DUST DEVIL (centre lane, every 3rd turn from
  3), Verdant STAMPEDE (two herds down the flanks, every 4th from 4), Karak ROLLING BOULDER (centre, every 4th from 4), Causeway
  ICEBREAKER (up both channels, every 4th from 3; it sounds the horn). They replace the sandstorm, the ion storm, the lightning and
  the collapse, which are gone with their code. Lanes are point-symmetric (`storm.test.ts`).
- **Crossfire's marked minefield** (`MapDef.minefield`, `placeMapMinefield`): neutral mines under red pennants, in mirrored pairs,
  set off by anyone. **Ironworks conveyor belts** (`MapDef.conveyors`, `runConveyorTick`): at turn start anything on a belt rides
  it 4m toward the slag (heavies stay put); its chevrons crawl.
- Not done: Dust Bowl is still the slowest map (15 of 24 undecided); shrinking it squeezed out its props (tried and reverted).
  Oil geysers were skipped (a launch, which the owner cut). `npm run shots:gpu -- lanes` shows every lane before and mid-sweep.

## Balance snapshot (2026-10-07, `balance.test.ts`: 6 maps x 24 seeds, both seats the Normal AI)
Every combat kind is gated now (`UNGATED` is empty): the Sledge's hammer is swung by every brain and closes in first (`aiSlamAct`:
move + slam in one turn), which took it from 0.11x to 0.77x of the median damage per $; the bomber measures 1.98x. Spread: Tank 1.61x,
Striker / Chop Bike / Breaker / Bulldozer ~1.45-1.55x, line infantry ~0.9-1.0x, Mortar 0.72x, Flak 0.62x (an AA specialist against an
AI that fields few aircraft), Rocketeer 0.64x (likewise anti-armour). Seats 51% / 49%. OPEN: Dust Bowl ends 16 of 24 games undecided
inside the 16-turn cap (the median map ~9): the slowest map, a candidate for a closer layout or a shorter sandstorm.

## Sound moments and the mix (2026-10-07)
- **Moments**: the new-turn banner plays `sfx.newTurn` (a low drum + rising two-note); a map hazard due next turn adds `sfx.alarm`
  (two pips, 650ms later; `sim.forecast(1)`). End turn, victory, defeat, medals, cash and the train horn had theirs already.
- **Menus**: every real pointer click on a control is heard: buttons / chips / toggles (existing handlers), checkboxes and their labels
  (`sfx.toggle`), sliders tick while dragged (`sfx.tick`, pitched by value, 70ms apart), clicking a foe in a list marks it
  (`sfx.select`). `smoke:buttons` asserts it via `__rht.sfxPlayed()` (hover first, so the hover whisper never counts as the click).
- **ONE SOUND, SEVERAL PARTS**: `ready()` throttles synth calls 12ms apart (burst stacking), and that silently dropped every part after
  the first of a multi-part sound (the horn's 2nd note, the medal chime's 2nd/3rd, every synth boom's grit, the new layers). Multi-part
  sounds now go through `Sfx.chord()`: the throttle applies once per sound.
- **The mix is measured**: `npm run probe:mix` renders every voice offline (`Sfx.measure`, an OfflineAudioContext) and gates peak and
  loudness (loudest 400ms RMS). It found the UI LEVEL WITH the guns (the confirm and deploy clicks 8-10 dB over) and the jet pack /
  rocket fist / swing 12-20 dB under: UI gains cut to sit >= 6 dB under combat, those verbs raised to the guns' level.

## Explosions throw, heavies hold (2026-10-07)
Every blast throws a trooper: grenades, shells and mines already ran `applyExplosiveRadius` -> `applyKnockback`; support and map
strikes (`detonateStrike`) now do too (collapse excepted). `IMMOVABLE_HEAVIES` (tank, artillery, bulldozer) have infinite `blastMass`:
no blast, punch, hook, shove, bike or spring moves them; the renderer ROCKS them on the hit flinch instead of sliding them. Only the
freight train still moves a heavy (`opts.train`, or a parked tank is hit every run). Light vehicles (Runabout, Chop Bike, Flak Track)
keep mass 5.5. Guarded by `knockback.test.ts` (one row per source: trooper thrown >= 1m, three heavies moved 0; fault-injected).

The fun units (each verb is the unit; the HUD card is named after it via `UNIT_VERBS` in `hud.ts`):
- **Breaker** (Vanguard, $300) — **Punch**: the push with a 7m dash, 26 damage and an 18m throw (`PUNCH_*`).
- **Hookshot** (Vanguard, $170, Shock Troops) — **Hook**: its shot drags what it hits to its feet (`UnitStats.pull`, `hookPull`, 20 yank
  damage, vehicles move 1/5.5); a steel cable is drawn from the gun to the harpoon. **Reel**: its hop reaches 10m and climbs cliffs.
- **Rocket Skater** (Vanguard, $240, Shock Troops) — **Boost**: every move bowls over foe troopers within 0.9m of its line (12 damage,
  thrown 4m sideways; `UnitStats.bowl`, `bowlAlong`). Rocket boots with flame cones.
- **Boomer** (Syndicate, $110, Demolitions) — **Detonate** after its move: 112 over 3.6m, friend or foe; the barrel is volatile from behind.
- **Molotov** (Syndicate, $170, Fire Discipline) — **Throw**: a 16m bottle that does NOT explode; it smashes into a 2.2m fire for 2 turns
  and sets troopers alight. Fire damage is now credited to whoever lit it (`burning.by`, burn zone `by`), and damage dealt between turns
  (fire at turn start) lands in the report that just closed.
- **Juggernaut** (Bastion, $340, Field Works) — 16m blast cannon whose every throw is scaled by `UnitStats.knockback` 2.2.
- **Mole Sapper** (Bastion, $320, Field Works) — **Burrow**: its move goes underground (`burrowed`: not drawn, not hit by rounds or blasts,
  passes under bodies and props; a dirt puff trail), then it erupts: 20 damage and a 6m throw to every foe within 2m (`eruptAt`). It
  refuses to surface in water or inside a prop or emplacement.
Final rosters (13 / 12 / 12): **Vanguard** soldier, sniper, jumper, heavy, bazooka, breaker, hookshot, skater, tank, hornet, runabout, flak,
gunship. **Syndicate** soldier, sniper, heavy, striker, grenadier, flamer, boomer, molotov, bazooka, sledge, runabout, flak. **Bastion**
soldier, sniper, heavy, mortar, ironclad, juggernaut, mole, tank, artillery, runabout, flak, bomber.
Balance (self-play, 2026-10-07): **supply caches now come in mirrored pairs** (`placePickups`): the free scatter had put six of Karak's seven
on one half, and that was the whole long-running player-seat lean (69% -> 53%). Ironclad $250, Jump Trooper $200. A lobbed weapon counts as
an armour answer for the bot only with 30+ damage (the Molotov is not one).

## Map features (2026-10-07, owner: "other fun things to add to maps ... more fun and unique")
- **Ironworks freight train** (`MapDef.train`, `runTrain`): a train runs both rail-yard tracks every 4th turn from turn 4. The rails are
  always drawn; they glow hazard-orange the turn before (`environment().rails` state "soon") and pulse on the turn ("now"), and the train
  model crosses during that resolve (`progress`). Anything on a track takes 140 and is thrown clear sideways. It rides the event forecast
  chip ("Freight train") and the hover text; `aiDangerAt` keeps bots off live rails.
- **Launch pads** (`MapDef.pads`, `launchPads()`, Karak and Crossfire, mirrored): a trooper that ENDS a plain move on a pad carries on as a
  high, fast leap to the pad's landing ring (`order.launched`). Karak's fire over the ravine; Crossfire's land on the forward nest crowns.
- **Thin ice** (`TerrainSpec.ice`, `pointOnIce`, Causeway): the middle of each frozen channel is walkable ice. A ground vehicle that ends a
  turn on it cracks it (`crackedTurn`, a dark ring under it); still there next turn, it sinks. Bots never park vehicles on ice.
- **Red barrels** (`barrels` cover, every map, mirrored, lowest placement priority): volatile, so a shot sets the stack off (the fuel
  chain reaction and fire).
- Posts, caches and props keep off rails, pads and landing spots (`onMapFeature`; `mapLayout.test` "map features are clear").
- A jump or pad launch that lands flush against a step now slides to the nearest ground its footprint fits on (movement oracle).
- **Sound map (2026-10-07 audit)**: an effect's sound is keyed by type + colour in `main.ts`. Fire of any size (`blast` 0xff7a2a: a flamer
  splash, a Molotov, the slag) is `sfx.ignite`, never an explosion; dirt/dust puffs (`DIG_FX`: a burrowing Mole, the train's wake) are
  silent; `HORN_FX` = the train horn (`sfx.horn`); `ICE_FX` = ice cracking/sinking (crash); `ERUPT_FX` = a Mole erupting (crash);
  `LAUNCH_FX` = a pad launch (whoosh); the Breaker's punch is a `strike` (thud), not a blast; a Boomer's fuse hisses as its order starts.
- **Ability and death sounds (2026-10-07 polish)**: `verbSound(actorKind, order)` in `audio.ts` (pure, `audio.test.ts`) names the sound
  an order makes the moment it starts, played by `main.ts` (`seenOrderIds`): Skater boost (rocket roar), Chop Bike rev, Bulldozer blade
  scrape, Mole dig rumble, Jump Trooper jet pack, Hookshot reel whine, Breaker rocket fist, any melee or Slam a swing swish. Synthesized
  (`Sfx.sweep` / `Sfx.glide`), no new files. `deathSound` plays on a kill: a trooper's body falls, a hull cooks off, an aircraft crashes.
- **Verb FX (2026-10-07 polish, `worldRenderer.syncEntity`)**: a Boomer's fuse always spits sparks (`userData.fuseTip`); a boosting
  Rocket Skater GLIDES (crouched, no stepping gait while it moves) and trails rocket flame and smoke from its boots. The Chop Bike's
  rider is a real figure (jacket, arms on the bars, boots on the pegs, spiked helmet, goggles, a steel machete), all `accent` meshes so
  the vehicle's role tint never paints it (it was two mint-green boxes).
- **Bastion infantry outline (2026-10-07)**: a broad kettle BRIM round the bucket helm and plated tassets front and back. These are
  procedural, not kit, pieces, so they show with the Blender kit loaded. Rifleman Vanguard~Bastion IoU 0.81 -> 0.77, marksman
  0.80 -> 0.75. Lesson: `measure:factions` runs `dist/`; rebuild (`npx vite build`) before every measure or you measure the old build.
- **No lasers, anywhere** (2026-10-07): the Bastion's Armor Bay power is the **Gun Run** (internal id `laser`, kept for saves): a jet
  strafes a line and seven cannon shells walk down it. The beam effect, its additive light curtain and its zap sound are deleted.
- **Flame Post** tanks are dark steel with one orange band: the bright orange drums read as the map's explosive red barrels.

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
  faction without it lost AI-vs-AI games outright (`npm run balance:factions`). THREE support powers each, never shared, starter first (owner 2026-10-01: "should start out with some starter thing and have more options in them based on your tech line ... differ per faction"): Vanguard Recon Sweep (start) / Airstrike (Support Wing) / Paradrop (Air Wing: two Troopers land at the point, field cap respected); Syndicate Smoke Screen (start) / Napalm (Assault: three firebombs, 2-turn burning ground) / Cluster Strike (Ordnance); Bastion Resupply Drop (start) / Gun Run (Armor Bay) / Barrage (Siege Works: six heavy shells walk a 4.5m circle). DEFENSES deck, 5-6 each: starters everyone has (Sandbags $60 = neutral low cover; Blast Wall $130), shared tech pieces (Gun Turret, Assault; Flak Nest $230, Armor Bay: the Flak Track's gun on a mount) and the faction's own: Vanguard Sensor Mast (Recon: a 10m spotter relay, no gun), Syndicate Minefield (Ordnance: three mines in a turnable triangle), Bastion Mortar Turret (Ordnance) + MG Bunker (Armor Bay: a Heavy Gunner's suppressing burst behind 150 HP of concrete). `doctrines.test.ts` pins starters / tech gates / one-of-its-own; `sim.test.ts` asserts every deck entry, on every map and faction, either REFUSES TO ARM (locked) or arms AND has a legal spot in its ring (the owner's locked-turret bug, fault-injection proven). The bot drops its strongest affordable DAMAGING power on a crowd (`DAMAGING_SUPPORT`, read top tier first); it does not build defenses or use the utility powers (not yet asked). The flat
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
- **Tech is cheap and says what it is** (2026-09-24), **rebuilt 2026-10-03** so no branch is a dead end and the
  armour road is not the only road. Doctrines $100 (Recon, Assault) / $150-200 (Support, Ordnance, Armor) / $240-260
  (Siege, Air Wing); specializations $130-160. Each research card carries a tag — cyan **NEW UNITS** (a doctrine:
  lists every unit, defense and support power it opens for this faction) or amber **UPGRADE** (a
  specialization, pick one of each pair).
  - **Every threat has an answer outside the road that makes it**: Recon owns the Flak Track, Flak Nest, Scout,
    Marksman and Drone Op (air answer + eyes); Assault owns the Rocketeer, Striker, Heavy, Jump Trooper (armour answer
    + pressure); Armor Bay is tanks/bunker/Gun Run only.
  - **Aircraft and artillery are the deep end**: Siege Works and Air Wing need Armor Bay AND Recon (radar / spotters),
    so the plane rush costs ~$700 of tech before the first gunship. `tech.test.ts` pins that ordering.
  - **Upgrades must beat buying another unit**: researching spends the base order (a deploy forgone) plus $130-160, so
    each pays a team-wide +25% (infantry damage, infantry HP, vehicle HP), +30% vs vehicles, +40% splash / +50% radius,
    double aura heal/repair, a sharper spotter, or +40% scatter on shots at you.
  - The bot's `aiTechPath` now includes Recon where it needs it and ends in one upgrade.
- Locked troops in the Deploy tab are NAMED, grouped by the doctrine that unlocks them ("Scout ·
  Marksman / 🔒 Recon Doctrine") — never a "▮▮▮ ×2" count.

## OWNER BATCH 2026-10-02 (rules that came out of it)

- **Air.** A gunship's BOMB is a bomb RUN: pick ground or a foe, it flies over (a move, so 2 AP) and drops straight
  down; 4.4m blast, 96 dmg, throws troops up to 9m. The Bomber's carpet is 3.4m x3. The gunship's autocannon hits
  ground AND air; the interceptor's only air. Nothing fires unasked (the auto strafe is gone). Expensive units hit
  harder: artillery 3.0m/62, mortar turret 2.6m/50 (`explosiveBlast` in sim.ts). Tank $680, Striker $440 (balance band).
- **High ground.** Spread x0.7 from a 0.45m rise, x0.5 from a mesa step (1.2m+); shooting UP x1.6 / x2.2. Aircraft fire down.
- **Mid-air collisions.** Opposed rounds closer than 0.42m in 3D meet: plain rounds cancel; a hit grenade/shell goes
  off there. Aircraft bombs are exempt. (Staged smokes must stop the target firing back.)
- **Base systems.** Comms Mast dead: every unit refills 1 AP (both sides). Blast Gate dead: deploy ring shrinks to
  beside the base, reinforcement cooldown +1. Reactor: income by health. The base panel shows chips for each.
- **Bots.** Ground units plan an A* route (1.2m grid, wall clearance = `spawnClearance`) instead of the greedy
  sidestep; no two end a move on top of each other (`spreadDestination`); Hard seeks high ground and builds a gun
  emplacement toward closing foes (`enemyDefenseAct`).
- **Bot economy (2026-10-02 AI pass).** Measured with a Hard-vs-Normal self-play harness (36 games, surviving-HP
  share): the old Hard bot researched every turn (the base has ONE order a turn) and sat on $800 with two troops
  (share 0.485 = worse than Normal). `smartEconomyAct` (Normal + Hard): parity first (>= 3 troops and the foe's
  count), the AP upgrade (two base orders; the bot now spends every base order), early income, the next doctrine
  on its path only with 4+ troops out, else the most-wanted troop. Share -> 0.58 vs the old Normal; Hard's tactics
  on top (stand-off at ~0.55 range instead of 6m) add ~0.04. Tried and REMOVED (no gain or negative): army
  cohesion (-0.02), weak-target pressing (-0.01), wounded-retreat threshold, threat-weighted A* (+0.005).
  Hard also runs gunship/bomber BOMB RUNS on clusters (2 AP) and sends the crippled to a medic.
- **Achievements** are four pages (Battles / Kills / Skill / Range), 46 medals with higher tiers; `commander.test.ts`
  asserts a long perfect career earns every one.

## FIELD HANDS, MOUNTED GUNS, HEIGHT, AUDIO (owner batch 2026-10-03)

- **Height is continuous** (`accuracyForShot`): shooter above the target by `d` metres scales the spread by
  `1/(1+1.1*(d-0.3))` (floor 0.2): 1.2m = half, 3m = a fifth. Below: `1+1.3*(|d|-0.3)` (cap 4): 1.2m = 2x,
  3m = 3.7x. Aircraft shoot down at no penalty. No tiers.
- **[REMOVED 2026-10-04 with the Medic and Engineer] Heal / Repair** (order `treat`, `sim.queueTreat`): the Medic walks to within 3.2m of a hurt infantry unit and
  restores EVERY part to full, wrecked non-critical parts to a third; the Engineer ("Mechanic" for Vanguard) does
  the same for vehicles, aircraft, emplacements and the base. Medic $220, Engineer $220 (the passive aura stays as
  a trickle). The bot's medics/engineers treat the most valuable wounded ally first (`aiTreatTarget`).
- **Placing** (`PLACEABLES` in `units.ts`, `sim.queuePlace`, instant, 1 AP + cost, within `reach`, T turns the
  rotatable ones): Demolitionist **Charge** $45 (a `cover` of kind `charge`: fused 3 turns, blows when shot, huge
  throwing blast, hurts everyone), Pad Tech **Pad** $40 (zone `sim.pads`: infantry that stop or land on it are launched 8m
  along its yaw, chains up to 3, ring-out kills), Oil Rigger **Slick** $50 (zone `sim.oilSlicks`: any blast/fire/round
  ending in it lights it: a burn zone of 18 a turn for 3 turns), Fortifier **Barrier** $40 (two tough `cover` blocks across
  the facing). Caps per side: 4 charges, 4 pads, 3 slicks, 3 barriers. Pads, slicks and charges ride `serialize()`.
- **Rocketeer** (`bazooka`, $300): flat rocket, 64 damage, x1.5 against vehicles (`UnitStats.antiArmor`).
- **Manned emplacements** (`gunpost`, `mortarpit`; defenses $90 / $140): an emplacement acts only while a trooper
  crews it (`sim.queueMan`; order `man`: walk up, crew; `queueDismount` = the Leave card). A crewed post gets 1 AP a turn,
  its crew none (`refreshMounts`); a post belongs to whoever crews it; it frees itself if the crew dies or is thrown
  clear. Every map starts with a mirrored pair of neutral Gun Posts on the flanks (`placeFieldMounts`). Bots crew a free
  post with a foe inside its reach (`aiMountTarget`); they never build one.
- **Who gets what:** Vanguard: Mechanic, Pad Tech, Rocketeer, Gun Post. Syndicate: Blaster (demo), Slickster (oil),
  Rocketeer ("Tank Hunter"), Mortar Pit. Bastion: Engineer, Mason (barriers), Demolisher (demo), Gun Post.
  The bot does not yet place charges, pads, oil or barriers (deferred, `docs/next-steps.md`).
- **Balance:** the self-play damage-per-dollar band cannot see a utility unit's worth, so the four field hands are
  `UNGATED` in `balance.test.ts` (printed, not gated); the Rocketeer is gated.
- **Audio** (`src/audio.ts`, `src/music.ts`, `public/audio`, credits in `ATTRIBUTION.md`, rebuild `npm run art:audio`, needs ffmpeg).
  - *Sources:* recorded CC0 samples play over every synthesized voice, which stays as the fallback. Every sample is peak-normalised
    to -3 dBFS and the recordings differ by 10+ dB in energy, so loudness is set in ONE table, `GROUP_GAIN`, from each group's measured
    RMS (`scripts/audio-stats.py`): deep boom > cannon = blast > crack > pop > rifle > carbine = pellet > pistol, machine gun held back.
  - *One voice per weapon* (`GUN_VOICES`, pure `voiceFor`): the same few recordings pitched and weighted per shooter (a marksman's
    rifle, scout and jumper carbines pitched up, pistols for the field hands, a deep MG, tank / siege gun / mortar pit / base relay at
    four pitches, flak cracks, rocket and flame synthesized, a hand grenade is a swish). `audio.test.ts` fails if an armed unit has no
    voice, if fewer than 20 distinct voices remain, or if the loudness order breaks.
  - *Hits and blasts:* a hit sounds like what it hit (`impactClass`: flesh, hull, concrete, wood, by the entity under the effect);
    an explosion's radius picks pop, blast or deep boom (`blastGroup`); off-screen sounds play at 35%. Oil catching, placing, a charge's
    fuse tick, healing, a bounce pad and a trooper settling into a post each have their own sound.
  - *Movement bed:* quiet footfalls, a track rumble and a rotor whirr under the units moving in view (`moveBed`).
  - *Music:* menus share a pool; each map has three tracks, one picked at random when the battle starts (`MAP_TRACKS`), the next
    follows when it ends; tracks are loudness-matched to -20 LUFS, fade out and in at scene changes, duck under the result stinger.
    Sound effects and Music are separate buses and sliders; mute gates both.
- **Visuals:** a shove is a stagger (lean and recover, upright on landing); a real throw is a full tumble about the
  axis across the throw; a pad launch is an upright leap. Treating plays the `aid` pose (tool lifts, body leans in); a placed
  charge/barrier drops in with a small overshoot and kicks dust, pads and oil fade up. A queued shot's line ends on the aimed PART (`orderAimPoint`).

## FACTION TRAITS and smarter field play (2026-10-03, second pass)

- **Unit traits** (`FactionDef.unitMods`, `applyFactionMods`, `CombatEntity.mods`, `unitModText`): the same unit is not the same
  unit. Vanguard is quick and light (troopers +12% speed, -5% HP; corpsman +20% speed; tank +10% speed, -8% HP; gunship +8% damage),
  Syndicate hard-hitting and brittle (raider +1 grenade, -8% HP; striker / sapper / flamer +10% damage; -8% HP on the glass), Bastion
  tough, slow and long-ranged (guardsman +12% HP, -8% speed; mortar and artillery +10% range; tank +12% HP). Multipliers are held to
  0.88-1.2 by `factionMods.test.ts`; the Deploy card names the faction's trait for each unit.
- **Batch 3, content (2026-10-03).** Eight new troop types: the **Runabout** (light car: 13m a move, four riders and a gunner seat, its MG
  fires only with a gunner aboard; `carrierCapacity`) and the **Turret Tech** (two **sentries** a sortie: small auto-turrets that shoot the nearest
  foe by themselves each turn and pack up after 4) are shared by every faction; each faction owns two more: Vanguard the **Hornet** (light
  tank, no ram) and the **Ricochet Gunner** (a hit glances on to two more foes within 3.2m, a warm bullet, never a beam); Syndicate the
  **Sledge** (Slam: every foe within 3m is hurt and flung up to 8m, can ring out) and the **Bounty Hunter** ($50 a kill); Bastion the
  **Ironclad** (tower shield: bullets from the front 150 degrees do 40%, blasts go round) and the **Trencher** (Dig: every trooper within 4m
  digs in). **Burning** is now a status (`entity.burning`): flamers, flame posts, napalm and burning ground set INFANTRY alight for three
  turns of 8, machines and aircraft do not burn, water or a medic puts it out. **Posts**: Rocket Posts and Flame Posts join Gun Posts as map
  pairs (`placeFieldMounts`, one band of the board each) and as base defenses (`isMountKind`); since 2026-10-06 every map also gets a mirrored
  pair of **Mortar Pits** and of **Cannon Posts** (`cannonpost`: a wheeled field gun firing a 54-damage tank shell, 32m, anti-armour). Posts keep
  3m off every supply cache and caches 3m off each other (`pickupSpotClear`); `mapLayout.test.ts` fails any overlap or a prop straddling a
  terrain step (except `hug` landmarks built into a step, e.g. the Ironworks furnace). **Map hazards** (barrage, collapse,
  lightning, slag) draw a thin steady outline the turn BEFORE they strike (`environment().soon`) and a pulsing filled zone on the turn;
  danger is molten orange-red (`hazardColor`), never the caches' gold (`npm run shots:gpu -- hazards`). **Strikes**: EMP Burst (vehicles and defenses lose
  next turn), Minefield Drop, Medevac (full heal, up), Sentry Drop, Rail Strike (3 rods, 95 each). **Base options** (`BASE_UPGRADES`): Armor I/II
  (+30% health each), the **Fortress Cannon** (a `cannon` weapon part: 120-damage shell every second turn at the dearest ground foe in 40m, costs
  no base order), the **Watch Radar** (enemy orders revealed every turn). The bot buys armour then the cannon with an army out.
- **The tech tree (2026-10-03)**: 29 nodes in four branch columns, each layer opening units / defenses / strikes, six exclusive pairs that
  change what you can field (Fire Discipline vs Demolitions, Field Works vs Field Hospital) and five upgrade pairs. Recon -> Sharpshooters (Ricochet,
  Bounty, Rail Strike), Radar Net (EMP, Watch Radar), the flak and spotter line. Assault -> Shock Troops (Jump, Rocketeer, Sledge, Ironclad, Rocket Post),
  Ordnance -> Fire Discipline | Demolitions. Motor Pool (Runabout, Hornet, APC) -> Armor Bay (Tank, Bunker, Lance) -> Siege / Air Wing (also need
  Recon). Support Wing -> Field Works | Field Hospital. `tech.test.ts` pins the shape (depth, exclusive pairs, deep end costs most).
- **Achievements (2026-10-03)**: every medal has Armory `points` (shown on the card, paid once on unlock); the **Arsenal** page counts what the sim tallies
  in `sim.stats` (slams, thrown, burned, sentries, ricochets, bounties, clashes, cannon shots, hops, deployed kinds, researched nodes, calls ...);
  `commander.liveCheck` unlocks counted medals the moment their tally is met, mid-battle, with a corner toast (`announceMedal`, `.achieve-toast`).
- **Round 1 of batch 3 (2026-10-03)**: a crewed post gets TWO actions a turn and its crew keeps ONE, spent only to climb out (leaving costs 1,
- **Pulses are not explosions (review, 2026-10-03)**: an EMP burst, a medic or engineer aura and a smoke shell used to draw as a full fireball with a scorch, a shove and an explosion sound (a medic healing next to a friend looked like a shell landing). `PULSE_EMP` / `PULSE_HEAL` / `PULSE_SMOKE` blasts (`isPulseBlast`) now draw ring(s) and flecks in cold blue, healing green or soft grey (`makePulse`), with no scorch, no shove and a quiet sound. The "rounds collide in mid-air" log line is one per shooter pair per turn, and the "sandstorm / barrage next turn" banners are gone (the forecast chip says it).
  not the whole turn); the crew is never a blocker or a casualty of its own post's line of fire (`crewId` exclusions in
  `firstEntityBetweenShot` / `firstEntityHitBySegment` / `firstExplosiveProximity`; the "Friendly fire risk" warning at 2.5m was the
  crew standing in the line), and the barrel starts 0.7m out of the ring. `isMountKind` replaces the hard-coded gun-post / mortar-pit
  pairs. Selecting a target always shows its part health (More / Less is gone), the base panel lost "One base order a turn." and the
  faction **doctrine name** is no longer shown anywhere (the rule stays in the card tooltip). Recon Sweep: $60, 2-turn cooldown, and it
  marks every foe for the next turn. Two rounds meeting in mid-air now draw a `clash` effect by family (`CLASH_SPARK` / `CLASH_BOLT` /
  `CLASH_BLAST`: spark star, sniper shock ring, fireball and smoke) with sound and a camera nudge. A real throw (blast or direct hit,
  2.2m+) flies on a true arc with the head leading, lands flat on its back with dust, skids, and gets up (a 4.5m+ throw turns a
  backflip first); knockback reach went up (`KNOCKBACK_MAX` 6, direct hit 7m).
- **Bot, Hard brain: the whole toolkit** (2026-10-03, round 3; `aiX.moves` switches it off). Every order a player has, with the rule for when it pays:
  HOP (`aiHopAct`: across a gap or up a ledge too tall to walk, or onto a perch beside the fight, only when it clearly beats the walk);
  PUSH (`aiShoveAct`: a foe with water or the edge behind it, or one of our own mines / burning ground / gas / charges a shove away);
  RAM (a tank with infantry or a nearly dead vehicle on its hull, or with its gun gone); SMOKE (a mortar screens a friend that three
  guns, or two when behind, are working over); MINE (a sapper holding with foes 3-14m off); CROUCH (a trooper standing its ground
  under fire with an action point spare); HULL DOWN (a tank that has fired and holds the target in reach stays put, unless it is
  winning 1.5x); CARRY (an APC or transport boards an idle rifleman while far from the fight and sets its troops down within 15m);
  BAYONET (a disarmed trooper adjacent to a foe strikes); plus the older ones: heal / repair, man a post, lay field items, strikes,
  bomb runs, defenses, research. Not used on purpose: the Drone Op's recon pulse (the bot sees everything already) and the artillery
  deploy (the sim plants it by itself). Normal and Easy keep their old toolkit so the tiers stay apart. Over 48 seeded games the full
  set changed nothing against the Normal bot (33 wins / 5 losses either way): it is behaviour, not a power spike. In those games the bot
  crouched 740 times, hopped 152 and shoved 104 (up from 59); ram / smoke / mine / carry did not come up because the bot rarely buys those
  units, so `aiBrains.test.ts` stages each one.
- **Bot, Hard brain: posts and posture** (2026-10-03, round 2). When it pushes in, `aiBestPost` scores every spot within one move
  (height over the nearest foe, cover toward it, foes that can reach the spot minus friends standing by, whether it can still
  shoot from there, progress to the goal) and walks to the best, only if clearly better than staying. Measured over 48 seeded
  games against the Normal bot (hard as the enemy): plain marching 30 wins / 6 losses, posts on the way in 31 / 1; letting a
  unit that has already fired scoot to a post lost ground (17 / 18), so firing units still hold and press, and that variant is
  gone. `aiStrengthRatio` (cost x health) below 0.75 puts it on posture HOLD: it falls back to within 14m of home and only
  engages what comes within 1.2x its range (neutral in the same games, it matters when the bot is genuinely behind).
  `enemyTroopPreference` now answers armour with Rocketeers first and a dug-in player (2+ turrets / bunkers / posts) with
  artillery and mortars. `aiX.post` / `aiX.posture` switch each off. A hull also never ends an AI move brushing a sheer face.
- **Bot, Hard brain only** (Normal is untouched so the balance band holds): field hands lay their item where it hurts (`aiPlaceAct`: oil
  across the foe's lane, a barrier ahead of the line, a charge in front of them, only with $120 to spare); a trooper with a foe at the
  water's edge or the map edge behind it shoves it (`aiShoveAct`, finally); and bots treat a charge, a foe's oil and a foe's pad as
  danger and path around them (`aiDangerAt`).
- **Ambience** (`Sfx.setAmbience`): each map has its own air (dry desert wind, furnace roar and a distant clank, leaf breeze and the
  odd bird, cold gusts, a hollow temple drone, far-off guns); cash caches chime.

## OWNER BATCH 2026-10-03, third pass (controls, rounds, sound)

- **Hop** (`sim.queueLeap`, `leapRange`, `leapUp`, order `move` with `leap: true`, key J, card "Jump"): every trooper but the jump trooper
  can arc a few metres over low cover and up onto a ledge (3.6m x sqrt(speed / 6.5): a scout ~4.9m and ~1.8m up, a heavy ~3.1m and ~1.2m).
  It shares the jet-pack arc (airborne for the hop), lands softly (the slam is the jump trooper's), and refuses with a reason (too high,
  no room, water). `leap.test.ts`.
- **Blasts throw troopers**: any real explosion throws a trooper back at least a hop (0.9-2.5m by falloff), and a rocket or shell that HITS one
  throws it away from the shooter (up to 5.5m); armour and structures do not move.
- **Rounds** (`projectileFx.ts`): no long tail. Each weapon's round is its own compact shape (`ROUND`): warm dash (rifle), thin pale dart
  (carbine), bead (pistol), fat alternating orange-red slugs (MG), a long white needle with a bright collar (marksman), a finned rocket with a
  short jet (bazooka, family `rocket`). Small-arms ribbons are 0.3-1.3m and attached.
- **Circles**: rings are densified (a vertex every ~0.15m) and the triangles that span a ledge are dropped (`LEDGE_SPAN`), so a ring breaks
  cleanly at a lip instead of climbing the cliff as shards; the head-ring over every unit and the base is gone (the group stays for the sniper mark).
- **KIA** is only for a unit that died; a broken part reads "<PART> DOWN".
- **Menus**: the set-up summary refreshes AFTER the pick is recorded (it showed the previous pick); `smoke:flow` flips every mode both ways and
  asserts chip, blurb and summary agree. Right-click is Back everywhere.
- **Controls**: Tab walks Home Base then every unit; H = Home Base; 1-9 pick the numbered card of a unit's actions or the Home Base's open tab
  (cards wear their number); [ and ] flip the base tabs; J hop, P push, Z undo the last order, Q / E turn the camera; clicking a field cache with
  Move armed walks onto it. When every unit's AP is spent the End Turn button pulses "All set" with a chime.
- **Cursor**: inked toon cursors (arrow, pointer, a reticle for attacks and enemies, a footprint ring for move / place orders), `body.cursor-aim` /
  `cursor-move`. **Title screen**: a slow sway across a front arc, not a 360 orbit.
- **Sound**: the real recorded firearms ("The Free Firearm Sound Library") replace the pitched-down fireworks for guns: one recording per kind (AR-15
  recruit, SMG scout, Tikka jumper, rotating Mosin / Savage / Arisaka for the marksman, an AK burst for the heavy gunner (one clip per burst),
  pistols and revolvers for the field hands, shotguns for the sapper, a lever rifle for turrets, a PPSh burst for the gun post). Interface sounds are
  Kenney's: hover, press, unit pick, confirm, back, error, toggle, deploy, turn, all-set, win, lose. Menus have sound now too.

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
- **Air bombing (2026-10-03)**: a gunship or bomber bombs any ground point within its bomb reach (11 / 12m) from where it hovers: 1 AP,
  NO flight. Click picks the spot (or the ground under a foe), the line from the rack and the splash are drawn, Confirm queues it
  (same pick-then-confirm as lobs and shells). The bomb leaves the rack under the airframe and falls steeply; it ignores aircraft. A bomber's
  carpet is three bombs across the spot along the line to it. The Hard bot bombs a clump in reach without moving.
- **Muzzles (2026-10-03)**: `MUZZLE_LOCAL` in sim.ts is the one table of where each gun really is (x right, z forward, y above `elevation`;
  an aircraft's `elevation` is its body centre). Every round, preview line, queued-order line and flash starts there (`muzzleFor`).
  `npm run shots:gpu -- muzzlecheck` measures the gap from each shooter's round origin to its drawn weapon mesh (should be ~0).
- **Intro**: the title pan owns the camera (`guideTo` is off while `menuDrift`); a boot veil hides the canvas until the model kits are in
  and warmed, then fades it in once; `probe:intro` fails on a camera jump, a veil that never lifts, or a snap when opening Play.
