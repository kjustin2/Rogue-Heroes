import type { Vec2 } from "../core/math";
import { isBuildingKind, isDefenseKind, isInfantryKind, type CombatEntity, type DamagePart, type InfantryStance } from "../game/damageModel";
import {
  POP_CAP,
  TROOP_CATALOG,
  TECH_TREE,
  DEFENSE_CATALOG,
  SUPPORT_POWERS,
  supportPowerSpec,
  INCOME_BY_LEVEL,
  generatorEfficiency,
  baseIncome,
  incomeUpgradeCost,
  commandUpgradeCost,
  isTechUnlocked,
  modeDef,
  type TroopKind,
  type DefenseKind,
  type SupportPowerKind,
} from "../game/sim";
import type { Intent, ShotPreview, TacticalOrder, TacticalSim, TurnDamageEntry, TurnReport } from "../game/sim";

// Discovery pacing state: which doctrines we've already seen researched, and when each
// troop/specialization was first revealed (drives the NEW badge + reveal flash). Module
// scope — there is one HUD. Reset detection: if the base no longer has a tech we've
// seen, a new battle started.
const NEW_BADGE_MS = 45000;
const revealTracker = {
  seenTech: new Set<string>(),
  seeded: false,
  revealedTroopAt: new Map<string, number>(),
  revealedTechAt: new Map<string, number>(),
};

function isRecentlyRevealed(at: number | undefined): boolean {
  return at !== undefined && Date.now() - at < NEW_BADGE_MS;
}

function syncRevealTracking(base: CombatEntity): void {
  const owned = base.unlockedTech ?? [];
  for (const id of revealTracker.seenTech) {
    if (!owned.includes(id)) {
      // Battle reset — start the discovery arc over.
      revealTracker.seenTech.clear();
      revealTracker.revealedTroopAt.clear();
      revealTracker.revealedTechAt.clear();
      revealTracker.seeded = false;
      break;
    }
  }
  const fresh = owned.filter((id) => !revealTracker.seenTech.has(id));
  for (const id of fresh) {
    revealTracker.seenTech.add(id);
    if (!revealTracker.seeded) continue; // don't badge tech from a restored save
    const now = Date.now();
    for (const spec of TROOP_CATALOG) if (spec.tech === id) revealTracker.revealedTroopAt.set(spec.kind, now);
    for (const node of TECH_TREE) if (node.tier === 4 && node.requires.includes(id)) revealTracker.revealedTechAt.set(node.id, now);
  }
  revealTracker.seeded = true;
}

const ORDER_ACTIONS: Array<{ id: Intent; label: string; tip: string }> = [
  { id: "move", label: "Move", tip: "Select Move, then click ground or a cover object. Costs 1 CP. Soldiers move farther than heavy units." },
  { id: "shoot", label: "Shoot", tip: "Select Shoot, pick an enemy part, then confirm. The map line previews cover, high ground, estimated damage, and shot accuracy." },
  { id: "grenade", label: "Grenade", tip: "Soldier only. Throw a limited-supply grenade in a short arc with splash damage." },
  { id: "ram", label: "Ram", tip: "Tank only. Select a close target or wall, then confirm. Costs 1 CP, deals 72 damage, and damages your front armor." },
  { id: "melee", label: "Strike", tip: "Melee unit only. Rush a nearby hostile and hit hard at close range." },
  { id: "defend", label: "Crouch", tip: "Infantry only. Improves accuracy and makes head shots harder, but slows the next move." },
  { id: "overwatch", label: "Overwatch", tip: "Hold fire until a hostile MOVES within watch range this resolve, then take a snap reaction shot (reduced accuracy). Costs 1 CP." },
  { id: "mine", label: "Mine", tip: "Sapper only. Plant a proximity mine at this spot ($15 + 1 CP). Hostiles that step on it eat a splash blast. Invisible to the enemy." },
];

export interface HudCallbacks {
  setIntent(intent: Intent): void;
  endTurn(): void;
  reset(): void;
  select(id: string): void;
  deselect(): void;
  queueMove(destination: Vec2): boolean;
  queueMoveToCover(id: string): boolean;
  queueTakeCover(id: string): boolean;
  queueClimbCover(id: string): boolean;
  queueShootPart(id: string, partId: string): boolean;
  queueGrenadePart(id: string, partId: string): boolean;
  queueGrenadeAt(destination: Vec2): boolean;
  queueRam(id: string): boolean;
  queueMelee(id: string): boolean;
  queueMeleePart(id: string, partId: string): boolean;
  queueDefend(stance?: InfantryStance): boolean;
  queueOverwatch(): boolean;
  queueMine(): boolean;
  queueSpawnTroop(kind: TroopKind): boolean;
  upgradeBaseIncome(): boolean;
  upgradeBaseCommand(): boolean;
  beginBuild(kind: DefenseKind): void;
  cancelBuild(): void;
  queueBuildStructure(point: Vec2): boolean;
  beginSupport(kind: SupportPowerKind): void;
  cancelSupport(): void;
  queueSupportAt(point: Vec2): boolean;
  queueShootAt(point: Vec2): boolean;
  researchTech(nodeId: string): boolean;
  cancelOrder(id: string): boolean;
  explainGrenadeTarget(id: string): boolean;
  explainRamTarget(id: string): boolean;
  explainMeleeTarget(id: string): boolean;
  openMenu(): void;
  returnToMainMenu(): void;
  editUnit(id: string): void;
}

export class Hud {
  private lastHtml = "";
  private action: Intent = "select";
  private targetId: string | undefined;
  private targetPartId: string | undefined;
  private friendlyDetailsId: string | undefined;
  private hoverEntityId: string | undefined;
  private logExpanded = false;
  private readonly tooltip: HTMLDivElement;
  private tooltipAnchor: HTMLElement | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly sim: TacticalSim,
    private readonly callbacks: HudCallbacks
  ) {
    this.root.addEventListener("click", (event) => this.handleClick(event));
    this.root.addEventListener("pointerover", (event) => this.handleTooltipOver(event));
    this.root.addEventListener("pointermove", (event) => this.handleTooltipMove(event));
    this.root.addEventListener("pointerout", (event) => this.handleTooltipOut(event));
    this.tooltip = document.createElement("div");
    this.tooltip.className = "hud-tooltip";
    document.body.append(this.tooltip);
  }

  get focusedTargetId(): string | undefined {
    return this.targetId;
  }

  get focusedPartId(): string | undefined {
    return this.targetPartId;
  }

  get hoveredTargetId(): string | undefined {
    return this.hoverEntityId;
  }

  chooseBoardEntity(id: string): void {
    const entity = this.sim.entity(id);
    if (!entity) return;
    if (entity.kind === "cover" && this.action === "move" && this.sim.selected?.kind === "tank") {
      if (this.callbacks.queueMoveToCover(entity.id)) {
        this.action = "select";
        this.callbacks.setIntent("select");
      }
      return;
    }
    if (entity.kind === "cover" && this.action !== "shoot" && this.action !== "grenade" && this.action !== "ram" && this.action !== "melee") {
      this.targetId = entity.id;
      this.targetPartId = this.firstTargetablePart(entity);
      this.friendlyDetailsId = undefined;
      this.action = "interact";
      this.callbacks.setIntent("select");
      return;
    }
    if (entity.team === "player") {
      this.chooseUnit(id);
    } else {
      this.chooseTarget(id);
    }
  }

  // Activate the Nth visible action in the command deck (keyboard number keys), so the
  // on-screen number always matches the key that triggers it for every unit type.
  activateActionSlot(slot: number): void {
    const actor = this.sim.selected;
    if (!actor || actor.team !== "player" || actor.kind === "base") return;
    const visible = ORDER_ACTIONS.filter((option) => actionVisible(option.id, actor, this.sim));
    const choice = visible[slot - 1];
    if (choice) this.setAction(choice.id);
  }

  // Escape handling during a battle: collapse the log, cancel a pending build, or step back to
  // selection. Returns false when there is nothing to dismiss (so the caller can open the menu).
  handleEscape(): boolean {
    if (this.logExpanded) {
      this.logExpanded = false;
      this.update();
      return true;
    }
    if (this.sim.pendingBuild) {
      this.callbacks.cancelBuild();
      this.update();
      return true;
    }
    if (this.sim.pendingSupport) {
      this.callbacks.cancelSupport();
      this.update();
      return true;
    }
    if (this.action !== "select") {
      this.setAction("select");
      return true;
    }
    if (this.targetId || this.friendlyDetailsId) {
      this.targetId = undefined;
      this.targetPartId = undefined;
      this.friendlyDetailsId = undefined;
      this.callbacks.setIntent("select");
      this.update();
      return true;
    }
    return false;
  }

  setAction(action: Intent): void {
    // Picking any unit action cancels an in-progress defense placement or strike call.
    if (this.sim.pendingBuild) this.callbacks.cancelBuild();
    if (this.sim.pendingSupport) this.callbacks.cancelSupport();
    this.action = action;
    if (action === "select" || action === "move") this.targetPartId = undefined;
    if (action === "select" || action === "move") this.targetId = undefined;
    if (action !== "select") this.friendlyDetailsId = undefined;
    if (action === "shoot" || action === "grenade" || action === "melee") this.chooseDefaultTargetPart();
    this.callbacks.setIntent(action);
    this.update();
  }

  toggleLog(): void {
    this.logExpanded = !this.logExpanded;
    this.update();
  }

  resetGame(): void {
    this.action = "select";
    this.targetId = undefined;
    this.targetPartId = undefined;
    this.friendlyDetailsId = undefined;
    this.hoverEntityId = undefined;
    this.callbacks.reset();
    this.update();
  }

  chooseGround(destination: Vec2): void {
    // Placing a base defense: drop it at the clicked spot.
    if (this.sim.pendingBuild && this.sim.phase === "command") {
      if (this.callbacks.queueBuildStructure(destination)) {
        this.action = "select";
        this.callbacks.setIntent("select");
      }
      return;
    }
    // Calling a support strike: mark the clicked spot as the target point.
    if (this.sim.pendingSupport && this.sim.phase === "command") {
      if (this.callbacks.queueSupportAt(destination)) {
        this.action = "select";
        this.callbacks.setIntent("select");
      }
      this.update();
      return;
    }
    if (this.action === "grenade" && this.sim.phase === "command") {
      if (this.callbacks.queueGrenadeAt(destination)) {
        this.action = "select";
        this.targetId = undefined;
        this.targetPartId = undefined;
        this.callbacks.setIntent("select");
      }
      return;
    }
    // Explosive shooters (tank, artillery, mortar, grenadier, mortar turret) can target a spot.
    if (this.action === "shoot" && this.sim.phase === "command" && this.sim.selectedCanGroundTarget()) {
      if (this.callbacks.queueShootAt(destination)) this.afterConfirmedOrder();
      return;
    }
    if (this.action !== "move" || this.sim.phase !== "command") {
      this.targetId = undefined;
      this.targetPartId = undefined;
      this.friendlyDetailsId = undefined;
      this.action = "select";
      this.callbacks.deselect();
      return;
    }
    if (this.callbacks.queueMove(destination)) {
      this.action = "select";
      this.callbacks.setIntent("select");
    }
  }

  update(): void {
    this.pruneInvalidFocus();
    if (this.tooltipAnchor && !this.tooltipAnchor.isConnected) this.hideTooltip();

    const selected = this.sim.selected;
    const actor = selected?.team === "player" ? selected : undefined;
    const target = this.targetId ? this.sim.entity(this.targetId) : undefined;
    const friendlyDetails = this.friendlyDetailsId ? this.sim.entity(this.friendlyDetailsId) : undefined;
    const playerUnits = this.sim.entities.filter((entity) => entity.team === "player");
    const enemies = this.sim.entities.filter((entity) => entity.team === "enemy");
    const cover = this.sim.entities.filter((entity) => entity.team === "neutral");
    // Only open the target drawer when the selected actor can actually perform the armed
    // attack — never for the Home Base (which has its own command deck and cannot attack).
    const targetPanelOpen = !target && Boolean(actor) && actionVisible(this.action, actor, this.sim);
    // "All set" reflects squad maneuvering, so ignore the base's economy command point.
    const squadUnits = playerUnits.filter((unit) => unit.status.alive && !isBuildingKind(unit.kind) && !isDefenseKind(unit.kind));
    const allOrdersSet = this.sim.phase === "command" && squadUnits.length > 0 && squadUnits.every((unit) => unit.commandPoints <= 0);
    const playerOrders = new Map<string, TacticalOrder[]>();
    for (const order of this.sim.orders.filter((item) => this.sim.entity(item.actorId)?.team === "player")) {
      const orders = playerOrders.get(order.actorId) ?? [];
      orders.push(order);
      playerOrders.set(order.actorId, orders);
    }

    const nextHtml = `
      <div class="topbar compact-top">
        <button class="btn primary end-turn" data-command="end" ${this.sim.phase !== "command" ? "disabled" : ""} data-tip="Resolve every queued order. Hotkey: Space.">
          End Turn
          <span>Space</span>
        </button>
        <button class="btn ghost menu-btn" data-command="open-menu" data-tip="Open the in-battle menu: save, controls, or return to the main menu. Hotkey: Esc.">Menu <span>Esc</span></button>
        ${turnChip(this.sim)}
        ${modeChip(this.sim)}
        ${eventChip(this.sim)}
        ${forecastChip(this.sim)}
      </div>
      ${bossBar(this.sim)}

      <aside class="panel roster ${allOrdersSet ? "all-set" : ""}">
        <div class="panel-title">Squad${allOrdersSet ? `<span class="all-orders-chip">All set</span>` : ""}</div>
        ${playerUnits.map((unit) => unitCard(unit, unit.id === actor?.id, playerOrders.get(unit.id) ?? [], this.sim)).join("")}
      </aside>

      ${targetPanelOpen ? `
        <aside class="panel target-panel">
          ${target ? inspectEntity(target, "Target", this.targetPartId, "close-target") : emptyTargetPanel(this.action)}
          <div class="target-list">
            <div class="panel-title">Hostiles</div>
            ${enemies.map((unit) => targetChip(unit, unit.id === this.targetId, actor, this.sim)).join("")}
            <div class="panel-title small">Cover</div>
            ${cover.map((unit) => targetChip(unit, unit.id === this.targetId, actor, this.sim)).join("")}
          </div>
        </aside>
      ` : ""}

      ${friendlyDetails?.team === "player" ? `
        <aside class="panel unit-detail-panel">
          ${inspectEntity(friendlyDetails, "Unit Detail", undefined, "close-unit-detail")}
        </aside>
      ` : ""}

      <section class="commandbar">
        ${orderPlanner(actor, target, this.targetPartId, this.action, playerOrders.get(actor?.id ?? "") ?? [], this.sim)}
      </section>

      <div class="money-bar" data-tip="Treasury. Your Home Base earns money each round (less if its reactor is damaged). Spend it deploying troops, building defenses, or upgrading your Home Base.">
        <span class="money-bar__icon">$</span>
        <span class="money-bar__label">Treasury</span>
        <span class="money-bar__value">${this.sim.money("player")}</span>
      </div>

      <section class="log compact-log ${this.logExpanded ? "expanded" : ""}" data-tip="${escapeAttr(this.sim.log.join(" / "))}">
        <button class="log-toggle" data-command="toggle-log" aria-label="${this.logExpanded ? "Close battle log" : "Open battle log"}" data-tip="${this.logExpanded ? "Collapse action log. Hotkey: L or Esc." : "Expand recent hits, misses, and system damage. Hotkey: L."}">
          <span class="log-toggle-icon">${this.logExpanded ? "X" : "+"}</span>
          <strong>${this.logExpanded ? "Close Battle Log" : "Open Log"}</strong>
        </button>
        ${this.logExpanded ? battleLogPanel(this.sim) : `<span class="log-line">${escapeHtml(this.sim.log[0] ?? "No events")}</span>`}
      </section>

      ${endScreen(this.sim)}
    `;

    if (nextHtml !== this.lastHtml) {
      const scrollState = this.captureScrollState();
      this.root.innerHTML = nextHtml;
      this.lastHtml = nextHtml;
      this.restoreScrollState(scrollState);
    }
  }

  private handleClick(event: Event): void {
    this.hideTooltip();
    const target = event.target as HTMLElement;
    const disabled = target.closest<HTMLElement>("[data-disabled='true']");
    if (disabled) return;

    const detailId = target.closest<HTMLElement>("[data-detail]")?.dataset.detail;
    if (detailId) {
      const entity = this.sim.entity(detailId);
      if (entity?.team === "player") {
        this.callbacks.select(detailId);
        this.targetId = undefined;
        this.targetPartId = undefined;
        this.friendlyDetailsId = detailId;
        this.action = "select";
        this.callbacks.setIntent("select");
      }
      return;
    }

    const cancelOrder = target.closest<HTMLElement>("[data-cancel-order]")?.dataset.cancelOrder;
    if (cancelOrder) {
      if (this.callbacks.cancelOrder(cancelOrder)) {
        this.action = "select";
        this.callbacks.setIntent("select");
      }
      return;
    }

    const orderAction = target.closest<HTMLElement>("[data-order-action]")?.dataset.orderAction as Intent | undefined;
    if (orderAction) {
      this.setAction(orderAction);
    }

    const spawnKind = target.closest<HTMLElement>("[data-spawn]")?.dataset.spawn as TroopKind | undefined;
    if (spawnKind) {
      if (this.callbacks.queueSpawnTroop(spawnKind)) this.afterConfirmedOrder();
    }

    const baseUpgrade = target.closest<HTMLElement>("[data-base-upgrade]")?.dataset.baseUpgrade;
    if (baseUpgrade === "income") {
      if (this.callbacks.upgradeBaseIncome()) this.afterConfirmedOrder();
    }
    if (baseUpgrade === "command") {
      if (this.callbacks.upgradeBaseCommand()) this.afterConfirmedOrder();
    }

    const buildKind = target.closest<HTMLElement>("[data-build]")?.dataset.build as DefenseKind | undefined;
    if (buildKind) this.callbacks.beginBuild(buildKind);
    if (target.closest<HTMLElement>("[data-build-cancel]")) this.callbacks.cancelBuild();

    const supportKind = target.closest<HTMLElement>("[data-support]")?.dataset.support as SupportPowerKind | undefined;
    if (supportKind) this.callbacks.beginSupport(supportKind);
    if (target.closest<HTMLElement>("[data-support-cancel]")) this.callbacks.cancelSupport();

    const editUnitId = target.closest<HTMLElement>("[data-edit-unit]")?.dataset.editUnit;
    if (editUnitId) {
      this.callbacks.editUnit(editUnitId);
      return;
    }

    const techNodeId = target.closest<HTMLElement>("[data-tech]")?.dataset.tech;
    if (techNodeId) {
      if (this.callbacks.researchTech(techNodeId)) this.afterConfirmedOrder();
    }

    const part = target.closest<HTMLElement>("[data-part]")?.dataset.part;
    if (part && this.targetId) this.targetPartId = part;

    const select = target.closest<HTMLElement>("[data-select]")?.dataset.select;
    if (select) this.chooseBoardEntity(select);

    const confirm = target.closest<HTMLElement>("[data-confirm]")?.dataset.confirm as Intent | undefined;
    if (confirm === "shoot" && this.targetId && this.targetPartId) {
      if (this.callbacks.queueShootPart(this.targetId, this.targetPartId)) this.afterConfirmedOrder();
    }
    if (confirm === "grenade" && this.targetId && this.targetPartId) {
      if (this.callbacks.queueGrenadePart(this.targetId, this.targetPartId)) this.afterConfirmedOrder();
    }
    if (confirm === "ram" && this.targetId) {
      if (this.callbacks.queueRam(this.targetId)) this.afterConfirmedOrder();
    }
    if (confirm === "melee" && this.targetId && this.targetPartId) {
      if (this.callbacks.queueMeleePart(this.targetId, this.targetPartId)) this.afterConfirmedOrder();
    }
    if (confirm === "defend") {
      if (this.callbacks.queueDefend("crouched")) this.afterConfirmedOrder();
    }
    if (confirm === "overwatch") {
      if (this.callbacks.queueOverwatch()) this.afterConfirmedOrder();
    }
    if (confirm === "mine") {
      if (this.callbacks.queueMine()) this.afterConfirmedOrder();
    }

    const coverAction = target.closest<HTMLElement>("[data-cover-action]")?.dataset.coverAction;
    if (coverAction && this.targetId) {
      if (coverAction === "shoot") {
        this.action = "shoot";
        this.callbacks.setIntent("shoot");
        this.chooseDefaultTargetPart();
      } else if (coverAction === "cover") {
        if (this.callbacks.queueTakeCover(this.targetId)) this.afterConfirmedOrder();
      } else if (coverAction === "climb") {
        if (this.callbacks.queueClimbCover(this.targetId)) this.afterConfirmedOrder();
      }
    }

    const command = target.closest<HTMLElement>("[data-command]")?.dataset.command;
    if (command === "end") this.callbacks.endTurn();
    if (command === "reset") this.resetGame();
    if (command === "open-menu") this.callbacks.openMenu();
    if (command === "to-menu") this.callbacks.returnToMainMenu();
    if (command === "toggle-log") this.logExpanded = !this.logExpanded;
    if (command === "close-unit-detail") this.friendlyDetailsId = undefined;
    if (command === "close-target") {
      this.targetId = undefined;
      this.targetPartId = undefined;
      if (this.action === "move" || this.action === "shoot" || this.action === "grenade" || this.action === "ram" || this.action === "melee") {
        this.action = "select";
        this.callbacks.setIntent("select");
      }
    }
    if (command === "clear-order-focus") {
      this.action = "select";
      this.targetId = undefined;
      this.targetPartId = undefined;
      this.callbacks.setIntent("select");
    }

    // Rebuild immediately so interactions feel instant despite the per-frame render throttle.
    this.update();
  }

  private chooseUnit(id: string): void {
    this.callbacks.select(id);
    this.targetId = undefined;
    this.targetPartId = undefined;
    this.friendlyDetailsId = undefined;
    this.action = "select";
    this.callbacks.setIntent("select");
  }

  private chooseTarget(id: string): void {
    const target = this.sim.entity(id);
    if (!target) return;
    this.targetId = id;
    this.targetPartId = this.firstTargetablePart(target);
    if (this.action === "grenade") this.callbacks.explainGrenadeTarget(id);
    if (this.action === "ram") this.callbacks.explainRamTarget(id);
    if (this.action === "melee") this.callbacks.explainMeleeTarget(id);
    if (this.action !== "shoot" && this.action !== "grenade" && this.action !== "ram" && this.action !== "melee") {
      this.action = "inspect";
      this.callbacks.setIntent(this.action);
    }
  }

  private afterConfirmedOrder(): void {
    this.action = "select";
    this.targetId = undefined;
    this.targetPartId = undefined;
    this.callbacks.setIntent("select");
  }

  private pruneInvalidFocus(): void {
    const friendly = this.friendlyDetailsId ? this.sim.entity(this.friendlyDetailsId) : undefined;
    if (!friendly || friendly.team !== "player" || !friendly.status.alive) this.friendlyDetailsId = undefined;

    const target = this.targetId ? this.sim.entity(this.targetId) : undefined;
    if (!target) {
      this.targetId = undefined;
      this.targetPartId = undefined;
      return;
    }
    if (this.targetPartId && !this.sim.targetableParts(target).some((part) => part.id === this.targetPartId)) {
      this.targetPartId = this.firstTargetablePart(target);
    }
  }

  private chooseDefaultTargetPart(): void {
    const target = this.targetId ? this.sim.entity(this.targetId) : undefined;
    if (!target || this.targetPartId) return;
    this.targetPartId = this.firstTargetablePart(target);
  }

  private captureScrollState(): Map<string, number> {
    const state = new Map<string, number>();
    for (const selector of [".commandbar", ".target-panel", ".unit-detail-panel", ".roster"]) {
      const node = this.root.querySelector<HTMLElement>(selector);
      if (node) state.set(selector, node.scrollTop);
    }
    return state;
  }

  private restoreScrollState(state: Map<string, number>): void {
    for (const [selector, top] of state) {
      const node = this.root.querySelector<HTMLElement>(selector);
      if (node) node.scrollTop = top;
    }
  }

  private firstTargetablePart(target: CombatEntity): string | undefined {
    return this.sim.targetableParts(target)[0]?.id;
  }

  private handleTooltipOver(event: PointerEvent): void {
    const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    const hoverId = (event.target as HTMLElement).closest<HTMLElement>("[data-select]")?.dataset.select;
    if (hoverId) this.hoverEntityId = hoverId;
    if (!anchor) return;
    this.tooltipAnchor = anchor;
    this.tooltip.textContent = anchor.dataset.tip ?? "";
    this.tooltip.classList.add("visible");
    this.positionTooltip(event);
  }

  private handleTooltipMove(event: PointerEvent): void {
    if (!this.tooltipAnchor) return;
    this.positionTooltip(event);
  }

  private handleTooltipOut(event: PointerEvent): void {
    const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    const hoverSelect = (event.target as HTMLElement).closest<HTMLElement>("[data-select]");
    if (hoverSelect) {
      const nextSelect = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.closest("[data-select]") : undefined;
      if (!nextSelect) this.hoverEntityId = undefined;
    }
    if (!anchor || !this.tooltipAnchor) return;
    const next = event.relatedTarget instanceof HTMLElement ? event.relatedTarget.closest("[data-tip]") : undefined;
    if (next === anchor) return;
    this.hideTooltip();
  }

  private hideTooltip(): void {
    this.tooltipAnchor = undefined;
    this.tooltip.classList.remove("visible");
    this.tooltip.textContent = "";
    this.tooltip.style.left = "-9999px";
    this.tooltip.style.top = "-9999px";
  }

  private positionTooltip(event: PointerEvent): void {
    const margin = 12;
    const width = Math.min(320, window.innerWidth - margin * 2);
    this.tooltip.style.maxWidth = `${width}px`;
    const rect = this.tooltip.getBoundingClientRect();
    const nextLeft = Math.min(window.innerWidth - rect.width - margin, Math.max(margin, event.clientX + 14));
    const below = event.clientY + 18 + rect.height < window.innerHeight - margin;
    const nextTop = below
      ? event.clientY + 18
      : Math.max(margin, event.clientY - rect.height - 18);
    this.tooltip.style.left = `${nextLeft}px`;
    this.tooltip.style.top = `${nextTop}px`;
  }
}

function unitCard(entity: CombatEntity, selected: boolean, orders: TacticalOrder[], sim: TacticalSim): string {
  const lastOrder = orders.at(-1);
  const spent = entity.status.alive && entity.commandPoints <= 0;
  const crouched = entity.stance === "crouched" && entity.status.alive;
  return `
    <div class="unit-card ${selected ? "selected" : ""} ${entity.status.alive ? "" : "dead"} ${spent ? "spent" : ""} ${crouched ? "crouched" : ""}">
      <button class="unit-select" data-select="${entity.id}" data-tip="${escapeAttr(cpTip(entity))}">
        <span class="unit-name">${escapeHtml(entity.name)}</span>
        <span class="unit-meta">${kindLabel(entity)} / ${cpPips(entity)}${grenadeSupplyText(entity)} / ${spent ? "Orders set" : statusText(entity)}${crouched ? `<span class="stance-chip">Crouched</span>` : ""}</span>
        <span class="queued-order">${orders.length ? orders.map((order) => escapeHtml(orderSummary(order, sim).replace("Queued: ", ""))).join(" / ") : "Idle"}</span>
      </button>
      <div class="unit-actions">
        <button class="mini-action detail" data-detail="${entity.id}" data-tip="Open ${escapeAttr(entity.name)} part health, status, and systems.">Info</button>
        ${lastOrder && sim.phase === "command" ? `<button class="mini-action undo" data-cancel-order="${lastOrder.id}" data-tip="Undo ${escapeAttr(entity.name)}'s latest queued order and refund 1 CP.">Undo</button>` : ""}
      </div>
    </div>
  `;
}

function targetChip(entity: CombatEntity, selected: boolean, actor: CombatEntity | undefined, sim: TacticalSim): string {
  const firstPart = sim.targetableParts(entity)[0];
  // Only compute a line-of-sight preview for hostiles; doing it for every cover object each
  // frame is expensive and unnecessary (cover chips just select a target).
  const preview = actor && firstPart && entity.team !== "neutral" ? sim.previewShot(actor.id, entity.id, firstPart.id) : undefined;
  const blocked = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const tip = blocked
    ? `${entity.name} is behind ${blocked.name}; shots hit that cover first.`
    : preview?.blockedByGround
      ? `${entity.name} is behind high ground; low shots may hit the map first.`
    : `${entity.name}: ${kindLabel(entity)}, ${statusText(entity)}.`;
  return `
    <button class="target-chip ${selected ? "selected" : ""} ${entity.status.alive ? "" : "dead"}" data-select="${entity.id}" data-tip="${escapeAttr(tip)}">
      <span>${escapeHtml(entity.name)}</span>
      <span>${blocked ? `Blocked by ${escapeHtml(blocked.name)}` : preview?.blockedByGround ? "Blocked by High Ground" : statusText(entity)}</span>
    </button>
  `;
}

function emptyTargetPanel(action: Intent): string {
  const titleText = action === "move" ? "Move Active" : "Pick Target";
  const body = action === "move"
    ? "Click ground on the map or select a cover object below."
    : action === "ram"
      ? "Choose a hostile or cover object for the ram."
      : action === "grenade"
        ? "Click ground to throw at a location, or choose a hostile/cover target."
      : "Choose a hostile or cover object, then pick a part in the order bar.";
  return `
    <div class="inspect-head">
      <div>
        <div class="panel-title">Target</div>
        <h2>${titleText}</h2>
      </div>
      <div class="inspect-actions">
        <button class="icon-btn close-btn" data-command="close-target" aria-label="Close target panel" data-tip="Close this target drawer and return to selection."><span>X</span><strong>Close</strong></button>
      </div>
    </div>
    <div class="empty-target">${body}</div>
  `;
}

function endScreen(sim: TacticalSim): string {
  if (sim.phase !== "victory" && sim.phase !== "defeat") return "";
  const win = sim.phase === "victory";
  const turns = sim.turn;
  const turnWord = turns === 1 ? "turn" : "turns";
  const playerUnits = sim.living("player").filter((e) => isInfantryKind(e.kind) || e.kind === "tank").length;
  const enemyUnits = sim.living("enemy").filter((e) => e.kind !== "cover").length;
  const sub = win
    ? `Enemy forces neutralized in ${turns} ${turnWord}. ${playerUnits} unit${playerUnits === 1 ? "" : "s"} still standing.`
    : `Your command was overrun on turn ${turns}. ${enemyUnits} enemy asset${enemyUnits === 1 ? "" : "s"} remain.`;
  return `
    <div class="endscreen endscreen--${win ? "victory" : "defeat"}">
      <div class="endscreen__card">
        <div class="endscreen__kicker">Battle Report</div>
        <h2 class="endscreen__title">${win ? "VICTORY" : "DEFEAT"}</h2>
        <p class="endscreen__sub">${escapeHtml(sub)}</p>
        <div class="endscreen__actions">
          <button class="endscreen__btn" data-command="reset" type="button">Play Again</button>
          <button class="endscreen__btn endscreen__btn--ghost" data-command="to-menu" type="button">Main Menu</button>
        </div>
      </div>
    </div>
  `;
}

// A persistent turn + phase indicator so players always know which round it is and whether
// orders are being planned or resolved.
function turnChip(sim: TacticalSim): string {
  const phaseLabel = sim.phase === "command" ? "Command" : sim.phase === "resolve" ? "Resolving" : sim.phase === "victory" ? "Victory" : "Defeat";
  return `<span class="turn-chip ${sim.phase}" data-tip="Current battle round and phase.">Turn ${sim.turn} <em>${phaseLabel}</em></span>`;
}

function modeChip(sim: TacticalSim): string {
  const def = modeDef(sim.mode);
  if (sim.mode === "destroy") {
    return `<span class="mode-chip" data-tip="${escapeAttr(def.blurb)}">${escapeHtml(sim.mapDef.name)} · ${escapeHtml(def.name)}</span>`;
  }
  const s = sim.modeState;
  if (sim.mode === "survival") {
    return `<span class="mode-chip score" data-tip="${escapeAttr(def.blurb)} ${escapeHtml(sim.mapDef.name)}.">${escapeHtml(def.name)} <strong class="score-you">Round ${sim.turn}</strong> <em>/ ${s.target}</em></span>`;
  }
  const label = sim.mode === "ctf" ? "Captures" : sim.mode === "domination" ? "Sectors" : "Hold";
  return `<span class="mode-chip score" data-tip="${escapeAttr(def.blurb)} ${escapeHtml(sim.mapDef.name)}.">${escapeHtml(def.name)} <strong class="score-you">${s.playerScore}</strong> – <strong class="score-foe">${s.enemyScore}</strong> <em>/ ${s.target} ${label}</em></span>`;
}

// Boss/elite HP bar pinned to the top of the screen while a named or elite hostile lives.
function bossBar(sim: TacticalSim): string {
  const boss = sim.entities.find((e) => e.team === "enemy" && e.status.alive && (e.bossName || e.elite));
  if (!boss) return "";
  const hp = boss.parts.reduce((sum, p) => sum + p.hp, 0);
  const max = boss.parts.reduce((sum, p) => sum + p.maxHp, 0);
  const fraction = Math.max(0, Math.min(1, hp / Math.max(1, max)));
  return `
    <div class="boss-bar" data-tip="${escapeAttr(`${boss.name}: elite hostile. Destroy its critical parts to bring it down.`)}">
      <span class="boss-bar__name">${escapeHtml(boss.bossName ?? boss.name)}</span>
      <div class="boss-bar__track"><i style="width:${(fraction * 100).toFixed(1)}%"></i></div>
    </div>
  `;
}

// A warning chip for the active/upcoming dynamic map event (sandstorm, barrage, collapse).
function eventChip(sim: TacticalSim): string {
  const notice = sim.environment().notice;
  if (!notice) return "";
  return `<span class="mode-chip event-chip" data-tip="Dynamic battlefield event">${escapeHtml(notice)}</span>`;
}

const EVENT_GLYPHS: Record<string, { glyph: string; label: string }> = {
  sandstorm: { glyph: "≋", label: "Sandstorm — accuracy drops" },
  ionstorm: { glyph: "⌁", label: "Ion storm — units limited to 1 CP" },
  barrage: { glyph: "☄", label: "Artillery barrage on the marked zone" },
  collapse: { glyph: "▽", label: "Structural collapse in the marked zone" },
};

// Environmental forecast: icons for events hitting NOW / next turn / the turn after,
// so a storm is something you plan around rather than a surprise.
function forecastChip(sim: TacticalSim): string {
  const entries = sim.forecast(2).filter((cell) => cell.kinds.length);
  if (!entries.length) return "";
  const cells = entries.map((cell) => {
    const offset = cell.turn - sim.turn;
    const when = offset === 0 ? "NOW" : `T+${offset}`;
    const glyphs = cell.kinds.map((kind) => {
      const info = EVENT_GLYPHS[kind] ?? { glyph: "?", label: kind };
      const timing = offset === 0 ? "this turn" : `in ${offset} turn${offset > 1 ? "s" : ""}`;
      return `<i data-tip="${escapeAttr(`${info.label} (${timing}).`)}">${info.glyph}</i>`;
    }).join("");
    return `<span class="forecast-cell ${offset === 0 ? "now" : ""}"><em>${when}</em>${glyphs}</span>`;
  }).join("");
  return `<span class="mode-chip forecast-chip" data-tip="Environmental forecast for the next two turns.">${cells}</span>`;
}

function buildingDetail(entity: CombatEntity): string {
  if (entity.kind !== "base") return "";
  const eff = generatorEfficiency(entity);
  const researched = (entity.unlockedTech ?? []).length;
  return `<div class="detail-statline building-statline">
      <div data-tip="Money paid to your treasury each round. Falls as the Reactor Core takes damage and stops if it is destroyed. The base earns money and deploys troops; it cannot attack."><span>Income</span><strong>$${baseIncome(entity)}/rd</strong></div>
      <div><span>Reactor</span><strong>${Math.round(eff * 100)}%</strong></div>
      <div data-tip="Doctrines researched on the tech tree, unlocking new troop types."><span>Tech</span><strong>${researched}/${TECH_TREE.length}</strong></div>
    </div>`;
}

function inspectEntity(entity: CombatEntity, titleText: string, activePartId: string | undefined, closeCommand?: "close-unit-detail" | "close-target"): string {
  const integrity = Math.round(entity.parts.reduce((sum, part) => sum + Math.max(0, part.hp), 0) / Math.max(1, entity.parts.reduce((sum, part) => sum + part.maxHp, 0)) * 100);
  return `
    <div class="inspect-head">
      <div>
        <div class="panel-title">${titleText}</div>
        <h2>${escapeHtml(entity.name)}</h2>
      </div>
      <div class="inspect-actions">
        <div class="status-pill ${entity.status.alive ? "" : "dead"}">${statusText(entity)}</div>
        ${closeCommand === "close-unit-detail" && entity.team === "player" && entity.kind !== "base" ? `<button class="icon-btn edit-btn" data-edit-unit="${entity.id}" data-tip="Customize this unit: rename it and apply unlocked cosmetic accents.">Edit</button>` : ""}
        ${closeCommand ? `<button class="icon-btn close-btn" data-command="${closeCommand}" aria-label="Close ${escapeAttr(titleText)} panel" data-tip="Close this detail panel."><span>X</span><strong>Close</strong></button>` : ""}
      </div>
    </div>
    <div class="detail-card">
      <div class="detail-nameplate">
        <span>${kindLabel(entity)}</span>
        <strong>${title(entity.team)}</strong>
        <em>${integrity}% integrity</em>
      </div>
      <div class="detail-statline">
        <div data-tip="${escapeAttr(cpTip(entity))}"><span>CP</span><strong>${entity.commandPoints}/${entity.maxCommandPoints}</strong></div>
        <div><span>Move</span><strong>${entity.status.canMove ? "Online" : "Down"}</strong></div>
        <div><span>Weapon</span><strong>${entity.status.canShoot ? "Online" : "Down"}</strong></div>
        ${entity.maxGrenades > 0 ? `<div><span>Grenades</span><strong>${entity.grenades}/${entity.maxGrenades}</strong></div>` : ""}
        <div><span>Posture</span><strong>${entity.stance === "crouched" ? "Crouched" : "Standing"}</strong></div>
      </div>
      ${buildingDetail(entity)}
    </div>
    <div class="parts detail-parts">
      ${entity.parts.map((part) => partRow(part, part.id === activePartId)).join("")}
    </div>
  `;
}

function orderPlanner(
  actor: CombatEntity | undefined,
  target: CombatEntity | undefined,
  targetPartId: string | undefined,
  action: Intent,
  orders: TacticalOrder[],
  sim: TacticalSim
): string {
  // The Home Base has its own command deck: deploy troops or upgrade itself.
  if (actor?.kind === "base") return baseCommandPanel(actor, sim);
  const selectedPart = target?.parts.find((part) => part.id === targetPartId);
  const preview = actor && target && selectedPart ? sim.previewShot(actor.id, target.id, selectedPart.id) : undefined;
  const grenadePreview = actor && target && selectedPart ? sim.previewGrenade(actor.id, target.id, selectedPart.id) : undefined;
  const blocker = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const grenadeBlocker = grenadePreview?.blockedById ? sim.entity(grenadePreview.blockedById) : undefined;
  const canShoot = Boolean(actor && target && target.team !== "player" && selectedPart && actor.status.canShoot && actor.commandPoints > 0 && sim.phase === "command");
  const grenadeStatus = target ? sim.previewGrenadeTarget(target.id) : undefined;
  const canGrenade = Boolean(actor && target && target.team !== "player" && selectedPart && actor.grenades > 0 && actor.commandPoints > 0 && sim.phase === "command" && grenadeStatus?.ok);
  const ramStatus = target ? sim.previewRam(target.id) : undefined;
  const meleeStatus = target ? sim.previewMelee(target.id) : undefined;
  const canRam = Boolean(actor && target && target.team !== "player" && actor.kind === "tank" && actor.status.canMove && actor.commandPoints > 0 && sim.phase === "command" && ramStatus?.ok);
  const canMelee = Boolean(actor && target && target.team !== "player" && selectedPart && actor.kind === "striker" && actor.status.canMove && actor.commandPoints > 0 && sim.phase === "command" && meleeStatus?.ok);
  const canDefend = Boolean(actor && isInfantryKind(actor.kind) && actor.status.canMove && actor.commandPoints > 0 && sim.phase === "command");
  const ramTip = actor?.kind === "tank"
    ? "Costs 1 CP. Deals 72 damage to the target and 14 damage to your front armor."
    : "Only tanks can ram.";
  const defendTip = actor && isInfantryKind(actor.kind)
    ? "Costs 1 CP. Crouch improves accuracy and head-shot defense, but slows this unit's next move."
    : "Only infantry can change stance.";
  const focusedAction = action !== "select" || Boolean(target);
  const showActions = Boolean(actor && actor.commandPoints > 0 && !focusedAction && sim.phase === "command");

  const actionBody = [
    orders.length && !target && action === "select" ? queuedOrdersState(orders, sim) : "",
    action === "move" ? moveState(actor) : "",
    action === "shoot" ? shootState(actor, target, targetPartId, preview, blocker, canShoot, sim) : "",
    action === "grenade" ? grenadeState(actor, target, targetPartId, grenadePreview, grenadeBlocker, canGrenade, grenadeStatus?.reason, sim) : "",
    action === "ram" ? ramState(target, canRam, ramStatus?.reason, ramTip) : "",
    action === "melee" ? meleeState(target, targetPartId, canMelee, meleeStatus?.reason, sim) : "",
    action === "interact" ? coverInteractionState(actor, target, sim) : "",
    action === "inspect" || action === "inspect-detail" ? inspectTargetState(actor, target, action === "inspect-detail", sim) : "",
    action === "defend" ? defendState(canDefend, defendTip) : "",
    action === "overwatch" ? overwatchState(actor, sim) : "",
    action === "mine" ? mineState(actor, sim) : "",
    !actor ? orderSummaryState(actor, target) : "",
  ].filter(Boolean).join("");

  return `
    <div class="order-head">
      <div>
        <div class="panel-title">Order</div>
        <h2>${actor ? escapeHtml(actor.name) : "No unit selected"}</h2>
      </div>
      <div class="cp-badge" data-tip="${actor ? escapeAttr(cpTip(actor)) : "Select a living squad unit."}">
        ${actor ? `${actor.commandPoints}/${actor.maxCommandPoints} CP` : "-- CP"}
      </div>
      ${(target || action !== "select") ? `<button class="icon-btn close-btn clear-focus" data-command="clear-order-focus" data-tip="Go back to the compact action list."><span>&lt;</span><strong>Back</strong></button>` : ""}
    </div>

    <div class="command-layout ${showActions && !actionBody ? "actions-only" : showActions ? "" : "single-detail"}">
      ${showActions ? `
        <div class="command-section action-deck">
          <div class="action-row">
            ${ORDER_ACTIONS.filter((option) => actionVisible(option.id, actor, sim)).map((option, index) => {
              const disabled = actionDisabled(option.id, actor, sim);
              const tip = option.id === "ram" ? ramTip : option.id === "defend" ? defendTip : option.tip;
              return `<button class="tool action action-${option.id} ${action === option.id ? "active" : ""} ${disabled ? "disabled" : ""}" data-order-action="${option.id}" data-disabled="${disabled}" data-tip="${escapeAttr(tip)}"><strong>${index + 1}. ${option.label}</strong><span>${actionCostLabel(option.id, actor)}</span></button>`;
            }).join("")}
          </div>
        </div>
      ` : ""}
      ${actionBody ? `<div class="command-section detail-deck">
        <div class="order-body">
          ${actionBody}
        </div>
      </div>` : ""}
    </div>
  `;
}

function shootState(
  actor: CombatEntity | undefined,
  target: CombatEntity | undefined,
  targetPartId: string | undefined,
  preview: ShotPreview | undefined,
  blocker: CombatEntity | undefined,
  canShoot: boolean,
  sim: TacticalSim
): string {
  if (!actor) return `<div class="order-note">No active unit.</div>`;
  if (!target) {
    return sim.selectedCanGroundTarget()
      ? `<div class="order-note">Choose a hostile or cover target, or click open ground to shell a spot.</div>`
      : `<div class="order-note">Choose a hostile or cover target.</div>`;
  }
  if (target.team === "player") {
    return `
      <div class="target-summary blocked">
        <strong>${escapeHtml(target.name)} is friendly</strong>
        <span>Select a hostile unit or cover object before confirming a shot.</span>
      </div>
    `;
  }
  const parts = sim.targetableParts(target);
  const blockedPart = blocker ? blocker.parts.find((part) => part.id === preview?.impactPartId) : undefined;
  const groundBlocked = Boolean(preview?.blockedByGround);
  const warning = preview?.warningText;
  if (parts.length === 1 && target.parts.every((part) => part.hp > 0)) {
    return `
      <div class="single-target-card ${blocker || groundBlocked || warning ? "blocked" : ""}">
        ${partButton(actor, target, parts[0], true, sim, warning ? escapeHtml(warning) : blocker ? `Blocked by ${escapeHtml(blocker.name)}` : groundBlocked ? "Blocked by high ground" : preview?.arcHeight ? "Arcing splash path" : "Line clear")}
      </div>
      <button class="btn confirm ${canShoot ? "" : "disabled"}" data-confirm="shoot" data-disabled="${!canShoot}" data-tip="${escapeAttr(confirmShootTip(preview, blocker, target))}">
        Confirm Shoot
        <span>${preview ? `${preview.amount} dmg` : "pick part"}</span>
      </button>
    `;
  }
  return `
    <div class="target-summary ${blocker || groundBlocked || warning ? "blocked" : ""}">
      <strong>${escapeHtml(target.name)}</strong>
      <span>${warning ? escapeHtml(warning) : blocker ? `Line blocked by ${escapeHtml(blocker.name)}; hit ${escapeHtml(blockedPart?.label ?? "cover")} first.` : groundBlocked ? "Line hits high ground before the target. Pick a higher part or move for a better angle." : preview?.arcHeight ? "Arcing explosive path. Near misses can still splash damage." : "Line is clear. Accuracy spread can still miss the part or hit something else."}</span>
    </div>
    <div class="part-options">
      ${parts.map((part) => partButton(actor, target, part, part.id === targetPartId, sim)).join("")}
      ${destroyedPartChips(target)}
    </div>
    <button class="btn confirm ${canShoot ? "" : "disabled"}" data-confirm="shoot" data-disabled="${!canShoot}" data-tip="${escapeAttr(confirmShootTip(preview, blocker, target))}">
      Confirm Shoot
      <span>${preview ? `${preview.amount} dmg` : "pick part"}</span>
    </button>
  `;
}

function grenadeState(
  actor: CombatEntity | undefined,
  target: CombatEntity | undefined,
  targetPartId: string | undefined,
  preview: ShotPreview | undefined,
  blocker: CombatEntity | undefined,
  canGrenade: boolean,
  reason: string | undefined,
  sim: TacticalSim
): string {
  if (!actor) return `<div class="order-note">No active unit.</div>`;
  if (!target) return `<div class="order-note">Click ground to throw at a location, or choose a hostile/cover target.</div>`;
  if (target.team === "player") {
    return `
      <div class="target-summary blocked">
        <strong>${escapeHtml(target.name)} is friendly</strong>
        <span>Select a hostile unit or cover object before throwing.</span>
      </div>
    `;
  }
  const parts = sim.targetableParts(target);
  const blockedPart = blocker ? blocker.parts.find((part) => part.id === preview?.impactPartId) : undefined;
  const groundBlocked = Boolean(preview?.blockedByGround);
  const warning = preview?.warningText;
  const status = reason
    ? escapeHtml(reason)
    : warning
      ? escapeHtml(warning)
      : blocker
        ? `Arc clipped by ${escapeHtml(blocker.name)}; blast hits ${escapeHtml(blockedPart?.label ?? "cover")} first.`
        : groundBlocked
          ? "Arc hits high ground before the target."
          : "Short arcing throw. Blast can catch nearby units or roll after a miss.";
  if (parts.length === 1 && target.parts.every((part) => part.hp > 0)) {
    return `
      <div class="single-target-card ${reason || blocker || groundBlocked || warning ? "blocked" : ""}">
        ${partButton(actor, target, parts[0], true, sim, status, "grenade")}
      </div>
      <button class="btn confirm ${canGrenade ? "" : "disabled"}" data-confirm="grenade" data-disabled="${!canGrenade}" data-tip="${escapeAttr(confirmGrenadeTip(preview, blocker, target, actor, reason))}">
        Confirm Grenade
        <span>${actor.grenades}/${actor.maxGrenades} left</span>
      </button>
    `;
  }
  return `
    <div class="target-summary ${reason || blocker || groundBlocked || warning ? "blocked" : ""}">
      <strong>${escapeHtml(target.name)}</strong>
      <span>${status}</span>
    </div>
    <div class="part-options">
      ${parts.map((part) => partButton(actor, target, part, part.id === targetPartId, sim, undefined, "grenade")).join("")}
      ${destroyedPartChips(target)}
    </div>
    <button class="btn confirm ${canGrenade ? "" : "disabled"}" data-confirm="grenade" data-disabled="${!canGrenade}" data-tip="${escapeAttr(confirmGrenadeTip(preview, blocker, target, actor, reason))}">
      Confirm Grenade
      <span>${preview ? `${preview.amount} dmg` : `${actor.grenades}/${actor.maxGrenades} left`}</span>
    </button>
  `;
}

function meleeState(target: CombatEntity | undefined, targetPartId: string | undefined, canMelee: boolean, reason: string | undefined, sim: TacticalSim): string {
  const parts = target ? sim.targetableParts(target) : [];
  const dmg = target && targetPartId ? sim.previewMeleeDamage(target.id, targetPartId) : undefined;
  return `
    <div class="target-summary ${canMelee ? "" : "blocked"}">
      <strong>${target ? escapeHtml(target.name) : "Pick target"}</strong>
      <span>${reason ? escapeHtml(reason) : target ? "Adjacent strike. Pick the exact part before confirming." : "Choose a hostile or object directly beside the striker."}</span>
    </div>
    ${parts.length && target ? `<div class="part-options">
      ${parts.map((part) => meleePartButton(part, part.id === targetPartId, sim.previewMeleeDamage(target.id, part.id))).join("")}
    </div>` : ""}
    <button class="btn confirm ${canMelee ? "" : "disabled"}" data-confirm="melee" data-disabled="${!canMelee}" data-tip="Queue a fast melee strike against the selected target.">
      Confirm Strike
      <span>${dmg !== undefined ? `${dmg} dmg` : "pick part"}</span>
    </button>
  `;
}

function coverInteractionState(actor: CombatEntity | undefined, target: CombatEntity | undefined, sim: TacticalSim): string {
  if (!target || target.kind !== "cover") return "";
  const isCliff = target.coverKind === "cliff";
  const canClimb = Boolean(actor && isInfantryKind(actor.kind) && (isCliff || (target.height <= 1.22 && target.coverKind !== "wall" && target.coverKind !== "ridge")));
  const coverReach = actor && !isCliff ? sim.previewTakeCover(target.id) : undefined;
  const canTakeCover = Boolean(actor && isInfantryKind(actor.kind) && !isCliff && coverReach?.ok);
  const canShoot = Boolean(actor?.status.canShoot && !isCliff);
  const summary = isCliff
    ? actor && !isInfantryKind(actor.kind)
      ? "Tanks cannot climb this cliff. Use infantry to ascend."
      : "Infantry can climb this ascent to reach the mesa."
    : coverReach && !coverReach.ok
      ? coverReach.reason ?? `${kindLabel(target)} / ${Math.ceil(target.parts[0]?.hp ?? 0)} HP`
      : `${kindLabel(target)} / ${Math.ceil(target.parts[0]?.hp ?? 0)} HP`;
  const tooFar = Boolean(actor && isInfantryKind(actor.kind) && !isCliff && coverReach && !coverReach.ok);
  return `
    <div class="target-summary ${(isCliff && actor && !isInfantryKind(actor.kind)) || tooFar ? "blocked" : ""}">
      <strong>${escapeHtml(target.name)}</strong>
      <span>${escapeHtml(summary)}</span>
    </div>
    <div class="cover-actions">
      ${actor && isInfantryKind(actor.kind) && !isCliff ? `<button class="btn confirm ${canTakeCover ? "" : "disabled"}" data-cover-action="cover" data-disabled="${!canTakeCover}" data-tip="${escapeAttr(coverReach?.ok ? "Move beside this object and crouch if the unit has enough CP." : coverReach?.reason ?? "Get closer to take cover here.")}">
        Take Cover
        <span>${canTakeCover ? "move+crouch" : "too far"}</span>
      </button>` : ""}
      ${canShoot ? `<button class="btn confirm" data-cover-action="shoot" data-tip="Target this object with the selected unit's weapon.">
        Shoot
        <span>target</span>
      </button>` : ""}
      ${canClimb ? `<button class="btn confirm" data-cover-action="climb" data-tip="${isCliff ? "Infantry spends 1 CP to climb this cliff ascent." : "Climb onto low cover. Tall walls and ridges are too high."}">
        ${isCliff ? "Climb Cliff" : "Climb"}
        <span>${isCliff ? "ascent" : "low object"}</span>
      </button>` : ""}
    </div>
  `;
}

function inspectTargetState(actor: CombatEntity | undefined, target: CombatEntity | undefined, expanded: boolean, sim: TacticalSim): string {
  if (!target) return `<div class="order-note">Select a target.</div>`;
  const parts = sim.targetableParts(target);
  return `
    <div class="target-summary">
      <strong>${escapeHtml(target.name)}</strong>
      <span>${kindLabel(target)} / ${statusText(target)} / ${parts.length} intact parts</span>
    </div>
    <div class="inspect-target-actions">
      ${actor?.status.canShoot ? `<button class="btn confirm" data-order-action="shoot" data-tip="Aim at a specific part.">
        Shoot
        <span>aim</span>
      </button>` : ""}
      ${actor && actor.maxGrenades > 0 ? `<button class="btn confirm ${actor.grenades > 0 ? "" : "disabled"}" data-order-action="grenade" data-disabled="${actor.grenades <= 0}" data-tip="Throw a limited-supply hand grenade in a short arc.">
        Grenade
        <span>${actor.grenades}/${actor.maxGrenades}</span>
      </button>` : ""}
      ${actor?.kind === "striker" ? `<button class="btn confirm" data-order-action="melee" data-tip="Melee strike with a striker unit.">
        Strike
        <span>close</span>
      </button>` : ""}
      <button class="btn confirm" data-order-action="${expanded ? "inspect" : "inspect-detail"}" data-tip="Toggle detailed target parts.">
        ${expanded ? "Less" : "More"}
        <span>detail</span>
      </button>
    </div>
    ${expanded ? `<div class="compact-target-parts">${target.parts.map((part) => partRow(part, false)).join("")}</div>` : ""}
  `;
}

function ramState(target: CombatEntity | undefined, canRam: boolean, reason: string | undefined, tip: string): string {
  return `
    <div class="target-summary ${canRam || !target ? "" : "blocked"}">
      <strong>${target ? escapeHtml(target.name) : "No target"}</strong>
      <span>${reason ? escapeHtml(reason) : target ? "Impact: 72 target damage, 14 self armor damage." : "Choose a hostile or cover target."}</span>
    </div>
    <button class="btn confirm ${canRam ? "" : "disabled"}" data-confirm="ram" data-disabled="${!canRam}" data-tip="${escapeAttr(tip)}">
      Confirm Ram
      <span>72 dmg</span>
    </button>
  `;
}

function defendState(canDefend: boolean, tip: string): string {
  return `
    ${canDefend ? "" : `<div class="order-note">${escapeHtml(tip)}</div>`}
    <button class="btn confirm ${canDefend ? "" : "disabled"}" data-confirm="defend" data-disabled="${!canDefend}" data-tip="${escapeAttr("Crouch improves accuracy and avoids direct head shots during resolve, but slows the next move.")}">
      Confirm Crouch
      <span>+accuracy</span>
    </button>
  `;
}

function mineState(actor: CombatEntity | undefined, sim: TacticalSim): string {
  const reason = actor ? sim.mineFailureReason(actor) : "Select a sapper first";
  return `
    <div class="target-summary ${reason ? "blocked" : ""}">
      <strong>${reason ? "Mine unavailable" : "Mine ready"}</strong>
      <span>${reason ? escapeHtml(reason) : "Plants a proximity mine at the sapper's feet. Hostiles that step on it take a splash blast. Your mines are invisible to the enemy."}</span>
    </div>
    <button class="btn confirm ${reason ? "disabled" : ""}" data-confirm="mine" data-disabled="${Boolean(reason)}" data-tip="${escapeAttr("Plant a proximity mine here ($15 + 1 CP).")}">
      Plant Mine
      <span>$15</span>
    </button>
  `;
}

function overwatchState(actor: CombatEntity | undefined, sim: TacticalSim): string {
  const reason = actor ? sim.overwatchFailureReason(actor) : "Select a unit first";
  const radius = actor ? sim.overwatchRadius(actor).toFixed(1) : "0";
  return `
    <div class="target-summary ${reason ? "blocked" : ""}">
      <strong>${reason ? "Overwatch unavailable" : "Overwatch armed"}</strong>
      <span>${reason ? escapeHtml(reason) : `Holds fire until a hostile moves within ${radius}m this resolve, then snaps a reaction shot (wider spread than an aimed shot).`}</span>
    </div>
    <button class="btn confirm ${reason ? "disabled" : ""}" data-confirm="overwatch" data-disabled="${Boolean(reason)}" data-tip="${escapeAttr("Set overwatch: the amber ring marks the kill zone. The first hostile to move inside it eats a snap shot.")}">
      Confirm Overwatch
      <span>1 CP</span>
    </button>
  `;
}

// The Home Base command deck: one action per turn — deploy a troop, upgrade income,
// or upgrade tech.
function baseCommandPanel(base: CombatEntity, sim: TacticalSim): string {
  const commanding = sim.phase === "command";
  // While placing a defense, duck the full deck away and show only a slim placement bar so
  // the player can see and click the green placement ring on the battlefield.
  if (sim.pendingBuild) {
    const pendingLabel = DEFENSE_CATALOG.find((d) => d.kind === sim.pendingBuild)?.label ?? "defense";
    return `
      <div class="placement-bar">
        <strong>Placing ${escapeHtml(pendingLabel)}</strong>
        <span>Click a spot inside the green ring near your Home Base.</span>
        <button class="btn ghost" data-build-cancel="1" type="button" data-tip="Cancel placement.">Cancel</button>
      </div>
    `;
  }
  return `
    <div class="order-head">
      <div>
        <div class="panel-title">Home Base</div>
        <h2>${escapeHtml(base.name)}</h2>
      </div>
      <div class="cp-badge" data-tip="${escapeAttr(cpTip(base))}">
        ${base.commandPoints}/${base.maxCommandPoints} CP
      </div>
    </div>
    <div class="command-layout single-detail">
      <div class="command-section detail-deck">
        <div class="order-body">
          ${commanding ? baseCommandBody(base, sim) : `<div class="order-note">The base can only act during the command phase.</div>${baseSummary(base, sim)}`}
        </div>
      </div>
    </div>
  `;
}

function baseSummary(base: CombatEntity, sim: TacticalSim): string {
  const field = sim.fieldUnitCount(base.team);
  const researched = (base.unlockedTech ?? []).length;
  return `
    <div class="detail-statline building-statline base-summary">
      <div data-tip="Money paid each round, scaled by reactor health. Upgrade income to raise it."><span>Income</span><strong>$${baseIncome(base)}/rd</strong></div>
      <div data-tip="Doctrines researched on the tech tree, unlocking new troop types."><span>Tech</span><strong>${researched}/${TECH_TREE.length}</strong></div>
      <div data-tip="Combat units you have on the field. Hard cap of ${POP_CAP}."><span>Field</span><strong>${field}/${POP_CAP}</strong></div>
    </div>
  `;
}

function baseCommandBody(base: CombatEntity, sim: TacticalSim): string {
  if (!base.status.alive) return `<div class="order-note">${escapeHtml(base.name)} is disabled.</div>`;
  const money = sim.money(base.team);
  const hasCp = base.commandPoints > 0;
  const incomeCost = incomeUpgradeCost(base);

  const note = hasCp
    ? "Spend the base's command point: deploy a troop, research a doctrine, or boost income."
    : `${base.name} has used its command point this turn.`;

  syncRevealTracking(base);
  const troopButtons = TROOP_CATALOG.map((spec) => {
    const locked = Boolean(spec.tech) && !isTechUnlocked(base, spec.tech as string);
    const techName = TECH_TREE.find((n) => n.id === spec.tech)?.name ?? "a doctrine";
    // Discovery pacing: a locked troop is a CLASSIFIED asset — no name, role, or price.
    // The only intel is which doctrine declassifies it, so buying a doctrine is a
    // reveal moment instead of a checklist tick.
    if (locked) {
      return `<button class="btn confirm disabled classified" data-spawn="${spec.kind}" data-disabled="true" data-tip="${escapeAttr(`Classified asset. Research ${techName} to reveal it.`)}">
        <span class="classified-name">▮▮▮▮▮▮</span>
        <span>${escapeHtml(techName)}</span>
      </button>`;
    }
    const reason = sim.spawnFailureReason(base, spec.kind);
    const cooldown = sim.troopCooldown(base, spec.kind);
    const ready = !reason;
    const isNew = isRecentlyRevealed(revealTracker.revealedTroopAt.get(spec.kind));
    const sub = cooldown > 0 ? `${cooldown} rd` : `$${spec.cost}`;
    const tip = reason
      ? `${spec.label}: ${reason}.`
      : `${spec.label} (${spec.role}): ${spec.tip} Costs 1 CP and $${spec.cost}; ${spec.cooldown}-round cooldown.`;
    return `<button class="btn confirm ${ready ? "" : "disabled"} ${isNew ? "just-revealed" : ""}" data-spawn="${spec.kind}" data-disabled="${!ready}" data-tip="${escapeAttr(tip)}">
      ${escapeHtml(spec.label)}${isNew ? `<em class="new-badge">NEW</em>` : ""}
      <span>${sub}</span>
    </button>`;
  }).join("");

  const techButtons = TECH_TREE.map((node) => {
    const unlocked = isTechUnlocked(base, node.id);
    // Tier-4 specializations stay encrypted until their parent doctrine is bought —
    // each doctrine decrypts a rival pair of upgrades you didn't know existed.
    const prereqsMet = node.requires.every((id) => isTechUnlocked(base, id));
    if (node.tier === 4 && !prereqsMet) {
      const parentName = TECH_TREE.find((n) => n.id === node.requires[0])?.name ?? "a doctrine";
      return `<button class="btn confirm disabled classified" data-tech="${node.id}" data-disabled="true" data-tip="${escapeAttr(`Encrypted R&D file. Research ${parentName} to decrypt it.`)}">
        <span class="classified-name">ENCRYPTED</span>
        <span>${escapeHtml(parentName)}</span>
      </button>`;
    }
    const reason = sim.researchFailureReason(base, node.id);
    const ready = !reason;
    const lockedOut = Boolean(reason && /locked out/i.test(reason));
    const isNew = node.tier === 4 && !unlocked && isRecentlyRevealed(revealTracker.revealedTechAt.get(node.id));
    const sub = unlocked ? "Done" : lockedOut ? "Locked" : `$${node.cost}`;
    const tip = unlocked
      ? `${node.name}: ${node.blurb} (researched)`
      : reason
        ? `${node.name}: ${reason}.`
        : `${node.name}: ${node.blurb} Costs 1 CP and $${node.cost}.`;
    return `<button class="btn confirm ${unlocked ? "done" : ready ? "" : "disabled"} ${isNew ? "just-revealed" : ""}" data-tech="${node.id}" data-disabled="${unlocked || !ready}" data-tip="${escapeAttr(tip)}">
      ${escapeHtml(node.name)}${isNew ? `<em class="new-badge">NEW</em>` : ""}
      <span>${sub}</span>
    </button>`;
  }).join("");

  const incomeReady = hasCp && incomeCost !== undefined && money >= incomeCost;
  const nextIncome = INCOME_BY_LEVEL[(base.incomeLevel ?? 0) + 1];
  const incomeTip = incomeCost === undefined
    ? "Income is fully upgraded."
    : `Raise income to $${nextIncome}/rd before reactor scaling. Costs 1 CP and $${incomeCost}.`;

  const cmdCost = commandUpgradeCost(base);
  const cmdReady = hasCp && cmdCost !== undefined && money >= cmdCost;
  const cmdTip = cmdCost === undefined
    ? "Command is already upgraded to 2 command points per turn."
    : `Upgrade the base to 2 command points per turn so it can act twice. Costs 1 CP and $${cmdCost}.`;

  const defenseButtons = DEFENSE_CATALOG.map((spec) => {
    const affordable = hasCp && money >= spec.cost;
    const active = sim.pendingBuild === spec.kind;
    const tip = `${spec.label} (${spec.role}): ${spec.tip} Costs 1 CP and $${spec.cost}. Then click a spot inside the green ring near your base.`;
    return `<button class="btn confirm ${active ? "active" : affordable ? "" : "disabled"}" data-build="${spec.kind}" data-disabled="${!affordable && !active}" data-tip="${escapeAttr(tip)}">
      ${escapeHtml(spec.label)}
      <span>${active ? "Placing…" : `$${spec.cost}`}</span>
    </button>`;
  }).join("");

  const pendingLabel = sim.pendingBuild ? DEFENSE_CATALOG.find((d) => d.kind === sim.pendingBuild)?.label ?? "defense" : "";
  const buildNote = sim.pendingBuild
    ? `<div class="order-note order-note--progress">Placing ${escapeHtml(pendingLabel)} — click a spot inside the green ring near your base. <button class="icon-btn" data-build-cancel="1" data-tip="Cancel placement.">Cancel</button></div>`
    : "";

  // Off-map support powers: tech-locked ones stay classified (same discovery language as
  // the troop deck); unlocked ones show cost / cooldown, and the armed one shows Targeting.
  const supportButtons = SUPPORT_POWERS.map((spec) => {
    const techLocked = Boolean(spec.tech) && !isTechUnlocked(base, spec.tech as string);
    if (techLocked) {
      const techName = TECH_TREE.find((n) => n.id === spec.tech)?.name ?? "a doctrine";
      return `<button class="btn confirm disabled classified" data-support="${spec.kind}" data-disabled="true" data-tip="${escapeAttr(`Classified support asset. Research ${techName} to reveal it.`)}">
        <span class="classified-name">▮▮▮▮▮▮</span>
        <span>${escapeHtml(techName)}</span>
      </button>`;
    }
    const reason = sim.supportFailureReason(base, spec.kind);
    const cooldown = sim.supportCooldown(base, spec.kind);
    const active = sim.pendingSupport === spec.kind;
    const ready = !reason;
    const sub = active ? "Targeting…" : cooldown > 0 ? `${cooldown} rd` : `$${spec.cost}`;
    const tip = reason && !active
      ? `${spec.label}: ${reason}.`
      : `${spec.label} (${spec.role}): ${spec.tip} Costs 1 CP and $${spec.cost}; ${spec.cooldown}-round cooldown. Then click the target point.`;
    return `<button class="btn confirm ${active ? "active" : ready ? "" : "disabled"}" data-support="${spec.kind}" data-disabled="${!ready && !active}" data-tip="${escapeAttr(tip)}">
      ${escapeHtml(spec.label)}
      <span>${sub}</span>
    </button>`;
  }).join("");

  const supportNote = sim.pendingSupport
    ? `<div class="order-note order-note--progress">Targeting ${escapeHtml(supportPowerSpec(sim.pendingSupport).label)} — click the strike point anywhere on the field. <button class="icon-btn" data-support-cancel="1" data-tip="Cancel the strike call.">Cancel</button></div>`
    : "";

  return `
    <div class="order-note">${escapeHtml(note)}</div>
    ${baseSummary(base, sim)}
    ${buildNote}
    <div class="base-section-title">Deploy Troop</div>
    <div class="spawn-options part-options">${troopButtons}</div>
    <div class="base-section-title">Tech Tree</div>
    <div class="tech-options part-options">${techButtons}</div>
    <div class="base-section-title">Build Defenses</div>
    <div class="defense-options part-options">${defenseButtons}</div>
    <div class="base-section-title">Call Support</div>
    ${supportNote}
    <div class="support-options part-options">${supportButtons}</div>
    <div class="base-section-title">Upgrade Base</div>
    <div class="upgrade-options part-options">
      <button class="btn confirm ${incomeReady ? "" : "disabled"}" data-base-upgrade="income" data-disabled="${!incomeReady}" data-tip="${escapeAttr(incomeTip)}">
        Income
        <span>${incomeCost === undefined ? "Maxed" : `$${incomeCost}`}</span>
      </button>
      <button class="btn confirm ${cmdReady ? "" : "disabled"}" data-base-upgrade="command" data-disabled="${!cmdReady}" data-tip="${escapeAttr(cmdTip)}">
        Command +1 CP
        <span>${cmdCost === undefined ? "Done" : `$${cmdCost}`}</span>
      </button>
    </div>
  `;
}

function moveState(actor: CombatEntity | undefined): string {
  const ready = Boolean(actor && actor.status.canMove && actor.commandPoints > 0);
  return `
    <div class="target-summary ${ready ? "" : "blocked"}">
      <strong>${ready ? "Move order armed" : "Move unavailable"}</strong>
      <span>${ready ? "Click ground to move, or click an object for cover/climb options." : "No movement or CP."}</span>
    </div>
  `;
}

function orderSummaryState(actor: CombatEntity | undefined, target: CombatEntity | undefined): string {
  return `
    <div class="target-summary compact-ready">
      <strong>${actor ? escapeHtml(actor.name) : "Select a unit"}</strong>
      <span>${target ? `Inspecting ${escapeHtml(target.name)}.` : actor ? `${actor.commandPoints}/${actor.maxCommandPoints} CP ready` : "Pick squad"}</span>
    </div>
  `;
}

function queuedOrdersState(orders: TacticalOrder[], sim: TacticalSim): string {
  return `
    <div class="queued-list">
      ${orders.map((order, index) => `
        <button class="queued-chip undo-order" data-cancel-order="${order.id}" data-tip="Undo step ${index + 1}: ${escapeAttr(orderSummary(order, sim).replace("Queued: ", ""))}. Refunds 1 CP.">
          <strong>${index + 1}. ${escapeHtml(title(order.kind))}</strong>
          <span>${escapeHtml(orderSummary(order, sim).replace("Queued: ", ""))}</span>
          <em>undo</em>
        </button>
      `).join("")}
    </div>
  `;
}

function battleLogPanel(sim: TacticalSim): string {
  const reports = [sim.currentTurnReport, ...sim.turnReports].filter(Boolean) as TurnReport[];
  return `
    <div class="battle-log-panel">
      <div class="battle-log-head">
        <div>
          <strong>Battle Log</strong>
          <span>Turn-by-turn damage and combat outcomes</span>
        </div>
        <em>${reports.length ? `${reports.length} turn${reports.length === 1 ? "" : "s"}` : "No reports"}</em>
      </div>
      <div class="turn-report-list">
        ${reports.length ? reports.map(turnReportCard).join("") : `<div class="turn-report empty">No resolved combat yet.</div>`}
      </div>
      <div class="recent-feed">
        <strong>Recent Events</strong>
        <div class="log-lines">${sim.log.slice(0, 12).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>
      </div>
    </div>
  `;
}

function turnReportCard(report: TurnReport): string {
  const sections = groupedDamageSections(report.entries);
  return `
    <article class="turn-report ${report.phase === "active" ? "active" : ""}">
      <header>
        <strong>Turn ${report.turn}</strong>
        <span>${report.phase === "active" ? "Resolving" : "Complete"}</span>
      </header>
      <div class="turn-summary-grid">
        ${sections.length ? sections.map(teamDamageSection).join("") : `<div class="damage-card quiet">No confirmed damage yet.</div>`}
      </div>
      <div class="turn-notes">
        ${report.notes.slice(0, 8).map((note) => `<span>${escapeHtml(note)}</span>`).join("")}
      </div>
    </article>
  `;
}

type DamageGroup = {
  targetName: string;
  targetTeam: TurnDamageEntry["targetTeam"];
  targetTeamLabel: string;
  total: number;
  killed: boolean;
  parts: TurnDamageEntry[];
};

type DamageSection = {
  team: TurnDamageEntry["targetTeam"];
  label: string;
  hint: string;
  total: number;
  groups: DamageGroup[];
};

function groupedDamageSections(entries: TurnDamageEntry[]): DamageSection[] {
  const groups = new Map<string, DamageGroup>();
  for (const entry of entries) {
    const key = `${entry.targetTeam}:${entry.targetName}`;
    const group = groups.get(key) ?? {
      targetName: entry.targetName,
      targetTeam: entry.targetTeam,
      targetTeamLabel: teamLabel(entry.targetTeam),
      total: 0,
      killed: false,
      parts: [],
    };
    group.total += entry.amount;
    group.killed = group.killed || entry.killed;
    group.parts.push(entry);
    groups.set(key, group);
  }
  const sections = new Map<TurnDamageEntry["targetTeam"], DamageSection>();
  for (const group of groups.values()) {
    const section = sections.get(group.targetTeam) ?? {
      team: group.targetTeam,
      label: teamSectionLabel(group.targetTeam),
      hint: teamSectionHint(group.targetTeam),
      total: 0,
      groups: [],
    };
    section.total += group.total;
    section.groups.push(group);
    sections.set(group.targetTeam, section);
  }
  return [...sections.values()]
    .map((section) => ({ ...section, groups: section.groups.sort((a, b) => b.total - a.total) }))
    .sort((a, b) => teamOrder(a.team) - teamOrder(b.team));
}

function teamDamageSection(section: DamageSection): string {
  return `
    <section class="damage-section team-${section.team}">
      <div class="damage-section-head">
        <strong>${escapeHtml(section.label)}</strong>
        <span>${escapeHtml(section.hint)} / -${section.total} HP</span>
      </div>
      <div class="damage-section-cards">
        ${section.groups.map(groupDamageCard).join("")}
      </div>
    </section>
  `;
}

function groupDamageCard(group: DamageGroup): string {
  return `
    <div class="damage-card team-${group.targetTeam} ${group.killed ? "killed" : ""}">
      <div class="damage-card-head">
        <strong>${escapeHtml(group.targetName)}</strong>
        <em>${group.killed ? "Disabled" : `-${group.total} HP`}</em>
      </div>
      <span class="team-badge">${escapeHtml(group.targetTeamLabel)}</span>
      ${group.parts.slice(0, 5).map((entry) => `
        <div class="damage-line">
          <b>${escapeHtml(entry.actorName)}</b>
          <span>${escapeHtml(entry.partLabel)} -${entry.amount}${entry.destroyed ? " destroyed" : ""}${entry.killed ? " killed" : ""}</span>
          <em>${Math.max(0, Math.ceil(entry.remainingHp))}/${entry.maxHp}</em>
        </div>
      `).join("")}
    </div>
  `;
}

function teamOrder(team: TurnDamageEntry["targetTeam"]): number {
  if (team === "player") return 0;
  if (team === "enemy") return 1;
  return 2;
}

function teamLabel(team: TurnDamageEntry["targetTeam"]): string {
  if (team === "player") return "Your Unit";
  if (team === "enemy") return "Enemy Unit";
  return "Neutral Object";
}

function teamSectionLabel(team: TurnDamageEntry["targetTeam"]): string {
  if (team === "player") return "Your Squad Hit";
  if (team === "enemy") return "Enemy Force Hit";
  return "Neutral Objects Hit";
}

function teamSectionHint(team: TurnDamageEntry["targetTeam"]): string {
  if (team === "player") return "damage to your units";
  if (team === "enemy") return "damage to enemies";
  return "cover and map objects";
}

function partButton(actor: CombatEntity, target: CombatEntity, part: DamagePart, selected: boolean, sim: TacticalSim, statusTextOverride?: string, attack: "shoot" | "grenade" = "shoot"): string {
  const preview = attack === "grenade" ? sim.previewGrenade(actor.id, target.id, part.id) : sim.previewShot(actor.id, target.id, part.id);
  const blocker = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const impactTarget = preview?.impactEntityId ? sim.entity(preview.impactEntityId) : undefined;
  const impactPart = impactTarget?.parts.find((candidate) => candidate.id === preview?.impactPartId);
  const accuracy = preview ? `${Math.round(preview.hitChance * 100)}%` : "--";
  const tip = [
    partTip(part),
    preview ? `Estimated damage: ${preview.amount}.` : "",
    preview ? `${preview.accuracyLabel}.` : "",
    preview?.warningText ? preview.warningText : "",
    blocker
      ? `Blocked by ${blocker.name}; the shot hits ${impactPart?.label ?? blocker.name} first.`
      : preview?.blockedByGround
        ? "High ground blocks this line before the target."
        : preview?.arcHeight
          ? attack === "grenade" ? "Arcing grenade throw; nearby units can still take splash damage." : "Arcing explosive shot; nearby units can still take splash damage."
          : "Clear shot to this part.",
  ].filter(Boolean).join(" ");
  return `
    <button class="part-choice ${selected ? "active" : ""} ${blocker || preview?.blockedByGround ? "blocked" : ""}" data-part="${part.id}" data-tip="${escapeAttr(tip)}">
      <strong>${escapeHtml(part.label)}</strong>
      <span>${statusTextOverride ? `${statusTextOverride} / ` : ""}${roleLabel(part)} / ${Math.ceil(part.hp)} HP</span>
      <em>${accuracy} / ${preview ? `${preview.amount} dmg` : "--"}</em>
    </button>
  `;
}

// A destroyed part is kept in the targeting list as a disabled chip (shown at 0 HP) so the
// player can see the damage they've already done instead of the part silently disappearing.
function destroyedPartChip(part: DamagePart): string {
  return `
    <button class="part-choice destroyed" data-part="${part.id}" data-disabled="true" disabled data-tip="${escapeAttr(`${part.label} is destroyed (0 HP) and can no longer be targeted.`)}">
      <strong>${escapeHtml(part.label)}</strong>
      <span>Destroyed / ${roleLabel(part)} / 0 HP</span>
      <em>—</em>
    </button>
  `;
}

function destroyedPartChips(target: CombatEntity): string {
  return target.parts.filter((part) => part.hp <= 0).map(destroyedPartChip).join("");
}

function meleePartButton(part: DamagePart, selected: boolean, dmg?: number): string {
  return `
    <button class="part-choice ${selected ? "active" : ""}" data-part="${part.id}" data-tip="${escapeAttr(`${partTip(part)} Strike this exact part if the striker is adjacent.${dmg !== undefined ? ` Estimated damage: ${dmg}.` : ""}`)}">
      <strong>${escapeHtml(part.label)}</strong>
      <span>${roleLabel(part)} / ${Math.ceil(part.hp)} HP</span>
      <em>${dmg !== undefined ? `${dmg} dmg` : "strike"}</em>
    </button>
  `;
}

function partRow(part: DamagePart, active: boolean): string {
  const ratio = part.hp / part.maxHp;
  return `
    <button class="part-row ${part.hp <= 0 ? "destroyed" : ""} ${active ? "active" : ""}" data-part="${part.id}" data-disabled="${part.hp <= 0}" data-tip="${escapeAttr(partTip(part))}">
      <div>
        <strong>${escapeHtml(part.label)}</strong>
        <span class="role-badge role-${part.role}">${roleLabel(part)}</span>
      </div>
      <div class="bar"><i style="width:${Math.max(0, ratio * 100).toFixed(1)}%"></i></div>
      <em>${Math.max(0, Math.ceil(part.hp))}/${part.maxHp}</em>
    </button>
  `;
}

function actionDisabled(action: Intent, actor: CombatEntity | undefined, sim: TacticalSim): boolean {
  if (!actor || sim.phase !== "command" || actor.commandPoints <= 0) return true;
  if (action === "move") return !actor.status.canMove;
  if (action === "shoot") return !actor.status.canShoot;
  if (action === "grenade") return actor.kind !== "soldier" || actor.grenades <= 0;
  if (action === "ram") return actor.kind !== "tank" || !actor.status.canMove;
  if (action === "melee") return actor.kind !== "striker" || !actor.status.canMove;
  if (action === "defend") return !isInfantryKind(actor.kind) || !actor.status.canMove;
  if (action === "overwatch") return Boolean(sim.overwatchFailureReason(actor));
  if (action === "mine") return Boolean(sim.mineFailureReason(actor));
  return false;
}

function actionVisible(action: Intent, actor: CombatEntity | undefined, sim: TacticalSim): boolean {
  if (!actor || sim.phase !== "command") return false;
  if (action === "ram") return actor.kind === "tank" && actor.status.canMove;
  if (action === "melee") return actor.kind === "striker" && actor.status.canMove;
  if (action === "defend") return isInfantryKind(actor.kind) && actor.status.canMove;
  if (action === "overwatch") return actor.status.canShoot && !isBuildingKind(actor.kind) && !isDefenseKind(actor.kind);
  if (action === "mine") return actor.kind === "sapper";
  if (action === "grenade") return actor.kind === "soldier" && actor.maxGrenades > 0;
  if (action === "shoot") return actor.status.canShoot;
  if (action === "move") return actor.status.canMove;
  return false;
}

function orderSummary(order: TacticalOrder, sim: TacticalSim): string {
  const target = sim.entity(order.targetId);
  const part = target?.parts.find((candidate) => candidate.id === order.targetPartId);
  if (order.kind === "move") return "Queued: move";
  if (order.kind === "ram") return `Queued: ram ${target?.name ?? "target"}`;
  if (order.kind === "melee") return `Queued: strike ${target?.name ?? "target"}${part ? ` / ${part.label}` : ""}`;
  if (order.kind === "grenade" && order.destination && !target) return "Queued: grenade ground";
  if (order.kind === "grenade") return `Queued: grenade ${target?.name ?? "target"}${part ? ` / ${part.label}` : ""}`;
  if (order.kind === "defend") return "Queued: crouch";
  return `Queued: shoot ${target?.name ?? "target"}${part ? ` / ${part.label}` : ""}`;
}

function cpPips(entity: CombatEntity): string {
  const pips = Array.from({ length: entity.maxCommandPoints }, (_, index) =>
    `<i class="${index < entity.commandPoints ? "full" : ""}"></i>`
  ).join("");
  return `<span class="cp-pips">${pips}</span><span class="cp-text">CP ${entity.commandPoints}/${entity.maxCommandPoints}</span>`;
}

function grenadeSupplyText(entity: CombatEntity): string {
  return entity.maxGrenades > 0 ? ` / G ${entity.grenades}/${entity.maxGrenades}` : "";
}

function actionCostLabel(action: Intent, actor: CombatEntity | undefined): string {
  if (action === "grenade" && actor) return `${actor.grenades}/${actor.maxGrenades} G`;
  return "1 CP";
}

function cpTip(entity: CombatEntity): string {
  const limited = entity.status.commandLimited ? " Damaged systems reduce this unit's refill." : "";
  const grenades = entity.maxGrenades > 0 ? ` Grenades are finite; ${entity.name} has ${entity.grenades} of ${entity.maxGrenades} left.` : "";
  return `Command Points. Most orders cost 1 CP. ${entity.name} has ${entity.commandPoints} of ${entity.maxCommandPoints} CP this turn.${limited}${grenades}`;
}

function confirmShootTip(preview: ShotPreview | undefined, blocker: CombatEntity | undefined, target: CombatEntity): string {
  if (!preview) return "Pick a target part before confirming the shot.";
  if (preview.warningText) return `${preview.warningText}. Confirming can hit your own unit if the projectile crosses them.`;
  if (blocker) return `Confirm the shot. ${blocker.name} blocks ${target.name}, so the shot deals ${preview.amount} damage to cover.`;
  if (preview.blockedByGround) return "This shot will hit high ground before the target. Move or choose a higher part for a clean line.";
  return `Confirm the shot for ${preview.amount} estimated damage. ${preview.accuracyLabel}; spread changes the projectile trajectory and can hit another part or unit.`;
}

function confirmGrenadeTip(preview: ShotPreview | undefined, blocker: CombatEntity | undefined, target: CombatEntity, actor: CombatEntity, reason: string | undefined): string {
  if (reason) return reason;
  if (!preview) return "Pick a target part before confirming the grenade throw.";
  if (preview.warningText) return `${preview.warningText}. Grenade blasts can hurt nearby friendly units.`;
  if (blocker) return `Confirm the grenade throw. ${blocker.name} clips the arc before ${target.name}, so the blast lands early.`;
  if (preview.blockedByGround) return "This grenade arc will hit high ground before the target.";
  return `Confirm the grenade throw for ${preview.amount} estimated direct damage. ${actor.grenades}/${actor.maxGrenades} grenades left before throwing.`;
}

function partTip(part: DamagePart): string {
  if (part.tags?.includes("support-aura")) return "Support system. While intact, nearby allies deal more shot damage.";
  if (part.tags?.includes("spotter-aura")) return "Spotter relay. While intact, nearby allies fire more accurately.";
  if (part.role === "core") return "Core part. Destroying a critical core disables the unit.";
  if (part.role === "head") return "Head part. Destroying it disables infantry immediately.";
  if (part.role === "weapon") return "Weapon part. Destroying it stops this unit from shooting.";
  if (part.role === "mobility") return "Mobility part. Destroying it stops movement and rams.";
  if (part.role === "utility") return "System part. Destroying it can jam weapons or reduce CP.";
  if (part.role === "armor") return "Armor part. Destroying it exposes the core to stronger follow-up shots.";
  if (part.role === "volatile") return "Explosive part. Destroying it causes an area blast.";
  return "Targetable part.";
}

function statusText(entity: CombatEntity): string {
  if (!entity.status.alive) return "Disabled";
  if (entity.status.exposedCore) return "Exposed";
  if (entity.status.immobilized) return "Immobile";
  if (entity.status.disarmed) return "Disarmed";
  if (entity.status.commandLimited) return "Limited";
  return "Ready";
}

function kindLabel(entity: CombatEntity): string {
  if (entity.kind === "cover" && entity.coverKind) return title(entity.coverKind.replace("-", " "));
  return title(entity.kind);
}

function roleLabel(part: DamagePart): string {
  if (part.role === "volatile") return "Explosive";
  return title(part.role);
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}


function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
