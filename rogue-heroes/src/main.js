import { BattleSim } from "./BattleSim.js";
import { BotAI } from "./BotAI.js";
import { BuildManager } from "./BuildManager.js";
import { Engine } from "./Engine.js";
import { initDevConsole } from "./DevConsole.js";
import { InputManager } from "./Input.js";
import { KingdomRenderer } from "./KingdomRenderer.js";
import { KingdomSim } from "./KingdomSim.js";
import { FORMATIONS } from "./defs.js";

const BUILD_SECONDS = 90;
const FACTORY_SECONDS = 10;

const canvas = document.getElementById("game");
const input = new InputManager(canvas);

let sim;
let build;
let botAI;
let battles;
let renderer;
let state = "build";
let buildTimer = BUILD_SECONDS;
let roundResults = [];
let defenseMatch = null;
let offenseMatch = null;
let queuedBotResults = [];
let battleSpeed = 1;
let selectedFormation = "line";
let techChoices = [];
let factoryTimer = FACTORY_SECONDS;
let factoryWatchId = 1;
let selectedTargetId = 1;
let battleNews = "";
let spyReport = null;
let mapExpanded = false;
let selectedBaseNodeId = null;
let selectedPrepBaseId = null;
let baseOrders = {};
let factoryTool = null;
let selectedFactoryItem = null;
let baseModalOpen = false;

function restart(seed = Date.now()) {
  sim = new KingdomSim(seed);
  build = new BuildManager(sim);
  botAI = new BotAI(sim);
  battles = { defense: new BattleSim(sim), offense: new BattleSim(sim) };
  renderer = new KingdomRenderer(canvas, input, sim, build, battles);
  state = "factorySetup";
  selectedBaseNodeId = sim.firstOwnedNode(0);
  selectedPrepBaseId = selectedBaseNodeId;
  build.setActiveBase(selectedBaseNodeId);
  buildTimer = BUILD_SECONDS;
  factoryTimer = FACTORY_SECONDS;
  roundResults = [];
  defenseMatch = null;
  offenseMatch = null;
  queuedBotResults = [];
  battleSpeed = 1;
  selectedFormation = "line";
  techChoices = [];
  factoryWatchId = 1;
  selectedTargetId = 1;
  battleNews = "";
  spyReport = null;
  mapExpanded = false;
  baseOrders = {};
  factoryTool = null;
  selectedFactoryItem = null;
  baseModalOpen = false;
}

function setState(next) {
  state = next;
}

function skipBuild() {
  buildTimer = 0;
  startFormation();
}

function startFactoryRun() {
  botAI.takeFactoryTurns();
  const others = sim.aliveKingdoms().filter((kingdom) => kingdom.id !== 0);
  factoryWatchId = others.length ? sim.rng.pick(others).id : 0;
  sim.startFactoryRun(factoryWatchId);
  factoryTimer = FACTORY_SECONDS;
  state = "factoryRun";
}

function startFormation() {
  if (sim.aliveKingdoms().length <= 1) return;
  sim.maybeReceiveAllianceOffer();
  const targets = sim.adjacentKingdomTargets(0, true).filter((kingdom) => kingdom.id !== 0 && !sim.areAllied(0, kingdom.id));
  selectedTargetId = targets[0]?.id ?? null;
  baseOrders = {};
  for (const node of sim.ownedNodes(0)) {
    const adjacent = sim.adjacentTargetNodesForBase(0, node.id);
    const army = sim.makeArmy(0, node.id);
    baseOrders[node.id] = adjacent.length && army.length
      ? { allocations: { [adjacent[0].id]: army.length }, reserve: 0, formation: selectedFormation }
      : { allocations: {}, reserve: army.length, formation: selectedFormation };
  }
  selectedPrepBaseId = sim.ownedNodes(0)[0]?.id || null;
  battleNews = sim.makeNewsSnippet();
  spyReport = null;
  state = "formation";
}

function beginRoundBattles() {
  botAI.takeBuildTurns();
  const orders = Object.fromEntries(Object.entries(baseOrders).map(([nodeId, order]) => [nodeId, { ...order, formation: selectedFormation }]));
  const matches = sim.chooseAttackPairs(orders);
  defenseMatch = matches.find((match) => match.defenderId === 0) || null;
  offenseMatch = matches.find((match) => match.attackerId === 0) || null;
  if (offenseMatch) offenseMatch.formation = selectedFormation;
  queuedBotResults = [];

  for (const match of matches) {
    if (match === defenseMatch || match === offenseMatch) continue;
    const resolver = new BattleSim(sim);
    queuedBotResults.push(resolver.fastResolve(match));
  }

  if (!defenseMatch && !offenseMatch) {
    finishRound([]);
    return;
  }
  if (defenseMatch) battles.defense.start(defenseMatch, true);
  if (offenseMatch) battles.offense.start(offenseMatch, true);
  battles.defense.speed = battleSpeed;
  battles.offense.speed = battleSpeed;
  state = "battle";
}

function finishRound(extraResults) {
  roundResults = [...extraResults, ...queuedBotResults].filter(Boolean);
  for (const result of roundResults) sim.applyBattleResult(result);
  const winner = sim.winner();
  if (winner && winner.id === 0) {
    state = "victory";
  } else if (sim.player.eliminated || sim.territoryCount(0) <= 0) {
    state = "defeat";
  } else {
    state = "results";
  }
}

function openTech() {
  techChoices = sim.getTechChoices(0);
  if (techChoices.length === 0) {
    nextRound();
    return;
  }
  state = "tech";
}

function chooseTech(id) {
  sim.applyTech(0, id);
  nextRound();
}

function nextRound() {
  sim.nextRound();
  selectedBaseNodeId = sim.ownedNodes(0).some((node) => node.id === selectedBaseNodeId) ? selectedBaseNodeId : sim.firstOwnedNode(0);
  selectedPrepBaseId = selectedBaseNodeId;
  if (selectedBaseNodeId) build.setActiveBase(selectedBaseNodeId);
  buildTimer = BUILD_SECONDS;
  factoryTimer = FACTORY_SECONDS;
  roundResults = [];
  queuedBotResults = [];
  defenseMatch = null;
  offenseMatch = null;
  state = "factorySetup";
}

function handleInput() {
  const button = renderer.hitButton();
  if (button) {
    if (mapExpanded && button.id !== "map_close") return;
    if (baseModalOpen && !(button.id === "base_modal_close" || button.id.startsWith("base_"))) return;
    if (button.id === "map_expand") {
      mapExpanded = true;
      selectedFactoryItem = null;
      factoryTool = null;
      build.selectedStructureId = null;
    }
    if (button.id === "map_close") mapExpanded = false;
    if (button.id === "base_more") baseModalOpen = true;
    if (button.id === "base_modal_close") baseModalOpen = false;
    if (button.id.startsWith("base_") && button.id !== "base_more" && button.id !== "base_modal_close" && state === "build") {
      selectedBaseNodeId = button.id.slice(5);
      if (build.setActiveBase(selectedBaseNodeId)) baseModalOpen = false;
    }
    if (button.id.startsWith("factory_tool_") && state === "factorySetup") {
      factoryTool = button.id.slice("factory_tool_".length);
      selectedFactoryItem = null;
    }
    if (button.id.startsWith("factory_") && !button.id.startsWith("factory_tool_") && state === "factorySetup") {
      sim.upgradeFactory(0, button.id.slice("factory_".length));
    }
    if (button.id.startsWith("sabotage_") && state === "factorySetup") {
      sim.sabotageFactory(Number(button.id.slice("sabotage_".length)));
    }
    if (button.id === "run_factory" && state === "factorySetup") startFactoryRun();
    if (button.id.startsWith("ally_") && state === "build") {
      const result = sim.offerAlliance(Number(button.id.slice(5)));
      if (result && !result.ok) build.setMessage(result.reason);
      else if (result) build.setMessage(result.accepted ? `Alliance formed with ${result.target}.` : `${result.target} refused the offer.`);
    }
    if (button.id.startsWith("tool_")) build.select(button.id.slice(5));
    if (button.id === "start_battle" && state === "build") startFormation();
    if (button.id.startsWith("formation_") && state === "formation") {
      selectedFormation = button.id.slice("formation_".length);
    }
    if (button.id.startsWith("target_") && state === "formation") {
      selectedTargetId = Number(button.id.slice("target_".length));
    }
    if (button.id.startsWith("prepbase_") && state === "formation") {
      selectedPrepBaseId = button.id.slice("prepbase_".length);
    }
    if (button.id.startsWith("order_defend_") && state === "formation") {
      const nodeId = button.id.slice("order_defend_".length);
      const armyCount = sim.makeArmy(0, nodeId).length;
      baseOrders[nodeId] = { allocations: {}, reserve: armyCount, formation: selectedFormation };
      selectedPrepBaseId = nodeId;
    }
    if (button.id.startsWith("ordertarget_") && state === "formation") {
      const [, source, target] = button.id.match(/^ordertarget_(.+?)_(.+)$/) || [];
      if (source && target) {
        const armyCount = sim.makeArmy(0, source).length;
        baseOrders[source] = { allocations: { [target]: armyCount }, reserve: 0, formation: selectedFormation };
        selectedPrepBaseId = source;
      }
    }
    if (button.id.startsWith("orderplus_") && state === "formation") adjustOrder(button.id, 1);
    if (button.id.startsWith("orderminus_") && state === "formation") adjustOrder(button.id, -1);
    if (button.id === "sell_structure" && state === "build") {
      const result = sim.sellStructure(0, build.selectedStructureId);
      build.setMessage(result.ok ? `Sold for ${result.refund} gold.` : result.reason);
      build.selectedStructureId = null;
    }
    if (button.id === "ally_accept" && state === "formation") {
      sim.respondAllianceOffer(true);
      battleNews = sim.makeNewsSnippet();
    }
    if (button.id === "ally_decline" && state === "formation") {
      sim.respondAllianceOffer(false);
      battleNews = sim.makeNewsSnippet();
    }
    if (button.id.startsWith("spy_") && state === "formation") {
      const result = sim.spyOnKingdom(Number(button.id.slice("spy_".length)));
      spyReport = result;
    }
    if (button.id === "launch_battle" && state === "formation") beginRoundBattles();
    if (button.id === "next_round" && state === "results") openTech();
    if (button.id.startsWith("tech_") && state === "tech") chooseTech(button.id.slice(5));
    if (button.id === "restart") restart(Date.now());
    if (button.id === "speed_1") setBattleSpeed(1);
    if (button.id === "speed_2") setBattleSpeed(2);
    if (button.id === "speed_4") setBattleSpeed(4);
    return;
  }

  if (mapExpanded || baseModalOpen) return;

  if (state === "factorySetup" && input.mouse.justClicked) {
    const factoryHit = renderer.hitFactory(input.mouse.x, input.mouse.y);
    if (factoryHit?.item) {
      selectedFactoryItem = factoryHit.item.id;
    } else if (factoryHit?.point) {
      if (selectedFactoryItem) {
        sim.moveFactoryItem(0, selectedFactoryItem, factoryHit.point.x, factoryHit.point.y);
        selectedFactoryItem = null;
      } else if (factoryTool) {
        const result = sim.addFactoryItem(0, factoryTool, factoryHit.point.x, factoryHit.point.y);
        if (!result.ok) build.setMessage(result.reason);
      }
    }
  }

  if (state === "build" && input.mouse.justClicked) {
    build.place(input.mouse.x, input.mouse.y);
  }

  if (state === "factorySetup") {
    if (input.pressed("enter") || input.pressed(" ")) startFactoryRun();
  } else if (state === "build") {
    const hotkeys = {
      "1": "wall",
      "2": "tower",
      "3": "barracks",
      "4": "trap",
      "5": "farm",
      "6": "guard_post",
      "7": "raider_camp",
      "8": "knight_stable",
      "9": "siege_yard",
    };
    for (const [key, type] of Object.entries(hotkeys)) {
      if (input.pressed(key)) build.select(type);
    }
    if (input.pressed("enter") || input.pressed(" ")) startFormation();
  } else if (state === "formation") {
    for (const key of Object.keys(FORMATIONS)) {
      if (input.pressed(key[0])) selectedFormation = key;
    }
    if (input.pressed("enter") || input.pressed(" ")) beginRoundBattles();
  }
}

function update(dt) {
  if (state === "factoryRun") {
    factoryTimer -= dt;
    if (sim.updateFactoryRun(dt) || factoryTimer <= 0) {
      state = "build";
      buildTimer = BUILD_SECONDS;
    }
  } else if (state === "build") {
    buildTimer -= dt;
    build.update(dt);
    if (buildTimer <= 0) startFormation();
  } else if (state === "battle") {
    battles.defense.update(dt);
    battles.offense.update(dt);
    const defenseDone = !defenseMatch || battles.defense.result;
    const offenseDone = !offenseMatch || battles.offense.result;
    if (defenseDone && offenseDone) {
      finishRound([battles.defense.result, battles.offense.result].filter(Boolean));
    }
  }
}

function render() {
  if (state === "factorySetup") renderer.drawFactorySetup(mapExpanded, factoryTool, selectedFactoryItem);
  else if (state === "factoryRun") renderer.drawFactoryRun(factoryWatchId, factoryTimer, FACTORY_SECONDS);
  else if (state === "build") renderer.drawBuild(buildTimer, mapExpanded, selectedBaseNodeId, baseModalOpen);
  else if (state === "formation") renderer.drawFormation(selectedFormation, selectedTargetId, battleNews, spyReport, mapExpanded, baseOrders, selectedPrepBaseId);
  else if (state === "battle") renderer.drawBattle();
  else if (state === "results") renderer.drawResults(roundResults, mapExpanded);
  else if (state === "tech") renderer.drawTech(techChoices);
  else if (state === "victory") renderer.drawEnd(true);
  else if (state === "defeat") renderer.drawEnd(false);
  handleInput();
  input.endFrame();
}

function adjustOrder(id, delta) {
  const [, source, target] = id.match(/^order(?:plus|minus)_(.+?)_(.+)$/) || [];
  if (!source || !target) return;
  const armyCount = sim.makeArmy(0, source).length;
  const order = baseOrders[source] || { allocations: {}, reserve: armyCount, formation: selectedFormation };
  order.allocations ||= {};
  order.reserve ??= Math.max(0, armyCount - Object.values(order.allocations).reduce((sum, value) => sum + value, 0));
  if (delta > 0 && order.reserve <= 0) return;
  const current = order.allocations[target] || 0;
  if (delta < 0 && current <= 0) return;
  order.allocations[target] = Math.max(0, current + delta);
  if (order.allocations[target] === 0) delete order.allocations[target];
  order.reserve = Math.max(0, Math.min(armyCount, order.reserve - delta));
  baseOrders[source] = order;
  selectedPrepBaseId = source;
}

function setBattleSpeed(speed) {
  battleSpeed = speed;
  battles.defense.speed = speed;
  battles.offense.speed = speed;
}

restart(12345);

initDevConsole({
  get state() { return state; },
  get buildTimer() { return buildTimer; },
  get factoryTimer() { return factoryTimer; },
  get sim() { return sim; },
  get build() { return build; },
  get battle() { return battles.defense; },
  get battles() { return battles; },
  get selectedFormation() { return selectedFormation; },
  get baseOrders() { return baseOrders; },
  get techChoices() { return techChoices; },
  restart,
  skipBuild,
  setState,
});

const engine = new Engine(update, render, () => state);
engine.start();
