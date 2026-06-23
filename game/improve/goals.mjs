// ============================================================================
//  OBJECTIVE GOALS for the self-improvement loop
// ----------------------------------------------------------------------------
//  A finite, terminating set of goals. The loop stops when every goal is MET.
//
//  Each goal is verified by TWO independent signals:
//    * logical  — a pure assertion over the captured play-through trace
//                 (state.json) and the vitest run summary. Auto-evaluated by
//                 check-goals.mjs. This is the "values/state are correct" signal.
//    * visual   — a named screenshot from the capture flow PLUS a human-readable
//                 criterion ("lookFor"). check-goals auto-confirms the shot
//                 EXISTS and is non-blank; an agent reviewer confirms it SHOWS
//                 the intended thing and records the verdict in the cycle's
//                 visual-verdicts.json. This is the "screenshots are the source
//                 of truth" signal.
//
//  A goal counts as MET only when logical.pass AND visual.present AND
//  visual.semantic(verdict) are all true for the cycle being evaluated.
//
//  `logical(ctx)` receives:
//    ctx.step(name)  -> the trace step object captured under that step name
//    ctx.trace       -> the full ordered array of step objects
//    ctx.vitest      -> { ok, passed[], failed[] } summary of `vitest run`
//  and returns { pass: boolean, detail: string }.
// ============================================================================

/** Safe lookup of a captured step; never throws so a missing step => clean fail. */
function need(ctx, name) {
  const s = ctx.step(name);
  if (!s) return null;
  return s;
}

export const GOALS = [
  // ---- Flow / regression guards (protect the working game) ------------------
  {
    id: "G1-main-menu",
    title: "Main menu renders with title and Start Game",
    category: "both",
    rationale: "The entry screen must always present a clear way into the game.",
    visual: { shot: "01-main-menu.png", lookFor: "ROGUE HEROES title logo and a prominent Start Game button on a clean menu background" },
    logical: (ctx) => {
      const s = need(ctx, "01-main-menu");
      if (!s) return { pass: false, detail: "no main-menu step captured" };
      const ok = s.dom?.mainMenu === true && s.dom?.startButton === true;
      return { pass: ok, detail: `mainMenu=${s.dom?.mainMenu} startButton=${s.dom?.startButton}` };
    },
  },
  {
    id: "G2-deploy-screen",
    title: "Deploy screen offers maps, a live preview, modes and difficulty",
    category: "both",
    rationale: "Players choose battlefield + mode + difficulty before deploying; each needs a visible preview.",
    visual: { shot: "02-deploy-screen.png", lookFor: "a list of battlefields, a top-down map PREVIEW image, mode cards, and difficulty cards" },
    logical: (ctx) => {
      const s = need(ctx, "02-deploy-screen");
      if (!s) return { pass: false, detail: "no deploy step captured" };
      const d = s.dom ?? {};
      const ok = d.maps >= 3 && d.modes >= 3 && d.diffs >= 3 && d.preview === true;
      return { pass: ok, detail: `maps=${d.maps} modes=${d.modes} diffs=${d.diffs} preview=${d.preview}` };
    },
  },
  {
    id: "G3-start-empty",
    title: "Battle starts in command phase, turn 1, with no units fielded",
    category: "logical",
    rationale: "Per the scenario design, both sides open with only a Home Base and must deploy from turn one.",
    logical: (ctx) => {
      const s = need(ctx, "03-battle-start");
      if (!s) return { pass: false, detail: "no battle-start step captured" };
      const ok = s.phase === "command" && s.turn === 1 && s.field?.player === 0 && s.field?.enemy === 0;
      return { pass: ok, detail: `phase=${s.phase} turn=${s.turn} field=${s.field?.player}/${s.field?.enemy}` };
    },
  },
  {
    id: "G4-canvas-painted",
    title: "The 3D battlefield actually renders (canvas is painted)",
    category: "both",
    rationale: "A black/blank canvas means the renderer or WebGL context is broken.",
    visual: { shot: "03-battle-start.png", lookFor: "a 3D battlefield with terrain, the player base, and the HUD command bar — not a black frame" },
    logical: (ctx) => {
      const s = need(ctx, "03-battle-start");
      if (!s) return { pass: false, detail: "no battle-start step captured" };
      return { pass: s.canvas?.ok === true, detail: `canvas lit=${s.canvas?.lit}` };
    },
  },
  {
    id: "G5-deploy-cost",
    title: "Deploying a Recruit adds a field unit and spends money + the base CP",
    category: "both",
    rationale: "Core economy contract: a deployment costs money and a command point and puts a unit on the field.",
    visual: { shot: "05-deploy-unit.png", lookFor: "a newly deployed infantry unit standing next to the player Home Base" },
    logical: (ctx) => {
      const s = need(ctx, "05-deploy-unit");
      if (!s) return { pass: false, detail: "no deploy-unit step captured" };
      const p = s.probe ?? {};
      const ok = p.fieldDelta === 1 && p.moneyDelta < 0 && p.baseCpAfter === 0 && p.spawned === true;
      return { pass: ok, detail: `fieldDelta=${p.fieldDelta} moneyDelta=${p.moneyDelta} baseCpAfter=${p.baseCpAfter} spawned=${p.spawned}` };
    },
  },
  {
    id: "G6-research-unlock",
    title: "Researching a doctrine unlocks it on the base",
    category: "logical",
    rationale: "The tech tree gates unit variety; research must persist on the base.",
    logical: (ctx) => {
      const s = need(ctx, "06-research");
      if (!s) return { pass: false, detail: "no research step captured" };
      const ok = Array.isArray(s.probe?.unlocked) && s.probe.unlocked.includes("assault");
      return { pass: ok, detail: `unlocked=${JSON.stringify(s.probe?.unlocked)}` };
    },
  },
  {
    id: "G7-combat-damage",
    title: "A resolved attack reduces an enemy part's health",
    category: "both",
    rationale: "Combat must actually apply per-part damage during the resolve phase.",
    visual: { shot: "09-resolve.png", lookFor: "projectiles in flight and/or impact effects between units during the resolve phase" },
    logical: (ctx) => {
      const s = need(ctx, "10-post-resolve");
      if (!s) return { pass: false, detail: "no post-resolve step captured" };
      const p = s.probe ?? {};
      const ok = p.enemyHpDelta < 0 || p.damageEntries > 0;
      return { pass: ok, detail: `enemyHpDelta=${p.enemyHpDelta} damageEntries=${p.damageEntries}` };
    },
  },
  {
    id: "G8-victory",
    title: "Eliminating the enemy transitions to a victory end-state with a reward",
    category: "both",
    rationale: "The win condition must fire and grant progression points.",
    visual: { shot: "12-victory.png", lookFor: "a Victory end screen overlaying the battlefield" },
    logical: (ctx) => {
      const s = need(ctx, "12-victory");
      if (!s) return { pass: false, detail: "no victory step captured" };
      const ok = s.phase === "victory" && (s.probe?.reward ?? 0) > 0;
      return { pass: ok, detail: `phase=${s.phase} reward=${s.probe?.reward}` };
    },
  },

  // ---- Enhancement goals (battlefield readability — from improve.md) ---------
  {
    id: "G9-move-range-ring",
    title: "Selecting Move shows the unit's movement-range ring",
    category: "both",
    rationale: "improve.md: show a movement-range circle when Move is selected (like the grenade indicator) so reach is obvious.",
    visual: { shot: "07-move-range.png", lookFor: "a cyan circular movement-range ring drawn on the ground around the selected unit" },
    logical: (ctx) => {
      const s = need(ctx, "07-move-range");
      if (!s) return { pass: false, detail: "no move-range step captured" };
      const r = s.probe?.actionRange;
      const ok = r && r.kind === "move" && r.radius > 0;
      return { pass: ok, detail: `actionRange=${JSON.stringify(r)}` };
    },
  },
  {
    id: "G10-ground-blast-preview",
    title: "Explosive ground-aim previews a blast-radius the unit can reach",
    category: "both",
    rationale: "improve.md: explosive projectiles can target a ground spot and must show the blast-radius circle for that spot.",
    visual: { shot: "08-ground-aim.png", lookFor: "a blast-radius ring drawn at a ground spot for an explosive unit's targeting, with the arc/landing marker" },
    logical: (ctx) => {
      const s = need(ctx, "08-ground-aim");
      if (!s) return { pass: false, detail: "no ground-aim step captured" };
      const g = s.probe?.groundAim;
      const ok = g && g.radius > 0 && g.reachable === true;
      return { pass: ok, detail: `groundAim=${JSON.stringify(g)}` };
    },
  },
  {
    id: "G11-build-placement-ring",
    title: "Building a defense shows a placement-range ring near the base",
    category: "both",
    rationale: "improve.md: turrets/walls can only be placed near the base — show a placement-range circle.",
    visual: { shot: "11-build-placement.png", lookFor: "a green placement-range ring around the Home Base while a turret/wall is being placed" },
    logical: (ctx) => {
      const s = need(ctx, "11-build-placement");
      if (!s) return { pass: false, detail: "no build-placement step captured" };
      const b = s.probe?.buildPlacement;
      const ok = b && b.radius > 0;
      return { pass: ok, detail: `buildPlacement=${JSON.stringify(b)}` };
    },
  },
  {
    id: "G12-objective-hud",
    title: "The HUD shows the current objective and the turn number",
    category: "both",
    rationale: "Players need the mode/objective and which turn it is visible at a glance.",
    visual: { shot: "03-battle-start.png", lookFor: "an objective/mode chip and a visible turn/round indicator in the HUD" },
    logical: (ctx) => {
      const s = need(ctx, "03-battle-start");
      if (!s) return { pass: false, detail: "no battle-start step captured" };
      const ok = s.dom?.modeChip === true && s.dom?.turnIndicator === true;
      return { pass: ok, detail: `modeChip=${s.dom?.modeChip} turnIndicator=${s.dom?.turnIndicator}` };
    },
  },
  {
    id: "G13-dead-part-visible",
    title: "A destroyed enemy part is shown at 0 HP, not hidden",
    category: "both",
    rationale: "improve.md: when an enemy part is destroyed, show it at 0 health instead of hiding it on click.",
    visual: { shot: "10-detail-destroyed.png", lookFor: "the inspected enemy's parts list still listing the destroyed part, shown at 0 / empty health" },
    logical: (ctx) => {
      const s = need(ctx, "10-detail-destroyed");
      if (!s) return { pass: false, detail: "no detail-destroyed step captured" };
      const p = s.probe ?? {};
      const ok = p.hadDestroyedPart === true && p.destroyedPartListed === true;
      return { pass: ok, detail: `hadDestroyedPart=${p.hadDestroyedPart} destroyedPartListed=${p.destroyedPartListed}` };
    },
  },
  {
    id: "G14-end-return-menu",
    title: "The end screen lets the player return to the main menu",
    category: "both",
    rationale: "improve.md: on the end screen, ensure players can return to the main menu.",
    visual: { shot: "12-victory.png", lookFor: "a control on the victory screen that returns to the main menu (e.g. a Main Menu / Continue button)" },
    logical: (ctx) => {
      const s = need(ctx, "12-victory");
      if (!s) return { pass: false, detail: "no victory step captured" };
      return { pass: s.dom?.endReturnControl === true, detail: `endReturnControl=${s.dom?.endReturnControl}` };
    },
  },

  // ---- Batch UX requests ----------------------------------------------------
  {
    id: "G15-menu-clean",
    title: "Main menu is uncluttered: no points badge, no how-to-play text",
    category: "both",
    rationale: "User: only show points in the Armory, and drop the 'Build a base economy' / controls hints from the main screen.",
    visual: { shot: "01-main-menu.png", lookFor: "a clean title screen with just the logo and menu buttons — NO points badge and NO bullet-list of hints/instructions — over a richer animated background" },
    logical: (ctx) => {
      const s = need(ctx, "01-main-menu");
      if (!s) return { pass: false, detail: "no main-menu step captured" };
      const ok = s.dom?.pointsBadge === false && s.dom?.hints === false;
      return { pass: ok, detail: `pointsBadge=${s.dom?.pointsBadge} hints=${s.dom?.hints}` };
    },
  },
  {
    id: "G16-build-deck-ducks",
    title: "Placing a defense ducks the command deck to a slim placement bar",
    category: "both",
    rationale: "User: when placing a turret the unit-pick menu should duck out of the way so you can click the ground.",
    visual: { shot: "11-build-placement.png", lookFor: "the big base command deck collapsed to a slim 'Placing …' bar so the green placement ring on the field is unobstructed" },
    logical: (ctx) => {
      const s = need(ctx, "11-build-placement");
      if (!s) return { pass: false, detail: "no build-placement step captured" };
      const ok = s.dom?.placementBar === true && s.dom?.deckDucked === true;
      return { pass: ok, detail: `placementBar=${s.dom?.placementBar} deckDucked=${s.dom?.deckDucked}` };
    },
  },
  {
    id: "G17-action-pace-setting",
    title: "Settings offers an action-pace control (slow / default / fast)",
    category: "both",
    rationale: "User: add a setting to slow down or speed up the action phase pace.",
    visual: { shot: "01b-settings.png", lookFor: "an 'Action speed' row in Settings with Slow / Default / Fast choices" },
    logical: (ctx) => {
      const s = need(ctx, "01b-settings");
      if (!s) return { pass: false, detail: "no settings step captured" };
      return { pass: (s.dom?.paceChips ?? 0) === 3, detail: `paceChips=${s.dom?.paceChips}` };
    },
  },

  // ---- Visual polish pass ---------------------------------------------------
  {
    id: "G18-unit-glyphs",
    title: "Each unit type is identifiable at a glance via an overhead role glyph",
    category: "both",
    rationale: "User: differentiate each unit from one another more — heavy vs marksman, APC vs tank read alike from the camera.",
    visual: { shot: "11b-unit-roster.png", lookFor: "every unit carries a distinct floating type tag (e.g. RFL / RCN / MRK / HVY / GRN / MTR / TNK / ART) colored by role, so the types are instantly distinguishable" },
    logical: (ctx) => {
      const s = need(ctx, "11b-unit-roster");
      if (!s) return { pass: false, detail: "no roster step captured" };
      // A varied roster is fielded so the per-kind glyphs can be reviewed; the glyphs
      // themselves (sprites) are confirmed visually.
      const kinds = s.probe?.kinds?.length ?? 0;
      return { pass: kinds >= 6, detail: `distinctKinds=${kinds} (${(s.probe?.kinds ?? []).join(",")})` };
    },
  },
  {
    id: "G19-prop-tint",
    title: "Cover props are tinted toward the map's palette so they fit the scene",
    category: "both",
    rationale: "User: apply polish so objects fit more in the map they are in (no generic brown crates on every map).",
    visual: { shot: "03-battle-start.png", lookFor: "the crates/sandbags/props on the field share the map's colour cast (tinted toward the ground/accent palette) rather than looking like generic out-of-place brown boxes" },
    logical: (ctx) => {
      const s = need(ctx, "11b-unit-roster");
      if (!s) return { pass: false, detail: "no roster step captured" };
      return { pass: (s.probe?.coverCount ?? 0) > 0, detail: `coverProps=${s.probe?.coverCount}` };
    },
  },

  // ---- Debug / scenario harness --------------------------------------------
  {
    id: "G20-debug-scenarios",
    title: "A debug scenario system can cut straight to staged battle states",
    category: "both",
    rationale: "User: the game needs a debug system so automated tests can cut to scenarios and screenshot them.",
    visual: { shot: "13-scenario-siege.png", lookFor: "an instantly-staged 'siege' battle — an enemy base fortified with walls/turrets and a player armor+siege column — reached with a single window.__rht.scenario('siege') call" },
    logical: (ctx) => {
      const s = need(ctx, "13-scenario-siege");
      if (!s) return { pass: false, detail: "no scenario step captured" };
      const p = s.probe ?? {};
      const ok = p.ok === true && (p.count ?? 0) >= 6 && (p.enemyWalls ?? 0) > 0 && p.playerTank === true;
      return { pass: ok, detail: `scenarios=${p.count} ok=${p.ok} map=${p.map} enemyWalls=${p.enemyWalls} playerTank=${p.playerTank}` };
    },
  },
];

// The vitest test titles the logic layer must keep green for the loop to trust the run.
// (Soft gate: surfaced in the report; individual goals above rely on the captured trace.)
export const REQUIRED_VITEST = [
  "loop goals",
];

export default GOALS;
