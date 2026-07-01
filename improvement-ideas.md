# Rogue Heroes — Best Improvement Ideas

_Written 2026-06-24. The original `improve.md` / `improve-concise.txt` roadmap is
essentially **done** (all 20 loop goals in `improve/goals.mjs` target shipped features:
menu, terrain blocks, move/blast/placement rings, defenses, glyphs, scenarios, etc.).
This doc is the **next** layer — ranked by impact ÷ effort, grounded in the current code._

The honest summary from a depth audit:

| Area | Maturity | Where |
| --- | --- | --- |
| Economy / deploy / cover / terrain | **Solid** | `sim.ts`, `maps.ts` |
| Unit roster (15 kinds, real roles) | **Solid** | `units.ts` |
| Win modes (destroy / ctf / hill) | **Solid** | `modes.ts` |
| **Enemy AI** | **Shallow** — greedy nearest-target | `sim.ts:2408–2541` |
| **Tech tree / meta payoff** | **Shallow** — 6 linear nodes, cosmetic-only progression | `tech.ts`, `progression.ts` |
| **Audio** | **Thin** — SFX only, no music/ambience | `audio.ts` |
| **Tutorial / onboarding** | **Basic** — 7 close-anytime steps | `main.ts:912` |
| **Game feel / juice** | **Rough** — instant moves, invisible auras | renderer |

The one-line takeaway: **the systems are built; what's missing is an opponent worth
beating, a reason to keep playing, and the polish that makes hits feel good.** Those three
are the whole list below.

---

## Tier 1 — Highest leverage (do these first)

### 1. Make the enemy AI actually tactical ⭐ biggest single lever
**Why:** This is a single-player tactics game. The current AI (`sim.ts:2408–2541`) is a
greedy loop: shoot if in range, else walk toward the nearest player. No cover use, no
focus-fire, no retreat, no army composition. Every other system is wasted if the opponent
plays like a turret on legs. **A better opponent improves every match for free.**

**Concrete, incremental wins (each independently shippable):**
- **Focus fire** — sort enemy shooters' targets by "can we kill a part/unit this turn?"
  and concentrate, instead of each unit picking its own nearest. (~highest impact, small.)
- **Use cover** — the cover/terrain LoS system already exists for the player; have AI
  movement prefer tiles adjacent to cover toward the enemy. Reuse the cover lookup, don't
  rebuild it.
- **Retreat when crippled** — a unit with `canShoot=false` or low core HP should fall
  back toward base instead of walking into fire.
- **Smarter economy** — current spend is "cheapest tech 45% / income 30% / else strongest
  troop" (`sim.ts:2500`). Make it build toward a composition (some AT for your tanks, some
  bodies for objectives) and react to what the player fields.

**Effort:** Medium, and naturally staged — ship focus-fire alone first and feel the
difference. **Add a `sim.test.ts` case per behavior** (deterministic seed makes this easy).

### 2. Give the difficulty setting real teeth + a fair "Normal"
**Why:** Difficulty currently scales enemy HP/damage/income (stat padding). Stat-padding a
dumb AI feels unfair, not hard. Pair it with #1: easy = greedy AI, hard = focus-fire +
cover + retreat. Same stats, smarter brain. That's the difficulty curve players respect.

**Effort:** Small once #1 exists (gate behaviors behind the difficulty level already passed
into the sim).

### 3. Tech tree depth + a meta reason to keep playing
**Why:** Two stacked problems kill replay value:
- The tech tree (`tech.ts`) is 6 nodes where cheapest-first is always optimal — no real
  build-order decisions.
- Progression (`progression.ts`) is **purely cosmetic** by design. Win → recolor a unit.
  There's no "I want to play again to unlock X."

**Options (pick the lazy one that fits the vision):**
- **Lazy/highest-ROI:** make tech choices *trade-offs* (mutually exclusive branches, or
  side-grades) so a match has a strategy, not a checklist. No new persistence needed.
- **Bigger:** a light campaign/skirmish ladder — beat map N to unlock map N+1 or a new unit
  doctrine. Reuses existing maps + tech; just a persisted unlock set in localStorage
  (`rht.progression.v1` already exists).

**Effort:** Tech trade-offs = small. Campaign ladder = medium. **Decide the vision before
building** — this is the one design question worth answering up front.

---

## Tier 2 — High polish-to-effort ratio

### 4. Game feel / "juice" on the resolve phase
**Why:** Hits don't feel good yet. Units teleport between tiles, support auras (medic,
engineer) are invisible, misses have no feedback. Combat is where players spend their time —
make it readable and satisfying.
- Tween unit movement over the resolve window instead of snapping (renderer-only, sim
  untouched — respects the one-way data flow).
- Hit/miss feedback: damage numbers or a flash on the part hit; a puff where a miss lands.
- **Show aura ranges** (medic heal, engineer repair, scout spotter) as ground rings on
  selection — the move/blast/placement ring system already exists; reuse it for auras.

**Effort:** Small–medium, renderer-side, low risk. High perceived-quality return.

### 5. Audio: a music/ambience layer
**Why:** `audio.ts` is all runtime-synthesized SFX (solid, no asset files needed) but there's
no music and no ambience — silence between actions reads as "unfinished." Even one low menu
loop + one battle loop + per-map ambient bed transforms the felt production value.

**Effort:** Small to wire (a loop player + ducking under SFX). The asset sourcing is the
real cost — keep it royalty-free or continue the synthesized approach (a slow generative pad
fits the existing no-assets philosophy).

### 6. Onboarding beyond the 7-step tutorial
**Why:** The tutorial (`main.ts:912`) is a closeable 7-step text walkthrough with no
in-match hints and no per-mode coverage. New players hit CTF/Hill with no guidance.
- Lightweight: contextual first-time tooltips ("this unit can take cover — get it adjacent")
  triggered by game state, not a wall of upfront text.
- Per-mode one-liner objective banner on first play of each mode.

**Effort:** Small. Reuses the existing objective HUD chip.

---

## Tier 3 — Worthwhile, lower urgency

- **Dynamic map events** — sandstorms (accuracy), collapsing cover, etc. Maps are detailed
  (`maps.ts`, 6 of them) but static. One shared event system, opt-in per map. _Medium; fun
  but not load-bearing._
- **Unit veterancy within a match** — a unit that survives + scores kills earns a small
  buff (or a visible chevron). Cheap way to make you care about individual units. _Small._
- **Replay / match summary screen** — end-of-battle recap (units lost, damage dealt, MVP)
  beyond the bare victory/defeat overlay. _Small–medium._
- **Smarter camera-assist** — already auto-frames; extend to follow the *most consequential*
  action during resolve, not just the selected unit. _Small._
- **AI personalities** — once #1 lands, seed enemy "doctrines" (turtle / rush / armor-heavy)
  so matches vary. _Small on top of #1._

---

## Explicitly NOT recommended right now
- More maps/units/cover variety — you have **15 units and 6 detailed maps**. Content isn't
  the bottleneck; the **opponent and the meta loop** are. Adding more content to a game with
  a dumb AI and no progression payoff is polishing the wrong end.
- i18n / locale — no audience signal that justifies it yet. YAGNI.
- A second save slot / battle history — nice, but #1–#3 move the needle far more.

---

## Suggested order
1. **Enemy AI — focus fire** (smallest slice of #1, biggest felt change).
2. **Hook focus-fire + the rest of #1 to difficulty** (#2) — now there's a curve.
3. **Resolve-phase juice + aura rings** (#4) — combat finally feels good.
4. **Decide the meta vision, then tech trade-offs or a ladder** (#3) — the replay reason.
5. **Music/ambience layer** (#5) and **contextual onboarding** (#6) as polish passes.

Every Tier-1/2 item is independently shippable and gate-able (`npm run verify` + a
`sim.test.ts` case for logic, a screenshot for anything visual). Nothing here needs a
rewrite — it's all additive on the existing three-layer architecture.
