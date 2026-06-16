import type { Vec2 } from "../core/math";
import type { CombatEntity, DamagePart } from "../game/damageModel";
import type { Intent, ShotPreview, TacticalOrder, TacticalSim } from "../game/sim";

const ORDER_ACTIONS: Array<{ id: Intent; label: string; tip: string }> = [
  { id: "move", label: "Move", tip: "Select Move, then click an open point on the map. Costs 1 CP and becomes this unit's order for the turn." },
  { id: "shoot", label: "Shoot", tip: "Select Shoot, pick an enemy part, then confirm. The map line previews whether cover blocks the shot." },
  { id: "ram", label: "Ram", tip: "Tank only. Select a target, then confirm. Costs 1 CP, deals 72 damage, and damages your front armor." },
];

export interface HudCallbacks {
  setIntent(intent: Intent): void;
  endTurn(): void;
  reset(): void;
  select(id: string): void;
  queueMove(destination: Vec2): boolean;
  queueShootPart(id: string, partId: string): boolean;
  queueRam(id: string): boolean;
  cancelOrder(id: string): boolean;
}

export class Hud {
  private lastHtml = "";
  private action: Intent = "select";
  private targetId: string | undefined;
  private targetPartId: string | undefined;
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

  chooseBoardEntity(id: string): void {
    const entity = this.sim.entity(id);
    if (!entity) return;
    if (entity.team === "player") {
      this.chooseUnit(id);
    } else {
      this.chooseTarget(id);
    }
  }

  setAction(action: Intent): void {
    this.action = action;
    if (action === "select" || action === "move") this.targetPartId = undefined;
    if (action === "shoot") this.chooseDefaultTargetPart();
    this.callbacks.setIntent(action);
  }

  resetGame(): void {
    this.action = "select";
    this.targetId = undefined;
    this.targetPartId = undefined;
    this.callbacks.reset();
  }

  chooseGround(destination: Vec2): void {
    if (this.action !== "move" || this.sim.phase !== "command") return;
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
    const playerUnits = this.sim.entities.filter((entity) => entity.team === "player");
    const enemies = this.sim.entities.filter((entity) => entity.team === "enemy");
    const cover = this.sim.entities.filter((entity) => entity.team === "neutral");
    const playerOrders = new Map(
      this.sim.orders
        .filter((order) => this.sim.entity(order.actorId)?.team === "player")
        .map((order) => [order.actorId, order])
    );

    const nextHtml = `
      <div class="topbar">
        <div>
          <div class="brand">Rogue Heroes Tactics</div>
          <div class="phase ${this.sim.phase}">Turn ${this.sim.turn} / ${title(this.sim.phase)}</div>
        </div>
        <div class="top-actions">
          <button class="btn ghost" data-command="reset" data-tip="Clear all damage and queued orders.">Reset</button>
          <button class="btn primary" data-command="end" ${this.sim.phase !== "command" ? "disabled" : ""} data-tip="Resolve every queued player and enemy order.">End Turn</button>
        </div>
      </div>

      <aside class="panel roster">
        <div class="panel-title">Squad</div>
        ${playerUnits.map((unit) => unitCard(unit, unit.id === actor?.id, playerOrders.get(unit.id), this.sim)).join("")}
      </aside>

      <aside class="panel target-panel">
        ${target ? inspectEntity(target, "Target", this.targetPartId) : emptyTargetPanel()}
        <div class="target-list">
          <div class="panel-title">Hostiles</div>
          ${enemies.map((unit) => targetChip(unit, unit.id === this.targetId, actor, this.sim)).join("")}
          <div class="panel-title small">Cover</div>
          ${cover.map((unit) => targetChip(unit, unit.id === this.targetId, actor, this.sim)).join("")}
        </div>
      </aside>

      <section class="commandbar">
        ${orderPlanner(actor, target, this.targetPartId, this.action, playerOrders.get(actor?.id ?? ""), this.sim)}
      </section>

      <section class="log">
        ${this.sim.log.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
      </section>
    `;

    if (nextHtml !== this.lastHtml) {
      this.root.innerHTML = nextHtml;
      this.lastHtml = nextHtml;
    }
  }

  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    const disabled = target.closest<HTMLElement>("[data-disabled='true']");
    if (disabled) return;
    this.hideTooltip();

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
      this.action = orderAction;
      if (orderAction === "move") this.targetPartId = undefined;
      if (orderAction === "shoot") this.chooseDefaultTargetPart();
      this.callbacks.setIntent(orderAction);
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

    const command = target.closest<HTMLElement>("[data-command]")?.dataset.command;
    if (command === "end") this.callbacks.endTurn();
    if (command === "reset") this.resetGame();
  }

  private chooseUnit(id: string): void {
    this.callbacks.select(id);
    this.action = "select";
    this.callbacks.setIntent("select");
  }

  private chooseTarget(id: string): void {
    const target = this.sim.entity(id);
    if (!target) return;
    this.targetId = id;
    this.targetPartId = this.firstTargetablePart(target);
    if (this.action !== "shoot" && this.action !== "ram") {
      this.action = "shoot";
      this.callbacks.setIntent(this.action);
    }
  }

  private afterConfirmedOrder(): void {
    this.action = "select";
    this.targetPartId = undefined;
    this.callbacks.setIntent("select");
  }

  private pruneInvalidFocus(): void {
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

  private firstTargetablePart(target: CombatEntity): string | undefined {
    return this.sim.targetableParts(target)[0]?.id;
  }

  private handleTooltipOver(event: PointerEvent): void {
    const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-tip]");
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

function unitCard(entity: CombatEntity, selected: boolean, order: TacticalOrder | undefined, sim: TacticalSim): string {
  return `
    <div class="unit-card ${selected ? "selected" : ""} ${entity.status.alive ? "" : "dead"}">
      <button class="unit-select" data-select="${entity.id}" data-tip="${escapeAttr(cpTip(entity))}">
        <span class="unit-name">${escapeHtml(entity.name)}</span>
        <span class="unit-meta">${entity.kind.toUpperCase()} / ${cpPips(entity)}</span>
        <span class="mini-bars">${entity.parts.map((part) => miniBar(part)).join("")}</span>
        <span class="queued-order">${order ? escapeHtml(orderSummary(order, sim)) : "No order queued"}</span>
      </button>
      ${order && sim.phase === "command" ? `<button class="mini-action undo" data-cancel-order="${entity.id}" data-tip="Undo ${escapeAttr(entity.name)}'s queued order and refund 1 CP.">Undo</button>` : ""}
    </div>
  `;
}

function targetChip(entity: CombatEntity, selected: boolean, actor: CombatEntity | undefined, sim: TacticalSim): string {
  const firstPart = sim.targetableParts(entity)[0];
  const preview = actor && firstPart ? sim.previewShot(actor.id, entity.id, firstPart.id) : undefined;
  const blocked = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const tip = blocked
    ? `${entity.name} is behind ${blocked.name}; shots hit that cover first.`
    : `${entity.name}: ${entity.kind}, ${statusText(entity)}.`;
  return `
    <button class="target-chip ${selected ? "selected" : ""} ${entity.status.alive ? "" : "dead"}" data-select="${entity.id}" data-tip="${escapeAttr(tip)}">
      <span>${escapeHtml(entity.name)}</span>
      <span>${blocked ? `blocked by ${escapeHtml(blocked.name)}` : statusText(entity)}</span>
    </button>
  `;
}

function emptyTargetPanel(): string {
  return `
    <div class="inspect-head">
      <div>
        <div class="panel-title">Target</div>
        <h2>No target</h2>
      </div>
    </div>
    <div class="empty-target">Enemy and cover details appear here.</div>
  `;
}

function inspectEntity(entity: CombatEntity, titleText: string, activePartId: string | undefined): string {
  return `
    <div class="inspect-head">
      <div>
        <div class="panel-title">${titleText}</div>
        <h2>${escapeHtml(entity.name)}</h2>
      </div>
      <div class="status-pill ${entity.status.alive ? "" : "dead"}">${statusText(entity)}</div>
    </div>
    <div class="stat-grid">
      <div><span>Type</span><strong>${entity.kind}</strong></div>
      <div><span>Team</span><strong>${entity.team}</strong></div>
      <div data-tip="${escapeAttr(cpTip(entity))}"><span>CP</span><strong>${entity.commandPoints}/${entity.maxCommandPoints}</strong></div>
    </div>
    <div class="parts">
      ${entity.parts.map((part) => partRow(part, part.id === activePartId)).join("")}
    </div>
  `;
}

function orderPlanner(
  actor: CombatEntity | undefined,
  target: CombatEntity | undefined,
  targetPartId: string | undefined,
  action: Intent,
  order: TacticalOrder | undefined,
  sim: TacticalSim
): string {
  const selectedPart = target?.parts.find((part) => part.id === targetPartId);
  const preview = actor && target && selectedPart ? sim.previewShot(actor.id, target.id, selectedPart.id) : undefined;
  const blocker = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const canShoot = Boolean(actor && target && selectedPart && actor.status.canShoot && actor.commandPoints > 0 && sim.phase === "command");
  const canRam = Boolean(actor && target && target.team !== "player" && actor.kind === "tank" && actor.status.canMove && actor.commandPoints > 0 && sim.phase === "command");
  const ramTip = actor?.kind === "tank"
    ? "Costs 1 CP. Deals 72 damage to the target and 14 damage to your front armor."
    : "Only tanks can ram.";

  return `
    <div class="order-head">
      <div>
        <div class="panel-title">Order</div>
        <h2>${actor ? escapeHtml(actor.name) : "No unit selected"}</h2>
      </div>
      <div class="cp-badge" data-tip="${actor ? escapeAttr(cpTip(actor)) : "Select a living squad unit."}">
        ${actor ? `${actor.commandPoints}/${actor.maxCommandPoints} CP` : "-- CP"}
      </div>
    </div>

    <div class="action-row">
      ${ORDER_ACTIONS.map((option) => {
        const disabled = actionDisabled(option.id, actor, order, sim);
        const tip = option.id === "ram" ? ramTip : option.tip;
        return `<button class="tool action ${action === option.id ? "active" : ""} ${disabled ? "disabled" : ""}" data-order-action="${option.id}" data-disabled="${disabled}" data-tip="${escapeAttr(tip)}">${option.label}<span>1 CP</span></button>`;
      }).join("")}
    </div>

    <div class="order-body">
      ${order ? queuedOrderState(actor, order, sim) : ""}
      ${!order && action === "move" ? moveState(actor) : ""}
      ${!order && action === "shoot" ? shootState(actor, target, targetPartId, preview, blocker, canShoot, sim) : ""}
      ${!order && action === "ram" ? ramState(target, canRam, ramTip) : ""}
      ${!order && action === "select" ? orderSummaryState(actor, target) : ""}
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
  const parts = sim.targetableParts(target);
  const blockedPart = blocker ? blocker.parts.find((part) => part.id === preview?.impactPartId) : undefined;
  return `
    <div class="target-summary ${blocker ? "blocked" : ""}">
      <strong>${escapeHtml(target.name)}</strong>
      <span>${blocker ? `Line blocked by ${escapeHtml(blocker.name)}; hit ${escapeHtml(blockedPart?.label ?? "cover")} first.` : "Current line is clear; moving targets can still reach cover before impact."}</span>
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

function ramState(target: CombatEntity | undefined, canRam: boolean, tip: string): string {
  return `
    <div class="target-summary">
      <strong>${target ? escapeHtml(target.name) : "No target"}</strong>
      <span>${target ? "Impact: 72 target damage, 14 self armor damage." : "Choose a hostile or cover target."}</span>
    </div>
    <button class="btn confirm ${canRam ? "" : "disabled"}" data-confirm="ram" data-disabled="${!canRam}" data-tip="${escapeAttr(tip)}">
      Confirm Ram
      <span>72 dmg</span>
    </button>
  `;
}

function moveState(actor: CombatEntity | undefined): string {
  const ready = Boolean(actor && actor.status.canMove && actor.commandPoints > 0);
  return `
    <div class="target-summary ${ready ? "" : "blocked"}">
      <strong>${ready ? "Move order armed" : "Move unavailable"}</strong>
      <span>${ready ? "Click a clear point on the battlefield to confirm." : "This unit has no movement or CP available."}</span>
    </div>
  `;
}

function orderSummaryState(actor: CombatEntity | undefined, target: CombatEntity | undefined): string {
  return `
    <div class="target-summary">
      <strong>${actor ? escapeHtml(actor.name) : "Select a unit"}</strong>
      <span>${target ? `Inspecting ${escapeHtml(target.name)}.` : "No target selected."}</span>
    </div>
  `;
}

function queuedOrderState(actor: CombatEntity | undefined, order: TacticalOrder, sim: TacticalSim): string {
  return `
    <div class="target-summary queued">
      <strong>${actor ? escapeHtml(actor.name) : "Selected unit"} is locked in</strong>
      <span>${escapeHtml(orderSummary(order, sim))}. Undo this before ending the turn if you want a different action.</span>
    </div>
    <button class="btn confirm undo-order" data-cancel-order="${order.actorId}" data-tip="Cancel this unit's queued order and refund its 1 CP.">
      Undo Order
      <span>refund 1 CP</span>
    </button>
  `;
}

function partButton(actor: CombatEntity, target: CombatEntity, part: DamagePart, selected: boolean, sim: TacticalSim): string {
  const preview = sim.previewShot(actor.id, target.id, part.id);
  const blocker = preview?.blockedById ? sim.entity(preview.blockedById) : undefined;
  const impactTarget = preview ? sim.entity(preview.impactEntityId) : undefined;
  const impactPart = impactTarget?.parts.find((candidate) => candidate.id === preview?.impactPartId);
  const tip = [
    partTip(part),
    preview ? `Estimated damage: ${preview.amount}.` : "",
    blocker ? `Blocked by ${blocker.name}; the shot hits ${impactPart?.label ?? blocker.name} first.` : "Clear shot to this part.",
  ].filter(Boolean).join(" ");
  return `
    <button class="part-choice ${selected ? "active" : ""} ${blocker ? "blocked" : ""}" data-part="${part.id}" data-tip="${escapeAttr(tip)}">
      <strong>${escapeHtml(part.label)}</strong>
      <span>${part.role} / ${Math.ceil(part.hp)} HP</span>
      <em>${preview ? `${preview.amount} dmg` : "--"}</em>
    </button>
  `;
}

function partRow(part: DamagePart, active: boolean): string {
  const ratio = part.hp / part.maxHp;
  return `
    <button class="part-row ${part.hp <= 0 ? "destroyed" : ""} ${active ? "active" : ""}" data-part="${part.id}" data-disabled="${part.hp <= 0}" data-tip="${escapeAttr(partTip(part))}">
      <div>
        <strong>${escapeHtml(part.label)}</strong>
        <span>${part.role}</span>
      </div>
      <div class="bar"><i style="width:${Math.max(0, ratio * 100).toFixed(1)}%"></i></div>
      <em>${Math.max(0, Math.ceil(part.hp))}/${part.maxHp}</em>
    </button>
  `;
}

function actionDisabled(action: Intent, actor: CombatEntity | undefined, order: TacticalOrder | undefined, sim: TacticalSim): boolean {
  if (!actor || sim.phase !== "command" || actor.commandPoints <= 0) return true;
  if (order) return true;
  if (action === "move") return !actor.status.canMove;
  if (action === "shoot") return !actor.status.canShoot;
  if (action === "ram") return actor.kind !== "tank" || !actor.status.canMove;
  return false;
}

function orderSummary(order: TacticalOrder, sim: TacticalSim): string {
  const target = sim.entity(order.targetId);
  const part = target?.parts.find((candidate) => candidate.id === order.targetPartId);
  if (order.kind === "move") return "Queued: move";
  if (order.kind === "ram") return `Queued: ram ${target?.name ?? "target"}`;
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
  if (blocker) return `Confirm the shot. ${blocker.name} blocks ${target.name}, so the shot deals ${preview.amount} damage to cover.`;
  return `Confirm the shot for ${preview.amount} estimated damage. Projectile travel is slow enough for movement and cover to matter.`;
}

function partTip(part: DamagePart): string {
  if (part.role === "core") return "Core part. Destroying a critical core disables the unit.";
  if (part.role === "head") return "Head part. Destroying it disables a soldier immediately.";
  if (part.role === "weapon") return "Weapon part. Destroying it stops this unit from shooting.";
  if (part.role === "mobility") return "Mobility part. Destroying it stops movement and rams.";
  if (part.role === "utility") return "System part. Destroying it can jam weapons or reduce CP.";
  if (part.role === "armor") return "Armor part. Destroying it exposes the core to stronger follow-up shots.";
  if (part.role === "volatile") return "Volatile part. Destroying it causes an explosion.";
  return "Targetable part.";
}

function miniBar(part: DamagePart): string {
  const ratio = Math.max(0, part.hp / part.maxHp);
  return `<i class="${part.hp <= 0 ? "down" : ""}" style="width:${(ratio * 100).toFixed(0)}%"></i>`;
}

function statusText(entity: CombatEntity): string {
  if (!entity.status.alive) return "disabled";
  if (entity.status.exposedCore) return "exposed";
  if (entity.status.immobilized) return "immobile";
  if (entity.status.disarmed) return "disarmed";
  if (entity.status.commandLimited) return "limited";
  return "ready";
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
