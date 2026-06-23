# Improvement cycle report — cycle-002

**Goals met: 2 / 14**  ·  vitest: green  ·  console errors: 0

> 👁️ Awaiting visual review: G1-main-menu, G2-deploy-screen, G4-canvas-painted, G5-deploy-cost, G7-combat-damage, G8-victory, G9-move-range-ring, G10-ground-blast-preview, G11-build-placement-ring, G12-objective-hud, G13-dead-part-visible, G14-end-return-menu

| | Goal | Logical | Visual |
|---|---|---|---|
| 👁️  | **G1-main-menu** Main menu renders with title and Start Game | pass: mainMenu=true startButton=true | present / _pending_ — `01-main-menu.png` |
| 👁️  | **G2-deploy-screen** Deploy screen offers maps, a live preview, modes and difficulty | pass: maps=6 modes=3 diffs=3 preview=true | present / _pending_ — `02-deploy-screen.png` |
| ✅ | **G3-start-empty** Battle starts in command phase, turn 1, with no units fielded | pass: phase=command turn=1 field=0/0 | — |
| 👁️  | **G4-canvas-painted** The 3D battlefield actually renders (canvas is painted) | pass: canvas lit=576 | present / _pending_ — `03-battle-start.png` |
| 👁️  | **G5-deploy-cost** Deploying a Recruit adds a field unit and spends money + the base CP | pass: fieldDelta=1 moneyDelta=-150 baseCpAfter=0 spawned=true | present / _pending_ — `05-deploy-unit.png` |
| ✅ | **G6-research-unlock** Researching a doctrine unlocks it on the base | pass: unlocked=["assault"] | — |
| 👁️  | **G7-combat-damage** A resolved attack reduces an enemy part's health | pass: enemyHpDelta=-20 damageEntries=0 | present / _pending_ — `09-resolve.png` |
| 👁️  | **G8-victory** Eliminating the enemy transitions to a victory end-state with a reward | pass: phase=victory reward=110 | present / _pending_ — `12-victory.png` |
| 👁️  | **G9-move-range-ring** Selecting Move shows the unit's movement-range ring | pass: actionRange={"kind":"move","radius":6.7} | present / _pending_ — `07-move-range.png` |
| 👁️  | **G10-ground-blast-preview** Explosive ground-aim previews a blast-radius the unit can reach | pass: groundAim={"radius":2.55,"reachable":true,"blocked":false} | present / _pending_ — `08-ground-aim.png` |
| 👁️  | **G11-build-placement-ring** Building a defense shows a placement-range ring near the base | pass: buildPlacement={"radius":11.7,"center":{"x":-20,"z":0}} | present / _pending_ — `11-build-placement.png` |
| 👁️  | **G12-objective-hud** The HUD shows the current objective and the turn number | pass: modeChip=true turnIndicator=true | present / _pending_ — `03-battle-start.png` |
| 👁️  | **G13-dead-part-visible** A destroyed enemy part is shown at 0 HP, not hidden | pass: hadDestroyedPart=true destroyedPartListed=true | present / _pending_ — `10-detail-destroyed.png` |
| 👁️  | **G14-end-return-menu** The end screen lets the player return to the main menu | pass: endReturnControl=true | present / _pending_ — `12-victory.png` |

## Remaining gaps
- **G1-main-menu** — needs visual review of 01-main-menu.png (look for: ROGUE HEROES title logo and a prominent Start Game button on a clean menu background)
- **G2-deploy-screen** — needs visual review of 02-deploy-screen.png (look for: a list of battlefields, a top-down map PREVIEW image, mode cards, and difficulty cards)
- **G4-canvas-painted** — needs visual review of 03-battle-start.png (look for: a 3D battlefield with terrain, the player base, and the HUD command bar — not a black frame)
- **G5-deploy-cost** — needs visual review of 05-deploy-unit.png (look for: a newly deployed infantry unit standing next to the player Home Base)
- **G7-combat-damage** — needs visual review of 09-resolve.png (look for: projectiles in flight and/or impact effects between units during the resolve phase)
- **G8-victory** — needs visual review of 12-victory.png (look for: a Victory end screen overlaying the battlefield)
- **G9-move-range-ring** — needs visual review of 07-move-range.png (look for: a cyan circular movement-range ring drawn on the ground around the selected unit)
- **G10-ground-blast-preview** — needs visual review of 08-ground-aim.png (look for: a blast-radius ring drawn at a ground spot for an explosive unit's targeting, with the arc/landing marker)
- **G11-build-placement-ring** — needs visual review of 11-build-placement.png (look for: a green placement-range ring around the Home Base while a turret/wall is being placed)
- **G12-objective-hud** — needs visual review of 03-battle-start.png (look for: an objective/mode chip and a visible turn/round indicator in the HUD)
- **G13-dead-part-visible** — needs visual review of 10-detail-destroyed.png (look for: the inspected enemy's parts list still listing the destroyed part, shown at 0 / empty health)
- **G14-end-return-menu** — needs visual review of 12-victory.png (look for: a control on the victory screen that returns to the main menu (e.g. a Main Menu / Continue button))

## ⏳ 12 goal(s) remaining — continue the loop.