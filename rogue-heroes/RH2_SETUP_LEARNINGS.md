# Rogue Hero 2 Setup Learnings Applied To Rogue Heroes

## Runtime Shape

- Keep the project runnable without a build step. Rogue Hero 2 worked well as native browser ES modules loaded from `index.html`, so Rogue Heroes keeps that same simple loop.
- Use a single canvas as the first-class game surface. This keeps rendering predictable for fast iteration and avoids mixing DOM UI state with game simulation state too early.
- Keep a tiny local static server script in the project. It makes module loading reliable and avoids depending on a global Python install.

## Code Organization

- Keep the engine loop small and boring. `Engine(update, render, getState)` is enough for this MVP.
- Split new systems by responsibility instead of recreating one giant `main.js` immediately:
  - `KingdomSim` for kingdom, economy, territory, and result state.
  - `BuildManager` for build placement and validation.
  - `BattleSim` for auto-battle resolution.
  - `BotAI` for bot spending.
  - `KingdomRenderer` for all canvas presentation.
- Keep definitions in a single `defs.js` file while the game is small. This makes balance iteration fast.

## Determinism And Debugging

- Seeded RNG was valuable in Rogue Hero 2 for reproducing map, combat, and multiplayer issues. Rogue Heroes uses seeded RNG from the start for kingdom setup, bot choices, target selection, and battle simulation.
- Expose a lightweight `window._dev` surface early. The MVP includes helpers for starting deterministic games, skipping build, adding gold, placing structures, changing battle speed, forcing win/loss, and snapshotting state.
- Keep snapshots plain and serializable. The current snapshot reports state, timer, battle results, kingdoms, territory ownership, and structure counts.

## Game State Lessons

- Explicit state names make flow easier to test. Rogue Heroes currently uses `build`, `battle`, `results`, `victory`, and `defeat`.
- It is better to preserve simple phase transitions until the core loop is fun. Separate screens like `battleIntro` and a full kingdom-map phase can come later.
- Fast-forward controls matter in auto battlers. The battle phase includes shared `1x`, `2x`, and `4x` speed controls.

## Testing Approach

- Syntax checks are the cheapest safety gate and should stay fast.
- The next automated test layer should mirror Rogue Hero 2's Playwright approach:
  - Boot the page.
  - Wait for `window._dev.ready`.
  - Start a seeded game.
  - Place structures.
  - Skip build.
  - Let battles resolve.
  - Assert results, victory, and defeat states.
- Runtime smoke tests should validate state transitions and deterministic battle outcomes before visual polish is expanded.

## What We Intentionally Did Not Carry Forward

- No WebRTC, lobby, host/client authority, reconciliation, or remote snapshot systems for the MVP.
- No gamepad or local co-op support yet.
- No card/deck/relic/cosmetic systems yet.
- No Electron packaging until the browser vertical slice feels good.
- No large persistent meta-progression system until the round loop has been manually tuned.

## Current Rogue Heroes Direction

- Keep the vertical slice focused on one high-signal loop: build, defend, attack, gain or lose territory, repeat.
- Make battles readable at a glance by showing both the player's defense and offense simultaneously.
- Prioritize impact, clarity, and fast iteration over final assets.
- Add richer systems only after manual playtesting proves which choices are fun.
