# Improvement cycle report — cycle-001

**Goals met: 9 / 14**  ·  vitest: green  ·  console errors: 0

| | Goal | Logical | Visual |
|---|---|---|---|
| ✅ | **G1-main-menu** Main menu renders with title and Start Game | pass: mainMenu=true startButton=true | present / ok — `01-main-menu.png` |
| ✅ | **G2-deploy-screen** Deploy screen offers maps, a live preview, modes and difficulty | pass: maps=6 modes=3 diffs=3 preview=true | present / ok — `02-deploy-screen.png` |
| ✅ | **G3-start-empty** Battle starts in command phase, turn 1, with no units fielded | pass: phase=command turn=1 field=0/0 | — |
| ✅ | **G4-canvas-painted** The 3D battlefield actually renders (canvas is painted) | pass: canvas lit=576 | present / ok — `03-battle-start.png` |
| ❌ | **G5-deploy-cost** Deploying a Recruit adds a field unit and spends money + the base CP | pass: fieldDelta=1 moneyDelta=-150 baseCpAfter=0 spawned=true | present / **no** — `05-deploy-unit.png` |
| ✅ | **G6-research-unlock** Researching a doctrine unlocks it on the base | pass: unlocked=["assault"] | — |
| ❌ | **G7-combat-damage** A resolved attack reduces an enemy part's health | pass: enemyHpDelta=-30 damageEntries=0 | present / **no** — `09-resolve.png` |
| ✅ | **G8-victory** Eliminating the enemy transitions to a victory end-state with a reward | pass: phase=victory reward=110 | present / ok — `12-victory.png` |
| ✅ | **G9-move-range-ring** Selecting Move shows the unit's movement-range ring | pass: actionRange={"kind":"move","radius":6.7} | present / ok — `07-move-range.png` |
| ❌ | **G10-ground-blast-preview** Explosive ground-aim previews a blast-radius the unit can reach | pass: groundAim={"radius":2.55,"reachable":true,"blocked":false} | present / **no** — `08-ground-aim.png` |
| ✅ | **G11-build-placement-ring** Building a defense shows a placement-range ring near the base | pass: buildPlacement={"radius":11.7,"center":{"x":-20,"z":0}} | present / ok — `11-build-placement.png` |
| ❌ | **G12-objective-hud** The HUD shows the current objective and the turn number | pass: modeChip=true turnIndicator=true | present / **no** — `03-battle-start.png` |
| ❌ | **G13-dead-part-visible** A destroyed enemy part is shown at 0 HP, not hidden | **fail**: hadDestroyedPart=true destroyedPartListed=false | present / **no** — `10-detail-destroyed.png` |
| ✅ | **G14-end-return-menu** The end screen lets the player return to the main menu | pass: endReturnControl=true | present / ok — `12-victory.png` |

## Remaining gaps
- **G5-deploy-cost** — visual rejected: Deployed Recruit is hidden behind the auto-opened base command deck; no clean view of the unit next to the base. Capture must frame it with the deck closed.
- **G7-combat-damage** — visual rejected: No projectile streak or impact effect visible in the resolve frame — capture caught a quiet frame; combatants also appear far apart. Improve capture timing and/or projectile visibility.
- **G10-ground-blast-preview** — visual rejected: Only the grenade throw-range circle is visible; no distinct blast-radius ring + arc/landing marker at the aimed ground spot. Needs a clearer blast preview and a sensible hover point.
- **G12-objective-hud** — visual rejected: At battle start the base deck is auto-open and covers the HUD; the objective/mode chip and turn indicator are not cleanly visible. Capture a deselected, unobstructed battle-start frame.
- **G13-dead-part-visible** — logic: hadDestroyedPart=true destroyedPartListed=false; visual rejected: Inspect-detail does not list the destroyed enemy part at all (destroyedPartListed=false) — matches the known gap; must show it at 0 HP.

## ⏳ 5 goal(s) remaining — continue the loop.