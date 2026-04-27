import { BOARD_EDGES, BOARD_NODES, BUILD_DEFS, KINGDOM_COLORS, TECH_DEFS } from "./defs.js";
import { createRng } from "./rng.js";

const STARTING_GOLD = 70;
const BASE_INCOME = 8;
const ALLIANCE_COST = 18;
export const NEUTRAL_ID = 4;

const STARTING_OWNERS = {
  n0: 0,
  n3: 1,
  n10: 2,
  n11: 3,
};

const FACTORY_COSTS = {
  worker: (f) => 14 + factoryCount(f, "worker") * 4,
  machine: (f) => 24 + factoryCount(f, "machine") * 7,
  belt: (f) => 18 + factoryCount(f, "belt") * 6,
  quality: (f) => 28 + factoryCount(f, "quality") * 10,
};

export class KingdomSim {
  constructor(seed = Date.now()) {
    this.seed = seed;
    this.rng = createRng(seed);
    this.round = 1;
    this.phase = "build";
    this.log = [];
    this.kingdoms = [];
    this.nodes = BOARD_NODES.map((node) => ({ ...node, owner: STARTING_OWNERS[node.id] ?? NEUTRAL_ID }));
    this.edges = BOARD_EDGES;
    this.pendingMatches = [];
    this.lastResults = [];
    this.alliance = null;
    this.pendingAllianceOffer = null;
    this.factoryRun = null;
    this.initKingdoms();
  }

  initKingdoms() {
    const names = ["Player Kingdom", "Ash Court", "Sunmere", "Greenholt", "Neutral Holds"];
    this.kingdoms = names.map((name, index) => ({
      id: index,
      name,
      color: KINGDOM_COLORS[index],
      isPlayer: index === 0,
      isNeutral: index === NEUTRAL_ID,
      gold: index === NEUTRAL_ID ? 0 : STARTING_GOLD,
      eliminated: false,
      structures: [],
      nextStructureId: 1,
      nextFactoryId: 1,
      lastIncome: BASE_INCOME,
      lastFactoryIncome: 0,
      lastLandIncome: 0,
      lastOffensePenalty: 0,
      nextIncomePenalty: 0,
      factory: {
        quality: 1,
        sabotageTimer: 0,
        antiSabotage: false,
        items: [],
      },
      tech: {
        unlocked: new Set(["wall", "tower", "barracks", "trap", "farm", "guard_post", "raider_camp", "knight_stable", "siege_yard"]),
        taken: new Set(),
        mods: {
          structureHp: 0,
          arrowDamage: 0,
          offenseSpeed: 0,
          guardVeterans: false,
        },
      },
    }));

    for (const kingdom of this.kingdoms.filter((k) => !k.isNeutral)) {
      this.seedFactory(kingdom.id);
      const base = this.firstOwnedNode(kingdom.id);
      this.addStructure(kingdom.id, "tower", 520, 285, true, base);
      this.addStructure(kingdom.id, "guard_post", 450, 380, true, base);
      this.addStructure(kingdom.id, kingdom.isPlayer ? "farm" : "raider_camp", 610, 395, true, base);
      if (kingdom.isPlayer) this.addStructure(kingdom.id, "raider_camp", 705, 330, true, base);
    }
  }

  seedFactory(kingdomId) {
    const kingdom = this.kingdoms[kingdomId];
    if (!kingdom) return;
    for (let i = 0; i < 3; i++) this.addFactoryItem(kingdomId, "worker", 0.16, 0.28 + i * 0.18, true);
    this.addFactoryItem(kingdomId, "machine", 0.48, 0.42, true);
    this.addFactoryItem(kingdomId, "belt", 0.34, 0.62, true);
  }

  get player() {
    return this.kingdoms[0];
  }

  aliveKingdoms() {
    return this.kingdoms.filter((kingdom) => !kingdom.isNeutral && !kingdom.eliminated && this.territoryCount(kingdom.id) > 0);
  }

  playableKingdoms() {
    return this.kingdoms.filter((kingdom) => !kingdom.isNeutral);
  }

  nodeById(nodeId) {
    return this.nodes.find((node) => node.id === nodeId) || null;
  }

  ownedNodes(kingdomId) {
    return this.nodes.filter((node) => node.owner === kingdomId);
  }

  firstOwnedNode(kingdomId) {
    return this.ownedNodes(kingdomId)[0]?.id || null;
  }

  territoryCount(kingdomId) {
    return this.ownedNodes(kingdomId).length;
  }

  areNodesAdjacent(a, b) {
    return this.edges.some((edge) => (edge[0] === a && edge[1] === b) || (edge[0] === b && edge[1] === a));
  }

  adjacentNodes(nodeId) {
    return this.edges
      .filter((edge) => edge[0] === nodeId || edge[1] === nodeId)
      .map((edge) => (edge[0] === nodeId ? edge[1] : edge[0]))
      .map((id) => this.nodeById(id))
      .filter(Boolean);
  }

  touchesKingdom(a, b) {
    if (a === b) return false;
    return this.edges.some(([left, right]) => {
      const l = this.nodeById(left);
      const r = this.nodeById(right);
      return (l?.owner === a && r?.owner === b) || (l?.owner === b && r?.owner === a);
    });
  }

  adjacentTargetNodesForBase(kingdomId, nodeId) {
    return this.adjacentNodes(nodeId).filter((node) => {
      if (node.owner === kingdomId) return false;
      if (this.areAllied(kingdomId, node.owner)) return false;
      return true;
    });
  }

  adjacentKingdomTargets(kingdomId, includeNeutral = false) {
    const ids = new Set();
    for (const node of this.ownedNodes(kingdomId)) {
      for (const target of this.adjacentTargetNodesForBase(kingdomId, node.id)) {
        if (target.owner === NEUTRAL_ID && !includeNeutral) continue;
        ids.add(target.owner);
      }
    }
    return [...ids].map((id) => this.kingdoms[id]).filter(Boolean);
  }

  addStructure(kingdomId, type, x, y, free = false, nodeId = null) {
    const kingdom = this.kingdoms[kingdomId];
    const def = BUILD_DEFS[type];
    const baseNodeId = nodeId || this.firstOwnedNode(kingdomId);
    if (!kingdom || !def || !baseNodeId) return { ok: false, reason: "Invalid structure." };
    if (!free && !this.isBuildingUnlocked(kingdomId, type)) return { ok: false, reason: "Locked by tech." };
    if (!free && kingdom.gold < def.cost) return { ok: false, reason: "Not enough gold." };
    if (!free) kingdom.gold -= def.cost;
    const bonusHp = kingdom.tech?.mods?.structureHp || 0;
    kingdom.structures.push({
      id: `${kingdomId}-${kingdom.nextStructureId++}`,
      nodeId: baseNodeId,
      type,
      x,
      y,
      hp: def.hp + bonusHp,
      maxHp: def.hp + bonusHp,
      cooldown: 0,
      disabled: false,
    });
    return { ok: true };
  }

  structuresForNode(kingdomId, nodeId) {
    return this.kingdoms[kingdomId]?.structures.filter((structure) => structure.nodeId === nodeId) || [];
  }

  isBuildingUnlocked(kingdomId, type) {
    const kingdom = this.kingdoms[kingdomId];
    return !!kingdom?.tech?.unlocked?.has(type);
  }

  removeDestroyedStructures(kingdomId) {
    const kingdom = this.kingdoms[kingdomId];
    kingdom.structures = kingdom.structures.filter((structure) => {
      const def = BUILD_DEFS[structure.type];
      return structure.hp > 0 || def.singleUse;
    });
  }

  incomeFor(kingdomId) {
    const kingdom = this.kingdoms[kingdomId];
    const penalty = kingdom?.nextIncomePenalty || 0;
    return Math.max(0, BASE_INCOME + this.landIncomeFor(kingdomId) + this.factoryIncomeFor(kingdomId) - penalty);
  }

  landIncomeFor(kingdomId) {
    return this.nodes.reduce((sum, node) => sum + (node.owner === kingdomId ? node.income : 0), 0);
  }

  factoryIncomeFor(kingdomId) {
    const kingdom = this.kingdoms[kingdomId];
    if (!kingdom || kingdom.isNeutral) return 0;
    const f = kingdom.factory;
    const counts = this.factoryCounts(f);
    const structureEconomy = kingdom.structures.reduce((sum, structure) => {
      const def = BUILD_DEFS[structure.type];
      return sum + (def.income || 0);
    }, 0);
    const layout = this.factoryEfficiencyFor(kingdomId);
    const sabotageMult = f.sabotageTimer > 0 ? 0.62 : 1;
    const handoffBonus = this.factoryHandoffFor(kingdomId);
    const throughput = Math.max(1, counts.worker * 4) * (1 + counts.belt * 0.13) * handoffBonus;
    const partValue = 1 + counts.machine * 0.42 + counts.quality * 0.18;
    const farmSupport = Math.floor(structureEconomy * 0.55);
    return Math.max(0, Math.floor((throughput * partValue * f.quality * layout + farmSupport) * sabotageMult));
  }

  factoryCounts(factory) {
    return {
      worker: factoryCount(factory, "worker"),
      machine: factoryCount(factory, "machine"),
      belt: factoryCount(factory, "belt"),
      quality: factoryCount(factory, "quality"),
    };
  }

  factoryEfficiencyFor(kingdomId) {
    const factory = this.kingdoms[kingdomId]?.factory;
    if (!factory) return 1;
    const machines = factory.items.filter((item) => item.type === "machine");
    const belts = factory.items.filter((item) => item.type === "belt");
    const workers = factory.items.filter((item) => item.type === "worker");
    const quality = factory.items.filter((item) => item.type === "quality");
    const machineScore = machines.length
      ? machines.reduce((sum, item) => sum + (1 - Math.abs(item.x - 0.52)), 0) / machines.length
      : 0.55;
    const beltScore = Math.min(1, belts.length / Math.max(1, machines.length + 1));
    const workerReach = workers.length
      ? workers.reduce((sum, item) => sum + (item.x < 0.72 ? 1 : 0.65), 0) / workers.length
      : 0.5;
    const qualityBonus = Math.min(0.22, quality.length * 0.055);
    return Math.max(0.65, Math.min(1.55, 0.62 + machineScore * 0.28 + beltScore * 0.24 + workerReach * 0.18 + qualityBonus));
  }

  factoryHandoffFor(kingdomId) {
    const workers = this.kingdoms[kingdomId]?.factory.items.filter((item) => item.type === "worker").sort((a, b) => a.x - b.x) || [];
    if (workers.length < 2) return 1;
    let closePairs = 0;
    for (let i = 1; i < workers.length; i++) {
      const gap = workers[i].x - workers[i - 1].x;
      if (gap >= 0.08 && gap <= 0.28) closePairs++;
    }
    return 1 + Math.min(0.35, closePairs * 0.09);
  }

  factoryCost(type, kingdomId = 0) {
    const kingdom = this.kingdoms[kingdomId];
    return FACTORY_COSTS[type]?.(kingdom.factory) || 0;
  }

  addFactoryItem(kingdomId, type, x = 0.2, y = 0.5, free = false) {
    const kingdom = this.kingdoms[kingdomId];
    if (!kingdom || kingdom.eliminated || kingdom.isNeutral) return { ok: false, reason: "Invalid kingdom." };
    const cost = this.factoryCost(type, kingdomId);
    if (!free && kingdom.gold < cost) return { ok: false, reason: "Not enough gold." };
    if (!free) kingdom.gold -= cost;
    const item = {
      id: `${kingdomId}-f${kingdom.nextFactoryId++}`,
      type,
      x: clamp(x, 0.06, 0.94),
      y: clamp(y, 0.12, 0.88),
    };
    kingdom.factory.items.push(item);
    if (type === "quality") kingdom.factory.quality = Math.round((kingdom.factory.quality + 0.08) * 100) / 100;
    return { ok: true, item, cost };
  }

  moveFactoryItem(kingdomId, itemId, x, y) {
    const item = this.kingdoms[kingdomId]?.factory.items.find((candidate) => candidate.id === itemId);
    if (!item) return false;
    item.x = clamp(x, 0.06, 0.94);
    item.y = clamp(y, 0.12, 0.88);
    return true;
  }

  upgradeFactory(kingdomId, type) {
    const map = { workers: "worker", machines: "machine", logistics: "belt", quality: "quality" };
    const itemType = map[type] || type;
    return this.addFactoryItem(kingdomId, itemType, 0.2 + this.rng.next() * 0.52, 0.22 + this.rng.next() * 0.52);
  }

  sabotageFactory(targetId) {
    const target = this.kingdoms[targetId];
    if (!target || target.eliminated || target.id === 0 || target.isNeutral) return { ok: false, reason: "Invalid target." };
    if (!this.touchesKingdom(0, targetId)) return { ok: false, reason: "Sabotage only works against touching kingdoms." };
    if (this.player.gold < 16) return { ok: false, reason: "Need 16 gold." };
    this.player.gold -= 16;
    target.factory.sabotageTimer = target.factory.antiSabotage ? 1 : 2;
    return { ok: true, target: target.name };
  }

  spyOnKingdom(targetId) {
    const target = this.kingdoms[targetId];
    if (!target || target.id === 0 || target.eliminated || target.isNeutral) return { ok: false, reason: "Invalid spy target." };
    if (this.player.gold < 28) return { ok: false, reason: "Need 28 gold." };
    this.player.gold -= 28;
    const touchedBase = this.ownedNodes(targetId).find((node) => this.adjacentNodes(node.id).some((adj) => adj.owner === 0));
    return {
      ok: true,
      target: target.name,
      node: touchedBase?.name || "frontier base",
      structures: this.structuresForNode(targetId, touchedBase?.id).map((s) => BUILD_DEFS[s.type]?.name || s.type),
      defenders: this.makeDefenders(targetId, touchedBase?.id),
    };
  }

  botFactoryUpgrades() {
    for (const kingdom of this.kingdoms) {
      if (kingdom.isPlayer || kingdom.eliminated || kingdom.isNeutral) continue;
      const choices = ["worker", "machine", "belt", "quality"];
      for (let i = 0; i < 2; i++) this.addFactoryItem(kingdom.id, this.rng.pick(choices), this.rng.next(), this.rng.next());
    }
  }

  startFactoryRun(watchOtherId) {
    const outputs = {};
    const delivered = {};
    for (const kingdom of this.aliveKingdoms()) {
      outputs[kingdom.id] = this.factoryIncomeFor(kingdom.id);
      delivered[kingdom.id] = 0;
    }
    this.factoryRun = {
      t: 0,
      duration: 10,
      watchOtherId,
      outputs,
      delivered,
      completed: false,
    };
    return this.factoryRun;
  }

  factoryRunProgressFor(kingdomId) {
    const run = this.factoryRun;
    if (!run) return { target: this.factoryIncomeFor(kingdomId), delivered: 0, progress: 0 };
    const progress = clamp(run.t / run.duration, 0, 1);
    return {
      target: run.outputs[kingdomId] || 0,
      delivered: run.delivered[kingdomId] || 0,
      progress,
    };
  }

  updateFactoryRun(dt) {
    if (!this.factoryRun || this.factoryRun.completed) return false;
    this.factoryRun.t += dt;
    const progress = clamp(this.factoryRun.t / this.factoryRun.duration, 0, 1);
    for (const kingdom of this.aliveKingdoms()) {
      const target = this.factoryRun.outputs[kingdom.id] || 0;
      this.factoryRun.delivered[kingdom.id] = Math.min(target, Math.floor(target * progress));
    }
    if (this.factoryRun.t >= this.factoryRun.duration) {
      this.grantRoundIncome(this.factoryRun.delivered);
      this.factoryRun.completed = true;
      return true;
    }
    return false;
  }

  grantRoundIncome(factoryOutputs = null) {
    for (const kingdom of this.aliveKingdoms()) {
      const land = BASE_INCOME + this.landIncomeFor(kingdom.id);
      const factory = factoryOutputs ? factoryOutputs[kingdom.id] || 0 : this.factoryIncomeFor(kingdom.id);
      const penalty = kingdom.nextIncomePenalty || 0;
      const income = Math.max(0, land + factory - penalty);
      kingdom.gold += income;
      kingdom.lastIncome = income;
      kingdom.lastLandIncome = land;
      kingdom.lastFactoryIncome = factory;
      kingdom.lastOffensePenalty = penalty;
      kingdom.nextIncomePenalty = 0;
      kingdom.factory.sabotageTimer = Math.max(0, kingdom.factory.sabotageTimer - 1);
    }
  }

  makeArmy(kingdomId, nodeId = null) {
    const structures = nodeId ? this.structuresForNode(kingdomId, nodeId) : this.kingdoms[kingdomId].structures;
    const army = [];
    for (const structure of structures) {
      const def = BUILD_DEFS[structure.type];
      if (!def.army) continue;
      for (let i = 0; i < def.armyCount; i++) army.push(def.army);
    }
    return army;
  }

  makeDefenders(kingdomId, nodeId = null, includeOffense = false) {
    if (kingdomId === NEUTRAL_ID) return ["guard", "archer"];
    const structures = nodeId ? this.structuresForNode(kingdomId, nodeId) : this.kingdoms[kingdomId].structures;
    const defenders = [];
    for (const structure of structures) {
      const def = BUILD_DEFS[structure.type];
      if (def.spawn) {
        for (let i = 0; i < def.spawnCount; i++) defenders.push(def.spawn);
      }
      if (includeOffense && def.army) {
        for (let i = 0; i < def.armyCount; i++) defenders.push(def.army);
      }
    }
    defenders.push("archer");
    return defenders;
  }

  getTechChoices(kingdomId = 0) {
    const kingdom = this.kingdoms[kingdomId];
    const taken = kingdom.tech.taken;
    const choices = Object.values(TECH_DEFS).filter((tech) => {
      if (taken.has(tech.id)) return false;
      if (tech.apply === "unlock_building" && kingdom.tech.unlocked.has(tech.building)) return false;
      return true;
    });
    const picked = [];
    while (picked.length < 3 && choices.length > 0) {
      const index = this.rng.int(0, choices.length - 1);
      picked.push(choices.splice(index, 1)[0]);
    }
    return picked;
  }

  applyTech(kingdomId, techId) {
    const kingdom = this.kingdoms[kingdomId];
    const tech = TECH_DEFS[techId];
    if (!kingdom || !tech || kingdom.tech.taken.has(techId)) return false;
    kingdom.tech.taken.add(techId);
    if (tech.apply === "unlock_building") kingdom.tech.unlocked.add(tech.building);
    if (tech.apply === "structure_hp") {
      kingdom.tech.mods.structureHp += tech.amount;
      for (const structure of kingdom.structures) {
        structure.maxHp += tech.amount;
        structure.hp += tech.amount;
      }
    }
    if (tech.apply === "arrow_damage") kingdom.tech.mods.arrowDamage += tech.amount;
    if (tech.apply === "offense_speed") kingdom.tech.mods.offenseSpeed += tech.amount;
    if (tech.apply === "guard_veterans") kingdom.tech.mods.guardVeterans = true;
    if (tech.apply === "factory_workers") {
      for (let i = 0; i < tech.amount; i++) this.addFactoryItem(kingdomId, "worker", 0.18, 0.25 + i * 0.14, true);
    }
    if (tech.apply === "factory_machines") {
      this.addFactoryItem(kingdomId, "machine", 0.52, 0.42, true);
      kingdom.factory.quality = Math.round((kingdom.factory.quality + 0.1) * 100) / 100;
    }
    if (tech.apply === "factory_logistics") {
      for (let i = 0; i < tech.amount; i++) this.addFactoryItem(kingdomId, "belt", 0.35 + i * 0.12, 0.65, true);
    }
    if (tech.apply === "anti_sabotage") kingdom.factory.antiSabotage = true;
    return true;
  }

  chooseAttackPairs(playerOrders = {}) {
    const matches = [];
    const defenseOrders = new Set(Object.entries(playerOrders).filter(([, order]) => order?.action === "defend").map(([nodeId]) => nodeId));

    for (const [nodeId, order] of Object.entries(playerOrders)) {
      if (!order || order.action !== "attack") continue;
      const source = this.nodeById(nodeId);
      const target = this.nodeById(order.targetNodeId);
      if (!source || !target || source.owner !== 0 || !this.areNodesAdjacent(source.id, target.id) || this.areAllied(source.owner, target.owner)) continue;
      const army = this.makeArmy(0, source.id);
      if (army.length === 0) continue;
      matches.push({
        attackerId: 0,
        defenderId: target.owner,
        attackerNodeId: source.id,
        defenderNodeId: target.id,
        targetNodeId: target.id,
        army,
        formation: order.formation || "line",
      });
    }

    for (const kingdom of this.aliveKingdoms().filter((k) => k.id !== 0)) {
      for (const node of this.ownedNodes(kingdom.id)) {
        const targets = this.adjacentTargetNodesForBase(kingdom.id, node.id);
        if (!targets.length || this.rng.next() < 0.42) continue;
        const target = this.rng.pick(targets);
        const army = this.makeArmy(kingdom.id, node.id);
        if (!army.length) continue;
        matches.push({
          attackerId: kingdom.id,
          defenderId: target.owner,
          attackerNodeId: node.id,
          defenderNodeId: target.id,
          targetNodeId: target.id,
          army,
          formation: this.rng.pick(["line", "wedge", "column", "scatter"]),
          defenderUsesOffense: target.owner === 0 && defenseOrders.has(target.id),
        });
      }
    }

    this.pendingMatches = matches;
    return matches;
  }

  makeNewsSnippet() {
    if (this.pendingAllianceOffer) {
      const from = this.kingdoms[this.pendingAllianceOffer.fromId];
      return `${from.name} sent an alliance offer. Accepting prevents mutual attacks this round, but blocks attacks into their border too.`;
    }
    if (this.alliance?.round === this.round) {
      const ally = this.kingdoms[this.alliance.b];
      return `Court rumor: ${ally.name} signed a temporary pact with Player Kingdom. Their banners should not clash this round.`;
    }
    const living = this.aliveKingdoms().filter((k) => k.id !== 0);
    const frontier = living.filter((k) => this.touchesKingdom(0, k.id));
    const biggestArmy = frontier
      .map((k) => ({ kingdom: k, size: this.ownedNodes(k.id).reduce((sum, node) => sum + this.makeArmy(k.id, node.id).length, 0) }))
      .sort((a, b) => b.size - a.size)[0];
    if (biggestArmy && biggestArmy.size >= 4) return `Scout report: ${biggestArmy.kingdom.name} has invested heavily in frontier offense and fields ${biggestArmy.size} attackers.`;
    const rich = living.sort((a, b) => this.incomeFor(b.id) - this.incomeFor(a.id))[0];
    if (rich) return `Market whisper: ${rich.name} is flush with production income and may snowball if ignored.`;
    return "Quiet borders: no clear war pattern has emerged this round.";
  }

  maybeReceiveAllianceOffer() {
    if (this.alliance?.round === this.round || this.pendingAllianceOffer || this.aliveKingdoms().length <= 2) return null;
    const candidates = this.adjacentKingdomTargets(0).filter((kingdom) => kingdom.id !== NEUTRAL_ID);
    if (!candidates.length) return null;
    if (this.rng.next() > 0.55) return null;
    const from = this.rng.pick(candidates);
    this.pendingAllianceOffer = { fromId: from.id, round: this.round };
    this.log.unshift(`${from.name} offered you a one-round alliance.`);
    return this.pendingAllianceOffer;
  }

  respondAllianceOffer(accept) {
    if (!this.pendingAllianceOffer) return { ok: false, reason: "No offer pending." };
    const fromId = this.pendingAllianceOffer.fromId;
    const from = this.kingdoms[fromId];
    this.pendingAllianceOffer = null;
    if (accept) {
      this.alliance = { a: 0, b: fromId, round: this.round };
      this.log.unshift(`You accepted ${from.name}'s alliance offer.`);
      return { ok: true, accepted: true, target: from.name };
    }
    this.log.unshift(`You refused ${from.name}'s alliance offer.`);
    return { ok: true, accepted: false, target: from.name };
  }

  areAllied(a, b) {
    if (a === NEUTRAL_ID || b === NEUTRAL_ID) return false;
    return !!this.alliance && this.alliance.round === this.round && ((this.alliance.a === a && this.alliance.b === b) || (this.alliance.a === b && this.alliance.b === a));
  }

  offerAlliance(targetId) {
    const target = this.kingdoms[targetId];
    if (this.aliveKingdoms().length <= 2) return { ok: false, reason: "Only possible with 3+ kingdoms alive." };
    if (!target || target.id === 0 || target.eliminated || target.isNeutral) return { ok: false, reason: "Invalid ally." };
    if (!this.touchesKingdom(0, targetId)) return { ok: false, reason: "Alliances can only be offered across touching borders." };
    if (this.alliance?.round === this.round) return { ok: false, reason: "Already allied this round." };
    if (this.player.gold < ALLIANCE_COST) return { ok: false, reason: `Need ${ALLIANCE_COST} gold.` };
    this.player.gold -= ALLIANCE_COST;
    const pressure = this.territoryCount(targetId) <= 2 ? 0.2 : 0;
    const playerLeadPenalty = this.territoryCount(0) > this.territoryCount(targetId) ? -0.12 : 0;
    const acceptChance = 0.68 + pressure + playerLeadPenalty;
    if (this.rng.next() <= acceptChance) {
      this.alliance = { a: 0, b: targetId, round: this.round };
      this.log.unshift(`${target.name} accepted your alliance for this round.`);
      return { ok: true, accepted: true, target: target.name };
    }
    this.log.unshift(`${target.name} refused your alliance gift.`);
    return { ok: true, accepted: false, target: target.name };
  }

  applyBattleResult(result) {
    const attacker = this.kingdoms[result.attackerId];
    const defender = this.kingdoms[result.defenderId];
    if (!attacker || !defender) return 0;
    let territoryDelta = 0;

    const starting = result.startingAttackers || result.survivingAttackers || 0;
    const lost = Math.max(0, starting - (result.survivingAttackers || 0));
    if (!attacker.isNeutral) attacker.nextIncomePenalty += Math.min(14, lost * 2);

    if (result.winner === "attacker") {
      territoryDelta = 1;
      this.captureNode(result.defenderNodeId || result.targetNodeId, attacker.id);
      this.log.unshift(`${attacker.name} seized ${this.nodeById(result.defenderNodeId)?.name || "one territory"} from ${defender.name}.`);
    } else {
      this.log.unshift(`${defender.name} held ${this.nodeById(result.defenderNodeId)?.name || "their base"} against ${attacker.name}.`);
    }

    if (result.structureStates && !defender.isNeutral) {
      for (const state of result.structureStates) {
        const structure = defender.structures.find((candidate) => candidate.id === state.id);
        if (structure) structure.hp = Math.max(0, state.hp);
      }
      this.removeDestroyedStructures(defender.id);
    }
    this.updateEliminations();
    return territoryDelta;
  }

  captureNode(nodeId, toId) {
    const node = this.nodeById(nodeId);
    if (!node) return;
    const fromId = node.owner;
    node.owner = toId;
    if (fromId !== toId && fromId !== NEUTRAL_ID) {
      const oldOwner = this.kingdoms[fromId];
      for (const structure of oldOwner.structures.filter((s) => s.nodeId === nodeId)) {
        structure.nodeId = this.firstOwnedNode(fromId) || nodeId;
      }
    }
  }

  updateEliminations() {
    for (const kingdom of this.kingdoms) {
      if (kingdom.isNeutral) continue;
      kingdom.eliminated = this.territoryCount(kingdom.id) <= 0;
    }
  }

  winner() {
    const alive = this.aliveKingdoms();
    if (alive.length === 1 && this.territoryCount(NEUTRAL_ID) === 0) return alive[0];
    return null;
  }

  nextRound() {
    this.round += 1;
    this.alliance = null;
    this.pendingAllianceOffer = null;
    this.factoryRun = null;
  }

  snapshot() {
    return {
      seed: this.seed,
      round: this.round,
      kingdoms: this.kingdoms.map((kingdom) => ({
        id: kingdom.id,
        name: kingdom.name,
        gold: kingdom.gold,
        territories: this.territoryCount(kingdom.id),
        structures: kingdom.structures.length,
        eliminated: kingdom.eliminated,
        factory: { ...kingdom.factory, items: kingdom.factory.items.map((item) => ({ ...item })) },
        landIncome: this.landIncomeFor(kingdom.id),
        factoryIncome: this.factoryIncomeFor(kingdom.id),
        offensePenalty: kingdom.nextIncomePenalty,
        tech: [...kingdom.tech.taken],
        unlocked: [...kingdom.tech.unlocked],
      })),
      nodes: this.nodes.map((node) => ({ id: node.id, owner: node.owner, income: node.income })),
      alliance: this.alliance,
      pendingAllianceOffer: this.pendingAllianceOffer,
    };
  }
}

function factoryCount(factory, type) {
  return factory.items.filter((item) => item.type === type).length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
