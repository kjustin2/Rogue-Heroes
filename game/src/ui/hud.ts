import type { Vec2 } from "../core/math";
import { isInfantryKind, type CombatEntity, type DamagePart, type InfantryStance } from "../game/damageModel";
import type { Intent, ShotPreview, TacticalOrder, TacticalSim, TurnDamageEntry, TurnReport } from "../game/sim";

const ORDER_ACTIONS: Array<{ id: Intent; label: string; tip: string }> = [
  { id: "move", label: "Move", tip: "Select Move, then click ground or a cover object. Costs 1 CP. Soldiers move farther than heavy units." },
  { id: "shoot", label: "Shoot", tip: "Select Shoot, pick an enemy part, then confirm. The map line previews cover, high ground, estimated damage, and shot accuracy." },
  { id: "ram", label: "Ram", tip: "Tank only. Select a close target or wall, then confirm. Costs 1 CP, deals 72 damage, and damages your front armor." },
  { id: "melee", label: "Strike", tip: "Melee unit only. Rush a nearby hostile and hit hard at close range." },
  { id: "defend", label: "Crouch", tip: "Infantry only. Improves accuracy and makes head shots harder, but slows the next move." },
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
  queueRam(id: string): boolean;
  queueMelee(id: string): boolean;
  queueDefend(stance?: InfantryStance): boolean;
  cancelOrder(id: string): boolean;
  explainRamTarget(id: string): boolean;
  explainMeleeTarget(id: string): boolean;
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
    if (entity.kind === "cover" && this.action !== "shoot" && this.action !== "ram" && this.action !== "melee") {
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

  setAction(action: Intent): void {
    this.action = action;
    if (action === "select" || action === "move") this.targetPartId = undefined;
    if (action === "select" || action === "move") this.targetId = undefined;
    if (action !== "select") this.friendlyDetailsId = undefined;
    if (action === "shoot") this.chooseDefaultTargetPart();
    this.callbacks.setIntent(action);
  }

  resetGame(): void {
    this.action = "select";
    this.targetId = undefined;
    this.targetPartId = undefined;
    this.friendlyDetailsId = undefined;
    this.callbacks.reset();
  }

  chooseGround(destination: Vec2): void {
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
    const targetPanelOpen = !target && (this.action === "shoot" || this.action === "ram" || this.action === "melee");
    const allOrdersSet = this.sim.phase === "command" && playerUnits.filter((unit) => unit.status.alive).every((unit) => unit.commandPoints <= 0);
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
      </div>

      <aside class="panel roster ${allOrdersSet ? "all-set" : ""}">
        <div class="panel-title">Squad <span class="phase-chip ${this.sim.phase}">T${this.sim.turn} ${title(this.sim.phase)}</span>${allOrdersSet ? `<span class="all-orders-chip">All set</span>` : ""}</div>
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

      <section class="log compact-log ${this.logExpanded ? "expanded" : ""}" data-tip="${escapeAttr(this.sim.log.join(" / "))}">
        <button class="log-toggle" data-command="toggle-log" aria-label="${this.logExpanded ? "Close battle log" : "Open battle log"}" data-tip="${this.logExpanded ? "Collapse action log." : "Expand recent hits, misses, and system damage."}">
          <span class="log-toggle-icon">${this.logExpanded ? "X" : "+"}</span>
          <strong>${this.logExpanded ? "Close Battle Log" : "Open Log"}</strong>
        </button>
        ${this.logExpanded ? battleLogPanel(this.sim) : `<span>${escapeHtml(this.sim.log[0] ?? "No events")}</span>`}
      </section>
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

    const part = target.closest<HTMLElement>("[data-part]")?.dataset.part;
    if (part && this.targetId) this.targetPartId = part;

    const select = target.closest<HTMLElement>("[data-select]")?.dataset.select;
    if (select) this.chooseBoardEntity(select);

    const confirm = target.closest<HTMLElement>("[data-confirm]")?.dataset.confirm as Intent | undefined;
    if (confirm === "shoot" && this.targetId && this.targetPartId) {
      if (this.callbacks.queueShootPart(this.targetId, this.targetPartId)) this.afterConfirmedOrder();
    }
    if (confirm === "ram" && this.targetId) {
      if (this.callbacks.queueRam(this.targetId)) this.afterConfirmedOrder();
    }
    if (confirm === "melee" && this.targetId) {
      if (this.callbacks.queueMelee(this.targetId)) this.afterConfirmedOrder();
    }
    if (confirm === "defend") {
      if (this.callbacks.queueDefend("crouched")) this.afterConfirmedOrder();
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
    if (command === "toggle-log") this.logExpanded = !this.logExpanded;
    if (command === "close-unit-detail") this.friendlyDetailsId = undefined;
    if (command === "close-target") {
      this.targetId = undefined;
      this.targetPartId = undefined;
      if (this.action === "move" || this.action === "shoot" || this.action === "ram") {
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
    if (this.action === "ram") this.callbacks.explainRamTarget(id);
    if (this.action === "melee") this.callbacks.explainMeleeTarget(id);
    if (this.action !== "shoot" && this.action !== "ram" && this.action !== "melee") {
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
        <span class="unit-meta">${kindLabel(entity)} / ${cpPips(entity)} / ${spent ? "Orders set" : statusText(entity)}${crouched ? `<span class="stance-chip">Crouched</span>` : ""}</span>
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
  const preview = actor && firstPart ? sim.previewShot(actor.id, entity.id, firstPart.id) : undefined;
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
        <div><span>Posture</span><strong>${entity.stance === "crouched" ? "Crouched" : "Standing"}</strong></div>
      </div>
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
  const selectedPart = target?.parts.find((part) => part.id === targetPartId);
  const preview = actor && target && selectedPart ? sim.previewShot(actor.id, target.id, selectedPart.id) : undefined;
  const blocker = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const canShoot = Boolean(actor && target && target.team !== "player" && selectedPart && actor.status.canShoot && actor.commandPoints > 0 && sim.phase === "command");
  const ramStatus = target ? sim.previewRam(target.id) : undefined;
  const meleeStatus = target ? sim.previewMelee(target.id) : undefined;
  const canRam = Boolean(actor && target && target.team !== "player" && actor.kind === "tank" && actor.status.canMove && actor.commandPoints > 0 && sim.phase === "command" && ramStatus?.ok);
  const canMelee = Boolean(actor && target && target.team !== "player" && actor.kind === "striker" && actor.status.canMove && actor.commandPoints > 0 && sim.phase === "command" && meleeStatus?.ok);
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
    action === "ram" ? ramState(target, canRam, ramStatus?.reason, ramTip) : "",
    action === "melee" ? meleeState(target, canMelee, meleeStatus?.reason) : "",
    action === "interact" ? coverInteractionState(actor, target) : "",
    action === "inspect" || action === "inspect-detail" ? inspectTargetState(actor, target, action === "inspect-detail", sim) : "",
    action === "defend" ? defendState(canDefend, defendTip) : "",
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
              return `<button class="tool action action-${option.id} ${action === option.id ? "active" : ""} ${disabled ? "disabled" : ""}" data-order-action="${option.id}" data-disabled="${disabled}" data-tip="${escapeAttr(tip)}"><strong>${index + 1}. ${option.label}</strong><span>1 CP</span></button>`;
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
  if (!target) return `<div class="order-note">Choose a hostile or cover target.</div>`;
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
  if (parts.length === 1) {
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
    </div>
    <button class="btn confirm ${canShoot ? "" : "disabled"}" data-confirm="shoot" data-disabled="${!canShoot}" data-tip="${escapeAttr(confirmShootTip(preview, blocker, target))}">
      Confirm Shoot
      <span>${preview ? `${preview.amount} dmg` : "pick part"}</span>
    </button>
  `;
}

function meleeState(target: CombatEntity | undefined, canMelee: boolean, reason: string | undefined): string {
  return `
    <div class="target-summary ${canMelee ? "" : "blocked"}">
      <strong>${target ? escapeHtml(target.name) : "Pick target"}</strong>
      <span>${reason ? escapeHtml(reason) : target ? "Fast close attack. High damage if the striker can reach." : "Choose a nearby hostile or object."}</span>
    </div>
    <button class="btn confirm ${canMelee ? "" : "disabled"}" data-confirm="melee" data-disabled="${!canMelee}" data-tip="Queue a fast melee strike against the selected target.">
      Confirm Strike
      <span>86 dmg</span>
    </button>
  `;
}

function coverInteractionState(actor: CombatEntity | undefined, target: CombatEntity | undefined): string {
  if (!target || target.kind !== "cover") return "";
  const isCliff = target.coverKind === "cliff";
  const canClimb = Boolean(actor && isInfantryKind(actor.kind) && (isCliff || (target.height <= 1.22 && target.coverKind !== "wall" && target.coverKind !== "ridge")));
  const canTakeCover = Boolean(actor && isInfantryKind(actor.kind) && !isCliff);
  const canShoot = Boolean(actor?.status.canShoot && !isCliff);
  const summary = isCliff
    ? actor && !isInfantryKind(actor.kind)
      ? "Tanks cannot climb this cliff. Use infantry to ascend."
      : "Infantry can climb this ascent to reach the mesa."
    : `${kindLabel(target)} / ${Math.ceil(target.parts[0]?.hp ?? 0)} HP`;
  return `
    <div class="target-summary ${isCliff && actor && !isInfantryKind(actor.kind) ? "blocked" : ""}">
      <strong>${escapeHtml(target.name)}</strong>
      <span>${summary}</span>
    </div>
    <div class="cover-actions">
      ${canTakeCover ? `<button class="btn confirm" data-cover-action="cover" data-tip="Move beside this object and crouch if the unit has enough CP.">
        Take Cover
        <span>move+crouch</span>
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
      <span>${kindLabel(target)} / ${statusText(target)} / ${parts.length} parts</span>
    </div>
    <div class="inspect-target-actions">
      ${actor?.status.canShoot ? `<button class="btn confirm" data-order-action="shoot" data-tip="Aim at a specific part.">
        Shoot
        <span>aim</span>
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
    ${expanded ? `<div class="compact-target-parts">${parts.map((part) => partRow(part, false)).join("")}</div>` : ""}
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

function partButton(actor: CombatEntity, target: CombatEntity, part: DamagePart, selected: boolean, sim: TacticalSim, statusTextOverride?: string): string {
  const preview = sim.previewShot(actor.id, target.id, part.id);
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
          ? "Arcing explosive shot; nearby units can still take splash damage."
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
  if (action === "ram") return actor.kind !== "tank" || !actor.status.canMove;
  if (action === "melee") return actor.kind !== "striker" || !actor.status.canMove;
  if (action === "defend") return !isInfantryKind(actor.kind) || !actor.status.canMove;
  return false;
}

function actionVisible(action: Intent, actor: CombatEntity | undefined, sim: TacticalSim): boolean {
  if (!actor || sim.phase !== "command") return false;
  if (action === "ram") return actor.kind === "tank" && actor.status.canMove;
  if (action === "melee") return actor.kind === "striker" && actor.status.canMove;
  if (action === "defend") return isInfantryKind(actor.kind) && actor.status.canMove;
  if (action === "shoot") return actor.status.canShoot;
  if (action === "move") return actor.status.canMove;
  return false;
}

function orderSummary(order: TacticalOrder, sim: TacticalSim): string {
  const target = sim.entity(order.targetId);
  const part = target?.parts.find((candidate) => candidate.id === order.targetPartId);
  if (order.kind === "move") return "Queued: move";
  if (order.kind === "ram") return `Queued: ram ${target?.name ?? "target"}`;
  if (order.kind === "melee") return `Queued: strike ${target?.name ?? "target"}`;
  if (order.kind === "defend") return "Queued: crouch";
  return `Queued: shoot ${target?.name ?? "target"}${part ? ` / ${part.label}` : ""}`;
}

function cpPips(entity: CombatEntity): string {
  const pips = Array.from({ length: entity.maxCommandPoints }, (_, index) =>
    `<i class="${index < entity.commandPoints ? "full" : ""}"></i>`
  ).join("");
  return `<span class="cp-pips">${pips}</span><span class="cp-text">CP ${entity.commandPoints}/${entity.maxCommandPoints}</span>`;
}

function cpTip(entity: CombatEntity): string {
  const limited = entity.status.commandLimited ? " Damaged systems reduce this unit's refill." : "";
  return `Command Points. Most orders cost 1 CP. ${entity.name} has ${entity.commandPoints} of ${entity.maxCommandPoints} CP this turn.${limited}`;
}

function confirmShootTip(preview: ShotPreview | undefined, blocker: CombatEntity | undefined, target: CombatEntity): string {
  if (!preview) return "Pick a target part before confirming the shot.";
  if (preview.warningText) return `${preview.warningText}. Confirming can hit your own unit if the projectile crosses them.`;
  if (blocker) return `Confirm the shot. ${blocker.name} blocks ${target.name}, so the shot deals ${preview.amount} damage to cover.`;
  if (preview.blockedByGround) return "This shot will hit high ground before the target. Move or choose a higher part for a clean line.";
  return `Confirm the shot for ${preview.amount} estimated damage. ${preview.accuracyLabel}; spread changes the projectile trajectory and can hit another part or unit.`;
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
