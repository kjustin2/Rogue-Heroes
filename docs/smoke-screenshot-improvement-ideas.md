# Smoke Screenshot Improvement Ideas

Reviewed screenshots: `game/shots/1-command.png`, `2-hover-help.png`, `3-queued-undo.png`, `4-two-moves-compact.png`, `4-unit-detail.png`, `5-blocked-targeting.png`, `5-cliff-interact.png`, `6-clear-targeting.png`, `7-projectiles.png`, `8-resolved.png`, `8-expanded-log.png`, `9-rolling-grenade.png`, and `10-mobile.png`.

Context note: the existing `improve.md` points toward an RTS layer with base building, zone control, and turn-based tactical battles triggered by conflict. The ideas below are framed to make the current tactical slice feel better now while also supporting that larger direction later.

## 1. Smart Combat Camera And Visibility Pass

The biggest visual issue in the screenshots is that the game often looks best from a high tactical angle, but targeting and resolve states can drop into low, prop-heavy views where important information is hard to read. In `5-blocked-targeting.png`, `6-clear-targeting.png`, `7-projectiles.png`, and `9-rolling-grenade.png`, walls, cliffs, crates, and large foreground props partially bury units, projectiles, and target lines.

Big improvement:

- Add tactical camera presets for command, targeting, and resolve instead of using one general-purpose camera behavior.
- Fade or ghost foreground props when they sit between the camera and selected units, targets, projectiles, or preview lines.
- Add stronger unit silhouettes, team-colored bases, and overhead role/status markers so units stay readable through clutter.
- Keep the current cinematic low-angle view as a momentary resolve camera, but make the default planning camera more board-game readable.

Why it matters:

This would immediately make the game feel more deliberate and less like the player is wrestling the camera. It also improves the look because the battlefield composition would consistently showcase units, cover, and action lines instead of letting scenery block the important moment.

## 2. Stronger Map-Based Intent Preview

The HUD contains useful information, but a lot of tactical meaning is still trapped in small text panels. The screenshots show preview lines and part buttons working, but the battlefield itself does not yet communicate enough about what will happen. This is especially visible in `3-queued-undo.png`, `4-two-moves-compact.png`, `5-blocked-targeting.png`, `6-clear-targeting.png`, and the grenade-related resolve shots.

Big improvement:

- Add direct map labels for selected action outcomes: "blocked by wall", "splash radius", "friendly risk", "outside range", "will hit cover", and estimated damage.
- For grenades and shells, show a landing marker, blast radius ring, and affected-unit highlights before confirming.
- For queued orders, number the order path on the map and use ghost positions for where the unit will stand after each move.
- Show health-change previews near the target, not only inside the bottom command bar.

Why it matters:

This would make decisions faster and more confident. The current command system is already deep enough to support interesting tactics, but the player needs more of that information on the battlefield itself.

## 3. Make Battles Objective-Driven, Not Just Damage-Driven

The current screenshots read as a clean tactical sandbox: squads, cover, base, target parts, and logs are all visible, but the battle does not yet communicate a reason to move other than getting better shots. The existing `improve.md` direction points to zone control and RTS-triggered battles, so the tactical map should start showing objectives that connect to that larger game loop.

Big improvement:

- Add local tactical objectives such as hold zones, disable relay nodes, protect construction units, destroy power structures, or extract damaged squads.
- Give each generated battle map a purpose tied to the RTS zone where the fight started.
- Show objective progress in the HUD and on the ground with capture/control rings.
- Let terrain and props imply the strategic context: a supply depot fight should look and play differently from a base-gate fight or ridge-control fight.

Why it matters:

This is probably the largest gameplay improvement. It turns the tactical mode from "kill the enemy force" into a conflict-resolution layer for the larger RTS game. It would also make maps more memorable because layout, props, and win conditions would all reinforce the same situation.

## 4. Resolve Phase Spectacle And Aftermath Feedback

The resolve screenshots show that projectiles and the battle log work, but the action can still feel quiet. In `7-projectiles.png`, the shot lines are visible but subtle. In `8-expanded-log.png`, the recap is informative, but it arrives as a detached report rather than a dramatic aftermath tied back to the map.

Big improvement:

- Add short camera beats during resolve: follow a shell, snap to a grenade landing zone, or briefly focus a critical part destruction.
- Add floating damage numbers and part-break callouts at the unit that was hit.
- Make destroyed parts visually obvious on models: missing weapons, damaged treads, smoking packs, exposed tank armor.
- After resolve, add a compact "Turn Impact" overlay that links major events back to units on the field.

Why it matters:

The game already has simultaneous orders and detailed part damage. Better resolve feedback would make that system feel much more rewarding. Players should not need to open the battle log to feel that something important happened.

## Suggested Priority

1. Smart camera and visibility pass.
2. Map-based intent preview, especially grenade/splash and queued-order overlays.
3. Resolve spectacle plus visible model damage.
4. Objective-driven battle maps tied to the planned RTS/zone-control layer.

The first two would make the current slice easier and more satisfying to play immediately. The fourth is the biggest design leap, but it should guide future tactical-map and scenario work.
