# Next steps — the roadmap (updated 2026-10-07)

The ONE live planning doc: where the game is, what is next, what is deliberately deferred. Read it at the
start of every session; update it at the end. Finished work lives in `git log`, not here.

## Where the game is

**Skirmish is the whole game until it is perfected** (owner's rule; Campaign and Skirmish Run were deleted
on purpose — see `CLAUDE.md`). A Skirmish: six themed maps (each with sections, a landmark, a hazard event and
its own light), three modes (Annihilation, Capture the Flag, Hold the Hill), three factions that look, play
and research differently, three AI brains (Easy / Normal / Hard differ in intelligence), or Local 2 Players.

2026-10-06: map props / posts / caches never overlap (`mapLayout.test.ts`), water no longer reads as a road,
every map has mirrored Mortar Pits and Cannon Posts (tank-shell field gun), and each infantry kind fires its
own round shape (`UNIT_ROUND`). Hazards now warn a turn early in molten orange (never cache gold).
Round 6 (2026-10-06, "only FUN units"): cut Trencher, Drone Operator, Bounty Hunter, Transport, Fortifier, Demolitionist; added the
Breaker (rocket-fist Punch, 18m throw), Boomer (kamikaze) and Juggernaut (knockback cannon); see `docs/game-systems.md`.
Round 7 (2026-10-07, second fun audit): cut Scout, Ricochet Gunner, Turret Tech (and placement); Runabout MG always fires; added Hookshot,
Rocket Skater, Molotov, Mole Sapper. Caches mirrored (the player-seat lean is gone: 53%). Map features landed (Ironworks train, launch pads,
thin ice, red barrels). Sound + visual audit done (fire never booms, silent dig puffs, train horn, ice/eruption crashes, pad whoosh;
flame-post drums no longer mimic red barrels). Watch: Jump Trooper is the lowest-value unit in self-play (0.52x).

State of `main`: `npm run verify` green (574 vitest incl. chaos, balance self-play and the movement +
projectile oracle), `npm run smoke:core` green (11 smokes), `npm run probe:terrain` 0 offenders,
`npm run measure:factions` GOAL MET, `npm run soak:gpu` with no mid-resolve shader compiles, perf gate OK.

Built most recently (for context): owner batch 3 (unit value scaling, thrown-body physics, research-gated
defenses and strikes, the tutorial, the step-flow set-up, AP wording, push, rotatable placement, fewest-words
pass); the measured faction look (silhouette kits, HQ architecture, machine dress, livery); painted terrain,
per-map light rigs, N8AO contact shading, map life; Blender HQs, hero props and faction dress; the movement +
projectile oracle and the seven bugs it found; a perf pass (no per-frame material churn, memoised colour
blends, static scenery keeps its paint, warmed debris program); base circles whole and on the board (the
board grows behind the bases, spawn spacing, flat zone rings drawn over props); bullets as burning streaks;
a toon rim on units and a lit lip on mesas; a picked base frames its deploy circle above the command panel.
Then (2026-10-02, owner batch): the air round (bomb run, gunship gun, no strafe), mid-air collisions, big high-ground
accuracy, right-click Back, base systems with real costs, A* bots that spread out and dig in, flat deploy rings on every
map, the no-go tile overlay, four Achievements pages, and a pile of UI fixes (see `docs/game-systems.md`).
Then (2026-10-03, owner batch): field hands (Heal / Repair, Charge, Bounce Pad, Oil, Barrier, Rocketeer), manned Gun Posts and
Mortar Pits (map-placed and base-built), continuous height advantage, the shove stagger, shot lines that end on the aimed part,
recorded CC0 sound effects and three music tracks per map (`docs/game-systems.md`, "FIELD HANDS").
Then (same day, owner round 2): splash aiming is PICK-then-CONFIRM (`hud.groundPick`: click a ground spot, the arc / blast / blocked
state is drawn from that spot, Confirm fires at it; the cursor ray now lands on the real terrain, not the y=0 plane, so high
ground picks the hill you see); the tech tree rebuilt so Recon, Assault and Armor each have a purpose (`docs/game-systems.md`,
"Tech is cheap"); no default rings around bases or unselected units; custom cursors; quick-select numbers on the base deck.
**Fixed**: a Karak tank tread clipped 0.2-0.5m into the west tower stump (a 3.2m block, the drawn tread is wider than the clearance
disc): AI vehicle moves now stop short of a sheer face. **Open**: `probe:terrain` still flags two borderline samples after the bot's
turns, an infantry body 0.3m into a Verdant terrace riser at (2.6, -10.9) and a captured turret's mount 0.14m into an Ironworks step
(-4.2, -10.5). Not yet bisected. Round 2 also added base yard details (hazard-striped gate, crates, drums, windsock, burning
barrel, pennant, strobing roof beacon) and the Hard bot's posts / posture (`docs/game-systems.md`).
Then (2026-10-01): no Deploy-now shortcut in set-up; the PLAY LOG (`game/logs/latest.log`); the locked-turret
placement fix (decks show locks, picks refuse up front, every refusal toasts its reason, every defense has a
placement ghost); Defenses decks of 5-6 and Support decks of 3 per faction (starters, tech pieces, faction-own);
three movement bugs the oracle found; the per-frame GL depth-blit error (postprocessing pinned at 6.39.2).

## Next — in priority order

1. **Owner playtest on the standalone build** (`cd game && npm run standalone`, or `npm run dist:exe`), then
   iterate off what he reports. Every report becomes a measured repro (a `shots:gpu` case, a filmstrip or a
   test) BEFORE a fix.
2. **Open overhaul picks** — `docs/overhaul-options.md` (infantry direction 1-3, landmark pass 6, destruction
   states 8, projectile trails / impact marks / muzzle pass 9-11, faction mechanics 14, faction voice 15).
   Implement only what the owner picks.
3. **Bomber AI.** The bot only bombs a foe already beneath it at the start of a turn, so self-play bombers
   average ~27 damage a game and the row sits at the band floor (it is in `UNGATED` in `balance.test.ts`).
   A bombing run (move over the nearest ground foe, release on arrival) alone took it to 1.8x the median;
   do the run AND a bomber retune (fewer loads or a smaller carpet) in one change, then un-gate it.
4. **The bot and the new decks.** It drops its strongest strike on a crowd, but never builds a defense, lays a
   minefield, paradrops or calls a utility power. Add only after the owner has played the new decks.
5. ~~The AI never uses Push~~ Done 2026-10-03 (Hard brain, `aiShoveAct`).
6. **Attack arms.** The Blender motion banks' `shoulderPitch` / `shoulderYaw` / `offhandPitch` never reach an
   arm: arms are `"body"`-part meshes and the pose code's `part.role === "core"` branch catches them first.
   Every attack still animates (weapon, torso, recoil) but the arms hold still. Settle the SIGN on a
   filmstrip first (pistol / launcher clips raise with NEGATIVE shoulderPitch; the melee blade is swung
   with `rotation.x -= shoulderPitch`): `npm run shots:filmstrip -- pistol launcher melee`.
7. **Karak's landform.** It is the last map built on stepped pyramid mesas; a canyon, crater ring or dune
   field would give it its own. Constraints: impassable = step > `TERRAIN_STEP` or water; shelves deep enough
   to stop on (`spawnClearance`); `scatter.test.ts`, `props.test.ts`, `movement.test.ts` green; rerun self-play.
8. **Remaining unit-identity ideas** (only if asked): engineer bridge span (sandbags are now in every Defenses deck); a flak tracer wall
   that blocks air movement (needs a new persistent, serialized line object).
9. **Elites / bosses** survive in code (`debugSpawn` options + the boss bar) for a possible set piece — only
   when asked.

10. **The bot and the field hands.** It treats (medic / engineer) and crews posts (Hard), but never places a charge, pad, oil
    or barrier, and never builds a post. Add only after the owner has played them.
11. **Crew animation.** A crewed post is a trooper crouched behind the gun; there is no dedicated firing pose for the crew.

- **Hard bot economy (found in the 2026-10-03 review, partly fixed).** Self-play (Hard vs Normal, 108 games) showed the Hard bot fielding almost only Soldiers/Heavies/Snipers/Scouts and no vehicle or new premium unit, because it spends every turn's ~$110 on the cheapest wished unit, never reaching the money for a doctrine, an income upgrade or a $450+ Hornet / $760 Tank. Fixed: its first two doctrines no longer need a spare-cash pad (variety up, win rate unchanged: 89-1-18). Tried and REVERTED: banking up to three turns of income for the next plan step or premium troop (win rate fell to 26-25-57, the same lesson as the 2026-10 note on saving while outnumbered). A real fix needs an opening book (units, then income, then doctrine) tuned against tournaments, not a threshold tweak.
- `serialize()` / `restore()` is idempotent except a passenger inside an aircraft: its elevation re-derives from the ground on restore (hidden, re-set on unload). Harmless.

- **Roster cut done (2026-10-04)**: see docs/game-systems.md "Roster cut". Hard vs Normal still 39-0-15 (18 seeds x 3 maps pairs); `measure:factions` GOAL MET after the Bastion heavy got pauldrons and an ammo drum (its silhouette sat at the 0.8 IoU line once unit ids shifted). Open: Syndicate has no Support Wing, so its Support lane is Field Works alone; with no healing the game is pure attrition (Medevac only), watch game length.

## Known and deliberately deferred (do not re-chase without new evidence)

- **Seat split in balance self-play** sits at 38-42% for the player seat (gate 35-65). Maps are point-
  mirrored, so a layout cannot favour a seat by itself; if `balance.test.ts` tips, widen the seed set before
  tuning, and look at resolve order / who queues first.
- **`measure:maps` contrast** is just under 0.10 on Ironworks / Karak / Crossfire (0.089-0.096); judged by eye
  as fine. Not forced.
- **`getParameters` ~2.7% of the frame** (perf:profile, stress scene) persists after the material-churn fixes;
  not vertex alphas, not the light set, not instanced shadows. Find what re-triggers three's program
  lookup before trying again.
- The tank Vanguard~Bastion pair sits at IoU 0.78-0.79; watch it when changing vehicle dress.
- Command-phase shimmer on grass and trees is the WIND, not a glitch.
- Real-GPU tools (`soak:gpu`, `shots:gpu`, `probe:intro`) only mean something on a machine with a GPU; under
  SwiftShader use them to check a scene renders and to read layouts, not to judge frame times.

Round 8 (2026-10-07, in progress): cut Grenadier, Hornet, Ironclad; added Chop Bike (Syndicate: rides through troopers slashing) and
Bulldozer (Bastion: shoves units, props and wrecks ahead of its blade); Jump Trooper landing is now a 2.5m "death from above" slam
(0.52x -> 0.90x). LEFT: map hazards (Dust Bowl oil geyser, Karak rolling boulder, Crossfire minefield strip, Verdant stampede: generalise
MapDef.train into lanes).
Polish pass (2026-10-07): `wording.test.ts` (tips match constants, no cut names), ability + death sounds, Orbital Lance -> Gun Run (no
lasers), Boomer fuse sparks, Skater glide + exhaust, Chop Bike rider, Bastion kettle brim (rifleman IoU 0.81 -> 0.77). Music checked:
16 tracks within -18.5..-20.9 LUFS, three per map, stingers duck. Not done: Breaker punch / Boomer detonate / Mole mound poses.

Fun + balance audit (2026-10-07, done): the deck cut (scans, heals, stat bumps, soft utility) and Shockwave / Spring Trap / Tank Drop;
every blast throws troopers, heavies never move; new-turn + hazard sounds, every menu click heard (smoke:buttons), the mix measured
(`probe:mix`) and the multi-part-sound throttle bug fixed (`chord`); the Sledge swung by every brain, every combat kind balance-gated;
ground plates clipped to the board (`shots:gpu -- corners`). OPEN: Dust Bowl is the slowest map (16 of 24 self-play games undecided at
16 turns); the Rocketeer and Flak sit low in self-play (0.64x / 0.62x: specialists against an AI that fields few vehicles/aircraft).
