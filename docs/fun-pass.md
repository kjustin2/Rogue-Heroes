# The fun pass — your batch, exploded, plus the ones it made me think of

Everything you listed is here with a number so you can cherry-pick, plus what I'd add. Where
something **already exists** I've said so rather than promising it twice — several of your ideas are
half-built already and the honest job is finishing them, not announcing them.

Reply with numbers. I'll work them in rounds, testing and committing each round.

---

## A. Units — cut the dull ones, make the rest signature

The current twelve: soldier, scout, sniper, striker, heavy, grenadier, mortar, medic, engineer,
flamer, droneop, sapper. **Four are near-duplicates in play**: medic, engineer, droneop and sapper
all share ~18–26 damage at ~14–18 range and differ only in a passive aura. That is where the "not
unique enough" comes from — it's mechanical, not just visual.

**Cut / replace**
1. **Cut `droneop`** (16 dmg, 16 range, spotter aura) → **Jump Trooper**: a jetpack arc-jump onto
   high ground, ignoring cliffs and water, then fire from up there. Your idea, and it's the single
   most tactical thing on this list — vertical movement changes every map instantly.
2. **Cut `sapper`** (26 dmg, 14 range) → **Demolitionist**: plants a hidden charge on the ground
   this turn, detonates it any later turn. Denial + traps, and it makes the enemy AI's pathing
   matter.
3. **Keep `medic` and `engineer`** but make their auras *visible verbs* rather than passive
   numbers (heal a part; repair a wall) so they read as different roles at a glance.

**New**
4. **Shotgunner** — a wide cone that hits *everything* in it. Devastating at 6m, useless at 15m.
5. **Wide-beam gunner** — your "super wide bullet": one shot that pierces along a line and hits
   every unit it crosses. Rewards lining enemies up.
6. **Ghost** — invisible for one turn (cannot be targeted, still blocks nothing). Costs its whole
   turn.
7. **Siege battery** — a *huge* artillery piece: enormous damage, enormous blast, two turns to
   reload, must deploy (can't fire and move). Visually the biggest gun on the field.
8. **Machine-gun team** — 12-round burst, suppression: a suppressed unit loses a command point next
   turn. `heavy` already has a 4-round burst; this makes suppression a real mechanic.
9. **AA gun with huge shells** — `flak` exists but fires small bolts. Give it visibly enormous
   tracer rounds and a real flak-burst effect.

**Factions (your "not just basic military")**
10. The three factions currently differ by roster and colour only. Give each a *rule*:
    **Bastion** — dig in: +armour when they haven't moved. **Syndicate** — scavengers: earn cash on
    kills, cheap fragile units. **Vanguard** — momentum: shooting after moving costs no extra CP.

## B. The environment fights back

11. **Shoot a tree, it falls** in the direction the shot came from, damaging anything under it.
    Trees are already destructible cover — this is the fall, plus a damage sweep.
12. **Volatile props chain-react** — fuel/ammo already explode when shot (3 different consequences
    exist). Make the blast able to set off *neighbouring* volatiles, so one shot can cascade.
13. **Gas that spreads, then ignites** — a shot-out canister leaks a growing gas cloud; any fire or
    explosive in it detonates the whole cloud. Your idea and the best one here.
14. **Lightning storm** — a map event that strikes a random telegraphed point each turn. `sandstorm`,
    `barrage`, `collapse` and `ionstorm` events already exist, so this is one more entry in a
    working system.
15. **Moving dust storm** — the sandstorm exists but is map-wide and static; make it a *wall* that
    sweeps across the board over several turns, so ground gets safe and unsafe.
16. **Deployable bridge** — the engineer can span a channel. Bridges are already destructible; this
    is the other half, and it makes water a puzzle instead of a wall.
17. **Push units into things** — blast knockback landed this round (a body thrown into water
    drowns). Extend it: slammed into a wall or a rock takes extra damage; slammed into another unit
    knocks both down.

## C. Maps — the big set pieces

18. **A canyon map** with one long high bridge as the only crossing, and a drop that kills.
19. **A mountain pass** where the high ground is a real climb (three tiers) and worth it.
20. **Mini structures with short cover** — ruined foundations, low walls, sandbag lines you fight
    *through*, not just around. Cheap to add: cover kinds already exist.
21. **A 3–4 player map** — big enough for multiple spawns. This one is genuinely large: the sim is
    two-team throughout (`"player" | "enemy" | "neutral"`), so it needs a real team refactor. Worth
    doing, but as its own project, not folded into a visual round.

## D. Feedback and UI

22. **Damaged parts show it** — a destroyed track hangs off, a dead turret droops, a hurt trooper
    limps. `damageModel` already tracks per-part HP, so the data is all there and unused visually.
23. **The UI is the weakest thing left.** It's clean now but plain — flat panels, one weight of
    type, no hierarchy between "read this" and "act on this". Wants a proper visual system: a real
    type scale, iconography, framed action cards, hover/press states with weight.
24. **Blender-authored infantry.** The models are procedural boxes; no palette work fixes that.
    This is a pipeline round: author a rig in Blender, export GLB, keep the procedural builder as
    the fallback the asset policy requires. Reference bar: Company of Heroes.

---

## Status (2026-09-15)

Done: 3, 4, 8, 23, 24, terrain-as-rock, perf 54→110 fps, cloud shadows + prop variety, and the
dashed-hatching glitch (ledger #5 — it was ground plates z-fighting, never a shadow).

**Your 09-15 batch, exploded — this is the working order:**

- **E. Alive pass** (all visual, no audio yet)
  - E1. Idles you can SEE at tactical zoom: weight shifts, head scans, weapon re-grips, per-unit
    phase so a squad never moves in lockstep. Vehicles idle too (engine tremor, turret scan).
  - E2. Scenery moves: tree canopies sway, banners/antennae flex, ambient particles per theme.
  - E3. Ground reads as a MATERIAL: grass tufts / sand ripples / ice cracks / slag as instanced
    detail that sways, not a flat tint. Per-map props that belong (no desert rock on ice — the
    rock is one Meshy hull tinted nowhere).
- **F. Attacks that land** — every attack family (melee, rifle, MG, scattergun, cannon, mortar,
  launcher, flamer, bomb, air gun) gets: anticipation → contact → follow-through on the actor,
  a hit reaction on the TARGET (flinch, knock, part shudder), and impact FX at the point of
  contact (never full-screen). Melee is the reference bar: lunge, crunch, target staggers.
- **G. GUI disclosure** — one thing at a time: no-selection shows the board; a selected unit
  shows its orders; a chosen order shows its targets. Detail panels collapse until asked.

Then back to the sim items: 1 jump trooper, 5 wide beam, 13 gas, 17 slam, 22 damaged parts.

## My recommendation, in order (original)

**Round 1 (biggest fun per hour):** 1, 4, 5, 11, 13, 17 — jump trooper, shotgunner, wide beam,
falling trees, spreading gas, knockback-into-things. All sim-side, all testable, all immediately
visible in play.

**Round 2:** 22 + 23 — damaged parts show it, and the UI visual system. This is where "child play"
gets fixed.

**Round 3:** 24 — Blender infantry, done properly.

**Later / own project:** 21 (multi-team) and 10 (faction rules) both touch the sim's team model.
