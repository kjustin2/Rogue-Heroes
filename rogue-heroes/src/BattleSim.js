import { BUILD_DEFS, UNIT_DEFS } from "./defs.js";

const FIELD = { x: 210, y: 82, w: 880, h: 610 };
const CORE = { x: 650, y: 365, r: 34, hp: 260 };

export class BattleSim {
  constructor(sim) {
    this.sim = sim;
    this.speed = 1;
    this.reset();
  }

  reset() {
    this.active = false;
    this.attackerId = 0;
    this.defenderId = 1;
    this.attackers = [];
    this.defenders = [];
    this.structures = [];
    this.projectiles = [];
    this.effects = [];
    this.beams = [];
    this.rings = [];
    this.impact = 0;
    this.core = { ...CORE, maxHp: CORE.hp };
    this.timer = 0;
    this.maxTime = 75;
    this.result = null;
    this.nextChaos = 4;
  }

  start(match, watch = true) {
    this.reset();
    this.active = true;
    this.watch = watch;
    this.attackerId = match.attackerId;
    this.defenderId = match.defenderId;
    this.attackerNodeId = match.attackerNodeId || null;
    this.defenderNodeId = match.defenderNodeId || null;
    this.formation = match.formation || "line";
    this.entry = match.entry || this.pickEntry();
    const defender = this.sim.kingdoms[this.defenderId];
    const structures = this.defenderNodeId && this.sim.structuresForNode
      ? this.sim.structuresForNode(this.defenderId, this.defenderNodeId)
      : defender.structures;
    this.structures = structures.map((structure) => ({ ...structure, cooldown: 0 }));
    this.attackers = this.spawnArmy(match.army);
    this.defenders = this.spawnDefenders(match.defenderArmy || [
      ...this.sim.makeDefenders(this.defenderId, this.defenderNodeId, match.defenderUsesOffense),
      ...(match.defenderExtraArmy || []),
    ]);
    this.startingAttackers = this.attackers.length;
    this.contestedNeutral = !!match.contestedNeutral;
    this.targetNodeId = match.targetNodeId || this.defenderNodeId;
  }

  spawnArmy(armyTypes) {
    const units = [];
    for (let i = 0; i < armyTypes.length; i++) {
      const type = armyTypes[i];
      const def = UNIT_DEFS[type];
      const p = formationPoint(this.entry, this.formation, i, armyTypes.length);
      units.push(this.makeUnit(type, 0, p.x, p.y, def, this.attackerId));
    }
    return units;
  }

  spawnDefenders(types) {
    const units = [];
    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const def = UNIT_DEFS[type];
      const angle = (Math.PI * 2 * i) / Math.max(1, types.length);
      units.push(this.makeUnit(type, 1, this.core.x + Math.cos(angle) * 92, this.core.y + Math.sin(angle) * 92, def, this.defenderId));
    }
    return units;
  }

  pickEntry() {
    const entries = ["west", "north", "south"];
    return this.sim.rng.pick(entries);
  }

  update(dt) {
    if (this.result) {
      this.updateEffects(dt);
      this.impact = Math.max(0, this.impact - dt * 4.5);
      return;
    }
    if (!this.active) return;
    this.step(dt * this.speed);
  }

  step(dt) {
    this.timer += dt;
    this.updateUnitTimers(dt, this.attackers);
    this.updateUnitTimers(dt, this.defenders);
    this.updateStructures(dt);
    this.updateUnits(dt, this.attackers, this.defenders);
    this.updateUnits(dt, this.defenders, this.attackers);
    this.updateProjectiles(dt);
    this.updateChaos(dt);
    this.updateEffects(dt);
    this.cleanup();
    this.checkEnd();
    this.impact = Math.max(0, this.impact - dt * 2.8);
  }

  updateChaos(dt) {
    if (!this.watch) return;
    this.nextChaos -= dt;
    if (this.nextChaos > 0) return;
    this.nextChaos = 3.5 + this.sim.rng.next() * 3.2;
    const livingAttackers = this.attackers.filter((unit) => unit.hp > 0);
    const livingDefenders = this.defenders.filter((unit) => unit.hp > 0);
    if (livingAttackers.length > 3 && this.sim.rng.next() < 0.55) {
      const center = this.sim.rng.pick(livingAttackers);
      this.rings.push({ x: center.x, y: center.y, r: 58, color: "#ffb347", t: 0, life: 0.28 });
      this.addEffect(center.x, center.y, "hit", "CLASH", "#ffb347");
    } else if (livingDefenders.length > 0) {
      const center = this.sim.rng.pick(livingDefenders);
      this.beams.push({ x1: center.x - 42, y1: center.y, x2: center.x + 42, y2: center.y, color: "#8cffaa", t: 0, life: 0.16 });
      this.addEffect(center.x, center.y, "hit", "RALLY", "#8cffaa");
    }
  }

  updateUnitTimers(dt, units) {
    for (const unit of units) {
      unit.slowTimer = Math.max(0, unit.slowTimer - dt);
      unit.chargeTimer = Math.max(0, unit.chargeTimer - dt);
    }
  }

  updateStructures(dt) {
    for (const structure of this.structures) {
      if (structure.hp <= 0 || structure.disabled) continue;
      const def = BUILD_DEFS[structure.type];
      if (def.blocks) {
        for (const attacker of this.attackers) {
          if (attacker.hp <= 0) continue;
          const dx = attacker.x - structure.x;
          const dy = attacker.y - structure.y;
          if (dx * dx + dy * dy < 85 * 85) attacker.slowTimer = Math.max(attacker.slowTimer, 0.22);
        }
        continue;
      }
      if (def.singleUse) {
        const target = nearestAlive(structure, this.attackers, 30);
        if (target) {
          this.applyDamage(target, def.damage, { color: "#ff5470", kind: "blast", sourceType: "trap" });
          this.addEffect(target.x, target.y, "blast", def.damage, "#ff5470");
          structure.disabled = true;
          structure.hp = 0;
          this.impact = Math.max(this.impact, 0.7);
        }
        continue;
      }
      if (!def.damage || !def.range) continue;
      structure.cooldown -= dt;
      if (structure.cooldown > 0) continue;
      const target = nearestAlive(structure, this.attackers, def.range);
      if (!target) continue;
      structure.cooldown = def.cooldown;
      if (def.shot === "beam") {
        this.fireBeam(structure, target, def.damage + this.kingdomMod(this.defenderId, "arrowDamage"), def.range, "#8be9ff");
        continue;
      }
      if (def.shot === "nova") {
        this.fireNova(structure, def.range, def.damage, "#d98cff");
        continue;
      }
      this.projectiles.push({
        x: structure.x,
        y: structure.y,
        target,
        damage: def.damage + this.kingdomMod(this.defenderId, "arrowDamage"),
        color: "#91d7ff",
        speed: 520,
        trail: 0.8,
        sourceType: structure.type,
      });
      if (structure.type === "tower" && this.sim.rng.next() < 0.28) {
        const extra = nearestAlive(target, this.attackers.filter((u) => u !== target), 95);
        if (extra) {
          this.projectiles.push({
            x: structure.x,
            y: structure.y,
            target: extra,
            damage: Math.max(3, Math.floor((def.damage + this.kingdomMod(this.defenderId, "arrowDamage")) * 0.65)),
            color: "#b9f4ff",
            speed: 570,
            sourceType: "tower",
          });
        }
      }
    }
  }

  updateUnits(dt, units, enemies) {
    for (const unit of units) {
      if (unit.hp <= 0) continue;
      unit.cooldown -= dt;
      const target = this.pickTarget(unit, enemies);
      if (!target) continue;
      const dx = target.x - unit.x;
      const dy = target.y - unit.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist > unit.range) {
        let speed = unit.speed;
        if (unit.slowTimer > 0) speed *= 0.58;
        if (unit.type === "raider" && dist > 120) speed *= 1.28;
        unit.x += (dx / dist) * speed * dt;
        unit.y += (dy / dist) * speed * dt;
        unit.x = Math.max(FIELD.x + unit.r, Math.min(FIELD.x + FIELD.w - unit.r, unit.x));
        unit.y = Math.max(FIELD.y + unit.r, Math.min(FIELD.y + FIELD.h - unit.r, unit.y));
      } else if (unit.cooldown <= 0) {
        unit.cooldown = unit.maxCooldown;
        if (unit.range > 45) {
          if (unit.beam) {
            this.fireBeam(unit, target, unit.damage, unit.range, unit.side === 0 ? "#ff8be8" : "#8be9ff");
            unit.cooldown = unit.maxCooldown;
            continue;
          }
          if (unit.spread) {
            this.fireSpread(unit, target);
            unit.cooldown = unit.maxCooldown;
            continue;
          }
          this.projectiles.push({
            x: unit.x,
            y: unit.y,
            target,
            damage: unit.damage,
            color: unit.side === 0 ? "#ffb26b" : "#b6f28a",
            speed: unit.type === "siege" ? 310 : 430,
            sourceType: unit.type,
            splash: unit.splash || 0,
            slow: unit.slow || 0,
          });
        } else {
          let damage = unit.damage;
          if (unit.type === "knight" && unit.chargeTimer <= 0) {
            damage = Math.round(damage * unit.charge);
            unit.chargeTimer = 4.0;
            this.addEffect(unit.x, unit.y, "hit", "CHARGE", "#ffd766");
          }
          this.applyDamage(target, damage, { color: unit.side === 0 ? "#ff9d67" : "#a7ff83", sourceType: unit.type });
          this.impact = Math.max(this.impact, 0.28);
        }
      }
    }
  }

  fireBeam(source, target, damage, range, color) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const hitPools = source.side === 0 ? [this.defenders, this.structures, [this.core]] : [this.attackers];
    let hits = 0;
    for (const pool of hitPools) {
      for (const unit of pool) {
        if (unit.hp <= 0) continue;
        const ux = unit.x - source.x;
        const uy = unit.y - source.y;
        const forward = ux * nx + uy * ny;
        if (forward < 0 || forward > range) continue;
        const side = Math.abs(ux * ny - uy * nx);
        if (side <= 18 + (unit.r || 8)) {
          this.applyDamage(unit, damage, { color, kind: "beam" });
          hits++;
        }
      }
    }
    this.beams = this.beams || [];
    if (this.watch && this.beams.length < 16) this.beams.push({ x1: source.x, y1: source.y, x2: source.x + nx * range, y2: source.y + ny * range, color, t: 0, life: 0.18 });
    if (hits) this.impact = Math.max(this.impact, 0.32);
  }

  fireNova(source, radius, damage, color) {
    for (const target of this.attackers) {
      if (target.hp <= 0) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      if (dx * dx + dy * dy <= radius * radius) {
        this.applyDamage(target, damage, { color, kind: "blast" });
        target.slowTimer = Math.max(target.slowTimer, 0.8);
      }
    }
    this.rings = this.rings || [];
    if (this.watch && this.rings.length < 16) this.rings.push({ x: source.x, y: source.y, r: radius, color, t: 0, life: 0.32 });
    this.impact = Math.max(this.impact, 0.35);
  }

  fireSpread(unit, target) {
    const base = Math.atan2(target.y - unit.y, target.x - unit.x);
    const angles = [-0.18, 0, 0.18];
    for (const offset of angles) {
      const a = base + offset;
      this.projectiles.push({
        x: unit.x,
        y: unit.y,
        vx: Math.cos(a),
        vy: Math.sin(a),
        side: unit.side,
        damage: unit.damage,
        color: unit.side === 0 ? "#ffd27b" : "#b6f28a",
        speed: 460,
        sourceType: unit.type,
        life: 0.75,
      });
    }
  }

  pickTarget(unit, enemies) {
    const livingEnemies = enemies.filter((enemy) => enemy.hp > 0);
    if (unit.side === 0) {
      const structure = nearestAlive(unit, this.structures, unit.type === "siege" ? 110 : 55);
      if (structure) return structure;
      const defender = nearestAlive(unit, livingEnemies, 260);
      if (defender && unit.type !== "siege") return defender;
      return this.core;
    }
    const attacker = nearestAlive(unit, livingEnemies, 9999);
    return attacker;
  }

  updateProjectiles(dt) {
    for (const shot of this.projectiles) {
      if (shot.vx != null) {
        shot.life -= dt;
        shot.x += shot.vx * shot.speed * dt;
        shot.y += shot.vy * shot.speed * dt;
        const targets = shot.side === 0 ? [...this.defenders, ...this.structures, this.core] : this.attackers;
        for (const target of targets) {
          if (target.hp <= 0) continue;
          const dx = target.x - shot.x;
          const dy = target.y - shot.y;
          const hitR = (target.r || (target.type && BUILD_DEFS[target.type] ? BUILD_DEFS[target.type].size * 0.45 : 16)) + 6;
          if (dx * dx + dy * dy <= hitR * hitR) {
            this.applyDamage(target, shot.damage, shot);
            shot.done = true;
            break;
          }
        }
        if (shot.life <= 0) shot.done = true;
        continue;
      }
      if (!shot.target || shot.target.hp <= 0) {
        shot.done = true;
        continue;
      }
      const dx = shot.target.x - shot.x;
      const dy = shot.target.y - shot.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 12) {
        this.applyDamage(shot.target, shot.damage, shot);
        if (shot.splash) this.applySplash(shot.target, shot.splash, Math.round(shot.damage * 0.45), shot);
        if (shot.slow) shot.target.slowTimer = Math.max(shot.target.slowTimer || 0, 0.7);
        this.impact = Math.max(this.impact, 0.35);
        shot.done = true;
      } else {
        shot.x += (dx / dist) * shot.speed * dt;
        shot.y += (dy / dist) * shot.speed * dt;
      }
    }
    this.projectiles = this.projectiles.filter((shot) => !shot.done);
    if (this.projectiles.length > 90) this.projectiles.splice(0, this.projectiles.length - 90);
  }

  applyDamage(target, amount, opts = {}) {
    const armor = target.armor || 0;
    const actual = Math.max(1, Math.round(amount - armor));
    target.hp -= actual;
    this.addEffect(target.x, target.y, opts.kind || "hit", actual, opts.color || "#ffffff");
    return actual;
  }

  applySplash(origin, radius, damage, opts) {
    const pools = [this.attackers, this.defenders, this.structures];
    for (const pool of pools) {
      for (const target of pool) {
        if (target === origin || target.hp <= 0) continue;
        const dx = target.x - origin.x;
        const dy = target.y - origin.y;
        if (dx * dx + dy * dy <= radius * radius) {
          this.applyDamage(target, damage, { ...opts, kind: "blast" });
        }
      }
    }
    this.addEffect(origin.x, origin.y, "blast", "SPLASH", opts.color || "#e89cff");
  }

  updateEffects(dt) {
    if (this.beams) {
      for (const beam of this.beams) beam.t += dt;
      this.beams = this.beams.filter((beam) => beam.t < beam.life);
    }
    if (this.rings) {
      for (const ring of this.rings) ring.t += dt;
      this.rings = this.rings.filter((ring) => ring.t < ring.life);
    }
    for (const effect of this.effects) {
      effect.t += dt;
      effect.y -= dt * 24;
      effect.r += dt * 42;
    }
    this.effects = this.effects.filter((effect) => effect.t < effect.life);
  }

  cleanup() {
    this.attackers = this.attackers.filter((unit) => unit.hp > 0);
    this.defenders = this.defenders.filter((unit) => unit.hp > 0);
  }

  checkEnd() {
    if (this.core.hp <= 0) {
      this.finish("attacker", true);
    } else if (this.attackers.length === 0) {
      this.finish("defender", false);
    } else if (this.timer >= this.maxTime) {
      this.finish("defender", false);
    }
  }

  finish(winner, coreDestroyed) {
    this.result = {
      attackerId: this.attackerId,
      defenderId: this.defenderId,
      attackerNodeId: this.attackerNodeId,
      defenderNodeId: this.defenderNodeId,
      targetNodeId: this.targetNodeId,
      contestedNeutral: this.contestedNeutral,
      winner,
      coreDestroyed,
      startingAttackers: this.startingAttackers || this.attackers.length,
      survivingAttackers: this.attackers.length,
      survivingDefenders: this.defenders.length,
      time: this.timer,
      structureStates: this.structures.map((structure) => ({ id: structure.id, hp: structure.hp })),
      entry: this.entry,
      formation: this.formation,
    };
    this.active = false;
    this.addEffect(this.core.x, this.core.y, winner === "attacker" ? "blast" : "hold", winner === "attacker" ? "BREACH" : "HOLD", winner === "attacker" ? "#ff5470" : "#7cffb2");
    this.impact = 1;
  }

  fastResolve(match) {
    this.start(match, false);
    this.speed = 8;
    let guard = 0;
    while (!this.result && guard < 2000) {
      this.step(1 / 30);
      guard++;
    }
    const result = this.result;
    this.speed = 1;
    return result;
  }

  kingdomMod(kingdomId, mod) {
    return this.sim.kingdoms[kingdomId]?.tech?.mods?.[mod] || 0;
  }

  makeUnit(type, side, x, y, def, kingdomId) {
    const mods = this.sim.kingdoms[kingdomId]?.tech?.mods || {};
    const unit = makeUnit(type, side, x, y, def);
    if (side === 0 && mods.offenseSpeed) unit.speed *= 1 + mods.offenseSpeed;
    if ((type === "archer" || type === "ranger") && mods.arrowDamage) unit.damage += mods.arrowDamage;
    if (type === "guard" && mods.guardVeterans) {
      unit.hp += 20;
      unit.maxHp += 20;
      unit.damage += 2;
    }
    return unit;
  }
}

function addJitter(value, seed) {
  return value + Math.sin(seed * 12.9898) * 6;
}

BattleSim.prototype.addEffect = function addEffect(x, y, kind, text, color) {
  if (!this.watch) return;
  const seed = this.effects.length + this.timer * 31;
  if (this.effects.length > 70) this.effects.shift();
  this.effects.push({
    x: addJitter(x, seed),
    y: addJitter(y, seed + 4),
    r: kind === "blast" ? 8 : 4,
    kind,
    text,
    color,
    t: 0,
    life: kind === "hold" ? 1.2 : 0.65,
  });
};

function makeUnit(type, side, x, y, def) {
  return {
    type,
    side,
    x,
    y,
    hp: def.hp,
    maxHp: def.hp,
    armor: def.armor || 0,
    speed: def.speed,
    damage: def.damage,
    range: def.range,
    cooldown: 0,
    maxCooldown: def.cooldown,
    r: def.radius,
    role: def.role,
    special: def.special,
    slow: def.slow || 0,
    splash: def.splash || 0,
    charge: def.charge || 1,
    slowTimer: 0,
    chargeTimer: 0,
  };
}

function formationPoint(entry, formation, i, total) {
  const row = Math.floor(i / 5);
  const col = i % 5;
  let forward = row * 28;
  let lateral = (col - Math.min(4, total - 1) / 2) * 28;
  if (formation === "wedge") {
    forward = Math.abs(col - 2) * 18 + row * 32;
    lateral = (col - 2) * 24;
  } else if (formation === "column") {
    forward = i * 22;
    lateral = ((i % 2) - 0.5) * 18;
  } else if (formation === "scatter") {
    forward = ((i * 37) % 120);
    lateral = (((i * 53) % 220) - 110);
  }
  if (entry === "north") return { x: CORE.x + lateral, y: FIELD.y + 22 + forward };
  if (entry === "south") return { x: CORE.x + lateral, y: FIELD.y + FIELD.h - 22 - forward };
  return { x: FIELD.x + 22 + forward, y: CORE.y + lateral };
}

function nearestAlive(origin, items, range) {
  let best = null;
  let bestD = range * range;
  for (const item of items) {
    if (item.hp <= 0) continue;
    const dx = item.x - origin.x;
    const dy = item.y - origin.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

export { FIELD, CORE };
