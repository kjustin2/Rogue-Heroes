import * as THREE from "three";
import { clamp01, dist, pointToSegmentDistance, segmentProgress, type Vec2 } from "../core/math";
import { isDefenseKind, isInfantryKind, isVehicleKind, type CombatEntity, type DamagePart, type PartRole } from "../game/damageModel";
import type { Projectile, ShotPreview, TacticalSim, VisualEvent } from "../game/sim";
import { OVERWATCH_ARC_HALF } from "../game/sim";
import { MAPS, type MapTheme, type AmbientKind, type AmbientSpec } from "../game/maps";
import { ARENA_BOUNDS, arenaDepth, arenaWidth, terrainBlocks, terrainHeightAt } from "../game/terrain";
import { instantiate, modelsVersion, type ModelKey } from "./models";

type PartMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

export interface WorldRenderDebug {
  previewLabels: number;
  splashRings: number;
  affectedMarkers: number;
  orderMarkers: number;
  floatingLabels: number;
  unitMarkers: number;
  ghostedEntities: string[];
}

export class WorldRenderer {
  readonly pickables: THREE.Object3D[] = [];

  private readonly entityRoot = new THREE.Group();
  private readonly markerRoot = new THREE.Group();
  private readonly orderRoot = new THREE.Group();
  private readonly previewRoot = new THREE.Group();
  private readonly projectileRoot = new THREE.Group();
  private readonly effectRoot = new THREE.Group();
  private readonly objectiveRoot = new THREE.Group();
  private readonly groundAimRoot = new THREE.Group();
  private readonly auraRoot = new THREE.Group();
  private readonly sceneryRoot = new THREE.Group();
  private readonly debrisRoot = new THREE.Group();
  // Resolve-phase juice: floating damage numbers and a brief white flash on a freshly-hit part.
  private readonly damageNumberRoot = new THREE.Group();
  private readonly floatingNumbers: { sprite: THREE.Sprite; bornMs: number; origin: Vec2; baseHeight: number; aspect: number }[] = [];
  private readonly flashByPart = new Map<string, number>();
  // Whole-body hit flinch: struck entity id -> { when hit, magnitude 0..1, shove direction }.
  // The unit lurches away from the shooter for a beat so a hit reads as a physical reaction,
  // not just the white part-flash.
  private readonly flinchByEntity = new Map<string, { at: number; mag: number; dx: number; dz: number }>();
  private lastDamageSeq = 0;
  // Dynamic map events: danger-zone rings + an eased sandstorm fog/haze blend.
  private readonly environmentRoot = new THREE.Group();
  private baseFogColor = 0xd9b27a;
  private baseFogDensity = 0.012;
  private baseSkyColor = 0xe8c98f;
  private sandstormBlend = 0;
  private ionBlend = 0;
  private readonly envScratch = new THREE.Color();
  private readonly envSand = new THREE.Color(0xcaa46a);
  private readonly envIon = new THREE.Color(0x5aa0ff);
  // Per-map ambient particle bed (dust/embers/pollen/snow/ash) that drifts to give the map life.
  private ambientPoints: THREE.Points | null = null;
  private ambientVel: Float32Array | null = null;
  private ambientClock = 0;
  private readonly groups = new Map<string, THREE.Group>();
  private readonly unitMarkers = new Map<string, THREE.Group>();
  private readonly destroyedPartKeys = new Set<string>();
  // Per-actor firing recoil [0..1], rebuilt each frame from freshly-launched projectiles so a
  // unit's weapon kicks back (and its body rocks) the instant it shoots.
  private readonly recoilByActor = new Map<string, number>();
  private readonly ring: THREE.Mesh;
  private readonly selectionDisc: THREE.Mesh;
  private readonly selectionBeacon: THREE.Mesh;
  private readonly selectionLight: THREE.PointLight;
  private readonly targetRing: THREE.Mesh;
  private readonly actionRangeRing: THREE.Mesh;
  private readonly placementRing: THREE.Mesh;
  private readonly placementDisc: THREE.Mesh;
  private ghostedEntityIds = new Set<string>();
  private playerAccent = 0x9dfcff;
  private lastOverlaySig = "";
  // Content signatures so the aura/objective overlays only rebuild geometry when they actually
  // change (auras add a coarse pulse bucket so their slow opacity pulse still animates). This kills
  // the per-frame disposeAndClear + geometry churn that caused the "random pauses while planning".
  private lastAurasSig = "";
  private lastObjectivesSig = "";
  // A midtone derived from the active map palette; structural props are tinted toward it so
  // they read as part of the map instead of generic brown crates on every battlefield.
  private propTint = new THREE.Color(0x8a7a5c);
  private skyTexture: THREE.CanvasTexture | null = null;
  private lastModelsVersion = modelsVersion();
  private lastTeamsVersion = 0;
  private readonly ghostStickyUntil = new Map<string, number>();
  private commandPhase = true;
  // Persistent battle scars: scorch decals under every blast, capped FIFO.
  private readonly craterRoot = new THREE.Group();
  private readonly scorchedIds = new Set<string>();
  // Recent flight positions per live projectile — drawn as a fading comet tail.
  private readonly trailHistory = new Map<string, { x: number; y: number; z: number }[]>();
  private debug: WorldRenderDebug = emptyDebug();

  // Fixed pool of flash lights (muzzle/blast), pre-added at intensity 0 so the scene's
  // light count never changes at runtime — a light-count change relinks every material.
  private readonly flashLights: { light: THREE.PointLight; strength: number; until: number; duration: number }[] = [];

  constructor(private readonly scene: THREE.Scene) {
    this.scene.add(this.sceneryRoot, this.craterRoot, this.debrisRoot, this.entityRoot, this.markerRoot, this.orderRoot, this.previewRoot, this.projectileRoot, this.effectRoot, this.objectiveRoot, this.groundAimRoot, this.auraRoot, this.damageNumberRoot, this.environmentRoot);
    for (let i = 0; i < 3; i += 1) {
      // Tight radius + fast decay: a wide pool reads as a brown stain on the ground
      // rather than a flash.
      const light = new THREE.PointLight(0xffc37a, 0, 5.5, 2);
      light.position.y = 1.4;
      this.scene.add(light);
      this.flashLights.push({ light, strength: 0, until: 0, duration: 1 });
    }
    this.applyMap(MAPS[0].theme);
    this.prewarmActionAssets();

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.86, 72),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.98, side: THREE.DoubleSide, depthWrite: false })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.045;
    this.scene.add(this.ring);

    this.selectionDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.72, 64),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false })
    );
    this.selectionDisc.rotation.x = -Math.PI / 2;
    this.selectionDisc.position.y = 0.026;
    this.scene.add(this.selectionDisc);

    this.selectionBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.48, 2.75, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.36, depthWrite: false })
    );
    this.selectionBeacon.position.y = 1.18;
    this.scene.add(this.selectionBeacon);

    // Tight range so the selection glow hugs the unit instead of flooding the ground.
    this.selectionLight = new THREE.PointLight(0x9dfcff, 1.2, 3.4);
    this.selectionLight.position.y = 1.55;
    this.scene.add(this.selectionLight);

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(1.08, 1.18, 56),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.88, side: THREE.DoubleSide })
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.position.y = 0.055;
    this.scene.add(this.targetRing);

    this.actionRangeRing = new THREE.Mesh(
      new THREE.RingGeometry(0.98, 1.02, 96),
      new THREE.MeshBasicMaterial({ color: 0xffbf4d, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false })
    );
    this.actionRangeRing.rotation.x = -Math.PI / 2;
    this.actionRangeRing.position.y = 0.06;
    this.scene.add(this.actionRangeRing);

    this.placementRing = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1.0, 96),
      new THREE.MeshBasicMaterial({ color: 0x8ef2d1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
    );
    this.placementRing.rotation.x = -Math.PI / 2;
    this.placementRing.visible = false;
    this.scene.add(this.placementRing);

    this.placementDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({ color: 0x8ef2d1, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })
    );
    this.placementDisc.rotation.x = -Math.PI / 2;
    this.placementDisc.visible = false;
    this.scene.add(this.placementDisc);
  }

  private prewarmActionAssets(): void {
    for (const key of [
      "shell-body", "shell-nose", "shell-exhaust", "shell-band", "shell-fin",
      "bolt-core", "bolt-ring",
      "grenade-body", "grenade-band", "grenade-spark",
      "rifle-slug", "rifle-tip", "rifle-spark", "rifle-tail",
      "ember", "muzzle-flash",
    ]) projectileGeometry(key);
    for (const radius of [0.026, 0.035, 0.04, 0.052, 0.07, 0.085, 0.11, 0.13]) tubeGeometry(radius);
    for (const radius of [0.22, 0.34, 0.38, 0.46]) projectileShadowGeometry(radius);
    for (const color of [0x75d8ff, 0xff765f, 0xffbf69, 0xffd166, 0xeaffff]) {
      lineMaterial(color, 0.5);
      tubeMaterial(color, 0.5);
      endpointMaterial(color);
    }
  }

  update(sim: TacticalSim, targetId?: string, targetPartId?: string, camera?: THREE.Camera, groundAim?: Vec2): void {
    this.debug = emptyDebug();
    this.commandPhase = sim.phase === "command";
    // A GLB finished loading since last frame: rebuild every entity group so units that
    // were born with procedural fallback meshes pick up their real model.
    if (modelsVersion() !== this.lastModelsVersion || TEAMS.version !== this.lastTeamsVersion) {
      this.lastModelsVersion = modelsVersion();
      this.lastTeamsVersion = TEAMS.version;
      for (const [id, group] of this.groups) {
        disposeSubtree(group);
        this.entityRoot.remove(group);
        this.groups.delete(id);
      }
    }
    // Ghosting with hysteresis: the trigger set is recomputed from in-flight projectiles
    // every frame, so during resolve a cover piece near a fire line would strobe
    // transparent<->opaque frame to frame. Once ghosted, stay ghosted for a beat.
    {
      const now = performance.now();
      for (const id of this.computeGhostedEntities(sim, targetId, targetPartId, camera)) {
        this.ghostStickyUntil.set(id, now + 350);
      }
      const ghosted = new Set<string>();
      for (const [id, until] of this.ghostStickyUntil) {
        if (until > now) ghosted.add(id);
        else this.ghostStickyUntil.delete(id);
      }
      this.ghostedEntityIds = ghosted;
    }
    this.debug.ghostedEntities = [...this.ghostedEntityIds];
    if (sim.entities.every((e) => e.parts.every((p) => p.hp === p.maxHp))) {
      this.destroyedPartKeys.clear();
      this.disposeAndClear(this.debrisRoot);
      this.flinchByEntity.clear();
    }
    this.animateDebris();
    this.pickables.splice(0);
    const liveIds = new Set(sim.entities.map((e) => e.id));
    for (const [id, group] of this.groups) {
      if (!liveIds.has(id)) {
        disposeSubtree(group);
        this.entityRoot.remove(group);
        this.groups.delete(id);
      }
    }
    this.computeRecoil(sim.projectiles);
    for (const entity of sim.entities) this.syncEntity(entity, sim.selectedId, targetId, targetPartId, sim.defending.has(entity.id), this.ghostedEntityIds.has(entity.id));
    this.syncUnitMarkers(sim);
    this.syncSelection(sim);
    this.syncTarget(sim, targetId);
    this.syncActionRange(sim);
    this.syncBuildPlacement(sim);
    this.syncAuras(sim);
    // The order/preview/ground-aim overlays only change on input during the command phase.
    // Rebuilding their geometry every frame while the player is just looking around churns the
    // GC (the source of the "random pauses" while planning), so skip when nothing changed.
    const overlaySig = sim.phase === "command"
      ? `${sim.selectedId}|${targetId ?? ""}|${targetPartId ?? ""}|${sim.intent}|${sim.orders.map((o) => `${o.kind}:${o.actorId}:${o.targetId ?? ""}:${o.destination ? `${o.destination.x.toFixed(1)},${o.destination.z.toFixed(1)}` : ""}`).join(",")}|${groundAim ? `${groundAim.x.toFixed(1)},${groundAim.z.toFixed(1)}` : ""}`
      : `~resolve${sim.projectiles.length}`;
    if (sim.phase !== "command" || overlaySig !== this.lastOverlaySig) {
      this.lastOverlaySig = overlaySig;
      this.syncOrders(sim);
      this.syncShotPreview(sim, targetId, targetPartId);
      this.syncGroundAim(sim, groundAim);
    }
    resetFxLinePool(); // recycle the projectile/effect trail lines instead of reallocating them
    this.syncProjectiles(sim.projectiles);
    this.syncEffects(sim.effects);
    this.syncFlashLights();
    this.syncDamageNumbers(sim);
    this.syncEnvironment(sim);
    this.syncAmbient();
    this.syncObjectives(sim);
  }

  // Dynamic map events: ease the sandstorm haze (fog + sky tint) and draw pulsing danger rings
  // over barrage/collapse zones so the player can read — and clear — the threatened ground.
  private syncEnvironment(sim: TacticalSim): void {
    this.disposeAndClear(this.environmentRoot);
    const env = sim.environment();
    this.sandstormBlend += (env.sandstorm - this.sandstormBlend) * 0.06;
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog && "density" in fog) {
      // A readable dusty haze, not a brown-out: keep units visible while the field clearly hazes.
      fog.color.copy(this.envScratch.setHex(this.baseFogColor)).lerp(this.envSand, this.sandstormBlend * 0.7);
      fog.density = this.baseFogDensity * (1 + this.sandstormBlend * 1.6);
    }
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.envScratch.setHex(this.baseSkyColor)).lerp(this.envSand, this.sandstormBlend * 0.45);
    }
    // Ion storm: an electric-blue cast that flickers, plus a few crackling arcs over the field.
    this.ionBlend += ((env.ionstorm ? 1 : 0) - this.ionBlend) * 0.08;
    if (this.ionBlend > 0.01) {
      const flicker = 1 + Math.sin(performance.now() * 0.021) * 0.18 * this.ionBlend;
      if (fog && "density" in fog) {
        fog.color.lerp(this.envIon, this.ionBlend * 0.55);
        fog.density *= flicker;
      }
      if (this.scene.background instanceof THREE.Color) this.scene.background.lerp(this.envIon, this.ionBlend * 0.4);
      if (this.ionBlend > 0.3) {
        const halfW = arenaWidth() * 0.36;
        const halfD = arenaDepth() * 0.36;
        for (let k = 0; k < 3; k += 1) {
          const t = performance.now() * 0.004 + k * 2.3;
          const x = Math.sin(t * 1.7) * halfW;
          const z = Math.cos(t * 1.1) * halfD;
          const h = 3.2 + Math.sin(t * 6) * 1.6;
          const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x, 0, z),
            new THREE.Vector3(x + Math.sin(t * 11) * 0.5, h, z + Math.cos(t * 9) * 0.5),
          ]);
          const arc = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x9ad0ff, transparent: true, opacity: (0.4 + 0.5 * Math.abs(Math.sin(t * 7))) * this.ionBlend }));
          this.environmentRoot.add(arc);
        }
      }
    }
    // Burning ground: flickering fire ring + rising flame cones + an orange ground glow.
    const flicker = (Math.sin(performance.now() * 0.02) + 1) * 0.5;
    for (const burn of sim.burnZones) {
      const y = terrainHeightAt(burn) + 0.07;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(burn.radius - 0.25, burn.radius, 40),
        new THREE.MeshBasicMaterial({ color: 0xff6b1a, transparent: true, opacity: 0.35 + flicker * 0.3, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(burn.x, y, burn.z);
      this.environmentRoot.add(ring);
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(burn.radius * 0.9, 24),
        new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.12 + flicker * 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(burn.x, y - 0.02, burn.z);
      this.environmentRoot.add(glow);
      for (let f = 0; f < 4; f += 1) {
        const t = performance.now() * 0.003 + f * 1.7 + (hash(burn.id) % 10);
        const flame = new THREE.Mesh(
          projectileGeometry("rifle-tail"),
          projectileMaterial(`burn-flame-${f % 2}`, f % 2 ? 0xffb02e : 0xff6b1a, 0.55, true),
        );
        flame.position.set(
          burn.x + Math.sin(t) * burn.radius * 0.55,
          y + 0.25 + Math.abs(Math.sin(t * 2.3)) * 0.3,
          burn.z + Math.cos(t * 1.3) * burn.radius * 0.55,
        );
        flame.scale.set(2.2, 2.6 + Math.sin(t * 5) * 0.8, 2.2);
        this.environmentRoot.add(flame);
      }
    }
    // Friendly mines only — the enemy never sees yours until they step on one.
    const minePulse = Math.sin(performance.now() * 0.009) > 0.2;
    for (const mine of sim.mines) {
      if (mine.team !== "player") continue;
      const y = terrainHeightAt(mine) + 0.05;
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.26, 16),
        new THREE.MeshBasicMaterial({ color: 0x39434a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(mine.x, y, mine.z);
      this.environmentRoot.add(disc);
      if (minePulse) {
        const pip = new THREE.Mesh(
          projectileGeometry("ember"),
          projectileMaterial("mine-pip", 0xff3b30, 0.95, true),
        );
        pip.position.set(mine.x, y + 0.09, mine.z);
        pip.scale.setScalar(1.4);
        this.environmentRoot.add(pip);
      }
    }
    // Cash caches: a spinning gold diamond bobbing over a warm ground glow — "run over this for money".
    const cachePulse = (Math.sin(performance.now() * 0.005) + 1) * 0.5;
    for (const cache of sim.pickups) {
      const y = terrainHeightAt(cache) + 0.05;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.74, 32),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.26 + cachePulse * 0.24, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(cache.x, y, cache.z);
      this.environmentRoot.add(ring);
      const coin = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.26),
        new THREE.MeshStandardMaterial({ color: 0xffcf4d, emissive: 0xffb020, emissiveIntensity: 0.65, metalness: 0.75, roughness: 0.32 }),
      );
      coin.position.set(cache.x, y + 0.52 + cachePulse * 0.16, cache.z);
      coin.rotation.set(0.32, performance.now() * 0.0032, 0);
      this.environmentRoot.add(coin);
    }
    const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    for (const zone of env.zones) {
      const color = zone.kind === "barrage" ? 0xff5a3c : 0xffb24a;
      const y = terrainHeightAt(zone) + 0.07;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(zone.radius - 0.4, zone.radius, 72),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 + pulse * 0.42, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(zone.x, y, zone.z);
      this.environmentRoot.add(ring);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(zone.radius, 56),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06 + pulse * 0.05, side: THREE.DoubleSide, depthWrite: false }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(zone.x, y, zone.z);
      this.environmentRoot.add(disc);
    }
  }

  // Floating damage numbers that pop off a unit when it's hit during resolve, plus recording
  // the per-part hit so paintPart can flash it white. Reads the live turn report (resolve only);
  // already-spawned numbers keep rising/fading on their own into the next command phase.
  private syncDamageNumbers(sim: TacticalSim): void {
    const now = performance.now();
    const report = sim.currentTurnReport;
    if (report && report.entries.length) {
      const maxSeq = report.entries.reduce((m, e) => Math.max(m, damageSeqOf(e.id)), 0);
      if (maxSeq < this.lastDamageSeq) this.lastDamageSeq = 0; // a new battle reset the counter
      for (const entry of report.entries) {
        if (damageSeqOf(entry.id) <= this.lastDamageSeq) continue;
        this.spawnDamageNumber(sim, entry, now);
      }
      this.lastDamageSeq = Math.max(this.lastDamageSeq, maxSeq);
    }
    for (let i = this.floatingNumbers.length - 1; i >= 0; i -= 1) {
      const fn = this.floatingNumbers[i];
      const t = (now - fn.bornMs) / DAMAGE_NUMBER_MS;
      if (t >= 1) {
        (fn.sprite.material as THREE.SpriteMaterial).dispose();
        this.damageNumberRoot.remove(fn.sprite);
        this.floatingNumbers.splice(i, 1);
        continue;
      }
      const pop = 0.62 + Math.min(1, t * 6) * 0.3; // quick punch in, then hold
      fn.sprite.scale.set(fn.aspect * pop, pop, 1);
      fn.sprite.position.set(fn.origin.x, fn.baseHeight + 0.5 + t * 1.5, fn.origin.z);
      (fn.sprite.material as THREE.SpriteMaterial).opacity = clamp01(1.1 - t) * 0.96;
    }
  }

  private spawnDamageNumber(sim: TacticalSim, entry: { targetId: string; actorId?: string; partId: string; targetTeam: CombatEntity["team"]; amount: number; killed: boolean; destroyed: boolean }, now: number): void {
    const target = sim.entity(entry.targetId);
    if (!target) return;
    this.flashByPart.set(`${entry.targetId}:${entry.partId}`, now);
    // Record a whole-body flinch, shoved away from the shooter (or backward off the unit's own
    // facing when there's no attacker, e.g. a mine/burn tick). Bigger hits flinch harder.
    if (target.kind !== "cover") {
      const attacker = entry.actorId ? sim.entity(entry.actorId) : undefined;
      let dx = attacker && attacker.id !== target.id ? target.position.x - attacker.position.x : -Math.sin(target.yaw);
      let dz = attacker && attacker.id !== target.id ? target.position.z - attacker.position.z : -Math.cos(target.yaw);
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      this.flinchByEntity.set(entry.targetId, { at: now, mag: Math.min(1, entry.amount / 42), dx, dz });
    }
    // Cap concurrent numbers so a 40-unit splash melee can't spike draw calls — recycle the
    // oldest (the flash still records for every hit; you can't read 200 numbers anyway).
    while (this.floatingNumbers.length >= MAX_FLOATING_NUMBERS) {
      const oldest = this.floatingNumbers.shift();
      if (oldest) {
        (oldest.sprite.material as THREE.SpriteMaterial).dispose();
        this.damageNumberRoot.remove(oldest.sprite);
      }
    }
    // Red when our own units take damage (alarm), gold when we're dealing it to the enemy.
    const color = entry.targetTeam === "player" ? 0xff6b7a : entry.targetTeam === "enemy" ? 0xffd166 : 0xffbf69;
    // Serious military phrasing for a kill, by what died: personnel are K.I.A.,
    // vehicles/structures are DESTROYED, cover is DEMOLISHED.
    const text = entry.destroyed
      ? (isInfantryKind(target.kind) ? "K.I.A." : target.kind === "cover" ? "DEMOLISHED" : "DESTROYED")
      : entry.killed ? `${entry.amount}!` : `${entry.amount}`;
    const record = floatingNumberTexture(text, color);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: record.texture, transparent: true, opacity: 0.96, depthWrite: false, depthTest: false }));
    const baseHeight = target.elevation + target.height * 0.6;
    sprite.scale.set(record.aspect * 0.62, 0.62, 1);
    sprite.position.set(target.position.x, baseHeight + 0.5, target.position.z);
    this.damageNumberRoot.add(sprite);
    this.floatingNumbers.push({ sprite, bornMs: now, origin: { ...target.position }, baseHeight, aspect: record.aspect });
    this.debug.floatingLabels += 1;
  }

  // Flash strength [0..1] for a part hit in the last DAMAGE_FLASH_MS, decaying to 0.
  private partFlash(entityId: string, partId: string): number {
    const at = this.flashByPart.get(`${entityId}:${partId}`);
    if (at === undefined) return 0;
    const t = (performance.now() - at) / DAMAGE_FLASH_MS;
    return t >= 1 ? 0 : 1 - t;
  }

  // Hit-flinch impulse for an entity struck in the last FLINCH_MS: strength [0..1] (snappy
  // spring, peaks at the strike and settles fast) plus the normalized shove direction.
  private entityFlinch(entityId: string): { f: number; dx: number; dz: number } | undefined {
    const rec = this.flinchByEntity.get(entityId);
    if (!rec) return undefined;
    const t = (performance.now() - rec.at) / FLINCH_MS;
    if (t >= 1) return undefined;
    const decay = 1 - t;
    return { f: rec.mag * decay * decay, dx: rec.dx, dz: rec.dz };
  }

  // Dispose then detach every child of a per-frame / per-swap root, freeing GPU geometry
  // before the (cheap) JS objects are GC'd. Without this, every rebuild leaks buffers.
  private disposeAndClear(group: THREE.Group): void {
    disposeSubtree(group);
    group.clear();
  }

  // Content signature for the objective overlay (constant opacity, so no pulse term is needed):
  // it only needs to rebuild when a holder flips, a score/flag moves, or the mode changes.
  private objectivesSignature(sim: TacticalSim): string {
    const s = sim.modeState;
    if (sim.mode === "domination" && s.hills) {
      return `dom|${s.hillRadius}|${s.hills.map((h, i) => `${h.x.toFixed(1)},${h.z.toFixed(1)}:${s.hillHolders?.[i] ?? ""}`).join(";")}`;
    }
    if (sim.mode === "hill") return `hill|${s.hill.x.toFixed(1)},${s.hill.z.toFixed(1)}|${s.hillRadius}|${s.hillHolder ?? ""}`;
    if (sim.mode === "ctf") return `ctf|${s.flags.map((f) => `${f.team}:${f.pos.x.toFixed(1)},${f.pos.z.toFixed(1)}:${f.home.x.toFixed(1)},${f.home.z.toFixed(1)}`).join(";")}`;
    return "none";
  }

  // Flag poles (CTF) and the contested zone ring (Hold the Hill). Only rebuilt when the objective
  // state changes — static geometry with constant opacity, so nothing is lost by not rebuilding.
  private syncObjectives(sim: TacticalSim): void {
    const sig = this.objectivesSignature(sim);
    if (sig === this.lastObjectivesSig) return;
    this.lastObjectivesSig = sig;
    this.disposeAndClear(this.objectiveRoot);
    const s = sim.modeState;
    if (sim.mode === "domination" && s.hills) {
      const radius = Math.max(3.0, s.hillRadius * 0.8);
      s.hills.forEach((sector, index) => {
        const holder = s.hillHolders?.[index];
        const color = holder === "player" ? 0x6fd7ff : holder === "enemy" ? 0xff7c5e : 0xffe08a;
        const y = terrainHeightAt(sector);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(radius - 0.24, radius, 56),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(sector.x, y + 0.06, sector.z);
        this.objectiveRoot.add(ring);
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 40),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }),
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(sector.x, y + 0.04, sector.z);
        this.objectiveRoot.add(disc);
      });
      return;
    }
    if (sim.mode === "hill") {
      const color = s.hillHolder === "player" ? 0x6fd7ff : s.hillHolder === "enemy" ? 0xff7c5e : 0xffe08a;
      const y = terrainHeightAt(s.hill);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(s.hillRadius - 0.28, s.hillRadius, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.hill.x, y + 0.06, s.hill.z);
      this.objectiveRoot.add(ring);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(s.hillRadius, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(s.hill.x, y + 0.04, s.hill.z);
      this.objectiveRoot.add(disc);
    } else if (sim.mode === "ctf") {
      for (const flag of s.flags) {
        const color = flag.team === "player" ? 0x6fd7ff : 0xff7c5e;
        const pole = new THREE.Group();
        const mast = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.06, 1.8, 8),
          new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.3, roughness: 0.5 })
        );
        mast.position.y = 0.9;
        const cloth = new THREE.Mesh(
          new THREE.BoxGeometry(0.72, 0.46, 0.06),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45 })
        );
        cloth.position.set(0.42, 1.5, 0);
        pole.add(mast, cloth);
        pole.position.set(flag.pos.x, terrainHeightAt(flag.pos), flag.pos.z);
        this.objectiveRoot.add(pole);
        const homeRing = new THREE.Mesh(
          new THREE.RingGeometry(1.0, 1.2, 32),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })
        );
        homeRing.rotation.x = -Math.PI / 2;
        homeRing.position.set(flag.home.x, terrainHeightAt(flag.home) + 0.05, flag.home.z);
        this.objectiveRoot.add(homeRing);
      }
    }
  }

  debugState(): WorldRenderDebug {
    return {
      ...this.debug,
      ghostedEntities: [...this.debug.ghostedEntities],
    };
  }

  // The default cosmetic accent for the player's units (overridable per unit via entity.accent).
  setPlayerAccent(color: number): void {
    this.playerAccent = color;
  }

  // Colorblind support: swap the team read palette (blue vs orange) and rebuild every
  // entity group so build-time team glows repaint too.
  setHighContrastTeams(on: boolean): void {
    Object.assign(TEAMS, on ? TEAMS_HIGH_CONTRAST : TEAMS_DEFAULT);
    TEAMS.version += 1;
  }

  // Re-theme the whole scene for a map: fog, sky, ground, terrain, grid, and lights.
  applyMap(theme: MapTheme): void {
    this.baseFogColor = theme.fog;
    // New battlefield: the last battle's scars don't carry over.
    this.disposeAndClear(this.craterRoot);
    this.scorchedIds.clear();
    // The aura/objective overlays are now signature-gated — clear their roots and reset the cached
    // signatures so a new battle always rebuilds them (never keeps the prior battle's flags/rings).
    this.disposeAndClear(this.auraRoot);
    this.disposeAndClear(this.objectiveRoot);
    this.lastAurasSig = "";
    this.lastObjectivesSig = "";
    // Trimmed below the authored density: under the graded post stack the full value
    // dissolves the frame edges into a cream wash and units stop reading at distance.
    this.baseFogDensity = theme.fogDensity * 0.72;
    this.baseSkyColor = theme.sky;
    this.sandstormBlend = 0;
    this.scene.fog = new THREE.FogExp2(theme.fog, this.baseFogDensity);
    if (this.skyTexture) this.skyTexture.dispose();
    this.skyTexture = makeThemeSky(theme);
    this.scene.background = this.skyTexture;
    // A desaturated blend of the map's ground tones — what structural props get nudged toward.
    this.propTint = new THREE.Color(theme.ground).lerp(new THREE.Color(theme.groundAccent), 0.55);
    this.rebuildArena(theme);
    this.buildAmbient(theme.ambient);
  }

  // (Re)build the drifting ambient particle bed for the active map.
  private buildAmbient(spec?: AmbientSpec): void {
    if (this.ambientPoints) {
      this.scene.remove(this.ambientPoints);
      this.ambientPoints.geometry.dispose();
      (this.ambientPoints.material as THREE.Material).dispose();
      this.ambientPoints = null;
      this.ambientVel = null;
    }
    if (!spec) return;
    // Scale particle count with arena area (capped) so the enlarged maps keep their atmosphere
    // instead of looking sparse; ~2200 is the reference (pre-scale medium) area.
    const areaScale = Math.min(2.2, Math.max(0.7, (arenaWidth() * arenaDepth()) / 2200));
    const count = Math.max(40, Math.round((spec.density ?? 1) * 170 * areaScale));
    const positions = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const m = ambientMotion(spec.kind);
    const w = arenaWidth();
    const d = arenaDepth();
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = ARENA_BOUNDS.minX + Math.random() * w;
      positions[i * 3 + 1] = Math.random() * AMBIENT_CEIL;
      positions[i * 3 + 2] = ARENA_BOUNDS.minZ + Math.random() * d;
      vel[i * 3] = m.windX * (0.4 + Math.random());
      vel[i * 3 + 1] = m.vy * (0.6 + Math.random() * 0.8);
      vel[i * 3 + 2] = m.windZ * (0.4 + Math.random());
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: spec.color, size: m.size, transparent: true, opacity: m.opacity, depthWrite: false, sizeAttenuation: true });
    this.ambientPoints = new THREE.Points(geometry, material);
    this.ambientPoints.frustumCulled = false;
    this.ambientVel = vel;
    this.scene.add(this.ambientPoints);
  }

  // Drift the ambient particles each frame, wrapping them within the arena bounds.
  private syncAmbient(): void {
    if (!this.ambientPoints || !this.ambientVel) return;
    const now = performance.now();
    let dt = (now - this.ambientClock) / 1000;
    this.ambientClock = now;
    if (dt <= 0 || dt > 0.1) dt = 0.016; // first frame / tab-switch guard
    const attr = this.ambientPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const { minX, maxX, minZ, maxZ } = ARENA_BOUNDS;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += this.ambientVel[i] * dt;
      arr[i + 1] += this.ambientVel[i + 1] * dt;
      arr[i + 2] += this.ambientVel[i + 2] * dt;
      if (arr[i] > maxX) arr[i] = minX; else if (arr[i] < minX) arr[i] = maxX;
      if (arr[i + 2] > maxZ) arr[i + 2] = minZ; else if (arr[i + 2] < minZ) arr[i + 2] = maxZ;
      if (arr[i + 1] > AMBIENT_CEIL) arr[i + 1] = 0; else if (arr[i + 1] < 0) arr[i + 1] = AMBIENT_CEIL;
    }
    attr.needsUpdate = true;
  }

  private rebuildArena(theme: MapTheme): void {
    // Arena materials (floor/rails/panels/patches/grid/terrain blocks) are freshly built on
    // every map swap and never shared with the pooled caches, so dispose them too — the generic
    // disposeAndClear frees geometry only, which would leak a full set of materials per battle.
    this.sceneryRoot.traverse((node) => {
      const mat = (node as Partial<THREE.Mesh>).material;
      const list = mat ? (Array.isArray(mat) ? mat : [mat]) : [];
      for (const m of list) if (m && !m.userData?.shared) m.dispose();
    });
    this.disposeAndClear(this.sceneryRoot);
    const width = arenaWidth();
    const depth = arenaDepth();

    // Slightly darker than the authored ground tone so units (whose palette tops out
    // near-white) keep value separation from the floor under the warm key light.
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.18, depth),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.ground).multiplyScalar(0.86), roughness: 0.95, metalness: 0.02 })
    );
    floor.position.y = -0.11;
    floor.receiveShadow = true;
    this.sceneryRoot.add(floor);

    this.sceneryRoot.add(makeTerrainBlocks(theme.ground, theme.groundAccent));

    const grid = new THREE.GridHelper(width, Math.round(width), theme.grid, theme.grid);
    grid.position.y = 0.02;
    grid.scale.z = depth / width;
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
      material.opacity = 0.1;
      material.transparent = true;
    }
    this.sceneryRoot.add(grid);

    const railColor = new THREE.Color(theme.ground).multiplyScalar(0.55);
    const railMat = new THREE.MeshStandardMaterial({ color: railColor, roughness: 0.9, metalness: 0.05 });
    for (const [x, z, sx, sz] of [
      [0, ARENA_BOUNDS.minZ - 0.1, width + 0.4, 0.22],
      [0, ARENA_BOUNDS.maxZ + 0.1, width + 0.4, 0.22],
      [ARENA_BOUNDS.minX - 0.1, 0, 0.22, depth + 0.4],
      [ARENA_BOUNDS.maxX + 0.1, 0, 0.22, depth + 0.4],
    ] as const) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.34, sz), railMat);
      rail.position.set(x, 0.1, z);
      rail.castShadow = true;
      rail.receiveShadow = true;
      this.sceneryRoot.add(rail);
    }

    // A coarse grid of large, low-opacity deck panels tinted toward the map accent gives the
    // floor a tiled, map-themed feel without clutter (alternating tones, flat floor only).
    const panelLight = new THREE.Color(theme.ground).lerp(new THREE.Color(theme.groundAccent), 0.28);
    const panelDark = new THREE.Color(theme.ground).multiplyScalar(0.82);
    const panelMatLight = new THREE.MeshBasicMaterial({ color: panelLight, transparent: true, opacity: 0.22, depthWrite: false });
    const panelMatDark = new THREE.MeshBasicMaterial({ color: panelDark, transparent: true, opacity: 0.22, depthWrite: false });
    const cols = 6;
    const rows = 4;
    const tileW = width / cols;
    const tileD = depth / rows;
    const gap = 0.32;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x = ARENA_BOUNDS.minX + (c + 0.5) * tileW;
        const z = ARENA_BOUNDS.minZ + (r + 0.5) * tileD;
        if (terrainHeightAt({ x, z }) > 0.05) continue; // keep panels on the flat floor
        const panel = new THREE.Mesh(
          new THREE.PlaneGeometry(tileW - gap, tileD - gap),
          (c + r) % 2 === 0 ? panelMatLight : panelMatDark,
        );
        panel.rotation.x = -Math.PI / 2;
        panel.position.set(x, 0.008, z);
        this.sceneryRoot.add(panel);
      }
    }

    // Deterministic ground-accent patches give the floor texture without clutter.
    const patchMat = new THREE.MeshBasicMaterial({ color: theme.groundAccent, transparent: true, opacity: 0.16, depthWrite: false });
    let seed = 1337;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < 28; i += 1) {
      const x = ARENA_BOUNDS.minX + rand() * width;
      const z = ARENA_BOUNDS.minZ + rand() * depth;
      const r = 0.8 + rand() * 1.9;
      // Keep ground texture patches on the flat floor so they never float over a block edge.
      if (terrainHeightAt({ x, z }) > 0.05) continue;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 20), patchMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, 0.014, z);
      this.sceneryRoot.add(disc);
    }

    // Team-tint fill at each base end. Range tracks arena width so the glow still reaches toward
    // the centre on the enlarged maps instead of pooling at the corners.
    const fillRange = Math.max(12, arenaWidth() * 0.42);
    const playerLight = new THREE.PointLight(theme.playerLight, 0.7, fillRange);
    playerLight.position.set(ARENA_BOUNDS.minX + 6, 4, 0);
    const enemyLight = new THREE.PointLight(theme.enemyLight, 0.7, fillRange);
    enemyLight.position.set(ARENA_BOUNDS.maxX - 6, 4, 0);
    this.sceneryRoot.add(playerLight, enemyLight);
  }


  private computeGhostedEntities(sim: TacticalSim, targetId: string | undefined, targetPartId: string | undefined, camera: THREE.Camera | undefined): Set<string> {
    const ghosted = new Set<string>();
    if (!camera) return ghosted;

    const cameraPoint = { x: camera.position.x, z: camera.position.z };
    const important: Vec2[] = [];
    for (const projectile of sim.projectiles.slice(0, 6)) important.push(projectile.position);
    const preview = this.activePreview(sim, targetId, targetPartId);
    const target = preview ? sim.entity(targetId) : undefined;
    if (preview) important.push(preview.impactPoint);
    if (target?.status.alive) important.push(target.position);
    if (!important.length) return ghosted;

    for (const entity of sim.entities) {
      if (entity.kind !== "cover" || !entity.status.alive) continue;
      for (const point of important) {
        const progress = segmentProgress(entity.position, cameraPoint, point);
        if (progress <= 0.12 || progress >= 0.94) continue;
        if (dist(cameraPoint, entity.position) > dist(cameraPoint, point)) continue;
        const clearance = entity.radius + Math.max(0.35, entity.height * 0.16);
        if (pointToSegmentDistance(entity.position, cameraPoint, point) <= clearance) {
          ghosted.add(entity.id);
          break;
        }
      }
    }

    return ghosted;
  }

  private activePreview(sim: TacticalSim, targetId: string | undefined, targetPartId: string | undefined): ShotPreview | undefined {
    const actor = sim.selected;
    if (!actor || actor.team !== "player" || !targetId || !targetPartId || sim.phase !== "command") return undefined;
    return sim.intent === "grenade"
      ? sim.previewGrenade(actor.id, targetId, targetPartId)
      : sim.previewShot(actor.id, targetId, targetPartId);
  }

  private syncUnitMarkers(sim: TacticalSim): void {
    const pulse = (Math.sin(performance.now() * 0.008) + 1) * 0.5;
    const liveMarkerIds = new Set<string>();
    for (const entity of sim.entities) {
      if (entity.kind === "cover" || !entity.status.alive) continue;
      liveMarkerIds.add(entity.id);
      const color = entity.team === "player" ? (entity.accent ?? this.playerAccent) : entity.team === "enemy" ? TEAMS.enemyMarker : 0xf6d776;
      let marker = this.unitMarkers.get(entity.id);
      if (!marker) {
        marker = makeUnitMarker(entity, color);
        this.unitMarkers.set(entity.id, marker);
        this.markerRoot.add(marker);
      }
      updateUnitMarker(marker, entity, color, pulse);
      this.debug.unitMarkers += 1;
    }
    for (const [id, marker] of this.unitMarkers) {
      if (liveMarkerIds.has(id)) continue;
      disposeSubtree(marker);
      this.markerRoot.remove(marker);
      this.unitMarkers.delete(id);
    }
  }

  // Each gun/cannon round, on its first ~0.16s of flight, drives a recoil punch on the unit that
  // fired it. Grenades are thrown (no recoil). A rapid-firing unit gets a fresh punch per round.
  private computeRecoil(projectiles: readonly Projectile[]): void {
    this.recoilByActor.clear();
    for (const projectile of projectiles) {
      if (projectile.kind === "grenade") continue;
      const recoil = clamp01(1 - projectile.age / RECOIL_TIME);
      if (recoil <= 0) continue;
      if (recoil > (this.recoilByActor.get(projectile.actorId) ?? 0)) this.recoilByActor.set(projectile.actorId, recoil);
    }
  }

  private syncEntity(entity: CombatEntity, selectedId: string, targetId: string | undefined, targetPartId: string | undefined, defending: boolean, ghosted: boolean): void {
    let group = this.groups.get(entity.id);
    // Captured structures change team: rebuild so team-colored trim/glow follows the flag.
    if (group && group.userData.team !== entity.team) {
      disposeSubtree(group);
      this.entityRoot.remove(group);
      this.groups.delete(entity.id);
      group = undefined;
    }
    if (!group) {
      group = this.buildEntity(entity);
      group.userData.team = entity.team;
      this.groups.set(entity.id, group);
      this.entityRoot.add(group);
    }
    group.userData.ghosted = ghosted;
    group.visible = entity.status.alive;
    const previousPosition = group.userData.previousPosition as Vec2 | undefined;
    const moved = previousPosition ? dist(previousPosition, entity.position) : 0;
    const moving = entity.kind !== "cover" && moved > 0.001;
    const motionTime = (group.userData.motionTime as number | undefined ?? 0) + (moving ? moved * 2.4 : 0);
    group.userData.previousPosition = { ...entity.position };
    group.userData.motionTime = motionTime;
    group.userData.moving = moving;
    // Ease a 0..1 walk weight so locomotion (limb swing, bob, lean) blends in and out instead of
    // popping to the idle pose in a single frame when a unit starts/stops.
    const walkWeight = ((group.userData.walkWeight as number | undefined) ?? 0) + ((moving ? 1 : 0) - ((group.userData.walkWeight as number | undefined) ?? 0)) * 0.2;
    group.userData.walkWeight = walkWeight;
    group.userData.recoil = this.recoilByActor.get(entity.id) ?? 0;
    // Rolling vehicles kick up a dust wake behind their tracks.
    if (moving && isVehicleKind(entity.kind)) {
      const lastDust = (group.userData.lastDustAt as number | undefined) ?? 0;
      if (motionTime - lastDust > 0.6) {
        group.userData.lastDustAt = motionTime;
        const rear = {
          x: entity.position.x - Math.sin(entity.yaw) * entity.radius * 0.9,
          z: entity.position.z - Math.cos(entity.yaw) * entity.radius * 0.9,
        };
        this.spawnSmokeColumn(rear, 2, this.propTint.getHex(), 0.3, 1.1, entity.elevation + 0.1);
      }
    }
    // Wrecks (and a killed base) smolder: a lazy wisp every ~1.5s keeps battle damage
    // reading as fresh instead of static scenery.
    const smolders = (entity.kind === "cover" && entity.coverKind === "wreck" && entity.status.alive) ||
      (!entity.status.alive && entity.kind === "base");
    if (smolders) {
      const now = performance.now();
      const lastSmolder = (group.userData.lastSmolderAt as number | undefined) ?? 0;
      if (now - lastSmolder > 1500) {
        group.userData.lastSmolderAt = now;
        this.spawnSmokeColumn(entity.position, 1, 0x25211d, 0.3, 1.9, entity.elevation + entity.height * 0.45);
      }
    }
    // Body rises on each footfall (two per stride) for a walking bounce, locked to distance.
    // Pelvis bob: highest at midstance (a leg planted under the body), lowest at the split — two
    // rises per stride. The old |sin| peaked at the split, which read as a floaty inverted bounce.
    const bob = isInfantryKind(entity.kind) ? (0.5 + 0.5 * Math.cos(motionTime * 1.6 * 2)) * 0.05 * walkWeight : 0;
    // Ease the rendered ground height so stepping on/off cover or terrain ledges glides
    // instead of snapping.
    const prevElevation = group.userData.renderElevation as number | undefined;
    const renderElevation = prevElevation === undefined ? entity.elevation : prevElevation + (entity.elevation - prevElevation) * 0.2;
    group.userData.renderElevation = renderElevation;
    group.position.set(entity.position.x, renderElevation + bob, entity.position.z);
    group.rotation.set(
      isInfantryKind(entity.kind) ? 0.06 * walkWeight : 0,
      entity.yaw,
      entity.kind === "tank" ? Math.sin(motionTime * 4.8) * 0.018 * walkWeight : 0
    );
    if (defending && isInfantryKind(entity.kind) && entity.status.alive) {
      group.scale.set(1.08, 1, 1.08);
    } else {
      group.scale.setScalar(entity.status.alive ? 1 : 0.94);
    }
    // Flyers hover: a gentle idle bob + pitch so an airborne unit never sits dead-still in the sky.
    if (entity.flying && entity.status.alive) {
      const t = performance.now() * 0.0018 + (hash(entity.id) % 63);
      group.position.y += Math.sin(t) * 0.18;
      group.rotation.x += Math.sin(t * 0.8) * 0.03;
    }
    // Hit flinch: the struck unit lurches away from the shooter with a quick pitch + roll
    // shudder and a brief downward absorb, so a landed hit reads as a physical reaction.
    const flinch = entity.status.alive && entity.kind !== "cover" ? this.entityFlinch(entity.id) : undefined;
    if (flinch) {
      const kindScale = isVehicleKind(entity.kind) ? 0.4 : isInfantryKind(entity.kind) ? 1 : 0.6;
      const s = flinch.f * kindScale;
      group.position.x += flinch.dx * s * 0.16;
      group.position.z += flinch.dz * s * 0.16;
      group.position.y -= s * 0.04;
      group.rotation.x += s * 0.12;
      group.rotation.z += Math.sin(performance.now() * 0.075) * s * 0.05;
    }
    const renderGhosted = ghosted;
    if (group.userData.glb) {
      // Whole-vehicle recoil kick for model-based units (no per-part weapon mesh to punch).
      const recoil = (group.userData.recoil as number | undefined) ?? 0;
      if (recoil > 0 && entity.status.alive) {
        group.position.x -= Math.sin(entity.yaw) * recoil * 0.14;
        group.position.z -= Math.cos(entity.yaw) * recoil * 0.14;
        group.rotation.x -= recoil * 0.02;
      }
    }
    // One id->part map per entity per frame instead of a parts.find per part MESH —
    // paintPart runs for ~20 meshes on an 8-part unit, so the linear scans added up.
    _partById.clear();
    for (const part of entity.parts) _partById.set(part.id, part);
    group.traverse((object) => {
      if (!("isMesh" in object)) return;
      const mesh = object as PartMesh;
      const partId = mesh.userData.partId as string | undefined;
      if (!partId) return;
      const part = _partById.get(partId);
      if (!part) return;
      this.syncDebris(entity, part);
      if (mesh.userData.pickProxy) {
        // Invisible raycast box over a GLB region — pickable, never painted.
        if (entity.status.alive) this.pickables.push(mesh);
        return;
      }
      this.paintPart(mesh, entity, part, entity.id === selectedId, entity.id === targetId, part.id === targetPartId, renderGhosted);
      if (entity.status.alive) this.pickables.push(mesh);
    });
    if (group.userData.glb) this.paintModel(group, entity, entity.id === selectedId, entity.id === targetId, renderGhosted);
  }

  private syncDebris(entity: CombatEntity, part: DamagePart): void {
    const key = `${entity.id}:${part.id}`;
    if (part.hp > 0) {
      this.destroyedPartKeys.delete(key);
      return;
    }
    if (this.destroyedPartKeys.has(key)) return;
    this.destroyedPartKeys.add(key);
    this.spawnDebris(entity, part);
  }

  private buildEntity(entity: CombatEntity): THREE.Group {
    const model = this.buildFromModel(entity);
    if (model) {
      if (entity.kind !== "cover") model.add(makeContactShadow(entity.radius));
      return model;
    }
    const group = new THREE.Group();
    group.userData.entityId = entity.id;
    if (entity.kind === "gunship") this.buildGunship(group, entity);
    else if (entity.kind === "flak") this.buildFlak(group, entity);
    else if (isVehicleKind(entity.kind)) this.buildTank(group, entity);
    if (isInfantryKind(entity.kind)) this.buildSoldier(group, entity);
    if (entity.kind === "base") this.buildBase(group, entity);
    if (isDefenseKind(entity.kind)) this.buildDefense(group, entity);
    if (entity.kind === "cover") this.buildCover(group, entity);
    // Flyers add their own ground shadow (dropped to terrain level) in buildGunship; everyone else
    // gets a contact shadow at their feet.
    if (entity.kind !== "cover" && !entity.flying) group.add(makeContactShadow(entity.radius));
    return group;
  }

  // Try the Meshy GLB for this entity kind; null (not loaded / no mapping) keeps the
  // procedural builder in charge. Infantry, walls, and glow-signal props are always
  // procedural — their walk cycle / parametric height / gameplay glow is the point.
  private buildFromModel(entity: CombatEntity): THREE.Group | null {
    const key = modelKeyFor(entity);
    if (!key) return null;
    const group = instantiate(key);
    if (!group) return null;
    group.userData.entityId = entity.id;
    group.userData.glb = true;
    if (entity.kind === "cover") {
      this.tintModelToMap(group);
      this.interactionGlow(group, entity, entity.parts[0]?.role === "volatile");
    } else {
      this.addModelAccents(group, entity);
    }
    this.addPickProxies(group, entity);
    return group;
  }

  // Team-colored emissive trim (roof light bar + side strips) so a weathered GLB still
  // reads player-cyan vs enemy-red at tactics camera distance — the same accent language
  // the procedural units use.
  private addModelAccents(group: THREE.Group, entity: CombatEntity): void {
    if (entity.team === "neutral") return;
    const color = entity.team === "enemy" ? TEAMS.enemyAccent : (entity.accent ?? this.playerAccent);
    const dims = group.userData.dims as THREE.Vector3;
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.85, roughness: 0.4, metalness: 0.1 });
    mat.userData.shared = false;
    // Roof-mounted only: flank strips either z-fight (embedded in the hull surface) or
    // float in mid-air, because the bbox doesn't follow the hull's actual profile. A light
    // bar + a small beacon above the silhouette are always safely clear of the mesh.
    const bar = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.32, dims.x * 0.22), 0.07, 0.07), mat);
    bar.position.set(0, dims.y + 0.06, -dims.z * 0.16);
    bar.userData.decor = true;
    group.add(bar);
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), mat);
    beacon.position.set(0, dims.y + 0.06, dims.z * 0.2);
    beacon.userData.decor = true;
    group.add(beacon);
    group.userData.accentMaterial = mat; // paintModel pulses it like a running light
  }

  // Nudge a GLB prop's albedo toward the map palette (mirror of tintPropToMap, but on the
  // clone's material records so per-frame damage tinting keeps the tint as its base).
  private tintModelToMap(group: THREE.Group, amount = 0.38): void {
    const mats = group.userData.glbMaterials as { material: THREE.MeshStandardMaterial; base: number }[] | undefined;
    if (!mats) return;
    for (const record of mats) {
      const tinted = new THREE.Color(record.base).lerp(this.propTint, amount);
      record.material.color.copy(tinted);
      record.base = tinted.getHex();
    }
  }

  // Invisible raycast boxes standing in for the procedural part meshes, so part-aiming,
  // hover and the vision overlay keep working over a single-skin GLB.
  private addPickProxies(group: THREE.Group, entity: CombatEntity): void {
    const dims = group.userData.dims as THREE.Vector3;
    const layout: [string, [number, number, number], [number, number, number]][] =
      entity.kind === "cover"
        ? [[entity.parts[0]?.id ?? "wall", [dims.x, dims.y, dims.z], [0, dims.y / 2, 0]]]
        : PICK_PROXY_LAYOUTS[entity.kind] ?? [];
    for (const [partId, size, pos] of layout) {
      if (!entity.parts.some((p) => p.id === partId)) continue;
      const proxy = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), pickProxyMaterial());
      proxy.position.set(pos[0], pos[1], pos[2]);
      proxy.userData.entityId = entity.id;
      proxy.userData.partId = partId;
      proxy.userData.pickProxy = true;
      proxy.visible = false; // raycaster tests invisible meshes; renderer never draws them
      proxy.castShadow = false;
      proxy.receiveShadow = false;
      group.add(proxy);
    }
  }

  // Per-frame tint/feedback for GLB entities: damage char, death darkening, selection /
  // target / hit-flash cues and ghosting — the coarse-grained sibling of paintPart.
  private paintModel(group: THREE.Group, entity: CombatEntity, selected: boolean, targeted: boolean, ghosted: boolean): void {
    const mats = group.userData.glbMaterials as { material: THREE.MeshStandardMaterial; base: number }[] | undefined;
    if (!mats) return;
    // Running-light pulse on the team accent trim — parked armor still reads alive.
    const accentMat = group.userData.accentMaterial as THREE.MeshStandardMaterial | undefined;
    if (accentMat) {
      accentMat.emissiveIntensity = entity.status.alive
        ? 0.6 + (Math.sin(performance.now() * 0.0035 + (hash(entity.id) % 63)) + 1) * 0.22
        : 0;
    }
    let totalHp = 0;
    let totalMax = 0;
    let flash = 0;
    for (const part of entity.parts) {
      totalHp += part.hp;
      totalMax += part.maxHp;
      flash = Math.max(flash, this.partFlash(entity.id, part.id));
    }
    const injury = 1 - clamp01(totalHp / Math.max(1, totalMax));
    const alive = entity.status.alive;
    const unitGlow = entity.kind !== "cover" && entity.team !== "neutral";
    const glowColor = entity.team === "enemy" ? TEAMS.enemyGlowDim : TEAMS.playerGlowDim;
    for (const record of mats) {
      const material = record.material;
      const color = _paintColor.set(record.base).lerp(_paintTmp.set(0x33120f), injury * 0.5);
      if (!alive) color.lerp(_paintTmp.set(0x08090a), 0.55);
      if (selected && alive) color.lerp(_paintTmp.set(0xffffff), 0.14);
      if (targeted && alive) color.lerp(_paintTmp.set(0xffd166), 0.26);
      if (flash > 0 && alive) color.lerp(_paintTmp.set(0xffffff), flash * 0.55);
      material.color.copy(color);
      if (flash > 0 && alive) {
        material.emissive.setHex(0xffffff);
        material.emissiveIntensity = 0.35 + flash * 0.5;
      } else if (alive && (selected || targeted)) {
        material.emissive.setHex(targeted ? 0x4f3000 : 0x0b3844);
        material.emissiveIntensity = targeted ? 0.4 : 0.5;
      } else if (alive && unitGlow) {
        material.emissive.setHex(glowColor);
        material.emissiveIntensity = 0.18 + injury * 0.1;
      } else {
        material.emissive.setHex(0x000000);
        material.emissiveIntensity = 0;
      }
      material.transparent = ghosted && alive;
      material.opacity = ghosted && alive ? (targeted ? 0.48 : 0.34) : 1;
      material.depthWrite = !(ghosted && alive);
    }
  }

  private buildTank(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x50d7ff;
    const factionPanel = entity.team === "enemy" ? 0x6a2722 : 0x123f55;
    // Shared chassis: hull, sloped front plate, treads, road wheels, exhausts.
    this.box(group, entity, "hull", [2.35, 0.72, 1.35], [0, 0.58, 0], 0x6fb7d7);
    this.box(group, entity, "hull", [1.86, 0.16, 1.5], [0, 0.98, -0.02], 0x28474f, { metalness: 0.16 });
    this.box(group, entity, "hull", [0.16, 0.18, 1.42], [-0.86, 1.12, -0.04], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.12 });
    this.box(group, entity, "hull", [0.16, 0.18, 1.42], [0.86, 1.12, -0.04], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.12 });
    this.box(group, entity, "front-plate", [2.28, 0.5, 0.22], [0, 0.68, 0.82], 0xc0cdc9);
    this.box(group, entity, "front-plate", [0.54, 0.18, 0.12], [-0.62, 0.83, 1.0], 0xfff4ca, { emissive: factionGlow, emissiveIntensity: 0.36 });
    this.box(group, entity, "front-plate", [0.54, 0.18, 0.12], [0.62, 0.83, 1.0], 0xfff4ca, { emissive: factionGlow, emissiveIntensity: 0.36 });
    this.box(group, entity, "left-tread", [0.34, 0.5, 1.72], [-1.32, 0.32, 0], 0x22282a);
    this.box(group, entity, "right-tread", [0.34, 0.5, 1.72], [1.32, 0.32, 0], 0x22282a);
    for (const side of [-1, 1]) {
      for (const z of [-0.58, 0, 0.58]) {
        this.cylinder(group, entity, side < 0 ? "left-tread" : "right-tread", 0.28, 0.16, [side * 1.36, 0.32, z], 0x0d1112);
      }
    }
    this.box(group, entity, "hull", [0.18, 0.22, 0.44], [-0.44, 0.86, -0.88], 0x151b1d, { emissive: 0xff7d26, emissiveIntensity: 0.18 });
    this.box(group, entity, "hull", [0.18, 0.22, 0.44], [0.44, 0.86, -0.88], 0x151b1d, { emissive: 0xff7d26, emissiveIntensity: 0.18 });
    // Armored side skirts shielding the upper track run (all tracked hulls share them).
    this.box(group, entity, "left-tread", [0.12, 0.36, 1.58], [-1.18, 0.6, 0], 0x2a3236, { metalness: 0.24 });
    this.box(group, entity, "right-tread", [0.12, 0.36, 1.58], [1.18, 0.6, 0], 0x2a3236, { metalness: 0.24 });

    if (entity.kind === "apc") {
      // Turretless boxy troop carrier: tall angular compartment, roof hatch, side vision
      // slits, and only a small cupola autogun — clearly not a gun tank.
      this.box(group, entity, "hull", [1.96, 0.74, 1.44], [0, 1.18, -0.06], 0x5a93ad, { metalness: 0.12 });
      this.box(group, entity, "front-plate", [1.86, 0.66, 0.2], [0, 1.12, 0.6], 0x9fb0ac, { metalness: 0.12 });
      this.box(group, entity, "hull", [1.6, 0.12, 1.18], [0, 1.58, -0.06], 0x274550, { metalness: 0.18 });
      this.box(group, entity, "turret", [0.62, 0.34, 0.7], [0, 1.66, 0.08], 0x46606e, { metalness: 0.2 });
      this.box(group, entity, "cannon", [0.14, 0.14, 0.78], [0.16, 1.78, 0.46], 0xd9e6df, { metalness: 0.3 });
      this.box(group, entity, "cannon", [0.2, 0.18, 0.14], [0.16, 1.78, 0.86], 0xffffff, { emissive: factionGlow, emissiveIntensity: 0.32 });
      for (const z of [-0.42, 0.06, 0.54]) {
        this.box(group, entity, "hull", [0.05, 0.22, 0.2], [0.99, 1.16, z], 0x121a1e, { emissive: factionGlow, emissiveIntensity: 0.18 });
        this.box(group, entity, "hull", [0.05, 0.22, 0.2], [-0.99, 1.16, z], 0x121a1e, { emissive: factionGlow, emissiveIntensity: 0.18 });
      }
      this.box(group, entity, "hull", [1.2, 0.5, 0.12], [0, 1.1, -0.78], 0x3a5563, { emissive: factionGlow, emissiveIntensity: 0.16 }); // rear troop ramp
      // Mudguard fenders front and rear, roof stowage, and a tall whip antenna.
      for (const side of [-1, 1]) {
        this.box(group, entity, side < 0 ? "left-tread" : "right-tread", [0.42, 0.1, 0.5], [side * 1.3, 0.62, 0.78], 0x20262a, { metalness: 0.2 });
        this.box(group, entity, side < 0 ? "left-tread" : "right-tread", [0.42, 0.1, 0.5], [side * 1.3, 0.62, -0.78], 0x20262a, { metalness: 0.2 });
      }
      this.box(group, entity, "hull", [0.5, 0.2, 0.5], [-0.74, 1.62, -0.52], 0x6a5a36, { accent: true });
      this.cylinder(group, entity, "turret", 0.028, 0.95, [0.86, 2.1, -0.52], 0xdfeaf2, [0, 0, 0], { accent: true, emissive: factionGlow, emissiveIntensity: 0.4 });
      this.box(group, entity, "turret", [0.08, 0.08, 0.08], [0.86, 2.56, -0.52], 0x9dfcff, { accent: true, emissive: factionGlow, emissiveIntensity: 0.85 });
      return;
    }

    // Tank / artillery: a real turret with a long main gun.
    this.box(group, entity, "turret", [1.08, 0.44, 0.86], [0, 1.12, 0.04], 0x5ba2c5);
    this.box(group, entity, "turret", [0.78, 0.16, 0.56], [0, 1.42, -0.08], 0x25444d, { metalness: 0.2 });
    this.box(group, entity, "cannon", [0.24, 0.24, 1.45], [0, 1.16, 1.03], 0xd9e6df, { metalness: 0.35 });
    this.box(group, entity, "cannon", [0.36, 0.34, 0.22], [0, 1.16, 1.8], 0xffffff, { emissive: 0x88ecff, emissiveIntensity: 0.28 });
    this.box(group, entity, "cannon", [0.42, 0.1, 0.16], [0, 1.32, 0.52], 0x121617, { metalness: 0.36 });
    this.box(group, entity, "turret", [0.44, 0.16, 0.18], [-0.58, 1.34, -0.16], 0xdaf7ff, { emissive: 0x50d7ff, emissiveIntensity: 0.4 });
    this.box(group, entity, "turret", [0.44, 0.16, 0.18], [0.58, 1.34, -0.16], 0xdaf7ff, { emissive: 0x50d7ff, emissiveIntensity: 0.4 });
    this.box(group, entity, "turret", [0.08, 0.58, 0.08], [-0.46, 1.72, -0.32], 0x0d1112, { metalness: 0.28 });
    this.box(group, entity, "turret", [0.28, 0.08, 0.08], [-0.46, 2.03, -0.32], 0xdaf7ff, { emissive: factionGlow, emissiveIntensity: 0.5 });
    if (entity.kind === "artillery") {
      // Siege gun: extra-long barrel with a slotted muzzle brake, hydraulic recoil
      // cylinders alongside the breech, a recoil spade, and rear outrigger legs.
      this.box(group, entity, "cannon", [0.26, 0.26, 1.7], [0, 1.3, 1.95], 0xb8c4bd, { metalness: 0.42 });
      this.box(group, entity, "cannon", [0.4, 0.4, 0.34], [0, 1.3, 2.84], 0x14181a, { accent: true, metalness: 0.4 });
      this.box(group, entity, "cannon", [0.5, 0.12, 0.12], [0, 1.3, 2.84], 0x0a0d0e, { accent: true });
      for (const x of [-0.18, 0.18]) this.cylinder(group, entity, "cannon", 0.08, 0.66, [x, 1.36, 0.95], 0x3a4042, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.4 });
      this.box(group, entity, "cannon", [0.4, 0.16, 0.5], [0, 1.16, 0.2], 0x2a3133, { metalness: 0.3 });
      this.box(group, entity, "hull", [0.5, 0.16, 0.9], [0, 0.32, -1.1], 0x2a3133, { metalness: 0.2 });
      for (const x of [-1, 1]) this.box(group, entity, "hull", [0.16, 0.16, 0.8], [x * 0.66, 0.28, -1.05], 0x2a3133, { accent: true });
    } else {
      // Tank: commander cupola + glowing periscope, a coaxial MG, a slotted muzzle brake,
      // and a turret-rear stowage bustle — clearly the gun tank, not the carriage gun.
      this.box(group, entity, "turret", [0.34, 0.2, 0.34], [0.36, 1.42, -0.08], 0x1c2428, { accent: true, metalness: 0.3 });
      this.box(group, entity, "turret", [0.12, 0.12, 0.12], [0.36, 1.57, 0.02], 0x8df0ff, { accent: true, emissive: 0x50d7ff, emissiveIntensity: 0.85 });
      this.box(group, entity, "cannon", [0.1, 0.12, 0.5], [0.27, 1.34, 0.72], 0x14181a, { accent: true, metalness: 0.34 });
      this.box(group, entity, "cannon", [0.34, 0.34, 0.26], [0, 1.16, 1.66], 0x14181a, { accent: true, metalness: 0.4 });
      this.box(group, entity, "turret", [0.72, 0.2, 0.32], [0, 1.12, -0.46], 0x6a5a36, { accent: true });
    }
  }

  // Attack gunship: sleek fuselage, a spinning main rotor + tail rotor, a chin autocannon, an
  // underslung bomb rack, and a ground shadow dropped to the terrain so it reads as airborne.
  private buildGunship(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x50d7ff;
    const factionPanel = entity.team === "enemy" ? 0x6a2722 : 0x123f55;
    this.box(group, entity, "hull", [1.0, 0.58, 2.0], [0, 0, 0], 0x5a93ad, { metalness: 0.22 });        // body
    this.box(group, entity, "hull", [0.72, 0.4, 0.8], [0, 0.16, 0.72], 0x9fc0d0, { metalness: 0.22 });   // cockpit
    this.box(group, entity, "hull", [0.3, 0.28, 1.4], [0, 0.06, -1.25], 0x466070, { metalness: 0.2 });   // tail boom
    this.box(group, entity, "hull", [0.5, 0.34, 0.12], [0, 0.28, -1.85], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.22 }); // tail fin
    // Main rotor (mobility): a mast + two crossed blades — spun each frame in syncEntity.
    this.cylinder(group, entity, "rotor", 0.06, 0.4, [0, 0.5, 0.05], 0x2a3236);
    this.box(group, entity, "rotor", [3.0, 0.04, 0.16], [0, 0.7, 0.05], 0x14181a);
    this.box(group, entity, "rotor", [0.16, 0.04, 3.0], [0, 0.7, 0.05], 0x14181a);
    this.box(group, entity, "rotor", [0.06, 0.72, 0.06], [0.2, 0.06, -1.9], 0x14181a);                    // tail rotor
    // Chin autocannon (weapon).
    this.box(group, entity, "gun", [0.26, 0.26, 0.7], [0, -0.3, 0.92], 0xd9e6df, { metalness: 0.35 });
    this.box(group, entity, "gun", [0.32, 0.32, 0.16], [0, -0.3, 1.32], 0xffffff, { emissive: factionGlow, emissiveIntensity: 0.4 });
    // Bomb rack (pack/volatile).
    this.box(group, entity, "pack", [0.72, 0.16, 0.95], [0, -0.44, -0.05], 0x3a4042, { metalness: 0.22 });
    for (const x of [-0.24, 0.24]) this.box(group, entity, "pack", [0.16, 0.3, 0.55], [x, -0.58, -0.05], 0xffb02e, { emissive: 0xff7d26, emissiveIntensity: 0.32 });
    for (const x of [-0.42, 0.42]) this.box(group, entity, "hull", [0.06, 0.06, 1.3], [x, -0.52, 0.1], 0x2a3236); // skids
    const shadow = makeContactShadow(entity.radius * 1.25);
    shadow.position.y = -(entity.agl ?? 6); // drop the shadow to the terrain directly below
    group.add(shadow);
  }

  // Flak Track: a low tracked chassis with an elevated multi-barrel AA gun that visibly points UP,
  // plus a tracking-radar dish — reads clearly as "the thing that shoots the sky".
  private buildFlak(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x50d7ff;
    this.box(group, entity, "hull", [2.0, 0.55, 1.25], [0, 0.5, 0], 0x5a7a6a, { metalness: 0.16 });
    this.box(group, entity, "hull", [1.7, 0.16, 1.3], [0, 0.8, 0], 0x2a3a34, { metalness: 0.2 });
    this.box(group, entity, "left-tread", [0.3, 0.45, 1.62], [-1.1, 0.28, 0], 0x22282a);
    this.box(group, entity, "right-tread", [0.3, 0.45, 1.62], [1.1, 0.28, 0], 0x22282a);
    for (const side of [-1, 1]) for (const z of [-0.5, 0, 0.5]) this.cylinder(group, entity, side < 0 ? "left-tread" : "right-tread", 0.24, 0.14, [side * 1.12, 0.28, z], 0x0d1112);
    this.box(group, entity, "gun", [0.72, 0.42, 0.72], [0, 1.02, -0.08], 0x46606e, { metalness: 0.2 }); // gun mount
    for (const x of [-0.15, 0.15]) this.cylinder(group, entity, "gun", 0.07, 1.15, [x, 1.55, 0.15], 0xd9e6df, [0.95, 0, 0], { metalness: 0.35 }); // barrels angled up
    this.box(group, entity, "gun", [0.42, 0.16, 0.16], [0, 2.05, 0.6], 0xffffff, { emissive: factionGlow, emissiveIntensity: 0.42 }); // muzzle
    this.cylinder(group, entity, "radar", 0.05, 0.55, [-0.72, 1.2, -0.42], 0x3a4042);
    this.box(group, entity, "radar", [0.52, 0.5, 0.06], [-0.72, 1.6, -0.42], 0x8fb0c0, { emissive: factionGlow, emissiveIntensity: 0.22, rotation: [0.32, 0.42, 0], accent: true });
  }

  private buildSoldier(group: THREE.Group, entity: CombatEntity): void {
    const palette = infantryPalette(entity.kind);
    const bodyColor = palette.body;
    const trimColor = palette.trim;
    const packColor = palette.pack;
    const teamGlow = entity.team === "enemy" ? TEAMS.enemyAccent : TEAMS.playerAccentGlow;
    // --- Shaped trooper chassis: rounded armor over tapered limbs (shared by all kinds;
    // each kind's signature kit attaches on top at the same anchor heights as before). ---
    // Hip girdle + utility belt.
    this.box(group, entity, "legs", [0.4, 0.16, 0.28], [0, 0.5, 0], trimColor, { metalness: 0.16 });
    this.box(group, entity, "body", [0.46, 0.09, 0.32], [0, 0.6, 0], 0x1c2326, { metalness: 0.2 });
    // Armored torso barrel with an angled chest plate and a glowing core seam.
    this.cylinder(group, entity, "body", 0.24, 0.62, [0, 0.84, 0], bodyColor, [0, 0, 0], { emissive: teamGlow, emissiveIntensity: 0.08, radiusBottom: 0.27 });
    this.box(group, entity, "body", [0.4, 0.34, 0.1], [0, 0.99, 0.18], trimColor, { metalness: 0.3, rotation: [-0.16, 0, 0] });
    this.box(group, entity, "body", [0.12, 0.2, 0.05], [0, 0.98, 0.245], 0x10171a, { emissive: teamGlow, emissiveIntensity: 0.5, rotation: [-0.16, 0, 0] });
    // Collar ring + shoulder pauldrons hugging the torso line.
    this.cylinder(group, entity, "body", 0.13, 0.1, [0, 1.2, 0.01], trimColor, [0, 0, 0], { metalness: 0.24 });
    this.sphere(group, entity, "body", 0.105, [-0.33, 1.03, 0.02], 0x39434a, { metalness: 0.3, scaleY: 0.78 });
    this.sphere(group, entity, "body", 0.105, [0.33, 1.03, 0.02], 0x39434a, { metalness: 0.3, scaleY: 0.78 });
    // Rounded head with a glowing visor band; each kind's kit supplies its own helmet on top.
    this.sphere(group, entity, "head", 0.175, [0, 1.37, 0.02], 0xd8d2bd, { scaleY: 0.95 });
    this.box(group, entity, "head", [0.28, 0.085, 0.07], [0, 1.38, 0.17], 0x0c1418, { emissive: teamGlow, emissiveIntensity: 0.55 });
    if (entity.kind === "sniper") {
      // Marksman: extra-long bipod-steadied rifle, a fat glowing scope, and a camo ghillie
      // hood/cloak that ragged-edges the silhouette — clearly the patient long-range shooter.
      this.box(group, entity, "rifle", [0.13, 0.15, 1.54], [0.46, 0.95, 0.52], trimColor, { metalness: 0.34 });
      this.box(group, entity, "rifle", [0.22, 0.2, 0.28], [0.46, 1.08, 0.12], 0x12161a, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.5 });
      this.box(group, entity, "rifle", [0.1, 0.1, 0.12], [0.46, 1.13, -0.06], 0x8de4ff, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.95 });
      this.cylinder(group, entity, "rifle", 0.03, 0.44, [0.38, 0.74, 1.04], 0x14181a, [0.5, 0, 0.32], { metalness: 0.3 });
      this.cylinder(group, entity, "rifle", 0.03, 0.44, [0.54, 0.74, 1.04], 0x14181a, [0.5, 0, -0.32], { metalness: 0.3 });
      this.box(group, entity, "body", [0.66, 0.26, 0.52], [0, 1.05, -0.06], 0x55603c, { accent: true });
      this.box(group, entity, "body", [0.5, 0.5, 0.16], [0, 0.74, -0.34], 0x4c5436, { accent: true });
      for (const x of [-0.22, 0.04, 0.26]) this.box(group, entity, "body", [0.1, 0.2, 0.08], [x, 0.5, -0.36], 0x5d663f, { accent: true });
      this.box(group, entity, "head", [0.48, 0.22, 0.52], [0, 1.5, -0.05], 0x55603c, { accent: true });
      this.box(group, entity, "head", [0.5, 0.1, 0.14], [0, 1.44, 0.2], 0x0a1418, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.55 });
    } else if (entity.kind === "grenadier") {
      // Splash specialist: stubby fat-muzzled launcher, a bandolier of amber rounds across
      // the chest, more on the pack, and a round pot helmet.
      this.box(group, entity, "rifle", [0.28, 0.26, 0.78], [0.48, 0.93, 0.3], trimColor, { metalness: 0.2 });
      this.cylinder(group, entity, "rifle", 0.21, 0.2, [0.48, 0.93, 0.74], 0x2b2418, [0.5, 0, 0], { accent: true, emissive: 0xffb02e, emissiveIntensity: 0.42 });
      this.cylinder(group, entity, "body", 0.06, 0.94, [0, 0.86, 0.2], 0x2e2110, [0, 0, 0.72], { accent: true });
      for (const [x, y] of [[-0.2, 0.66], [0, 0.86], [0.2, 1.06]] as const) this.box(group, entity, "body", [0.12, 0.15, 0.12], [x, y, 0.25], 0xffb84a, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.4 });
      for (const x of [-0.16, 0, 0.16]) this.box(group, entity, "pack", [0.11, 0.16, 0.11], [x, 1.08, -0.42], 0xffca6b, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.35 });
      this.box(group, entity, "head", [0.46, 0.2, 0.46], [0, 1.5, 0.0], 0x5a4a22, { accent: true });
      this.box(group, entity, "head", [0.5, 0.09, 0.18], [0, 1.46, 0.22], 0x6a5626, { accent: true });
    } else if (entity.kind === "striker") {
      // Close-assault: a long glowing arc-blade, a buckler on the off arm, a shoulder
      // pauldron, and a sleek crested visor helm — aggressive and unmistakably melee.
      this.box(group, entity, "rifle", [0.1, 0.16, 1.28], [0.52, 0.86, 0.42], 0xe6dcff, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.72 });
      this.box(group, entity, "rifle", [0.16, 0.2, 0.22], [0.52, 0.92, -0.12], 0x2a2142, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.45 });
      this.box(group, entity, "body", [0.12, 0.6, 0.5], [-0.52, 0.86, 0.06], 0x3a2c5c, { accent: true });
      this.box(group, entity, "body", [0.08, 0.4, 0.1], [-0.58, 0.86, 0.06], 0xc6a8ff, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.6 });
      this.box(group, entity, "body", [0.3, 0.2, 0.36], [0.46, 1.14, 0.02], 0x4a3a72, { accent: true });
      this.box(group, entity, "head", [0.44, 0.34, 0.46], [0, 1.46, 0.0], 0x2a2142, { accent: true, metalness: 0.2 });
      this.box(group, entity, "head", [0.48, 0.08, 0.16], [0, 1.44, 0.22], 0xc6a8ff, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.8 });
      this.box(group, entity, "head", [0.1, 0.26, 0.12], [0, 1.7, -0.04], 0x6a4fae, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.5 });
    } else if (entity.kind === "heavy") {
      // Anchor: the widest, bulkiest frame, armor pauldrons, a drum-fed auto-cannon with an
      // ammo belt looping to a big glowing back drum, and a slab face-visor helmet.
      this.box(group, entity, "body", [0.58, 0.5, 0.42], [0, 0.92, 0.02], bodyColor, { metalness: 0.14, emissive: 0x401a08, emissiveIntensity: 0.12 });
      this.box(group, entity, "body", [0.7, 0.18, 0.46], [0, 1.14, 0.0], trimColor, { metalness: 0.18 });
      for (const x of [-0.4, 0.4]) this.box(group, entity, "body", [0.26, 0.22, 0.38], [x, 1.12, 0.02], 0x6a3a1c, { accent: true, metalness: 0.2 });
      this.box(group, entity, "rifle", [0.27, 0.27, 1.22], [0.54, 0.92, 0.46], 0x2b2f31, { metalness: 0.32 });
      this.cylinder(group, entity, "rifle", 0.26, 0.24, [0.54, 0.74, 0.5], 0x14181a, [0, 0, 0], { metalness: 0.3 });
      this.box(group, entity, "rifle", [0.34, 0.3, 0.22], [0.54, 0.92, 1.12], 0xffca6b, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.5 });
      for (let i = 0; i < 4; i++) this.box(group, entity, "rifle", [0.12, 0.09, 0.1], [0.34 - i * 0.07, 0.8 - i * 0.015, 0.18 - i * 0.13], 0xffca6b, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.3 });
      this.box(group, entity, "pack", [0.58, 0.56, 0.42], [0, 0.9, -0.38], 0xffb02e, { accent: true, emissive: 0xff6b1a, emissiveIntensity: 0.5 });
      this.box(group, entity, "pack", [0.64, 0.12, 0.48], [0, 1.2, -0.38], 0xfff0bf, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.6 });
      this.box(group, entity, "head", [0.5, 0.46, 0.48], [0, 1.36, 0.0], 0x7a4a2a, { accent: true, metalness: 0.18 });
      this.box(group, entity, "head", [0.54, 0.14, 0.16], [0, 1.36, 0.22], 0x141819, { accent: true, emissive: 0xffb02e, emissiveIntensity: 0.6 });
    } else if (entity.kind === "mortar") {
      // Indirect-fire team: long mortar tube slung high over the shoulder, a round olive
      // baseplate + folded bipod legs on the back, and a heavy olive-drab steel helmet.
      this.box(group, entity, "rifle", [0.16, 0.16, 0.44], [0.44, 0.94, 0.2], trimColor, { metalness: 0.2 });
      this.cylinder(group, entity, "rifle", 0.13, 1.1, [0.14, 1.2, -0.12], 0x2a2f31, [Math.PI * 0.32, 0, 0], { metalness: 0.34 });
      this.cylinder(group, entity, "rifle", 0.16, 0.12, [-0.06, 1.6, -0.42], 0xffd27a, [Math.PI * 0.32, 0, 0], { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.45 });
      this.cylinder(group, entity, "pack", 0.33, 0.08, [0, 1.0, -0.47], 0x4a4f33, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.3 });
      this.cylinder(group, entity, "pack", 0.12, 0.1, [0, 1.0, -0.52], 0x2c2f22, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.3 });
      for (const x of [-0.16, 0.16]) this.box(group, entity, "pack", [0.04, 0.62, 0.04], [x, 0.86, -0.5], 0x3a3f2c, { accent: true });
      this.box(group, entity, "head", [0.46, 0.22, 0.46], [0, 1.5, 0.0], 0x4a4f33, { accent: true, metalness: 0.16 });
      this.box(group, entity, "head", [0.5, 0.09, 0.18], [0, 1.45, 0.22], 0x3a3f28, { accent: true });
    } else if (entity.kind === "medic") {
      // Support: a clean white vest + helmet emblazoned with a bold red cross, a hip med
      // satchel, a glowing green heal vial, and only a small sidearm — reads as "help."
      this.box(group, entity, "rifle", [0.16, 0.16, 0.46], [0.45, 0.9, 0.24], 0xd8d2cf, { metalness: 0.2 });
      this.box(group, entity, "body", [0.5, 0.66, 0.06], [0, 0.86, 0.19], 0xf4f4f4, { accent: true });
      this.box(group, entity, "body", [0.18, 0.42, 0.05], [0, 0.9, 0.23], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.5 });
      this.box(group, entity, "body", [0.42, 0.16, 0.05], [0, 0.94, 0.23], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.5 });
      this.box(group, entity, "pack", [0.3, 0.3, 0.2], [0.36, 0.66, -0.04], 0xf0f0f0, { accent: true });
      this.box(group, entity, "pack", [0.14, 0.05, 0.05], [0.36, 0.7, 0.07], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.45 });
      this.box(group, entity, "pack", [0.05, 0.14, 0.05], [0.36, 0.7, 0.07], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.45 });
      this.box(group, entity, "body", [0.1, 0.16, 0.1], [-0.3, 0.7, 0.16], 0x9dffd0, { accent: true, emissive: 0x4ce0a0, emissiveIntensity: 0.7 });
      this.box(group, entity, "head", [0.46, 0.2, 0.46], [0, 1.5, 0.0], 0xf4f4f4, { accent: true });
      this.box(group, entity, "head", [0.1, 0.05, 0.16], [0, 1.52, 0.22], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.5 });
      this.box(group, entity, "head", [0.05, 0.14, 0.16], [0, 1.52, 0.22], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.5 });
    } else if (entity.kind === "scout") {
      // Light recon: stubby carbine, chest binoculars with glowing green lenses, a tall whip
      // antenna with a blinking tip, and a soft beret with goggles — the leanest silhouette.
      this.box(group, entity, "rifle", [0.13, 0.14, 0.6], [0.46, 0.95, 0.22], trimColor, { metalness: 0.22 });
      this.box(group, entity, "body", [0.28, 0.14, 0.12], [0, 1.0, 0.22], 0x1c2a24, { accent: true });
      for (const x of [-0.09, 0.09]) this.cylinder(group, entity, "body", 0.05, 0.07, [x, 1.0, 0.3], 0x9dffcf, [Math.PI / 2, 0, 0], { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.85 });
      this.cylinder(group, entity, "pack", 0.028, 0.95, [-0.2, 1.42, -0.34], 0xdaf7e6, [0, 0, 0], { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.5 });
      this.box(group, entity, "pack", [0.08, 0.08, 0.08], [-0.2, 1.92, -0.34], 0x9dffcf, { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.95 });
      this.box(group, entity, "head", [0.44, 0.14, 0.42], [0, 1.5, 0.0], 0x2f6e4a, { accent: true });
      this.box(group, entity, "head", [0.12, 0.1, 0.08], [0.16, 1.56, -0.04], 0x244d39, { accent: true });
      this.box(group, entity, "head", [0.42, 0.1, 0.14], [0, 1.42, 0.2], 0x0e2a24, { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.6 });
    } else if (entity.kind === "engineer") {
      // Builder crew: a welding torch with a blazing tip, a big steel wrench on the back,
      // a hi-vis hard hat with a head-lamp, and a tool belt of hanging gear.
      this.box(group, entity, "rifle", [0.12, 0.12, 0.46], [0.46, 0.92, 0.2], 0x3a3320, { metalness: 0.3 });
      this.box(group, entity, "rifle", [0.11, 0.11, 0.16], [0.46, 0.92, 0.5], 0xfff0c0, { accent: true, emissive: 0xffce4a, emissiveIntensity: 1.0 });
      this.box(group, entity, "pack", [0.1, 0.64, 0.1], [-0.34, 0.92, -0.32], 0xcfd6dc, { accent: true, metalness: 0.42 });
      this.box(group, entity, "pack", [0.24, 0.16, 0.12], [-0.34, 1.28, -0.32], 0xcfd6dc, { accent: true, metalness: 0.42 });
      this.box(group, entity, "body", [0.6, 0.12, 0.4], [0, 0.62, 0.02], 0xffce4a, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.4 });
      for (const x of [-0.18, 0.12]) this.box(group, entity, "body", [0.08, 0.18, 0.06], [x, 0.5, 0.18], 0xbfc6cc, { accent: true, metalness: 0.4 });
      this.box(group, entity, "head", [0.48, 0.18, 0.46], [0, 1.5, 0.0], 0xffce4a, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.35 });
      this.box(group, entity, "head", [0.16, 0.1, 0.08], [0, 1.5, 0.24], 0xbfe8ff, { accent: true, emissive: 0xbfe8ff, emissiveIntensity: 0.9 });
    } else if (entity.kind === "flamer") {
      // Incendiary specialist: fat twin-nozzle projector with a pilot flame, hazard-striped
      // shoulder guard, and big glowing fuel tanks on the back — unmistakably "fire".
      this.box(group, entity, "rifle", [0.2, 0.2, 0.82], [0.47, 0.92, 0.3], 0x3a3230, { metalness: 0.3 });
      this.cylinder(group, entity, "rifle", 0.09, 0.3, [0.47, 0.92, 0.78], 0x1d1a18, [Math.PI / 2, 0, 0], { metalness: 0.36 });
      this.sphere(group, entity, "rifle", 0.06, [0.47, 0.92, 0.96], 0xffb02e, { accent: true, emissive: 0xff6b1a, emissiveIntensity: 0.95 });
      this.box(group, entity, "rifle", [0.1, 0.1, 0.34], [0.47, 1.04, 0.4], 0x5a2f10, { accent: true });
      this.box(group, entity, "body", [0.34, 0.16, 0.4], [-0.36, 1.08, 0.02], 0xffb02e, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.2 });
      this.cylinder(group, entity, "pack", 0.13, 0.62, [-0.14, 0.86, -0.44], 0xc23a10, [0, 0, 0], { accent: true, emissive: 0xff5a1a, emissiveIntensity: 0.3, metalness: 0.3 });
      this.cylinder(group, entity, "pack", 0.13, 0.62, [0.14, 0.86, -0.44], 0xd84a14, [0, 0, 0], { accent: true, emissive: 0xff5a1a, emissiveIntensity: 0.3, metalness: 0.3 });
      this.box(group, entity, "head", [0.46, 0.2, 0.46], [0, 1.5, 0], 0x8a2f10, { accent: true, metalness: 0.2 });
    } else if (entity.kind === "droneop") {
      // Drone operator: a signal wand, a control slate on the chest, and the recon drone
      // itself hovering overhead with a spinning-ring rotor and a scanning eye.
      this.box(group, entity, "rifle", [0.12, 0.12, 0.5], [0.46, 0.92, 0.22], 0x3a4450, { metalness: 0.3 });
      this.box(group, entity, "body", [0.3, 0.22, 0.06], [0, 0.96, 0.23], 0x0e1a26, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.55 });
      this.box(group, entity, "head", [0.46, 0.18, 0.46], [0, 1.49, 0], 0x2c4a6a, { accent: true });
      this.box(group, entity, "head", [0.2, 0.08, 0.24], [0.16, 1.52, 0.14], 0x9fdcff, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.7 });
      // The drone (pack part, so shooting the pack downs the optics — cause and effect).
      this.box(group, entity, "pack", [0.34, 0.09, 0.34], [0, 2.25, -0.1], 0x35485c, { accent: true, metalness: 0.3 });
      this.cylinder(group, entity, "pack", 0.26, 0.05, [0, 2.33, -0.1], 0x9fdcff, [0, 0, 0], { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.5 });
      this.sphere(group, entity, "pack", 0.07, [0, 2.18, 0.08], 0xff5a4d, { accent: true, emissive: 0xff3b30, emissiveIntensity: 0.85 });
    } else if (entity.kind === "sapper") {
      // Combat sapper: stubby demolition launcher with a fat drum, mine discs clipped to
      // the belt, blast apron, and a heavy face shield — the wall-breaker.
      this.box(group, entity, "rifle", [0.22, 0.22, 0.6], [0.47, 0.92, 0.26], 0x4a4232, { metalness: 0.3 });
      this.cylinder(group, entity, "rifle", 0.14, 0.2, [0.47, 0.8, 0.2], 0x2a2620, [0, 0, Math.PI / 2], { accent: true, metalness: 0.3 });
      this.box(group, entity, "rifle", [0.14, 0.14, 0.16], [0.47, 0.92, 0.62], 0xffca6b, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.4 });
      for (const x of [-0.18, 0.02, 0.22]) this.cylinder(group, entity, "body", 0.07, 0.04, [x, 0.58, 0.22], 0x8a7a3a, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.3 });
      this.box(group, entity, "body", [0.44, 0.5, 0.07], [0, 0.72, 0.2], 0x5a4a1a, { accent: true });
      this.box(group, entity, "head", [0.48, 0.26, 0.1], [0, 1.38, 0.2], 0x3a342a, { accent: true, metalness: 0.24 });
      this.box(group, entity, "head", [0.44, 0.16, 0.44], [0, 1.5, 0], 0x8a7a3a, { accent: true });
    } else {
      // Line infantry (soldier): standard bayoneted rifle, a brimmed helmet with a comms
      // bead, chest webbing/pouches and a slung frag — the plain baseline trooper.
      this.box(group, entity, "rifle", [0.18, 0.18, 0.9], [0.45, 0.92, 0.28], trimColor);
      this.box(group, entity, "rifle", [0.05, 0.05, 0.3], [0.45, 0.96, 0.78], 0xeaffff, { accent: true, metalness: 0.5 });
      this.box(group, entity, "body", [0.5, 0.12, 0.06], [0, 0.94, 0.2], 0x2c3a30, { accent: true });
      for (const x of [-0.16, 0.16]) this.box(group, entity, "body", [0.14, 0.18, 0.1], [x, 0.74, 0.2], 0x35463a, { accent: true });
      this.box(group, entity, "body", [0.12, 0.16, 0.12], [-0.3, 0.66, 0.12], 0x3f5036, { accent: true });
      this.box(group, entity, "head", [0.44, 0.2, 0.44], [0, 1.5, 0.0], 0x2c3a3d, { accent: true, metalness: 0.14 });
      this.box(group, entity, "head", [0.48, 0.07, 0.16], [0, 1.43, 0.22], 0x141819, { accent: true });
      this.box(group, entity, "head", [0.09, 0.08, 0.07], [0.2, 1.5, 0.1], 0x8df0ff, { accent: true, emissive: 0x5ff1ff, emissiveIntensity: 0.7 });
    }
    this.box(group, entity, "pack", [0.36, 0.42, 0.17], [0, 0.84, -0.29], packColor, entity.kind === "grenadier" ? { emissive: 0xff7d26, emissiveIntensity: 0.26 } : {});
    // Team-lit status lamp on the pack. (No twin tanks / comm nub — invisible at tactics
    // zoom and each small mesh is a draw call across a 40-unit battle.)
    this.box(group, entity, "pack", [0.1, 0.14, 0.06], [-0.22, 1.04, -0.38], 0xdaf7ff, { emissive: teamGlow, emissiveIntensity: 0.42 });
    // Arms and legs are tagged as limbs so they can swing into a walk cycle while moving.
    // Tapered cylinders with glove/boot caps — same base positions and pivots as before.
    this.cylinder(group, entity, "body", 0.075, 0.5, [-0.42, 0.72, 0.02], bodyColor, [0, 0, 0], { radiusBottom: 0.09 }).userData.limb = "arm-l";
    this.cylinder(group, entity, "body", 0.075, 0.5, [0.42, 0.72, 0.02], bodyColor, [0, 0, 0], { radiusBottom: 0.09 }).userData.limb = "arm-r";
    this.sphere(group, entity, "body", 0.088, [-0.42, 0.46, 0.05], 0x1f282c, { metalness: 0.2 }).userData.limb = "arm-l";
    this.sphere(group, entity, "body", 0.088, [0.42, 0.46, 0.05], 0x1f282c, { metalness: 0.2 }).userData.limb = "arm-r";
    this.cylinder(group, entity, "legs", 0.095, 0.52, [-0.18, 0.26, 0], 0x162225, [0, 0, 0], { radiusBottom: 0.075 }).userData.limb = "leg-l";
    this.cylinder(group, entity, "legs", 0.095, 0.52, [0.18, 0.26, 0], 0x162225, [0, 0, 0], { radiusBottom: 0.075 }).userData.limb = "leg-r";
    this.box(group, entity, "legs", [0.2, 0.11, 0.3], [-0.18, 0.055, 0.07], 0x101516, { metalness: 0.14 }).userData.limb = "leg-l";
    this.box(group, entity, "legs", [0.2, 0.11, 0.3], [0.18, 0.055, 0.07], 0x101516, { metalness: 0.14 }).userData.limb = "leg-r";
  }

  private buildBase(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x5fe6ff;
    this.box(group, entity, "core", [2.45, 1.35, 2.05], [0, 0.68, 0], 0xd06458);
    this.box(group, entity, "core", [2.72, 0.22, 2.32], [0, 1.48, 0], 0x51231f, { metalness: 0.18 });
    for (const x of [-1.42, 1.42]) this.box(group, entity, "core", [0.26, 1.52, 0.28], [x, 0.82, -0.52], 0x7c3f39, { metalness: 0.14 });
    // Command rooftop (no weapon) — this HQ earns money and builds, it does not attack.
    this.box(group, entity, "core", [1.1, 0.34, 1.1], [0.2, 1.78, 0.15], 0xc9a36a, { metalness: 0.18 });
    this.cylinder(group, entity, "core", 0.34, 0.3, [0.2, 2.06, 0.15], 0xe7c98c, [0, 0, 0], { emissive: factionGlow, emissiveIntensity: 0.32 });
    // Team banner flying over the command core — a quick readability + flavor cue.
    this.cylinder(group, entity, "core", 0.05, 1.2, [1.02, 2.4, 0.62], 0xdadfd2, [0, 0, 0], { metalness: 0.3 });
    this.box(group, entity, "core", [0.06, 0.5, 0.72], [1.02, 2.74, 0.99], factionGlow, { emissive: factionGlow, emissiveIntensity: 0.5 });
    this.box(group, entity, "core", [0.06, 0.5, 0.18], [1.02, 2.74, 1.44], factionGlow, { emissive: factionGlow, emissiveIntensity: 0.32 });
    this.box(group, entity, "comms", [0.18, 1.7, 0.18], [-0.9, 2.05, -0.15], 0xd9ded2);
    this.box(group, entity, "comms", [0.72, 0.12, 0.12], [-0.9, 2.88, -0.15], 0xffffff, { emissive: 0xffa08a, emissiveIntensity: 0.55 });
    this.box(group, entity, "comms", [0.12, 0.12, 0.86], [-0.9, 2.46, -0.15], 0xffffff, { emissive: factionGlow, emissiveIntensity: 0.42 });
    this.box(group, entity, "power", [0.72, 0.9, 0.72], [0.92, 0.62, -0.62], 0xffc857, { emissive: 0xff9e2b, emissiveIntensity: 0.4 });
    this.box(group, entity, "power", [0.94, 0.1, 0.94], [0.92, 1.12, -0.62], 0xfff0bf, { emissive: 0xff9e2b, emissiveIntensity: 0.58 });
    this.box(group, entity, "gate", [2.75, 0.68, 0.34], [0, 0.38, 1.24], 0x8b4d47);
    this.box(group, entity, "gate", [0.18, 0.76, 0.42], [-1.08, 0.46, 1.42], 0x3a1c19, { metalness: 0.18 });
    this.box(group, entity, "gate", [0.18, 0.76, 0.42], [1.08, 0.46, 1.42], 0x3a1c19, { metalness: 0.18 });
    for (const x of [-0.75, 0, 0.75]) this.box(group, entity, "core", [0.28, 0.12, 0.08], [x, 1.2, 1.06], 0xfff0bf, { emissive: 0xff9d6c, emissiveIntensity: 0.45 });
  }

  private buildDefense(group: THREE.Group, entity: CombatEntity): void {
    const glow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x5fe6ff;
    if (entity.kind === "wall") {
      const h = entity.height;
      this.box(group, entity, "barrier", [2.15, h, 0.62], [0, h / 2, 0], 0x8a9099, { metalness: 0.2 });
      this.box(group, entity, "barrier", [2.34, 0.24, 0.82], [0, h - 0.12, 0], 0x676f7a, { metalness: 0.22 });
      this.box(group, entity, "barrier", [2.34, 0.2, 0.82], [0, 0.16, 0], 0x4f565f, { metalness: 0.22 });
      for (const x of [-0.72, 0, 0.72]) this.box(group, entity, "barrier", [0.14, h * 0.82, 0.66], [x, h * 0.46, 0], 0x5a626d);
      this.box(group, entity, "barrier", [1.96, 0.12, 0.1], [0, h * 0.66, 0.33], 0xdfeaf2, { emissive: glow, emissiveIntensity: 0.4 });
      this.box(group, entity, "barrier", [1.96, 0.12, 0.1], [0, h * 0.34, 0.33], 0xdfeaf2, { emissive: glow, emissiveIntensity: 0.28 });
      return;
    }
    // Shared emplacement base + traversing head.
    this.box(group, entity, "mount", [1.55, 0.4, 1.55], [0, 0.2, 0], 0x474f59, { metalness: 0.22 });
    this.box(group, entity, "mount", [1.7, 0.14, 1.7], [0, 0.05, 0], 0x2f353d, { metalness: 0.16 });
    this.cylinder(group, entity, "mount", 0.52, 0.32, [0, 0.52, 0], 0x5b6671, [0, 0, 0], { metalness: 0.26 });
    for (const [x, z] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]] as const) {
      this.box(group, entity, "mount", [0.16, 0.34, 0.16], [x, 0.21, z], 0x2b3036, { metalness: 0.3 });
    }
    if (entity.kind === "exturret") {
      // Twin mortar tubes angled up + a glowing shell magazine.
      this.box(group, entity, "gun", [0.94, 0.42, 0.94], [0, 0.78, 0], 0x586470, { metalness: 0.24 });
      for (const x of [-0.24, 0.24]) {
        this.cylinder(group, entity, "gun", 0.15, 0.78, [x, 1.18, 0.08], 0x232a30, [0.5, 0, 0], { metalness: 0.34 });
        this.cylinder(group, entity, "gun", 0.17, 0.1, [x, 1.5, 0.26], 0xffd27a, [0.5, 0, 0], { emissive: 0xff9e2b, emissiveIntensity: 0.4 });
      }
      this.box(group, entity, "ammo", [0.6, 0.46, 0.5], [0, 0.62, -0.7], 0xffb02e, { emissive: 0xff6b1a, emissiveIntensity: 0.4 });
      this.box(group, entity, "ammo", [0.66, 0.1, 0.56], [0, 0.9, -0.7], 0xfff0bf, { emissive: 0xff7d26, emissiveIntensity: 0.5 });
    } else {
      // Single auto-cannon turret with a sensor dome.
      this.box(group, entity, "gun", [0.82, 0.44, 0.92], [0, 0.78, -0.02], 0x5d6873, { metalness: 0.26 });
      this.box(group, entity, "gun", [0.22, 0.22, 1.25], [0, 0.86, 0.74], 0xcfd9de, { metalness: 0.36 });
      this.box(group, entity, "gun", [0.3, 0.3, 0.2], [0, 0.86, 1.34], 0xffffff, { emissive: glow, emissiveIntensity: 0.34 });
      this.box(group, entity, "gun", [0.16, 0.16, 0.5], [0.26, 1.02, 0.1], 0x141a1e, { metalness: 0.3 });
      this.box(group, entity, "sensor", [0.34, 0.2, 0.34], [-0.26, 1.12, -0.12], 0x101517, { emissive: glow, emissiveIntensity: 0.5 });
      this.box(group, entity, "sensor", [0.16, 0.16, 0.16], [-0.26, 1.3, -0.12], 0xdaf7ff, { emissive: glow, emissiveIntensity: 0.7 });
    }
  }

  private buildCover(group: THREE.Group, entity: CombatEntity): void {
    const part = entity.parts[0];
    const volatile = part.role === "volatile";
    if (entity.coverKind === "ammo") {
      this.box(group, entity, part.id, [0.92, 0.58, 0.72], [0, 0.32, 0], 0x8c6541, { emissive: 0xff9e2b, emissiveIntensity: 0.18 });
      this.box(group, entity, part.id, [0.72, 0.18, 0.52], [0, 0.72, 0], 0xffca6b, { emissive: 0xff7d26, emissiveIntensity: 0.42 });
      for (const x of [-0.24, 0.24]) this.cylinder(group, entity, part.id, 0.14, 0.62, [x, 0.52, 0], 0x34312a);
      for (const z of [-0.32, 0.32]) this.box(group, entity, part.id, [1.02, 0.08, 0.08], [0, 0.66, z], 0xfff0bf, { emissive: 0xffb02e, emissiveIntensity: 0.35 });
    } else if (entity.coverKind === "conduit") {
      this.box(group, entity, part.id, [0.48, 1.15, 0.48], [0, 0.58, 0], 0x315764, { emissive: 0x48e9ff, emissiveIntensity: 0.34 });
      this.box(group, entity, part.id, [1.08, 0.16, 0.24], [0, 1.22, 0], 0x9dfcff, { emissive: 0x48e9ff, emissiveIntensity: 0.68 });
      this.box(group, entity, part.id, [0.16, 0.82, 0.92], [0, 0.58, 0], 0x152126);
      this.box(group, entity, part.id, [0.86, 0.08, 0.12], [0, 0.2, 0.52], 0x8df4ff, { emissive: 0x48e9ff, emissiveIntensity: 0.7 });
      this.box(group, entity, part.id, [0.86, 0.08, 0.12], [0, 0.96, -0.52], 0x8df4ff, { emissive: 0x48e9ff, emissiveIntensity: 0.58 });
    } else if (volatile) {
      this.box(group, entity, part.id, [0.82, 0.98, 0.82], [0, 0.5, 0], 0xffb02e, { emissive: 0xff6b1a, emissiveIntensity: 0.35 });
      this.box(group, entity, part.id, [0.56, 0.28, 0.56], [0, 1.14, 0], 0xffd06a, { emissive: 0xffb02e, emissiveIntensity: 0.45 });
      this.box(group, entity, part.id, [0.16, 0.82, 0.9], [0, 0.56, 0], 0x5a3516);
      this.box(group, entity, part.id, [0.98, 0.1, 0.1], [0, 0.96, 0], 0xfff0bf, { emissive: 0xff7d26, emissiveIntensity: 0.42 });
      this.box(group, entity, part.id, [0.1, 0.1, 0.98], [0, 0.96, 0], 0xfff0bf, { emissive: 0xff7d26, emissiveIntensity: 0.42 });
    } else if (entity.coverKind === "barricade") {
      this.box(group, entity, part.id, [1.72, 0.62, 0.46], [0, 0.32, 0], 0x9b7045);
      this.box(group, entity, part.id, [1.54, 0.18, 0.56], [0, 0.72, 0], 0xc18a50);
      for (const x of [-0.58, 0.58]) this.box(group, entity, part.id, [0.12, 0.68, 0.58], [x, 0.36, 0], 0x704a2b);
      for (const x of [-0.34, 0.34]) this.box(group, entity, part.id, [0.08, 0.12, 0.62], [x, 0.86, 0], 0xe9be77, { emissive: 0x6c3a13, emissiveIntensity: 0.18 });
    } else if (entity.coverKind === "ridge") {
      this.box(group, entity, part.id, [2.2, 0.82, 0.78], [0, 0.48, 0], 0x8d5e36);
      this.box(group, entity, part.id, [2.34, 0.2, 0.88], [0, 0.98, 0], 0xb77b43);
      this.box(group, entity, part.id, [2.02, 0.08, 0.98], [0, 0.18, 0.02], 0x5f3b22);
      this.box(group, entity, part.id, [1.72, 0.08, 0.96], [0, 0.68, -0.02], 0xd39a5a);
      this.box(group, entity, part.id, [1.7, 0.08, 0.08], [0, 1.28, -0.38], 0xf0c37a, { emissive: 0x6c3a13, emissiveIntensity: 0.16 });
    } else if (entity.coverKind === "cliff") {
      this.box(group, entity, part.id, [1.72, 1.62, 0.74], [0, 0.86, 0], 0x8f5f35);
      this.box(group, entity, part.id, [1.94, 0.28, 0.8], [0, 1.72, -0.02], 0xb9783f);
      this.box(group, entity, part.id, [1.82, 0.1, 0.86], [0, 0.42, 0.04], 0x5d3820);
      this.box(group, entity, part.id, [1.76, 0.09, 0.86], [0, 0.86, -0.02], 0xc18b55);
      this.box(group, entity, part.id, [1.62, 0.08, 0.82], [0, 1.26, 0.02], 0x6b4327);
      this.box(group, entity, part.id, [0.28, 0.16, 0.82], [-0.52, 0.2, 0.06], 0xd6a15f);
      this.box(group, entity, part.id, [0.28, 0.16, 0.82], [0.06, 0.58, 0.06], 0xd6a15f);
      this.box(group, entity, part.id, [0.28, 0.16, 0.82], [0.52, 0.96, 0.06], 0xd6a15f);
    } else if (entity.coverKind === "depot") {
      // Capturable supply depot: fuel hut + drum stack + comms whip; the beacon strip
      // takes the holder's color (neutral = warm white) via the team rebuild.
      const holder = entity.team === "player" ? 0x5fe6ff : entity.team === "enemy" ? 0xff6d57 : 0xffe9c4;
      this.box(group, entity, part.id, [1.5, 0.95, 1.15], [0, 0.5, 0], 0x6a6455, { metalness: 0.16 });
      this.box(group, entity, part.id, [1.68, 0.14, 1.3], [0, 1.03, 0], 0x4a453a, { metalness: 0.2 });
      this.cylinder(group, entity, part.id, 0.24, 0.7, [-0.45, 0.36, 0.75], 0x54584a, [0, 0, 0], { metalness: 0.3 });
      this.cylinder(group, entity, part.id, 0.24, 0.7, [0.15, 0.36, 0.82], 0x615a48, [0, 0, 0], { metalness: 0.3 });
      this.cylinder(group, entity, part.id, 0.03, 1.1, [0.6, 1.6, -0.35], 0xd8dcd2, [0, 0, 0], { metalness: 0.3 });
      this.box(group, entity, part.id, [0.9, 0.12, 0.12], [0, 1.16, 0.45], holder, { emissive: holder, emissiveIntensity: 0.7 });
      this.box(group, entity, part.id, [0.5, 0.3, 0.08], [0, 0.62, 0.6], 0xffca6b, { emissive: 0xff9e2b, emissiveIntensity: 0.25 });
      // Ground capture pad in the holder's color — marks "stand here to take this".
      this.cylinder(group, entity, part.id, 1.05, 0.04, [0, 0.02, 0], holder, [0, 0, 0], { emissive: holder, emissiveIntensity: 0.45 });
    } else if (entity.coverKind === "wreck") {
      // Burnt-out hull: charred body, blown-open plate, a bare road wheel, ember glow in
      // the burn seam — reads as the vehicle that died here.
      this.box(group, entity, part.id, [1.7, 0.55, 1.05], [0, 0.3, 0], 0x201d1a, { metalness: 0.22 });
      this.box(group, entity, part.id, [1.15, 0.4, 0.8], [-0.1, 0.68, 0], 0x2b2622, { metalness: 0.18, rotation: [0.06, 0.22, -0.12] });
      this.box(group, entity, part.id, [0.9, 0.1, 0.7], [0.45, 0.62, 0.1], 0x171512, { rotation: [0.4, -0.3, 0.5] });
      this.cylinder(group, entity, part.id, 0.22, 0.14, [0.7, 0.24, 0.55], 0x0f0d0b, [Math.PI / 2, 0, 0.4]);
      this.box(group, entity, part.id, [0.5, 0.14, 0.3], [-0.3, 0.55, -0.2], 0xff7d26, { emissive: 0xff5a1a, emissiveIntensity: 0.55 });
    } else if (entity.coverKind === "rock") {
      this.box(group, entity, part.id, [1.25, 0.95, 1.05], [0, 0.5, 0], 0x8a857c);
      this.box(group, entity, part.id, [0.82, 0.62, 0.7], [0.22, 1.05, -0.12], 0x9c968b);
      this.box(group, entity, part.id, [0.6, 0.44, 0.52], [-0.32, 0.92, 0.22], 0x736d64);
    } else if (entity.coverKind === "tree") {
      this.cylinder(group, entity, part.id, 0.17, 1.4, [0, 0.7, 0], 0x5a3b22, [0, 0, 0]);
      this.box(group, entity, part.id, [1.15, 1.0, 1.15], [0, 1.7, 0], 0x3f7a3a, { emissive: 0x123d12, emissiveIntensity: 0.12 });
      this.box(group, entity, part.id, [0.82, 0.72, 0.82], [0, 2.35, 0], 0x4f9a4a, { emissive: 0x123d12, emissiveIntensity: 0.1 });
    } else if (entity.coverKind === "crate") {
      this.box(group, entity, part.id, [0.92, 0.7, 0.92], [0, 0.35, 0], 0x9a6a3a);
      this.box(group, entity, part.id, [0.72, 0.55, 0.72], [0.1, 0.96, -0.06], 0xb07c45);
      this.box(group, entity, part.id, [0.94, 0.07, 0.07], [0, 0.55, 0], 0x4a2f18);
      this.box(group, entity, part.id, [0.07, 0.07, 0.94], [0, 0.55, 0], 0x4a2f18);
    } else if (entity.coverKind === "sandbag") {
      for (const [x, y] of [[-0.46, 0.18], [0.46, 0.18], [0, 0.18], [-0.24, 0.5], [0.24, 0.5]] as const) {
        this.box(group, entity, part.id, [0.5, 0.34, 0.72], [x, y, 0], 0xb8a86a, { metalness: 0.02 });
      }
    } else if (entity.coverKind === "rubble") {
      this.box(group, entity, part.id, [1.45, 0.5, 1.1], [0, 0.25, 0], 0x7c756a);
      this.box(group, entity, part.id, [0.5, 0.42, 0.5], [0.42, 0.6, 0.22], 0x8c857a);
      this.box(group, entity, part.id, [0.42, 0.32, 0.42], [-0.4, 0.55, -0.22], 0x6c655a);
    } else if (entity.coverKind === "pillar") {
      this.cylinder(group, entity, part.id, 0.42, 2.5, [0, 1.3, 0], 0xc8bca0, [0, 0, 0]);
      this.box(group, entity, part.id, [1.0, 0.22, 1.0], [0, 0.12, 0], 0xb0a488);
      this.box(group, entity, part.id, [1.0, 0.22, 1.0], [0, 2.5, 0], 0xb0a488);
    } else if (entity.coverKind === "container") {
      // Corrugated shipping container: a long ribbed metal box with door hardware.
      this.box(group, entity, part.id, [1.95, 1.42, 1.02], [0, 0.72, 0], 0x3f6b52, { metalness: 0.3 });
      for (const x of [-0.72, -0.36, 0, 0.36, 0.72]) this.box(group, entity, part.id, [0.06, 1.38, 1.05], [x, 0.72, 0], 0x2f5340);
      this.box(group, entity, part.id, [1.99, 0.14, 1.06], [0, 1.41, 0], 0x4a7a5e, { metalness: 0.3 });
      this.box(group, entity, part.id, [1.99, 0.14, 1.06], [0, 0.05, 0], 0x27402f, { metalness: 0.3 });
      this.box(group, entity, part.id, [0.52, 1.12, 0.06], [0.48, 0.68, 0.54], 0x5a8a6e, { emissive: 0x14251b, emissiveIntensity: 0.12 });
      for (const y of [0.4, 0.96]) this.box(group, entity, part.id, [0.08, 0.06, 0.1], [0.72, y, 0.56], 0xd8dcd2, { metalness: 0.4 });
    } else if (entity.coverKind === "bunker") {
      // Low concrete pillbox: wide sloped body, a dark firing slit, a vent stack.
      this.box(group, entity, part.id, [2.0, 0.85, 1.32], [0, 0.42, 0], 0x8a8478, { metalness: 0.04 });
      this.box(group, entity, part.id, [2.14, 0.16, 1.44], [0, 0.93, 0], 0x736d62, { metalness: 0.04 });
      this.box(group, entity, part.id, [1.5, 0.5, 1.0], [0, 1.18, 0], 0x807a6e, { metalness: 0.04 });
      this.box(group, entity, part.id, [1.42, 0.16, 0.1], [0, 0.62, 0.66], 0x14110d);
      this.cylinder(group, entity, part.id, 0.12, 0.55, [-0.72, 1.2, -0.3], 0x5a5449, [0, 0, 0], { metalness: 0.2 });
    } else {
      this.box(group, entity, part.id, [1.82, 1.25, 0.56], [0, 0.63, 0], 0xb98b5b);
      this.box(group, entity, part.id, [1.66, 0.22, 0.62], [0, 1.37, 0], 0xe0b673);
      this.box(group, entity, part.id, [0.14, 1.12, 0.66], [-0.58, 0.7, 0], 0x7a5535);
      this.box(group, entity, part.id, [0.14, 1.12, 0.66], [0.58, 0.7, 0], 0x7a5535);
      for (const x of [-0.34, 0.34]) this.box(group, entity, part.id, [0.1, 1.02, 0.08], [x, 0.7, 0.34], 0xf0c37a, { emissive: 0x6c3a13, emissiveIntensity: 0.16 });
    }
    this.tintPropToMap(group);
    this.interactionGlow(group, entity, volatile);
  }

  // Nudge a prop's structural surfaces toward the active map's palette so it belongs to the
  // scene. Glowing gameplay-signal props (fuel/ammo/conduit, anything emissive) are left alone
  // so their cues stay legible. Both the live material and the stored baseColor are updated so
  // the per-part damage shading keeps the tint.
  private tintPropToMap(group: THREE.Group, amount = 0.32): void {
    group.traverse((obj) => {
      const mesh = obj as PartMesh;
      if (!(mesh.isMesh) || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
      if ((mesh.userData.baseEmissiveIntensity as number ?? 0) > 0.12) return; // keep glowing signals
      const tinted = new THREE.Color(mesh.userData.baseColor as number ?? mesh.material.color.getHex()).lerp(this.propTint, amount);
      mesh.material.color.copy(tinted);
      mesh.userData.baseColor = tinted.getHex();
    });
  }

  private interactionGlow(group: THREE.Group, entity: CombatEntity, volatile: boolean): void {
    // Neutral cover glows warm white — cyan is reserved for the player team, so a crate
    // must never wear the same edge light as friendly kit.
    const color = entity.coverKind === "cliff" ? 0xb48cff : volatile ? 0xffca6b : entity.coverKind === "ridge" ? 0xf0c37a : 0xffe9c4;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72, depthWrite: false });
    const width = Math.max(0.58, entity.radius * 1.08);
    const depth = Math.max(0.42, entity.radius * 0.54);
    const y = Math.max(0.34, entity.height * 0.58);
    for (const [sx, sy, sz, x, z, rotation] of [
      [width, 0.035, 0.055, 0, depth, 0],
      [width, 0.035, 0.055, 0, -depth, 0],
      [0.055, 0.035, width * 0.72, depth, 0, 0],
      [0.055, 0.035, width * 0.72, -depth, 0, 0],
    ] as const) {
      const glow = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      glow.position.set(x, y, z);
      glow.rotation.y = rotation;
      glow.userData.decor = true;
      group.add(glow);
    }
  }

  private box(
    group: THREE.Group,
    entity: CombatEntity,
    partId: string,
    size: [number, number, number],
    pos: [number, number, number],
    color: number,
    materialOptions: { metalness?: number; emissive?: number; emissiveIntensity?: number; accent?: boolean; rotation?: [number, number, number] } = {}
  ): PartMesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.62,
        metalness: materialOptions.metalness ?? 0.08,
        emissive: materialOptions.emissive ?? 0x000000,
        emissiveIntensity: materialOptions.emissiveIntensity ?? 0,
      })
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (materialOptions.rotation) mesh.rotation.set(materialOptions.rotation[0], materialOptions.rotation[1], materialOptions.rotation[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.accent = materialOptions.accent === true;
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    // Outlines only on infantry, and only on the silhouette-critical parts (torso, head,
    // legs): those are the shapes that must read at tactics distance, and each outline is
    // a whole extra draw call — trinkets/weapons don't earn one at 0.38 opacity.
    if (isInfantryKind(entity.kind) && OUTLINED_PARTS.has(partId)) this.outline(mesh);
    group.add(mesh);
    return mesh;
  }

  private cylinder(
    group: THREE.Group,
    entity: CombatEntity,
    partId: string,
    radius: number,
    depth: number,
    pos: [number, number, number],
    color: number,
    rotation: [number, number, number] = [0, 0, Math.PI / 2],
    materialOptions: { metalness?: number; emissive?: number; emissiveIntensity?: number; accent?: boolean; radiusBottom?: number } = {}
  ): PartMesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, materialOptions.radiusBottom ?? radius, depth, 14),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.7,
        metalness: materialOptions.metalness ?? 0.16,
        emissive: materialOptions.emissive ?? 0x000000,
        emissiveIntensity: materialOptions.emissiveIntensity ?? 0,
      })
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.accent = materialOptions.accent === true;
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    if (isInfantryKind(entity.kind) && OUTLINED_PARTS.has(partId)) this.outline(mesh);
    group.add(mesh);
    return mesh;
  }

  // Sphere part mesh (helmets, shoulder pads, joints) with the same userData contract as box().
  private sphere(
    group: THREE.Group,
    entity: CombatEntity,
    partId: string,
    radius: number,
    pos: [number, number, number],
    color: number,
    materialOptions: { metalness?: number; emissive?: number; emissiveIntensity?: number; accent?: boolean; scaleY?: number } = {}
  ): PartMesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 14, 10),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: materialOptions.metalness ?? 0.12,
        emissive: materialOptions.emissive ?? 0x000000,
        emissiveIntensity: materialOptions.emissiveIntensity ?? 0,
      })
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (materialOptions.scaleY) mesh.scale.y = materialOptions.scaleY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.accent = materialOptions.accent === true;
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    group.add(mesh);
    return mesh;
  }

  private outline(mesh: PartMesh): void {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 35),
      new THREE.LineBasicMaterial({ color: 0x050708, transparent: true, opacity: 0.38 })
    );
    edges.userData.decor = true;
    mesh.add(edges);
  }


  private spawnDebris(entity: CombatEntity, part: DamagePart): void {
    const count = entity.kind === "cover"
      ? 4
      : part.role === "armor" || part.role === "core" ? 6 : part.role === "mobility" ? 5 : part.role === "weapon" ? 4 : 3;
    const color = roleColor(entity, part.role, entity.team === "enemy" ? 0xd96a5d : 0x7bc5d8);
    const seed = hash(`${entity.id}:${part.id}`);
    const born = performance.now() / 1000;
    for (let i = 0; i < count; i++) {
      const a = ((seed + i * 83) % 360) * (Math.PI / 180);
      const r = 0.38 + ((seed >> (i % 8)) & 7) * 0.08 + i * 0.035;
      const long = part.role === "weapon" && i === 0;
      const wheel = part.role === "mobility" && i < 2;
      const geometry = wheel
        ? new THREE.CylinderGeometry(0.18, 0.18, 0.16, 10)
        : new THREE.BoxGeometry(long ? 0.18 : 0.18 + i * 0.025, long ? 0.18 : 0.14 + (i % 3) * 0.045, long ? 0.92 : 0.24 + (i % 2) * 0.08);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.78,
          metalness: part.role === "weapon" || part.role === "mobility" ? 0.28 : 0.08,
          emissive: part.role === "volatile" || part.id === "pack" || part.id === "comms" ? 0xff8d3a : 0x000000,
          emissiveIntensity: part.role === "volatile" ? 0.45 : part.id === "pack" || part.id === "comms" ? 0.22 : 0,
        })
      ) as PartMesh;
      mesh.position.set(
        entity.position.x + Math.sin(a) * (entity.radius + r),
        0.12 + (i % 4) * 0.08,
        entity.position.z + Math.cos(a) * (entity.radius + r)
      );
      mesh.rotation.set(seed * 0.017 + i, a, seed * 0.011 + i * 0.3);
      mesh.userData.origin = mesh.position.clone();
      mesh.userData.velocity = new THREE.Vector3(Math.sin(a) * (1.0 + i * 0.11), 1.65 + (i % 4) * 0.28, Math.cos(a) * (1.0 + i * 0.11));
      mesh.userData.spin = new THREE.Vector3(2.2 + (i % 3) * 0.7, 1.1 + i * 0.18, 1.7 + (i % 4) * 0.35);
      mesh.userData.baseRotation = mesh.rotation.clone();
      mesh.userData.born = born;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.debrisRoot.add(mesh);
    }
    // A quick, bright, LOCALIZED spark flash AT the destroyed part (never a screen flash) so the
    // eye catches exactly what broke — the snapped track, the blown turret, the dropped gun. Rides
    // the auto-expiring smoke-puff path with a short bright life.
    const partY = Math.max(0.25, entity.elevation + entity.height * (part.role === "mobility" ? 0.28 : part.role === "head" ? 0.92 : 0.58));
    const sparkColor = part.role === "volatile" ? 0xff7d26 : part.role === "mobility" || part.role === "weapon" ? 0xffe6b0 : 0xffd27a;
    for (let i = 0; i < 4; i += 1) {
      const material = new THREE.MeshBasicMaterial({ color: sparkColor, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
      const flash = new THREE.Mesh(projectileGeometry("ember"), material);
      const a = ((seed + i * 149) % 360) * (Math.PI / 180);
      flash.position.set(entity.position.x + Math.sin(a) * entity.radius * 0.4, partY, entity.position.z + Math.cos(a) * entity.radius * 0.4);
      flash.scale.setScalar(1.4 + (i % 2) * 0.6);
      flash.userData.smoke = { born: born + i * 0.02, life: 0.32, rise: 1.4, baseOpacity: 0.95, baseScale: flash.scale.x };
      flash.userData.origin = flash.position.clone();
      this.debrisRoot.add(flash);
    }
    // Losing the core (or a volatile store) is a kill moment: a short-lived column of
    // dark smoke rises from the wreck. Puffs share the pooled ember geometry; their
    // materials are per-puff (opacity animates) and disposed when the puff expires.
    if (part.role === "core" || part.role === "volatile") {
      const puffs = entity.kind === "cover" ? 3 : isVehicleKind(entity.kind) || entity.kind === "base" ? 7 : 4;
      this.spawnSmokeColumn(entity.position, puffs, 0x2c2724, 0.45, 2.6, entity.height * 0.4);
    }
  }

  // Rising, growing, fading smoke puffs (kill columns, vehicle dust). Cleaned up by
  // animateDebris when their life runs out.
  private spawnSmokeColumn(position: Vec2, count: number, color: number, opacity: number, lifeSeconds: number, baseY: number): void {
    const born = performance.now() / 1000;
    for (let i = 0; i < count; i += 1) {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const puff = new THREE.Mesh(projectileGeometry("ember"), material);
      puff.position.set(
        position.x + (Math.sin(i * 2.4) * 0.28),
        baseY + 0.15 + i * 0.06,
        position.z + (Math.cos(i * 3.1) * 0.28),
      );
      puff.scale.setScalar(2.6 + (i % 3) * 1.1);
      puff.userData.smoke = { born: born + i * 0.12, life: lifeSeconds, rise: 0.55 + (i % 3) * 0.22, baseOpacity: opacity, baseScale: puff.scale.x };
      puff.userData.origin = puff.position.clone();
      this.debrisRoot.add(puff);
    }
  }

  private animateDebris(): void {
    const now = performance.now() / 1000;
    // Smoke puffs rise, grow, fade, then free their (per-puff) material. Iterate a copy
    // since expired puffs are removed mid-loop.
    for (const object of [...this.debrisRoot.children]) {
      const smoke = object.userData.smoke as { born: number; life: number; rise: number; baseOpacity: number; baseScale: number } | undefined;
      if (!smoke) continue;
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      const age = now - smoke.born;
      if (age < 0) continue;
      if (age > smoke.life) {
        mesh.material.dispose();
        this.debrisRoot.remove(mesh);
        continue;
      }
      const origin = mesh.userData.origin as THREE.Vector3;
      mesh.position.y = origin.y + smoke.rise * age;
      mesh.scale.setScalar(smoke.baseScale * (1 + age * 0.9));
      mesh.material.opacity = smoke.baseOpacity * (1 - age / smoke.life);
    }
    for (const object of this.debrisRoot.children) {
      if (object.userData.smoke) continue;
      const mesh = object as PartMesh;
      const origin = mesh.userData.origin as THREE.Vector3 | undefined;
      const velocity = mesh.userData.velocity as THREE.Vector3 | undefined;
      const spin = mesh.userData.spin as THREE.Vector3 | undefined;
      const baseRotation = mesh.userData.baseRotation as THREE.Euler | undefined;
      const born = mesh.userData.born as number | undefined;
      if (!origin || !velocity || !spin || !baseRotation || born === undefined) continue;
      const age = Math.min(2.2, now - born);
      mesh.position.set(
        origin.x + velocity.x * age,
        Math.max(0.07, origin.y + velocity.y * age - 2.65 * age * age),
        origin.z + velocity.z * age
      );
      mesh.rotation.set(
        baseRotation.x + spin.x * age,
        baseRotation.y + spin.y * age,
        baseRotation.z + spin.z * age
      );
    }
  }

  private paintPart(mesh: PartMesh, entity: CombatEntity, part: DamagePart, selected: boolean, targeted: boolean, targetedPart: boolean, ghosted: boolean): void {
    const material = mesh.material;
    const basePosition = mesh.userData.basePosition as THREE.Vector3 | undefined;
    const baseRotation = mesh.userData.baseRotation as THREE.Euler | undefined;
    const baseScale = mesh.userData.baseScale as THREE.Vector3 | undefined;
    if (basePosition) mesh.position.copy(basePosition);
    if (baseRotation) mesh.rotation.copy(baseRotation);
    if (baseScale) mesh.scale.copy(baseScale);
    if (entity.stance === "crouched" && isInfantryKind(entity.kind) && part.hp > 0) {
      // A readable crouch: legs fold under, the torso drops and leans forward over the knees,
      // and the head/weapon tuck down with it rather than just sinking straight into the ground.
      const drop = 0.42;
      if (part.role === "mobility") {
        mesh.scale.y *= 0.58;
        mesh.position.y = Math.max(0.06, mesh.position.y - 0.02);
        mesh.position.z += 0.07;
      } else if (part.role === "head") {
        mesh.position.y -= drop + 0.06;
        mesh.position.z += 0.12;
      } else if (part.role === "core") {
        mesh.position.y -= drop;
        mesh.position.z += 0.08;
        mesh.rotation.x += 0.16;
      } else {
        mesh.position.y -= drop;
        mesh.position.z += 0.05;
      }
    }

    // Walk cycle: swing arms and legs from the shoulder/hip while the unit moves, weighted by the
    // eased walkWeight so it blends in/out. Legs additionally LIFT on their forward (swing) half so
    // the planted leg reads as ground contact rather than a sweeping pendulum (the anti-skate cue).
    const limb = mesh.userData.limb as string | undefined;
    const parent = mesh.parent;
    const walkW = (parent?.userData.walkWeight as number | undefined) ?? 0;
    if (limb && part.hp > 0 && entity.status.alive && entity.stance !== "crouched" && walkW > 0.02 && basePosition) {
      const motionTime = (parent?.userData.motionTime as number | undefined) ?? 0;
      const isLeg = limb.startsWith("leg");
      const forwardPair = limb === "leg-l" || limb === "arm-r";
      // motionTime is distance-scaled, so a ~1.6 multiplier yields one stride per ~1.6m walked.
      const theta = motionTime * 1.6 + (forwardPair ? 0 : Math.PI);
      const swing = Math.sin(theta) * (isLeg ? 0.62 : 0.42) * walkW;
      const pivotY = isLeg ? 0.52 : 0.98;
      const reach = pivotY - basePosition.y;
      // Foot lift during the forward-swing half (cos(theta) > 0), so one foot steps while the other
      // stays planted — kills the "hovering/sliding feet" read even with a single-mesh leg.
      const lift = isLeg ? Math.max(0, Math.cos(theta)) * 0.07 * walkW : 0;
      mesh.rotation.x = (baseRotation ? baseRotation.x : 0) + swing;
      mesh.position.z = basePosition.z + reach * Math.sin(swing);
      mesh.position.y = pivotY - reach * Math.cos(swing) + lift;
    }

    // Firing recoil: the weapon kicks back toward the body and tips its muzzle up, and the
    // torso rocks back a touch — a quick punch that decays over the round's first frames.
    const recoil = (parent?.userData.recoil as number | undefined) ?? 0;
    if (recoil > 0 && part.hp > 0 && entity.status.alive) {
      if (part.id === "rifle" || part.id === "cannon" || part.id === "gun") {
        const kick = recoil * (entity.kind === "tank" || entity.kind === "artillery" ? 0.3 : entity.kind === "apc" || entity.kind === "turret" || entity.kind === "exturret" ? 0.22 : 0.16);
        mesh.position.z -= kick;
        mesh.rotation.x -= recoil * 0.16;
      } else if (part.role === "core" && isInfantryKind(entity.kind)) {
        mesh.rotation.x -= recoil * 0.08;
        mesh.position.z -= recoil * 0.03;
      }
    }

    // Accent meshes (signature insignia / visors / gear) opt out of the team-color
    // normalization so each unit can carry a little authored identity color of its own.
    const accent = mesh.userData.accent === true;
    const base = accent ? (mesh.userData.baseColor as number) : roleColor(entity, part.role, mesh.userData.baseColor as number);
    const ratio = clamp01(part.hp / part.maxHp);
    const injury = 1 - ratio;
    // Reuse module-scope scratch Colors: paintPart runs for every part mesh of every entity
    // every frame, so `new THREE.Color()` here was allocating hundreds of objects per frame.
    const color = _paintColor.set(base).lerp(_paintTmp.set(0x33120f), injury * 0.55);
    if (ratio < 0.42 && part.hp > 0) color.lerp(_paintTmp.set(0xff5f35), 0.16 + injury * 0.18);
    if (!entity.status.alive) color.lerp(_paintTmp.set(0x08090a), 0.55);
    if (selected && part.hp > 0) color.lerp(_paintTmp.set(0xffffff), 0.24);
    if (targeted && part.hp > 0) color.lerp(_paintTmp.set(0xffd166), targetedPart ? 0.58 : 0.3);
    // Hit flash: a freshly-damaged part snaps white for a beat, so the eye catches what got hit.
    const flash = part.hp > 0 ? this.partFlash(entity.id, part.id) : 0;
    if (flash > 0) color.lerp(_paintTmp.set(0xffffff), flash * 0.7);
    material.color.copy(color);
    const baseEmissive = mesh.userData.baseEmissive as number;
    const unitGlow = entity.kind !== "cover" && entity.team !== "neutral";
    const coverGlow = entity.kind === "cover" && part.hp > 0;
    const coverGlowColor = entity.coverKind === "cliff" ? 0x4a2284 : part.role === "volatile" ? 0x7a4200 : entity.coverKind === "ridge" ? 0x5a3a13 : 0x5c4620;
    const unitGlowColor = entity.team === "enemy" ? TEAMS.enemyGlowDim : TEAMS.playerGlowDim;
    material.emissive.setHex(part.hp > 0 && targetedPart ? 0x4f3000 : part.hp > 0 && selected ? 0x0b3844 : accent ? baseEmissive : unitGlow ? unitGlowColor : coverGlow ? coverGlowColor : baseEmissive);
    material.emissiveIntensity = part.hp > 0
      ? (mesh.userData.baseEmissiveIntensity as number) + (unitGlow ? 0.14 : 0) + (coverGlow ? 0.18 : 0) + (selected ? 0.58 : 0) + (targetedPart ? 0.72 : targeted ? 0.34 : 0)
      : 0;
    // Living idle: standing infantry breathe, their arms + held weapon carry a slow sway, and the
    // torso does a subtle weight-shift — phase-offset per unit so a squad doesn't move in lockstep,
    // and weighted by (1 - walkWeight) so it fades out as the unit starts walking. Keeps the roster
    // alive instead of frozen through the long planning phase, without any new geometry.
    const idleW = isInfantryKind(entity.kind) && entity.status.alive && part.hp > 0 && entity.stance !== "crouched" ? 1 - walkW : 0;
    if (idleW > 0.02) {
      const t = performance.now() * 0.0017 + (hash(entity.id) % 100) * 0.11;
      if (part.role === "core") {
        mesh.scale.y *= 1 + Math.sin(t * 1.2) * 0.012 * idleW;
        mesh.rotation.z += Math.sin(t * 0.6) * 0.02 * idleW;
      } else if (limb === "arm-l" || limb === "arm-r") {
        mesh.rotation.x += Math.sin(t + (limb === "arm-r" ? 0.5 : 0)) * 0.05 * idleW;
      } else if (part.id === "rifle") {
        mesh.rotation.x += Math.sin(t + 0.3) * 0.04 * idleW;
        mesh.rotation.z += Math.sin(t * 0.8) * 0.02 * idleW;
      }
    }
    if (this.commandPhase && entity.team === "player" && entity.status.alive && entity.commandPoints > 0 && part.role === "weapon" && part.hp > 0 && !selected && !targeted) {
      material.emissive.setHex(entity.accent ?? this.playerAccent);
      material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.14 + (Math.sin(performance.now() * 0.004 + (hash(entity.id) % 63)) + 1) * 0.09);
    }
    // Elites/bosses wear a burning gold trim so they read as the priority target.
    if (entity.elite && entity.status.alive && part.hp > 0 && !selected && !targeted && flash <= 0) {
      material.emissive.setHex(0xffb020);
      material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.3 + (Math.sin(performance.now() * 0.005) + 1) * 0.12);
    }
    material.transparent = ghosted && part.hp > 0;
    material.opacity = ghosted && part.hp > 0 ? (targeted ? 0.48 : 0.34) : 1;
    material.depthWrite = !(ghosted && part.hp > 0);
    mesh.visible = part.hp > 0 || entity.kind !== "cover";
    this.paintOutline(mesh, ghosted && part.hp > 0);
    if (part.hp <= 0) {
      mesh.rotation.x += part.role === "head" ? 0.55 : 0.18;
      mesh.rotation.z += part.role === "mobility" ? 0.75 : 0.32;
      mesh.position.y = Math.max(0.11, mesh.position.y - 0.18);
      mesh.position.x += part.role === "weapon" ? 0.16 : part.role === "mobility" ? 0.08 : 0;
      mesh.scale.multiplyScalar(0.78);
    } else if (ratio < 0.45) {
      mesh.scale.y *= 0.86 + ratio * 0.2;
      mesh.rotation.z += part.role === "mobility" ? 0.06 : 0.03;
      material.emissive.setHex(0xff5f35);
      material.emissiveIntensity = 0.18 + (1 - ratio) * 0.28;
    }
    // Gunship rotor: spin fast whenever it's alive so it reads as an idling/flying aircraft.
    if (entity.kind === "gunship" && part.id === "rotor" && entity.status.alive) {
      mesh.rotation.y += performance.now() * 0.03;
    }
    if (entity.kind === "tank" && part.role === "mobility" && mesh.geometry.type === "CylinderGeometry" && mesh.parent?.userData.moving) {
      mesh.rotation.y += ((mesh.parent.userData.motionTime as number | undefined) ?? 0) * 2.2;
    }
    if (flash > 0) {
      material.emissive.setHex(0xffffff);
      material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.5 + flash * 0.6);
    }
  }

  private paintOutline(mesh: PartMesh, ghosted: boolean): void {
    for (const child of mesh.children) {
      if (!child.userData.decor || !("material" in child)) continue;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!(material instanceof THREE.Material)) continue;
        material.transparent = true;
        material.opacity = ghosted ? 0.16 : 0.38;
        material.depthWrite = !ghosted;
      }
    }
  }

  private syncSelection(sim: TacticalSim): void {
    const selected = sim.selected;
    this.ring.visible = Boolean(selected);
    this.selectionDisc.visible = Boolean(selected);
    this.selectionBeacon.visible = Boolean(selected);
    this.selectionLight.visible = Boolean(selected);
    if (!selected) return;
    const color = selected.team === "player" ? (selected.accent ?? this.playerAccent) : selected.team === "enemy" ? TEAMS.enemyMarker : 0xf6d776;
    const scale = Math.max(0.72, selected.radius * 0.96);
    const pulse = (Math.sin(performance.now() * 0.009) + 1) * 0.5;
    const pulseScale = 1.06 + pulse * 0.09;
    this.ring.position.x = selected.position.x;
    this.ring.position.y = selected.elevation + 0.045;
    this.ring.position.z = selected.position.z;
    this.ring.scale.setScalar(scale * pulseScale);
    const mat = this.ring.material as THREE.MeshBasicMaterial;
    mat.color.setHex(color);
    mat.opacity = 0.88 + pulse * 0.12;
    this.selectionDisc.position.x = selected.position.x;
    this.selectionDisc.position.y = selected.elevation + 0.026;
    this.selectionDisc.position.z = selected.position.z;
    // Clamp so large entities (bases/buildings) don't spread a big translucent floor pool,
    // and keep it faint so it reads as a highlight rather than a colored ground patch.
    this.selectionDisc.scale.setScalar(Math.min(scale, 1.45) * (1.18 + pulse * 0.06));
    const discMat = this.selectionDisc.material as THREE.MeshBasicMaterial;
    discMat.color.setHex(color);
    discMat.opacity = 0.12 + pulse * 0.05;
    this.selectionBeacon.position.x = selected.position.x;
    this.selectionBeacon.position.y = selected.elevation + 1.18;
    this.selectionBeacon.position.z = selected.position.z;
    this.selectionBeacon.scale.set(scale * (1.0 + pulse * 0.08), 1, scale * (1.0 + pulse * 0.08));
    const beaconMat = this.selectionBeacon.material as THREE.MeshBasicMaterial;
    beaconMat.color.setHex(color);
    beaconMat.opacity = 0.28 + pulse * 0.18;
    this.selectionLight.position.x = selected.position.x;
    this.selectionLight.position.y = selected.elevation + 1.55;
    this.selectionLight.position.z = selected.position.z;
    this.selectionLight.color.setHex(color);
    this.selectionLight.intensity = 0.9 + pulse * 0.4;
  }

  private syncTarget(sim: TacticalSim, targetId: string | undefined): void {
    const target = sim.entity(targetId);
    this.targetRing.visible = Boolean(target);
    if (!target) return;
    this.targetRing.position.x = target.position.x;
    this.targetRing.position.y = target.elevation + 0.055;
    this.targetRing.position.z = target.position.z;
    this.targetRing.scale.setScalar(target.radius * 1.42);
    const mat = this.targetRing.material as THREE.MeshBasicMaterial;
    mat.color.setHex(target.team === "enemy" ? 0xffd166 : 0xf6d776);
  }

  private syncActionRange(sim: TacticalSim): void {
    const selected = sim.selected;
    const range = sim.selectedActionRange();
    this.actionRangeRing.visible = Boolean(selected && range);
    if (!selected || !range) return;
    const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    this.actionRangeRing.position.set(range.position.x, range.elevation + 0.062, range.position.z);
    this.actionRangeRing.scale.setScalar(range.radius * (1 + pulse * 0.01));
    const mat = this.actionRangeRing.material as THREE.MeshBasicMaterial;
    mat.color.setHex(range.kind === "melee" ? 0xd28cff : range.kind === "grenade" ? 0xff7f67 : range.kind === "move" ? 0x9dfcff : 0xffbf4d);
    mat.opacity = 0.34 + pulse * 0.16;
  }

  // Faint rings showing the reach of support/spotter auras (medic, engineer, scout, sniper),
  // so the player can see which allies benefit. Command phase only to avoid resolve clutter.
  // Signature for the aura/overwatch overlay: the watcher + aura-unit content, plus a ~15fps pulse
  // bucket so the slow opacity pulse still animates while the geometry stays static between beats.
  private aurasSignature(sim: TacticalSim): string {
    let sig = `${sim.phase}|${Math.floor(performance.now() / 66)}`;
    for (const [id] of sim.overwatching) {
      const w = sim.entity(id);
      if (w?.status.alive) sig += `|ow:${id}:${w.position.x.toFixed(1)},${w.position.z.toFixed(1)}:${(sim.overwatchFacing.get(id) ?? -9).toFixed(2)}`;
    }
    if (sim.phase === "command") {
      for (const e of sim.entities) {
        if (!e.status.alive || e.kind === "cover") continue;
        let auraBits = "";
        for (const part of e.parts) {
          if (part.hp <= 0 || !part.tags) continue;
          for (const t of part.tags) if (t.endsWith("-aura")) auraBits += t;
        }
        if (auraBits) sig += `|au:${e.id}:${e.position.x.toFixed(1)},${e.position.z.toFixed(1)}:${auraBits}`;
      }
    }
    return sig;
  }

  private syncAuras(sim: TacticalSim): void {
    const sig = this.aurasSignature(sim);
    if (sig === this.lastAurasSig) return;
    this.lastAurasSig = sig;
    this.disposeAndClear(this.auraRoot);
    const owPulse = (Math.sin(performance.now() * 0.005) + 1) * 0.5;
    // Overwatch kill zones show in BOTH phases — the amber wedge is the whole promise.
    for (const [watcherId] of sim.overwatching) {
      const watcher = sim.entity(watcherId);
      if (!watcher || !watcher.status.alive) continue;
      const radius = sim.overwatchRadius(watcher);
      const y = watcher.elevation + 0.06;
      const facing = sim.overwatchFacing.get(watcherId);
      // Filled directional wedge marking the watched arc (or a full disc for a legacy save with
      // no stored facing), plus a faint full-range ring so the total reach still reads.
      this.auraRoot.add(makeWatchCone(watcher.position, y - 0.006, radius, facing ?? 0, facing === undefined ? Math.PI : OVERWATCH_ARC_HALF, 0xffbf4d, 0.24 + owPulse * 0.12));
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius - 0.16, radius, 72),
        new THREE.MeshBasicMaterial({ color: 0xffbf4d, transparent: true, opacity: 0.16 + owPulse * 0.12, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(watcher.position.x, y, watcher.position.z);
      this.auraRoot.add(ring);
      const eye = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.4, 24),
        new THREE.MeshBasicMaterial({ color: 0xffbf4d, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
      );
      eye.rotation.x = -Math.PI / 2;
      eye.position.set(watcher.position.x, watcher.elevation + watcher.height + 0.5, watcher.position.z);
      this.auraRoot.add(eye);
    }
    if (sim.phase !== "command") return;
    const pulse = (Math.sin(performance.now() * 0.004) + 1) * 0.5;
    for (const entity of sim.entities) {
      if (!entity.status.alive || entity.kind === "cover") continue;
      const tags = new Set<string>();
      for (const part of entity.parts) {
        if (part.hp > 0 && part.tags) for (const tag of part.tags) tags.add(tag);
      }
      const auras: Array<{ radius: number; color: number }> = [];
      if (tags.has("medic-aura")) auras.push({ radius: 4.5, color: 0x8effa6 });
      if (tags.has("repair-aura")) auras.push({ radius: 4.5, color: 0x7fe0c0 });
      if (tags.has("support-aura")) auras.push({ radius: 4.5, color: 0xffd27a });
      if (tags.has("spotter-aura")) auras.push({ radius: 6.2, color: 0x8de4ff });
      for (const aura of auras) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(aura.radius - 0.13, aura.radius, 64),
          new THREE.MeshBasicMaterial({ color: aura.color, transparent: true, opacity: 0.16 + pulse * 0.1, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(entity.position.x, entity.elevation + 0.05, entity.position.z);
        this.auraRoot.add(ring);
      }
    }
  }

  // The circle showing where a base defense can be placed (active during the build flow).
  private syncBuildPlacement(sim: TacticalSim): void {
    const placement = sim.buildPlacement();
    this.placementRing.visible = Boolean(placement);
    this.placementDisc.visible = Boolean(placement);
    if (!placement) return;
    const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    const y = terrainHeightAt(placement.center) + 0.05;
    this.placementRing.position.set(placement.center.x, y + 0.02, placement.center.z);
    this.placementRing.scale.setScalar(placement.radius);
    (this.placementRing.material as THREE.MeshBasicMaterial).opacity = 0.5 + pulse * 0.2;
    this.placementDisc.position.set(placement.center.x, y, placement.center.z);
    this.placementDisc.scale.setScalar(placement.radius);
  }

  private syncOrders(sim: TacticalSim): void {
    this.disposeAndClear(this.orderRoot);
    if (sim.phase !== "command") return;
    const projectedPositions = new Map<string, { x: number; z: number }>();
    for (const order of sim.orders) {
      const actor = sim.entity(order.actorId);
      if (!actor) continue;
      const from = projectedPositions.get(actor.id) ?? actor.position;
      if (order.kind === "defend") {
        this.orderRoot.add(makeEndpoint(from, 0x8de4ff, actor.radius + 0.45));
        this.orderRoot.add(makeEndpoint(from, 0xffffff, actor.radius + 0.14));
        continue;
      }
      const to = order.destination ?? sim.entity(order.targetId)?.position;
      if (!to) continue;
      const color = order.kind === "move" ? 0x9dfcff : order.kind === "ram" ? 0xffbf4d : order.kind === "melee" ? 0xb48cff : 0xff7f67;
      const fromY = terrainHeightAt(from) + 0.24;
      const toY = terrainHeightAt(to) + 0.24;
      this.orderRoot.add(makeTubeLine(from, to, color, 0.32, fromY, 0.028, toY));
      this.orderRoot.add(makeLine(from, to, color, 0.62, fromY + 0.05, toY + 0.05));
      if (order.kind === "move") this.orderRoot.add(makeEndpoint(to, color, actor.radius + 0.22, toY + 0.035));
      if (order.kind === "move" && order.destination) projectedPositions.set(actor.id, order.destination);
    }
  }

  private syncShotPreview(sim: TacticalSim, targetId: string | undefined, targetPartId: string | undefined): void {
    this.disposeAndClear(this.previewRoot);
    const actor = sim.selected;
    if (!actor || actor.team !== "player" || !targetId || !targetPartId || sim.phase !== "command") return;
    const target = sim.entity(targetId);
    const preview = this.activePreview(sim, targetId, targetPartId);
    if (!target || target.team === "player" || !preview) return;

    const impact = preview.impactEntityId ? sim.entity(preview.impactEntityId) : undefined;
    const friendlyRisk = Boolean(preview.warningEntityId);
    const clear = !preview.blockedById && !preview.blockedByGround && !friendlyRisk;
    const previewColor = friendlyRisk ? 0xff527a : clear ? 0x8de4ff : preview.blockedByGround ? 0xff6f4f : 0xffbf69;
    this.addPreviewTrajectory(preview.from, preview.impactPoint, previewColor, clear ? 0.48 : 0.6, preview.fromHeight, preview.impactHeight, preview.arcHeight, 0.052);
    this.previewRoot.add(makeEndpoint(preview.impactPoint, previewColor, (impact?.radius ?? 0.72) + 0.18, preview.impactHeight + 0.045));
    this.syncSplashPreview(sim, actor.id, preview, previewColor);
    this.addPreviewLabel(sim, preview, previewColor);
    if (preview.blockedById) {
      this.addPreviewTrajectory(preview.impactPoint, preview.aimPoint, 0xff765f, 0.3, preview.impactHeight, preview.aimHeight, 0, 0.035);
      this.previewRoot.add(makeEndpoint(preview.aimPoint, 0xff765f, target.radius + 0.1, preview.aimHeight + 0.04));
    } else if (preview.blockedByGround || friendlyRisk) {
      this.addPreviewTrajectory(preview.impactPoint, preview.aimPoint, 0xff765f, 0.3, preview.impactHeight, preview.aimHeight, 0, 0.035);
      this.previewRoot.add(makeEndpoint(preview.aimPoint, 0xff765f, target.radius + 0.1, preview.aimHeight + 0.04));
    }
  }

  // Hovering ground while aiming a grenade or explosive shell: show the throw/firing arc, the
  // blast radius at the landing spot, and whether terrain or a unit in front intercepts it.
  private syncGroundAim(sim: TacticalSim, point?: Vec2): void {
    this.disposeAndClear(this.groundAimRoot);
    if (!point) return;
    // Targeting a support power: draw the strike footprint instead of a weapon arc.
    if (sim.pendingSupport) {
      this.drawSupportReticle(sim, sim.pendingSupport, point);
      return;
    }
    // Aiming overwatch: preview the watch cone toward the cursor so the player sees the arc and
    // radius before committing. The click direction becomes the watched facing.
    if (sim.intent === "overwatch") {
      const watcher = sim.selected;
      if (watcher && !sim.overwatchFailureReason(watcher)) {
        const facing = Math.atan2(point.x - watcher.position.x, point.z - watcher.position.z);
        const radius = sim.overwatchRadius(watcher);
        const y = watcher.elevation + 0.05;
        this.groundAimRoot.add(makeWatchCone(watcher.position, y, radius, facing, OVERWATCH_ARC_HALF, 0xffbf4d, 0.3));
        this.groundAimRoot.add(makeEndpoint({ x: watcher.position.x + Math.sin(facing) * radius, z: watcher.position.z + Math.cos(facing) * radius }, 0xffd166, 0.55, terrainHeightAt(point) + 0.05));
      }
      return;
    }
    const aim = sim.groundAimPreview(point);
    if (!aim) return;
    const landing = aim.hit ?? { point: aim.to, height: aim.toHeight };
    const color = !aim.reachable ? 0xff765f : aim.blocked ? 0xffbf69 : 0x8de4ff;
    if (aim.arcHeight > 0.04) {
      this.groundAimRoot.add(makeArcTubeLine(aim.from, landing.point, color, 0.5, aim.fromHeight, landing.height, aim.arcHeight, 0.05));
      this.groundAimRoot.add(makeArcLine(aim.from, landing.point, color, 0.85, aim.fromHeight, landing.height, aim.arcHeight));
    } else {
      this.groundAimRoot.add(makeTubeLine(aim.from, landing.point, color, 0.5, aim.fromHeight, 0.05, landing.height));
      this.groundAimRoot.add(makeLine(aim.from, landing.point, color, 0.85, aim.fromHeight, landing.height));
    }
    // Blast footprint at where it actually lands (the marked spot, or the obstacle it clips).
    this.groundAimRoot.add(makeSplashDisc(landing.point, color, aim.radius));
    this.groundAimRoot.add(makeEndpoint(landing.point, color, 0.5, landing.height + 0.05));
  }

  // The hover footprint while calling in a support power: line of bomb circles (airstrike),
  // a wide saturation disc (cluster), or the burning beam line (laser). Line powers align
  // away from the calling base, so the preview shows the true strike axis.
  private drawSupportReticle(sim: TacticalSim, kind: string, point: Vec2): void {
    const base = sim.selected;
    const dx = point.x - (base?.position.x ?? point.x - 1);
    const dz = point.z - (base?.position.z ?? point.z);
    const len = Math.hypot(dx, dz) || 1;
    const dir = { x: dx / len, z: dz / len };
    const pulse = (Math.sin(performance.now() * 0.008) + 1) * 0.5;
    const y = terrainHeightAt(point) + 0.07;
    if (kind === "airstrike") {
      for (let i = 0; i < 5; i += 1) {
        const p = { x: point.x + dir.x * (i - 2) * 1.7, z: point.z + dir.z * (i - 2) * 1.7 };
        this.groundAimRoot.add(makeSplashDisc(p, 0xff8c3a, 1.9));
      }
      this.groundAimRoot.add(makeLine({ x: point.x - dir.x * 6, z: point.z - dir.z * 6 }, { x: point.x + dir.x * 6, z: point.z + dir.z * 6 }, 0xff8c3a, 0.5 + pulse * 0.3, y));
    } else if (kind === "cluster") {
      this.groundAimRoot.add(makeSplashDisc(point, 0xffb02e, 3.2 + 1.35));
      this.groundAimRoot.add(makeEndpoint(point, 0xffb02e, 0.6, y));
    } else {
      const from = { x: point.x - dir.x * 4.5, z: point.z - dir.z * 4.5 };
      const to = { x: point.x + dir.x * 4.5, z: point.z + dir.z * 4.5 };
      this.groundAimRoot.add(makeTubeLine(from, to, 0xff5a4d, 0.4 + pulse * 0.3, y, 0.09));
      this.groundAimRoot.add(makeSplashDisc(point, 0xff5a4d, 1.15));
    }
  }

  private syncSplashPreview(sim: TacticalSim, actorId: string, preview: ShotPreview, color: number): void {
    const radius = splashRadiusFor(preview.projectileKind);
    if (radius <= 0) return;
    this.previewRoot.add(makeSplashDisc(preview.impactPoint, color, radius));
    this.debug.splashRings += 1;

    for (const entity of sim.entities) {
      if (entity.id === actorId || !entity.status.alive) continue;
      if (dist(entity.position, preview.impactPoint) > radius + entity.radius * 0.55) continue;
      const markerColor = entity.team === "player" ? 0xff527a : entity.team === "enemy" ? 0xffd166 : 0xffbf69;
      this.previewRoot.add(makeEndpoint(entity.position, markerColor, entity.radius + 0.34, entity.elevation + 0.09));
      this.debug.affectedMarkers += 1;
    }
  }

  private addPreviewLabel(sim: TacticalSim, preview: ShotPreview, color: number): void {
    const blocker = preview.blockedById ? sim.entity(preview.blockedById) : undefined;
    const radius = splashRadiusFor(preview.projectileKind);
    const text = preview.warningText
      ? "Friendly risk"
      : blocker
        ? `Blocked: ${blocker.name}`
        : preview.blockedByGround
          ? "Blocked: high ground"
          : radius > 0
            ? `${preview.amount} dmg / Splash ${radius.toFixed(1)}m`
            : `${preview.amount} dmg / ${Math.round(preview.hitChance * 100)}%`;
    const label = makeLabelSprite(text, color, 0.56);
    label.position.set(preview.impactPoint.x, preview.impactHeight + 0.88, preview.impactPoint.z);
    this.previewRoot.add(label);
    this.debug.previewLabels += 1;
  }

  private addPreviewTrajectory(
    from: { x: number; z: number },
    to: { x: number; z: number },
    color: number,
    opacity: number,
    fromHeight: number,
    toHeight: number,
    arcHeight: number,
    radius: number
  ): void {
    if (arcHeight > 0.04) {
      this.previewRoot.add(makeArcTubeLine(from, to, color, opacity, fromHeight, toHeight, arcHeight, radius));
      this.previewRoot.add(makeArcLine(from, to, color, Math.min(0.98, opacity + 0.34), fromHeight, toHeight, arcHeight));
    } else {
      this.previewRoot.add(makeTubeLine(from, to, color, opacity, fromHeight, radius, toHeight));
      this.previewRoot.add(makeLine(from, to, color, Math.min(0.98, opacity + 0.34), fromHeight, toHeight));
    }
  }

  private syncProjectiles(projectiles: readonly Projectile[]): void {
    this.disposeAndClear(this.projectileRoot);
    const liveIds = new Set<string>();
    for (const projectile of projectiles) {
      liveIds.add(projectile.id);
      const style = projectileStyle(projectile);

      // Comet tail: recent positions fade out behind the round. Opacities are quantized
      // so every segment hits the cached line-material pool.
      let history = this.trailHistory.get(projectile.id);
      if (!history) {
        history = [];
        this.trailHistory.set(projectile.id, history);
      }
      history.push({ x: projectile.position.x, y: projectile.height, z: projectile.position.z });
      if (history.length > 6) history.shift();
      for (let i = history.length - 1; i > 0; i -= 1) {
        const a = history[i - 1];
        const b = history[i];
        const fade = TRAIL_OPACITIES[Math.min(TRAIL_OPACITIES.length - 1, history.length - 1 - i)];
        this.projectileRoot.add(fxLine(a, b, style.trailColor, fade, a.y, b.y));
      }
      // Heavy rounds drag a smoke wake behind the tracer; puffs grow and thin with age.
      if (projectile.kind === "shell" || (projectile.kind === "grenade" && projectile.state !== "rolling")) {
        for (let i = history.length - 3; i >= 0; i -= 2) {
          const p = history[i];
          const back = history.length - 1 - i;
          const fadeIdx = Math.min(SMOKE_OPACITIES.length - 1, Math.floor(back / 2));
          const puff = new THREE.Mesh(projectileGeometry("ember"), projectileMaterial(`trail-smoke-${fadeIdx}`, 0x8d8578, SMOKE_OPACITIES[fadeIdx]));
          puff.position.set(p.x, p.y, p.z);
          puff.scale.setScalar((projectile.kind === "shell" ? 3.4 : 2.2) + back * 0.9);
          this.projectileRoot.add(puff);
        }
      }
      // White-hot head segment reads as a tracer and feeds the bloom pass. Each weapon
      // family gets its own signature: fat plasma streak (bolt), heavy shell tracer,
      // needle-thin brilliant line (sniper), standard rifle tracer.
      const sniper = projectile.sourceKind === "sniper";
      const headRadius = projectile.kind === "bolt" ? 0.048 : projectile.kind === "shell" ? 0.036 : sniper ? 0.018 : 0.028;
      const headBlend = projectile.kind === "bolt" ? 0.7 : sniper ? 0.8 : 0.55;
      this.projectileRoot.add(makeTubeLine(
        projectile.previous, projectile.position,
        blendHex(style.trailColor, 0xffffff, headBlend), 0.9,
        projectile.previousHeight, headRadius, projectile.height,
      ));
      // Sniper rounds leave a long luminous vapor line across their last few meters.
      if (sniper && history.length >= 4) {
        const tail = history[history.length - 4];
        this.projectileRoot.add(makeTubeLine(
          tail, projectile.position,
          blendHex(style.trailColor, 0xffffff, 0.5), 0.4,
          tail.y, 0.012, projectile.height,
        ));
      }
      this.projectileRoot.add(makeProjectileShadow(projectile, style.trailColor));

      const flash = makeMuzzleFlash(projectile);
      if (flash) this.projectileRoot.add(flash);

      const model = makeProjectileModel(projectile);
      model.position.set(projectile.position.x, projectile.height, projectile.position.z);
      orientAlongShot(model, projectile.previous, projectile.position);
      this.projectileRoot.add(model);
    }
    for (const id of this.trailHistory.keys()) if (!liveIds.has(id)) this.trailHistory.delete(id);
  }

  /** Claim the stalest pooled light and flash it at a world point (muzzle or blast). */
  flashLight(position: Vec2, color: number, strength: number, durationMs = 150, height = 1.3): void {
    let stalest = this.flashLights[0];
    for (const record of this.flashLights) if (record.until < stalest.until) stalest = record;
    stalest.light.color.setHex(color);
    stalest.light.position.set(position.x, height, position.z);
    stalest.strength = strength;
    stalest.duration = durationMs;
    stalest.until = performance.now() + durationMs;
  }

  private syncFlashLights(): void {
    const now = performance.now();
    for (const record of this.flashLights) {
      const remaining = record.until - now;
      record.light.intensity = remaining > 0 ? record.strength * (remaining / record.duration) : 0;
    }
  }

  private syncEffects(effects: readonly VisualEvent[]): void {
    this.disposeAndClear(this.effectRoot);
    for (const effect of effects) {
      const t = clamp01(effect.age / effect.duration);
      const opacity = 1 - t;
      if (effect.type === "shot") {
        this.effectRoot.add(makeBeam(effect.from, effect.to, effect.color, opacity));
      } else if (effect.type === "jet") {
        // A strike aircraft crossing the field: dark delta silhouette + engine glow +
        // contrail, plus a racing ground shadow so the flyby reads at tactics zoom.
        const x = effect.from.x + (effect.to.x - effect.from.x) * t;
        const z = effect.from.z + (effect.to.z - effect.from.z) * t;
        const dirX = effect.to.x - effect.from.x;
        const dirZ = effect.to.z - effect.from.z;
        const len = Math.hypot(dirX, dirZ) || 1;
        const alt = 7.4;
        const jet = new THREE.Group();
        const body = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.7, 6), new THREE.MeshBasicMaterial({ color: 0x14171a }));
        body.rotation.x = Math.PI / 2;
        const wing = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.06, 0.6), new THREE.MeshBasicMaterial({ color: 0x1d2125 }));
        wing.position.z = -0.3;
        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.06, 0.3), new THREE.MeshBasicMaterial({ color: 0x1d2125 }));
        tail.position.z = -0.75;
        jet.add(body, wing, tail);
        for (const side of [-1, 1]) {
          const engine = new THREE.Mesh(
            new THREE.SphereGeometry(0.09, 8, 6),
            new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          engine.position.set(side * 0.32, -0.02, -0.72);
          jet.add(engine);
        }
        jet.position.set(x, alt, z);
        jet.rotation.y = Math.atan2(dirX, dirZ);
        this.effectRoot.add(jet);
        const back = { x: x - (dirX / len) * 3.4, z: z - (dirZ / len) * 3.4 };
        this.effectRoot.add(makeTubeLine(back, { x, z }, 0xffffff, 0.22, alt, 0.06, alt));
        const shadow = new THREE.Mesh(projectileShadowGeometry(0.5), projectileShadowMaterial(0x000000, 0.2));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.set(x, terrainHeightAt({ x, z }) + 0.03, z);
        shadow.scale.set(1, 1.9, 1);
        this.effectRoot.add(shadow);
      } else if (effect.type === "beam") {
        // Orbital lance: a burning light-curtain from the sky along the strike line, with a
        // white-hot core and a scorch line on the ground.
        const fade = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
        const dirX = effect.to.x - effect.from.x;
        const dirZ = effect.to.z - effect.from.z;
        const length = Math.hypot(dirX, dirZ) || 1;
        const yaw = Math.atan2(-dirZ, dirX);
        const midX = (effect.from.x + effect.to.x) / 2;
        const midZ = (effect.from.z + effect.to.z) / 2;
        const curtain = new THREE.Mesh(
          new THREE.PlaneGeometry(length + 1.5, 17),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: fade * 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        curtain.position.set(midX, 8.4, midZ);
        curtain.rotation.y = yaw;
        this.effectRoot.add(curtain);
        const core = new THREE.Mesh(
          new THREE.PlaneGeometry(length + 0.5, 17),
          new THREE.MeshBasicMaterial({ color: 0xfff1dc, transparent: true, opacity: fade * 0.7, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        core.position.set(midX, 8.4, midZ);
        core.rotation.y = yaw;
        core.scale.x = 0.22;
        this.effectRoot.add(core);
        const y = terrainHeightAt({ x: midX, z: midZ }) + 0.12;
        this.effectRoot.add(makeTubeLine(effect.from, effect.to, 0xff7a5a, fade * 0.9, y, 0.11));
        this.effectRoot.add(fxLine(effect.from, effect.to, 0xfff1dc, fade, y + 0.06));
      } else if (effect.type === "topple") {
        // A felled column pivots at its base and slams along the from->to line, kicking
        // dust at the impact end. The dead cover mesh hides itself, so this IS the fall.
        const dirX = effect.to.x - effect.from.x;
        const dirZ = effect.to.z - effect.from.z;
        const reach = Math.hypot(dirX, dirZ) || 1;
        const fall = Math.min(1, t * 1.7);
        const radius = Math.max(0.22, (effect.radius ?? 0.4) * 0.75);
        const column = new THREE.Mesh(
          new THREE.CylinderGeometry(radius, radius * 1.2, reach, 10),
          new THREE.MeshStandardMaterial({ color: effect.color, roughness: 0.92, transparent: t > 0.72, opacity: t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1 }),
        );
        column.position.y = reach / 2;
        const pivot = new THREE.Group();
        pivot.add(column);
        pivot.position.set(effect.from.x, terrainHeightAt(effect.from) + 0.05, effect.from.z);
        pivot.rotation.y = Math.atan2(dirX, dirZ);
        pivot.rotation.x = fall * fall * (Math.PI / 2 - 0.06);
        this.effectRoot.add(pivot);
        if (fall >= 1) {
          const dust = new THREE.Mesh(
            new THREE.RingGeometry(0.4 + (t - 0.6) * 2.2, 0.7 + (t - 0.6) * 2.6, 24),
            new THREE.MeshBasicMaterial({ color: 0xcfc2a4, transparent: true, opacity: opacity * 0.5, side: THREE.DoubleSide, depthWrite: false }),
          );
          dust.rotation.x = -Math.PI / 2;
          dust.position.set(effect.to.x, terrainHeightAt(effect.to) + 0.08, effect.to.z);
          this.effectRoot.add(dust);
        }
      } else if (effect.type === "blast") {
        // Battle scar: the first frame of every blast burns a scorch decal into the ground
        // that persists for the whole battle (FIFO-capped so long sieges stay cheap).
        if (!this.scorchedIds.has(effect.id)) {
          this.scorchedIds.add(effect.id);
          const scorch = new THREE.Mesh(_scorchGeometry(), _scorchMaterial());
          scorch.rotation.x = -Math.PI / 2;
          scorch.rotation.z = (hash(effect.id) % 628) / 100;
          scorch.position.set(effect.to.x, terrainHeightAt(effect.to) + 0.012 + (this.craterRoot.children.length % 7) * 0.0015, effect.to.z);
          scorch.scale.setScalar(Math.max(0.8, (effect.radius ?? 1) * 0.85));
          this.craterRoot.add(scorch);
          if (this.craterRoot.children.length > 40) this.craterRoot.remove(this.craterRoot.children[0]);
        }
        const ring = new THREE.Mesh(
          new THREE.RingGeometry((effect.radius ?? 1) * t, (effect.radius ?? 1) * t + 0.08, 32),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.7, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(effect.to.x, 0.08, effect.to.z);
        this.effectRoot.add(ring);
        // White-hot core that punches through the bloom threshold for the blast's first
        // beats. Additive so it reads as light, not a solid white egg.
        if (t < 0.45) {
          const core = new THREE.Mesh(
            new THREE.SphereGeometry((effect.radius ?? 1) * (0.14 + t * 0.42), 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffdba6, transparent: true, opacity: (1 - t / 0.45) * 0.85, depthWrite: false, blending: THREE.AdditiveBlending })
          );
          core.position.set(effect.to.x, 0.5 + t * 0.9, effect.to.z);
          this.effectRoot.add(core);
        }
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 1) * (0.24 + t * 0.82), 12, 6),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.2, depthWrite: false, blending: THREE.AdditiveBlending })
        );
        dome.scale.y = 0.36;
        dome.position.set(effect.to.x, 0.22 + t * 0.36, effect.to.z);
        this.effectRoot.add(dome);
        // Ember spray arcing out of the blast.
        const embers = new THREE.Group();
        embers.position.set(effect.to.x, 0.3, effect.to.z);
        addEmbers(embers, 4, 0xffb02e, (effect.radius ?? 1) * (0.4 + t * 0.9), 0.4 + t * 1.2, effect.age);
        this.effectRoot.add(embers);
      } else {
        // Additive with capped growth — the old opaque 2x-growing sphere wrapped the
        // whole unit in a colored balloon on heavy hits.
        const hit = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 0.45) * (0.65 + t * 0.45), 10, 8),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.42, depthWrite: false, blending: THREE.AdditiveBlending })
        );
        hit.position.set(effect.to.x, 0.8, effect.to.z);
        this.effectRoot.add(hit);
        const impactRing = new THREE.Mesh(
          new THREE.RingGeometry((effect.radius ?? 0.45) * (0.35 + t * 0.85), (effect.radius ?? 0.45) * (0.35 + t * 0.85) + 0.04, 24),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.52, side: THREE.DoubleSide, depthWrite: false })
        );
        impactRing.rotation.x = -Math.PI / 2;
        impactRing.position.set(effect.to.x, 0.11, effect.to.z);
        this.effectRoot.add(impactRing);
        // A few hot sparks kicked off the impact point.
        const sparks = new THREE.Group();
        sparks.position.set(effect.to.x, 0.65, effect.to.z);
        addEmbers(sparks, 3, 0xffd27a, 0.25 + t * 0.55, 0.12, effect.age);
        this.effectRoot.add(sparks);
      }
    }
  }
}

function emptyDebug(): WorldRenderDebug {
  return {
    previewLabels: 0,
    splashRings: 0,
    affectedMarkers: 0,
    orderMarkers: 0,
    floatingLabels: 0,
    unitMarkers: 0,
    ghostedEntities: [],
  };
}

function makeUnitMarker(entity: CombatEntity, color: number): THREE.Group {
  const group = new THREE.Group();
  const radius = Math.max(0.18, Math.min(0.48, entity.radius * 0.34));
  const ringMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  const pipMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + 0.035, 24),
    ringMaterial
  );
  ring.rotation.x = -Math.PI / 2;
  const pip = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.34, 18),
    pipMaterial
  );
  pip.rotation.x = -Math.PI / 2;
  pip.position.y = 0.015;
  group.userData.ringMaterial = ringMaterial;
  group.userData.pipMaterial = pipMaterial;
  group.add(ring, pip);
  // No floating type tag — each unit's distinct silhouette (built in buildSoldier /
  // buildTank) is what identifies its kind now, so the battlefield stays uncluttered.
  updateUnitMarker(group, entity, color, 0.5);
  return group;
}

function updateUnitMarker(marker: THREE.Group, entity: CombatEntity, color: number, pulse: number): void {
  const y = entity.elevation + entity.height + 0.32;
  marker.position.set(entity.position.x, y, entity.position.z);
  const ringMaterial = marker.userData.ringMaterial as THREE.MeshBasicMaterial | undefined;
  if (ringMaterial) {
    ringMaterial.color.setHex(color);
    ringMaterial.opacity = 0.64 + pulse * 0.18;
  }
}

function makeSplashDisc(position: Vec2, color: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  const y = terrainHeightAt(position) + 0.085;
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 64),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(position.x, y, position.z);
  // A bold edge band, thickness scaled to the radius so the blast circumference reads
  // clearly from the tactical camera (a hairline ring is invisible at this zoom).
  const band = Math.max(0.2, radius * 0.12);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.05, radius - band), radius + 0.05, 72),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(position.x, y + 0.012, position.z);
  group.add(fill, ring);
  return group;
}

// A flat filled wedge on the ground — the overwatch watch cone — with its bisector pointing
// along `facing` (a yaw, atan2(dx,dz) convention). The sector is built symmetric about the
// mesh's local +X (which maps to world +X once laid flat), then the parent group is turned by
// `facing - PI/2` so the wedge points where the unit is watching. A full-circle wedge
// (halfAngle = PI) is the legacy 360° watch fallback.
function makeWatchCone(center: Vec2, y: number, radius: number, facing: number, halfAngle: number, color: number, opacity: number): THREE.Group {
  const group = new THREE.Group();
  // Translucent wedge fill.
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48, -halfAngle, halfAngle * 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })
  );
  fill.rotation.x = -Math.PI / 2;
  group.add(fill);
  // A bright outer arc band so the kill-zone edge reads clearly on any ground color.
  const band = Math.max(0.16, radius * 0.045);
  const arc = new THREE.Mesh(
    new THREE.RingGeometry(radius - band, radius, 48, 1, -halfAngle, halfAngle * 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: Math.min(0.95, opacity + 0.55), side: THREE.DoubleSide, depthWrite: false })
  );
  arc.rotation.x = -Math.PI / 2;
  arc.position.y = 0.006;
  group.add(arc);
  group.position.set(center.x, y, center.z);
  group.rotation.y = facing - Math.PI / 2;
  return group;
}

// How long a floating damage number lives, how long a hit-flash on a part lasts (ms), and the
// cap on concurrent floating numbers (bounds worst-case draw calls in a huge melee).
const DAMAGE_NUMBER_MS = 950;
const DAMAGE_FLASH_MS = 320;
// How long a whole-body hit flinch lasts (ms). Short + snappy — a strike, not a stumble.
const FLINCH_MS = 300;
const MAX_FLOATING_NUMBERS = 24;

// Ceiling height (world units) the ambient particle bed drifts within.
const AMBIENT_CEIL = 7;

// Per-kind drift + look for the ambient particle bed. windX/windZ = lateral drift, vy = vertical
// (positive rises like embers, negative falls like snow), plus point size and opacity.
function ambientMotion(kind: AmbientKind): { windX: number; windZ: number; vy: number; size: number; opacity: number } {
  switch (kind) {
    case "embers": return { windX: 0.25, windZ: 0.12, vy: 0.55, size: 0.12, opacity: 0.85 };
    case "snow": return { windX: 0.22, windZ: 0.1, vy: -0.5, size: 0.17, opacity: 0.72 };
    case "ash": return { windX: 0.3, windZ: 0.12, vy: -0.22, size: 0.13, opacity: 0.5 };
    case "pollen": return { windX: 0.3, windZ: 0.28, vy: 0.04, size: 0.1, opacity: 0.5 };
    default: return { windX: 0.8, windZ: 0.22, vy: 0.08, size: 0.14, opacity: 0.5 }; // dust
  }
}

// Parse the trailing integer out of a "damage-N" report id.
function damageSeqOf(id: string): number {
  const n = Number(id.slice(id.lastIndexOf("-") + 1));
  return Number.isFinite(n) ? n : 0;
}

// Outlined, box-less number sprite for floating combat damage (cached by text+color).
function floatingNumberTexture(text: string, color: number): { texture: THREE.CanvasTexture; aspect: number } {
  const key = `dmg|${text}|${color.toString(16)}`;
  const cached = floatingNumberTextures.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    const texture = new THREE.CanvasTexture(canvas);
    const fallback = { texture, aspect: 1 };
    floatingNumberTextures.set(key, fallback);
    return fallback;
  }
  const font = "900 52px Arial, sans-serif";
  context.font = font;
  const textWidth = Math.ceil(context.measureText(text).width);
  canvas.width = Math.max(64, textWidth + 28);
  canvas.height = 72;
  context.font = font;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const fg = new THREE.Color(color);
  context.lineWidth = 8;
  context.strokeStyle = "rgba(6, 8, 10, 0.92)";
  context.lineJoin = "round";
  context.strokeText(text, canvas.width / 2, canvas.height / 2);
  context.fillStyle = `rgb(${Math.round(fg.r * 255)}, ${Math.round(fg.g * 255)}, ${Math.round(fg.b * 255)})`;
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const record = { texture, aspect: canvas.width / canvas.height };
  floatingNumberTextures.set(key, record);
  return record;
}

function makeLabelSprite(text: string, color: number, size = 0.58, background = 0x101516, opacity = 0.94): THREE.Sprite {
  const textureRecord = labelTexture(text, color, background);
  const material = new THREE.SpriteMaterial({ map: textureRecord.texture, transparent: true, opacity, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(textureRecord.aspect * size, size, 1);
  return sprite;
}

// Preview-label keys are high-cardinality ("<amount> dmg / <hitChance>%" over every target/part/
// range/cover combo), so this cache is LRU-capped — without a bound it grew a fresh CanvasTexture
// (GPU memory) for every distinct label seen across a long match.
const LABEL_TEXTURE_CAP = 120;

function labelTexture(text: string, color: number, background: number): { texture: THREE.CanvasTexture; aspect: number } {
  const key = `${text}|${color.toString(16)}|${background.toString(16)}`;
  const cached = labelTextures.get(key);
  if (cached) {
    labelTextures.delete(key); // LRU touch: move to the most-recently-used end
    labelTextures.set(key, cached);
    return cached;
  }
  if (labelTextures.size >= LABEL_TEXTURE_CAP) {
    const oldest = labelTextures.keys().next().value;
    if (oldest !== undefined) {
      labelTextures.get(oldest)?.texture.dispose();
      labelTextures.delete(oldest);
    }
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    const texture = new THREE.CanvasTexture(canvas);
    const fallback = { texture, aspect: 1 };
    labelTextures.set(key, fallback);
    return fallback;
  }

  context.font = "700 30px Arial, sans-serif";
  const paddingX = 18;
  const paddingY = 12;
  const textWidth = Math.ceil(context.measureText(text).width);
  canvas.width = Math.max(74, textWidth + paddingX * 2);
  canvas.height = 62;
  context.font = "700 30px Arial, sans-serif";
  context.textBaseline = "middle";

  const bg = new THREE.Color(background);
  const fg = new THREE.Color(color);
  context.fillStyle = `rgba(${Math.round(bg.r * 255)}, ${Math.round(bg.g * 255)}, ${Math.round(bg.b * 255)}, 0.88)`;
  roundRect(context, 0, 0, canvas.width, canvas.height, 12);
  context.fill();
  context.strokeStyle = `rgba(${Math.round(fg.r * 255)}, ${Math.round(fg.g * 255)}, ${Math.round(fg.b * 255)}, 1)`;
  context.lineWidth = 3;
  roundRect(context, 1.5, 1.5, canvas.width - 3, canvas.height - 3, 10);
  context.stroke();
  context.fillStyle = "#f7fbff";
  context.fillText(text, paddingX, canvas.height / 2 + paddingY * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const record = { texture, aspect: canvas.width / canvas.height };
  labelTextures.set(key, record);
  return record;
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function splashRadiusFor(kind: Projectile["kind"]): number {
  if (kind === "grenade") return 2.55;
  if (kind === "shell") return 1.75;
  return 0;
}

function projectileStyle(projectile: Projectile): {
  trailColor: number;
} {
  if (projectile.kind === "shell") {
    return {
      trailColor: projectile.color,
    };
  }
  if (projectile.kind === "bolt") {
    return {
      trailColor: 0xffd166,
    };
  }
  if (projectile.kind === "grenade") {
    if (projectile.state === "rolling") {
      return {
        trailColor: 0xffbf69,
      };
    }
    return {
      trailColor: 0xffbf69,
    };
  }
  // Rifle family: brighten the marksman's tracer and give the heavy gunner a hot orange streak.
  if (projectile.sourceKind === "sniper") return { trailColor: blendHex(projectile.color, 0xffffff, 0.4) };
  if (projectile.sourceKind === "heavy") return { trailColor: 0xffae57 };
  return {
    trailColor: projectile.color,
  };
}

function orientAlongShot(mesh: THREE.Object3D, from: { x: number; z: number }, to: { x: number; z: number }): void {
  const delta = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
  if (delta.lengthSq() < 0.0001) return;
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
}

// A few small trailing embers behind a round (in the model's local frame, where -Y is the
// trailing direction). All use pooled geometry + cached materials, so they cost no GC churn.
function addEmbers(group: THREE.Group, count: number, color: number, spread: number, baseY: number, age: number): void {
  for (let i = 0; i < count; i += 1) {
    const ember = new THREE.Mesh(projectileGeometry("ember"), projectileMaterial(`ember-${i}`, color, 0.55 - i * 0.13));
    ember.position.set(Math.sin(age * 22 + i * 2.1) * spread, baseY - i * 0.16, Math.cos(age * 19 + i * 1.7) * spread);
    ember.scale.setScalar(1 - i * 0.22);
    group.add(ember);
  }
}

function makeProjectileModel(projectile: Projectile): THREE.Group {
  const group = new THREE.Group();
  const src = projectile.sourceKind;
  const team = projectile.color;
  if (projectile.kind === "shell") {
    // Siege shells: artillery is the biggest with 6 fins and a smoky tail, the mortar turret
    // lobs a fat blunt-nosed bomb, the tank fires a sleek AP round. All spin-stabilise in flight.
    const heavy = src === "artillery";
    const bomb = src === "exturret";
    const body = new THREE.Mesh(projectileGeometry("shell-body"), projectileMaterial("shell-body", 0xbfd1cc, 0.98));
    const nose = new THREE.Mesh(projectileGeometry("shell-nose"), projectileMaterial("shell-nose", team, 0.98));
    const exhaust = new THREE.Mesh(projectileGeometry("shell-exhaust"), projectileMaterial("shell-exhaust", 0xffd166, 0.72, true));
    // A ragged flame cone licking off the tail, flickering with age.
    const flame = new THREE.Mesh(projectileGeometry("rifle-tail"), projectileMaterial("shell-flame", 0xff9a3c, 0.8, true));
    flame.position.y = -0.42;
    flame.rotation.x = Math.PI;
    flame.scale.set(1.6, 1.9 + Math.sin(projectile.age * 31) * 0.5, 1.6);
    group.add(flame);
    const bandA = new THREE.Mesh(projectileGeometry("shell-band"), projectileMaterial("shell-band-a", 0x1d2426, 0.9));
    const bandB = new THREE.Mesh(projectileGeometry("shell-band"), projectileMaterial("shell-band-b", team, 0.88));
    nose.position.y = 0.33;
    if (bomb) { nose.scale.set(1.35, 0.62, 1.35); nose.position.y = 0.26; }
    exhaust.position.y = -0.32;
    exhaust.scale.setScalar((1.08 + Math.sin(projectile.age * 24) * 0.16) * (heavy ? 1.45 : 1));
    bandA.position.y = 0.02;
    bandB.position.y = -0.14;
    bandA.rotation.x = Math.PI / 2;
    bandB.rotation.x = Math.PI / 2;
    bandA.scale.setScalar(0.95);
    bandB.scale.setScalar(0.78);
    const finCount = heavy ? 6 : 4;
    for (let i = 0; i < finCount; i += 1) {
      const angle = (i / finCount) * Math.PI * 2;
      const fin = new THREE.Mesh(projectileGeometry("shell-fin"), projectileMaterial("shell-fin", 0x6e7a78, 0.92));
      fin.position.set(Math.cos(angle) * 0.13, -0.18, Math.sin(angle) * 0.13);
      fin.rotation.y = angle;
      group.add(fin);
    }
    group.add(body, nose, exhaust, bandA, bandB);
    group.rotation.y = projectile.age * (heavy ? 6 : 11);
    if (heavy) addEmbers(group, 3, 0xffae57, 0.12, -0.34, projectile.age);
    // Sized against the 3.4-unit GLB tank — the old 1.14 base read as a toy bullet a
    // third of the vehicle's length.
    group.scale.setScalar(0.82 * (heavy ? 1.3 : bomb ? 1.12 : 1));
    return group;
  }
  if (projectile.kind === "bolt") {
    // Energy bolts: the APC autogun spits small fast bolts, the Home Base lobs a heavy haloed
    // core, turrets fire the standard round. Cores pulse inside an additive plasma shell;
    // containment rings counter-spin.
    const small = src === "apc";
    const big = src === "base";
    const core = new THREE.Mesh(projectileGeometry("bolt-core"), projectileMaterial("bolt-core", 0xfff6d8, 0.98, true));
    const shell = new THREE.Mesh(projectileGeometry("bolt-core"), projectileMaterial("bolt-shell", 0xffd166, 0.5, true));
    shell.scale.setScalar(1.7 + Math.sin(projectile.age * 22) * 0.18);
    group.add(shell);
    // Crackling containment arcs: jagged lines whipping around the core, re-seeded by age.
    for (let a = 0; a < 2; a += 1) {
      const seed = projectile.age * 31 + a * 4.1;
      const points: THREE.Vector3[] = [];
      for (let p = 0; p <= 4; p += 1) {
        const angle = seed + (p / 4) * Math.PI * 1.4;
        const r = 0.14 + Math.abs(Math.sin(seed * 2.7 + p * 3.3)) * 0.1;
        points.push(new THREE.Vector3(Math.cos(angle) * r, Math.sin(angle * 1.6 + a) * r * 0.8, Math.sin(angle) * r));
      }
      const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial(0xfff1a6, 0.65));
      group.add(arc);
    }
    const ringA = new THREE.Mesh(projectileGeometry("bolt-ring"), projectileMaterial("bolt-ring-a", 0xfff1a6, 0.62, true));
    const ringB = new THREE.Mesh(projectileGeometry("bolt-ring"), projectileMaterial("bolt-ring-b", team, 0.5, true));
    ringA.rotation.x = Math.PI / 2;
    ringB.rotation.x = Math.PI / 2;
    ringA.rotation.z = projectile.age * (small ? 10 : 6);
    ringB.rotation.z = Math.PI / 2 - projectile.age * (small ? 12 : 8);
    ringA.scale.setScalar(0.92);
    ringB.scale.setScalar(0.68);
    core.scale.setScalar(1 + Math.sin(projectile.age * 18) * 0.1);
    group.add(core, ringA, ringB);
    if (big) {
      const halo = new THREE.Mesh(projectileGeometry("bolt-ring"), projectileMaterial("bolt-ring-c", 0xfff1a6, 0.32));
      halo.rotation.x = Math.PI / 2;
      halo.rotation.z = projectile.age * 4;
      halo.scale.setScalar(1.25);
      group.add(halo);
    }
    group.scale.setScalar(1.18 * (small ? 0.78 : big ? 1.35 : 1));
    return group;
  }
  if (projectile.kind === "grenade") {
    const mortar = src === "mortar";
    const body = new THREE.Mesh(projectileGeometry("grenade-body"), projectileMaterial("grenade-body", 0x2f342a, 0.98));
    const band = new THREE.Mesh(projectileGeometry("grenade-band"), projectileMaterial("grenade-band", 0xffbf69, 0.82));
    const spark = new THREE.Mesh(projectileGeometry("grenade-spark"), projectileMaterial("grenade-spark", 0xfff1a6, 0.6, true));
    // Armed-fuse blink: a red pip strobing faster as it flies — reads as "live ordnance".
    const fuse = new THREE.Mesh(
      projectileGeometry("ember"),
      projectileMaterial("grenade-fuse", 0xff3b30, Math.sin(projectile.age * 26) > 0 ? 0.95 : 0.15, true),
    );
    fuse.position.y = 0.16;
    fuse.scale.setScalar(1.5);
    group.add(fuse);
    band.rotation.x = Math.PI / 2;
    band.rotation.z = projectile.age * (projectile.state === "rolling" ? 20 : 9);
    spark.position.y = projectile.state === "rolling" ? -0.02 : -0.18;
    spark.position.x = projectile.state === "rolling" ? Math.sin(projectile.age * 18) * 0.12 : 0;
    spark.scale.setScalar((projectile.state === "rolling" ? 0.72 : 1) + Math.sin(projectile.age * 18) * 0.18);
    group.add(body, band, spark);
    // Mortar bomb: tail fins and a heavier body that tumbles end-over-end through its arc.
    if (mortar && projectile.state !== "rolling") {
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const fin = new THREE.Mesh(projectileGeometry("shell-fin"), projectileMaterial("mortar-fin", 0x4a4f33, 0.92));
        fin.position.set(Math.cos(angle) * 0.12, 0.16, Math.sin(angle) * 0.12);
        fin.rotation.y = angle;
        fin.scale.set(0.6, 0.7, 0.6);
        group.add(fin);
      }
      group.rotation.x = projectile.age * 5;
    }
    if (projectile.state === "rolling") group.rotation.z = projectile.age * 8;
    group.scale.setScalar((projectile.state === "rolling" ? 0.94 : 1.08) * (mortar ? 1.22 : 1));
    return group;
  }
  // Rifle family: the marksman fires a long bright tracer, the scout a small fast dart, the
  // heavy gunner a fat hot round; everyone else the standard sparking tracer.
  const sniper = src === "sniper";
  const scout = src === "scout";
  const heavyGun = src === "heavy";
  const tipColor = heavyGun ? 0xffb24a : team;
  // Additive throughout: a rifle round is a streak of light, not a painted pellet.
  const slug = new THREE.Mesh(projectileGeometry("rifle-slug"), projectileMaterial("rifle-slug", 0xfffbe8, 0.98, true));
  const tip = new THREE.Mesh(projectileGeometry("rifle-tip"), projectileMaterial("rifle-tip", tipColor, 0.96, true));
  const spark = new THREE.Mesh(projectileGeometry("rifle-spark"), projectileMaterial("rifle-spark", heavyGun ? 0xffd08a : 0xfff1a6, 0.72, true));
  const tailA = new THREE.Mesh(projectileGeometry("rifle-tail"), projectileMaterial("rifle-tail-a", tipColor, 0.42, true));
  const tailB = new THREE.Mesh(projectileGeometry("rifle-tail"), projectileMaterial("rifle-tail-b", 0xeaffff, 0.28, true));
  tip.position.y = 0.18;
  spark.position.y = -0.2;
  tailA.position.y = -0.24;
  tailB.position.y = -0.34;
  tailB.scale.setScalar(0.72);
  group.add(slug, tip, spark, tailA, tailB);
  if (sniper) {
    group.scale.set(0.74, 1.7, 0.74);
    const streak = new THREE.Mesh(projectileGeometry("rifle-tail"), projectileMaterial("rifle-streak", team, 0.22));
    streak.position.y = -0.5;
    streak.scale.set(0.6, 1.8, 0.6);
    group.add(streak);
  } else if (scout) {
    group.scale.setScalar(0.78);
  } else if (heavyGun) {
    group.scale.set(1.32, 1.05, 1.32);
    addEmbers(group, 2, 0xffae57, 0.07, -0.3, projectile.age);
  } else {
    addEmbers(group, 2, 0xffe6b0, 0.05, -0.3, projectile.age);
  }
  return group;
}

// A quick bright flash at the muzzle on the first frames of a round's life. Drawn at the
// projectile's stored origin (the muzzle point), so it needs no separate sim event.
const RECOIL_TIME = 0.16;
const MUZZLE_FLASH_TIME = 0.12;
function makeMuzzleFlash(projectile: Projectile): THREE.Object3D | undefined {
  if (projectile.kind === "grenade" || projectile.age > MUZZLE_FLASH_TIME) return undefined;
  const t = clamp01(projectile.age / MUZZLE_FLASH_TIME);
  const fade = 1 - t;
  const scale = muzzleFlashScale(projectile) * (0.55 + t * 0.9);
  const group = new THREE.Group();
  const core = new THREE.Mesh(projectileGeometry("muzzle-flash"), projectileMaterial("muzzle-core", 0xfff4cf, 0.9 * fade));
  core.scale.setScalar(scale);
  const glow = new THREE.Mesh(projectileGeometry("muzzle-flash"), projectileMaterial("muzzle-glow", blendHex(projectile.color, 0xffd27a, 0.5), 0.4 * fade));
  glow.scale.setScalar(scale * 1.9);
  group.add(core, glow);
  group.position.set(projectile.origin.x, projectile.originHeight, projectile.origin.z);
  return group;
}

function muzzleFlashScale(p: Projectile): number {
  if (p.kind === "shell") return p.sourceKind === "artillery" ? 1.5 : 1.2;
  if (p.kind === "bolt") return p.sourceKind === "base" ? 1.2 : 0.85;
  if (p.sourceKind === "heavy") return 0.8;
  if (p.sourceKind === "sniper") return 0.7;
  return 0.55;
}

function makeProjectileShadow(projectile: Projectile, color: number): THREE.Mesh {
  const groundY = terrainHeightAt(projectile.position) + 0.028;
  const heightAboveGround = Math.max(0, projectile.height - groundY);
  const radius = projectile.kind === "shell" ? 0.46 : projectile.kind === "grenade" ? projectile.state === "rolling" ? 0.24 : 0.38 : projectile.kind === "bolt" ? 0.34 : 0.22;
  const opacity = projectile.state === "rolling" ? 0.24 : Math.max(0.1, 0.28 - heightAboveGround * 0.035);
  const shadow = new THREE.Mesh(
    projectileShadowGeometry(radius),
    projectileShadowMaterial(projectile.kind === "bolt" ? color : 0x000000, opacity)
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(projectile.position.x, groundY, projectile.position.z);
  shadow.scale.z = 0.55;
  return shadow;
}

function roleColor(entity: CombatEntity, role: PartRole, fallback: number): number {
  if (entity.team === "enemy" && entity.kind !== "cover") {
    if (role === "weapon") return 0xffd2bd;
    if (role === "mobility") return 0x211a1b;
    if (role === "head") return 0xffc5a8;
    if (role === "utility") return 0xff9c75;
    if (role === "volatile") return 0xff7d38;
    return blendHex(fallback, TEAMS.enemyBlend, 0.68);
  }
  if (entity.team === "player") {
    if (role === "weapon") return 0xeaffff;
    if (role === "mobility") return 0x172328;
    if (role === "head") return 0xf2dfbf;
    if (role === "utility") return 0x8ff2d1;
    if (role === "volatile") return 0xffd06a;
    if (role === "core") return blendHex(fallback, 0x7fe8ff, 0.42);
    return blendHex(fallback, 0x5bc6e5, 0.22);
  }
  return fallback;
}

function blendHex(a: number, b: number, amount: number): number {
  const color = new THREE.Color(a).lerp(new THREE.Color(b), amount);
  return color.getHex();
}

function makeLine(from: { x: number; z: number }, to: { x: number; z: number }, color: number, opacity: number, y = 0.16, toY = y): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, y, from.z),
    new THREE.Vector3(to.x, toY, to.z),
  ]);
  const mat = lineMaterial(color, opacity);
  return new THREE.Line(geo, mat);
}

// A frame-scoped pool of 2-vertex lines for the projectile + effect roots — both are disposed and
// rebuilt EVERY frame during resolve, so `makeLine` there was the dominant per-frame allocator
// (up to 5 trail segments per round) and the source of the resolve-phase GC jank. Pooled geometry
// is tagged shared so disposeSubtree only detaches it; the index resets once per frame. NOT for the
// command-phase overlay roots — those are conditionally skipped and keep their lines across frames.
const fxLinePool: THREE.Line[] = [];
let fxLineIdx = 0;
function resetFxLinePool(): void { fxLineIdx = 0; }
function fxLine(from: { x: number; z: number }, to: { x: number; z: number }, color: number, opacity: number, y = 0.16, toY = y): THREE.Line {
  let line = fxLinePool[fxLineIdx];
  if (!line) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    geo.userData.shared = true; // pooled — disposeSubtree detaches but never frees it
    line = new THREE.Line(geo, lineMaterial(color, opacity));
    line.frustumCulled = false; // tiny overlay lines always near the action — skip the cull test
    fxLinePool[fxLineIdx] = line;
  }
  fxLineIdx += 1;
  const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  pos.setXYZ(0, from.x, y, from.z);
  pos.setXYZ(1, to.x, toY, to.z);
  pos.needsUpdate = true;
  line.material = lineMaterial(color, opacity);
  return line;
}

function makeTubeLine(
  from: { x: number; z: number },
  to: { x: number; z: number },
  color: number,
  opacity: number,
  y = 0.18,
  radius = 0.035,
  toY = y
): THREE.Object3D {
  const start = new THREE.Vector3(from.x, y, from.z);
  const end = new THREE.Vector3(to.x, toY, to.z);
  const delta = new THREE.Vector3().subVectors(end, start);
  const length = delta.length();
  if (length < 0.01) return new THREE.Group();

  const mesh = new THREE.Mesh(
    tubeGeometry(radius),
    tubeMaterial(color, opacity)
  );
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.y = length;
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

function makeEndpoint(position: { x: number; z: number }, color: number, radius: number, y = 0.12): THREE.Mesh {
  const marker = new THREE.Mesh(
    endpointGeometry(radius),
    endpointMaterial(color)
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.set(position.x, y, position.z);
  return marker;
}

function makeArcLine(
  from: { x: number; z: number },
  to: { x: number; z: number },
  color: number,
  opacity: number,
  fromHeight: number,
  toHeight: number,
  arcHeight: number
): THREE.Line {
  const points = trajectoryPoints(from, to, fromHeight, toHeight, arcHeight, 18);
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial(color, opacity, false));
}

function makeArcTubeLine(
  from: { x: number; z: number },
  to: { x: number; z: number },
  color: number,
  opacity: number,
  fromHeight: number,
  toHeight: number,
  arcHeight: number,
  radius: number
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(trajectoryPoints(from, to, fromHeight, toHeight, arcHeight, 14));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 14, radius, 8, false), tubeMaterial(color, opacity));
}

function trajectoryPoints(
  from: { x: number; z: number },
  to: { x: number; z: number },
  fromHeight: number,
  toHeight: number,
  arcHeight: number,
  segments: number
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const y = fromHeight + (toHeight - fromHeight) * t + Math.sin(Math.PI * t) * arcHeight;
    points.push(new THREE.Vector3(x, y, z));
  }
  return points;
}

function makeBeam(from: { x: number; z: number }, to: { x: number; z: number }, color: number, opacity: number): THREE.Group {
  const group = new THREE.Group();
  group.add(makeLine(from, to, color, opacity));
  group.add(makeLine({ x: from.x, z: from.z + 0.04 }, { x: to.x, z: to.z + 0.04 }, 0xffffff, opacity * 0.45));
  return group;
}

function infantryPalette(kind: string): { body: number; trim: number; pack: number } {
  switch (kind) {
    case "scout": return { body: 0x7fe0a0, trim: 0xeafff0, pack: 0x2f6e4a };
    case "sniper": return { body: 0x5cc9ff, trim: 0xf0fdff, pack: 0x16486a };
    case "striker": return { body: 0xd28cff, trim: 0xffffff, pack: 0x4a2b78 };
    case "heavy": return { body: 0xc06a3a, trim: 0xffd9b0, pack: 0x5a2f18 };
    case "grenadier": return { body: 0xffb23f, trim: 0xfff0ba, pack: 0x784214 };
    case "mortar": return { body: 0xe0a64f, trim: 0xfff0c8, pack: 0x6a4a1a };
    case "medic": return { body: 0xff7f8f, trim: 0xffffff, pack: 0x7a1f2a };
    case "engineer": return { body: 0xe0c24a, trim: 0xfff6c0, pack: 0x6a5a18 };
    case "flamer": return { body: 0xff8a4a, trim: 0xffe2c4, pack: 0x8a2f10 };
    case "droneop": return { body: 0x9fb8d8, trim: 0xf0f6ff, pack: 0x2c4a6a };
    case "sapper": return { body: 0xd8c06a, trim: 0xfff2c8, pack: 0x5a4a1a };
    default: return { body: 0x26f0c8, trim: 0xeaffff, pack: 0x1d5f66 };
  }
}

// Terrain is built from flat-topped raised rectangles. Render each as a crisp box: shaded
// sides, an accent-toned cap, and a dark edge outline so steps read clearly from any angle.
function makeTerrainBlocks(groundColor: number, accentColor: number): THREE.Group {
  const group = new THREE.Group();
  const sideColor = new THREE.Color(groundColor).multiplyScalar(0.66);
  const capColor = new THREE.Color(accentColor).lerp(new THREE.Color(0xffffff), 0.1);
  const sideMaterial = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.95, metalness: 0.03 });
  // polygonOffset keeps the cap's top from z-fighting the body when surfaces nearly coincide.
  const capMaterial = new THREE.MeshStandardMaterial({ color: capColor, roughness: 0.9, metalness: 0.03, emissive: 0x1c1208, emissiveIntensity: 0.08, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const CAP = 0.1;
  for (const block of terrainBlocks()) {
    const w = block.maxX - block.minX;
    const d = block.maxZ - block.minZ;
    const cx = (block.minX + block.maxX) / 2;
    const cz = (block.minZ + block.maxZ) / 2;
    // The body stops one cap-thickness short of the top; the cap sits flush on top of it so no
    // two same-facing surfaces share the block-top plane (the source of the zoom z-fighting).
    const bodyHeight = Math.max(0.05, block.height - CAP);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, bodyHeight, d), sideMaterial);
    body.position.set(cx, bodyHeight / 2, cz);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, CAP, d + 0.02), capMaterial);
    cap.position.set(cx, block.height - CAP / 2, cz);
    cap.receiveShadow = true;
    cap.castShadow = true;
    group.add(cap);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(body.geometry),
      new THREE.LineBasicMaterial({ color: 0x04070a, transparent: true, opacity: 0.42 })
    );
    edges.position.copy(body.position);
    group.add(edges);
  }
  return group;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Free the GPU geometry of every Mesh/Line under `obj` before it is detached, so rebuilt
// overlays + swapped scenes don't leak buffers (renderer.info.memory.geometries climbing is
// the symptom). Deliberately conservative:
//   * geometry ONLY — materials/textures are often shared (label sprites, pooled materials),
//     and they are a separate counter; freeing geometry fixes the measured leak with no risk.
//   * Sprites are skipped — THREE.Sprite.geometry is a single module-shared geometry; disposing
//     it would break every sprite.
//   * geometries tagged `userData.shared` (the pooled projectile/tube/ring caches) are skipped.
// Which Meshy GLB (if any) stands in for this entity. Infantry keep their procedural
// bodies (walk cycle + per-part damage posing), walls stay parametric, and glow-signal
// props (ammo/fuel/conduit) keep their emissive gameplay cue.
// A vertical gradient sky derived from the map theme: deep zenith fading through the
// theme's sky color into a warm fogged horizon band, so every map gets atmosphere depth
// instead of a flat color backdrop.
function makeThemeSky(theme: MapTheme): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const sky = new THREE.Color(theme.sky);
    const zenith = sky.clone().multiplyScalar(0.42).lerp(new THREE.Color(0x101b30), 0.35);
    const horizon = sky.clone().lerp(new THREE.Color(theme.fog), 0.65).multiplyScalar(1.08);
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, `#${zenith.getHexString()}`);
    gradient.addColorStop(0.45, `#${sky.getHexString()}`);
    gradient.addColorStop(1, `#${horizon.getHexString()}`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function modelKeyFor(entity: CombatEntity): ModelKey | null {
  switch (entity.kind) {
    case "tank": return "tank";
    case "apc": return "apc";
    case "artillery": return "artillery";
    case "base": return "hq";
    case "turret": return "turret";
    // exturret stays procedural: two Meshy attempts both produced sprawled/flat tube
    // heaps — the authored angled-mortar emplacement reads far better.
    case "cover":
      if (entity.parts[0]?.role === "volatile") return null;
      switch (entity.coverKind) {
        case "barricade": return "barricade";
        case "sandbag": return "sandbags";
        case "crate": return "crates";
        case "rock": return "rock";
        case "rubble": return "rock";
        default: return null;
      }
    default: return null;
  }
}

// Invisible raycast boxes approximating where each damage-model part sits on the GLB —
// sized/positioned to match the procedural builders they replace so part-aiming feels
// identical. Raycaster ignores `visible`, so these cost zero draw calls.
const PICK_PROXY_LAYOUTS: Record<string, [string, [number, number, number], [number, number, number]][]> = {
  tank: [
    ["hull", [2.4, 0.9, 1.5], [0, 0.55, 0]],
    ["front-plate", [2.3, 0.5, 0.3], [0, 0.65, 0.85]],
    ["left-tread", [0.45, 0.6, 1.8], [-1.25, 0.3, 0]],
    ["right-tread", [0.45, 0.6, 1.8], [1.25, 0.3, 0]],
    ["turret", [1.2, 0.6, 1.0], [0, 1.25, 0]],
    ["cannon", [0.35, 0.35, 1.7], [0, 1.2, 1.2]],
  ],
  apc: [
    ["hull", [2.2, 1.4, 1.5], [0, 0.9, 0]],
    ["front-plate", [2.1, 0.7, 0.3], [0, 1.0, 0.75]],
    ["left-tread", [0.45, 0.6, 1.8], [-1.2, 0.3, 0]],
    ["right-tread", [0.45, 0.6, 1.8], [1.2, 0.3, 0]],
    ["turret", [0.7, 0.4, 0.8], [0, 1.7, 0.08]],
    ["cannon", [0.25, 0.25, 0.9], [0.16, 1.8, 0.5]],
  ],
  artillery: [
    ["hull", [2.4, 0.9, 1.6], [0, 0.55, -0.3]],
    ["front-plate", [2.3, 0.5, 0.3], [0, 0.65, 0.6]],
    ["left-tread", [0.45, 0.6, 1.9], [-1.25, 0.3, -0.2]],
    ["right-tread", [0.45, 0.6, 1.9], [1.25, 0.3, -0.2]],
    ["turret", [1.2, 0.6, 1.0], [0, 1.25, -0.2]],
    ["cannon", [0.35, 0.35, 2.6], [0, 1.35, 1.3]],
  ],
  base: [
    ["core", [2.6, 1.7, 2.2], [0, 0.85, 0]],
    ["comms", [0.5, 1.9, 0.5], [-0.9, 2.2, -0.15]],
    ["power", [0.95, 1.1, 0.95], [0.9, 0.6, -0.6]],
    ["gate", [2.7, 0.8, 0.5], [0, 0.4, 1.2]],
  ],
  turret: [
    ["mount", [1.8, 0.6, 1.8], [0, 0.3, 0]],
    ["gun", [0.9, 0.6, 2.0], [0, 0.95, 0.4]],
    ["sensor", [0.5, 0.5, 0.5], [-0.26, 1.25, -0.12]],
  ],
  exturret: [
    ["mount", [1.8, 0.6, 1.8], [0, 0.3, 0]],
    ["gun", [1.2, 1.0, 1.2], [0, 1.1, 0.05]],
    ["ammo", [0.75, 0.55, 0.6], [0, 0.62, -0.7]],
  ],
};

const _pickProxyMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
_pickProxyMaterial.userData.shared = true;
function pickProxyMaterial(): THREE.MeshBasicMaterial {
  return _pickProxyMaterial;
}

// Infantry part ids that earn a silhouette outline (each outline = one extra draw call).
const OUTLINED_PARTS = new Set(["body", "head", "legs"]);

// Team read colors, swappable for the colorblind high-contrast palette (blue vs orange).
// Mutated in place; bumping TEAMS.version makes the renderer rebuild every entity group.
const TEAMS = {
  version: 0,
  enemyAccent: 0xff6d57,
  enemyMarker: 0xff8f7f,
  enemyGlowDim: 0x4f160f,
  enemyBlend: 0xe66e5c,
  playerGlowDim: 0x063a44,
  playerAccentGlow: 0x5ff1ff,
};
const TEAMS_DEFAULT = { ...TEAMS };
const TEAMS_HIGH_CONTRAST = {
  enemyAccent: 0xffa11e,
  enemyMarker: 0xffb020,
  enemyGlowDim: 0x4f3300,
  enemyBlend: 0xf0a030,
  playerGlowDim: 0x0a2a5c,
  playerAccentGlow: 0x66aaff,
};

// Shared scorch-decal resources (one texture/material/geometry for every crater).
let _scorchMat: THREE.MeshBasicMaterial | undefined;
let _scorchGeo: THREE.CircleGeometry | undefined;
function _scorchMaterial(): THREE.MeshBasicMaterial {
  if (!_scorchMat) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(48, 48, 6, 48, 48, 48);
      g.addColorStop(0, "rgba(12,9,6,0.66)");
      g.addColorStop(0.45, "rgba(20,14,9,0.42)");
      g.addColorStop(0.8, "rgba(30,22,14,0.16)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 96, 96);
      // A few radial streaks so craters aren't perfect discs.
      ctx.strokeStyle = "rgba(10,7,5,0.35)";
      ctx.lineWidth = 3;
      for (let i = 0; i < 7; i += 1) {
        const a = (i / 7) * Math.PI * 2 + 0.4;
        ctx.beginPath();
        ctx.moveTo(48 + Math.cos(a) * 14, 48 + Math.sin(a) * 14);
        ctx.lineTo(48 + Math.cos(a) * (34 + (i % 3) * 8), 48 + Math.sin(a) * (34 + (i % 3) * 8));
        ctx.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    // polygonOffset pulls the decal toward the camera in depth space so it always wins the
    // depth test against the coplanar ground — without it, the ~12mm ground gap collapses into
    // one depth bucket as the camera pulls back and the terrain occludes the scorch (it "vanishes"
    // when you zoom out). depthWrite stays off so units standing on the scar still draw over it.
    _scorchMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    _scorchMat.userData.shared = true;
  }
  return _scorchMat;
}
function _scorchGeometry(): THREE.CircleGeometry {
  if (!_scorchGeo) {
    _scorchGeo = new THREE.CircleGeometry(1, 20);
    _scorchGeo.userData.shared = true;
  }
  return _scorchGeo;
}

// Soft radial contact-shadow blob shared by every unit — anchors them to the ground far
// better than the distant PCF sun shadow alone. One shared texture/material/geometry;
// one mesh (and draw call) per unit.
let _contactShadowMaterial: THREE.MeshBasicMaterial | undefined;
let _contactShadowGeometry: THREE.CircleGeometry | undefined;
function makeContactShadow(radius: number): THREE.Mesh {
  if (!_contactShadowMaterial) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const gradient = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
      gradient.addColorStop(0, "rgba(0,0,0,0.42)");
      gradient.addColorStop(0.6, "rgba(0,0,0,0.22)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
    }
    const texture = new THREE.CanvasTexture(canvas);
    _contactShadowMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    _contactShadowMaterial.userData.shared = true;
  }
  if (!_contactShadowGeometry) {
    _contactShadowGeometry = new THREE.CircleGeometry(1, 24);
    _contactShadowGeometry.userData.shared = true;
  }
  const blob = new THREE.Mesh(_contactShadowGeometry, _contactShadowMaterial);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.024;
  blob.scale.setScalar(Math.max(0.55, radius * 1.25));
  blob.userData.decor = true;
  return blob;
}

export function disposeSubtree(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    if ((node as THREE.Sprite).isSprite) return;
    const geometry = (node as Partial<THREE.Mesh>).geometry as THREE.BufferGeometry | undefined;
    if (geometry && typeof geometry.dispose === "function" && !geometry.userData?.shared) {
      geometry.dispose();
    }
    // Also free materials. Pooled/singleton materials are tagged userData.shared and skipped, and
    // GLB clones own per-instance materials (models.ts instantiate clones them) whose textures stay
    // shared with the template (material.dispose() never frees a texture) — so this only frees the
    // per-entity (procedural part / outline / accent / GLB-clone) and per-frame overlay materials
    // that previously leaked on every unit death, group rebuild, and overlay refresh.
    const material = (node as Partial<THREE.Mesh>).material as THREE.Material | THREE.Material[] | undefined;
    if (material) {
      const list = Array.isArray(material) ? material : [material];
      for (const mat of list) {
        if (mat && typeof mat.dispose === "function" && !mat.userData?.shared) mat.dispose();
      }
    }
  });
}

// Scratch colors reused by paintPart's per-frame, per-mesh hot path (avoids allocating).
const _paintColor = new THREE.Color();
const _paintTmp = new THREE.Color();
// Scratch id->part map reused by syncEntity's per-frame traverse.
const _partById = new Map<string, DamagePart>();

// Quantized comet-tail opacities (newest segment first) — fixed values keep the cached
// line-material pool bounded.
const TRAIL_OPACITIES = [0.62, 0.4, 0.26, 0.16, 0.09, 0.05, 0.03];
// Quantized smoke-wake opacities (behind shells/grenades), same cache discipline.
const SMOKE_OPACITIES = [0.26, 0.17, 0.1, 0.05];

const tubeGeometries = new Map<string, THREE.CylinderGeometry>();
const endpointGeometries = new Map<string, THREE.RingGeometry>();
const projectileShadowGeometries = new Map<string, THREE.CircleGeometry>();
const materials = new Map<string, THREE.Material>();
const projectileGeometries = new Map<string, THREE.BufferGeometry>();
const labelTextures = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();
const floatingNumberTextures = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();

function tubeGeometry(radius: number): THREE.CylinderGeometry {
  const key = radius.toFixed(3);
  let geometry = tubeGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(radius, radius, 1, 10, 1, true);
    geometry.userData.shared = true; // pooled — never disposed by disposeSubtree
    tubeGeometries.set(key, geometry);
  }
  return geometry;
}

function endpointGeometry(radius: number): THREE.RingGeometry {
  const key = radius.toFixed(2);
  let geometry = endpointGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.RingGeometry(radius, radius + 0.08, 44);
    geometry.userData.shared = true;
    endpointGeometries.set(key, geometry);
  }
  return geometry;
}

function projectileShadowGeometry(radius: number): THREE.CircleGeometry {
  const key = radius.toFixed(2);
  let geometry = projectileShadowGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.CircleGeometry(radius, 28);
    geometry.userData.shared = true;
    projectileShadowGeometries.set(key, geometry);
  }
  return geometry;
}

function lineMaterial(color: number, opacity: number, depthWrite = true): THREE.LineBasicMaterial {
  const key = `line:${color}:${opacity.toFixed(2)}:${depthWrite ? 1 : 0}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite });
    material.userData.shared = true; // pooled across frames — disposeSubtree must never free it
    materials.set(key, material);
  }
  return material as THREE.LineBasicMaterial;
}

function tubeMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = `tube:${color}:${opacity.toFixed(2)}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    material.userData.shared = true; // pooled across frames — disposeSubtree must never free it
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

function endpointMaterial(color: number): THREE.MeshBasicMaterial {
  const key = `endpoint:${color}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false });
    material.userData.shared = true; // pooled across frames — disposeSubtree must never free it
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

function projectileShadowMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = `projectile-shadow:${color}:${opacity.toFixed(2)}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    material.userData.shared = true; // pooled across frames — disposeSubtree must never free it
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

function projectileGeometry(key: string): THREE.BufferGeometry {
  let geometry = projectileGeometries.get(key);
  if (!geometry) {
    if (key === "shell-body") {
      geometry = new THREE.CylinderGeometry(0.14, 0.16, 0.42, 16);
    } else if (key === "shell-nose") {
      geometry = new THREE.ConeGeometry(0.15, 0.3, 16);
    } else if (key === "shell-exhaust") {
      geometry = new THREE.SphereGeometry(0.14, 12, 8);
    } else if (key === "shell-band") {
      geometry = new THREE.TorusGeometry(0.16, 0.012, 8, 18);
    } else if (key === "shell-fin") {
      geometry = new THREE.BoxGeometry(0.05, 0.18, 0.34);
    } else if (key === "bolt-core") {
      geometry = new THREE.OctahedronGeometry(0.2, 0);
    } else if (key === "bolt-ring") {
      geometry = new THREE.TorusGeometry(0.26, 0.018, 8, 24);
    } else if (key === "grenade-body") {
      geometry = new THREE.IcosahedronGeometry(0.18, 1);
    } else if (key === "grenade-band") {
      geometry = new THREE.TorusGeometry(0.18, 0.014, 8, 18);
    } else if (key === "grenade-spark") {
      geometry = new THREE.SphereGeometry(0.1, 10, 8);
    } else if (key === "rifle-slug") {
      geometry = new THREE.CylinderGeometry(0.035, 0.045, 0.34, 10);
    } else if (key === "rifle-tip") {
      geometry = new THREE.SphereGeometry(0.055, 10, 8);
    } else if (key === "rifle-spark") {
      geometry = new THREE.SphereGeometry(0.08, 10, 8);
    } else if (key === "rifle-tail") {
      geometry = new THREE.ConeGeometry(0.055, 0.22, 10);
    } else if (key === "ember") {
      geometry = new THREE.SphereGeometry(0.05, 8, 6);
    } else if (key === "muzzle-flash") {
      geometry = new THREE.SphereGeometry(0.18, 12, 8);
    } else {
      geometry = new THREE.SphereGeometry(0.08, 10, 8);
    }
    geometry.userData.shared = true;
    projectileGeometries.set(key, geometry);
  }
  return geometry;
}

function projectileMaterial(key: string, color: number, opacity: number, additive = false): THREE.MeshBasicMaterial {
  const materialKey = `projectile:${key}:${color}:${opacity.toFixed(2)}:${additive ? "a" : "n"}`;
  let material = materials.get(materialKey);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    material.userData.shared = true; // pooled across frames — disposeSubtree must never free it
    materials.set(materialKey, material);
  }
  return material as THREE.MeshBasicMaterial;
}
