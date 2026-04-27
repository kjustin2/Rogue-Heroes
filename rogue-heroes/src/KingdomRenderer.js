import { BOARD_EDGES, BUILD_DEFS, FORMATIONS, KINGDOM_COLORS, UNIT_DEFS } from "./defs.js";
import { CORE, FIELD } from "./BattleSim.js";

const STRUCTURE_COLORS = {
  wall: ["#8d98a8", "#4e5665"],
  tower: ["#7bd7ff", "#2077c7"],
  barracks: ["#ffb15d", "#8f5129"],
  trap: ["#ff5570", "#9d253b"],
  farm: ["#90ef84", "#328a45"],
  guard_post: ["#b7f179", "#5c8f37"],
  raider_camp: ["#ff895c", "#b7472d"],
  knight_stable: ["#ffe27b", "#a98724"],
  siege_yard: ["#e694ff", "#7943ac"],
  beam_obelisk: ["#8be9ff", "#215c89"],
  nova_shrine: ["#d98cff", "#66308f"],
  ranger_range: ["#ffe07a", "#9b7b23"],
  arcanum: ["#ff8be8", "#7b2e76"],
};

const UNIT_COLORS = {
  guard: "#8cffaa",
  archer: "#b9ff73",
  raider: "#ff8d62",
  knight: "#ffd766",
  siege: "#e89cff",
  ranger: "#ffd27b",
  mage: "#ff8be8",
};

export class KingdomRenderer {
  constructor(canvas, input, sim, build, battles) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.input = input;
    this.sim = sim;
    this.build = build;
    this.battles = battles;
    this.buttons = [];
    this.toolButtons = [];
    this.tooltip = null;
    this.time = 0;
  }

  resize() {
    const dpr = 1;
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.updateBuildBounds();
  }

  updateBuildBounds() {
    if (!this.build || !this.build.setScreenBounds) return;
    const leftW = Math.min(280, Math.max(220, this.width * 0.19));
    const toolW = 288;
    const x = leftW + 48;
    const y = 96;
    const w = Math.max(420, this.width - x - toolW - 34);
    const h = Math.max(430, this.height - y - 28);
    this.build.setScreenBounds({ x, y, w, h });
  }

  beginFrame(lowFx = false) {
    this.resize();
    this.lowFx = lowFx;
    this.time = performance.now() / 1000;
    this.buttons = [];
    this.toolButtons = [];
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    const bg = ctx.createLinearGradient(0, 0, this.width, this.height);
    bg.addColorStop(0, "#171b2b");
    bg.addColorStop(0.45, "#10151f");
    bg.addColorStop(1, "#241827");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!lowFx) {
      this.drawAmbientGrid();
      this.drawGlow(this.width * 0.18, this.height * 0.15, 180, "rgba(87, 177, 255, 0.15)");
      this.drawGlow(this.width * 0.9, this.height * 0.82, 220, "rgba(255, 89, 112, 0.12)");
    }
  }

  drawBuild(timer, mapExpanded = false, selectedBaseNodeId = null, baseModalOpen = false) {
    this.beginFrame();
    this.drawTopBar("Build The Kingdom", `Round ${this.sim.round}  |  Spend on offense, defense, and diplomacy  |  Battle in ${Math.ceil(timer)}s`);
    this.drawGoldBadge(this.width - 470, 18);
    this.drawBuildLayout(selectedBaseNodeId);
    this.drawButton("start_battle", "START BATTLE", this.width - 186, 22, 158, 42, "#21c886", "#0d6a55");
    if (mapExpanded) this.drawMapOverlay();
    if (baseModalOpen) this.drawBaseModal(selectedBaseNodeId);
    this.drawTooltip();
  }

  drawFactorySetup(mapExpanded = false, factoryTool = null, selectedFactoryItem = null) {
    this.beginFrame();
    this.drawTopBar("Factory Setup", "Upgrade your production floor, hire workers, or sabotage a rival before spending on war");
    this.drawGoldBadge(this.width - 390, 18);
    this.drawButton("map_expand", "MAP", this.width - 164, 22, 58, 36, "#33465f", "#1b2636");
    const sideW = 330;
    const player = this.sim.player;
    this.drawFactoryPanel(player, 34, 104, this.width - sideW - 68, this.height - 132, true, this.time, selectedFactoryItem, factoryTool);
    const rightX = this.width - sideW - 24;
    this.drawGlassPanel(rightX, 104, sideW, this.height - 132, "#151f2b");
    const ctx = this.ctx;
    this.drawPanelTitle(rightX + 24, 146, "Factory Controls", "Select a tool, then click the factory floor to place it.");
    this.drawPlacementHint(rightX + 24, 188, sideW - 48, factoryTool, selectedFactoryItem);
    const options = [
      ["worker", "Place Worker", "Workers push parts along the line."],
      ["machine", "Place Machine", "Machines convert parts into gold pieces."],
      ["belt", "Place Belt", "Belts speed parts toward the treasury."],
      ["quality", "Place Inspector", "Quality stations multiply output."],
    ];
    let y = 274;
    for (const [id, label, desc] of options) {
      const cost = this.sim.factoryCost(id, 0);
      this.drawFactoryToolCard(`factory_tool_${id}`, id, label, desc, cost, rightX + 24, y, sideW - 48, 58, factoryTool === id);
      y += 66;
    }
    ctx.fillStyle = "#ffb56b";
    ctx.font = "900 16px ui-sans-serif";
    ctx.fillText("Sabotage Frontier Factory", rightX + 24, y + 20);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText("Only touching kingdoms can be sabotaged.", rightX + 24, y + 38);
    y += 56;
    for (const kingdom of this.sim.adjacentKingdomTargets(0).filter((k) => k.id !== 0)) {
      const slow = kingdom.factory.sabotageTimer > 0 ? " (slowed)" : "";
      this.drawButton(`sabotage_${kingdom.id}`, `${kingdom.name}${slow}  16g`, rightX + 24, y, sideW - 48, 36, "#ff655d", "#93323a");
      y += 48;
    }
    this.drawButton("run_factory", "RUN FACTORIES", rightX + 24, this.height - 82, sideW - 48, 48, "#21c886", "#0d6a55");
    if (mapExpanded) this.drawMapOverlay();
    this.drawTooltip();
  }

  drawFactoryRun(watchId, timer, maxTimer) {
    this.beginFrame(true);
    this.drawTopBar("Factory Run", "Workers produce gold for the upcoming build phase");
    const left = { x: 24, y: 106, w: (this.width - 66) / 2, h: this.height - 142 };
    const right = { x: left.x + left.w + 18, y: 106, w: left.w, h: left.h };
    this.drawFactoryPanel(this.sim.player, left.x, left.y, left.w, left.h, false, maxTimer - timer);
    this.drawFactoryPanel(this.sim.kingdoms[watchId] || this.sim.player, right.x, right.y, right.w, right.h, false, maxTimer - timer);
    const ctx = this.ctx;
    const p = 1 - timer / maxTimer;
    drawFastBar(ctx, this.width / 2 - 220, this.height - 44, 440, 12, p, "#7cff9d");
    ctx.fillStyle = "#dce6f6";
    ctx.font = "900 14px ui-sans-serif";
    ctx.fillText(`Production ends in ${Math.max(0, Math.ceil(timer))}s`, this.width / 2 - 88, this.height - 54);
    this.drawTooltip();
  }

  drawBattle() {
    this.beginFrame(true);
    this.drawTopBar("War Round Live", "Your defense and your offense resolve at the same time");
    this.drawDualBattles();
    this.drawBattleSummary();
    const speed = this.battles.defense.speed || this.battles.offense.speed || 1;
    this.drawButton("speed_1", "1x", this.width - 180, 24, 44, 36, speed === 1 ? "#21c886" : "#273246");
    this.drawButton("speed_2", "2x", this.width - 128, 24, 44, 36, speed === 2 ? "#21c886" : "#273246");
    this.drawButton("speed_4", "4x", this.width - 76, 24, 44, 36, speed === 4 ? "#21c886" : "#273246");
    this.drawTooltip();
  }

  drawBattleSummary() {
    const ctx = this.ctx;
    const matches = (this.sim.pendingMatches || []).filter((match) => match.attackerId === 0 || match.defenderId === 0);
    const w = Math.min(680, this.width - 420);
    const x = 210;
    const y = this.height - 84;
    ctx.fillStyle = "rgba(7, 11, 18, 0.78)";
    roundedRect(ctx, x, y, w, 54, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 12px ui-sans-serif";
    ctx.fillText("YOUR FRONTIER BATTLES", x + 14, y + 20);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 11px ui-sans-serif";
    const text = matches.slice(0, 4).map((match) => {
      const area = this.sim.nodeById(match.targetNodeId || match.defenderNodeId)?.name || "frontier";
      return match.attackerId === 0 ? `Attack ${area} (${match.army.length})` : `Defend ${area}`;
    }).join("  |  ") || "No direct battles for your kingdom.";
    ctx.fillText(text, x + 14, y + 40);
  }

  drawFormation(selectedFormation, selectedTargetId, news, spyReport, mapExpanded = false, baseOrders = {}, selectedPrepBaseId = null) {
    this.beginFrame();
    this.drawTopBar("Battle Prep", "Pick your target, choose formation, read the room, and optionally spy before the war starts");
    this.drawButton("map_expand", "MAP", this.width - 284, 22, 58, 36, "#33465f", "#1b2636");
    const army = this.sim.makeArmy(0);
    this.drawGlassPanel(32, 112, 320, 332, "#141d29");
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 20px ui-sans-serif";
    ctx.fillText("Your Army", 56, 150);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "800 13px ui-sans-serif";
    ctx.fillText(unitSummary(army), 56, 180);
    ctx.fillStyle = "#7de7a5";
    wrapText(ctx, "Formation changes where units start and how concentrated the first push is.", 56, 216, 250, 18);
    ctx.fillStyle = "#aebbd0";
    wrapText(ctx, "Line spreads pressure. Wedge punches toward the core. Column protects siege. Scatter avoids traps and beams.", 56, 270, 250, 18);
    ctx.fillStyle = "#ffcf6c";
    ctx.font = "900 13px ui-sans-serif";
    ctx.fillText("NEWS", 56, 334);
    ctx.fillStyle = "#dce6f6";
    ctx.font = "700 12px ui-sans-serif";
    wrapText(ctx, news || "No reports this round.", 56, 356, 250, 16);

    let x = 390;
    for (const formation of Object.values(FORMATIONS)) {
      this.drawFormationCard(formation, x, 122, 190, 310, formation.id === selectedFormation);
      x += 212;
    }
    this.drawBattlePrepTargets(selectedTargetId, spyReport, baseOrders, selectedPrepBaseId);
    this.drawButton("launch_battle", "LAUNCH BATTLE", this.width - 210, this.height - 76, 180, 48, "#ffb347", "#b95e1f");
    if (mapExpanded) this.drawMapOverlay();
    this.drawTooltip();
  }

  drawResults(results, mapExpanded = false) {
    this.beginFrame();
    this.drawTopBar(`Round ${this.sim.round} Results`, "A lost defense gives up one map spot; lost attackers reduce next round income");
    this.drawButton("map_expand", "MAP", this.width - 284, 22, 58, 36, "#33465f", "#1b2636");
    const boardRect = { x: 34, y: 106, w: Math.min(560, this.width * 0.42), h: Math.min(520, this.height - 166) };
    this.drawBoard(boardRect.x, boardRect.y, boardRect.w, boardRect.h, true);

    const reportX = boardRect.x + boardRect.w + 28;
    const reportW = Math.max(420, this.width - reportX - 34);
    this.drawGlassPanel(reportX, 112, reportW, Math.min(430, this.height - 176), "#171f2d");
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 24px ui-sans-serif";
    ctx.fillText("Battle Report", reportX + 24, 154);
    ctx.font = "700 15px ui-sans-serif";
    let y = 196;
    for (const result of results.slice(0, 10)) {
      const attacker = this.sim.kingdoms[result.attackerId];
      const defender = this.sim.kingdoms[result.defenderId];
      const won = result.winner === "attacker";
      ctx.fillStyle = won ? "#ffcf6c" : "#75f2b2";
      const area = this.sim.nodeById(result.targetNodeId || result.defenderNodeId)?.name || "Frontier";
      ctx.fillText(won ? "TAKEN!" : "HELD!", reportX + 24, y);
      ctx.fillStyle = "#dce5f5";
      ctx.font = "600 14px ui-sans-serif";
      ctx.fillText(areaHeadline(result, area, attacker, defender), reportX + 104, y);
      ctx.fillStyle = "#8492aa";
      const lost = Math.max(0, (result.startingAttackers || result.survivingAttackers || 0) - result.survivingAttackers);
      ctx.fillText(`${Math.ceil(result.time)}s  |  ${result.survivingAttackers} attackers left  |  ${lost * 2}g loss penalty  |  ${result.entry || "west"} entry`, reportX + 104, y + 20);
      ctx.font = "700 15px ui-sans-serif";
      y += 56;
    }
    this.drawKingdomStats(reportX + reportW - 250, 128, 220, 166);
    this.drawButton("next_round", "CHOOSE TECH", this.width - 196, this.height - 74, 166, 46, "#21c886", "#0d6a55");
    if (mapExpanded) this.drawMapOverlay();
    this.drawTooltip();
  }

  drawTech(choices) {
    this.beginFrame();
    this.drawTopBar("Invest In Tech", "Choose one upgrade before the next build phase");
    const ctx = this.ctx;
    let x = Math.max(40, (this.width - 930) / 2);
    for (const tech of choices) {
      this.drawGlassPanel(x, 150, 290, 270, "#172233");
      ctx.fillStyle = "#7de7a5";
      ctx.font = "900 13px ui-sans-serif";
      ctx.fillText("UPGRADE", x + 22, 184);
      ctx.fillStyle = "#ffffff";
      ctx.font = "900 22px ui-sans-serif";
      wrapText(ctx, tech.name, x + 22, 220, 230, 25);
      ctx.fillStyle = "#aebbd0";
      ctx.font = "700 14px ui-sans-serif";
      wrapText(ctx, tech.desc, x + 22, 292, 240, 20);
      this.drawButton(`tech_${tech.id}`, "TAKE TECH", x + 58, 360, 170, 42, "#21c886", "#0d6a55");
      x += 320;
    }
    this.drawTooltip();
  }

  drawEnd(victory) {
    this.beginFrame();
    const ctx = this.ctx;
    const title = victory ? "KINGDOM UNITED" : "KINGDOM LOST";
    this.drawGlow(this.width / 2, this.height / 2, 320, victory ? "rgba(80,255,160,0.20)" : "rgba(255,80,100,0.22)");
    ctx.textAlign = "center";
    ctx.fillStyle = victory ? "#aaffc8" : "#ffb0bd";
    ctx.font = "900 58px ui-sans-serif";
    ctx.fillText(title, this.width / 2, this.height / 2 - 42);
    ctx.fillStyle = "#d6dfef";
    ctx.font = "600 18px ui-sans-serif";
    ctx.fillText(victory ? "Every banner bends to your crown." : "Your last banner has fallen.", this.width / 2, this.height / 2 + 4);
    ctx.textAlign = "left";
    this.drawButton("restart", "RESTART", this.width / 2 - 74, this.height / 2 + 42, 148, 48, "#21c886", "#0d6a55");
    this.drawTooltip();
  }

  drawBuildLayout(selectedBaseNodeId = null) {
    const boardW = Math.min(250, Math.max(210, this.width * 0.19));
    this.drawBoard(24, 96, boardW, 244, false);
    this.drawButton("map_expand", "EXPAND MAP", 56, 304, 148, 30, "#33465f", "#1b2636");
    this.drawKingdomStats(24, 360, boardW, 170);
    this.drawBaseSelector(24, 540, boardW, 112, selectedBaseNodeId);
    this.drawBuildField(selectedBaseNodeId);
    this.drawToolbar();
    this.drawAlliancePanel(24, 664, Math.min(250, Math.max(210, this.width * 0.19)), 164);
    this.drawBuildMessage();
  }

  drawBuildField(selectedBaseNodeId = null) {
    const ctx = this.ctx;
    const b = this.build.screenBounds;
    const map = mapFor(b);
    this.drawGlassPanel(b.x, b.y, b.w, b.h, "#151f2b");

    const floor = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
    floor.addColorStop(0, "rgba(43, 77, 72, 0.44)");
    floor.addColorStop(0.55, "rgba(33, 42, 61, 0.52)");
    floor.addColorStop(1, "rgba(71, 45, 75, 0.42)");
    ctx.fillStyle = floor;
    roundedRect(ctx, b.x + 10, b.y + 10, b.w - 20, b.h - 20, 8);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.lineWidth = 1;
    for (let x = b.x + 10; x <= b.x + b.w - 10; x += this.build.grid) {
      ctx.beginPath();
      ctx.moveTo(x, b.y + 10);
      ctx.lineTo(x, b.y + b.h - 10);
      ctx.stroke();
    }
    for (let y = b.y + 10; y <= b.y + b.h - 10; y += this.build.grid) {
      ctx.beginPath();
      ctx.moveTo(b.x + 10, y);
      ctx.lineTo(b.x + b.w - 10, y);
      ctx.stroke();
    }

    this.drawCore({ x: CORE.x, y: CORE.y, hp: CORE.hp, maxHp: CORE.hp, r: CORE.r }, map);
    const nodeId = selectedBaseNodeId || this.build.activeNodeId || this.sim.firstOwnedNode(0);
    for (const structure of this.sim.structuresForNode(0, nodeId)) this.drawStructure(structure, map, map.scale, structure.id === this.build.selectedStructureId);

    const def = BUILD_DEFS[this.build.selected];
    const world = this.build.screenToWorld(this.input.mouse.x, this.input.mouse.y);
    const ghostWorld = this.build.snapWorld(world.x, world.y);
    const ghost = this.build.worldToScreen(ghostWorld.x, ghostWorld.y);
    const check = this.build.canPlace(this.input.mouse.x, this.input.mouse.y);
    if (inside(this.input.mouse.x, this.input.mouse.y, b)) {
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.shadowColor = check.ok ? "#72ffad" : "#ff5570";
      ctx.shadowBlur = 22;
      ctx.fillStyle = check.ok ? "rgba(114,255,173,0.42)" : "rgba(255,85,112,0.42)";
      const size = def.size * map.scale;
      roundedRect(ctx, ghost.x - size / 2, ghost.y - size / 2, size, size, 7);
      ctx.fill();
      ctx.restore();
    }
    this.drawBuildFieldLegend(b);
    this.drawSelectedStructurePanel(b);
  }

  drawBaseSelector(x, y, w, h, selectedBaseNodeId) {
    this.drawGlassPanel(x, y, w, h, "#141d29");
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 14px ui-sans-serif";
    ctx.fillText("YOUR BASES", x + 14, y + 24);
    ctx.fillStyle = "#91a0b8";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText("Build separately at each owned land.", x + 14, y + 43);
    let yy = y + 58;
    const bases = this.sim.ownedNodes(0);
    for (const node of bases.slice(0, 2)) {
      const selected = node.id === selectedBaseNodeId;
      this.drawButton(`base_${node.id}`, `${selected ? "*" : ""}${node.name}`, x + 12, yy, w - 24, 24, selected ? "#21c886" : "#33465f", selected ? "#0d6a55" : "#1b2636");
      yy += 28;
    }
    if (bases.length > 2) this.drawButton("base_more", `ALL BASES (${bases.length})`, x + 12, yy, w - 24, 24, "#273246", "#151c29");
  }

  drawBaseModal(selectedBaseNodeId) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(3, 6, 11, 0.78)";
    ctx.fillRect(0, 0, this.width, this.height);
    const w = 420;
    const h = Math.min(520, this.height - 120);
    const x = this.width / 2 - w / 2;
    const y = 96;
    this.drawGlassPanel(x, y, w, h, "#101827");
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 22px ui-sans-serif";
    ctx.fillText("Select Base", x + 24, y + 38);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 12px ui-sans-serif";
    ctx.fillText("Choose which owned land you are building for.", x + 24, y + 60);
    let yy = y + 88;
    for (const node of this.sim.ownedNodes(0)) {
      const selected = node.id === selectedBaseNodeId;
      this.drawButton(`base_${node.id}`, `${node.name}  +${node.income}g`, x + 24, yy, w - 48, 34, selected ? "#21c886" : "#33465f", selected ? "#0d6a55" : "#1b2636");
      yy += 42;
    }
    this.drawButton("base_modal_close", "CLOSE", x + w - 112, y + h - 48, 86, 32, "#33465f", "#1b2636");
  }

  drawToolbar() {
    const groups = [
      ["Defense", ["wall", "tower", "beam_obelisk", "nova_shrine", "barracks", "trap", "guard_post"]],
      ["Offense", ["raider_camp", "knight_stable", "siege_yard", "ranger_range", "arcanum"]],
      ["Economy", ["farm"]],
    ];
    const x = this.width - 276;
    let y = 96;
    for (const [label, ids] of groups) {
      const ctx = this.ctx;
      ctx.fillStyle = "#95a5bc";
      ctx.font = "800 12px ui-sans-serif";
      ctx.fillText(label.toUpperCase(), x, y);
      y += 12;
      for (const id of ids) {
        const def = BUILD_DEFS[id];
        const selected = this.build.selected === id;
        const locked = !this.sim.isBuildingUnlocked(0, id);
        const colors = STRUCTURE_COLORS[id] || ["#9aa6b5", "#4d5563"];
        const button = this.drawToolButton(`tool_${id}`, def, x, y, 246, 46, selected, colors, locked);
        this.toolButtons.push({ ...button, type: id });
        y += 52;
      }
      y += 8;
    }

    const selected = BUILD_DEFS[this.build.selected];
    this.drawGlassPanel(x, y, 246, 134, "#151f2b");
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 16px ui-sans-serif";
    ctx.fillText(selected.name, x + 16, y + 28);
    ctx.fillStyle = "#78f0b0";
    ctx.font = "900 12px ui-sans-serif";
    ctx.fillText(buildStatLine(selected), x + 16, y + 50);
    ctx.fillStyle = "#aebbd0";
    ctx.font = "600 13px ui-sans-serif";
    wrapText(ctx, selected.desc, x + 16, y + 74, 212, 17);
  }

  drawDualBattles() {
    const gap = 18;
    const top = 102;
    const footer = 92;
    const panelW = (this.width - gap * 3) / 2;
    const panelH = this.height - top - footer;
    const left = { x: gap, y: top, w: panelW, h: panelH };
    const right = { x: gap * 2 + panelW, y: top, w: panelW, h: panelH };

    this.drawBattlePanel("YOUR DEFENSE", this.battles.defense, left, "#4da3ff");
    this.drawBattlePanel("YOUR OFFENSE", this.battles.offense, right, "#ff9d67");
  }

  drawBattlePanel(label, battle, rect, accent) {
    this.drawGlassPanel(rect.x, rect.y, rect.w, rect.h, "#121a27");
    const ctx = this.ctx;
    const map = mapFor(rect);
    const attacker = this.sim.kingdoms[battle.attackerId];
    const defender = this.sim.kingdoms[battle.defenderId];

    if (!battle.active && !battle.result) {
      ctx.fillStyle = "#7f8ca3";
      ctx.font = "800 18px ui-sans-serif";
      ctx.fillText(`${label}: NO MATCH`, rect.x + 22, rect.y + 36);
      ctx.font = "600 14px ui-sans-serif";
      ctx.fillText("Your kingdom is not involved in this lane.", rect.x + 22, rect.y + 64);
      return;
    }

    const shake = battle.result ? 0 : Math.sin(this.time * 48) * battle.impact * 2.2;
    const arena = { x: rect.x + 16 + shake, y: rect.y + 84, w: rect.w - 32, h: rect.h - 140 };
    const arenaMap = mapFor(arena);
    this.drawArena(arena, accent, battle.impact);

    const attackerColor = attacker.color;
    const defenderColor = defender.color;
    ctx.fillStyle = accent;
    ctx.font = "900 15px ui-sans-serif";
    ctx.fillText(label, rect.x + 20, rect.y + 30);
    ctx.fillStyle = attackerColor;
    roundedRect(ctx, rect.x + 20, rect.y + 43, 11, 11, 2);
    ctx.fill();
    ctx.fillStyle = defenderColor;
    roundedRect(ctx, rect.x + 34, rect.y + 43, 11, 11, 2);
    ctx.fill();
    ctx.fillStyle = "#dce6f6";
    ctx.font = "800 17px ui-sans-serif";
    ctx.fillText(`${attacker.name} -> ${defender.name}`, rect.x + 52, rect.y + 55);
    ctx.fillStyle = "#8795ad";
    ctx.font = "700 12px ui-sans-serif";
    ctx.fillText(`${Math.max(0, Math.ceil(battle.maxTime - battle.timer))}s`, rect.x + rect.w - 64, rect.y + 31);
    ctx.fillStyle = "#8ea0bb";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText("R Raider  K Knight  S Siege  |  G Guard  A Archer  |  C Core", rect.x + 20, rect.y + 70);

    this.drawCore(battle.core, arenaMap);
    for (const structure of battle.structures) {
      if (structure.hp > 0) this.drawStructure(structure, arenaMap, arena.w / FIELD.w);
    }
    for (const beam of battle.beams || []) this.drawBeam(beam, arenaMap);
    for (const ring of battle.rings || []) this.drawRing(ring, arenaMap);
    for (const shot of battle.projectiles) this.drawProjectile(shot, arenaMap);
    for (const unit of battle.defenders) this.drawUnit(unit, arenaMap);
    for (const unit of battle.attackers) this.drawUnit(unit, arenaMap);
    for (const effect of battle.effects) this.drawEffect(effect, arenaMap);

    const hudY = rect.y + rect.h - 44;
    this.drawMetric(rect.x + 20, hudY, "ATK", battle.attackers.length, "#ffad75");
    this.drawMetric(rect.x + 104, hudY, "DEF", battle.defenders.length, "#89ffaa");
    this.drawMetric(rect.x + 188, hudY, "CORE", Math.max(0, Math.ceil(battle.core.hp)), "#7dc7ff");
    this.drawUnitBreakdown(battle, rect.x + 278, hudY - 2);
    if (battle.result) {
      ctx.fillStyle = battle.result.winner === "attacker" ? "#ffcf6c" : "#75f2b2";
      ctx.font = "900 20px ui-sans-serif";
      ctx.fillText(battle.result.winner === "attacker" ? "BREACH" : "HELD", rect.x + rect.w - 110, hudY + 18);
    }
  }

  drawArena(rect, accent, impact) {
    const ctx = this.ctx;
    ctx.fillStyle = "#162030";
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    for (let x = rect.x; x < rect.x + rect.w; x += 30) {
      ctx.beginPath();
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
      ctx.stroke();
    }
    for (let y = rect.y; y < rect.y + rect.h; y += 30) {
      ctx.beginPath();
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.38 + impact * 0.45;
    ctx.lineWidth = 2;
    roundedRect(ctx, rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2, 8);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawBoard(x, y, w, h, large) {
    const ctx = this.ctx;
    this.drawGlassPanel(x, y, w, h, "#141d29");
    const pad = large ? 48 : 18;
    const bx = x + pad;
    const by = y + (large ? 58 : 34);
    const bw = w - pad * 2;
    const bh = h - (large ? 92 : 52);
    const nodeById = new Map(this.sim.nodes.map((node) => [node.id, node]));
    if (large) {
      const land = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
      land.addColorStop(0, "#203624");
      land.addColorStop(0.5, "#263245");
      land.addColorStop(1, "#3b2f22");
      ctx.fillStyle = land;
      roundedRect(ctx, bx - 28, by - 28, bw + 56, bh + 64, 14);
      ctx.fill();
      ctx.strokeStyle = "rgba(125, 231, 165, 0.12)";
      for (let i = 0; i < 9; i++) {
        ctx.beginPath();
        ctx.moveTo(bx - 20 + i * (bw / 8), by - 18);
        ctx.lineTo(bx + 22 + i * (bw / 8), by + bh + 30);
        ctx.stroke();
      }
    }
    ctx.lineWidth = large ? 4 : 2;
    for (const edge of BOARD_EDGES) {
      const a = nodeById.get(edge[0]);
      const b = nodeById.get(edge[1]);
      const allied = this.sim.areAllied(a.owner, b.owner);
      ctx.strokeStyle = allied ? "rgba(125, 231, 165, 0.78)" : "rgba(255,255,255,0.16)";
      ctx.beginPath();
      ctx.moveTo(bx + a.x * bw, by + a.y * bh);
      ctx.lineTo(bx + b.x * bw, by + b.y * bh);
      ctx.stroke();
    }
    for (const node of this.sim.nodes) {
      const nx = bx + node.x * bw;
      const ny = by + node.y * bh;
      const color = KINGDOM_COLORS[node.owner] || "#777";
      this.drawGlow(nx, ny, large ? 26 : 18, color + "55");
      if (node.owner === 0) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = large ? 4 : 2;
        ctx.beginPath();
        ctx.arc(nx, ny, large ? 30 : 22, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (this.sim.alliance?.round === this.sim.round && this.sim.areAllied(0, node.owner)) {
        ctx.strokeStyle = "#7de7a5";
        ctx.lineWidth = large ? 5 : 3;
        ctx.beginPath();
        ctx.arc(nx, ny, large ? 35 : 25, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawKingdomIcon(ctx, nx, ny, large ? 20 : 15, color, node.income);
      if (large) {
        ctx.fillStyle = "#f4f8ff";
        ctx.font = "900 12px ui-sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.name, nx, ny + 38);
        ctx.fillStyle = "#9fb0c8";
        ctx.font = "800 11px ui-sans-serif";
        ctx.fillText(`${this.sim.kingdoms[node.owner]?.name || "Unknown"}`, nx, ny + 52);
        ctx.textAlign = "left";
      }
      if (Math.hypot(this.input.mouse.x - nx, this.input.mouse.y - ny) <= (large ? 22 : 17)) {
        const owner = this.sim.kingdoms[node.owner];
        this.setTooltip(
          `${node.name}`,
          `Controlled by ${owner?.name || "Unknown"}. Worth +${node.income} land gold during factory payout. ${this.sim.territoryCount(node.owner)} total land.`,
          nx + 16,
          ny + 16,
        );
      }
    }
    ctx.fillStyle = "#dce6f6";
    ctx.font = "900 14px ui-sans-serif";
    ctx.fillText("KINGDOM BOARD", x + 18, y + 28);
    if (!large) {
      ctx.fillStyle = "#8fa1b9";
      ctx.font = "800 11px ui-sans-serif";
      ctx.fillText("Hover castles for names and income", x + 18, y + 48);
    }
  }

  drawKingdomStats(x, y, w, h) {
    const ctx = this.ctx;
    this.drawGlassPanel(x, y, w, h, "#141d29");
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 15px ui-sans-serif";
    ctx.fillText("BANNERS", x + 16, y + 28);
    let row = y + 56;
    ctx.font = "700 13px ui-sans-serif";
    for (const kingdom of this.sim.kingdoms) {
      drawBanner(ctx, x + 15, row - 18, 22, 26, kingdom.color, kingdom.id);
      ctx.fillStyle = kingdom.eliminated ? "#687186" : "#dce6f6";
      ctx.fillText(`${kingdom.name}`, x + 46, row);
      ctx.fillStyle = kingdom.eliminated ? "#687186" : "#93a2b9";
      ctx.fillText(`${this.sim.territoryCount(kingdom.id)} land`, x + w - 72, row);
      row += 25;
    }
  }

  drawStructure(structure, map, scale, selected = false) {
    const ctx = this.ctx;
    const def = BUILD_DEFS[structure.type];
    const p = map.point(structure.x, structure.y);
    const size = Math.max(8, def.size * scale);
    const colors = STRUCTURE_COLORS[structure.type] || ["#9aa6b5", "#4d5563"];
    ctx.save();
    if (scale > 0.75) {
      ctx.shadowColor = colors[0];
      ctx.shadowBlur = 8 * scale;
    }
    if (scale > 0.75) {
      const grad = ctx.createLinearGradient(p.x - size / 2, p.y - size / 2, p.x + size / 2, p.y + size / 2);
      grad.addColorStop(0, colors[0]);
      grad.addColorStop(1, colors[1]);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = colors[0];
    }
    roundedRect(ctx, p.x - size / 2, p.y - size / 2, size, size, Math.min(8, size * 0.18));
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.62)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (selected) {
      ctx.strokeStyle = "#ffcf6c";
      ctx.lineWidth = 3;
      roundedRect(ctx, p.x - size / 2 - 5, p.y - size / 2 - 5, size + 10, size + 10, Math.min(10, size * 0.2));
      ctx.stroke();
    }
    drawStructureGlyph(ctx, structure.type, p.x, p.y, size);
    ctx.restore();
    if (structure.maxHp && structure.hp < structure.maxHp) {
      drawFastBar(ctx, p.x - size / 2, p.y - size / 2 - 8, size, 5, structure.hp / structure.maxHp, "#7cff9d");
    }
    if (inside(this.input.mouse.x, this.input.mouse.y, { x: p.x - size / 2, y: p.y - size / 2, w: size, h: size })) {
      if (def.range) {
        ctx.save();
        ctx.strokeStyle = "rgba(125, 231, 255, 0.48)";
        ctx.fillStyle = "rgba(125, 231, 255, 0.07)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, def.range * map.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      this.setTooltip(BUILD_DEFS[structure.type].name, `${buildStatLine(BUILD_DEFS[structure.type])}. ${BUILD_DEFS[structure.type].desc}`, p.x + size / 2 + 8, p.y);
    }
  }

  drawCore(core, map) {
    const ctx = this.ctx;
    const p = map.point(core.x, core.y);
    const r = Math.max(12, core.r * map.scale);
    if (map.scale > 0.5) this.drawGlow(p.x, p.y, r * 2.2, "rgba(125,199,255,0.22)");
    ctx.fillStyle = "#e7f5ff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7dc7ff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#1a2533";
    ctx.font = `900 ${Math.max(10, r * 0.7)}px ui-sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("C", p.x, p.y + r * 0.25);
    ctx.textAlign = "left";
    drawBar(ctx, p.x - r * 1.45, p.y - r - 13, r * 2.9, 7, core.hp / core.maxHp, "#7cff9d");
  }

  drawUnit(unit, map) {
    const ctx = this.ctx;
    const p = map.point(unit.x, unit.y);
    const r = Math.max(4, unit.r * map.scale);
    const color = UNIT_COLORS[unit.type] || (unit.side === 0 ? "#ff9d67" : "#89ffaa");
    if (unit.type === "siege" || unit.type === "knight") this.drawGlow(p.x, p.y, r * 1.9, color + "30");
    drawUnitShape(ctx, unit.type, p.x, p.y, r, color);
    ctx.strokeStyle = unit.side === 0 ? "#ffe1d1" : "#d8ffe5";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const dir = unit.side === 0 ? 1 : -1;
    ctx.strokeStyle = "rgba(255,255,255,0.72)";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + dir * r * 1.4, p.y);
    ctx.stroke();
    if (unit.hp < unit.maxHp) drawFastBar(ctx, p.x - r * 1.3, p.y - r - 7, r * 2.6, 4, unit.hp / unit.maxHp, "#7cff9d");
    if (Math.hypot(this.input.mouse.x - p.x, this.input.mouse.y - p.y) <= r + 6) {
      const def = UNIT_DEFS[unit.type];
      this.setTooltip(def.name, `${def.role}. HP ${def.hp}, DMG ${def.damage}, RNG ${def.range}. ${def.special}`, p.x + r + 8, p.y);
    }
  }

  drawProjectile(shot, map) {
    const ctx = this.ctx;
    const p = map.point(shot.x, shot.y);
    ctx.fillStyle = shot.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  drawBeam(beam, map) {
    const ctx = this.ctx;
    const a = map.point(beam.x1, beam.y1);
    const b = map.point(beam.x2, beam.y2);
    const alpha = 1 - beam.t / beam.life;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = beam.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  drawRing(ring, map) {
    const ctx = this.ctx;
    const p = map.point(ring.x, ring.y);
    const alpha = 1 - ring.t / ring.life;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ring.r * map.scale * (1 + ring.t * 1.6), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawEffect(effect, map) {
    const ctx = this.ctx;
    const p = map.point(effect.x, effect.y);
    const k = 1 - effect.t / effect.life;
    ctx.save();
    ctx.globalAlpha = Math.max(0, k);
    ctx.strokeStyle = effect.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, effect.r * map.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = effect.color;
    ctx.font = "900 12px ui-sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(effect.text), p.x, p.y - 12 * k);
    ctx.textAlign = "left";
    ctx.restore();
  }

  drawMetric(x, y, label, value, color) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = "900 11px ui-sans-serif";
    ctx.fillText(label, x, y);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 18px ui-sans-serif";
    ctx.fillText(String(value), x, y + 20);
  }

  drawBuildMessage() {
    if (this.build.messageTimer <= 0) return;
    const ctx = this.ctx;
    const alpha = Math.min(1, this.build.messageTimer);
    ctx.globalAlpha = alpha;
    this.drawGlassPanel(294, 88, 480, 38, "#2a1c20");
    ctx.fillStyle = "#ffd0a0";
    ctx.font = "800 14px ui-sans-serif";
    ctx.fillText(this.build.message, 314, 113);
    ctx.globalAlpha = 1;
  }

  drawBuildFieldLegend(rect) {
    const ctx = this.ctx;
    const x = rect.x + 18;
    const y = rect.y + rect.h - 38;
    ctx.fillStyle = "rgba(8, 12, 18, 0.58)";
    roundedRect(ctx, x, y, 438, 24, 6);
    ctx.fill();
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "800 12px ui-sans-serif";
    ctx.fillText("Core must survive  |  Defense protects here  |  Offense attacks enemy cores", x + 12, y + 16);
  }

  drawSelectedStructurePanel(rect) {
    const structure = this.build.selectedStructure?.();
    if (!structure) return;
    const def = BUILD_DEFS[structure.type];
    const ctx = this.ctx;
    const w = 330;
    const h = 78;
    const x = rect.x + rect.w - w - 18;
    const y = rect.y + 18;
    ctx.fillStyle = "rgba(8, 12, 18, 0.82)";
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 207, 108, 0.45)";
    ctx.stroke();
    ctx.fillStyle = "#ffcf6c";
    ctx.font = "900 12px ui-sans-serif";
    ctx.fillText("SELECTED STRUCTURE", x + 14, y + 20);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 16px ui-sans-serif";
    ctx.fillText(def.name, x + 14, y + 44);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText(`Sell refund: ${Math.max(1, Math.floor(def.cost * 0.35))}g`, x + 14, y + 63);
    this.drawButton("sell_structure", "SELL", x + w - 86, y + 22, 64, 34, "#ff655d", "#93323a");
  }

  drawUnitBreakdown(battle, x, y) {
    const ctx = this.ctx;
    const atk = countTypes(battle.attackers);
    const def = countTypes(battle.defenders);
    ctx.font = "800 11px ui-sans-serif";
    let xx = x;
    for (const type of ["raider", "knight", "siege", "ranger", "mage"]) {
      if (!atk[type]) continue;
      ctx.fillStyle = UNIT_COLORS[type];
      ctx.fillText(`${unitLabel(type)} ${atk[type]}`, xx, y + 14);
      xx += 42;
    }
    xx = x;
    for (const type of ["guard", "archer"]) {
      if (!def[type]) continue;
      ctx.fillStyle = UNIT_COLORS[type];
      ctx.fillText(`${unitLabel(type)} ${def[type]}`, xx, y + 32);
      xx += 42;
    }
  }

  drawGoldBadge(x, y) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(x, y, x + 210, y + 44);
    grad.addColorStop(0, "#ffe27a");
    grad.addColorStop(1, "#c47a22");
    ctx.fillStyle = grad;
    roundedRect(ctx, x, y, 210, 44, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.stroke();
    ctx.fillStyle = "#271707";
    ctx.font = "900 15px ui-sans-serif";
    ctx.fillText("TREASURY", x + 16, y + 18);
    ctx.font = "900 26px ui-sans-serif";
    ctx.fillText(`${this.sim.player.gold}g`, x + 112, y + 31);
  }

  drawAlliancePanel(x, y, w, h) {
    this.drawGlassPanel(x, y, w, h, "#141d29");
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 14px ui-sans-serif";
    ctx.fillText("ALLIANCE", x + 14, y + 24);
    ctx.fillStyle = "#95a5bc";
    ctx.font = "700 11px ui-sans-serif";
    const alive = this.sim.aliveKingdoms();
    if (alive.length <= 2) {
      ctx.fillText("Only available with 3+ kingdoms alive.", x + 14, y + 48);
      return;
    }
    if (this.sim.alliance?.round === this.sim.round) {
      const ally = this.sim.kingdoms[this.sim.alliance.b];
      ctx.fillStyle = "#7de7a5";
      ctx.fillText(`Allied with ${ally?.name || "Unknown"} this round.`, x + 14, y + 50);
      ctx.fillStyle = "#95a5bc";
      wrapText(ctx, "One-round pact: no mutual attacks, but both kingdoms can still fight everyone else.", x + 14, y + 72, w - 28, 14);
      return;
    }
    wrapText(ctx, "Offer a one-round pact for 18g. Allies cannot target each other this battle. Strong kingdoms are less likely to accept.", x + 14, y + 44, w - 28, 14);
    let yy = y + 92;
    for (const kingdom of this.sim.adjacentKingdomTargets(0).filter((k) => k.id !== 0).slice(0, 3)) {
      this.drawButton(`ally_${kingdom.id}`, kingdom.name, x + 12, yy, w - 24, 26, "#33465f", "#1b2636");
      yy += 31;
    }
  }

  drawFactoryPanel(kingdom, x, y, w, h, controls, t, selectedFactoryItem = null, factoryTool = "worker") {
    this.drawGlassPanel(x, y, w, h, "#141d29");
    const ctx = this.ctx;
    const f = kingdom.factory;
    const counts = this.sim.factoryCounts(f);
    const land = 8 + this.sim.landIncomeFor(kingdom.id);
    const factory = this.sim.factoryIncomeFor(kingdom.id);
    const run = this.sim.factoryRunProgressFor(kingdom.id);
    const total = this.sim.incomeFor(kingdom.id);
    const efficiency = Math.round(this.sim.factoryEfficiencyFor(kingdom.id) * 100);
    const handoff = Math.round(this.sim.factoryHandoffFor(kingdom.id) * 100);
    const headerGrad = ctx.createLinearGradient(x + 16, y + 16, x + w - 16, y + 82);
    headerGrad.addColorStop(0, kingdom.color + "88");
    headerGrad.addColorStop(1, "rgba(17, 25, 38, 0.20)");
    ctx.fillStyle = headerGrad;
    roundedRect(ctx, x + 16, y + 14, w - 32, 76, 10);
    ctx.fill();
    drawBanner(ctx, x + 28, y + 26, 34, 42, kingdom.color, kingdom.id);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 24px ui-sans-serif";
    ctx.fillText(`${kingdom.name} Factory`, x + 78, y + 43);
    ctx.fillStyle = "#d7e3f6";
    ctx.font = "800 13px ui-sans-serif";
    const penalty = kingdom.nextIncomePenalty || 0;
    ctx.fillText(`Land + base ${land}g  +  factory ${factory}g${penalty ? `  -  losses ${penalty}g` : ""}  =  next build ${total}g`, x + 78, y + 68);
    if (f.sabotageTimer > 0) {
      ctx.fillStyle = "#ff8d74";
      ctx.font = "900 12px ui-sans-serif";
      ctx.fillText("SABOTAGED: workers are slowed this run", x + w - 278, y + 43);
    }

    const statY = y + 104;
    const stats = [
      ["Workers", counts.worker, "carry parts"],
      ["Machines", counts.machine, "process"],
      ["Belts", counts.belt, "move faster"],
      ["Flow", `${efficiency}%`, `${handoff}% handoff`],
    ];
    const statW = Math.max(88, Math.min(170, (w - 56) / 4));
    for (let i = 0; i < stats.length; i++) {
      const sx = x + 22 + i * statW;
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      roundedRect(ctx, sx, statY, statW - 10, 58, 8);
      ctx.fill();
      ctx.fillStyle = "#8fa1b9";
      ctx.font = "800 11px ui-sans-serif";
      ctx.fillText(stats[i][0].toUpperCase(), sx + 12, statY + 18);
      ctx.fillStyle = "#ffffff";
      ctx.font = "900 22px ui-sans-serif";
      ctx.fillText(String(stats[i][1]), sx + 12, statY + 42);
      if (statW > 125) {
        ctx.fillStyle = "#91a0b8";
        ctx.font = "700 10px ui-sans-serif";
        ctx.fillText(stats[i][2], sx + 12, statY + 54);
      }
    }

    const floor = { x: x + 24, y: y + 178, w: w - 48, h: Math.max(170, h - 226) };
    if (controls) this.factoryFloor = { ...floor };
    const floorGrad = ctx.createLinearGradient(floor.x, floor.y, floor.x + floor.w, floor.y + floor.h);
    floorGrad.addColorStop(0, "#172436");
    floorGrad.addColorStop(0.55, "#1b2e35");
    floorGrad.addColorStop(1, "#251f39");
    ctx.fillStyle = floorGrad;
    roundedRect(ctx, floor.x, floor.y, floor.w, floor.h, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.055)";
    for (let gx = floor.x + 28; gx < floor.x + floor.w; gx += 54) {
      ctx.fillRect(gx, floor.y + 12, 2, floor.h - 24);
    }

    const intake = { x: floor.x + 26, y: floor.y + floor.h * 0.5 - 42, w: 92, h: 84 };
    const treasury = { x: floor.x + floor.w - 132, y: floor.y + floor.h * 0.5 - 48, w: 104, h: 96 };
    ctx.fillStyle = "#253245";
    roundedRect(ctx, intake.x, intake.y, intake.w, intake.h, 9);
    ctx.fill();
    ctx.fillStyle = "#ffd76b";
    roundedRect(ctx, treasury.x, treasury.y, treasury.w, treasury.h, 10);
    ctx.fill();
    ctx.fillStyle = "#28190b";
    ctx.font = "900 13px ui-sans-serif";
    ctx.fillText("PARTS", intake.x + 22, intake.y + 29);
    ctx.fillText("TREASURY", treasury.x + 15, treasury.y + 31);
    ctx.font = "900 24px ui-sans-serif";
    ctx.fillText(`+${factory}`, treasury.x + 25, treasury.y + 65);

    this.drawAssemblyLane(f, floor, intake, treasury, t);
    this.drawFactoryItems(f, floor, selectedFactoryItem, t);
    this.drawFactoryParts(f, floor, intake, treasury, run, factory, t);
    if (controls && factoryTool) this.drawFactoryPlacementGhost(floor, factoryTool);

    ctx.fillStyle = "rgba(7, 11, 18, 0.68)";
    roundedRect(ctx, floor.x + 16, floor.y + floor.h - 50, Math.min(720, floor.w - 32), 36, 7);
    ctx.fill();
    ctx.fillStyle = "#c6d4e8";
    ctx.font = "800 12px ui-sans-serif";
    ctx.fillText("Assembly line: workers hand off parts, machines raise part value, belts shorten the trip, delivered value becomes gold.", floor.x + 30, floor.y + floor.h - 28);
    if (controls) {
      ctx.fillStyle = "#95a5bc";
      ctx.font = "700 12px ui-sans-serif";
      ctx.fillText("Placement mode is active. Click the factory floor to place the selected tool, or click an item to move it.", x + 22, y + h - 22);
    }
  }

  drawAssemblyLane(factory, floor, intake, treasury, t) {
    const ctx = this.ctx;
    const lineY = floor.y + floor.h * 0.5;
    const stations = assemblyStations(factory, floor, intake, treasury);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(intake.x + intake.w + 8, lineY);
    for (const station of stations) ctx.lineTo(station.x, station.y);
    ctx.lineTo(treasury.x - 14, lineY);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#7de7a5";
    ctx.setLineDash([14, 12]);
    ctx.lineDashOffset = -t * 38;
    ctx.beginPath();
    ctx.moveTo(intake.x + intake.w + 8, lineY);
    for (const station of stations) ctx.lineTo(station.x, station.y);
    ctx.lineTo(treasury.x - 14, lineY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i];
      const b = stations[i + 1];
      if (a.type !== "worker" || b.type !== "worker") continue;
      const pulse = 0.45 + Math.sin(t * 6 + i) * 0.35;
      ctx.strokeStyle = `rgba(255, 226, 122, ${pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - 18);
      ctx.lineTo(b.x, b.y - 18);
      ctx.stroke();
      ctx.fillStyle = "#ffe27a";
      const hx = a.x + (b.x - a.x) * ((t * 0.8 + i * 0.2) % 1);
      const hy = a.y - 18 + Math.sin(t * 8 + i) * 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawFactoryItems(factory, floor, selectedFactoryItem, t) {
    const ctx = this.ctx;
    for (const item of factory.items) {
      const px = floor.x + item.x * floor.w;
      const py = floor.y + item.y * floor.h;
      const selected = item.id === selectedFactoryItem;
      if (item.type === "belt") {
        ctx.strokeStyle = selected ? "#ffffff" : "#d98cff";
        ctx.lineWidth = selected ? 8 : 6;
        ctx.beginPath();
        ctx.moveTo(px - 34, py);
        ctx.lineTo(px + 56, py);
        ctx.stroke();
        ctx.fillStyle = "#f3d2ff";
        for (let i = 0; i < 3; i++) ctx.fillRect(px - 24 + i * 28 + ((t * 22) % 14), py - 3, 12, 6);
      } else if (item.type === "machine") {
        const pulse = 0.5 + Math.sin(t * 5 + px) * 0.5;
        ctx.fillStyle = selected ? "#8be9ff" : "#2f8cff";
        roundedRect(ctx, px - 34, py - 24, 68, 48, 8);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.22 + pulse * 0.42})`;
        ctx.fillRect(px - 22, py - 8, 44, 14);
        ctx.fillStyle = "#dce6f6";
        ctx.font = "900 10px ui-sans-serif";
        ctx.fillText("MACHINE", px - 25, py + 36);
      } else if (item.type === "quality") {
        ctx.fillStyle = selected ? "#ffffff" : "#7de7a5";
        ctx.beginPath();
        ctx.arc(px, py, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#113020";
        ctx.font = "900 16px ui-sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Q", px, py + 6);
        ctx.textAlign = "left";
      } else {
        ctx.fillStyle = selected ? "#ffffff" : "#ffe27a";
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#271707";
        ctx.fillRect(px - 4, py - 1, 8, 2);
        ctx.fillStyle = "#ffb347";
        ctx.fillRect(px + 7, py - 5, 10, 10);
      }
      if (Math.hypot(this.input.mouse.x - px, this.input.mouse.y - py) <= 24) {
        this.setTooltip(factoryLabel(item.type), factoryHelp(item.type), px + 20, py);
      }
    }
  }

  drawFactoryParts(factory, floor, intake, treasury, run, projectedFactory, t) {
    const ctx = this.ctx;
    const target = run.target || projectedFactory;
    const delivered = run.target ? run.delivered : Math.floor(projectedFactory * 0.35);
    const counts = {
      machine: factory.items.filter((item) => item.type === "machine").length,
      quality: factory.items.filter((item) => item.type === "quality").length,
    };
    const partValue = Math.max(1, Math.round(1 + counts.machine * 0.45 + counts.quality * 0.2));
    const liveCount = Math.min(64, Math.max(8, Math.ceil(target / partValue)));
    const stations = [
      { x: intake.x + intake.w + 14, y: floor.y + floor.h * 0.5, type: "intake" },
      ...assemblyStations(factory, floor, intake, treasury),
      { x: treasury.x - 10, y: floor.y + floor.h * 0.5, type: "treasury" },
    ];
    for (let i = 0; i < liveCount; i++) {
      const deliveredValue = Math.min(target, i * partValue);
      const isDelivered = deliveredValue < delivered;
      const phase = run.target
        ? clamp01((run.progress * liveCount - i) / Math.max(1, liveCount / 8))
        : ((t * 0.16 + i / liveCount) % 1);
      const p = pointOnStations(stations, phase);
      const lane = (i % 3) - 1;
      const px = isDelivered ? treasury.x + 18 + ((i * 17) % (treasury.w - 36)) : p.x;
      const py = isDelivered ? treasury.y + 48 + ((i * 11) % 28) : p.y + lane * 9 + Math.sin(t * 5 + i) * 3;
      const processed = stations.some((station) => station.type === "machine" && station.x < px);
      ctx.fillStyle = isDelivered ? "#fff08a" : processed ? "#ffd76b" : "#ffb347";
      ctx.beginPath();
      ctx.arc(px, py, isDelivered ? 4.2 : 5.5, 0, Math.PI * 2);
      ctx.fill();
      if (processed && !isDelivered) {
        ctx.fillStyle = "#28190b";
        ctx.font = "900 8px ui-sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`+${partValue}`, px, py + 3);
        ctx.textAlign = "left";
      }
      if (!isDelivered && i % 3 === 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.moveTo(px - 14, py);
        ctx.lineTo(px - 4, py);
        ctx.stroke();
      }
    }
    ctx.fillStyle = "#28190b";
    ctx.font = "900 13px ui-sans-serif";
    ctx.fillText(`${delivered}/${target} gold value delivered`, treasury.x - 42, treasury.y + treasury.h + 22);
  }

  drawFactoryPlacementGhost(floor, factoryTool) {
    if (!inside(this.input.mouse.x, this.input.mouse.y, floor)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = factoryToolColor(factoryTool);
    ctx.lineWidth = 2;
    const x = this.input.mouse.x;
    const y = this.input.mouse.y;
    if (factoryTool === "belt") {
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x - 36, y);
      ctx.lineTo(x + 56, y);
      ctx.stroke();
    } else if (factoryTool === "machine") {
      roundedRect(ctx, x - 34, y - 24, 68, 48, 8);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, factoryTool === "quality" ? 18 : 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    this.setTooltip(`Placing ${factoryLabel(factoryTool)}`, "Click here to place the selected factory item. Click an existing item first if you want to move it.", x + 18, y);
  }

  drawBattlePrepTargets(selectedTargetId, spyReport, baseOrders = {}, selectedPrepBaseId = null) {
    const ctx = this.ctx;
    const x = 34;
    const y = 464;
    const w = Math.min(760, Math.max(560, this.width * 0.56));
    const h = Math.max(150, this.height - y - 96);
    this.drawGlassPanel(x, y, w, h, "#141d29");
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 19px ui-sans-serif";
    ctx.fillText("Base Orders And Intel", x + 20, y + 32);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 12px ui-sans-serif";
    ctx.fillText("Each owned base can attack one adjacent land, or keep its offensive units home as extra defense.", x + 20, y + 54);
    let yy = y + 82;
    for (const node of this.sim.ownedNodes(0).slice(0, 5)) {
      const selected = node.id === selectedPrepBaseId;
      const order = baseOrders[node.id] || { allocations: {}, reserve: this.sim.makeArmy(0, node.id).length };
      const armyCount = this.sim.makeArmy(0, node.id).length;
      const allocated = Object.values(order.allocations || {}).reduce((sum, value) => sum + value, 0);
      const reserve = order.reserve ?? Math.max(0, armyCount - allocated);
      ctx.fillStyle = selected ? "rgba(125, 231, 165, 0.16)" : "rgba(255,255,255,0.06)";
      roundedRect(ctx, x + 16, yy - 16, w - 32, 58, 8);
      ctx.fill();
      drawBanner(ctx, x + 26, yy - 11, 24, 31, this.sim.player.color, 0);
      ctx.fillStyle = selected ? "#7de7a5" : "#ffffff";
      ctx.font = "900 13px ui-sans-serif";
      ctx.fillText(node.name, x + 62, yy + 2);
      ctx.fillStyle = "#91a0b8";
      ctx.font = "700 11px ui-sans-serif";
      ctx.fillText(`${armyCount} offensive units  |  ${allocated} attacking  |  ${reserve} defending`, x + 62, yy + 18);
      this.drawButton(`prepbase_${node.id}`, selected ? "ACTIVE" : "VIEW", x + w - 318, yy - 10, 62, 26, selected ? "#21c886" : "#33465f", selected ? "#0d6a55" : "#1b2636");
      this.drawButton(`order_defend_${node.id}`, `HOLD ${reserve}`, x + w - 248, yy - 10, 74, 26, reserve > 0 ? "#21c886" : "#33465f", reserve > 0 ? "#0d6a55" : "#1b2636");
      let tx = x + 62;
      const targets = this.sim.adjacentTargetNodesForBase(0, node.id).slice(0, 3);
      for (const target of targets) {
        const owner = this.sim.kingdoms[target.owner];
        const count = order.allocations?.[target.id] || 0;
        this.drawButton(`orderminus_${node.id}_${target.id}`, "-", tx, yy + 28, 24, 23, "#273246", "#151c29");
        this.drawButton(`ordertarget_${node.id}_${target.id}`, `${target.name} ${count}`, tx + 28, yy + 28, 96, 23, count > 0 ? "#ffb347" : owner.color, count > 0 ? "#9a4f17" : "#1b2636");
        this.drawButton(`orderplus_${node.id}_${target.id}`, "+", tx + 128, yy + 28, 24, 23, "#273246", "#151c29");
        tx += 158;
      }
      yy += 70;
    }
    if (this.sim.pendingAllianceOffer) {
      const from = this.sim.kingdoms[this.sim.pendingAllianceOffer.fromId];
      ctx.fillStyle = "rgba(255, 207, 108, 0.14)";
      roundedRect(ctx, x + w - 172, y + 70, 142, 82, 8);
      ctx.fill();
      ctx.fillStyle = "#ffcf6c";
      ctx.font = "900 12px ui-sans-serif";
      ctx.fillText("ALLIANCE OFFER", x + w - 154, y + 92);
      ctx.fillStyle = "#dce6f6";
      ctx.font = "700 11px ui-sans-serif";
      ctx.fillText(from.name, x + w - 154, y + 111);
      this.drawButton("ally_accept", "ACCEPT", x + w - 156, y + 122, 58, 24, "#21c886", "#0d6a55");
      this.drawButton("ally_decline", "NO", x + w - 92, y + 122, 44, 24, "#ff655d", "#93323a");
    }
    const spyTargets = this.sim.adjacentKingdomTargets(0).filter((kingdom) => kingdom.id !== 0);
    if (spyTargets.length) {
      const sx = x + w - 172;
      let sy = this.sim.pendingAllianceOffer ? y + 166 : y + 82;
      ctx.fillStyle = "#8be9ff";
      ctx.font = "900 12px ui-sans-serif";
      ctx.fillText("FRONTIER SPIES", sx + 16, sy);
      sy += 12;
      for (const kingdom of spyTargets.slice(0, 3)) {
        this.drawButton(`spy_${kingdom.id}`, `${kingdom.name} 28g`, sx + 8, sy, 126, 25, "#6f57ff", "#33216d");
        sy += 31;
      }
    }
    if (yy === y + 82) {
      ctx.fillStyle = "#ffcf6c";
      ctx.font = "800 13px ui-sans-serif";
      ctx.fillText("No owned bases can issue orders.", x + 20, yy);
    }
    const reportY = y + h - 74;
    ctx.fillStyle = "rgba(7, 11, 18, 0.52)";
    roundedRect(ctx, x + 16, reportY, w - 32, 54, 7);
    ctx.fill();
    ctx.fillStyle = spyReport?.ok ? "#8be9ff" : spyReport ? "#ff8d74" : "#9fb0c8";
    ctx.font = "900 12px ui-sans-serif";
    ctx.fillText("SPY REPORT", x + 30, reportY + 21);
    ctx.fillStyle = "#dce6f6";
    ctx.font = "700 12px ui-sans-serif";
    if (spyReport?.ok) {
      wrapText(ctx, `${spyReport.target} at ${spyReport.node}: ${spyReport.structures.length} structures and ${spyReport.defenders.length} defenders seen. ${spyReport.structures.slice(0, 3).join(", ") || "No major structures"}.`, x + 118, reportY + 20, w - 164, 15);
    } else if (spyReport) {
      wrapText(ctx, spyReport.reason || "Spy attempt failed.", x + 118, reportY + 20, w - 164, 15);
    } else {
      wrapText(ctx, "No scout report yet.", x + 118, reportY + 20, w - 164, 15);
    }
  }

  drawMapOverlay() {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(3, 6, 11, 0.78)";
    ctx.fillRect(0, 0, this.width, this.height);
    const w = Math.min(this.width - 96, 980);
    const h = Math.min(this.height - 112, 660);
    const x = (this.width - w) / 2;
    const y = (this.height - h) / 2 + 18;
    this.drawGlassPanel(x, y, w, h, "#101827");
    this.drawBoard(x + 22, y + 22, w - 44, h - 96, true);
    this.drawButton("map_close", "CLOSE", x + w - 116, y + h - 56, 86, 34, "#33465f", "#1b2636");
    ctx.fillStyle = "#dce6f6";
    ctx.font = "900 15px ui-sans-serif";
    ctx.fillText("Map rules", x + 30, y + h - 40);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 12px ui-sans-serif";
    ctx.fillText("White rings are your lands. Green rings/roads mark alliances. Gray castles are neutral expansion. Attacks only cross roads.", x + 116, y + h - 40);
  }

  drawTopBar(title, subtitle) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(9, 13, 20, 0.82)";
    ctx.fillRect(0, 0, this.width, 78);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, 78);
    ctx.lineTo(this.width, 78);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 28px ui-sans-serif";
    ctx.fillText(title, 24, 34);
    ctx.fillStyle = "#91a0b8";
    ctx.font = "700 14px ui-sans-serif";
    ctx.fillText(subtitle, 26, 58);
  }

  drawAmbientGrid() {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.028)";
    ctx.lineWidth = 1;
    for (let x = -40; x < this.width + 80; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x + Math.sin(this.time + x * 0.01) * 4, 0);
      ctx.lineTo(x - 60, this.height);
      ctx.stroke();
    }
  }

  drawGlassPanel(x, y, w, h, color) {
    const ctx = this.ctx;
    ctx.save();
    if (!this.lowFx) {
      ctx.shadowColor = "rgba(0,0,0,0.28)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
    }
    ctx.fillStyle = color;
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.11)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  drawToolButton(id, def, x, y, w, h, selected, colors, locked = false) {
    const ctx = this.ctx;
    const hover = inside(this.input.mouse.x, this.input.mouse.y, { x, y, w, h });
    const top = locked ? "#20232b" : selected ? colors[0] : hover ? "#2a3548" : "#202939";
    const bottom = locked ? "#11141a" : selected ? colors[1] : "#121822";
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    ctx.fillStyle = grad;
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = selected ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.13)";
    ctx.stroke();
    ctx.fillStyle = locked ? "#687386" : "#ffffff";
    ctx.font = "900 13px ui-sans-serif";
    ctx.fillText(`${labelFor(def.id)}  ${def.name}`, x + 12, y + 18);
    ctx.fillStyle = locked ? "#6d7789" : selected ? "#102018" : "#87f0b5";
    ctx.font = "900 11px ui-sans-serif";
    ctx.fillText(locked ? "LOCK" : `${def.cost}g`, x + w - 48, y + 18);
    ctx.fillStyle = locked ? "#5d6878" : selected ? "#13231d" : "#8fa1b9";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText(buildStatLine(def), x + 12, y + 36);
    if (hover) this.setTooltip(def.name, `${locked ? "Locked. " : ""}${buildStatLine(def)}. ${def.desc}`, x - 286, y + 4);
    const button = { id, x, y, w, h };
    this.buttons.push(button);
    return button;
  }

  drawButton(id, label, x, y, w, h, top, bottom) {
    const ctx = this.ctx;
    const hover = inside(this.input.mouse.x, this.input.mouse.y, { x, y, w, h });
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, hover ? brighten(top) : top);
    grad.addColorStop(1, bottom || top);
    ctx.save();
    ctx.shadowColor = top;
    ctx.shadowBlur = hover ? 13 : 4;
    ctx.fillStyle = grad;
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 12px ui-sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label.toUpperCase(), x + w / 2, y + h / 2 + 5);
    ctx.textAlign = "left";
    ctx.restore();
    const button = { id, x, y, w, h };
    this.buttons.push(button);
    return button;
  }

  drawPanelTitle(x, y, title, subtitle) {
    const ctx = this.ctx;
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 24px ui-sans-serif";
    ctx.fillText(title, x, y);
    ctx.fillStyle = "#9fb0c8";
    ctx.font = "700 12px ui-sans-serif";
    wrapText(ctx, subtitle, x, y + 26, 276, 16);
  }

  drawPlacementHint(x, y, w, factoryTool, selectedFactoryItem) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(x, y, x + w, y + 54);
    grad.addColorStop(0, "rgba(33, 200, 134, 0.22)");
    grad.addColorStop(1, "rgba(47, 140, 255, 0.12)");
    ctx.fillStyle = grad;
    roundedRect(ctx, x, y, w, 58, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(125, 231, 165, 0.32)";
    ctx.stroke();
    ctx.fillStyle = "#7de7a5";
    ctx.font = "900 11px ui-sans-serif";
    ctx.fillText(selectedFactoryItem ? "MOVE MODE" : "PLACEMENT MODE", x + 14, y + 19);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 15px ui-sans-serif";
    ctx.fillText(selectedFactoryItem ? "Click a new floor spot" : factoryTool ? `${factoryLabel(factoryTool)} selected` : "No tool selected", x + 14, y + 39);
    ctx.fillStyle = "#aebbd0";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText(selectedFactoryItem ? "The selected item will move there." : factoryTool ? "Next floor click places this item." : "Pick a tool below before placing.", x + 14, y + 53);
  }

  drawFactoryToolCard(id, type, label, desc, cost, x, y, w, h, selected) {
    const ctx = this.ctx;
    const hover = inside(this.input.mouse.x, this.input.mouse.y, { x, y, w, h });
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, selected ? "#244f41" : hover ? "#243149" : "#1b2535");
    grad.addColorStop(1, selected ? "#123526" : "#111827");
    ctx.fillStyle = grad;
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = selected ? "#7de7a5" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = factoryToolColor(type);
    if (type === "machine") {
      roundedRect(ctx, x + 12, y + 14, 30, 24, 5);
      ctx.fill();
    } else if (type === "belt") {
      ctx.lineWidth = 5;
      ctx.strokeStyle = factoryToolColor(type);
      ctx.beginPath();
      ctx.moveTo(x + 12, y + 27);
      ctx.lineTo(x + 44, y + 27);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x + 27, y + 28, type === "quality" ? 13 : 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 13px ui-sans-serif";
    ctx.fillText(selected ? "SELECTED" : label.toUpperCase(), x + 54, y + 22);
    ctx.fillStyle = "#91a0b8";
    ctx.font = "700 11px ui-sans-serif";
    ctx.fillText(desc, x + 54, y + 40);
    ctx.fillStyle = selected ? "#7de7a5" : "#ffcf6c";
    ctx.font = "900 12px ui-sans-serif";
    ctx.fillText(`${cost}g`, x + w - 46, y + 22);
    this.buttons.push({ id, x, y, w, h });
  }

  drawFormationCard(formation, x, y, w, h, selected) {
    this.drawGlassPanel(x, y, w, h, selected ? "#21344a" : "#172233");
    const ctx = this.ctx;
    ctx.fillStyle = selected ? "#7de7a5" : "#8fa1b9";
    ctx.font = "900 13px ui-sans-serif";
    ctx.fillText(selected ? "SELECTED" : "FORMATION", x + 18, y + 28);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 24px ui-sans-serif";
    ctx.fillText(formation.name, x + 18, y + 64);
    this.drawFormationPreview(formation.id, x + 42, y + 86, w - 84, 64);
    ctx.fillStyle = "#aebbd0";
    ctx.font = "700 13px ui-sans-serif";
    wrapText(ctx, formation.desc, x + 18, y + 176, w - 36, 18);
    this.drawButton(`formation_${formation.id}`, selected ? "ACTIVE" : "SELECT", x + 34, y + h - 48, w - 68, 34, selected ? "#21c886" : "#273246", selected ? "#0d6a55" : "#151c29");
  }

  setTooltip(title, body, x, y) {
    this.tooltip = { title, body, x, y };
  }

  drawTooltip() {
    if (!this.tooltip) return;
    const ctx = this.ctx;
    const w = 280;
    const h = 92;
    const x = Math.min(this.width - w - 12, Math.max(12, this.tooltip.x));
    const y = Math.min(this.height - h - 12, Math.max(86, this.tooltip.y));
    ctx.fillStyle = "rgba(7, 11, 18, 0.94)";
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(125, 231, 165, 0.42)";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 14px ui-sans-serif";
    ctx.fillText(this.tooltip.title, x + 14, y + 24);
    ctx.fillStyle = "#aebbd0";
    ctx.font = "700 12px ui-sans-serif";
    wrapText(ctx, this.tooltip.body, x + 14, y + 48, w - 28, 15);
  }

  drawFormationPreview(id, x, y, w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundedRect(ctx, x, y, w, h, 8);
    ctx.fill();
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const row = Math.floor(i / 5);
      const col = i % 5;
      let px = x + 18 + col * ((w - 36) / 4);
      let py = y + 18 + row * 28;
      if (id === "wedge") py += Math.abs(col - 2) * 7;
      if (id === "column") {
        px = x + w / 2 + ((i % 2) - 0.5) * 18;
        py = y + 12 + i * 6;
      }
      if (id === "scatter") {
        px = x + 14 + ((i * 37) % Math.max(1, w - 28));
        py = y + 12 + ((i * 23) % Math.max(1, h - 24));
      }
      pts.push([px, py]);
    }
    for (const [px, py] of pts) {
      ctx.fillStyle = "#ffb56b";
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawGlow(x, y, r, color) {
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  hitButton() {
    if (!this.input.mouse.justClicked) return null;
    return [...this.buttons].reverse().find((button) => inside(this.input.mouse.x, this.input.mouse.y, button)) || null;
  }

  hitFactory(x, y) {
    if (!this.factoryFloor || !inside(x, y, this.factoryFloor)) return null;
    const floor = this.factoryFloor;
    for (const item of [...this.sim.player.factory.items].reverse()) {
      const px = floor.x + item.x * floor.w;
      const py = floor.y + item.y * floor.h;
      if (Math.hypot(x - px, y - py) <= 28) return { item };
    }
    return {
      point: {
        x: (x - floor.x) / floor.w,
        y: (y - floor.y) / floor.h,
      },
    };
  }
}

function identityMap() {
  return {
    scale: 1,
    point(x, y) {
      return { x, y };
    },
  };
}

function mapFor(rect) {
  const sx = rect.w / FIELD.w;
  const sy = rect.h / FIELD.h;
  const scale = Math.min(sx, sy);
  return {
    scale,
    point(x, y) {
      return {
        x: rect.x + (x - FIELD.x) * sx,
        y: rect.y + (y - FIELD.y) * sy,
      };
    },
  };
}

function inside(x, y, rect) {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawBar(ctx, x, y, w, h, value, color) {
  ctx.fillStyle = "rgba(4, 8, 14, 0.72)";
  roundedRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundedRect(ctx, x, y, Math.max(0, Math.min(1, value)) * w, h, h / 2);
  ctx.fill();
}

function drawFastBar(ctx, x, y, w, h, value, color) {
  ctx.fillStyle = "rgba(4, 8, 14, 0.72)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.max(0, Math.min(1, value)) * w, h);
}

function drawUnitShape(ctx, type, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (type === "raider") {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x - r * 0.7, y - r * 0.8);
    ctx.lineTo(x - r * 0.45, y + r * 0.8);
    ctx.closePath();
  } else if (type === "guard") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.8, y - r * 0.25);
    ctx.lineTo(x + r * 0.55, y + r * 0.85);
    ctx.lineTo(x - r * 0.55, y + r * 0.85);
    ctx.lineTo(x - r * 0.8, y - r * 0.25);
    ctx.closePath();
  } else if (type === "siege") {
    ctx.rect(x - r, y - r * 0.72, r * 2, r * 1.44);
  } else if (type === "mage") {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  if (type === "archer" || type === "ranger") {
    ctx.strokeStyle = "#102018";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x - r * 0.1, y, r * 0.7, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }
}

function drawStructureGlyph(ctx, type, x, y, size) {
  const s = size * 0.5;
  ctx.strokeStyle = "rgba(255,255,255,0.86)";
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.lineWidth = Math.max(1.5, size * 0.06);
  ctx.beginPath();
  if (type === "tower") {
    ctx.moveTo(x, y - s * 0.62);
    ctx.lineTo(x + s * 0.48, y + s * 0.48);
    ctx.lineTo(x - s * 0.48, y + s * 0.48);
    ctx.closePath();
    ctx.stroke();
  } else if (type === "wall") {
    for (let i = -1; i <= 1; i++) ctx.rect(x + i * s * 0.34 - s * 0.12, y - s * 0.42, s * 0.24, s * 0.84);
    ctx.fill();
  } else if (type === "trap") {
    ctx.moveTo(x - s * 0.55, y - s * 0.55);
    ctx.lineTo(x + s * 0.55, y + s * 0.55);
    ctx.moveTo(x + s * 0.55, y - s * 0.55);
    ctx.lineTo(x - s * 0.55, y + s * 0.55);
    ctx.stroke();
  } else if (type === "farm") {
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(x - s * 0.55, y + i * s * 0.28);
      ctx.lineTo(x + s * 0.55, y + i * s * 0.1);
    }
    ctx.stroke();
  } else if (type === "beam_obelisk" || type === "arcanum") {
    ctx.moveTo(x, y - s * 0.7);
    ctx.lineTo(x + s * 0.42, y);
    ctx.lineTo(x, y + s * 0.7);
    ctx.lineTo(x - s * 0.42, y);
    ctx.closePath();
    ctx.stroke();
  } else if (type === "nova_shrine") {
    ctx.arc(x, y, s * 0.48, 0, Math.PI * 2);
    ctx.moveTo(x + s * 0.72, y);
    ctx.arc(x, y, s * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.font = `900 ${Math.max(9, size * 0.36)}px ui-sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(labelFor(type), x, y + size * 0.13);
    ctx.textAlign = "left";
  }
}

function drawKingdomIcon(ctx, x, y, r, color, income) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - r, y + r * 0.65);
  ctx.lineTo(x - r, y - r * 0.15);
  ctx.lineTo(x - r * 0.55, y - r * 0.15);
  ctx.lineTo(x - r * 0.55, y - r * 0.55);
  ctx.lineTo(x, y - r * 0.9);
  ctx.lineTo(x + r * 0.55, y - r * 0.55);
  ctx.lineTo(x + r * 0.55, y - r * 0.15);
  ctx.lineTo(x + r, y - r * 0.15);
  ctx.lineTo(x + r, y + r * 0.65);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#f7fbff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#101722";
  ctx.font = `900 ${Math.max(8, r * 0.62)}px ui-sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(`+${income}`, x, y + r * 0.34);
  ctx.textAlign = "left";
}

function drawBanner(ctx, x, y, w, h, color, id) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  roundedRect(ctx, x + 3, y + 3, w, h, 4);
  ctx.fill();
  ctx.fillStyle = "#d9e5f7";
  ctx.fillRect(x, y, 3, h + 8);
  const grad = ctx.createLinearGradient(x + 3, y, x + w, y + h);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "#111827");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x + 3, y);
  ctx.lineTo(x + w, y + 4);
  ctx.lineTo(x + w - 7, y + h * 0.54);
  ctx.lineTo(x + w, y + h - 4);
  ctx.lineTo(x + 3, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.font = `900 ${Math.max(9, h * 0.42)}px ui-sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(String(id + 1), x + w * 0.48, y + h * 0.64);
  ctx.textAlign = "left";
  ctx.restore();
}

function brighten(color) {
  if (color.startsWith("#")) return color;
  return color;
}

function labelFor(type) {
  const labels = {
    wall: "W",
    tower: "T",
    barracks: "B",
    trap: "X",
    farm: "F",
    guard_post: "G",
    raider_camp: "R",
    knight_stable: "K",
    siege_yard: "S",
    beam_obelisk: "B",
    nova_shrine: "N",
    ranger_range: "A",
    arcanum: "M",
  };
  return labels[type] || "?";
}

function unitLabel(type) {
  const labels = {
    guard: "G",
    archer: "A",
    raider: "R",
    knight: "K",
    siege: "S",
    ranger: "R",
    mage: "M",
  };
  return labels[type] || "?";
}

function countTypes(items) {
  const counts = {};
  for (const item of items) counts[item.type] = (counts[item.type] || 0) + 1;
  return counts;
}

function buildStatLine(def) {
  const parts = [`HP ${def.hp}`];
  if (def.damage) parts.push(`DMG ${def.damage}`);
  if (def.range) parts.push(`RNG ${def.range}`);
  if (def.spawn) {
    const unit = UNIT_DEFS[def.spawn];
    parts.push(`DEF ${def.spawnCount} ${unit ? unit.name : def.spawn}`);
  }
  if (def.army) {
    const unit = UNIT_DEFS[def.army];
    parts.push(`ATK ${def.armyCount} ${unit ? unit.name : def.army}`);
  }
  if (def.income) parts.push(`+${def.income} GOLD/RD`);
  if (def.blocks) parts.push("SLOW AURA");
  return parts.join("  |  ");
}

function factoryCost(factory, type) {
  const count = (kind) => factory.items?.filter((item) => item.type === kind).length || 0;
  const costs = {
    worker: 14 + count("worker") * 4,
    machine: 24 + count("machine") * 7,
    belt: 18 + count("belt") * 6,
    quality: 28 + count("quality") * 10,
  };
  return costs[type] || 0;
}

function factoryLabel(type) {
  return {
    worker: "Worker",
    machine: "Machine",
    belt: "Belt",
    quality: "Inspector",
  }[type] || "Factory Part";
}

function factoryHelp(type) {
  return {
    worker: "Carries parts across the floor. More workers create more moving gold pieces.",
    machine: "Converts parts into sellable goods. Best near the center of the line.",
    belt: "Speeds the route from parts to treasury. More belt coverage improves efficiency.",
    quality: "Raises factory quality and multiplies final output.",
  }[type] || "Factory item.";
}

function factoryToolColor(type) {
  return {
    worker: "#ffe27a",
    machine: "#2f8cff",
    belt: "#d98cff",
    quality: "#7de7a5",
  }[type] || "#ffffff";
}

function assemblyStations(factory, floor, intake, treasury) {
  const items = [...factory.items].sort((a, b) => a.x - b.x);
  const stations = items.map((item) => ({
    type: item.type,
    x: floor.x + item.x * floor.w,
    y: floor.y + item.y * floor.h,
  }));
  if (stations.length === 0) {
    const y = floor.y + floor.h * 0.5;
    return [
      { type: "worker", x: intake.x + intake.w + floor.w * 0.18, y },
      { type: "machine", x: floor.x + floor.w * 0.52, y },
      { type: "worker", x: treasury.x - floor.w * 0.18, y },
    ];
  }
  return stations;
}

function pointOnStations(stations, phase) {
  if (stations.length === 1) return stations[0];
  const scaled = clamp01(phase) * (stations.length - 1);
  const index = Math.min(stations.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = stations[index];
  const b = stations[index + 1];
  return {
    x: a.x + (b.x - a.x) * local,
    y: a.y + (b.y - a.y) * local,
  };
}

function battleHeadline(result, attacker, defender) {
  if (result.winner === "attacker") {
    const words = result.survivingAttackers >= 3 ? "stormed the gates" : "barely cracked the core";
    return `${attacker.name} ${words} of ${defender.name}`;
  }
  const words = result.survivingDefenders >= 3 ? "stood unbroken" : "survived by a thread";
  return `${defender.name} ${words} against ${attacker.name}`;
}

function areaHeadline(result, area, attacker, defender) {
  if (result.contestedNeutral) {
    const winner = result.winner === "attacker" ? attacker : defender;
    return `${winner.name} won the neutral clash at ${area}`;
  }
  if (result.winner === "attacker") return `${area} fell to ${attacker.name}`;
  return `${area} held under ${defender.name}`;
}

function unitSummary(army) {
  if (army.length === 0) return "No army yet";
  const counts = {};
  for (const type of army) counts[type] = (counts[type] || 0) + 1;
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${UNIT_DEFS[type]?.name || type}`)
    .join("  |  ");
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}
