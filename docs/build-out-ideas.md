# Rogue Heroes Tactics — Build-Out Ideas

Ideas only — nothing here is implemented. Grounded in what the game already has:
a pure deterministic sim (seeded RNG, per-part damage, replayable resolves), an
8-mission campaign, a doctrine tech tree with rival specializations, off-map support
powers, discovery-paced unlocks, dynamic map events, toppling cover, three win modes,
and a cosmetic-only armory. Each idea notes the systems it touches and a rough size
(S = a day-ish, M = a few days, L = a week+).

---

## 1. Campaign 2.0 — from mission ladder to operation

The current campaign is a linear ladder of 8 skirmishes with briefings. The biggest
return on investment in the whole doc is making it feel like a *war*, not a playlist.

- **Operation map with branches (M).** A stylized front-line map where completed
  missions push the line forward. 2-way branches ("strike the refinery OR relieve the
  outpost") that pick which map/mode/modifier you face next and which reward you get.
  Pure data extension of `campaign.ts` + one new menu screen.
- **Persistent roster + veterancy (L, flagship).** Units that survive a mission carry
  to the next: name, kill count, and a rank (Recruit → Regular → Veteran → Elite) worth
  small, readable bumps (+acc/+hp, one extra grenade at Elite) and a visible chevron
  insignia (renderer accent). Losing a veteran should *hurt*. Needs: campaign save
  schema for roster, deploy screen "bring your squad" step, sim hooks for per-unit
  modifiers (same pattern as tech effects).
- **Between-mission requisition (M).** Spend mission rewards on the NEXT mission's
  starting kit: extra starting cash, a pre-unlocked doctrine, one free support strike,
  a fortified start (2 walls + turret). Turns the reward number into a decision.
- **Named characters + radio drama (S–M).** A commander, a recurring enemy warlord,
  and 2–3 squad voices delivered as briefing text + in-battle radio toasts on triggers
  (first blood, base under attack, veteran down). The toast/intel-ticker surface
  already exists.
- **Mid-mission scripted beats (M).** Turn-triggered events per mission: enemy
  reinforcements air-drop on turn 4, a neutral convoy crosses on turn 3 (protect or
  loot), the map event forecast changes mid-battle. `events` config already supports
  per-turn scheduling — extend with entity-spawn events.
- **Optional objectives (S).** "Also destroy the fuel depot" / "win before turn 8" /
  "keep all veterans alive" for bonus requisition. Checked at victory; shown on the
  briefing card.
- **Finale (M).** A two-phase last mission: destroy the shield generators (new
  invulnerable-until flag on the enemy base), then the base itself, under escalating
  barrage events. Uses existing pieces almost entirely.

## 2. New tactical systems

- **Overwatch / reaction fire (L, deepest gameplay add).** During command, spend a
  unit's CP to set a watch arc; during resolve, enemies moving through the arc eat a
  reaction shot (with an accuracy penalty). This single system transforms defense,
  chokepoints (the causeway!), and the escort mode below. Sim: new order kind +
  interrupt checks in the projectile/move resolver; renderer: arc telegraph wedge.
- **Suppression (M).** Sustained fire near a unit builds suppression: -accuracy, and
  at full pin, -1 CP next turn (mirrors the existing ion-storm CP clamp). Heavy
  gunners get a purpose beyond damage; smoke visual + "PINNED" tag on the marker.
- **Battlefield scars (S–M).** Blasts leave crater decals; destroyed vehicles leave
  wreck hulls that act as new neutral cover entities (the damage model already treats
  cover generically). Fights visibly reshape the map — pairs beautifully with topple.
- **Salvage (S).** A unit ending its turn beside a wreck/rubble recovers $30–60 once
  per wreck. Gives scouts and the mid-field a reason to exist after the lines form.
- **Capturable neutral structures (M).** Maps seed a derelict turret / watchtower
  (vision + high ground) / supply depot (+$/turn) that an infantry unit captures by
  standing adjacent for a turn. Objectives beyond the base fight; great on CTF/hill
  maps too.
- **Mines & demo charges (M).** Engineer gains "plant mine" (hidden to the enemy AI
  via a simple "known after first detonation" rule) and "demo charge" vs cover/walls —
  synergizes with topple for engineered collapses.
- **Event forecast bar (S).** The sim already computes future event windows; show the
  next 2 turns' weather/barrage schedule as small icons above the turn counter so
  storms are plans, not surprises.

## 3. New units & enemies

- **Flamer (M):** cone attack that leaves 2-turn burning ground (area denial; the
  danger-zone ring visuals already exist). Counter: crouching does not help — run.
- **Drone operator (M):** deploys a fragile hovering drone (new flying flag: ignores
  terrain height for movement/LoS) that spots for indirect fire like the scout relay.
- **Sapper (S if mines exist):** the mine/demo kit above as its own kind, freeing the
  engineer to stay the repair unit.
- **Enemy elites & a boss (M).** Campaign-only variants: an elite tint + one extra
  part (shield generator part that must be destroyed first) and a finale walker boss
  with per-part phases — the per-part damage model was built for this.

## 4. New modes

- **Escort (M):** a slow neutral convoy crosses the map; you win if ≥1 truck exits.
  Trucks are just vehicles with no weapons — most of the sim already handles it.
  (Needs overwatch to really sing.)
- **Survival (M):** seeded escalating waves against your fortified base; leaderboard
  number = turns survived. Reuses AI spawn machinery; great retention mode.
- **Domination (S):** three hills, score per held hill per turn — variant of the
  existing hill logic.
- **Daily operation (S–M):** date-seeded map + modifier ("all costs -20%", "permanent
  sandstorm", "no vehicles") + fixed difficulty; local best-score history. The seeded
  determinism makes this nearly free and very sticky.
- **Puzzle scenarios (S each):** fixed tiny setups with a "win this turn" constraint
  (the scenario/debug seam already stages arbitrary states). 10 of these = a great
  "tactics gym" menu entry + teaching tool.

## 5. Meta & progression

- **Commander profile (M):** lifetime stats (battles, K/D by unit kind, favorite
  doctrine), medals for feats (win without losing a unit; topple-kill; triple-kill
  with one shell), and title unlocks feeding the existing cosmetic titles.
- **Armory expansion via retexture (M):** the Meshy pipeline supports cheap
  retexture-only passes — unit *skins* (winter, desert night, parade) as cosmetic
  unlocks would reuse committed meshes for ~10 credits each instead of 30.
- **Doctrine mastery (S):** playing a doctrine N times unlocks a cosmetic banner/decal
  for it — visible on the HQ model's accent flag.

## 6. Presentation & drama

- **Replay system (M, uniquely cheap here).** The sim is deterministic: record the
  battle seed + every queued order per turn, and a full battle replay (with free
  camera) is just re-running the sim. Almost no other game gets replays this cheap.
  Also unlocks "share this battle" codes.
- **Kill-cam finish (S):** on the battle-winning kill, 1.5s slow zoom + letterbox on
  the final shot before the victory card. All camera pieces (guideTo, punch-in) exist.
- **Director-style campaign cutscenes (M–L):** data-driven rail-camera beats for
  mission intros (fly over the map, pan across enemy defenses) — the DEAD AIR
  director/cutscene pattern is the house reference.
- **Radio barks (S):** short procedural radio chirp + text line on kills/losses/
  strikes ("Lance inbound, heads down!") — audio synth layer already exists.
- **Photo mode (S):** pause, free camera, hide UI, screenshot key. The debug camera
  already does 90% of this.

## 7. QoL / platform

- **Undo last order during command (S)** — orders are a queue; pop + refund CP.
- **Threat preview toggle (M):** show enemy range/LoS overlays during command
  (previewShot machinery run in reverse).
- **Turn timeline scrubber for the resolve (M):** pause/slow/replay the resolve that
  just happened (pairs with the replay system).
- **Keybind remapping + colorblind team palettes (S–M).**
- **Steam packaging pass (M):** electron-builder already outputs a portable exe;
  achievements map cleanly onto the medals system.
- **Map editor-lite (M–L):** maps are pure data — a JSON-driven custom-map loader +
  share codes is far cheaper than an in-game editor and unlocks community content.

---

## Suggested sequencing

**Wave 1 — make battles deeper (systems):** overwatch, suppression, battlefield
scars + salvage, event forecast bar, undo. These multiply every mode.

**Wave 2 — make the campaign the product:** persistent roster + veterancy,
operation map with branches, requisition, optional objectives, mid-mission beats,
radio drama. This is where the game becomes "one more mission" instead of "one
more skirmish".

**Wave 3 — retention + spectacle:** daily operation, survival mode, replays +
kill-cam, puzzle gym, commander medals, skins. Cheap individually, compounding
together.

**Anytime, opportunistically:** photo mode, barks, capturable structures, new maps
(night urban with working streetlights; canyon spans built from the causeway
blocks; volcanic ashfall with scheduled eruption events).

The two bets I'd place first: **overwatch** (deepest tactical payoff per line of
code, and the causeway/chokepoint maps are already built for it) and **persistent
roster veterancy** (the emotional engine every beloved tactics game runs on).
