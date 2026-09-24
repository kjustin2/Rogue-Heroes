# Next steps — the roadmap (updated 2026-09-23)

This is the ONE live planning doc. Read it at the start of every session; update it at the end.
Setup for a fresh clone: root `README.md`. Engineering rules: `CLAUDE.md`.

## Where the game is

**Skirmish is the whole game until it is perfected** (owner's rule — Campaign and Skirmish Run were
deleted on purpose; see "SKIRMISH ONLY" in `CLAUDE.md` for the ban list). A Skirmish is: six themed
maps, each with its own sections, landmarks and hazard event; three modes (Annihilation, Capture the
Flag, Hold the Hill); three factions that look, play and research differently; three AI brains
(Easy / Normal / Hard differ in intelligence, not just stats); or Local 2 Players hotseat.

State of the checkout: `npm run verify` green (typecheck, script syntax, 430+ vitest incl. chaos +
balance self-play, build); `npm run smoke:core` green; `npm run perf` OK against the baseline;
`npm run smoke:electron` green. Everything is committed on `main`.

What was built in the last stretch (for context, not to redo): one toon art direction end to end
(Blender kits for infantry, props, vehicles — no Meshy anywhere), distance-locked infantry gait with
IK knees, per-family death animations, ballistic projectile FX with a no-pop rule, deploy-anywhere
placement, draped ground overlays, themed maps, the research table, achievements, the toon UI with
measured readability gates, and a whole-game glitch sweep whose findings were all fixed.

## Playtest round 1 (2026-09-23) — done, awaiting the owner's next pass

Owner report → fixed: selected unit blown out white (selection light + cone removed); move lines cut
through slabs (draped); sawtooth "teeth" on the deploy ring at the Ironworks rim (conservative drape);
▲ CLIMB tags on move previews; newly unlocked Deploy cards stuck on an amber flash frame (flash removed,
NEW badge kept); Overwatch removed (see CLAUDE.md ban); Derelict Turret explains itself, has a Move to
Capture button, becomes "Captured Turret" you select and fire (Tab reaches owned turrets).
**Not reproduced:** "the picked Deploy card moves to first in the row" — card positions are identical
before/after picking at 1800×980; likely the same stuck-flash bug. Ask the owner if it persists.

## Playtest round 2 (2026-09-23) — done

Maps decluttered to 8–14 deliberate props each with a two-tank gap everywhere (see CLAUDE.md "MAPS ARE
MINIMAL"); Striker $280 → $340 (open maps put it at 2.83x the median dmg/$, now 2.33x). Deck cards are two
rows so a price can never be pushed out; the UI audit's blind spot for wholly-clipped text is closed and
fault-injected. 2-player: handoff card rewritten (whose turn / one instruction / intel box / go), faction
blurbs shortened, preview caption no longer repeats the list. Menu state leak ("brightness stayed down
after Settings") fixed at the root — derived from the DOM — and gated. Intro rail cancels on leaving.
Seat split in balance self-play is 35% (gate 35–65): at the edge; widen seeds before tuning if it tips.

## Owner's batch 3 (2026-09-24) — the next rounds, in this order

1. ~~Unit value scaling~~ DONE: tank shell 55→78 (one-shots a trooper), armour ×1.3→×1.6, $450→$600
   (self-play 2.45x median, in band); Deploy tooltips show HP + damage a shot (`troopSheet`); the AI
   wishlist discount 20%→30% a place (a $600 tank outbid the counter at the head of the list).
   Found on the way: the Ironworks slag spill alternated corners starting with the PLAYER's, and
   self-play read Ironworks 1-13 for the enemy seat; both furnaces now vent together. Every map still
   leans a little to the enemy seat (38% overall, gate 35%) -- unexplained, not the slag; look at
   resolve order / who queues first before any tuning.
2. **Fun physics**: explosions / rockets throw INFANTRY with a proper ragdoll-ish arc + tumble + land
   (vehicles rock, never fly). Builds on `applyKnockback` + the THROWN death family.
3. ~~Base upgrade clarity~~ DONE: the card reads "Income +$50/turn · $200 · pays back in 4 turns";
   Command reads "Base acts twice a turn".
4. ~~Tech unlocks new Defenses and Support powers~~ DONE: Gun Turret behind Assault, Mortar Turret behind
   Ordnance; each faction has a strike + a utility power (Recon Sweep / Smoke Screen / Resupply Drop), all
   research-gated.
5. **Tutorial**: quick but complete — aim follows a moving target or its old spot? support cooldown +
   re-buy, CP, climb, capture, cover, deploy ring, End Turn resolves both sides at once.
6. **Faction identity, much stronger** in look AND play (they still read alike).
7. **Look-and-feel overhaul** (toon, "AAA"): infantry up to the tank's quality bar; maps and map props
   more striking; projectiles cooler (grenades already good — use them as the bar).
8. **GUI flows like a pro web designer** (owner: "showing too much... wasn't clear what to do"):
   Skirmish set-up as a STEP flow (map → factions → mode → difficulty → go), not one wall.
9. ~~Tech tree clarity~~ DONE: NEW UNITS / UPGRADE tags; doctrines list units + defenses + strikes.
10. **CP made clear**: how many each unit has and what spends them; an "unused CP" warning on End Turn
   with "don't show again", and a Gameplay option to turn it back on/off.
11. **Options split**: Settings (display / audio / controls) vs Gameplay (warnings, hints, pace ...).
12. **Map backgrounds** (skyline / outer ground) look low-detail: enhance.
13. ~~Progression per game~~ DONE (costs roughly halved, nothing callable on turn 1): tech CHEAP to start so every game explores a path; the opening is
   limited (no air strikes at turn 1 -- strikes and defenses unlocked by tech, see item 4).

14. ~~Money display~~ DONE: a big amber money plate with next turn's income under it.
15. **Map event zones** (lightning, slag, barrage...): hover shows what it is and when; click for more.
16. **Strike (melee) reach**: a unit within strike range but not adjacent closes AND strikes in ONE order
   (the striker's charge, for every infantry melee), and the range is long enough to be usable.
17. **Push ability** for infantry: shove a unit far; into water / off the map kills it, with a fun animation.
18. ~~Unit action buttons cramped~~ DONE: wider floor, 10px gutters, taller buttons.
19. ~~Rename CP to AP~~ DONE in every player-visible string (tutorial explanation: item 5).
20. ~~No objects near base spawns~~ DONE: `BASE_CLEAR` keeps every deploy ring empty (props.test).
21. **Rotatable placements**: a wall's facing and an airstrike's line direction are the player's choice.

## Next — in priority order

0. **Faction identity (2026-09-23)** is merged to `main` (PR #3): each faction owns
   its own units, one strike and one doctrine rule (Rapid Response / Scavengers / Dig In), plus
   helmet colours and vehicle add-ons. Playtest all three against the bot; the numbers most likely
   to want tuning are the 30% bounty, the 0.75 dig-in multiplier and `enemyStrikeAct`'s threshold.
   Details in `CLAUDE.md` ("FACTIONS play, look and fight differently").
1. **Owner playtest of Skirmish on the standalone build**, then iterate off what he reports.
   Build it with `cd game && npm run standalone` (or `npm run dist:exe` on Windows). Areas that
   changed most and have had the least human play: deaths, projectiles, the research table, the
   Ironworks slag spill, the three AI brains, hotseat, themed map layouts. Every report becomes a
   measured repro (a `shots:gpu` case, a filmstrip, or a test) BEFORE a fix — see "How to work".
2. **Balance pass from play**, not from self-play alone. `balance.test.ts` gates the extremes
   (per-kind damage per $ within 0.5x–2.5x of the median; seats 35–65%) but the striker and tank
   sit near the top of the band. Tune `src/game/units.ts` only with the self-play table in hand.
3. **Map terrain vocabulary.** Verdant Pass is DONE (2026-09-23): its two stepped pyramid
   mountains are now farmed TERRACES, three shelves per valley side climbing to the map edge in
   0.8 risers with jogged lips, hedges and stumps on the lower shelf. Karak is the one map still
   built on stepped pyramid mesas (NW/SE); a canyon, crater ring or dune field would give it its
   own landform. Constraints: impassable = step > `TERRAIN_STEP` or water; shelves must be deep
   enough to stop on (`spawnClearance`: 1.4m infantry, ~2.6m tank); `scatter.test.ts` must stay
   green; rerun balance self-play (the Verdant change moved Verdant from 4 draws to 2 and pushed
   the bomber row under the floor, see the next item).
   **Bomber AI (found on the Verdant pass).** The bot only bombs a foe that is already beneath
   it at the START of a turn; flying toward one spends the turn, so 34 self-play bombers averaged
   ~27 damage a game and the row sits at the band floor on noise alone. Tried in the Verdant
   branch and reverted (too big a balance swing for a map change): a bombing run (move over the
   nearest ground foe in reach, release on arrival — an actor's orders run in sequence) took the
   bomber to 1.8x the median; requiring a group of two took it to 2.3x and sank the APC to 0.38x.
   So the aircraft is fine and the AI is what is weak. The fix is that run plus a bomber retune
   (fewer loads or a smaller carpet) in one change, then take `bomber` back out of `UNGATED`
   in `balance.test.ts`.
4. **Remaining unit-identity ideas** (only if the owner wants more depth):
   - Engineer: deployable bridge span or sandbag line (reuse the Defenses placement flow).
   - Flak: a one-turn tracer wall that reveals and blocks air movement through it (needs a new
     persistent, serialized, rendered line object — that is why it was skipped).
   - Hit reactions per body part: head snaps back, leg buckles, pack spins (today one shove).
   - **Attack arms (found by the 2026-09-23 attack audit, not fixed):** the Blender motion banks'
     `shoulderPitch` / `shoulderYaw` / `offhandPitch` channels never reach an arm, because arms
     are `"body"`-part meshes and the pose code's `part.role === "core"` branch catches them first
     (they get the torso's pitch instead). Every attack still animates (weapon, torso, recoil,
     rounds), but the arms hold still. Before moving the limb branches up, settle the SIGN on a
     filmstrip: the pistol and launcher clips raise the arm with NEGATIVE shoulderPitch, while the
     melee blade (which is live) is swung with `rotation.x -= shoulderPitch` — the two readings
     disagree, and the arm has to follow the blade. Films: `shots:filmstrip -- pistol launcher melee`.
5. **Elites / bosses** survive in code (`debugSpawn` options + the top-of-screen boss bar) for a
   possible Skirmish set piece — only when asked.

## Known and deliberately deferred (do not re-chase without new evidence)

- **Balance self-play seat split moved toward the gate's low edge** with the 2026-09-23 map-props
  pass: player seat 40% of decided games (8 / 12, 16 draws) on top of the Verdant terraces, vs
  58% (11 / 8) before either change (35% with the props alone). Maps are point-mirrored, so a layout
  cannot favour a seat by itself; at ~20 decided games this is inside the noise, but a later
  layout change may tip `balance.test.ts` red. If it does, widen the seed set before tuning.

- `soak:gpu` sees ONE toon program compile on the first resolve (a transparent toon material
  created mid-resolve; key diff field #51). Not a visible hitch — max frame 20.8 ms, same as later
  resolves. Twin-cloning both vertex-colour states did not catch it; find the material created
  mid-resolve before trying again.
- Command-phase shimmer on grass and trees is the WIND (ground detail + tree sway), not a glitch.
- The real-GPU tools (`soak:gpu`, `shots:gpu`, `probe:intro`) only mean something on a machine
  with a GPU. In a cloud container they run under `xvfb-run` on SwiftShader: use them to check that
  a scene renders and to read layouts, not to judge frame times or subtle shading.
  There a resolve takes ~40s of wall time (the clock runs on rendered frames), which is why
  `smoke:flow` now waits up to 120s for a turn; under `?lowfx=1` SwiftShader also drops the big
  ground plane in wide views (sky shows through), on `main` as much as anywhere.

## How to work (the rules that kept this repo sane)

- **Gate every commit with `npm run verify`**; run `npm run test:full` before handing a build over.
- **Never claim a visual change from code.** Screenshot it (`npm run shots:gpu -- <case>`), judge
  motion on filmstrips (`shots:filmstrip`, `shots:step`), and READ the images.
- **Bisect before you tune** any rendering artefact (see the hatching ledger in `CLAUDE.md`).
- One test script at a time (they share the GPU); never leave a dev server running.
- The owner tests on the standalone build, not the dev server. Hand him a build, not a report.
