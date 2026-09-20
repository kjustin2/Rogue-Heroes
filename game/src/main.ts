import "./style.css";
// Self-hosted fonts (no CDN — the packaged Electron app must work offline).
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/900.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";

import { dist, type Vec2 } from "./core/math";
import { Stage } from "./render/stage";
import { WorldRenderer, type WorldRenderDebug } from "./render/worldRenderer";
import { preloadAll as preloadModels, loadedTemplates, modelsVersion, setModelSkin } from "./render/models";
import { FeelDirector } from "./render/feel";
import { POI_WEIGHT, ResolveDirector } from "./render/resolveDirector";
import { Hud } from "./ui/hud";
import {
  TacticalSim,
  MAPS,
  MODES,
  DIFFICULTIES,
  mapDef,
  mapSize,
  modeDef,
  difficultyLabel,
  type Intent,
  type ModeId,
  type TroopKind,
  type DefenseKind,
  type Difficulty,
  type MapDef,
  type SupportPowerKind,
  FACTIONS,
  type FactionId,
} from "./game/sim";
import type { AimMode, Team } from "./game/damageModel";
import { isInfantryKind } from "./game/damageModel";
import { TECH_TREE, troopsUnlockedBy } from "./game/tech";
import { troopSpec, unitStats } from "./game/units";
import { sfx } from "./audio";
import { music } from "./music";
import { progression, COSMETICS, COSMETIC_CATEGORIES, type Cosmetic } from "./progression";
import { battleReward } from "./progression";
import { campaign, CAMPAIGN_TITLE, CAMPAIGN_SYNOPSIS, rankFor, rankHpBonus, rankInsignia, type CampaignMission, type RosterMember } from "./campaign";
import { run, RUN_LENGTH } from "./run";
import { commander, MEDALS } from "./commander";
import { settings, ACTION_PACES, PACE_LABEL, RENDER_SCALES, RENDER_SCALE_LABEL, RENDER_SCALE_DPR, DEFAULT_KEYBINDS, KEYBIND_LABELS, keyDisplay, type ActionPace, type RenderScale, type BindableAction } from "./settings";
import { applyScenario, scenarioInfo } from "./game/scenarios";
import { ARENA_BOUNDS } from "./game/terrain";
import { PerfMonitor, type PerfSnapshot, type RenderInfo } from "./render/perfMonitor";
import { auditUI, type UiFinding } from "./debug/uiAudit";
import { DebugOverlay } from "./debug/debugOverlay";
import {
  runDiagnostics,
  describeScene,
  type DiagnosticsReport,
  type SceneDescription,
  type ScreenProjector,
} from "./debug/diagnostics";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
const ui = document.getElementById("ui");

if (!canvas || !ui) throw new Error("Missing game canvas or UI root");
const uiRoot = ui;

// Total doctrine-mastery stars needed to unlock the Winter skin pack — a slow, earned cosmetic
// (respecting the "meta unlocks slow" bar) instead of a free toggle.
const WINTER_SKIN_MASTERY = 3;

const stage = new Stage(canvas);
// ?lowfx=1 forces the composer-free performance path — headless SwiftShader (smokes,
// perf bench) stalls on the HalfFloat bloom chain; real GPUs get the graded stack.
const LOWFX = new URLSearchParams(location.search).has("lowfx");
// Silence audio under automation so background test runs never blare music. navigator.webdriver
// is set by Playwright/Puppeteer in every headless smoke/screenshot run, so this mutes them all
// with zero per-script changes; ?mute is a manual override. Runs before any sound can start
// (audio only unlocks on a later pointer gesture), and music shares sfx's master gain, so pinning
// sfx muted silences both layers.
const AUTOMATED = navigator.webdriver === true || new URLSearchParams(location.search).has("mute");
stage.setQuality(LOWFX ? "performance" : settings.renderScale);
// ?debug unlocks the Debug section in Settings (infinite money, free cooldowns). Launch the game
// with ?debug in the URL, or the packaged app with --debug / RHT_DEBUG=1. See the README.
const DEBUG_UNLOCKED = new URLSearchParams(location.search).has("debug");
stage.setPixelRatioCap(RENDER_SCALE_DPR[settings.renderScale]);
preloadModels(); // kick GLB loads immediately; renderer swaps them in as they arrive
setModelSkin(settings.unitSkin);
const sim = new TacticalSim();
const world = new WorldRenderer(stage.scene);
// Points the camera at the best moment of each resolve. Presentation only -- it reads outcomes and
// chooses where to look; it never touches the sim's state or its rng.
const resolveCam = new ResolveDirector();
// Which units were alive at the top of the frame, so a death can be spotted as a transition.
const aliveLastFrame = new Set<string>();
// Where the director wants to look this frame, handed to syncCameraAssist.
let resolveFocus: Vec2 | undefined;
world.setPlayerAccent(progression.accentColor());
const feel = new FeelDirector(stage);
feel.setReducedMotion(settings.reducedMotion);
stage.setReducedMotion(settings.reducedMotion);
world.setHighContrastTeams(settings.highContrastTeams);
sfx.setMuted(settings.muted || AUTOMATED);
sfx.setVolume(settings.volume);
music.setVolume(settings.musicVolume);

// --- Debug/perf harness wiring (drives window.__rht.perf/diagnostics/overlay) ---
const perfMon = new PerfMonitor();
// Mount on <body>, NOT #ui — the HUD rewrites #ui's innerHTML every update, which would
// wipe out a canvas parented there. position:fixed keeps it pinned over the game canvas.
const debugOverlay = new DebugOverlay(document.body);
// World point -> screen pixel projector shared by diagnostics, describeScene, and the overlay.
const projectToScreen: ScreenProjector = (point, height) => stage.projectToScreen(point, height);

/** Read the live THREE renderer counters into a plain, serializable snapshot. */
function readRenderInfo(): RenderInfo {
  const info = stage.renderer.info;
  return {
    calls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? 0,
  };
}

/** Total live objects in the scene graph — a coarse leak signal for the perf harness. */
function countSceneObjects(): number {
  let n = 0;
  stage.scene.traverse(() => { n += 1; });
  return n;
}

/** Structured, projected readout of the current scene for the overlay + AI inspector. */
function buildSceneDescription(): SceneDescription {
  return describeScene(sim, {
    project: projectToScreen,
    selectedId: sim.selectedId,
    targetedId: hud.focusedTargetId ?? hud.hoveredTargetId,
  });
}

/** Run the anomaly scan against the current sim + perf state. */
function runSceneDiagnostics(): DiagnosticsReport {
  return runDiagnostics(sim, {
    bounds: ARENA_BOUNDS,
    project: projectToScreen,
    perf: perfSnapshot(),
    // Floor kept low so it flags genuinely frozen/broken rendering anywhere without false
    // positives from the slow headless (SwiftShader) GPU the capture harness runs on.
    fpsFloor: 12,
  });
}

/** A perf snapshot that also refreshes the renderer counters + scene-object count. */
function perfSnapshot(): PerfSnapshot {
  perfMon.setRenderInfo(readRenderInfo(), countSceneObjects());
  return perfMon.snapshot();
}

const SAVE_KEY = "rht.savedBattle.v1";

let tutorialActive = false;
// The campaign mission the current battle belongs to (undefined for skirmish/tutorial). Drives
// whether a victory advances the campaign ladder and shows the story overlay.
let activeCampaignMission: CampaignMission | undefined;
let inBattle = false; // true between starting/loading a battle and it ending or being left
// Mirrored onto <body class="in-battle"> so the HUD can be hidden behind the title diorama in CSS.
function setInBattle(on: boolean): void {
  inBattle = on;
  document.body.classList.toggle("in-battle", on);
}
let hoverWorld: Vec2 | undefined;
let lastEndPhase: "victory" | "defeat" | undefined;

// Persist an in-progress battle so closing the app or quitting to the menu never loses it.
// Tutorials are throwaway and finished battles aren't resumable, so neither is saved.
function autosaveIfActive(): void {
  if (inBattle && !tutorialActive && (sim.phase === "command" || sim.phase === "resolve")) {
    safeStorageSet(SAVE_KEY, sim.serialize());
  }
}
// pagehide fires on app/tab close (more reliable than beforeunload); the localStorage write
// is synchronous so it completes before the page unloads.
window.addEventListener("pagehide", autosaveIfActive);

const hud = new Hud(uiRoot, sim, {
  setIntent: (intent: Intent) => sim.setIntent(intent),
  endTurn: () => {
    if (sim.phase === "command") sfx.turn();
    resolveCam.begin(stage.viewState()); sim.endTurn();
  },
  reset: () => {
    sim.reset();
    world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
    focusOnPlayerBase();
    lastEndPhase = undefined;
  },
  select: (id: string) => {
    sim.select(id);
    const entity = sim.entity(id);
    // Only recenter if the unit is genuinely off-screen or hidden behind a panel; don't snap
    // when it is already comfortably in view.
    if (entity && !stage.isInView(entity.position)) stage.focusOn(entity.position);
  },
  deselect: () => sim.deselect(),
  queueMove: (destination) => sim.queueMove(destination),
  queueMoveToCover: (id: string) => sim.queueMoveToCover(id),
  queueTakeCover: (id: string) => sim.queueTakeCover(id),
  queueClimbCover: (id: string) => sim.queueClimbCover(id),
  queueCapture: (id: string) => {
    const ok = sim.queueCapture(id);
    if (ok) sfx.select();
    return ok;
  },
  queueShootPart: (id: string, partId: string) => sim.queueShootPart(id, partId),
  queueGrenadePart: (id: string, partId: string) => sim.queueGrenadePart(id, partId),
  queueGrenadeAt: (destination) => sim.queueGrenadeAt(destination),
  queueSmokeAt: (destination) => sim.queueSmokeAt(destination),
  queueBombDrop: () => sim.queueBombDrop(),
  queueLoad: (passengerId: string) => sim.queueLoad(passengerId),
  queueUnload: (destination) => sim.queueUnload(destination),
  queueRam: (id: string) => sim.queueRam(id),
  queueMelee: (id: string) => sim.queueMelee(id),
  queueMeleePart: (id: string, partId: string) => sim.queueMeleePart(id, partId),
  queueDefend: (stance) => sim.queueDefend(stance),
  queueSpawnTroop: (kind) => {
    const ok = sim.queueSpawnTroop(kind);
    if (ok) sfx.deploy();
    return ok;
  },
  upgradeBaseIncome: () => sim.upgradeBaseIncome(),
  upgradeBaseCommand: () => sim.upgradeBaseCommand(),
  beginBuild: (kind: DefenseKind) => {
    sim.setPendingBuild(kind);
    sfx.ui();
  },
  cancelBuild: () => sim.setPendingBuild(undefined),
  queueBuildStructure: (point) => {
    const ok = sim.queueBuildStructure(point);
    if (ok) sfx.build();
    return ok;
  },
  queueOverwatch: () => {
    const ok = sim.queueOverwatch();
    if (ok) sfx.select();
    return ok;
  },
  queueOverwatchToward: (point) => {
    const ok = sim.queueOverwatchToward(point);
    if (ok) sfx.select();
    return ok;
  },
  queueRecon: () => {
    const ok = sim.queueRecon();
    if (ok) sfx.select();
    return ok;
  },
  queueDeploy: () => {
    const ok = sim.queueDeploy();
    if (ok) sfx.select();
    return ok;
  },
  queueMine: () => {
    const ok = sim.queueMine();
    if (ok) sfx.build();
    return ok;
  },
  beginSupport: (kind) => {
    sim.setPendingSupport(kind);
    sfx.ui();
  },
  cancelSupport: () => sim.setPendingSupport(undefined),
  queueSupportAt: (point) => {
    const ok = sim.queueSupportAt(point);
    if (ok) {
      sfx.turn();
      showToast("Strike inbound — resolves at end of turn");
    }
    return ok;
  },
  queueShootAt: (point) => sim.queueShootAt(point),
  researchTech: (nodeId) => {
    const ok = sim.researchTech(nodeId);
    if (ok) {
      // Reveal flourish: declassify the doctrine's units by name the moment it lands.
      const revealed = troopsUnlockedBy(nodeId).map((kind) => troopSpec(kind).label);
      const decrypted = TECH_TREE.filter((n) => n.tier === 4 && n.requires.includes(nodeId)).length;
      if (revealed.length) {
        showToast(`Declassified: ${revealed.join(" + ")} now deployable`);
        sfx.deploy();
      } else if (decrypted) {
        showToast("R&D files decrypted — check the tech deck");
      }
      // Doctrine mastery: lifetime research counters with tier-up toasts.
      const before = commander.masteryTier(nodeId);
      commander.recordResearch(nodeId);
      const after = commander.masteryTier(nodeId);
      if (after > before) {
        const node = TECH_TREE.find((n) => n.id === nodeId);
        showToast(`Doctrine mastery ${"I".repeat(after)} — ${node?.name ?? nodeId} (lifetime)`);
      }
    }
    return ok;
  },
  cancelOrder: (id: string) => sim.cancelOrder(id),
  explainGrenadeTarget: (id: string) => sim.explainGrenadeTarget(id),
  explainRamTarget: (id: string) => sim.explainRamTarget(id),
  explainMeleeTarget: (id: string) => sim.explainMeleeTarget(id),
  openMenu: () => openPauseMenu(),
  returnToMainMenu: () => showMainMenu(),
  editUnit: (id: string) => openEditOverlay(id),
});

let orbitingPointerId: number | undefined;
let orbitLastX = 0;
let orbitLastY = 0;

canvas.addEventListener("pointerdown", (event) => {
  sfx.unlock();
  if (event.button === 1) {
    event.preventDefault();
    orbitingPointerId = event.pointerId;
    orbitLastX = event.clientX;
    orbitLastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  if (anyOverlayOpen()) return;
  const pick = stage.pick(event.clientX, event.clientY, world.pickables);
  if (pick) {
    if (pick.pickupId) {
      inspectPickup(pick.pickupId);
      return;
    }
    const entity = sim.entity(pick.entityId);
    if (!entity) return;
    hud.chooseBoardEntity(entity.id);
    hud.update();
    return;
  }

  hud.chooseGround(stage.screenToWorld(event.clientX, event.clientY));
  hud.update();
});

canvas.addEventListener("pointermove", (event) => {
  if (orbitingPointerId === event.pointerId) {
    event.preventDefault();
    const deltaX = event.clientX - orbitLastX;
    const deltaY = event.clientY - orbitLastY;
    orbitLastX = event.clientX;
    orbitLastY = event.clientY;
    stage.orbitBy(deltaX * 0.008, -deltaY * 0.005);
    return;
  }
  // Track the ground point under the cursor so we can preview a grenade/shell landing spot.
  hoverWorld = stage.screenToWorld(event.clientX, event.clientY);
});

const stopOrbit = (event: PointerEvent): void => {
  if (orbitingPointerId !== event.pointerId) return;
  orbitingPointerId = undefined;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
};

canvas.addEventListener("pointerup", stopOrbit);
canvas.addEventListener("pointercancel", stopOrbit);
canvas.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});

// A click anywhere in the HUD plays a soft UI blip (the deploy/build/turn cues layer on top).
uiRoot.addEventListener("pointerdown", (event) => {
  sfx.unlock();
  const el = event.target as HTMLElement;
  if (el.closest("button, .menu-card, [data-select], [data-part]")) sfx.ui();
});

const heldKeys = new Set<string>();
let lastCommandCameraKey = "";

function clickArmedConfirm(): boolean {
  const button = uiRoot.querySelector<HTMLElement>("[data-confirm][data-disabled='false']");
  if (!button) return false;
  button.click();
  return true;
}

window.addEventListener("wheel", (event) => {
  if (shouldLetUiScroll(event)) return;
  event.preventDefault();
  resolveCam.playerTookControl(); // manual camera input wins over direction
  stage.zoomBy(event.deltaY > 0 ? 0.08 : -0.08);
}, { passive: false });

function shouldLetUiScroll(event: WheelEvent): boolean {
  // Any open full-screen menu/overlay scrolls instead of zooming the world.
  if (anyOverlayOpen()) return true;
  // Walk up from the element under the cursor and find ANY actually-scrollable ancestor (by its
  // computed overflow + real overflow content), rather than a hardcoded class list that misses new
  // scroll containers like the tech-tree tab. If the cursor is over a scrollable menu, the wheel
  // scrolls that menu (chaining to a parent scroller that can still move); it never zooms the world
  // out from under a menu the player is reading — even at the menu's scroll boundary.
  let node: HTMLElement | null = event.target instanceof HTMLElement ? event.target : null;
  let overScrollable = false;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) {
      overScrollable = true;
      if (event.deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
      if (event.deltaY < 0 && node.scrollTop > 0) return true;
    }
    node = node.parentElement;
  }
  return overScrollable;
}

window.addEventListener("keydown", (event) => {
  // When any overlay/menu is open, only Escape (to step back) is handled.
  if (anyOverlayOpen()) {
    if (event.code === "Escape") {
      event.preventDefault();
      dismissTopOverlay();
    }
    return;
  }
  if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
    event.preventDefault();
    heldKeys.add(event.code);
    return;
  }
  if (event.repeat) return;
  // Digits, Escape, and R are fixed; everything else routes through the rebindable map.
  const digit = /^Digit([1-6])$/.exec(event.code);
  if (digit) {
    hud.activateActionSlot(Number(digit[1]));
    return;
  }
  if (event.code === "Escape") {
    event.preventDefault();
    if (!hud.handleEscape()) openPauseMenu();
    return;
  }
  if (event.code === "KeyR") {
    hud.resetGame();
    return;
  }
  const bound = (Object.entries(settings.keybinds) as [BindableAction, string][]).find(([, code]) => code === event.code)?.[0];
  if (!bound) return;
  switch (bound) {
    case "endTurn":
      event.preventDefault();
      if (sim.phase === "command") sfx.turn();
      resolveCam.begin(stage.viewState()); sim.endTurn();
      break;
    case "cycle":
      event.preventDefault();
      sim.cyclePlayer(event.shiftKey ? -1 : 1);
      if (sim.selected) stage.focusOn(sim.selected.position);
      hud.update();
      break;
    case "move": hud.setAction("move"); break;
    case "shoot": hud.setAction("shoot"); break;
    case "grenade": hud.setAction("grenade"); break;
    case "ram": hud.setAction("ram"); break;
    case "defend": hud.setAction("defend"); break;
    case "melee": hud.setAction("melee"); break;
    case "overwatch": hud.setAction("overwatch"); break;
    case "crouch":
      if (sim.queueDefend("crouched")) hud.setAction("select");
      break;
    case "log": hud.toggleLog(); break;
    case "confirm":
      event.preventDefault();
      clickArmedConfirm();
      break;
  }
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.code);
});

function focusOnPlayerBase(): void {
  const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
  if (base) stage.focusOn(base.position);
  else if (sim.selected) stage.focusOn(sim.selected.position);
}

// Configure and theme the battle for a chosen map + mode + difficulty, then frame the base.
// Pick the AI's faction from the map id and the player's choice. Deterministic by construction --
// a cheap string hash, no RNG -- and it never mirrors the player, so a matchup is always a matchup.
function opposingFaction(mapId: string, player: FactionId): FactionId {
  const others = FACTIONS.filter((f) => f.id !== player);
  let hash = 0;
  for (let i = 0; i < mapId.length; i += 1) hash = (hash * 31 + mapId.charCodeAt(i)) >>> 0;
  return others[hash % others.length].id;
}

function startBattle(mapId: string, modeId: ModeId, difficulty: Difficulty = settings.difficulty, faction: FactionId = settings.faction): void {
  tutorialActive = false;
  renderTutorialPanel(); // a tutorial panel must not survive into the next battle
  activeCampaignMission = undefined;
  campaign.setActive(undefined); // a skirmish is not a campaign mission
  closeAllMenus();
  // The enemy's faction is DERIVED, never rolled: same map plus same player faction always gives
  // the same opponent, so a seeded run, a save reload and a replay all agree. Rolling it inside
  // the sim would put hidden nondeterminism in a system the chaos and determinism tests rely on.
  sim.configure(mapDef(mapId), modeId, difficulty, { player: faction, enemy: opposingFaction(mapId, faction) });
  world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
  world.setPlayerAccent(progression.accentColor());
  focusOnPlayerBase();
  lastEndPhase = undefined;
  setInBattle(true);
  hud.update();
}

// Configure a campaign mission battle and remember which mission it is (so victory advances the
// ladder and a save can resume it). Mirrors startBattle but tags the active mission.
function startCampaignMission(mission: CampaignMission): void {
  tutorialActive = false;
  activeCampaignMission = mission;
  campaign.setActive(mission.id);
  closeAllMenus();
  sim.configure(mapDef(mission.map), mission.mode, mission.difficulty, { player: settings.faction, enemy: opposingFaction(mission.map, settings.faction) });

  // Requisition perk banked on the last victory screen.
  const perk = campaign.consumeRequisition();
  if (perk === "cash") {
    sim.economy.set("player", (sim.economy.get("player") ?? 0) + 200);
    showToast("Requisition delivered: +$200 starting funds");
  } else if (perk === "doctrine") {
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    if (base && !(base.unlockedTech ?? []).includes("recon")) {
      base.unlockedTech = [...(base.unlockedTech ?? []), "recon"];
      showToast("Requisition delivered: Recon Doctrine pre-researched");
    }
  }

  // The veteran roster deploys free, named, ranked, and tougher — and dies for good.
  deployRoster(campaign.roster);

  // Finale set piece: the named Warden, tracked by the top-of-screen HP bar.
  if (mission.boss) {
    sim.debugSpawn(mission.boss.kind as TroopKind, "enemy", { x: mission.boss.x, z: mission.boss.z }, { bossName: mission.boss.name });
  }
  firedBeats.clear();

  world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
  world.setPlayerAccent(progression.accentColor());
  focusOnPlayerBase();
  lastEndPhase = undefined;
  setInBattle(true);
  hud.update();
  runMissionIntro();
}

// Deploy a carried veteran roster at the player base: free, named, ranked, tougher, permadeath.
// Shared by campaign missions and skirmish-run sectors.
function deployRoster(roster: readonly RosterMember[]): void {
  const playerBase = sim.entities.find((e) => e.kind === "base" && e.team === "player");
  if (!playerBase || !roster.length) return;
  roster.forEach((member, index) => {
    const angle = -0.8 + index * 0.5;
    const spot = {
      x: playerBase.position.x + Math.sin(angle + Math.PI / 2) * 3.4,
      z: playerBase.position.z + Math.cos(angle + Math.PI / 2) * 3.4,
    };
    const unit = sim.debugSpawn(member.kind as TroopKind, "player", spot);
    const rank = rankFor(member.kills);
    unit.name = `${member.name} ${rankInsignia(rank)}`.trim();
    const bonus = rankHpBonus(rank);
    if (bonus > 1) for (const part of unit.parts) { part.maxHp = Math.round(part.maxHp * bonus); part.hp = part.maxHp; }
  });
  showToast(`${roster.length} veteran${roster.length > 1 ? "s" : ""} deployed with you`);
}

// The player units that walked away, as roster-merge input (star suffixes stripped so a
// veteran's name stays stable across battles). Air and armor carry forward like infantry.
function collectSurvivors(): Array<{ name: string; kind: string; kills: number }> {
  const carriable = ["tank", "apc", "artillery", "gunship", "interceptor", "bomber", "transport", "flak"];
  return sim.entities
    .filter((e) => e.team === "player" && e.status.alive && (isInfantryKind(e.kind) || carriable.includes(e.kind)))
    .map((e) => ({ name: e.name.replace(/ ★+$/, ""), kind: e.kind, kills: sim.killsBy.get(e.id) ?? 0 }));
}

// Configure and launch the current sector of an active skirmish run. Mirrors startCampaignMission
// (roster carry + a starting-funds bonus) minus the story/boss scaffolding.
function startRunBattle(): void {
  tutorialActive = false;
  activeCampaignMission = undefined;
  campaign.setActive(undefined);
  closeAllMenus();
  const battle = run.current();
  sim.configure(mapDef(battle.map), battle.mode, battle.difficulty, { player: settings.faction, enemy: opposingFaction(battle.map, settings.faction) });

  const cash = run.consumeCash();
  if (cash > 0) {
    sim.economy.set("player", (sim.economy.get("player") ?? 0) + cash);
    showToast(`Salvage banked: +$${cash} starting funds`);
  }
  deployRoster(run.roster);
  firedBeats.clear();

  world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
  world.setPlayerAccent(progression.accentColor());
  focusOnPlayerBase();
  lastEndPhase = undefined;
  setInBattle(true);
  hud.update();
  showToast(`Sector ${run.sectorNumber} of ${RUN_LENGTH} · ${mapDef(battle.map).name} · ${modeDef(battle.mode).name}`);
}

// Mission-intro cinematic: a letterboxed rail flyover — enemy lines, the contested centre, then
// home — skippable with a click. Pure camera work; the sim is untouched.
//
// It is a RAIL, not a chain of camera guides: the first version handed three `guideTo`s to the
// exponential follow-cam, which whipped 70m across the board in about a second each time — at
// that speed every frame is a different view and the whole thing read as flashing. Now the
// camera starts ON the first beat (behind a black fade), each leg is an eased tween at a rate
// the eye can follow, and the HUD, hints and toasts stay hidden until the rail hands the
// planning camera back.
let introActive = false;
function runMissionIntro(): void {
  if (settings.reducedMotion) return;
  const enemyBase = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
  const playerBase = sim.entities.find((e) => e.kind === "base" && e.team === "player");
  if (!enemyBase || !playerBase) return;
  const beats: { focus: Vec2; zoom: number; hold: number; travel: number; caption: string }[] = [
    { focus: enemyBase.position, zoom: 0.76, hold: 1800, travel: 0, caption: "Enemy lines" },
    { focus: sim.modeState.hill ?? midpoint(enemyBase.position, playerBase.position), zoom: 0.95, hold: 1100, travel: 3000, caption: "The contested ground" },
    { focus: playerBase.position, zoom: 0.8, hold: 1200, travel: 3000, caption: "Home" },
  ];
  const overlay = document.createElement("div");
  overlay.className = "mission-intro";
  overlay.innerHTML = `<div class="mission-intro__caption"></div><button class="mission-intro__skip" type="button">Skip ▸</button>`;
  document.body.appendChild(overlay);
  document.body.classList.add("killcam", "intro-cam");
  const caption = overlay.querySelector<HTMLElement>(".mission-intro__caption")!;
  introActive = true;
  let raf = 0;
  const pitch = 0.62;
  const yaw = stage.viewState().yaw;
  const finish = (): void => {
    if (!introActive) return;
    introActive = false;
    window.cancelAnimationFrame(raf);
    document.body.classList.remove("killcam", "intro-cam");
    overlay.remove();
    focusOnPlayerBase();
  };
  overlay.addEventListener("click", finish);
  // Start on the first beat before the fade lifts, so there is no cut from the base.
  stage.debugSetView({ x: beats[0].focus.x, z: beats[0].focus.z, zoom: beats[0].zoom, pitch, yaw });
  requestAnimationFrame(() => overlay.classList.add("show"));
  const ease = (t: number): number => t * t * (3 - 2 * t);
  const t0 = performance.now();
  // Timeline: [hold0][travel1][hold1][travel2][hold2]
  const marks: { at: number; from: number; to: number; kind: "hold" | "travel" }[] = [];
  let cursor = 0;
  beats.forEach((b, i) => {
    if (b.travel > 0) { marks.push({ at: cursor, from: i - 1, to: i, kind: "travel" }); cursor += b.travel; }
    marks.push({ at: cursor, from: i, to: i, kind: "hold" }); cursor += b.hold;
  });
  const total = cursor;
  let shownCaption = "";
  const tick = (): void => {
    if (!introActive) return;
    const now = performance.now() - t0;
    if (now >= total) { finish(); return; }
    let seg = marks[0];
    for (const m of marks) if (now >= m.at) seg = m;
    const a = beats[seg.from], b = beats[seg.to];
    const span = seg.kind === "travel" ? b.travel : a.hold;
    const u = ease(Math.min(1, (now - seg.at) / Math.max(1, span)));
    let x: number, z: number, zoom: number;
    if (seg.kind === "travel") {
      x = a.focus.x + (b.focus.x - a.focus.x) * u;
      z = a.focus.z + (b.focus.z - a.focus.z) * u;
      // Pull back a touch mid-travel so the pan reads as a flight, not a slide.
      zoom = a.zoom + (b.zoom - a.zoom) * u + Math.sin(u * Math.PI) * 0.12;
    } else {
      // The opening hold is a STILL — the owner wants the main image first, then the movement.
      // Later holds get a slow push-in so the shot is never dead.
      x = a.focus.x; z = a.focus.z;
      zoom = seg.from === 0 ? a.zoom : a.zoom + 0.06 - 0.06 * u;
    }
    stage.debugSetView({ x, z, zoom, pitch, yaw });
    if (b.caption !== shownCaption && seg.kind === "hold") { shownCaption = b.caption; caption.textContent = b.caption; caption.classList.remove("show"); void caption.offsetWidth; caption.classList.add("show"); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// Radio-drama beats: one-shot transmissions on their keyed turns during campaign battles.
const firedBeats = new Set<string>();
function watchCampaignBeats(): void {
  const mission = activeCampaignMission;
  if (!mission?.beats || sim.phase !== "command") return;
  for (const beat of mission.beats) {
    const key = `${mission.id}:${beat.turn}`;
    if (beat.turn === sim.turn && !firedBeats.has(key)) {
      firedBeats.add(key);
      showToast(`📻 ${beat.text}`);
      sfx.ui();
    }
  }
}

// Deploy with a brief full-screen loading veil. startBattle() rebuilds the whole arena
// (geometry + materials) synchronously, so without this the click just freezes for a beat.
// We paint the veil first (two rAFs let it reach the screen), then run the heavy build under
// it, then fade it once the battle has had a frame to render. Min visible time avoids a flash.
function deployWithLoadingScreen(mapId: string, modeId: ModeId, difficulty: Difficulty, faction: FactionId, mission?: CampaignMission): void {
  const veil = document.createElement("div");
  veil.className = "battle-loading";
  veil.innerHTML = `<div class="battle-loading__inner">
    <div class="battle-loading__spinner"></div>
    <div class="battle-loading__label"><span>Deploying to</span><strong>${escapeAttr(mapDef(mapId).name)}</strong></div>
  </div>`;
  document.body.appendChild(veil);
  requestAnimationFrame(() => veil.classList.add("show"));
  const startedAt = performance.now();
  const minVisible = settings.reducedMotion ? 250 : 600;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (mission) {
      startCampaignMission(mission);
    } else {
      startBattle(mapId, modeId, difficulty, faction);
      // First time the player tries a mode, spell out how it's won (the tutorial only covers Annihilation).
      const mode = modeDef(modeId);
      hintOnce(`mode-${modeId}`, `${mode.name} — ${mode.blurb}`);
    }
    const hold = Math.max(0, minVisible - (performance.now() - startedAt));
    window.setTimeout(() => {
      veil.classList.add("leaving");
      window.setTimeout(() => veil.remove(), 360);
    }, hold);
  }));
}

// ---------------------------------------------------------------------------
// Menu, overlay, and helper UI
// ---------------------------------------------------------------------------

function anyOverlayOpen(): boolean {
  return Boolean(document.querySelector(".menu-screen:not(.is-leaving), .pause-overlay, .edit-overlay"));
}

// When one menu replaces another we skip the incoming screen's fade-in. Otherwise it
// animates up from fully transparent for half a second, briefly revealing the live 3D
// battlefield behind the translucent menu — the "flash to a map" between screens. The very
// first menu shown after page load still fades in for a polished entrance.
let skipNextMenuEntrance = false;

function closeAllMenus(): void {
  for (const el of document.querySelectorAll(".menu-screen, .pause-overlay, .edit-overlay")) {
    if (el.classList.contains("menu-screen")) skipNextMenuEntrance = true;
    el.remove();
  }
  // Hide the persistent radar backdrop. show*() re-adds this synchronously before paint
  // when swapping menus, so the radar only stops when we leave menus for gameplay.
  document.body.classList.remove("menus-open");
  stage.setLowCost(false);
  // Only the diorama's drifting low view gets reset -- closing the pause menu mid-battle must
  // leave the player's camera exactly where they put it.
  if (stage.menuDrift) stage.resetView();
  syncHudInert();
}

/**
 * The battle HUD is unreachable (pointer + keyboard) exactly while a menu screen covers it.
 * Derived from the DOM rather than tracked with a flag, because menus close down several paths --
 * closeAllMenus, dismissTopOverlay, a screen removing itself -- and a stale flag here would leave
 * the whole HUD inert with nothing on top of it.
 */
function syncHudInert(): void {
  const hud = document.getElementById("ui");
  if (!hud) return;
  // A pause / edit overlay covers the HUD just as a full menu does: Tab must not walk under it.
  const covered = Boolean(document.querySelector(".menu-screen:not(.is-leaving), .pause-overlay, .edit-overlay"));
  if (covered) hud.setAttribute("inert", "");
  else hud.removeAttribute("inert");
}

// Overlays are removed from a dozen click handlers (Resume, Back, Apply ...) that never call
// syncHudInert; with pause/edit overlays now covering the HUD, a stale inert flag would leave the
// HUD dead after Resume. Re-derive it from the DOM whenever a top-level screen comes or goes.
new MutationObserver(() => syncHudInert()).observe(document.body, { childList: true });

function dismissTopOverlay(): void {
  const overlays = [...document.querySelectorAll<HTMLElement>(".menu-screen:not(.is-leaving), .pause-overlay, .edit-overlay")];
  const top = overlays[overlays.length - 1];
  if (!top) return;
  // The root landing menu cannot be escaped away.
  if (top.classList.contains("main-menu")) return;
  const closer = top.querySelector<HTMLElement>("[data-overlay-close]");
  if (closer) closer.click();
  else top.remove();
  syncHudInert();
}

/**
 * THE TITLE DIORAMA. The main menu used to sit over an empty default arena, blurred and buried
 * under a dark gradient -- a brown nothing. It sits over the game now: a real map with a squad and
 * an enemy patrol standing in it, idling, under a camera that drifts slowly around them. Every
 * entry point to the main menu comes through showMainMenu, and the in-memory battle it replaces
 * has already been autosaved (Continue restores from storage), so nothing is lost by it.
 */
function stageMenuDiorama(): void {
  sim.configure(mapDef("verdant"), "destroy", "normal");
  const squad: [TroopKind, number, number][] = [["soldier", -3.2, 1.4], ["heavy", -4.4, -0.6], ["striker", -5.6, 2.2], ["jumper", -2.4, -1.6], ["tank", -7.2, 0.4]];
  for (const [kind, x, z] of squad) {
    const u = sim.debugSpawn(kind, "player", { x, z });
    u.yaw = Math.PI * 0.5 + (x + z) * 0.05;
  }
  const patrol: [TroopKind, number, number][] = [["striker", 7.5, -1.2], ["soldier", 8.8, 1.6], ["apc", 11, 0]];
  for (const [kind, x, z] of patrol) {
    const u = sim.debugSpawn(kind, "enemy", { x, z });
    u.yaw = -Math.PI * 0.5;
  }
  sim.select("");
  world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
  world.setPlayerAccent(progression.accentColor());
  stage.debugSetView({ x: 0.5, z: 0.4, zoom: 0.62, pitch: 0.42, yaw: 0.6 });
  stage.menuDrift = true;
}

function mountScreen(html: string, className: string): HTMLDivElement {
  const screen = document.createElement("div");
  screen.className = className;
  if (className.includes("menu-screen")) {
    if (skipNextMenuEntrance) screen.classList.add("menu-screen--instant");
    skipNextMenuEntrance = false;
    document.body.classList.add("menus-open"); // reveal the persistent radar backdrop
    stage.setLowCost(true); // lean post chain + shadows off while menus cover the field
  }
  screen.innerHTML = html;
  document.body.appendChild(screen);
  // AFTER the append: syncHudInert reads the DOM, so calling it while the screen is still detached
  // would find no menu and clear the flag it is here to set. The battle HUD stays mounted
  // underneath a menu, and marking it inert stops Tab from walking into buttons nobody can see.
  syncHudInert();
  return screen;
}

// A scaled top-down SVG preview of a battlefield: terrain blocks, bases, the central zone.
function mapPreviewSvg(map: MapDef): string {
  const b = map.terrain.bounds;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const W = 360;
  const H = Math.round((W * d) / w);
  const sx = (x: number): number => ((x - b.minX) / w) * W;
  const sy = (z: number): number => ((z - b.minZ) / d) * H;
  const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
  const blocks = (map.terrain.blocks ?? [])
    .map((blk) => {
      const op = Math.min(0.85, 0.28 + blk.height * 0.32);
      return `<rect x="${sx(blk.minX).toFixed(1)}" y="${sy(blk.minZ).toFixed(1)}" width="${(sx(blk.maxX) - sx(blk.minX)).toFixed(1)}" height="${(sy(blk.maxZ) - sy(blk.minZ)).toFixed(1)}" rx="3" fill="${hex(map.theme.groundAccent)}" opacity="${op.toFixed(2)}" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>`;
    })
    .join("");
  const hill = `<circle cx="${sx(map.hill.x).toFixed(1)}" cy="${sy(map.hill.z).toFixed(1)}" r="${((map.hillRadius / w) * W).toFixed(1)}" fill="none" stroke="#ffe08a" stroke-width="2" stroke-dasharray="5 4" opacity="0.8"/>`;
  const player = `<g><circle cx="${sx(map.playerBase.x).toFixed(1)}" cy="${sy(map.playerBase.z).toFixed(1)}" r="9" fill="#6fd7ff"/><text x="${sx(map.playerBase.x).toFixed(1)}" y="${(sy(map.playerBase.z) + 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#03121a" font-weight="700">P</text></g>`;
  const enemy = `<g><circle cx="${sx(map.enemyBase.x).toFixed(1)}" cy="${sy(map.enemyBase.z).toFixed(1)}" r="9" fill="#ff7c5e"/><text x="${sx(map.enemyBase.x).toFixed(1)}" y="${(sy(map.enemyBase.z) + 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#1a0603" font-weight="700">E</text></g>`;
  return `<svg class="map-preview-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeAttr(map.name)} preview">
    <rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="${hex(map.theme.ground)}"/>
    ${blocks}${hill}${player}${enemy}
  </svg>`;
}

function pointsBadge(): string {
  return `<div class="menu-points" data-tip="Earned by playing battles. Spend them in the Armory on cosmetics."><span>★</span> ${progression.points} pts</div>`;
}

function showMainMenu(): void {
  autosaveIfActive(); // quitting a battle to the menu preserves it for Continue
  setInBattle(false);
  closeAllMenus();
  stageMenuDiorama();
  const hasSave = Boolean(safeStorageGet(SAVE_KEY));
  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content main-menu__content">
      <h1 class="title-logo">ROGUE HEROES<span>TACTICS</span></h1>
      <!-- ONE primary action, three ways to play, and the utilities demoted to a quiet row. Eight
           stacked buttons of equal weight told a new player nothing about where to start. -->
      <div class="main-menu__buttons" data-allow-overlap>
        ${hasSave
          ? `<button class="title-start" data-menu="continue" type="button">Continue Battle</button>`
          : `<button class="title-start" data-menu="campaign" type="button">Play Campaign</button>`}
        <div class="menu-modes">
          ${hasSave ? `<button class="menu-mode" data-menu="campaign" type="button"><strong>Campaign</strong><span>Story missions</span></button>` : ""}
          <button class="menu-mode" data-menu="play" type="button"><strong>Skirmish</strong><span>One battle, your rules</span></button>
          <button class="menu-mode" data-menu="run" type="button"><strong>Skirmish Run</strong><span>${run.active ? `Sector ${run.sectorNumber}/${RUN_LENGTH} in progress` : "Survive a chain of sectors"}</span></button>
        </div>
        <button class="menu-link" data-menu="tutorial" type="button">Play the tutorial</button>
        <div class="menu-utilities">
          <button class="menu-utility" data-menu="armory" type="button">Armory</button>
          <button class="menu-utility" data-menu="settings" type="button">Settings</button>
          <button class="menu-utility menu-utility--exit" data-menu="exit" type="button">Exit</button>
        </div>
      </div>
    </div>
  `,
    "menu-screen main-menu",
  );

  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-menu]")?.dataset.menu;
    if (action === "campaign") showCampaign();
    else if (action === "run") showRunIntro();
    else if (action === "play") showStartScreen();
    else if (action === "continue") loadSavedBattle();
    else if (action === "tutorial") startTutorial();
    else if (action === "armory") showArmory();
    else if (action === "settings") showSettings();
    else if (action === "exit") window.close(); // Electron: closes window → app.quit(); no-op in a browser tab
  });
}

function showStartScreen(): void {
  closeAllMenus();
  let selectedMap = MAPS[0].id;
  let selectedMode: ModeId = "destroy";
  let selectedDifficulty: Difficulty = settings.difficulty;
  let selectedFaction: FactionId = settings.faction;

  const mapList = MAPS.map(
    (m) => `<button class="menu-card map-card ${m.id === selectedMap ? "selected" : ""}" data-map="${m.id}" type="button">
      <strong>${m.name}<em class="map-size-badge size-${mapSize(m)}">${mapSize(m)}</em></strong>
      <span>${m.feel}</span>
    </button>`,
  ).join("");
  // Mode and difficulty are CHIP rows with one blurb line for the picked one: five blurb cards
  // pushed Faction and Difficulty below the fold at 720p, which is how "the faction pick seems
  // hidden behind Deploy" was reported. Every choice on this page fits one screen now.
  const modeChips = MODES.map(
    (mode) => `<button class="menu-chip ${mode.id === selectedMode ? "on" : ""}" data-mode="${mode.id}" type="button">${mode.name}</button>`,
  ).join("");
  // Each card states the faction's IDENTITY and, explicitly, what it gives up. A roster is defined
  // as much by its hole as by its depth, and a player choosing blind cannot see the hole.
  const factionCards = FACTIONS.map(
    (f) => `<button class="menu-card faction-card ${f.id === selectedFaction ? "selected" : ""}" data-faction="${f.id}" data-tip="${escapeAttr(f.detail)}" type="button">
      <strong><span class="faction-pip" style="background:#${f.accent.toString(16).padStart(6, "0")}"></span>${escapeAttr(f.name)}</strong>
      <span>${escapeAttr(f.blurb)}</span>
      <em class="faction-roster">${f.roster.length} troops &middot; ${f.defenses.length} defenses &middot; ${f.supports.length} support strikes</em>
    </button>`,
  ).join("");
  const diffChips = DIFFICULTIES.map(
    (d) => `<button class="menu-chip ${d === selectedDifficulty ? "on" : ""}" data-diff="${d}" type="button">${difficultyLabel(d)}</button>`,
  ).join("");

  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content">
      <div class="menu-head">
        <button class="menu-back" data-overlay-close data-back type="button">&lsaquo; Back</button>
        <h2 class="menu-heading">Skirmish</h2>
      </div>
      <div class="start-layout">
        <div class="start-left">
          <div class="menu-section">
            <div class="menu-label">Map</div>
            <div class="map-list">${mapList}</div>
          </div>
          <div class="menu-section">
            <div class="menu-label">Preview</div>
            <div class="map-preview" data-preview></div>
          </div>
        </div>
        <div class="start-right">
          <div class="menu-section start-factions">
            <div class="menu-label">Faction</div>
            <div class="menu-grid faction-grid">${factionCards}</div>
          </div>
          <div class="menu-section">
            <div class="menu-label">Mode</div>
            <div class="chip-row">${modeChips}</div>
            <p class="choice-blurb" data-mode-blurb>${escapeHtml(modeDef(selectedMode).blurb)}</p>
          </div>
          <div class="menu-section">
            <div class="menu-label">Difficulty</div>
            <div class="chip-row">${diffChips}</div>
            <p class="choice-blurb" data-diff-blurb>${escapeHtml(difficultyBlurb(selectedDifficulty))}</p>
          </div>
        </div>
      </div>
      <div class="menu-actions"><button class="title-start" data-start type="button">Deploy to Battle</button></div>
    </div>
  `,
    "menu-screen title-screen",
  );

  const previewHost = screen.querySelector<HTMLElement>("[data-preview]");
  const renderPreview = (): void => {
    if (previewHost) previewHost.innerHTML = mapPreviewSvg(mapDef(selectedMap));
  };
  renderPreview();

  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-back]")) {
      showMainMenu();
      return;
    }
    const factionBtn = target.closest<HTMLElement>("[data-faction]");
    if (factionBtn) {
      selectedFaction = (factionBtn.dataset.faction as FactionId) ?? selectedFaction;
      settings.faction = selectedFaction; // remembered for next time, like difficulty
      settings.save();
      for (const card of screen.querySelectorAll<HTMLElement>("[data-faction]")) {
        card.classList.toggle("selected", card.dataset.faction === selectedFaction);
      }
      return;
    }
    const mapBtn = target.closest<HTMLElement>("[data-map]");
    if (mapBtn) {
      selectedMap = mapBtn.dataset.map ?? selectedMap;
      for (const el of screen.querySelectorAll(".map-card")) el.classList.toggle("selected", el === mapBtn);
      renderPreview();
      return;
    }
    const modeBtn = target.closest<HTMLElement>("[data-mode]");
    if (modeBtn) {
      selectedMode = (modeBtn.dataset.mode as ModeId) ?? selectedMode;
      for (const el of screen.querySelectorAll("[data-mode]")) el.classList.toggle("on", el === modeBtn);
      const blurb = screen.querySelector("[data-mode-blurb]");
      if (blurb) blurb.textContent = modeDef(selectedMode).blurb;
      return;
    }
    const diffBtn = target.closest<HTMLElement>("[data-diff]");
    if (diffBtn) {
      selectedDifficulty = (diffBtn.dataset.diff as Difficulty) ?? selectedDifficulty;
      for (const el of screen.querySelectorAll("[data-diff]")) el.classList.toggle("on", el === diffBtn);
      const blurb = screen.querySelector("[data-diff-blurb]");
      if (blurb) blurb.textContent = difficultyBlurb(selectedDifficulty);
      return;
    }
    if (target.closest("[data-start]")) {
      if (screen.classList.contains("is-leaving")) return;
      settings.difficulty = selectedDifficulty;
      settings.save();
      screen.classList.add("is-leaving"); // startBattle's closeAllMenus removes it
      deployWithLoadingScreen(selectedMap, selectedMode, selectedDifficulty, selectedFaction);
    }
  });
}

function difficultyBlurb(d: Difficulty): string {
  if (d === "easy") return "Weaker enemy. Learn the ropes.";
  if (d === "hard") return "Tougher enemy that hits harder and earns faster.";
  return "An even fight.";
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
}

// Keep the Settings fullscreen toggle in sync when the user enters/leaves via F11 or Esc.
document.addEventListener("fullscreenchange", () => {
  const btn = document.querySelector<HTMLElement>('[data-set="fullscreen"]');
  if (!btn) return;
  const on = !!document.fullscreenElement;
  btn.classList.toggle("on", on);
  btn.textContent = on ? "On" : "Off";
});

function showSettings(): void {
  closeAllMenus();
  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content overlay-card">
      <div class="menu-head">
        <button class="menu-back" data-overlay-close data-back type="button">&lsaquo; Back</button>
        <h2 class="menu-heading">Settings</h2>
      </div>
      <div class="settings-row">
        <label>Fullscreen</label>
        <button class="menu-toggle ${document.fullscreenElement ? "on" : ""}" data-set="fullscreen" type="button">${document.fullscreenElement ? "On" : "Off"}</button>
      </div>
      <div class="settings-row">
        <label>Graphics quality</label>
        <div class="settings-choices">
          ${RENDER_SCALES.map((r) => `<button class="menu-chip ${settings.renderScale === r ? "on" : ""}" data-set="scale" data-value="${r}" type="button">${RENDER_SCALE_LABEL[r]}</button>`).join("")}
        </div>
      </div>
      <div class="settings-row">
        <label>Sound</label>
        <button class="menu-toggle ${settings.muted ? "" : "on"}" data-set="mute" type="button">${settings.muted ? "Muted" : "On"}</button>
      </div>
      <div class="settings-row">
        <label>Volume</label>
        <input type="range" min="0" max="100" value="${Math.round(settings.volume * 100)}" data-set="volume" />
      </div>
      <div class="settings-row">
        <label>Music</label>
        <input type="range" min="0" max="100" value="${Math.round(settings.musicVolume * 100)}" data-set="musicVolume" />
      </div>
      <div class="settings-row">
        <label data-tip="How fast queued orders play out when the turn resolves.">Action speed</label>
        <div class="settings-choices">
          ${ACTION_PACES.map((p) => `<button class="menu-chip ${settings.actionPace === p ? "on" : ""}" data-set="pace" data-value="${p}" type="button">${PACE_LABEL[p]}</button>`).join("")}
        </div>
      </div>
      <div class="settings-row">
        <label>Reduced motion</label>
        <button class="menu-toggle ${settings.reducedMotion ? "on" : ""}" data-set="motion" type="button">${settings.reducedMotion ? "On" : "Off"}</button>
      </div>
      <div class="settings-row">
        <label>Vehicle skin</label>
        ${commander.totalMastery() >= WINTER_SKIN_MASTERY
          ? `<button class="menu-toggle ${settings.unitSkin === "winter" ? "on" : ""}" data-set="skin" type="button" data-tip="Arctic camo for vehicles and structures. Cosmetic only.">${settings.unitSkin === "winter" ? "Winter" : "Standard"}</button>`
          : `<button class="menu-toggle locked" data-set="skin" type="button" data-tip="Winter camo unlocks at ${WINTER_SKIN_MASTERY} doctrine-mastery stars. Research doctrines in battle to earn them.">🔒 ${commander.totalMastery()}/${WINTER_SKIN_MASTERY}</button>`}
      </div>
      <div class="settings-row">
        <label>High-contrast teams</label>
        <button class="menu-toggle ${settings.highContrastTeams ? "on" : ""}" data-set="teams" type="button" data-tip="Colorblind-safe palette: your side blue, enemy orange.">${settings.highContrastTeams ? "On" : "Off"}</button>
      </div>
      ${DEBUG_UNLOCKED ? `
      <div class="settings-row settings-row--head"><label>Debug</label></div>
      <div class="settings-row">
        <label>Infinite money</label>
        <button class="menu-toggle ${settings.debugInfiniteMoney ? "on" : ""}" data-set="debug-money" type="button" data-tip="Keeps your treasury topped up every command phase.">${settings.debugInfiniteMoney ? "On" : "Off"}</button>
      </div>
      <div class="settings-row">
        <label>No deploy cooldowns</label>
        <button class="menu-toggle ${settings.debugFreeCooldown ? "on" : ""}" data-set="debug-cd" type="button" data-tip="Zeroes deploy cooldowns so you can reinforce instantly.">${settings.debugFreeCooldown ? "On" : "Off"}</button>
      </div>` : ""}
      <div class="settings-row settings-row--head"><label>Controls</label><button class="menu-toggle" data-set="binds-reset" type="button" data-tip="Restore every key to its default.">Reset keys</button></div>
      ${(Object.keys(KEYBIND_LABELS) as BindableAction[]).map((action) => `
        <div class="settings-row settings-row--bind">
          <label>${escapeHtml(KEYBIND_LABELS[action])}</label>
          <button class="menu-toggle bind-key" data-rebind="${action}" type="button" data-tip="Click, then press the new key.">${escapeHtml(keyDisplay(settings.keybinds[action]))}</button>
        </div>`).join("")}
      <p class="settings-note">Settings save automatically.</p>
    </div>
  `,
    "menu-screen",
  );

  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-back]")) {
      // Opened from the pause menu mid-battle: Back is back to the pause menu, never to the
      // title (which would quit the battle the player only meant to tweak the volume in).
      if (inBattle) { screen.remove(); openPauseMenu(); } else showMainMenu();
      return;
    }
    const set = target.closest<HTMLElement>("[data-set]")?.dataset.set;
    if (set === "fullscreen") {
      toggleFullscreen();
      return; // label refreshes via the fullscreenchange listener
    }
    if (set === "mute") {
      settings.muted = !settings.muted;
      sfx.setMuted(settings.muted || AUTOMATED);
    } else if (set === "scale") {
      const value = target.closest<HTMLElement>("[data-value]")?.dataset.value as RenderScale | undefined;
      if (value) {
        settings.renderScale = value;
        stage.setPixelRatioCap(RENDER_SCALE_DPR[value]);
        if (!LOWFX) stage.setQuality(value);
      }
    } else if (set === "diff") {
      const value = target.closest<HTMLElement>("[data-value]")?.dataset.value as Difficulty | undefined;
      if (value) settings.difficulty = value;
    } else if (set === "pace") {
      const value = target.closest<HTMLElement>("[data-value]")?.dataset.value as ActionPace | undefined;
      if (value) settings.actionPace = value;
    } else if (set === "motion") {
      settings.reducedMotion = !settings.reducedMotion;
      document.body.classList.toggle("reduced-motion", settings.reducedMotion);
      feel.setReducedMotion(settings.reducedMotion);
      stage.setReducedMotion(settings.reducedMotion);
    } else if (set === "teams") {
      settings.highContrastTeams = !settings.highContrastTeams;
      world.setHighContrastTeams(settings.highContrastTeams);
    } else if (set === "skin") {
      if (commander.totalMastery() < WINTER_SKIN_MASTERY) {
        showToast(`Winter skin unlocks at ${WINTER_SKIN_MASTERY} doctrine-mastery stars — keep researching doctrines`);
      } else {
        settings.unitSkin = settings.unitSkin === "winter" ? "" : "winter";
        setModelSkin(settings.unitSkin);
      }
    } else if (set === "debug-money") {
      settings.debugInfiniteMoney = !settings.debugInfiniteMoney;
      if (settings.debugInfiniteMoney && inBattle) sim.debugGrant("player", 999999);
    } else if (set === "debug-cd") {
      settings.debugFreeCooldown = !settings.debugFreeCooldown;
    } else if (set === "binds-reset") {
      settings.keybinds = { ...DEFAULT_KEYBINDS };
    }
    // Rebind flow: arm the clicked key button, capture the next keypress, swap conflicts.
    const rebind = target.closest<HTMLElement>("[data-rebind]")?.dataset.rebind as BindableAction | undefined;
    if (rebind) {
      const btn = target.closest<HTMLElement>("[data-rebind]")!;
      btn.textContent = "Press a key…";
      btn.classList.add("on");
      const capture = (keyEvent: KeyboardEvent): void => {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        window.removeEventListener("keydown", capture, true);
        if (keyEvent.code !== "Escape") {
          const taken = (Object.entries(settings.keybinds) as [BindableAction, string][]).find(([, code]) => code === keyEvent.code)?.[0];
          if (taken && taken !== rebind) settings.keybinds[taken] = settings.keybinds[rebind]; // swap
          settings.keybinds[rebind] = keyEvent.code;
          settings.save();
        }
        showSettings();
      };
      window.addEventListener("keydown", capture, true);
      return; // don't re-render yet — wait for the captured key
    }
    settings.save();
    showSettings();
  });
  screen.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.dataset.set === "volume") {
      settings.volume = Number(target.value) / 100;
      sfx.setVolume(settings.volume);
      settings.save();
    } else if (target.dataset.set === "musicVolume") {
      settings.musicVolume = Number(target.value) / 100;
      music.setVolume(settings.musicVolume);
      settings.save();
    }
  });
}

function armoryCardHtml(c: Cosmetic): string {
  const owned = progression.isUnlocked(c.id);
  const active = progression.isEquipped(c.id);
  const preview =
    c.kind === "accent"
      ? `<div class="armory-swatch" style="--swatch:#${(c.accent ?? 0).toString(16).padStart(6, "0")}"></div>`
      : c.kind === "emblem"
        ? `<div class="armory-glyph">${c.emblem || "—"}</div>`
        : `<div class="armory-glyph armory-glyph--title">“${escapeHtml(c.title ?? "")}”</div>`;
  return `<div class="armory-card ${active ? "active" : ""}">
    ${preview}
    <strong>${escapeHtml(c.name)}</strong>
    <span>${escapeHtml(c.desc)}</span>
    ${owned
      ? `<button class="menu-chip ${active ? "on" : ""}" data-equip="${c.id}" type="button">${active ? "Equipped" : "Equip"}</button>`
      : `<button class="menu-chip ${progression.points >= c.cost ? "" : "locked"}" data-unlock="${c.id}" type="button">Unlock · ${c.cost}</button>`}
  </div>`;
}

// Lifetime service record: stats, medals (earned lit, unearned ghosted), doctrine mastery.
function commanderProfileHtml(): string {
  const s = commander.stats;
  const top = commander.topUnitKind();
  const medals = MEDALS.map((m) => {
    const earned = s.medals.includes(m.id);
    return `<span class="medal ${earned ? "earned" : ""}" data-tip="${escapeAttr(`${m.name}: ${m.blurb}${earned ? " (earned)" : ""}`)}">✪ ${escapeHtml(m.name)}</span>`;
  }).join("");
  const mastered = TECH_TREE.filter((n) => n.tier < 4 && commander.masteryTier(n.id) > 0)
    .map((n) => `<span class="medal earned" data-tip="${escapeAttr(`${n.name} researched ${s.doctrineUse[n.id] ?? 0} times lifetime.`)}">${escapeHtml(n.name)} ${"I".repeat(commander.masteryTier(n.id))}</span>`)
    .join("");
  return `
    <div class="armory-category-title">Service Record</div>
    <div class="commander-profile">
      <div class="commander-profile__stats">
        <div><span>Battles</span><strong>${s.battles}</strong></div>
        <div><span>Wins / Losses</span><strong>${s.wins} / ${s.losses}</strong></div>
        <div><span>Unit Kills</span><strong>${s.kills}</strong></div>
        <div><span>Deadliest Unit</span><strong>${top ? escapeHtml(top) : "—"}</strong></div>
      </div>
      <div class="commander-profile__medals">${medals}</div>
      ${mastered ? `<div class="commander-profile__medals">${mastered}</div>` : ""}
    </div>
  `;
}

function showArmory(): void {
  closeAllMenus();
  const sections = COSMETIC_CATEGORIES.map((cat) => {
    const cards = COSMETICS.filter((c) => c.kind === cat.kind).map(armoryCardHtml).join("");
    return `<div class="armory-category-title">${cat.label}</div><div class="armory-grid">${cards}</div>`;
  }).join("");
  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content overlay-card armory-screen">
      <div class="menu-head">
        <button class="menu-back" data-overlay-close data-back type="button">&lsaquo; Back</button>
        <h2 class="menu-heading">Armory</h2>
        ${pointsBadge()}
      </div>
      <p class="settings-note">Earn points in battle. Spend them here on unit accents, callsigns, and emblems.</p>
      ${commanderProfileHtml()}
      ${sections}
    </div>
  `,
    "menu-screen",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-back]")) {
      showMainMenu();
      return;
    }
    const unlock = target.closest<HTMLElement>("[data-unlock]")?.dataset.unlock;
    if (unlock) {
      if (progression.unlock(unlock)) {
        progression.setEquipped(unlock);
        world.setPlayerAccent(progression.accentColor());
      }
      showArmory();
      return;
    }
    const equip = target.closest<HTMLElement>("[data-equip]")?.dataset.equip;
    if (equip) {
      progression.setEquipped(equip);
      world.setPlayerAccent(progression.accentColor());
      showArmory();
    }
  });
}

// ---- Campaign ----
function showCampaign(): void {
  closeAllMenus();
  const missions = campaign.missions();
  const completedCount = missions.filter((m) => campaign.isCompleted(m.id)).length;
  const cards = missions
    .map((m, i) => {
      const done = campaign.isCompleted(m.id);
      const unlocked = campaign.isUnlocked(i);
      const status = done ? "completed" : unlocked ? "available" : "locked";
      const label = done ? "✓ Cleared" : unlocked ? "Briefing ›" : "Locked";
      return `<button class="campaign-card ${status} ${m.branchLabel ? "campaign-card--branch" : ""}" data-mission="${m.id}" ${unlocked ? "" : "disabled"} type="button">
        <span class="campaign-card__no">${String(i + 1).padStart(2, "0")}</span>
        <span class="campaign-card__body">
          <strong>${escapeHtml(m.name)}${m.branchLabel ? ` <em class="campaign-card__branch">${escapeHtml(m.branchLabel)}</em>` : ""}</strong>
          <span class="campaign-card__region">${escapeHtml(m.region)} · ${escapeHtml(modeDef(m.mode).name)} · ${escapeHtml(difficultyLabel(m.difficulty))}${m.bonus ? ` · <span class="campaign-card__bonus">☆ ${escapeHtml(m.bonus.text)}</span>` : ""}</span>
        </span>
        <span class="campaign-card__status">${label}</span>
      </button>`;
    })
    .join("");
  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content overlay-card campaign-screen">
      <div class="menu-head">
        <button class="menu-back" data-overlay-close data-back type="button">&lsaquo; Back</button>
        <h2 class="menu-heading">${escapeHtml(CAMPAIGN_TITLE)}</h2>
        ${pointsBadge()}
      </div>
      <p class="settings-note campaign-synopsis">${escapeHtml(CAMPAIGN_SYNOPSIS)}</p>
      <div class="campaign-progress">Progress · ${completedCount} / ${missions.length}${campaign.isAllComplete() ? " — Campaign complete ★" : ""}</div>
      ${campaign.roster.length ? `<div class="campaign-roster campaign-roster--map"><span class="campaign-roster__title">Squad Roster — deploys free on every mission</span>${campaign.roster
        .map((m) => `<span class="campaign-roster__member" data-tip="${escapeAttr(`${rankFor(m.kills)} ${m.kind} — ${m.kills} kills, ${m.missions} mission${m.missions === 1 ? "" : "s"}. Falls in battle = gone for good.`)}">${escapeHtml(m.name)} <em>${rankInsignia(rankFor(m.kills)) || "·"}</em></span>`)
        .join("")}</div>` : ""}
      <div class="campaign-list campaign-list--operation">${cards}</div>
    </div>
  `,
    "menu-screen",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-back]")) {
      showMainMenu();
      return;
    }
    const id = target.closest<HTMLElement>("[data-mission]")?.dataset.mission;
    if (!id) return;
    const mission = campaign.mission(id);
    if (mission && campaign.isUnlocked(missions.indexOf(mission))) showBriefing(mission);
  });
}

function showBriefing(mission: CampaignMission): void {
  closeAllMenus();
  const map = mapDef(mission.map);
  const paras = mission.briefing.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content overlay-card briefing-screen">
      <div class="menu-head">
        <button class="menu-back" data-back type="button">&lsaquo; Missions</button>
        <h2 class="menu-heading">${escapeHtml(mission.name)}</h2>
      </div>
      <div class="briefing-layout">
        <div class="briefing-text">
          <div class="briefing-meta">${escapeHtml(mission.region)} · ${escapeHtml(modeDef(mission.mode).name)} · ${escapeHtml(difficultyLabel(mission.difficulty))}</div>
          ${paras}
          <div class="briefing-objective"><span>Objective</span> ${escapeHtml(mission.objective)}</div>
        </div>
        <div class="briefing-map">${mapPreviewSvg(map)}</div>
      </div>
      <div class="menu-actions"><button class="title-start" data-deploy type="button">Deploy to Battle</button></div>
    </div>
  `,
    "menu-screen",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-back]")) {
      showCampaign();
      return;
    }
    if (target.closest("[data-deploy]")) {
      screen.classList.add("is-leaving");
      deployWithLoadingScreen(mission.map, mission.mode, mission.difficulty, settings.faction, mission);
    }
  });
}

function showCampaignVictory(mission: CampaignMission, reward: number, bonusText?: string): void {
  const next = campaign.nextMission(mission.id);
  const complete = campaign.isAllComplete();
  const roster = campaign.roster;
  const rosterHtml = roster.length
    ? `<div class="campaign-roster"><span class="campaign-roster__title">Squad Roster</span>${roster
        .map((m) => {
          const rank = rankFor(m.kills);
          return `<span class="campaign-roster__member" data-tip="${escapeAttr(`${rank} — ${m.kills} kills over ${m.missions} mission${m.missions === 1 ? "" : "s"}. Veterans deploy free next mission (${Math.round((rankHpBonus(rank) - 1) * 100)}% bonus HP). If they fall, they're gone.`)}">${escapeHtml(m.name)} <em>${rankInsignia(rank) || "·"}</em></span>`;
        })
        .join("")}</div>`
    : "";
  const requisitionHtml = !complete && next
    ? `<div class="campaign-requisition">
        <span class="campaign-roster__title">Requisition — choose one for the next mission</span>
        <div class="pause-buttons requisition-row">
          <button class="menu-action" data-req="cash" type="button">+$200 starting funds</button>
          <button class="menu-action" data-req="doctrine" type="button">Recon Doctrine pre-researched</button>
        </div>
      </div>`
    : "";
  const screen = mountScreen(
    `
    <div class="overlay-card campaign-end victory">
      <div class="campaign-end__kicker">${complete ? "Campaign Complete ★" : "Mission Complete"}</div>
      <h2 class="menu-heading">${escapeHtml(mission.name)}</h2>
      <p class="campaign-end__story">${escapeHtml(mission.victory)}</p>
      <div class="campaign-end__reward">+${reward} points${bonusText ? ` · Bonus objective: ${escapeHtml(bonusText)} ✓` : ""}</div>
      ${rosterHtml}
      ${requisitionHtml}
      <div class="pause-buttons">
        ${!complete && next ? `<button class="title-start" data-next type="button">Next · ${escapeHtml(next.name)}</button>` : ""}
        <button class="menu-action" data-menu-btn type="button">${complete ? "Return to Menu" : "Mission Select"}</button>
      </div>
    </div>
  `,
    "pause-overlay campaign-overlay",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const req = target.closest<HTMLElement>("[data-req]")?.dataset.req as "cash" | "doctrine" | undefined;
    if (req) {
      campaign.setRequisition(req);
      for (const btn of screen.querySelectorAll<HTMLElement>("[data-req]")) btn.classList.toggle("active", btn.dataset.req === req);
      sfx.select();
      return;
    }
    if (target.closest("[data-next]") && next) {
      screen.remove();
      showBriefing(next);
    } else if (target.closest("[data-menu-btn]")) {
      screen.remove();
      if (complete) showMainMenu();
      else showCampaign();
    }
  });
}

function showCampaignDefeat(mission: CampaignMission): void {
  const screen = mountScreen(
    `
    <div class="overlay-card campaign-end defeat">
      <div class="campaign-end__kicker">Mission Failed</div>
      <h2 class="menu-heading">${escapeHtml(mission.name)}</h2>
      <p class="campaign-end__story">The Vanguard is thrown back — but not broken. Regroup and try again, Commander.</p>
      <div class="pause-buttons">
        <button class="title-start" data-retry type="button">Retry Mission</button>
        <button class="menu-action" data-menu-btn type="button">Mission Select</button>
      </div>
    </div>
  `,
    "pause-overlay campaign-overlay",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-retry]")) {
      screen.remove();
      deployWithLoadingScreen(mission.map, mission.mode, mission.difficulty, settings.faction, mission);
    } else if (target.closest("[data-menu-btn]")) {
      screen.remove();
      showCampaign();
    }
  });
}

// Compact veteran-roster strip for the run overlays (reuses the campaign roster styling).
function runRosterHtml(): string {
  if (!run.roster.length) return "";
  const members = run.roster
    .map((m) => {
      const rank = rankFor(m.kills);
      return `<span class="campaign-roster__member" data-tip="${escapeAttr(`${rank} ${m.kind} — ${m.kills} kills over ${m.missions} sector${m.missions === 1 ? "" : "s"}. Redeploys free next sector. Falls in battle = gone for good.`)}">${escapeHtml(m.name)} <em>${rankInsignia(rank) || "·"}</em></span>`;
    })
    .join("");
  return `<div class="campaign-roster"><span class="campaign-roster__title">Squad Roster — veterans of this run</span>${members}</div>`;
}

// Between-sector screen: a cleared, non-final sector. run.index already points at the next one.
function showRunSector(reward: number): void {
  const next = run.current();
  const cashLine = run.bankedCash > 0 ? ` · Salvage banked: +$${run.bankedCash}` : "";
  const screen = mountScreen(
    `
    <div class="overlay-card campaign-end victory">
      <div class="campaign-end__kicker">Sector ${run.index} Cleared</div>
      <h2 class="menu-heading">Skirmish Run</h2>
      <p class="campaign-end__story">The line holds. Regroup and push to the next sector — your veterans and salvage come with you.</p>
      <div class="campaign-end__reward">+${reward} points${cashLine}</div>
      ${runRosterHtml()}
      <div class="campaign-progress">Next · Sector ${run.sectorNumber} of ${RUN_LENGTH} — ${escapeHtml(mapDef(next.map).name)} · ${escapeHtml(modeDef(next.mode).name)} · ${escapeHtml(difficultyLabel(next.difficulty))}</div>
      <div class="pause-buttons">
        <button class="title-start" data-next type="button">Deploy · Sector ${run.sectorNumber}</button>
        <button class="menu-action" data-menu-btn type="button">Abandon Run</button>
      </div>
    </div>
  `,
    "pause-overlay campaign-overlay",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-next]")) {
      screen.remove();
      deployRunWithLoadingScreen();
    } else if (target.closest("[data-menu-btn]")) {
      run.end();
      screen.remove();
      showMainMenu();
    }
  });
}

function showRunComplete(reward: number): void {
  const screen = mountScreen(
    `
    <div class="overlay-card campaign-end victory">
      <div class="campaign-end__kicker">Run Complete ★</div>
      <h2 class="menu-heading">Skirmish Run</h2>
      <p class="campaign-end__story">All ${RUN_LENGTH} sectors cleared in one unbroken push. The frontier is yours, Commander — for now.</p>
      <div class="campaign-end__reward">+${reward} points</div>
      ${runRosterHtml()}
      <div class="pause-buttons">
        <button class="title-start" data-menu-btn type="button">Return to Menu</button>
      </div>
    </div>
  `,
    "pause-overlay campaign-overlay",
  );
  screen.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-menu-btn]")) {
      screen.remove();
      showMainMenu();
    }
  });
}

function showRunDefeat(): void {
  const cleared = run.index; // sectors banked before the loss
  const screen = mountScreen(
    `
    <div class="overlay-card campaign-end defeat">
      <div class="campaign-end__kicker">Run Over</div>
      <h2 class="menu-heading">Skirmish Run</h2>
      <p class="campaign-end__story">The Vanguard is overrun on Sector ${cleared + 1}. ${cleared > 0 ? `You held ${cleared} sector${cleared === 1 ? "" : "s"} before the line broke.` : "No ground held — regroup and run it again."}</p>
      <div class="pause-buttons">
        <button class="title-start" data-new type="button">New Run</button>
        <button class="menu-action" data-menu-btn type="button">Return to Menu</button>
      </div>
    </div>
  `,
    "pause-overlay campaign-overlay",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-new]")) {
      screen.remove();
      beginNewRun();
    } else if (target.closest("[data-menu-btn]")) {
      screen.remove();
      showMainMenu();
    }
  });
}

// Loading veil around a run sector start (mirrors deployWithLoadingScreen for campaign/skirmish).
function deployRunWithLoadingScreen(): void {
  const battle = run.current();
  const veil = document.createElement("div");
  veil.className = "battle-loading";
  veil.innerHTML = `<div class="battle-loading__inner">
    <div class="battle-loading__spinner"></div>
    <div class="battle-loading__label"><span>Deploying to</span><strong>${escapeAttr(mapDef(battle.map).name)}</strong></div>
  </div>`;
  document.body.appendChild(veil);
  requestAnimationFrame(() => veil.classList.add("show"));
  const startedAt = performance.now();
  const minVisible = settings.reducedMotion ? 250 : 600;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    startRunBattle();
    const hold = Math.max(0, minVisible - (performance.now() - startedAt));
    window.setTimeout(() => {
      veil.classList.add("leaving");
      window.setTimeout(() => veil.remove(), 360);
    }, hold);
  }));
}

// Fresh run: pick a new seed (app-side, so a real clock is fine here) and drop into sector 1.
function beginNewRun(): void {
  run.begin(Math.floor(performance.now() * 1000) ^ (progression.points * 2654435761));
  deployRunWithLoadingScreen();
}

// Skirmish Run entry: start a fresh ladder, or resume/abandon one already in progress.
function showRunIntro(): void {
  closeAllMenus();
  const active = run.active;
  const battle = active ? run.current() : undefined;
  const body = active && battle
    ? `<p class="settings-note">A run is in progress.</p>
       <div class="campaign-progress">Sector ${run.sectorNumber} of ${RUN_LENGTH} — ${escapeHtml(mapDef(battle.map).name)} · ${escapeHtml(modeDef(battle.mode).name)} · ${escapeHtml(difficultyLabel(battle.difficulty))}</div>
       ${runRosterHtml()}`
    : `<p class="settings-note">${RUN_LENGTH} battles back to back on random maps, each harder than the last. Survivors carry forward; the fallen stay dead. Lose once and the run is over.</p>`;
  const buttons = active
    ? `<button class="title-start" data-resume type="button">Resume Run</button>
       <button class="menu-action" data-new type="button">Abandon &amp; Start Over</button>`
    : `<button class="title-start" data-new type="button">Begin Run</button>`;
  const screen = mountScreen(
    `
    <div class="title-screen__content menu-content overlay-card">
      <h2 class="menu-heading">Skirmish Run</h2>
      ${body}
      <div class="pause-buttons">
        ${buttons}
        <button class="menu-action" data-back type="button">Back</button>
      </div>
    </div>
  `,
    "menu-screen",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-resume]")) {
      screen.remove();
      deployRunWithLoadingScreen();
    } else if (target.closest("[data-new]")) {
      screen.remove();
      beginNewRun();
    } else if (target.closest("[data-back]")) {
      screen.remove();
      showMainMenu();
    }
  });
}

// ---- In-battle pause menu ----
function openPauseMenu(): void {
  if (document.querySelector(".pause-overlay")) return;
  const screen = mountScreen(
    `
    <div class="overlay-card pause-card">
      <h2 class="menu-heading">Paused</h2>
      <div class="pause-buttons">
        <button class="title-start" data-pause="resume" data-overlay-close type="button">Resume</button>
        <button class="menu-action" data-pause="save" type="button">Save Battle</button>
        <button class="menu-action" data-pause="settings" type="button">Settings</button>
        <button class="menu-action" data-pause="controls" type="button">Controls</button>
        <button class="menu-action" data-pause="menu" type="button">Main Menu</button>
      </div>
      <div class="pause-feedback" data-feedback></div>
    </div>
  `,
    "pause-overlay",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === screen) {
      screen.remove();
      return;
    }
    const action = target.closest<HTMLElement>("[data-pause]")?.dataset.pause;
    if (action === "resume") screen.remove();
    else if (action === "save") {
      const ok = saveBattle();
      const feedback = screen.querySelector<HTMLElement>("[data-feedback]");
      if (feedback) feedback.textContent = ok ? "Battle saved." : "Save unavailable.";
    } else if (action === "controls") {
      screen.remove();
      showControls();
    } else if (action === "settings") {
      screen.remove();
      showSettings();
    } else if (action === "menu") {
      screen.remove();
      showMainMenu();
    }
  });
}

function showControls(): void {
  const rows: Array<[string, string]> = [
    ["Left click", "Select a unit / pick a target / order ground"],
    ["Middle-drag", "Orbit the camera"],
    ["WASD", "Pan the camera"],
    ["Scroll", "Zoom"],
    ["Space", "End turn"],
    ["Tab", "Cycle squad units"],
    ["1–6", "Command-deck action"],
    ["M / F / G", "Move / Shoot / Grenade"],
    ["X / B / V", "Ram / Strike / Crouch"],
    ["C", "Quick crouch"],
    ["Enter", "Confirm the armed order"],
    ["L", "Toggle the battle log"],
    ["Esc", "Back / pause"],
    ["R", "Restart the battle"],
  ];
  const screen = mountScreen(
    `
    <div class="overlay-card controls-card">
      <div class="menu-head">
        <button class="menu-back" data-overlay-close data-back type="button">&lsaquo; Back</button>
        <h2 class="menu-heading">Controls</h2>
      </div>
      <div class="controls-grid">
        ${rows.map(([k, v]) => `<div class="controls-row"><kbd>${k}</kbd><span>${v}</span></div>`).join("")}
      </div>
    </div>
  `,
    "pause-overlay",
  );
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === screen || target.closest("[data-back]")) {
      screen.remove();
      openPauseMenu();
    }
  });
}

// ---- Per-unit customization (rename + accent) ----
function openEditOverlay(id: string): void {
  const entity = sim.entity(id);
  if (!entity) return;
  const accents = COSMETICS.filter((c): c is Cosmetic & { accent: number } => c.kind === "accent" && c.accent !== undefined && progression.isUnlocked(c.id));
  const screen = mountScreen(
    `
    <div class="overlay-card edit-card">
      <div class="menu-head">
        <button class="menu-back" data-overlay-close data-back type="button">&lsaquo; Back</button>
        <h2 class="menu-heading">Customize Unit</h2>
      </div>
      <label class="edit-label">Name</label>
      <input class="edit-name" type="text" maxlength="22" value="${escapeAttr(entity.name)}" />
      <label class="edit-label">Accent</label>
      <div class="edit-accents">
        ${accents.map((c) => {
          const hex = `#${c.accent.toString(16).padStart(6, "0")}`;
          const current = (entity.accent ?? progression.accentColor()) === c.accent;
          return `<button class="edit-accent ${current ? "on" : ""}" data-accent="${c.accent}" style="--swatch:${hex}" title="${escapeAttr(c.name)}" type="button"></button>`;
        }).join("")}
      </div>
      <p class="settings-note">Unlock more accents in the Armory with points earned in battle.</p>
      <button class="title-start edit-apply" data-apply type="button">Apply</button>
    </div>
  `,
    "edit-overlay",
  );
  const nameInput = screen.querySelector<HTMLInputElement>(".edit-name");
  let accent = entity.accent;
  screen.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === screen || target.closest("[data-back]")) {
      screen.remove();
      return;
    }
    const accentBtn = target.closest<HTMLElement>("[data-accent]");
    if (accentBtn) {
      accent = Number(accentBtn.dataset.accent);
      for (const el of screen.querySelectorAll(".edit-accent")) el.classList.toggle("on", el === accentBtn);
      return;
    }
    if (target.closest("[data-apply]")) {
      const name = nameInput?.value.trim();
      if (name) entity.name = name;
      entity.accent = accent;
      screen.remove();
      hud.update();
    }
  });
}

// ---- Save / load ----
// Always overwrite the single save slot with the current battle so "Continue" reloads the
// most recent save. (The old command-phase-only guard silently failed mid-resolve saves,
// leaving a stale earlier save as the one Continue would load.) restore() normalizes any
// snapshot back to a clean command phase.
function saveBattle(): boolean {
  if (sim.gameOver) return false; // nothing meaningful to resume from a finished battle
  return safeStorageSet(SAVE_KEY, sim.serialize());
}

function loadSavedBattle(): void {
  const raw = safeStorageGet(SAVE_KEY);
  if (!raw) {
    showMainMenu();
    return;
  }
  if (sim.restore(raw)) {
    tutorialActive = false;
    // If the saved battle was a campaign mission, resume that context so victory still advances.
    activeCampaignMission = campaign.activeMissionId ? campaign.mission(campaign.activeMissionId) : undefined;
    closeAllMenus();
    world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
    world.setPlayerAccent(progression.accentColor());
    focusOnPlayerBase();
    lastEndPhase = undefined;
    setInBattle(true);
    hud.update();
  }
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeStorageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// ---- Tutorial ----
const TUTORIAL_STEPS: Array<{ title: string; body: string }> = [
  { title: "Welcome, Commander", body: "Turn-based tactics. You start with only a Home Base. Learn the basics against an easy bot." },
  { title: "Select your base", body: "Click your blue Home Base. Its command deck opens at the bottom — from there you deploy troops, research tech, build defenses, and upgrade." },
  { title: "Deploy a Recruit", body: "In the base deck, click Recruit to place rifle infantry beside your base. It costs money and the base's command point." },
  { title: "End the turn", body: "Press Space (or End Turn) to resolve the turn. Income is paid and your new troop is ready to act next turn." },
  { title: "Move a unit", body: "Select your Recruit and press M (Move). A cyan circle shows how far it can go this turn — click inside it to move." },
  { title: "Attack", body: "Press F (Shoot), click an enemy, pick a body part, and Confirm. The line preview shows cover, accuracy, and estimated damage." },
  { title: "Build defenses and win", body: "From the base, build walls and turrets nearby and upgrade income and command points. Destroy the enemy base and every enemy unit to win." },
];
let tutorialStep = 0;

function startTutorial(): void {
  closeAllMenus();
  tutorialStep = 0;
  startBattle("ironworks", "destroy", "easy");
  tutorialActive = true;
  renderTutorialPanel();
}

function renderTutorialPanel(): void {
  document.querySelector(".tutorial-panel")?.remove();
  if (!tutorialActive) return;
  const step = TUTORIAL_STEPS[tutorialStep];
  const panel = document.createElement("div");
  panel.className = "tutorial-panel";
  panel.innerHTML = `
    <div class="tutorial-step">Step ${tutorialStep + 1} / ${TUTORIAL_STEPS.length}</div>
    <strong>${step.title}</strong>
    <p>${step.body}</p>
    <div class="tutorial-actions">
      ${tutorialStep > 0 ? `<button class="menu-chip" data-tut="back" type="button">Back</button>` : ""}
      ${tutorialStep < TUTORIAL_STEPS.length - 1 ? `<button class="menu-chip on" data-tut="next" type="button">Next</button>` : `<button class="menu-chip on" data-tut="done" type="button">Got it</button>`}
      <button class="menu-chip" data-tut="exit" type="button">Exit Tutorial</button>
    </div>
  `;
  panel.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-tut]")?.dataset.tut;
    if (action === "next") {
      tutorialStep = Math.min(TUTORIAL_STEPS.length - 1, tutorialStep + 1);
      renderTutorialPanel();
    } else if (action === "back") {
      tutorialStep = Math.max(0, tutorialStep - 1);
      renderTutorialPanel();
    } else if (action === "done") {
      panel.remove();
    } else if (action === "exit") {
      tutorialActive = false;
      panel.remove();
      showMainMenu();
    }
  });
  document.body.appendChild(panel);
}

// A brief flourish when a resolve finishes and the next command round opens.
let roundTransitionEl: HTMLDivElement | undefined;
function showRoundTransition(turn: number): void {
  if (anyOverlayOpen() || sim.gameOver) return;
  roundTransitionEl?.remove();
  const el = document.createElement("div");
  el.className = "round-transition";
  el.innerHTML = `<div class="round-transition__bar"></div><div class="round-transition__label"><span>Next</span><strong>Turn ${turn}</strong></div>`;
  document.body.appendChild(el);
  roundTransitionEl = el;
  // Trigger the enter animation on the next frame, then auto-clear.
  requestAnimationFrame(() => el.classList.add("show"));
  // Held ~0.5s longer than the original 1300/700 so the new round reads clearly before play.
  const life = settings.reducedMotion ? 1200 : 1800;
  window.setTimeout(() => {
    el.classList.remove("show");
    el.classList.add("leaving");
    window.setTimeout(() => { el.remove(); if (roundTransitionEl === el) roundTransitionEl = undefined; }, 360);
  }, life);
}

sim.bus.on("TURN_START", ({ turn }) => {
  showRoundTransition(turn);
  // Back out to the zoom the player was planning at before the resolve pushed in.
  if (resolveEntryZoom !== undefined) {
    const view = stage.viewState();
    stage.guideTo({ focus: { x: view.x, z: view.z }, zoom: resolveEntryZoom }, { mode: "resolve", strength: 1.2, durationMs: 700 });
    resolveEntryZoom = undefined;
  }
});
// The planning zoom the resolve camera pushed in from; restored at the next TURN_START.
let resolveEntryZoom: number | undefined;

// Enemy-intel ticker: when the AI finishes a doctrine mid-battle, warn the player — a
// readable escalation beat you can race ("their Armor Bay is online; rush or dig in").
let seenEnemyTech = new Set<string>();
function watchEnemyIntel(): void {
  const enemyBase = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
  if (!enemyBase) return;
  const owned = enemyBase.unlockedTech ?? [];
  for (const id of seenEnemyTech) {
    if (!owned.includes(id)) {
      seenEnemyTech = new Set();
      break;
    }
  }
  for (const id of owned) {
    if (seenEnemyTech.has(id)) continue;
    seenEnemyTech.add(id);
    // Pre-seeded tech (campaign setups) lands on turn 1 — only mid-battle research is news.
    if (inBattle && sim.turn > 1) {
      const node = TECH_TREE.find((n) => n.id === id);
      if (node) showToast(`INTEL — enemy ${node.name} online`);
    }
  }
}

function showToast(text: string, lifeMs = 2600): void {
  // Toasts stack in a shared column above the order panel — concurrent toasts
  // (e.g. several medals at once) must never overlap in place.
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  host.appendChild(toast);
  window.setTimeout(() => toast.classList.add("show"), 16);
  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => toast.remove(), 400);
  }, lifeMs);
}

// Drop any lingering toasts immediately — called before a full-screen end overlay so transient
// start-of-battle notices can't overlap its buttons.
// Debug/sandbox cheats, applied each command frame while unlocked (via ?debug + the Debug settings
// section): keep the treasury topped up, and/or zero the deploy cooldowns for instant reinforcement.
function applyDebugCheats(): void {
  if (settings.debugInfiniteMoney && sim.money("player") < 90000) sim.debugGrant("player", 999999);
  if (settings.debugFreeCooldown) {
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    if (base?.spawnCooldowns) for (const key of Object.keys(base.spawnCooldowns)) (base.spawnCooldowns as Record<string, number>)[key] = 0;
  }
}

// Clicking a ground cash cache surfaces how much it pays and how to collect it.
function inspectPickup(id: string): void {
  const cache = sim.pickups.find((p) => p.id === id);
  if (!cache) return;
  showToast(`💰 Field cache — roll a unit over it to bank $${cache.amount}`);
  sfx.ui();
}

function clearToasts(): void {
  document.getElementById("toasts")?.replaceChildren();
}

// First-time onboarding hints beyond the 7-step tutorial — each fires once ever (persisted to
// localStorage) and never during the tutorial itself. Reuses the existing toast surface.
const HINTS_KEY = "rht.hints.v1";
const seenHints = ((): Set<string> => {
  try {
    const raw = safeStorageGet(HINTS_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
})();
// Hints are spaced out: a second one waits until the first has had time to be read, so a scenario
// that makes three states true at once still delivers them one at a time.
let lastHintAt = -Infinity;
const HINT_GAP_MS = 5000;
function hintOnce(id: string, text: string): boolean {
  if (tutorialActive || introActive || seenHints.has(id)) return false;
  if (performance.now() - lastHintAt < HINT_GAP_MS) return false;
  lastHintAt = performance.now();
  seenHints.add(id);
  safeStorageSet(HINTS_KEY, JSON.stringify([...seenHints]));
  // Dwell scales with length: reading speed plus a margin, never the 2.6s a two-word medal gets.
  const words = text.trim().split(/\s+/).length;
  showToast(text, Math.min(9000, Math.max(2600, 2200 + words * 330)));
  return true;
}

// The key a hint tells the player to press is the one they actually have bound.
function hintKey(action: BindableAction): string {
  return keyDisplay(settings.keybinds[action]);
}

// Contextual, state-triggered hints checked each command-phase frame. Every hint is ONE sentence
// that names the verb and the key, fires only while the state it describes is true, and fires once
// ever (persisted). At most one hint fires per frame so two true states never stack two toasts.
// They cover the gap the tutorial leaves: what to do once the base and the troops are on the field.
const HINT_IDS = ["base", "controls", "in-range", "cover", "unspent", "unit-jumper", "unit-mortar", "unit-sniper"] as const;
const UNIT_HINTS: Partial<Record<TroopKind, (name: string) => string>> = {
  jumper: (name) => `${name} jumps instead of walking — press ${hintKey("move")} and click across cliffs, water or walls, or beside an enemy to slam it.`,
  mortar: (name) => `${name} fires in a high arc — press ${hintKey("shoot")} and click an enemy or a spot behind walls and ridges.`,
  sniper: (name) => `${name} shoots through bodies — press ${hintKey("shoot")} and line enemies up so one round hits them all.`,
};
function updateOnboardingHints(): void {
  if (!inBattle || tutorialActive || sim.phase !== "command") return;
  if (HINT_IDS.every((id) => seenHints.has(id))) return;
  const squad = sim.living("player").filter((e) => e.kind !== "base" && e.kind !== "cover" && !e.carriedById);
  const base = sim.entities.find((e) => e.kind === "base" && e.team === "player" && e.status.alive);

  // 1. Nothing on the field yet: the only move is the base.
  if (squad.length === 0 && base && base.commandPoints > 0) {
    hintOnce("base", "Click your Home Base, then Deploy a troop — the base gets one order a turn.");
    return;
  }
  // 2. Troops exist: how to give one an order.
  if (squad.length > 0 && hintOnce("controls", `Troops deployed — click one, then press ${hintKey("move")} to move or ${hintKey("shoot")} to shoot.`)) return;

  // 3. A unit that is special the first time it is fielded: one line on what makes it so.
  for (const unit of squad) {
    const line = UNIT_HINTS[unit.kind as TroopKind];
    if (line && hintOnce(`unit-${unit.kind}`, line(unit.name))) return;
  }

  // 4. The first time one of your units can actually hit something.
  if (!seenHints.has("in-range")) {
    const enemies = sim.living("enemy").filter((e) => e.kind !== "cover" && !e.carriedById);
    for (const actor of squad) {
      if (!actor.status.canShoot || actor.commandPoints <= 0) continue;
      const range = unitStats(actor.kind).weaponRange;
      for (const enemy of enemies) {
        if (dist(actor.position, enemy.position) > range) continue;
        const part = sim.targetableParts(enemy)[0];
        const preview = part ? sim.previewShot(actor.id, enemy.id, part.id) : undefined;
        if (!preview || preview.blockedById || preview.blockedByGround) continue;
        hintOnce("in-range", `${actor.name} can hit ${enemy.name} — press ${hintKey("shoot")}, click it, then Confirm.`);
        return;
      }
    }
  }

  // 5. Standing beside cover with a unit that could crouch behind it.
  const selected = sim.entity(sim.selectedId);
  if (selected && selected.team === "player" && isInfantryKind(selected.kind) && !sim.defending.has(selected.id) && selected.commandPoints > 0) {
    const nearCover = sim.entities.some((e) => e.kind === "cover" && e.status.alive && e.height >= 1 && dist(e.position, selected.position) <= 3.6);
    if (nearCover && hintOnce("cover", `Cover is beside ${selected.name} — press ${hintKey("crouch")} to crouch behind it and take less fire.`)) return;
  }

  // 6. Some units are done and others still have points: don't end the turn yet.
  const spent = squad.some((u) => u.commandPoints <= 0);
  const idle = squad.find((u) => u.commandPoints > 0 && (u.status.canMove || u.status.canShoot));
  if (spent && idle) hintOnce("unspent", `${idle.name} still has command points — give every unit an order before pressing ${hintKey("endTurn")}.`);
}

if (settings.reducedMotion) document.body.classList.add("reduced-motion");
showMainMenu();
// Pre-compile every shader variant (both shadow states × both post chains) behind the
// first menu, so battle start / menu flips never stall on a synchronous GLSL link.
stage.warmUp(world.warmUpSamplers());

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let last = performance.now();
let warmedModelsVersion = modelsVersion();
let lastHudUpdateAt = 0;
let lastHudPhase = sim.phase;
let lastHudLogHead = "";
const seenProjectileIds = new Set<string>();
// Debug-seam slow motion for the resolve clock (1 = normal). Filmstrips shoot swings at 0.25.
let resolveScale = 1;
const seenEffectIds = new Set<string>();

// ONE BAD FRAME MUST NEVER FREEZE THE GAME. The loop had no guard, so a single thrown error
// anywhere in a frame killed rAF for good: the last frame stayed on screen, the HUD read
// "Turn 1 resolving" forever, and the console said nothing to anyone not already watching it.
// Found by playing: the game soft-locked on turn 1 of a restored battle. The error is logged
// (and counted for the diagnostics seam) and the next frame is always scheduled.
let frameErrors = 0;
function frame(now: number): void {
  try {
    frameBody(now);
  } catch (error) {
    frameErrors += 1;
    if (frameErrors <= 5) console.error("frame error", error);
    last = now;
  }
  requestAnimationFrame(frame);
}

function frameBody(now: number): void {
  const frameMs = now - last;
  const dt = Math.min(0.05, frameMs / 1000);
  last = now;
  stage.update(dt, {
    up: heldKeys.has("KeyW"),
    down: heldKeys.has("KeyS"),
    left: heldKeys.has("KeyA"),
    right: heldKeys.has("KeyD"),
  });
  // Camera direction runs on REAL time, not the paced sim clock, so the action-pace setting
  // changes how fast the battle plays out without changing how the camera moves.
  resolveCam.enabled = !settings.reducedMotion;
  const shot = resolveCam.update(dt);
  // Hitstop freezes the sim by SKIPPING the step, never by scaling dt: scaling would change the
  // step sequence the sim sees, while skipping delays everything uniformly and preserves ordering.
  // The action-pace setting only scales time while orders resolve; planning stays real-time.
  if (shot.hitstop <= 0) sim.update(sim.phase === "resolve" ? dt * settings.resolveSpeed * resolveScale : dt);
  resolveFocus = shot.focus; // consumed by syncCameraAssist, the single camera authority
  if (DEBUG_UNLOCKED && inBattle && sim.phase === "command") applyDebugCheats();
  processBattleEvents();
  watchEnemyIntel();
  watchCampaignBeats();
  feel.update(dt);
  music.setState(
    sim.phase === "resolve" ? "resolve"
    : sim.phase === "victory" || sim.phase === "defeat" ? "end"
    : inBattle ? "command" : "menu",
  );
  music.update();
  handleEndState();
  syncCameraAssist();
  const aimPoint = groundAimHover();
  world.update(sim, hud.focusedTargetId ?? hud.hoveredTargetId, hud.focusedPartId, stage.camera, aimPoint);
  updateOnboardingHints();
  const hudLogHead = sim.log[0] ?? "";
  const idleThrottleMs = sim.phase === "resolve" ? 120 : 90;
  const shouldUpdateHud = sim.phase !== lastHudPhase || hudLogHead !== lastHudLogHead || now - lastHudUpdateAt > idleThrottleMs;
  if (shouldUpdateHud) {
    hud.update();
    lastHudUpdateAt = now;
    lastHudPhase = sim.phase;
    lastHudLogHead = hudLogHead;
  }
  stage.render(dt);
  // A GLB arrived since the last warm-up: compile its textured-PBR shaders off the hot
  // path so the first deploy of that unit doesn't hitch.
  if (modelsVersion() !== warmedModelsVersion) {
    warmedModelsVersion = modelsVersion();
    stage.warmUp([...loadedTemplates(), ...world.warmUpSamplers()]);
  }

  // Perf instrumentation — sample the inter-frame delta (skip first frame + tab-switch
  // outliers) and refresh the renderer counters now that this frame has drawn.
  if (frameMs > 0 && frameMs < 1000) perfMon.sample(frameMs, now);
  perfMon.setRenderInfo(readRenderInfo(), null);
  if (debugOverlay.isEnabled()) debugOverlay.render(buildSceneDescription());
}

requestAnimationFrame(frame);

// The cursor ground point, only while aiming a grenade/shell at a spot (so the renderer can
// draw the landing arc and blast radius).
function groundAimHover(): Vec2 | undefined {
  if (anyOverlayOpen() || sim.phase !== "command") return undefined;
  if (sim.pendingSupport) return hoverWorld; // strike-call targeting reticle
  // Overwatch aims a watch cone at the cursor; grenade/shell aim a landing arc.
  const aiming = sim.intent === "grenade" || sim.intent === "overwatch" || (sim.intent === "shoot" && sim.selectedCanGroundTarget());
  return aiming ? hoverWorld : undefined;
}

// Diff freshly-spawned projectiles/effects against the seen-sets and fire the one-shot
// feedback for each: audio, camera trauma/kick, and pooled flash lights. This is the single
// seam where sim events become player-facing juice (one-way data flow preserved).
function processBattleEvents(): void {
  // A killing blow is the moment of a turn worth watching, and the only one that earns a freeze.
  // Without the hold, a unit that dies in the same frame as everything else simply vanishes: the
  // eye never registers what happened to it.
  if (sim.phase === "resolve") {
    for (const entity of sim.entities) {
      if (entity.kind === "cover") continue;
      const wasAlive = aliveLastFrame.has(entity.id);
      if (entity.status.alive) {
        aliveLastFrame.add(entity.id);
      } else if (wasAlive) {
        aliveLastFrame.delete(entity.id);
        resolveCam.note(entity.position.x, entity.position.z, POI_WEIGHT.kill, 1.6);
        // Base kills are the end of the battle; hold longer for those.
        resolveCam.freeze(settings.reducedMotion ? 0 : entity.kind === "base" ? 0.2 : 0.09);
        feel.addTrauma(entity.kind === "base" ? 0.4 : 0.16);
      }
    }
  }
  for (const projectile of sim.projectiles) {
    if (seenProjectileIds.has(projectile.id)) continue;
    seenProjectileIds.add(projectile.id);
    sfx.shot(projectile.kind);
    resolveCam.note(projectile.origin.x, projectile.origin.z, POI_WEIGHT.shot, 0.7);
    const onScreen = stage.isInView(projectile.origin) ? 1 : 0.3;
    const heavy = projectile.kind === "shell" || projectile.kind === "grenade";
    if (heavy) {
      feel.addTrauma((projectile.kind === "shell" ? 0.12 : 0.08) * onScreen);
      world.flashLight(projectile.origin, 0xffc37a, 3.2 * onScreen, 130);
    } else {
      world.flashLight(projectile.origin, 0xffe2a8, 1.6 * onScreen, 90);
    }
  }
  for (const effect of sim.effects) {
    if (seenEffectIds.has(effect.id)) continue;
    seenEffectIds.add(effect.id);
    if (effect.type === "blast") {
      sfx.explosion();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.blast, 1.5);
      const onScreen = stage.isInView(effect.to) ? 1 : 0.3;
      const size = Math.min(1, (effect.radius ?? 1) / 3);
      feel.addTrauma((0.18 + size * 0.2) * onScreen);
      const view = stage.viewState();
      feel.kick(effect.to, { x: view.x, z: view.z }, (0.9 + size * 1.6) * onScreen);
      stage.punch(0.25 * size * onScreen);
      world.flashLight(effect.to, 0xffa24d, (4.5 + size * 4) * onScreen, 260, 1.8);
    } else if (effect.type === "impact") {
      sfx.impact();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.impact, 0.9);
      if (stage.isInView(effect.to)) feel.addTrauma(0.05);
    } else if (effect.type === "bolt") {
      sfx.explosion();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.strike, 2);
      const onScreen = stage.isInView(effect.to) ? 1 : 0.3;
      feel.addTrauma(0.2 * onScreen);
      stage.punch(0.2 * onScreen);
      world.flashLight(effect.to, 0xd8ecff, 9 * onScreen, 140, 3);
    } else if (effect.type === "strike") {
      // A landed blow: the camera kicks away from the impact and the director looks at it. Same
      // sound as an impact for now -- the visual pass comes first.
      sfx.impact();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.impact, 1.2);
      const onScreen = stage.isInView(effect.to) ? 1 : 0.3;
      feel.addTrauma(0.12 * onScreen);
      const view = stage.viewState();
      feel.kick(effect.to, { x: view.x, z: view.z }, 1.1 * onScreen);
      stage.punch(0.12 * onScreen);
    } else if (effect.type === "topple") {
      sfx.crash();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.topple, 1.8);
      if (stage.isInView(effect.to)) feel.addTrauma(0.14);
    } else if (effect.type === "jet") {
      sfx.jet();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.strike, 2);
      feel.addTrauma(0.08);
    } else if (effect.type === "beam") {
      sfx.beam();
      resolveCam.note(effect.to.x, effect.to.z, POI_WEIGHT.strike, 2);
      feel.addTrauma(0.22);
      stage.punch(0.3);
    }
  }
  // Keep the seen-sets bounded by dropping ids no longer in play. A blind clear() would let a
  // projectile/effect that is still alive be re-seen next frame and replay its sound.
  if (seenProjectileIds.size > 500) {
    const live = new Set(sim.projectiles.map((p) => p.id));
    for (const id of seenProjectileIds) if (!live.has(id)) seenProjectileIds.delete(id);
  }
  if (seenEffectIds.size > 800) {
    const live = new Set(sim.effects.map((e) => e.id));
    for (const id of seenEffectIds) if (!live.has(id)) seenEffectIds.delete(id);
  }
}

function handleEndState(): void {
  if (sim.phase !== "victory" && sim.phase !== "defeat") {
    if (lastEndPhase) lastEndPhase = undefined;
    return;
  }
  if (lastEndPhase === sim.phase) return;
  lastEndPhase = sim.phase;
  const victory = sim.phase === "victory";
  if (victory) sfx.victory();
  else sfx.defeat();
  // Commander ledger: lifetime stats + medal checks for every real battle.
  if (!tutorialActive) {
    const killsByKind: Record<string, number> = {};
    for (const [id, count] of sim.killsBy) {
      const kind = sim.entity(id)?.kind ?? "unknown";
      killsByKind[kind] = (killsByKind[kind] ?? 0) + count;
    }
    const freshMedals = commander.recordBattle({
      victory,
      turns: sim.turn,
      losses: sim.playerLosses,
      killsByKind,
      toppleHappened: sim.toppled.size > 0,
    });
    for (const medal of freshMedals) showToast(`🎖 Medal earned — ${medal.name}: ${medal.blurb}`);
  }
  // Kill-cam: a 1.6s letterboxed zoom onto the decisive spot before the end screens land.
  if (!settings.reducedMotion) {
    const focusTarget = victory
      ? sim.entities.find((e) => e.kind === "base" && e.team === "enemy") ?? sim.entities.find((e) => e.team === "enemy" && !e.status.alive)
      : sim.entities.find((e) => e.kind === "base" && e.team === "player");
    if (focusTarget) {
      stage.guideTo({ focus: focusTarget.position, zoom: 0.62 }, { mode: "resolve", strength: 3.4, durationMs: 1500 });
      document.body.classList.add("killcam");
      const endPhase = sim.phase;
      window.setTimeout(() => {
        document.body.classList.remove("killcam");
        if (sim.phase === endPhase) concludeEndState(victory);
      }, 1600);
      return;
    }
  }
  concludeEndState(victory);
}

// The end-of-battle overlays/toasts, split out so the kill-cam can delay them.
function concludeEndState(victory: boolean): void {
  clearToasts(); // no lingering start-of-battle notice should overlap the end overlay
  // Campaign battles advance the story ladder and show their own end overlay.
  const mission = activeCampaignMission;
  if (mission) {
    if (victory) {
      const firstClear = !campaign.isCompleted(mission.id);
      // Optional objective: +50% mission reward when passed.
      const bonusPassed = mission.bonus
        ? (mission.bonus.check === "noLosses" ? sim.playerLosses === 0 : sim.turn <= (mission.bonus.turns ?? 8))
        : false;
      const bonusReward = bonusPassed ? Math.round(mission.reward * 0.5) : 0;
      const reward = (firstClear ? mission.reward : Math.round(mission.reward * 0.25)) + bonusReward + battleReward(true, sim.difficulty, sim.turn);
      // Veteran roster: survivors carry forward with their kills; the fallen are gone.
      campaign.recordBattleOutcome(collectSurvivors());
      campaign.markComplete(mission.id); // records progress + clears the active-mission save tag
      activeCampaignMission = undefined;
      progression.award(reward);
      showCampaignVictory(mission, reward, bonusPassed ? mission.bonus?.text : undefined);
    } else {
      showCampaignDefeat(mission); // keep the mission active so Retry re-runs it
    }
    return;
  }
  // Skirmish run: a cleared sector carries survivors + cash and advances; a loss ends the run.
  if (run.active) {
    if (victory) {
      const leftover = sim.economy.get("player") ?? 0;
      const reward = battleReward(true, sim.difficulty, sim.turn);
      progression.award(reward);
      const complete = run.advance(collectSurvivors(), leftover); // mutates roster/index BEFORE the overlay reads them
      if (complete) {
        const bonus = 120; // clearing the whole ladder is worth a chunk on top of the last battle
        progression.award(bonus);
        showRunComplete(reward + bonus);
      } else {
        showRunSector(reward);
      }
    } else {
      run.end();
      showRunDefeat();
    }
    return;
  }
  if (!tutorialActive) {
    const reward = battleReward(victory, sim.difficulty, sim.turn);
    progression.award(reward);
    showToast(`+${reward} points earned`);
  }
}

declare global {
  interface Window {
    __rht: {
      sim: TacticalSim;
      setIntent(intent: Intent): void;
      setAim(aim: AimMode): void;
      endTurn(): void;
      reset(): void;
      toMenu(): void;
      deselect(): void;
      chooseBoardEntity(id: string): void;
      queueDefend(stance?: "standing" | "crouched" | "prone"): void;
      queueMoveToCover(id: string): boolean;
      queueTakeCover(id: string): boolean;
      queueClimbCover(id: string): boolean;
      queueGrenadePart(id: string, partId: string): boolean;
      queueGrenadeAt(destination: Vec2): boolean;
      queueSmokeAt(destination: Vec2): boolean;
      queueBombDrop(): boolean;
      queueLoad(passengerId: string): boolean;
      queueUnload(destination: Vec2): boolean;
      queueShootAt(destination: Vec2): boolean;
      queueMelee(id: string): boolean;
      queueMeleePart(id: string, partId: string): boolean;
      queueSpawnTroop(kind: TroopKind): boolean;
      queueBuildStructure(point: Vec2): boolean;
      beginBuild(kind: DefenseKind): void;
      beginSupport(kind: SupportPowerKind): void;
      queueSupportAt(point: Vec2): boolean;
      queueOverwatch(): boolean;
      queueOverwatchToward(point: Vec2): boolean;
      queueCapture(id: string): boolean;
      queueMine(): boolean;
      queueRecon(): boolean;
      queueDeploy(): boolean;
      upgradeBaseIncome(): boolean;
      upgradeBaseCommand(): boolean;
      researchTech(nodeId: string): boolean;
      startBattle(mapId: string, modeId: ModeId, difficulty?: Difficulty): void;
      startRun(seed?: number): void;
      inspectPickup(id: string): void;
      money(team: Team): number;
      cancelOrder(id: string): void;
      camera(): { x: number; z: number; zoom: number; yaw: number; pitch: number };
      setView(view: { x?: number; z?: number; zoom?: number; yaw?: number; pitch?: number }): void;
      renderDebug(): WorldRenderDebug;
      // Debug scenario harness: cut straight to a staged battle state for tests/screenshots.
      scenario(id: string): boolean;
      scenarios(): Array<{ id: string; title: string; description: string }>;
      // Perf + bug harness: frame stats, anomaly scan, AI-readable scene, scene-graph size.
      perf(): PerfSnapshot;
      perfReset(): void;
      diagnostics(): DiagnosticsReport;
      describeScene(): SceneDescription;
      limbPose(entityId: string): { limb: string; rotX: number; rotY: number; posY: number; posZ: number }[];
      partColors(entityId: string): { partId: string; color: string; emissive: string; intensity: number }[];
      sceneGraph(): { total: number; topLevel: number };
      // The live Three scene root — QA probes census it (draw-work attribution).
      sceneRoot(): object;
      /** The live perspective camera (probes vary near/far to reproduce depth fights). */
      cameraObject(): object;
      viewState(): { x: number; z: number; zoom: number; yaw: number; pitch: number };
      sceneObject(): object;
      /** Re-run the shader warm-up with the resolve-only samplers; returns programs before/after. */
      warmUp(): { before: number; after: number };
      /** Cache keys of every compiled shader program — diff across a resolve to find compile hitches. */
      programs(): string[];
      /** Frames that threw since load. A smoke should assert 0. */
      frameErrors(): number;
      /** Multiplies the resolve-phase sim clock (filmstrips run at 0.25 to see a swing). */
      setResolveScale(scale: number): void;
      setDebugOverlay(on: boolean): boolean;
      // Black-silhouette mode: every unit renders as a flat black shape on white. The
      // "name each unit from its outline alone" test -- a recolour variant fails it instantly.
      silhouette(on: boolean): void;
      // Deterministic HUD geometry checks (overlap / truncation / clipping / occlusion).
      // Empty array is the assertion; smoke:ui-audit drives it across viewports and screens.
      auditUI(): UiFinding[];
      // Cosmetic toggles (skin pack + colorblind palette) for screenshot harnesses.
      setModelSkin(skin: string): void;
      setHighContrastTeams(on: boolean): void;
      // Dynamic map events: read current weather/zone state; force one for screenshots/tests.
      environment(): { sandstorm: number; ionstorm: number; notice?: string; zones: Array<{ kind: string; x: number; z: number; radius: number }> };
      forceEvent(kind: "sandstorm" | "barrage" | "collapse" | "ionstorm"): void;
      startCampaign(id: string): void;
      save(): boolean;
      // True when audio is silenced (settings mute or running under test automation).
      audioMuted(): boolean;
    };
  }
}

window.__rht = {
  sim,
  setIntent: (intent) => sim.setIntent(intent),
  setAim: (aim) => sim.setAim(aim),
  endTurn: () => { resolveCam.begin(stage.viewState()); sim.endTurn(); },
  reset: () => {
    hud.resetGame();
    lastCommandCameraKey = "";
  },
  // The title screen from ANY state (a battle, a sub-menu, an end screen) — what the UI shots and
  // the ui-audit mean by "title". reset() alone only restarts the sim.
  toMenu: () => showMainMenu(),
  deselect: () => sim.deselect(),
  chooseBoardEntity: (id) => hud.chooseBoardEntity(id),
  queueDefend: (stance) => sim.queueDefend(stance),
  queueMoveToCover: (id) => sim.queueMoveToCover(id),
  queueTakeCover: (id) => sim.queueTakeCover(id),
  queueClimbCover: (id) => sim.queueClimbCover(id),
  queueGrenadePart: (id, partId) => sim.queueGrenadePart(id, partId),
  queueGrenadeAt: (destination) => sim.queueGrenadeAt(destination),
  queueSmokeAt: (destination) => sim.queueSmokeAt(destination),
  queueBombDrop: () => sim.queueBombDrop(),
  queueLoad: (passengerId: string) => sim.queueLoad(passengerId),
  queueUnload: (destination) => sim.queueUnload(destination),
  queueShootAt: (destination) => sim.queueShootAt(destination),
  queueMelee: (id) => sim.queueMelee(id),
  queueMeleePart: (id, partId) => sim.queueMeleePart(id, partId),
  queueSpawnTroop: (kind) => sim.queueSpawnTroop(kind),
  queueBuildStructure: (point) => sim.queueBuildStructure(point),
  beginBuild: (kind) => sim.setPendingBuild(kind),
  beginSupport: (kind) => sim.setPendingSupport(kind),
  queueSupportAt: (point) => sim.queueSupportAt(point),
  queueOverwatch: () => sim.queueOverwatch(),
  queueOverwatchToward: (point) => sim.queueOverwatchToward(point),
  queueCapture: (id) => sim.queueCapture(id),
  queueMine: () => sim.queueMine(),
  queueRecon: () => sim.queueRecon(),
  queueDeploy: () => sim.queueDeploy(),
  upgradeBaseIncome: () => sim.upgradeBaseIncome(),
  upgradeBaseCommand: () => sim.upgradeBaseCommand(),
  researchTech: (nodeId) => sim.researchTech(nodeId),
  startBattle: (mapId, modeId, difficulty) => startBattle(mapId, modeId, difficulty),
  startRun: (seed?: number) => { run.begin(seed ?? 12345); startRunBattle(); },
  inspectPickup: (id: string) => inspectPickup(id),
  money: (team) => sim.money(team),
  cancelOrder: (id) => sim.cancelOrder(id),
  camera: () => stage.viewState(),
  setView: (view) => stage.debugSetView(view),
  viewState: () => stage.viewState(),
  renderDebug: () => world.debugState(),
  scenario: (id) => {
    closeAllMenus();
    if (!applyScenario(sim, id)) return false;
    tutorialActive = false;
    renderTutorialPanel(); // the panel leaked from a tutorial cut into every later scenario shot
    lastEndPhase = undefined; // let victory/defeat scenarios render their end screen
    world.applyMap(sim.mapDef.theme, [sim.mapDef.playerBase, sim.mapDef.enemyBase]);
    world.setPlayerAccent(progression.accentColor());
    const focus = sim.selected;
    if (focus) stage.focusOn(focus.position);
    else focusOnPlayerBase();
    hud.update();
    return true;
  },
  scenarios: () => scenarioInfo(),
  perf: () => perfSnapshot(),
  perfReset: () => perfMon.reset(),
  diagnostics: () => runSceneDiagnostics(),
  describeScene: () => buildSceneDescription(),
  limbPose: (entityId: string) => world.limbPose(entityId),
  partColors: (entityId: string) => world.partColors(entityId),
  sceneGraph: () => ({ total: countSceneObjects(), topLevel: stage.scene.children.length }),
  sceneRoot: () => stage.scene,
  cameraObject: () => stage.camera,
  sceneObject: () => stage.scene,
  warmUp: () => { const before = stage.renderer.info.programs?.length ?? 0; stage.warmUp([...loadedTemplates(), ...world.warmUpSamplers()]); return { before, after: stage.renderer.info.programs?.length ?? 0 }; },
  programs: () => (stage.renderer.info.programs ?? []).map((p) => String((p as unknown as { cacheKey: string }).cacheKey)),
  frameErrors: () => frameErrors,
  setResolveScale: (scale: number) => { resolveScale = scale; },
  setDebugOverlay: (on) => { debugOverlay.setEnabled(on); return debugOverlay.isEnabled(); },
  silhouette: (on) => { world.setSilhouette(on); stage.setSilhouette(on); },
  auditUI: () => auditUI(),
  setModelSkin: (skin: string) => setModelSkin(skin),
  setHighContrastTeams: (on: boolean) => world.setHighContrastTeams(on),
  environment: () => sim.environment(),
  forceEvent: (kind) => sim.debugForceEvent(kind),
  startCampaign: (id) => { const m = campaign.mission(id); if (m) startCampaignMission(m); },
  save: () => saveBattle(),
  audioMuted: () => sfx.isMuted,
};

// Text-content escaping reuses the attribute escaper (it already neutralizes < > & " ').
function escapeHtml(value: string): string {
  return escapeAttr(value);
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function syncCameraAssist(): void {
  if (sim.phase === "resolve") {
    const focus = resolveFocus ?? resolveFocusPoint();
    if (!focus) return;
    const view = stage.viewState();
    // PUSH IN on the action. At the planning zoom a firefight was two small figures trading
    // pixels at the edge of the board; the resolve is the payoff and it gets a closer camera.
    // The planning view is restored on TURN_START (below), so the player never has to zoom back.
    if (resolveEntryZoom === undefined) resolveEntryZoom = view.zoom;
    stage.guideTo({
      focus,
      zoom: Math.min(view.zoom, 0.72),
      pitch: Math.max(view.pitch, 0.62),
    }, { mode: "resolve", strength: 1.85, durationMs: 280 });
    lastCommandCameraKey = "";
    return;
  }

  if (sim.phase !== "command") {
    lastCommandCameraKey = "";
    return;
  }

  const actor = sim.selected;
  const target = sim.entity(hud.focusedTargetId ?? hud.hoveredTargetId);
  if (!actor || actor.team !== "player" || !target || target.team === "player") {
    lastCommandCameraKey = "";
    return;
  }

  const key = `${actor.id}:${target.id}:${hud.focusedPartId ?? ""}:${sim.intent}`;
  if (key === lastCommandCameraKey) return;
  lastCommandCameraKey = key;

  const separation = dist(actor.position, target.position);
  stage.guideTo({
    focus: midpoint(actor.position, target.position),
    zoom: separation > 9 ? 0.9 : 0.82,
    pitch: 0.68,
  }, { mode: "aim", strength: 2.7, durationMs: 1300 });
}

// Fallback framing for when the director has nothing to say (it is disabled by reduce-motion, or
// it is still yielding to a player who just panned). Averaging every live projectile is a decent
// default and a poor priority system: with two firefights it points the camera at the empty ground
// between them, and once a shell lands it forgets the kill immediately. That is what the director
// is for; this remains as the floor.
function resolveFocusPoint(): Vec2 | undefined {
  if (sim.projectiles.length) {
    let x = 0;
    let z = 0;
    let count = 0;
    for (const projectile of sim.projectiles.slice(0, 8)) {
      x += projectile.position.x + projectile.intendedPoint.x;
      z += projectile.position.z + projectile.intendedPoint.z;
      count += 2;
    }
    return count ? { x: x / count, z: z / count } : undefined;
  }

  const active = sim.orders.find((order) => !order.done);
  const actor = sim.entity(active?.actorId);
  const target = sim.entity(active?.targetId);
  if (actor && target) return midpoint(actor.position, target.position);
  if (actor && active?.destination) return midpoint(actor.position, active.destination);
  return undefined;
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}
