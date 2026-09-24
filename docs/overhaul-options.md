# Look & faction overhaul — options (pick by number)

Owner asks (2026-09-24): infantry to AAA quality (the tank is the bar, infantry "look silly"); maps,
backgrounds, props and projectiles "way more cool and interesting" in the same toon style; factions
"WAY too similar" in look and play. Nothing below is built yet — pick numbers, add "love this" notes,
and only the picks get implemented.

Evidence this was written from: `game/shots/gpu-lineup.png` (infantry), `gpu-vehicles-close.png`
(tank / APC), `gpu-map-*.png` (six maps). Reference shots named per option live in the
game-presentation skill's gallery (internal study only).

**Why the tank works and the infantry don't** (so every option below fixes the cause, not the paint):
the tank has one clean silhouette, bevelled hard-surface parts, ONE ink-rim weight and a 3-value
palette. The troopers are box stacks with oversized helmets and heads, a patchwork of saturated
blocks (pink medic, yellow slabs), no shared line weight, and proportions that change kind to kind.

---

## A. Infantry — pick ONE direction

1. **Hero toon** — 5.5-heads-tall, smaller helmets, tapered torso and limbs (bevelled prisms, not
   boxes), the tank's exact ink rim, and a palette atlas per faction (dark / mid / light + ONE accent at
   chest height). Reads like a premium 3D tactics game. *Refs: Coastal World palette atlas, Hyper Light
   Drifter palette discipline.* Keeps the rig, per-part damage and gait untouched (shapes only).
2. **Tabletop miniature** — stockier, chunkier armour with shelf pauldrons, a painted edge highlight
   (fresnel rim) and a round base under every unit like a painted mini. Strongest "toy soldiers
   worth collecting" read; bases also fix grounding at every zoom.
3. **Faceted soldier** — realistic 7-heads proportion, low-poly faceted planes, flat shading and one
   soft gradient per part. Closest match to the tank's hard-surface kit; least "cute".

## B. Maps & backgrounds — pick any

4. **Layered horizon** — three silhouette layers per biome (mesas / smokestacks / forest / ice floes /
   ziggurats / border fences) fading into a gradient sky dome whose horizon colour IS the fog colour,
   plus slow cloud shadows drifting over the board. Fixes "backgrounds look weird and low detail".
5. **Painted terrain** — 2–3 ground materials per map (worn path, base ground, accent patches like
   scorch, snow drift, moss), cliff faces with strata (tri-planar rock), shoreline foam on water.
6. **Landmark pass** — each map's landmark (derrick, furnace, chapel/mill, freighter, colossus,
   checkpoint gate) rebuilt to the tank's bar in the Blender kit, lit by one accent colour so it is
   the thing your eye finds first.

## C. Props — pick any

7. **Hero props** — maps now carry 6–14 props, so each can be a hero piece: re-author the ~20 kinds in
   use (convoy, railcar, bunker, fuel, gas, conduit, brazier, ammo…) at tank quality — bevels, ink rim,
   baked AO, and volatile props visibly *volatile* (hazard stripes, glowing cells, fuel sloshing).
8. **Destruction states** — every prop gets a damaged mesh and a rubble footprint instead of popping
   away.

## D. Projectiles & impacts (grenades are the bar) — pick any

9. **Grenade-grade trails for everything** — the chunky ink-rimmed smoke puffs the grenade has, on
   rockets, shells, mortar rounds and bombs (each family its own colour and puff size).
10. **Impacts that leave marks** — persistent scorch decals, thrown debris chunks with the ink rim,
    dust crowns scaled to the blast.
11. **Muzzle & tracer pass** — one consistent muzzle-flash language per weapon family, heavier
    tracers for the MG and marksman.

## E. Factions — pick any (look AND play)

12. **Three silhouettes** — each faction gets its own infantry kit shapes, not just colours:
    Vanguard sleek visored helmets + jet packs + radio masts; Syndicate hoods, scarves, mismatched
    scavenged plates; Bastion heavy plate, full-face helms, shields on the line troops. Base and
    vehicle architecture follow (Vanguard hangars, Syndicate scrap huts, Bastion concrete bunkers).
13. **Three palettes** — Vanguard cool steel + cyan, Syndicate rust + tan + orange, Bastion olive +
    concrete + green, carried into the HUD accent, the deploy ring and the base banner.
14. **A signature MECHANIC each** (bigger than today's doctrines):
    Vanguard **Drop Pods** — deploy anywhere you have line of sight, not just at the base;
    Syndicate **Ambush** — units that hold still in cover are hidden until they fire;
    Bastion **Fortify** — engineers and line troops build sandbag walls anywhere they stand.
15. **Faction voice** — announcer lines and a music motif per faction on deploy / victory.

---

**Suggested pick if you just want "make it great":** 1 + 4 + 6 + 7 + 9 + 10 + 12 + 13 + 14, in that order
(infantry first, because it is the biggest gap to the tank).
