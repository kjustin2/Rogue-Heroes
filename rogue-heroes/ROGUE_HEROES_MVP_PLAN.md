# Rogue Heroes Vertical Slice MVP Plan

## Summary

Rogue Heroes is a fast paced kingdom-building auto battler. The vertical slice should prove the core loop before network multiplayer, gamepad support, final art, or larger progression systems are added.

The MVP runs as a separate vanilla JavaScript canvas app under `rogue-heroes/`, using the same no-build setup style as Rogue Hero 2: native ES modules, a requestAnimationFrame engine, canvas rendering, deterministic seeded simulation, and browser dev-console helpers.

The first playable goal is:

1. Start a single-player game with one player kingdom and three bot kingdoms.
2. Upgrade and run a small factory that produces gold from workers, machines, logistics, and sabotage risk.
3. Spend a short build phase placing defensive, offensive, and economy structures.
4. Optionally buy a one-round alliance when 3+ kingdoms are alive.
5. Resolve a round where each kingdom attacks another non-allied kingdom.
6. Watch the player defense and offense battles play out as auto battlers.
7. Apply territory gains/losses on the kingdom board.
8. Repeat until the player conquers the board or loses all territory.

## Player Flow

### Game Start

- The game opens directly into the build phase.
- The player begins with:
  - 3 territories.
  - 70 gold.
  - 1 tower.
  - 1 guard post.
  - 1 farm.
- Three bot kingdoms each begin with 3 territories and a basic starting base.

### Build Phase

- Before build, the player has a factory setup and factory run phase.
- Factory output plus controlled land value determines how much gold is available for the build phase.
- The player has 90 seconds to build.
- The player may also click `Start Battle` or press `Enter`/`Space` to start early.
- The build screen shows:
  - Round number.
  - Current gold.
  - Expected next income.
  - Build timer.
  - Kingdom board ownership.
  - Build field.
  - Tool buttons grouped by defense, offense, and economy.
- Clicking a tool selects it.
- Clicking inside the build grid places it if:
  - The player can afford it.
  - It is inside the build field.
  - It is not too close to another structure.
  - It is not blocking the core area.

### Current MVP Structures

Defense:

- `Wall`: cheap blocker with high HP.
- `Tower`: fires at attackers during defense battles.
- `Barracks`: spawns two guard defenders.
- `Trap`: single-use burst damage.
- `Guard Post`: spawns one guard defender.

Offense:

- `Raider Camp`: adds three fast raiders to the player's next attack.
- `Stable`: adds two durable knights.
- `Siege Yard`: adds one slow siege unit that is strong against the core.

Economy:

- `Farm`: increases income by 5 gold each round.

### Battle Phase

- At the end of build, bot kingdoms make simple build decisions.
- Before battle, the player chooses an offensive formation: line, wedge, column, or scatter.
- Every living kingdom sends an offensive army to another living kingdom.
- If no bot randomly attacks the player, one bot attack is redirected to the player so the player always gets a defense battle while bots remain alive.
- The player watches the battle involving their kingdom, prioritizing defense.
- Other bot battles resolve quickly in simulation.
- Battle HUD shows:
  - Attacker and defender names.
  - Attacker count.
  - Defender count.
  - Core HP.
  - Remaining battle time.
  - Speed buttons for `1x`, `2x`, and `4x`.
- Attacking armies enter from randomized edges instead of always using the same lane.

### Battle Rules

- Attackers spawn from the left side and move toward the defender core.
- Defender units spawn around the core.
- Towers fire projectiles at attackers.
- Beam Obelisks fire piercing beams after being unlocked through tech.
- Nova Shrines pulse ring damage after being unlocked through tech.
- Traps trigger once when attackers cross them.
- Rangers use spread shots after being unlocked through tech.
- Mages use piercing beam attacks after being unlocked through tech.
- Raiders sprint, knights charge, siege units splash, archers slow, and walls apply a slowing aura.
- Attackers target nearby structures, nearby defenders, or the core.
- Defenders target nearby attackers.
- The defender holds if:
  - All attackers die.
  - The battle timer expires.
- The attacker wins if the core is destroyed.

### Territory Results

- If the attacker destroys the core, the attacker gains 1 territory from the defender.
- If the attacker wins with at least 3 surviving attackers, the attacker gains 2 territories.
- If the defender holds, no territory changes hands.
- Damaged or destroyed defender structures persist after battle.
- Destroyed non-single-use structures are removed from the defender base.
- Territory nodes have different gold values, so high-value kingdoms are strategically important.

### Alliances

- If 3+ kingdoms are alive, the player may offer one alliance per round.
- An alliance costs gold and can be refused.
- Allied kingdoms cannot attack each other during that round.
- Alliances expire at the next round, preventing permanent stalemates.

### Factory Phase

- Each round starts with factory setup.
- The player can buy workers, machines, logistics, or quality upgrades.
- The player can sabotage a rival factory, slowing workers and reducing output.
- The factory run phase shows the player's factory and one rival factory producing gold.
- Final build gold comes from base income, controlled land income, factory output, and farm structures.

### Round Results

- The results screen shows:
  - Kingdom board after territory changes.
  - Battle report lines.
  - Current territory counts.
  - `Next Round` button.
- Starting the next round grants income to all living kingdoms.
- After results, the player picks one tech upgrade before the next build phase.

### Tech Tree

- Each round offers three deterministic tech choices.
- Tech can unlock new buildings or improve existing systems.
- Current tech includes structure HP, arrow damage, offensive speed, veteran guards, Beam Obelisk, Nova Shrine, Ranger Range, and Arcanum unlocks.

### Win/Loss

- Victory triggers when the player is the only kingdom with territory.
- Defeat triggers when the player reaches zero territories.

## Technical Implementation

### Runtime Shape

- `index.html` hosts a single full-screen canvas.
- `style.css` contains only page/canvas shell styles.
- `src/main.js` owns the app state machine.
- `src/Engine.js` owns the requestAnimationFrame loop.
- `src/Input.js` owns mouse/keyboard state.
- `src/KingdomSim.js` owns kingdoms, territory, income, structures, attack pairing, result application, and snapshots.
- `src/BuildManager.js` owns placement validation and selected build tools.
- `src/BotAI.js` owns simple bot build decisions.
- `src/BattleSim.js` owns units, structures, projectiles, battle timer, core HP, and battle result generation.
- `src/KingdomRenderer.js` owns all canvas rendering and button hitboxes.
- `src/DevConsole.js` exposes test/debug helpers on `window._dev`.
- `src/defs.js` owns balance constants for structures, units, colors, and the territory board.
- `src/rng.js` provides deterministic seeded RNG.

### State Machine

Current MVP states:

- `build`
- `battle`
- `results`
- `victory`
- `defeat`

The original larger plan allowed `boot`, `kingdomMap`, and `battleIntro`, but those are intentionally collapsed for the playable vertical slice.

### Dev Console

The MVP exposes `window._dev`:

- `_dev.ready`
- `_dev.startRogueHeroes(seed)`
- `_dev.skipBuild()`
- `_dev.addGold(amount)`
- `_dev.place(type, x, y)`
- `_dev.setSpeed(speed)`
- `_dev.forceWin()`
- `_dev.forceDefeat()`
- `_dev.snapshot()`

These are intended for manual iteration and future Playwright tests.

## Test Plan

Manual acceptance:

- Load `rogue-heroes/index.html` through a local server.
- Confirm the game starts on the build screen.
- Place at least one defense, offense, and economy structure.
- Start the battle manually before the timer ends.
- Confirm attackers, defenders, towers, traps, projectiles, core HP, and speed controls work.
- Confirm the round results screen displays territory changes.
- Continue multiple rounds.
- Confirm victory and defeat screens are reachable.

Programmatic checks to add next:

- Boot page and assert `window._dev.ready === true`.
- Start deterministic game with `_dev.startRogueHeroes(12345)`.
- Assert 4 kingdoms and 12 territories.
- Place every structure type through `_dev.place`.
- Use `_dev.skipBuild()` and confirm state reaches `battle`.
- Let battle resolve and confirm state reaches `results`, `victory`, or `defeat`.
- Force win/loss and assert end states.

## Assumptions And Defaults

- MVP is single-player only.
- There is no network multiplayer.
- There is no gamepad support.
- Art is intentionally simple top-down canvas geometry.
- Build phase defaults to 90 seconds.
- Bots use a simple spend-until-low-gold build heuristic.
- The player watches defense battles whenever bots are alive.
- Territory changes are intentionally simple so the loop can be tuned after manual playtesting.
