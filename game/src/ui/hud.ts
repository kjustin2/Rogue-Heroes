import { AIM_LABELS, type AimMode, type CombatEntity, type DamagePart } from "../game/damageModel";
import type { Intent, TacticalSim } from "../game/sim";

const AIMS: AimMode[] = ["center", "weapon", "mobility", "utility", "head", "core", "weakest"];
const INTENTS: { id: Intent; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "move", label: "Move" },
  { id: "shoot", label: "Shoot" },
  { id: "ram", label: "Ram" },
];

export interface HudCallbacks {
  setIntent(intent: Intent): void;
  setAim(aim: AimMode): void;
  endTurn(): void;
  reset(): void;
  select(id: string): void;
  queueShoot(id: string): void;
  queueRam(id: string): void;
}

export class Hud {
  private lastHtml = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly sim: TacticalSim,
    private readonly callbacks: HudCallbacks
  ) {
    this.root.addEventListener("click", (event) => this.handleClick(event));
  }

  update(): void {
    const selected = this.sim.selected;
    const playerUnits = this.sim.entities.filter((e) => e.team === "player");
    const enemies = this.sim.entities.filter((e) => e.team === "enemy");
    const neutral = this.sim.entities.filter((e) => e.team === "neutral");

    const nextHtml = `
      <div class="topbar">
        <div>
          <div class="brand">Rogue Heroes Tactics</div>
          <div class="phase ${this.sim.phase}">Turn ${this.sim.turn} / ${title(this.sim.phase)}</div>
        </div>
        <div class="top-actions">
          <button class="btn ghost" data-action="reset">Reset</button>
          <button class="btn primary" data-action="end" ${this.sim.phase !== "command" ? "disabled" : ""}>End Turn</button>
        </div>
      </div>

      <aside class="panel roster">
        <div class="panel-title">Squad</div>
        ${playerUnits.map((unit) => unitCard(unit, unit.id === this.sim.selectedId)).join("")}
      </aside>

      <aside class="panel inspector">
        ${selected ? inspectEntity(selected) : `<div class="empty">No unit selected</div>`}
        <div class="target-list">
          <div class="panel-title">Hostiles</div>
          ${enemies.map((unit) => compactEntity(unit, unit.id === this.sim.selectedId)).join("")}
          <div class="panel-title small">Cover</div>
          ${neutral.map((unit) => compactEntity(unit, unit.id === this.sim.selectedId)).join("")}
        </div>
      </aside>

      <section class="commandbar">
        <div class="segment">
          ${INTENTS.map((intent) => `<button class="tool ${this.sim.intent === intent.id ? "active" : ""}" data-intent="${intent.id}">${intent.label}</button>`).join("")}
        </div>
        <div class="segment aim">
          ${AIMS.map((aim) => `<button class="tool ${this.sim.aim === aim ? "active" : ""}" data-aim="${aim}">${AIM_LABELS[aim]}</button>`).join("")}
        </div>
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
    const intent = target.closest<HTMLElement>("[data-intent]")?.dataset.intent as Intent | undefined;
    if (intent) this.callbacks.setIntent(intent);

    const aim = target.closest<HTMLElement>("[data-aim]")?.dataset.aim as AimMode | undefined;
    if (aim) this.callbacks.setAim(aim);

    const select = target.closest<HTMLElement>("[data-select]")?.dataset.select;
    if (select) {
      const entity = this.sim.entity(select);
      if (entity && entity.team !== "player" && this.sim.intent === "shoot") {
        this.callbacks.queueShoot(select);
      } else if (entity && entity.team !== "player" && this.sim.intent === "ram") {
        this.callbacks.queueRam(select);
      } else {
        this.callbacks.select(select);
      }
    }

    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "end") this.callbacks.endTurn();
    if (action === "reset") this.callbacks.reset();
  }
}

function unitCard(entity: CombatEntity, selected: boolean): string {
  return `
    <button class="unit-card ${selected ? "selected" : ""} ${entity.status.alive ? "" : "dead"}" data-select="${entity.id}">
      <span class="unit-name">${escapeHtml(entity.name)}</span>
      <span class="unit-meta">${entity.kind.toUpperCase()} / CP ${entity.commandPoints}</span>
      <span class="mini-bars">${entity.parts.map((part) => miniBar(part)).join("")}</span>
    </button>
  `;
}

function compactEntity(entity: CombatEntity, selected: boolean): string {
  return `
    <button class="target-chip ${selected ? "selected" : ""} ${entity.status.alive ? "" : "dead"}" data-select="${entity.id}">
      <span>${escapeHtml(entity.name)}</span>
      <span>${statusText(entity)}</span>
    </button>
  `;
}

function inspectEntity(entity: CombatEntity): string {
  return `
    <div class="inspect-head">
      <div>
        <div class="panel-title">Selected</div>
        <h2>${escapeHtml(entity.name)}</h2>
      </div>
      <div class="status-pill ${entity.status.alive ? "" : "dead"}">${statusText(entity)}</div>
    </div>
    <div class="stat-grid">
      <div><span>Type</span><strong>${entity.kind}</strong></div>
      <div><span>Team</span><strong>${entity.team}</strong></div>
      <div><span>CP</span><strong>${entity.commandPoints}/${entity.maxCommandPoints}</strong></div>
    </div>
    <div class="parts">
      ${entity.parts.map((part) => partRow(part)).join("")}
    </div>
  `;
}

function partRow(part: DamagePart): string {
  const ratio = part.hp / part.maxHp;
  return `
    <div class="part-row ${part.hp <= 0 ? "destroyed" : ""}">
      <div>
        <strong>${escapeHtml(part.label)}</strong>
        <span>${part.role}</span>
      </div>
      <div class="bar"><i style="width:${Math.max(0, ratio * 100).toFixed(1)}%"></i></div>
      <em>${Math.max(0, Math.ceil(part.hp))}/${part.maxHp}</em>
    </div>
  `;
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
