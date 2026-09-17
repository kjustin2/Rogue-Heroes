# Unit identity — one signature ability each, plus vehicle personality

The look side landed 2026-09-16 (every infantry kind has its own Blender helmet + weapon; see
`npm run shots:lineup`). This is the OTHER half of "each one unique": one signature verb per unit
that you can see happen, no tooltips required. Pick by number. Everything here is sim-side and
testable; none of it adds a new button unless it says so.

What each kind already has that is unique in play: scout (fastest, long carbine), sniper (pierces
the line), striker (blade, lunge), heavy (10-round MG), grenadier (splash launcher), mortar
(indirect, over walls), medic (heal aura), engineer (repair aura + damage boost), flamer (burning
ground), drone op (spotter aura, 26m eyes), sapper (scattergun + mines), jumper (jet jump).

## Infantry

1. **Scout — Dash.** Its move never provokes overwatch (it is too fast to track). Visible: the
   overwatch cone flashes and misses. Zero UI.
2. **Sniper — Mark.** After a sniper fires at a unit, every other friendly gets +20% hit on that
   unit until the next turn. Visible: the marked unit wears a red bracket. Zero UI.
3. **Striker — Charge.** Strike reach becomes a real charge: up to 5m of closing distance is free
   (no move CP), the lunge covers it. Visible: the slash arc starts far back. Zero UI.
4. **Heavy — Suppression.** Any unit the MG burst touches (hit or near miss) loses one command
   point next turn. Visible: a "SUPPRESSED" chip on the card and the trooper drops to a crouch.
   This is the one the doc called item 8 and it makes the MG a *control* weapon, not just DPS.
5. **Grenadier — Airburst.** Optional: the launcher round detonates over cover, so crouching
   behind sandbags halves the protection instead of blocking it. Visible: the blast is above the
   wall, shards come down.
6. **Mortar — Smoke round.** A second order: lob a smoke cloud (3 turns) that blocks line of
   fire through it. Reuses the gas-cloud machinery with a grey cloud and no choke/ignite. New
   button (one), but it is the classic mortar verb and it gives the player a *defensive* tool
   the roster does not have.
7. **Medic — Stabilise.** A downed trooper (all HP parts 0 but head intact) stays as a body for
   one turn; a medic reaching it brings it back at 30%. Visible: the body glows the medic's red,
   the medic kneels. Turns "killed" into "down" for infantry and adds rescue plays.
8. **Engineer — Deployable bridge / barricade.** Item 16 from the fun pass: place a span over
   a channel (one CP + $) or a sandbag line. Visible: it builds over the resolve. New button
   (reuses the Defenses placement flow).
9. **Flamer — Fear.** Enemy infantry within 6m of a burn zone at turn start move away from it
   on their AI turn instead of pressing. Visible: they run. Zero UI.
10. **Drone op — Recon pulse.** Reveal every enemy unit's queued order for one turn (ghost
    arrows on the board). The strongest information verb in the game; costs its whole turn.
11. **Sapper — Breach.** Its scattergun destroys a wall/cover piece in ONE shot regardless of HP
    (already 3x; make it total). Visible: the wall goes down in one bang.
12. **Jump trooper — Slam landing.** Landing within 1.5m of an enemy knocks it back a step and
    deals 15 (the slam rule already exists — reuse `resolveSlam`). Visible: dust ring on landing.

## Vehicles and air (personality beyond "big gun")

13. **Tank — Hull down.** Not moving for a turn gives +30% armour (the Bastion rule from item 10,
    given to the tank only). Visible: the tank settles on its suspension and the hull darkens.
14. **APC — Carry.** Airlift already exists for the transport; give the APC a 2-seat ground
    version so the roster's fast flanker actually flanks with infantry.
15. **Artillery — Deploy.** Must spend a turn deploying (outriggers down) before it can fire,
    and cannot move while deployed. Visible: legs fold out. Makes it a *position* piece.
16. **Flak — Tracer wall.** Its shots leave a 1-turn tracer line that reveals stealth/air and
    blocks air movement through it. Visible: a hanging line of bursts.
17. **Gunship — Strafe.** A move order that also fires along the path at everything on it.
18. **Bomber — Carpet.** Drops three bombs in a line along its heading instead of one.

## Animation polish still owed (pairs with the above)

19. Per-family attack clips in the Blender motion bank for the families that still use the
    procedural curve: **flamer** (sweep across), **pistol** (one-hand snap), **wrench/wand**
    (a working gesture, not a shot), **mortar** (drop-a-round), **shotgun** (pump). `author_motion.py`
    already has the channel model; each is ~20 curve keys.
20. **Hit reactions per body part**: head hit = snap back, leg hit = buckle, pack hit = spin. The
    flinch is one shove today.
21. **Death variety**: fall forward / backward / crumple by the direction of the killing shot.
    Today every death is the same collapse.

## Landed 2026-09-16

4 suppression, 12 slam landing, 13 hull down, 19 (flamer / scattergun / sidearm clips), 21 death
variety. Still open: 1–3, 5–11, 14–18, 20.

## My picks if you say "you choose"

4 (suppression), 7 (stabilise), 6 (smoke), 12 (slam landing), 13 (hull down), 19, 21. Those seven
make every unit's *turn* look different, not just its helmet, and none of them adds more than one
button.
