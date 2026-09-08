# Art direction — three named options

You said the map, the ground units and the GUIs all need to look AAA. I agree, and the reason
none of my last round closed it is that I was tuning a look that doesn't exist yet. The game
currently renders default `MeshStandardMaterial` on procedural boxes under a warm key light, on a
brown plane. That is not a style — it's the absence of one, and no amount of texture work fixes it.

So: pick a direction. **Reply with the numbers you want** (e.g. "A, plus 14 and 22"). Rejected
options get deleted from disk.

## What the reference bar actually looks like

I put our frames next to the gallery (`/game-presentation` references, 46 verified shots).

**Into the Breach** — the board is *composed of readable objects*. Discrete terrain plates,
distinct terrain kinds each with its own colour and height, buildings and trees as information.
Strong value break between the dark surround and the light board. Every pixel of ground says
something. Ours is one continuous brown plane; there is nothing to read.

**Summer Afternoon (three.js)** — fully committed flat/painterly shading: two-tone value steps,
hand-tinted gradient sky, warm horizon haze, big organic canopies with darker internal shapes,
long soft shadows. It photographs like a film still with less geometry than we already have.

**Hades** — value hierarchy on characters: dark at the feet, mid on the body, and exactly one
hot saturated accent at chest height. Every unit passes the black-silhouette test.

The gap is not detail. It's **commitment to a shading model, a palette, and a silhouette rule**.

---

## Option A — "Tactical Board" (Into the Breach, in 3D)

Readability *is* the aesthetic. The battlefield stops being a plane and becomes a board.

1. Terrain rebuilt as discrete **plates** with visible edges and thickness — grass, dust, rock,
   water, road each a distinct value and hue, not a blend.
2. A dark surround and a bevelled board edge, so the play space reads as a lit stage.
3. Every terrain kind gets a **height step** — flat ground, raised rock, sunken water — so
   elevation reads from silhouette alone.
4. Props (trees, rocks, crates) placed as *board furniture* at plate centres, not scattered.
5. One vertical **landmark** per map carrying the accent colour, unoccluded from most of the board.
6. Units: chunky, low-detail, **high-contrast** — dark base, mid body, one hot accent at weapon
   height. Detail removed, not added.
7. Per-unit silhouette rule enforced by a black-silhouette contact sheet you can look at.
8. GUI: strict regional grid, boxed panels with hard borders, one accent colour, tabular numbers.
9. Threat/range shown as **coloured board overlays**, not thin rings.

## Option B — "Painterly Field" (Summer Afternoon / Coastal World)

Committed flat-shaded diorama. Warm, saturated, hand-tinted. The most beautiful of the three and
the biggest departure.

10. Swap every material to a **toon ramp** (3–4 band `MeshToonMaterial` + narrow-smoothstep
    terminator) — flat shapes with crisp value steps instead of soft PBR gradients.
11. **Gradient sky dome** with the fog colour driven from its horizon band (one shared constant),
    so distance reads as haze, not as grey.
12. Ground gets **painted value zones** — broad hand-authored patches of grass/dirt/scrub, plus
    scattered flat detail marks, rather than a tiling noise texture.
13. Trees and rocks rebuilt as **big organic canopies** with a darker internal mass, two-tone.
14. **Long soft directional shadows** at a low sun angle as a primary composition element.
15. Instanced **ground cover** (grass/scrub clumps, alpha-cutout, wind in the vertex shader).
16. Slow **cloud-shadow** scroll over the terrain — one texture fetch, makes every frame alive.
17. Units re-silhouetted as stylized characters: bigger heads-in-helmets, heavier boots, capes /
    packs / antennae per role. Personality via *shape*, not greebles.
18. GUI: light, minimal, typographic — Slow Roads restraint. Translucent cards, no heavy chrome.

## Option C — "Grim Command" (Hades / Dead Cells / Darkest Dungeon)

Dark, cool, dramatic. Closest to where the game already leans, taken all the way.

19. World desaturated and cooled; terrain values pushed **dark**, so units read as near-black
    silhouettes with lit rims.
20. One warm key + a strong **cool rim light**; heavy vignette; bloom reserved for accents only.
21. Every unit carries exactly **one hot saturated accent** (visor, muzzle, power cell) at chest
    height — the only saturated pixels in the frame.
22. Fresnel rim shader on all units so they separate from any ground.
23. Terrain lit by **practical lights** (fires, lamps, base glow) that double as wayfinding.
24. GUI: ornamented dark panels with gold trim and big display type; focus states carried by a
    caret + fill + value change, never a 1px outline.

---

## Shared foundation (right under any option — I'll start these now)

25. **Blob shadows + a frozen shadow map**, so shadow cost stops scaling with detail and I can
    afford more geometry per unit.
26. **Vertex-colour AO** on every procedural part (darken downward-facing/interior verts) — baked
    contact shading with zero assets, which is most of what "AAA" reads as on simple shapes.
27. **Palette-atlas materials**: one 4×4 swatch texture, every part UV'd to a texel centre, so a
    whole unit merges to one draw call and a faction reskin is 16 pixels.
28. **Gradient sky dome + fog colour from one shared constant** (they're two eyeballed values now,
    which is why distance reads as "turning grey").
29. **HUD grid skeleton** — one full-screen CSS grid with named regions, so panels cannot overlap
    by construction (the target panel covering the Menu button was this bug).
30. **Typography scale** — rem-only HUD off a `clamp()` root, display + body font pair, tabular
    numbers on every counter, halo on all over-world text.
31. **`auditUI()` gate** — deterministic overlap / truncation / contrast / occlusion checks across
    five viewports and three screens, wired into `test:full`, so UI regressions get caught by a
    test instead of by you.

---

**My recommendation: A for the map and GUI, B's unit work (items 13, 17) on top.** A tactics game
lives or dies on board readability, and Into the Breach is the proven bar for exactly this genre —
but its unit and prop *shapes* are the flattest of the three, and B's silhouette work is what will
give your troopers personality. C is the most dramatic but fights the genre: dark, low-contrast
terrain is the enemy of reading a battlefield.
