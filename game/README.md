# Rogue Heroes Tactics — game package

Setup, run and test instructions live in the [root README](../README.md); the engineering guide
is [`CLAUDE.md`](../CLAUDE.md). This file is a short tour of how the game plays.

## The loop

- **Command phase:** every unit gets command points. Select a trooper, vehicle or aircraft and
  queue orders — move, shoot (aimed at a specific part), grenade, melee, take cover,
  load/unload transports, and each kind's signature ability. Your Home Base gets one order a turn:
  deploy a unit (you pick where in its ring), research a doctrine, build a defense, call a support
  strike, or upgrade income.
- **Resolve phase:** both sides' orders play out together in a short real-time burst, with a
  camera that follows the action. Then the next command phase begins.
- **Per-part damage:** units are bags of parts. Destroy a tank's tread and it can't move, its
  cannon and it can't shoot; knock a rifle out of a soldier's hands and they are disarmed.
  Blasts throw what they don't kill (into water, where it drowns).
- **Tech:** doctrines unlock new troop types; each doctrine then offers two specializations —
  pick one, and the other is locked out for the battle.

## Skirmish

Six battlefields, each with its own layout, landmarks and hazard: Dust Bowl (sandstorms),
Ironworks (slag spills), Verdant Pass (lightning), Frozen Causeway (ion storms), Ruins of Karak
(collapses) and Crossfire Basin (artillery barrages). Three modes (Annihilation, Capture the Flag,
Hold the Hill), three factions, three AI difficulties, or Local 2 Players (hotseat). Medals and lifetime
stats are on the Achievements page; cosmetics are in the Armory.

## Debug / Sandbox mode

Launch with `?debug` (dev URL) or `--debug` / `RHT_DEBUG=1` (desktop app) to reveal a Debug
section at the bottom of Settings: infinite money and free deploy cooldowns.
