import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ParticleShape, Particles } from "./particles";
import { hasMotionBank, sampleMotion } from "./infantryMotion";
import { clamp, clamp01, dist, pointToSegmentDistance, segmentProgress, type Vec2 } from "../core/math";
import { isBuildingKind, isDefenseKind, isInfantryKind, isVehicleKind, type CombatEntity, type DamagePart, type EntityKind, type PartRole } from "../game/damageModel";
import type { Projectile, ShotPreview, TacticalSim, VisualEvent } from "../game/sim";
import { OVERWATCH_ARC_HALF } from "../game/sim";
import { MAPS, type MapTheme, type AmbientKind, type AmbientSpec } from "../game/maps";
import { ARENA_BOUNDS, arenaDepth, arenaWidth, terrainBlocks, terrainBridges, terrainHeightAt, terrainWater } from "../game/terrain";
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
  private readonly attackPhaseByActor = new Map<string, number>();
  /**
   * Pooled particulate for combat. The blast/impact effects were pure geometry -- expanding rings,
   * a dome, a hot core -- with nothing PARTICULATE in them, so an explosion read as a diagram of an
   * explosion. This is a single THREE.Points over pre-allocated buffers with a ring cursor: no
   * allocation per hit, one draw call for every particle on screen.
   */
  private particles: Particles | null = null;
  /** Effects that have already fired their one-shot burst, so it happens on the first frame only. */
  private readonly burstIds = new Set<string>();
  private particleClock = performance.now();
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
  /** The active map's scrolling water-ripple normal, if it has water. Rebuilt per map. */
  private waterRipple: THREE.Texture | undefined;
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
      new THREE.CircleGeometry(1.34, 64),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })
    );
    this.selectionDisc.rotation.x = -Math.PI / 2;
    this.selectionDisc.position.y = 0.026;
    this.scene.add(this.selectionDisc);

    this.selectionBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.34, 1.5, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.13, depthWrite: false })
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
    // Derived from sim state every frame rather than pushed in at battle start. There were eight
    // places that (re)build the battlefield, and a faction tint applied at only some of them is a
    // bug that shows up as "the army is the wrong colour after loading a save".
    this.setFactionTints(sim.factionOf("player").accent, sim.factionOf("enemy").accent);
    if (!this.particles) this.particles = new Particles(this.scene);
    // Particles run on real time, independent of the sim's paced clock: smoke should not billow
    // faster because the player set the action pace to fast.
    const nowMs = performance.now();
    let particleDt = (nowMs - this.particleClock) / 1000;
    this.particleClock = nowMs;
    if (!(particleDt > 0) || particleDt > 0.1) particleDt = 0.016; // first frame / tab-switch guard
    this.particles.update(particleDt);
    this.emitCombatParticles(sim);
    this.computeRecoil(sim.projectiles);
    this.computeAttackPhases(sim);
    for (const entity of sim.entities) {
      // A unit carried by an air transport is aboard/hidden — don't draw it (nor make it clickable).
      if (entity.carriedById) {
        const group = this.groups.get(entity.id);
        if (group) group.visible = false;
        continue;
      }
      const existing = this.groups.get(entity.id);
      if (existing && !existing.visible) existing.visible = true; // reappears when dropped off
      this.syncEntity(entity, sim.selectedId, targetId, targetPartId, sim.defending.has(entity.id), this.ghostedEntityIds.has(entity.id));
    }
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
    this.syncWater();
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
      coin.userData.pickupId = cache.id;
      this.environmentRoot.add(coin);
      // A flat, invisible-but-raycastable disc over the whole footprint so the cache is easy to
      // click (the thin ring + floating coin alone are a fiddly target). Clicking it shows its payout.
      const hit = new THREE.Mesh(
        new THREE.CircleGeometry(0.74, 16),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      hit.rotation.x = -Math.PI / 2;
      hit.position.set(cache.x, y + 0.03, cache.z);
      hit.userData.pickupId = cache.id;
      this.environmentRoot.add(hit);
      this.pickables.push(hit, coin);
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
  /**
   * Current pose of an actor's animated limbs, for the animation-liveness probe.
   *
   * Exists because a stopped walk cycle is invisible in a screenshot: the unit still renders, still
   * moves across the board, and only the LEGS stop swinging. That regression shipped once already
   * (a render-parent change orphaned the animation state) and no gate noticed, so the pose is now
   * readable and assertable from outside.
   */
  limbPose(entityId: string): { limb: string; rotX: number; posY: number; posZ: number }[] {
    const group = this.groups.get(entityId);
    if (!group) return [];
    const out: { limb: string; rotX: number; posY: number; posZ: number }[] = [];
    group.traverse((node) => {
      const limb = node.userData?.limb as string | undefined;
      // Weapons are not limbs (they do not swing from a joint) but they ARE animated, by the attack
      // choreography, and a stopped attack pose is just as invisible in a still as a stopped walk.
      const partId = node.userData?.partId as string | undefined;
      const label = limb ?? (partId === "rifle" || partId === "cannon" || partId === "gun" ? "weapon" : undefined);
      if (!label) return;
      out.push({ limb: label, rotX: node.rotation.x, posY: node.position.y, posZ: node.position.z });
    });
    return out;
  }

  /**
   * The colour every part mesh of an actor is ACTUALLY rendering, after role tinting, damage
   * shading, selection and hit flash. Added because reading the authored colour out of the source
   * repeatedly failed to explain what the portraits showed -- several rounds were spent reasoning
   * about a paint pipeline that is easier to just measure.
   */
  partColors(entityId: string): { partId: string; color: string; emissive: string; intensity: number }[] {
    const group = this.groups.get(entityId);
    if (!group) return [];
    const out: { partId: string; color: string; emissive: string; intensity: number }[] = [];
    group.traverse((node) => {
      const mesh = node as PartMesh;
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
      const partId = mesh.userData?.partId as string | undefined;
      if (!partId) return;
      out.push({
        partId,
        color: `#${mesh.material.color.getHexString()}`,
        emissive: `#${mesh.material.emissive.getHexString()}`,
        intensity: Number(mesh.material.emissiveIntensity.toFixed(2)),
      });
    });
    return out;
  }

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

  /**
   * Give each side its faction's colour. Player and enemy stay unmistakably different -- the team
   * read is never negotiable -- but a Bastion army now looks like a Bastion army rather than like
   * every other army in the game.
   */
  setFactionTints(player: number, enemy: number): void {
    // A faction accent is a UI colour: deliberately high-luminance so it reads on dark chrome.
    // Blending one straight into a HULL bleached the armour — enemies came out pale pink and player
    // troopers pale mint, with the modelling washed off both. Bodies get a deepened version of the
    // same hue, so the faction still reads at tactical distance without erasing the material.
    FACTION_TINT.player = blendHex(player, 0x0e1b21, 0.4);
    // The core (torso) leans a little lighter than the trim so the two do not flatten together.
    FACTION_TINT.playerCore = blendHex(player, 0x0e1b21, 0.24);
    FACTION_TINT.enemy = blendHex(enemy, 0x2a1210, 0.5);
  }

  // Colorblind support: swap the team read palette (blue vs orange) and rebuild every
  // entity group so build-time team glows repaint too.
  setHighContrastTeams(on: boolean): void {
    Object.assign(TEAMS, on ? TEAMS_HIGH_CONTRAST : TEAMS_DEFAULT);
    TEAMS.version += 1;
  }

  // Re-theme the whole scene for a map: fog, sky, ground, terrain, grid, and lights.
  applyMap(theme: MapTheme): void {
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
    if (this.skyTexture) this.skyTexture.dispose();
    const sky = makeThemeSky(theme);
    this.skyTexture = sky.texture;
    this.scene.background = this.skyTexture;
    // Fog IS the sky's horizon band. See makeThemeSky.
    this.baseFogColor = sky.horizon.getHex();
    this.scene.fog = new THREE.FogExp2(this.baseFogColor, this.baseFogDensity);
    // A desaturated blend of the map's ground tones — what structural props get nudged toward.
    // Deliberately darker and less saturated than the ground it sits on. Props must recede so
    // the units advance; before this a crate competed with a soldier for the eye, and at tactical
    // zoom the scenery won because there is more of it.
    this.propTint = new THREE.Color(theme.ground).lerp(new THREE.Color(theme.groundAccent), 0.35).multiplyScalar(0.62);
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

  // Scroll the water's ripple normal. Two axes at different rates so the pattern never reads as a
  // texture sliding in one direction, and slow enough that a still frame looks still.
  private syncWater(): void {
    const ripple = this.waterRipple;
    if (!ripple) return;
    const t = performance.now() * 0.00004;
    ripple.offset.set(t, t * 0.62);
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
    // Arena materials (floor/rails/terrain blocks/water) are freshly built on every map swap and
    // never shared with the pooled caches, so dispose them too — the generic disposeAndClear frees
    // geometry only, which would leak a full set of materials per battle.
    //
    // TEXTURES need disposing explicitly: material.dispose() never frees them, and the procedurally
    // baked ground texture is a fresh 512x512 canvas per map swap. The leak probe caught this
    // growing at ~1 texture per swap, which is exactly what it exists to catch.
    this.sceneryRoot.traverse((node) => {
      const mat = (node as Partial<THREE.Mesh>).material;
      const list = mat ? (Array.isArray(mat) ? mat : [mat]) : [];
      for (const m of list) {
        if (!m || m.userData?.shared) continue;
        const textured = m as THREE.MeshStandardMaterial;
        if (textured.map && !textured.map.userData?.shared) textured.map.dispose();
        if (textured.normalMap && !textured.normalMap.userData?.shared) textured.normalMap.dispose();
        m.dispose();
      }
    });
    this.disposeAndClear(this.sceneryRoot);
    const width = arenaWidth();
    const depth = arenaDepth();

    // Slightly darker than the authored ground tone so units (whose palette tops out
    // near-white) keep value separation from the floor under the warm key light.
    const surface = makeGroundTexture(theme);
    // One tile per ~11 world units. The tile is seamless now, so it can be small enough for the
    // detail to survive at the tactical camera; the old 19-unit tile existed only to push a visible
    // seam out of frame, and at that scale the ground had no readable surface left at all.
    const tileX = Math.max(2, width / GROUND_TILE);
    const tileZ = Math.max(2, depth / GROUND_TILE);
    surface.map.repeat.set(tileX, tileZ);
    surface.normalMap.repeat.set(tileX, tileZ);
    // MACRO VARIATION. The texture tiles every ~11 units, so its variation averages out across a
    // 100-unit map and a wide desert still measures as one flat value -- the FLAT / NARROW RANGE /
    // MONOCHROME flags the image gate keeps raising on Dust Bowl. Vertex colours on a subdivided
    // floor add a slow, NON-repeating drift in both value and hue on top of it, for no extra draw
    // call and no second texture.
    const floorGeometry = new THREE.BoxGeometry(width, 0.18, depth, 40, 1, 40);
    paintMacroVariation(floorGeometry, new THREE.Color(theme.groundAccent).lerp(new THREE.Color(theme.ground), 0.4));
    const floor = new THREE.Mesh(
      floorGeometry,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: surface.map,
        normalMap: surface.normalMap,
        // The whole point of the normal map is that the low key light rakes across the ground and
        // finds relief in it. Too strong and the floor reads as crumpled foil at this camera pitch.
        normalScale: new THREE.Vector2(0.5, 0.5),
        color: new THREE.Color(theme.ground),
        roughness: 0.95,
        metalness: 0.02,
      })
    );
    floor.position.y = -0.11;
    floor.receiveShadow = true;
    this.sceneryRoot.add(floor);

    this.sceneryRoot.add(makeGroundPlates(theme, width, depth, surface));
    this.sceneryRoot.add(makeTerrainBlocks(theme.ground, theme.groundAccent, surface));
    const water = makeWaterAndBridges(theme, surface);
    this.waterRipple = (water.userData.ripple as THREE.Texture | undefined) ?? undefined;
    this.sceneryRoot.add(water);
    this.sceneryRoot.add(makeSurroundings(theme, width, depth, surface));

    // No ground grid: movement is continuous, so a grid describes no rule the player can use and
    // reads as an unfinished prototype. Range rings and move previews carry that information.

    // BOARD EDGE. A chamfered dark lip running the arena's perimeter, sitting proud of the floor and
    // dropping below it. It is what turns "a plane that happens to stop" into a board with a rim,
    // and the shadow it casts inward is the line that separates the lit stage from the dark ground
    // around it. Still the arena-bounds affordance it always was, just legible now.
    const rimColor = new THREE.Color(theme.ground).multiplyScalar(0.3).lerp(new THREE.Color(theme.fog), 0.12);
    const rimMat = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.94, metalness: 0.06 });
    for (const [x, z, sx, sz] of [
      [0, ARENA_BOUNDS.minZ - 0.42, width + 1.7, 0.86],
      [0, ARENA_BOUNDS.maxZ + 0.42, width + 1.7, 0.86],
      [ARENA_BOUNDS.minX - 0.42, 0, 0.86, depth + 1.7],
      [ARENA_BOUNDS.maxX + 0.42, 0, 0.86, depth + 1.7],
    ] as const) {
      const lip = new THREE.Mesh(new RoundedBoxGeometry(sx, 0.62, sz, 1, 0.16), rimMat);
      lip.position.set(x, -0.18, z);
      lip.receiveShadow = true;
      lip.castShadow = true;
      this.sceneryRoot.add(lip);
    }

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

    // (Removed: a 6x4 grid of translucent "deck panels". They tiled the floor with large flat
    // rectangles of near-identical value, which is the opposite of the variation the ground needs,
    // and they read as UI painted onto the world. The ground texture above replaces them.)

    // (Removed: scattered translucent ground-accent discs. They were near-invisible against the
    // old flat floor, but against a textured, properly lit one they read as brown stains sitting
    // on the surface. The ground texture map carries this variation now.)

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
  // Which actors are mid-attack, and how far through. Read from the order itself so the pose can
  // never drift out of step with the shot it belongs to.
  private computeAttackPhases(sim: TacticalSim): void {
    this.attackPhaseByActor.clear();
    if (sim.phase !== "resolve") return;
    for (const order of sim.orders) {
      if (order.done) continue;
      if (order.kind !== "shoot" && order.kind !== "melee" && order.kind !== "grenade") continue;
      const duration = order.duration > 0 ? order.duration : 1;
      const phase = Math.max(0, Math.min(1, order.elapsed / duration));
      this.attackPhaseByActor.set(order.actorId, phase);
    }
  }

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
    group.userData.attackPhase = this.attackPhaseByActor.get(entity.id);
    group.userData.weaponFamily = weaponFamily(entity.kind);
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
      this.paintPart(group, mesh, entity, part, entity.id === selectedId, entity.id === targetId, part.id === targetPartId, renderGhosted);
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
    else if (entity.kind === "interceptor") this.buildInterceptor(group, entity);
    else if (entity.kind === "bomber") this.buildBomber(group, entity);
    else if (entity.kind === "transport") this.buildTransport(group, entity);
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
  private tintModelToMap(group: THREE.Group, amount = 0.74): void {
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

  // Interceptor: a sleek jet fighter — narrow fuselage, pointed nose, swept delta wings, twin tail,
  // glowing engine cans. No rotor (distinct from the helicopter gunship), reads as "air superiority".
  private buildInterceptor(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x50d7ff;
    const factionPanel = entity.team === "enemy" ? 0x6a2722 : 0x123f55;
    this.box(group, entity, "hull", [0.5, 0.4, 2.4], [0, 0, 0], 0x6a8a9a, { metalness: 0.3 });         // fuselage
    this.box(group, entity, "hull", [0.34, 0.32, 0.7], [0, 0.04, 1.25], 0x9fc0d0, { metalness: 0.3 });  // canopy
    this.box(group, entity, "hull", [0.16, 0.14, 0.5], [0, 0, 1.7], 0xd9e6df, { metalness: 0.35 });      // nose tip
    for (const side of [-1, 1]) this.box(group, entity, "wing", [1.5, 0.06, 0.9], [side * 0.9, -0.02, -0.2], 0x4a6472, { rotation: [0, side * 0.5, 0], metalness: 0.25 }); // swept delta wings
    for (const side of [-1, 1]) this.box(group, entity, "hull", [0.06, 0.42, 0.42], [side * 0.22, 0.22, -1.05], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.26 }); // twin tail fins
    for (const side of [-1, 1]) this.box(group, entity, "gun", [0.1, 0.1, 0.8], [side * 0.5, -0.06, 0.62], 0xd9e6df, { metalness: 0.4 }); // wing cannons
    for (const side of [-1, 1]) this.box(group, entity, "gun", [0.14, 0.14, 0.14], [side * 0.5, -0.06, 1.02], 0xffffff, { emissive: factionGlow, emissiveIntensity: 0.4 }); // muzzles
    for (const side of [-1, 1]) this.box(group, entity, "hull", [0.22, 0.22, 0.34], [side * 0.16, 0, -1.3], 0xff8c3a, { emissive: 0xff6a1e, emissiveIntensity: 0.55 }); // engine cans
    const shadow = makeContactShadow(entity.radius * 1.1);
    shadow.position.y = -(entity.agl ?? 7.5);
    group.add(shadow);
  }

  // Bomber: a big heavy bomber — fat fuselage, long straight wings, four engine nacelles, a belly
  // bomb bay. No gun. Slow and unmistakably a bomb truck, distinct from the fighter and the gunship.
  private buildBomber(group: THREE.Group, entity: CombatEntity): void {
    this.box(group, entity, "hull", [1.1, 0.7, 3.0], [0, 0, 0], 0x5f6f66, { metalness: 0.18 });        // fuselage
    this.box(group, entity, "hull", [0.7, 0.5, 0.9], [0, 0.22, 1.3], 0x9fb0a6, { metalness: 0.2 });     // cockpit
    this.box(group, entity, "hull", [0.3, 0.55, 0.5], [0, 0.4, -1.72], 0x46564e);                       // tail fin
    this.box(group, entity, "hull", [1.5, 0.06, 0.42], [0, 0.5, -1.62], 0x46564e);                      // tailplane
    for (const side of [-1, 1]) this.box(group, entity, "engine", [2.4, 0.12, 1.0], [side * 1.7, 0.02, -0.1], 0x4a5a52, { metalness: 0.18 }); // long wings
    for (const side of [-1, 1]) for (const off of [0.9, 1.9]) this.box(group, entity, "engine", [0.32, 0.34, 0.8], [side * off, -0.16, 0.25], 0x2a3a34, { metalness: 0.25 }); // engine nacelles
    this.box(group, entity, "pack", [0.82, 0.24, 1.7], [0, -0.44, -0.1], 0x3a4042, { metalness: 0.2 }); // bomb bay
    for (const z of [-0.55, 0, 0.55]) this.box(group, entity, "pack", [0.32, 0.36, 0.42], [0, -0.62, z], 0xffb02e, { emissive: 0xff7d26, emissiveIntensity: 0.3 }); // bombs
    const shadow = makeContactShadow(entity.radius * 1.35);
    shadow.position.y = -(entity.agl ?? 8);
    group.add(shadow);
  }

  // Transport: a boxy cargo helicopter — fat cabin, big main rotor, tail boom + rotor, skids.
  // Clearly a lift bird, distinct from the sleek attack gunship.
  private buildTransport(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x50d7ff;
    this.box(group, entity, "hull", [1.2, 0.9, 2.2], [0, 0, 0], 0x6a7a6a, { metalness: 0.18 });       // cargo cabin
    this.box(group, entity, "hull", [0.9, 0.5, 0.7], [0, 0.2, 1.2], 0x9fc0d0, { metalness: 0.2 });     // cockpit glass
    this.box(group, entity, "hull", [0.32, 0.32, 1.5], [0, 0.22, -1.5], 0x46564e);                     // tail boom
    this.box(group, entity, "hull", [0.5, 0.42, 0.12], [0, 0.46, -2.15], 0x46564e, { emissive: factionGlow, emissiveIntensity: 0.2 }); // tail fin
    this.cylinder(group, entity, "rotor", 0.08, 0.42, [0, 0.64, 0.05], 0x2a3236);                      // rotor mast
    this.box(group, entity, "rotor", [3.8, 0.05, 0.18], [0, 0.84, 0.05], 0x14181a);                    // main blades
    this.box(group, entity, "rotor", [0.18, 0.05, 3.8], [0, 0.84, 0.05], 0x14181a);
    this.box(group, entity, "tail", [0.06, 0.8, 0.06], [0.22, 0.22, -2.2], 0x14181a);                  // tail rotor
    for (const x of [-0.55, 0.55]) this.box(group, entity, "hull", [0.06, 0.06, 1.7], [x, -0.62, 0.1], 0x2a3236); // skids
    const shadow = makeContactShadow(entity.radius * 1.3);
    shadow.position.y = -(entity.agl ?? 5.5);
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
    // Every part of this trooper -- shared chassis AND the kind's own kit -- goes into `rig`, an
    // inner group carrying the role's proportions. Scaling the parts individually desynced the kit
    // from the body (helmets floating off heads); scaling one wrapper keeps every anchor aligned
    // by construction. It has to be an inner group rather than the entity group, because the
    // entity group's scale is rewritten every frame for elite and death states.
    const rig = new THREE.Group();
    const build = infantryBuild(entity.kind);
    rig.scale.set(build.girth, build.stature, build.girth);
    rig.rotation.x = build.lean;
    group.add(rig);
    // --- Shaped trooper chassis, PROPORTIONED PER ROLE. ---
    //
    // Every kind used to share one identical torso, head and leg set, with its signature kit
    // bolted on top. Close up that kit reads clearly; at the distance the game is actually played
    // it does not, because ~70% of the silhouette was the same shape for all twelve infantry. The
    // black-silhouette test failed even though the detail work was there. So the CHASSIS now
    // varies: a heavy gunner is short and broad, a scout is tall and narrow, a striker leans into
    // the fight. Proportion survives at any zoom, where greebles do not.
    // Hip girdle: a belt block with hanging thigh plates, so the waist reads as armour rather
    // than a step change in the torso cylinder.
    this.box(rig, entity, "legs", [0.4, 0.16, 0.28], [0, 0.5, 0], trimColor, { metalness: 0.16 });
    for (const side of [-1, 1]) {
      this.box(rig, entity, "legs", [0.13, 0.19, 0.2], [side * 0.2, 0.44, 0.02], trimColor, { metalness: 0.22, rotation: [0, 0, side * -0.14] });
    }
    // Utility belt with pouches. Three small blocks around the front is the cheapest thing that
    // reads as "kit carried by a person" instead of a smooth mannequin.
    this.box(rig, entity, "body", [0.46, 0.09, 0.32], [0, 0.6, 0], 0x1c2326, { metalness: 0.2 });
    for (const [x, z] of [[-0.17, 0.16], [0.17, 0.16], [0, 0.185]] as const) {
      this.box(rig, entity, "body", [0.11, 0.11, 0.08], [x, 0.6, z], 0x2b343a, { metalness: 0.12, bevel: 0.3 });
    }
    // Torso: a tapered barrel with a SEPARATE upper chest mass that overhangs it. The overhang is
    // what gives the trooper a shoulder line and a shadow under the chest -- a single cylinder
    // reads as a bottle no matter how it is lit.
    this.cylinder(rig, entity, "body", 0.24, 0.5, [0, 0.8, 0], bodyColor, [0, 0, 0], { emissive: teamGlow, emissiveIntensity: 0.08, radiusBottom: 0.27, outline: true });
    this.box(rig, entity, "body", [0.5, 0.3, 0.34], [0, 1.03, 0], bodyColor, { metalness: 0.14, bevel: 0.26, outline: true });
    // Angled breastplate over it, with a glowing core seam.
    this.box(rig, entity, "body", [0.42, 0.34, 0.11], [0, 0.99, 0.18], trimColor, { metalness: 0.3, rotation: [-0.16, 0, 0], bevel: 0.24 });
    this.box(rig, entity, "body", [0.12, 0.2, 0.05], [0, 0.98, 0.245], 0x10171a, { emissive: teamGlow, emissiveIntensity: 0.21, rotation: [-0.16, 0, 0] });
    // Back plate, so the unit has a silhouette from behind too -- half the time the camera is
    // looking at a trooper's back and there was nothing there.
    this.box(rig, entity, "body", [0.4, 0.32, 0.08], [0, 1.0, -0.17], trimColor, { metalness: 0.26, rotation: [0.1, 0, 0], bevel: 0.24 });
    // Gorget + neck column.
    this.cylinder(rig, entity, "body", 0.13, 0.1, [0, 1.2, 0.01], trimColor, [0, 0, 0], { metalness: 0.24 });
    this.cylinder(rig, entity, "body", 0.085, 0.12, [0, 1.25, 0.01], 0x1a2226, [0, 0, 0], { metalness: 0.3 });
    // Pauldrons: angled, bevelled plates with a rim, canted outward off the shoulder. Squashed
    // spheres read as balls at any distance; a plate with a lit top edge reads as armour.
    for (const side of [-1, 1]) {
      this.box(rig, entity, "body", [0.25, 0.18, 0.32], [side * 0.35, 1.05, 0.01], 0x39434a, { metalness: 0.32, rotation: [0, 0, side * -0.3], bevel: 0.3 });
      this.box(rig, entity, "body", [0.26, 0.05, 0.33], [side * 0.37, 1.15, 0.01], trimColor, { metalness: 0.4, rotation: [0, 0, side * -0.3], bevel: 0.4 });
    }
    // Head: skull, a brow ridge over the visor, and a rear comms block. The brow is the single
    // detail that stops a head reading as a featureless ball.
    this.sphere(rig, entity, "head", 0.132, [0, 1.335, 0.02], 0x7b6a58, { scaleY: 0.95, outline: true });
    this.box(rig, entity, "head", [0.216, 0.07, 0.072], [0, 1.4, 0.145], 0x2b343a, { metalness: 0.26, rotation: [-0.24, 0, 0], bevel: 0.35 });
    this.box(rig, entity, "head", [0.202, 0.085, 0.05], [0, 1.33, 0.17], 0x0c1418, { emissive: teamGlow, emissiveIntensity: 0.23 });
    this.box(rig, entity, "head", [0.101, 0.11, 0.072], [0, 1.32, -0.15], 0x2b343a, { metalness: 0.24, bevel: 0.3 });
    if (entity.kind === "sniper") {
      // Marksman: extra-long bipod-steadied rifle, a fat glowing scope, and a camo ghillie
      // hood/cloak that ragged-edges the silhouette — clearly the patient long-range shooter.
      this.box(rig, entity, "rifle", [0.13, 0.15, 1.54], [0.46, 0.95, 0.52], trimColor, { metalness: 0.34 });
      this.box(rig, entity, "rifle", [0.22, 0.2, 0.28], [0.46, 1.08, 0.12], 0x12161a, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.21 });
      this.box(rig, entity, "rifle", [0.1, 0.1, 0.12], [0.46, 1.13, -0.06], 0x8de4ff, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.38 });
      this.cylinder(rig, entity, "rifle", 0.03, 0.44, [0.38, 0.74, 1.04], 0x14181a, [0.5, 0, 0.32], { metalness: 0.3 });
      this.cylinder(rig, entity, "rifle", 0.03, 0.44, [0.54, 0.74, 1.04], 0x14181a, [0.5, 0, -0.32], { metalness: 0.3 });
      this.box(rig, entity, "body", [0.66, 0.26, 0.52], [0, 1.05, -0.06], 0x55603c, { accent: true });
      this.box(rig, entity, "body", [0.5, 0.5, 0.16], [0, 0.74, -0.34], 0x4c5436, { accent: true });
      for (const x of [-0.22, 0.04, 0.26]) this.box(rig, entity, "body", [0.1, 0.2, 0.08], [x, 0.5, -0.36], 0x5d663f, { accent: true });
      this.box(rig, entity, "head", [0.346, 0.22, 0.374], [0, 1.46, -0.05], 0x55603c, { accent: true });
      this.box(rig, entity, "head", [0.36, 0.1, 0.101], [0, 1.4, 0.2], 0x0a1418, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.23 });
    } else if (entity.kind === "grenadier") {
      // Splash specialist: stubby fat-muzzled launcher, a bandolier of amber rounds across
      // the chest, more on the pack, and a round pot helmet.
      this.box(rig, entity, "rifle", [0.28, 0.26, 0.78], [0.48, 0.93, 0.3], trimColor, { metalness: 0.2 });
      this.cylinder(rig, entity, "rifle", 0.21, 0.2, [0.48, 0.93, 0.74], 0x2b2418, [0.5, 0, 0], { accent: true, emissive: 0xffb02e, emissiveIntensity: 0.18 });
      this.cylinder(rig, entity, "body", 0.06, 0.94, [0, 0.86, 0.2], 0x2e2110, [0, 0, 0.72], { accent: true });
      for (const [x, y] of [[-0.2, 0.66], [0, 0.86], [0.2, 1.06]] as const) this.box(rig, entity, "body", [0.12, 0.15, 0.12], [x, y, 0.25], 0xffb84a, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.17 });
      for (const x of [-0.16, 0, 0.16]) this.box(rig, entity, "pack", [0.11, 0.16, 0.11], [x, 1.08, -0.42], 0xffca6b, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.35 });
      this.box(rig, entity, "head", [0.331, 0.2, 0.331], [0, 1.46, 0.0], 0x5a4a22, { accent: true });
      this.box(rig, entity, "head", [0.36, 0.09, 0.13], [0, 1.42, 0.22], 0x6a5626, { accent: true });
    } else if (entity.kind === "striker") {
      // Close-assault: a long glowing arc-blade, a buckler on the off arm, a shoulder
      // pauldron, and a sleek crested visor helm — aggressive and unmistakably melee.
      this.box(rig, entity, "rifle", [0.1, 0.16, 1.28], [0.52, 0.86, 0.42], 0xc6bce0, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.3 });
      this.box(rig, entity, "rifle", [0.16, 0.2, 0.22], [0.52, 0.92, -0.12], 0x2a2142, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.19 });
      this.box(rig, entity, "body", [0.12, 0.6, 0.5], [-0.52, 0.86, 0.06], 0x3a2c5c, { accent: true });
      this.box(rig, entity, "body", [0.08, 0.4, 0.1], [-0.58, 0.86, 0.06], 0x8a6ecf, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.15 });
      this.box(rig, entity, "body", [0.3, 0.2, 0.36], [0.46, 1.14, 0.02], 0x4a3a72, { accent: true });
      this.box(rig, entity, "head", [0.317, 0.34, 0.331], [0, 1.42, 0.0], 0x2a2142, { accent: true, metalness: 0.2 });
      this.box(rig, entity, "head", [0.346, 0.08, 0.115], [0, 1.4, 0.22], 0xc6a8ff, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.34 });
      this.box(rig, entity, "head", [0.072, 0.26, 0.086], [0, 1.66, -0.04], 0x6a4fae, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.21 });
    } else if (entity.kind === "heavy") {
      // Anchor: the widest, bulkiest frame, armor pauldrons, a drum-fed auto-cannon with an
      // ammo belt looping to a big glowing back drum, and a slab face-visor helmet.
      this.box(rig, entity, "body", [0.58, 0.5, 0.42], [0, 0.92, 0.02], bodyColor, { metalness: 0.14, emissive: 0x401a08, emissiveIntensity: 0.12 });
      this.box(rig, entity, "body", [0.7, 0.18, 0.46], [0, 1.14, 0.0], trimColor, { metalness: 0.18 });
      for (const x of [-0.4, 0.4]) this.box(rig, entity, "body", [0.26, 0.22, 0.38], [x, 1.12, 0.02], 0x6a3a1c, { accent: true, metalness: 0.2 });
      this.box(rig, entity, "rifle", [0.27, 0.27, 1.22], [0.54, 0.92, 0.46], 0x2b2f31, { metalness: 0.32 });
      this.cylinder(rig, entity, "rifle", 0.26, 0.24, [0.54, 0.74, 0.5], 0x14181a, [0, 0, 0], { metalness: 0.3 });
      this.box(rig, entity, "rifle", [0.34, 0.3, 0.22], [0.54, 0.92, 1.12], 0xb2842f, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.12 });
      for (let i = 0; i < 4; i++) this.box(rig, entity, "rifle", [0.12, 0.09, 0.1], [0.34 - i * 0.07, 0.8 - i * 0.015, 0.18 - i * 0.13], 0xb2842f, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.14 });
      this.cylinder(rig, entity, "pack", 0.17, 0.3, [-0.03, 0.95, -0.34], 0xc8761f, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.32 });
      this.box(rig, entity, "pack", [0.12, 0.1, 0.26], [0.2, 0.95, -0.26], 0x8a5a22, { accent: true, metalness: 0.3, bevel: 0.3 });
      this.box(rig, entity, "pack", [0.3, 0.08, 0.1], [0, 1.14, -0.3], 0xc8871f, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.16, bevel: 0.35 });
      this.box(rig, entity, "head", [0.36, 0.46, 0.346], [0, 1.32, 0.0], 0x7a4a2a, { accent: true, metalness: 0.18 });
      this.box(rig, entity, "head", [0.389, 0.14, 0.115], [0, 1.32, 0.22], 0x141819, { accent: true, emissive: 0xffb02e, emissiveIntensity: 0.25 });
    } else if (entity.kind === "mortar") {
      // Indirect-fire team: long mortar tube slung high over the shoulder, a round olive
      // baseplate + folded bipod legs on the back, and a heavy olive-drab steel helmet.
      this.box(rig, entity, "rifle", [0.16, 0.16, 0.44], [0.44, 0.94, 0.2], trimColor, { metalness: 0.2 });
      this.cylinder(rig, entity, "rifle", 0.13, 1.1, [0.14, 1.2, -0.12], 0x2a2f31, [Math.PI * 0.32, 0, 0], { metalness: 0.34 });
      this.cylinder(rig, entity, "rifle", 0.16, 0.12, [-0.06, 1.6, -0.42], 0xffd27a, [Math.PI * 0.32, 0, 0], { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.19 });
      this.cylinder(rig, entity, "pack", 0.33, 0.08, [0, 1.0, -0.47], 0x4a4f33, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.3 });
      this.cylinder(rig, entity, "pack", 0.12, 0.1, [0, 1.0, -0.52], 0x2c2f22, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.3 });
      for (const x of [-0.16, 0.16]) this.box(rig, entity, "pack", [0.04, 0.62, 0.04], [x, 0.86, -0.5], 0x3a3f2c, { accent: true });
      this.box(rig, entity, "head", [0.331, 0.22, 0.331], [0, 1.46, 0.0], 0x4a4f33, { accent: true, metalness: 0.16 });
      this.box(rig, entity, "head", [0.36, 0.09, 0.13], [0, 1.41, 0.22], 0x3a3f28, { accent: true });
    } else if (entity.kind === "medic") {
      // Support: a clean white vest + helmet emblazoned with a bold red cross, a hip med
      // satchel, a glowing green heal vial, and only a small sidearm — reads as "help."
      this.box(rig, entity, "rifle", [0.16, 0.16, 0.46], [0.45, 0.9, 0.24], 0xb8b2ae, { metalness: 0.2 });
      this.box(rig, entity, "body", [0.5, 0.66, 0.06], [0, 0.86, 0.19], 0xaba695, { accent: true });
      this.box(rig, entity, "body", [0.18, 0.42, 0.05], [0, 0.9, 0.23], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
      this.box(rig, entity, "body", [0.42, 0.16, 0.05], [0, 0.94, 0.23], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
      this.box(rig, entity, "pack", [0.3, 0.3, 0.2], [0.36, 0.66, -0.04], 0xa39e8e, { accent: true });
      this.box(rig, entity, "pack", [0.14, 0.05, 0.05], [0.36, 0.7, 0.07], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.19 });
      this.box(rig, entity, "pack", [0.05, 0.14, 0.05], [0.36, 0.7, 0.07], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.19 });
      this.box(rig, entity, "body", [0.1, 0.16, 0.1], [-0.3, 0.7, 0.16], 0x9dffd0, { accent: true, emissive: 0x4ce0a0, emissiveIntensity: 0.29 });
      this.box(rig, entity, "head", [0.331, 0.2, 0.331], [0, 1.46, 0.0], 0xaba695, { accent: true });
      this.box(rig, entity, "head", [0.072, 0.05, 0.115], [0, 1.48, 0.22], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
      this.box(rig, entity, "head", [0.036, 0.14, 0.115], [0, 1.48, 0.22], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
    } else if (entity.kind === "scout") {
      // Light recon: stubby carbine, chest binoculars with glowing green lenses, a tall whip
      // antenna with a blinking tip, and a soft beret with goggles — the leanest silhouette.
      this.box(rig, entity, "rifle", [0.13, 0.14, 0.6], [0.46, 0.95, 0.22], trimColor, { metalness: 0.22 });
      this.box(rig, entity, "body", [0.28, 0.14, 0.12], [0, 1.0, 0.22], 0x1c2a24, { accent: true });
      for (const x of [-0.09, 0.09]) this.cylinder(rig, entity, "body", 0.05, 0.07, [x, 1.0, 0.3], 0x9dffcf, [Math.PI / 2, 0, 0], { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.36 });
      this.cylinder(rig, entity, "pack", 0.028, 0.95, [-0.2, 1.42, -0.34], 0xbcd8c6, [0, 0, 0], { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.21 });
      this.box(rig, entity, "pack", [0.08, 0.08, 0.08], [-0.2, 1.92, -0.34], 0x9dffcf, { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.38 });
      this.box(rig, entity, "head", [0.317, 0.14, 0.302], [0, 1.46, 0.0], 0x2f6e4a, { accent: true });
      this.box(rig, entity, "head", [0.086, 0.1, 0.058], [0.16, 1.52, -0.04], 0x244d39, { accent: true });
      this.box(rig, entity, "head", [0.302, 0.1, 0.101], [0, 1.38, 0.2], 0x0e2a24, { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.25 });
    } else if (entity.kind === "engineer") {
      // Builder crew: a welding torch with a blazing tip, a big steel wrench on the back,
      // a hi-vis hard hat with a head-lamp, and a tool belt of hanging gear.
      this.box(rig, entity, "rifle", [0.12, 0.12, 0.46], [0.46, 0.92, 0.2], 0x3a3320, { metalness: 0.3 });
      this.box(rig, entity, "rifle", [0.11, 0.11, 0.16], [0.46, 0.92, 0.5], 0xe4d8ae, { accent: true, emissive: 0xffce4a, emissiveIntensity: 0.38 });
      this.box(rig, entity, "pack", [0.1, 0.64, 0.1], [-0.34, 0.92, -0.32], 0xa8b0b8, { accent: true, metalness: 0.42 });
      this.box(rig, entity, "pack", [0.24, 0.16, 0.12], [-0.34, 1.28, -0.32], 0xa8b0b8, { accent: true, metalness: 0.42 });
      this.box(rig, entity, "body", [0.6, 0.12, 0.4], [0, 0.62, 0.02], 0xffce4a, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.17 });
      for (const x of [-0.18, 0.12]) this.box(rig, entity, "body", [0.08, 0.18, 0.06], [x, 0.5, 0.18], 0xbfc6cc, { accent: true, metalness: 0.4 });
      this.box(rig, entity, "head", [0.346, 0.18, 0.331], [0, 1.46, 0.0], 0xd9a52f, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.14 });
      this.box(rig, entity, "head", [0.115, 0.1, 0.058], [0, 1.46, 0.24], 0xbfe8ff, { accent: true, emissive: 0xbfe8ff, emissiveIntensity: 0.38 });
    } else if (entity.kind === "flamer") {
      // Incendiary specialist: fat twin-nozzle projector with a pilot flame, hazard-striped
      // shoulder guard, and big glowing fuel tanks on the back — unmistakably "fire".
      this.box(rig, entity, "rifle", [0.2, 0.2, 0.82], [0.47, 0.92, 0.3], 0x3a3230, { metalness: 0.3 });
      this.cylinder(rig, entity, "rifle", 0.09, 0.3, [0.47, 0.92, 0.78], 0x1d1a18, [Math.PI / 2, 0, 0], { metalness: 0.36 });
      this.sphere(rig, entity, "rifle", 0.06, [0.47, 0.92, 0.96], 0xffb02e, { accent: true, emissive: 0xff6b1a, emissiveIntensity: 0.38 });
      this.box(rig, entity, "rifle", [0.1, 0.1, 0.34], [0.47, 1.04, 0.4], 0x5a2f10, { accent: true });
      this.box(rig, entity, "body", [0.34, 0.16, 0.4], [-0.36, 1.08, 0.02], 0xffb02e, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.2 });
      this.cylinder(rig, entity, "pack", 0.13, 0.62, [-0.14, 0.86, -0.44], 0xc23a10, [0, 0, 0], { accent: true, emissive: 0xff5a1a, emissiveIntensity: 0.3, metalness: 0.3 });
      this.cylinder(rig, entity, "pack", 0.13, 0.62, [0.14, 0.86, -0.44], 0xd84a14, [0, 0, 0], { accent: true, emissive: 0xff5a1a, emissiveIntensity: 0.3, metalness: 0.3 });
      this.box(rig, entity, "head", [0.331, 0.2, 0.331], [0, 1.46, 0], 0x8a2f10, { accent: true, metalness: 0.2 });
    } else if (entity.kind === "droneop") {
      // Drone operator: a signal wand, a control slate on the chest, and the recon drone
      // itself hovering overhead with a spinning-ring rotor and a scanning eye.
      this.box(rig, entity, "rifle", [0.12, 0.12, 0.5], [0.46, 0.92, 0.22], 0x3a4450, { metalness: 0.3 });
      this.box(rig, entity, "body", [0.3, 0.22, 0.06], [0, 0.96, 0.23], 0x0e1a26, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.23 });
      this.box(rig, entity, "head", [0.331, 0.18, 0.331], [0, 1.45, 0], 0x2c4a6a, { accent: true });
      this.box(rig, entity, "head", [0.144, 0.08, 0.173], [0.16, 1.48, 0.14], 0x9fdcff, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.29 });
      // The drone (pack part, so shooting the pack downs the optics — cause and effect).
      this.box(rig, entity, "pack", [0.34, 0.09, 0.34], [0, 2.25, -0.1], 0x35485c, { accent: true, metalness: 0.3 });
      this.cylinder(rig, entity, "pack", 0.26, 0.05, [0, 2.33, -0.1], 0x9fdcff, [0, 0, 0], { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.21 });
      this.sphere(rig, entity, "pack", 0.07, [0, 2.18, 0.08], 0xff5a4d, { accent: true, emissive: 0xff3b30, emissiveIntensity: 0.36 });
    } else if (entity.kind === "sapper") {
      // Combat sapper: stubby demolition launcher with a fat drum, mine discs clipped to
      // the belt, blast apron, and a heavy face shield — the wall-breaker.
      this.box(rig, entity, "rifle", [0.22, 0.22, 0.6], [0.47, 0.92, 0.26], 0x4a4232, { metalness: 0.3 });
      this.cylinder(rig, entity, "rifle", 0.14, 0.2, [0.47, 0.8, 0.2], 0x2a2620, [0, 0, Math.PI / 2], { accent: true, metalness: 0.3 });
      this.box(rig, entity, "rifle", [0.14, 0.14, 0.16], [0.47, 0.92, 0.62], 0xffca6b, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.17 });
      for (const x of [-0.18, 0.02, 0.22]) this.cylinder(rig, entity, "body", 0.07, 0.04, [x, 0.58, 0.22], 0x8a7a3a, [Math.PI / 2, 0, 0], { accent: true, metalness: 0.3 });
      this.box(rig, entity, "body", [0.44, 0.5, 0.07], [0, 0.72, 0.2], 0x5a4a1a, { accent: true });
      this.box(rig, entity, "head", [0.346, 0.26, 0.072], [0, 1.34, 0.2], 0x3a342a, { accent: true, metalness: 0.24 });
      this.box(rig, entity, "head", [0.317, 0.16, 0.317], [0, 1.46, 0], 0x8a7a3a, { accent: true });
    } else {
      // Line infantry (soldier): standard bayoneted rifle, a brimmed helmet with a comms
      // bead, chest webbing/pouches and a slung frag — the plain baseline trooper.
      // A rifle, not a plank: receiver, a slimmer barrel with a muzzle device, a magazine
      // hanging below, a stock behind the grip and a low optic on top. This is the shape the
      // player sees on the most common unit in the game, so it earns the extra meshes.
      this.box(rig, entity, "rifle", [0.115, 0.15, 0.52], [0.45, 0.93, 0.2], trimColor, { metalness: 0.34, bevel: 0.22 });
      this.cylinder(rig, entity, "rifle", 0.032, 0.46, [0.45, 0.95, 0.63], 0x1d2529, [Math.PI / 2, 0, 0], { metalness: 0.44 });
      this.box(rig, entity, "rifle", [0.07, 0.07, 0.11], [0.45, 0.95, 0.88], 0x11181b, { metalness: 0.5, bevel: 0.3 });
      this.box(rig, entity, "rifle", [0.075, 0.19, 0.11], [0.45, 0.81, 0.16], 0x232c31, { metalness: 0.3, bevel: 0.26 });
      this.box(rig, entity, "rifle", [0.09, 0.12, 0.26], [0.45, 0.9, -0.13], 0x2b343a, { metalness: 0.26, bevel: 0.28 });
      this.box(rig, entity, "rifle", [0.05, 0.06, 0.16], [0.45, 1.03, 0.16], 0x11181b, { metalness: 0.42, bevel: 0.3 });
      this.box(rig, entity, "rifle", [0.05, 0.05, 0.16], [0.45, 0.96, 0.98], 0xcfe2e4, { accent: true, metalness: 0.5 });
      this.box(rig, entity, "body", [0.5, 0.12, 0.06], [0, 0.94, 0.2], 0x2c3a30, { accent: true });
      for (const x of [-0.16, 0.16]) this.box(rig, entity, "body", [0.14, 0.18, 0.1], [x, 0.74, 0.2], 0x35463a, { accent: true });
      this.box(rig, entity, "body", [0.12, 0.16, 0.12], [-0.3, 0.66, 0.12], 0x3f5036, { accent: true });
      this.box(rig, entity, "head", [0.317, 0.2, 0.317], [0, 1.46, 0.0], 0x2c3a3d, { accent: true, metalness: 0.14 });
      this.box(rig, entity, "head", [0.346, 0.07, 0.115], [0, 1.39, 0.22], 0x141819, { accent: true });
      this.box(rig, entity, "head", [0.065, 0.08, 0.05], [0.2, 1.46, 0.1], 0x8df0ff, { accent: true, emissive: 0x5ff1ff, emissiveIntensity: 0.29 });
    }
    this.box(rig, entity, "pack", [0.36, 0.42, 0.17], [0, 0.84, -0.29], packColor, entity.kind === "grenadier" ? { emissive: 0xff7d26, emissiveIntensity: 0.26 } : {});
    // Team-lit status lamp on the pack. (No twin tanks / comm nub — invisible at tactics
    // zoom and each small mesh is a draw call across a 40-unit battle.)
    this.box(rig, entity, "pack", [0.1, 0.14, 0.06], [-0.22, 1.04, -0.38], 0xbcd4dc, { emissive: teamGlow, emissiveIntensity: 0.18 });
    // Arms and legs are tagged as limbs so they can swing into a walk cycle while moving.
    // Tapered cylinders with glove/boot caps — same base positions and pivots as before.
    // Arms: upper arm, a bracer at the forearm, and a blocky glove. Every mesh carries the same
    // limb tag, so they all swing about the shared shoulder pivot as one piece -- the segments are
    // there for silhouette, not for a second joint.
    for (const side of [-1, 1]) {
      const tag = side < 0 ? "arm-l" : "arm-r";
      this.cylinder(rig, entity, "body", 0.075, 0.34, [side * 0.42, 0.82, 0.02], bodyColor, [0, 0, 0], { radiusBottom: 0.085 }).userData.limb = tag;
      this.box(rig, entity, "body", [0.14, 0.2, 0.15], [side * 0.42, 0.6, 0.03], 0x2b343a, { metalness: 0.26, bevel: 0.28 }).userData.limb = tag;
      this.box(rig, entity, "body", [0.12, 0.12, 0.14], [side * 0.42, 0.46, 0.05], 0x1f282c, { metalness: 0.2, bevel: 0.32 }).userData.limb = tag;
    }
    // Legs: thigh, a knee plate, and a boot with a raised toe. The knee plate is what breaks the
    // "two smooth pipes" read, and the toe is what makes a planted foot look planted.
    for (const side of [-1, 1]) {
      const tag = side < 0 ? "leg-l" : "leg-r";
      this.box(rig, entity, "legs", [0.15, 0.14, 0.16], [side * 0.18, 0.3, 0.03], trimColor, { metalness: 0.28, bevel: 0.3 }).userData.limb = tag;
      this.box(rig, entity, "legs", [0.11, 0.08, 0.12], [side * 0.18, 0.13, 0.06], 0x212b2f, { metalness: 0.2, bevel: 0.3 }).userData.limb = tag;
    }
    this.cylinder(rig, entity, "legs", 0.095, 0.52, [-0.18, 0.26, 0], 0x162225, [0, 0, 0], { radiusBottom: 0.075, outline: true }).userData.limb = "leg-l";
    this.cylinder(rig, entity, "legs", 0.095, 0.52, [0.18, 0.26, 0], 0x162225, [0, 0, 0], { radiusBottom: 0.075, outline: true }).userData.limb = "leg-r";
    this.box(rig, entity, "legs", [0.2, 0.11, 0.3], [-0.18, 0.055, 0.07], 0x101516, { metalness: 0.14 }).userData.limb = "leg-l";
    this.box(rig, entity, "legs", [0.2, 0.11, 0.3], [0.18, 0.055, 0.07], 0x101516, { metalness: 0.14 }).userData.limb = "leg-r";
  }

  // The HQ was a salmon-red block: at the tactical camera it read as a lump of pink plastic, and
  // it was the largest single object on the field. It is now a weathered concrete command post —
  // plinth, battered main block with corner buttresses, a raised command deck with a lit window
  // band, mast and generator — with the team read carried by ACCENT trim and glow rather than by
  // painting the whole structure a team colour. Same part ids (core/comms/power/gate), so the sim,
  // the pick proxies and the damage model are untouched.
  private buildBase(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x5fe6ff;
    const CONCRETE = 0x585a52;
    const CONCRETE_DARK = 0x43453f;
    const STEEL = 0x33362f;

    // Plinth + battered main block.
    this.box(group, entity, "core", [3.0, 0.26, 2.6], [0, 0.13, 0], STEEL, { roughness: 0.94, bevel: 0.08 });
    this.box(group, entity, "core", [2.62, 0.34, 2.24], [0, 0.4, 0], CONCRETE_DARK, { roughness: 0.92, bevel: 0.1 });
    this.box(group, entity, "core", [2.4, 1.06, 2.02], [0, 1.06, 0], CONCRETE, { roughness: 0.9, bevel: 0.09, outline: true });
    // Corner buttresses: the vertical rhythm that keeps a big flat block from reading as a crate.
    for (const x of [-1.16, 1.16]) {
      for (const z of [-0.9, 0.9]) {
        this.box(group, entity, "core", [0.3, 1.16, 0.34], [x, 1.02, z], CONCRETE_DARK, { roughness: 0.93, bevel: 0.14 });
      }
    }
    // Roof slab with an overhanging lip — the shadow line under it is what gives the mass weight.
    this.box(group, entity, "core", [2.66, 0.2, 2.28], [0, 1.68, 0], CONCRETE_DARK, { metalness: 0.1, roughness: 0.88, bevel: 0.2 });

    // Raised command deck: smaller footprint, lit window band, capped by a dark roof.
    this.box(group, entity, "core", [1.42, 0.62, 1.24], [0.1, 2.09, 0.05], CONCRETE, { roughness: 0.88, bevel: 0.12 });
    // Window band: front face and one side, so the deck reads as occupied from either approach.
    const glass = { emissive: factionGlow, emissiveIntensity: 0.32, metalness: 0.3, bevel: 0.3 } as const;
    this.box(group, entity, "core", [1.28, 0.2, 0.06], [0.1, 2.16, 0.65], 0x1d2a2e, glass);
    this.box(group, entity, "core", [0.06, 0.2, 1.1], [-0.58, 2.16, 0.05], 0x1d2a2e, glass);
    this.box(group, entity, "core", [1.56, 0.14, 1.38], [0.1, 2.46, 0.05], STEEL, { metalness: 0.16, roughness: 0.85, bevel: 0.24 });

    // Team banner on a mast — the one place a saturated team colour belongs on a structure.
    this.cylinder(group, entity, "core", 0.045, 1.15, [1.06, 2.5, 0.66], 0x9aa096, [0, 0, 0], { metalness: 0.34 });
    this.box(group, entity, "core", [0.05, 0.46, 0.66], [1.06, 2.82, 0.99], factionGlow, { emissive: factionGlow, emissiveIntensity: 0.45 });
    this.box(group, entity, "core", [0.05, 0.46, 0.16], [1.06, 2.82, 1.4], factionGlow, { emissive: factionGlow, emissiveIntensity: 0.28 });
    // Roof-edge marker lamps: small, warm, and the only bright pixels on the silhouette.
    for (const x of [-0.9, 0.9]) {
      this.box(group, entity, "core", [0.12, 0.08, 0.12], [x, 1.82, -0.94], 0xffd9a0, { emissive: 0xffa04a, emissiveIntensity: 0.5 });
    }

    // Comms mast + crossbeam + dish.
    this.cylinder(group, entity, "comms", 0.07, 1.9, [-0.92, 2.6, -0.2], 0x8f958b, [0, 0, 0], { radiusBottom: 0.11, metalness: 0.36 });
    this.box(group, entity, "comms", [0.66, 0.08, 0.08], [-0.92, 3.34, -0.2], 0x8f958b, { metalness: 0.36, bevel: 0.4 });
    this.box(group, entity, "comms", [0.1, 0.1, 0.1], [-0.92, 3.5, -0.2], 0xffb08a, { emissive: 0xff6a4a, emissiveIntensity: 0.6, bevel: 0.4 });
    this.cylinder(group, entity, "comms", 0.3, 0.1, [-0.92, 3.02, 0.06], 0xb7bcb2, [Math.PI / 2.6, 0, 0], { metalness: 0.3 });

    // Generator block: ribbed housing, warm vent glow, exhaust stack.
    this.box(group, entity, "power", [0.78, 0.72, 0.7], [1.0, 0.9, -0.72], 0x4b4a3f, { metalness: 0.22, roughness: 0.86, bevel: 0.12 });
    for (const z of [-0.92, -0.72, -0.52]) this.box(group, entity, "power", [0.82, 0.06, 0.08], [1.0, 1.0, z], 0x2c2b24, { metalness: 0.3 });
    this.box(group, entity, "power", [0.5, 0.16, 0.06], [1.0, 0.68, -0.38], 0xffb347, { emissive: 0xff8c1a, emissiveIntensity: 0.55, bevel: 0.35 });
    this.cylinder(group, entity, "power", 0.09, 0.5, [1.32, 1.5, -0.72], 0x2c2b24, [0, 0, 0], { metalness: 0.3 });

    // Gate: recessed armoured door between two bollards, with a lit sill so the entrance reads.
    this.box(group, entity, "gate", [2.7, 0.66, 0.3], [0, 0.55, 1.16], 0x3b3d37, { metalness: 0.2, roughness: 0.85, bevel: 0.1 });
    this.box(group, entity, "gate", [1.5, 0.86, 0.16], [0, 0.63, 1.28], 0x272924, { metalness: 0.3, bevel: 0.1 });
    for (const x of [-1.16, 1.16]) this.box(group, entity, "gate", [0.22, 0.8, 0.36], [x, 0.5, 1.38], 0x2f312b, { metalness: 0.24, bevel: 0.16 });
    for (const x of [-0.5, 0, 0.5]) this.box(group, entity, "gate", [0.26, 0.06, 0.06], [x, 1.02, 1.34], 0xffd9a0, { emissive: 0xffa04a, emissiveIntensity: 0.4, bevel: 0.4 });
  }

  private buildDefense(group: THREE.Group, entity: CombatEntity): void {
    const glow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x5fe6ff;
    if (entity.kind === "wall") {
      const h = entity.height;
      this.box(group, entity, "barrier", [2.15, h, 0.62], [0, h / 2, 0], 0x6a7078, { metalness: 0.2, bevel: 0.08 });
      this.box(group, entity, "barrier", [2.34, 0.24, 0.82], [0, h - 0.12, 0], 0x676f7a, { metalness: 0.22 });
      this.box(group, entity, "barrier", [2.34, 0.2, 0.82], [0, 0.16, 0], 0x4f565f, { metalness: 0.22 });
      for (const x of [-0.72, 0, 0.72]) this.box(group, entity, "barrier", [0.14, h * 0.82, 0.66], [x, h * 0.46, 0], 0x5a626d);
      // Team identification stripe. One, not two, and painted rather than lit: a blast wall is
      // concrete, and two glowing bands made it the brightest object on the battlefield.
      this.box(group, entity, "barrier", [1.96, 0.1, 0.06], [0, h * 0.62, 0.33], 0xb9c6cf, { emissive: glow, emissiveIntensity: 0.16, bevel: 0.35 });
      // Chipped corners and exposed rebar, so it reads as poured concrete taking punishment.
      for (const x of [-0.98, 0.98]) {
        this.box(group, entity, "barrier", [0.1, 0.16, 0.66], [x, h - 0.06, 0], 0x6c737b, { metalness: 0.1, bevel: 0.3 });
      }
      for (const x of [-0.5, 0.5]) {
        this.cylinder(group, entity, "barrier", 0.02, 0.18, [x, h + 0.06, 0.1], 0x8a7a5c, [0, 0, 0], { metalness: 0.5 });
      }
      return;
    }
    // Shared emplacement base + traversing ring, dug in behind a sandbag berm.
    this.box(group, entity, "mount", [1.5, 0.36, 1.5], [0, 0.18, 0], 0x333a42, { metalness: 0.24, bevel: 0.12 });
    this.box(group, entity, "mount", [1.72, 0.14, 1.72], [0, 0.05, 0], 0x22272d, { metalness: 0.18, bevel: 0.1 });
    this.cylinder(group, entity, "mount", 0.5, 0.26, [0, 0.47, 0], 0x3d454e, [0, 0, 0], { metalness: 0.3 });
    // Traverse ring: a lighter band right under the head, which is what makes the head read as a
    // separate rotating mass rather than part of the plinth.
    this.cylinder(group, entity, "mount", 0.54, 0.07, [0, 0.6, 0], 0x596470, [0, 0, 0], { metalness: 0.44 });
    // Sandbag berm on three sides. Emplacements are DUG IN; a bare plinth reads as furniture.
    for (const [x, z, sx, sz] of [
      [0, -0.86, 1.62, 0.3],
      [-0.86, 0.06, 0.3, 1.5],
      [0.86, 0.06, 0.3, 1.5],
    ] as const) {
      this.box(group, entity, "mount", [sx, 0.3, sz], [x, 0.15, z], 0x6b6350, { accent: true, metalness: 0.04, bevel: 0.42 });
      this.box(group, entity, "mount", [sx * 0.82, 0.26, sz * 0.82], [x, 0.4, z], 0x8a7f66, { accent: true, metalness: 0.04, bevel: 0.45 });
    }
    // Bolted feet.
    for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]] as const) {
      this.box(group, entity, "mount", [0.18, 0.3, 0.18], [x, 0.18, z], 0x1c2126, { metalness: 0.35, bevel: 0.2 });
    }
    if (entity.kind === "exturret") {
      // Twin mortar tubes on a braced cradle, fed from a rack of shells behind.
      this.box(group, entity, "gun", [0.9, 0.36, 0.86], [0, 0.74, 0], 0x3a434c, { metalness: 0.26, bevel: 0.16 });
      // Trunnion the tubes sit in, so they are carried by something rather than growing out of a box.
      for (const x of [-0.3, 0.3]) {
        this.box(group, entity, "gun", [0.12, 0.3, 0.3], [x, 0.94, -0.02], 0x2b333a, { metalness: 0.36, bevel: 0.24 });
      }
      for (const x of [-0.24, 0.24]) {
        this.cylinder(group, entity, "gun", 0.14, 0.82, [x, 1.16, 0.06], 0x1e242a, [0.5, 0, 0], { metalness: 0.4 });
        // Muzzle collar: metal, not a lamp.
        this.cylinder(group, entity, "gun", 0.16, 0.09, [x, 1.51, 0.25], 0x6d604a, [0.5, 0, 0], { metalness: 0.45 });
      }
      // A rack of individual shells rather than one glowing crate -- readable as ammunition, and it
      // no longer lights the emplacement up like a brazier.
      this.box(group, entity, "ammo", [0.62, 0.14, 0.5], [0, 0.5, -0.72], 0x2e3339, { metalness: 0.3, bevel: 0.2 });
      for (const [x, i] of [[-0.18, 0], [0, 1], [0.18, 2]] as const) {
        this.cylinder(group, entity, "ammo", 0.07, 0.34, [x, 0.74 - i * 0.01, -0.72], 0x6d6047, [0, 0, 0], { metalness: 0.34 });
        this.cylinder(group, entity, "ammo", 0.07, 0.1, [x, 0.95 - i * 0.01, -0.72], 0xb8923f, [0, 0, 0], { metalness: 0.42 });
      }
    } else {
      // Single auto-cannon: gun housing, a slimmer barrel with a brake, a belt box and a sensor head.
      this.box(group, entity, "gun", [0.78, 0.4, 0.86], [0, 0.76, -0.02], 0x3c454f, { metalness: 0.28, bevel: 0.16 });
      this.cylinder(group, entity, "gun", 0.075, 1.15, [0, 0.84, 0.72], 0x22282e, [Math.PI / 2, 0, 0], { metalness: 0.44 });
      // Muzzle brake -- a shaped piece of metal, where there used to be a white glowing block.
      this.box(group, entity, "gun", [0.17, 0.17, 0.2], [0, 0.84, 1.3], 0x171c21, { metalness: 0.5, bevel: 0.24 });
      for (const z of [1.24, 1.36]) {
        this.box(group, entity, "gun", [0.22, 0.05, 0.04], [0, 0.84, z], 0x2b3238, { metalness: 0.46, bevel: 0.4 });
      }
      // Ammunition belt box on the flank.
      this.box(group, entity, "gun", [0.24, 0.24, 0.44], [0.3, 0.96, 0.06], 0x2a3138, { metalness: 0.32, bevel: 0.2 });
      this.box(group, entity, "gun", [0.1, 0.06, 0.3], [0.3, 0.84, 0.28], 0x8a7340, { metalness: 0.4, bevel: 0.35 });
      // Sensor head: the housing is dark and only the LENS emits.
      this.box(group, entity, "sensor", [0.3, 0.22, 0.28], [-0.28, 1.08, -0.1], 0x1a2024, { metalness: 0.3, bevel: 0.2 });
      this.box(group, entity, "sensor", [0.12, 0.1, 0.05], [-0.28, 1.09, 0.05], 0xdaf7ff, { emissive: glow, emissiveIntensity: 0.5, bevel: 0.3 });
      this.cylinder(group, entity, "sensor", 0.012, 0.34, [-0.28, 1.36, -0.1], 0x2b3238, [0, 0, 0], { metalness: 0.4 });
    }
  }

  private buildCover(group: THREE.Group, entity: CombatEntity): void {
    const part = entity.parts[0];
    const volatile = part.role === "volatile";
    if (entity.coverKind === "ammo") {
      // A pallet of banded shell crates with one round standing proud of the stack, so it reads as
      // "munitions" from above rather than as a generic box.
      this.box(group, entity, part.id, [1.0, 0.12, 0.8], [0, 0.06, 0], 0x4a3f31, { bevel: 0.2 });
      this.box(group, entity, part.id, [0.9, 0.34, 0.68], [0, 0.29, 0], 0x5c4a33, { bevel: 0.14 });
      this.box(group, entity, part.id, [0.78, 0.3, 0.6], [0, 0.61, -0.03], 0x67543a, { bevel: 0.14 });
      // Steel banding across each crate: the small bright accents, not the whole prop.
      for (const [y, w] of [[0.29, 0.92], [0.61, 0.8]] as const) {
        this.box(group, entity, part.id, [w, 0.05, 0.06], [0, y, 0.26], 0xb8923f, { metalness: 0.4, bevel: 0.35 });
      }
      // A single shell, nose up, standing in the open crate.
      this.cylinder(group, entity, part.id, 0.09, 0.34, [0.24, 0.9, -0.03], 0x6b6f5a, [0, 0, 0], { metalness: 0.35 });
      this.cylinder(group, entity, part.id, 0.09, 0.14, [0.24, 1.11, -0.03], 0xb8923f, [0, 0, 0], { metalness: 0.45, radiusBottom: 0.02 });
      // Hazard chevron on the front face.
      this.box(group, entity, part.id, [0.34, 0.09, 0.04], [-0.18, 0.62, 0.31], 0xd8a53a, { bevel: 0.3 });
    } else if (entity.coverKind === "conduit") {
      // A junction box on a post, with an insulator stack and cable runs going off both ways.
      this.box(group, entity, part.id, [0.28, 0.3, 0.28], [0, 0.14, 0], 0x2b3238, { bevel: 0.22 });
      this.cylinder(group, entity, part.id, 0.09, 0.68, [0, 0.6, 0], 0x39424a, [0, 0, 0], { metalness: 0.4 });
      this.box(group, entity, part.id, [0.46, 0.56, 0.34], [0, 1.06, 0], 0x35424c, { metalness: 0.28, bevel: 0.16 });
      // Ceramic insulators -- the one place a bright material belongs on this prop.
      for (const x of [-0.13, 0.13]) {
        this.cylinder(group, entity, part.id, 0.06, 0.18, [x, 1.42, 0], 0xb9b0a0, [0, 0, 0], { metalness: 0.1 });
      }
      // Live terminal: small, and the only emissive thing here.
      this.box(group, entity, part.id, [0.1, 0.06, 0.06], [0, 1.2, 0.19], 0x9dfcff, { emissive: 0x48e9ff, emissiveIntensity: 0.55, bevel: 0.3 });
      // Cable runs sagging away on each side.
      for (const side of [-1, 1]) {
        this.box(group, entity, part.id, [0.5, 0.05, 0.05], [side * 0.36, 1.3, 0], 0x181d21, { bevel: 0.4, rotation: [0, 0, side * 0.22] });
      }
    } else if (volatile) {
      // Fuel: a ribbed drum in a low cradle with a valve head and a hazard band. Dark body, warm
      // band -- the previous version was a saturated orange blob that read as a pickup, not a hazard.
      this.box(group, entity, part.id, [0.86, 0.1, 0.78], [0, 0.05, 0], 0x3b3a33, { bevel: 0.2 });
      this.cylinder(group, entity, part.id, 0.36, 0.88, [0, 0.54, 0], 0x6d5a33, [0, 0, 0], { metalness: 0.32 });
      // Rolling hoops: the ribs are what make a cylinder read as a fuel drum at any distance.
      for (const y of [0.3, 0.56, 0.82]) {
        this.cylinder(group, entity, part.id, 0.385, 0.06, [0, y, 0], 0x4a4030, [0, 0, 0], { metalness: 0.4 });
      }
      // Hazard band + valve assembly on top.
      this.cylinder(group, entity, part.id, 0.372, 0.15, [0, 0.68, 0], 0xd8952f, [0, 0, 0], { metalness: 0.2 });
      this.cylinder(group, entity, part.id, 0.16, 0.12, [0, 1.02, 0], 0x4a4436, [0, 0, 0], { metalness: 0.42 });
      this.box(group, entity, part.id, [0.26, 0.05, 0.05], [0, 1.1, 0], 0x8f8672, { metalness: 0.45, bevel: 0.35 });
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
      // Three axis-aligned boxes read as a stack of crates, not a rock. Five CANTED slabs of
      // different sizes, each tipped on two axes and half-buried, give it a broken silhouette and
      // catch the key light on different planes. Seeded per entity so no two are the same boulder.
      const v = hash(entity.id);
      const tip = (n: number): number => (((v >> (n * 3)) % 9) - 4) * 0.085;
      this.box(group, entity, part.id, [1.4, 0.8, 1.15], [0, 0.34, 0], 0x6f6a62, { roughness: 0.98, bevel: 0.3, rotation: [tip(0), tip(1) * 4, tip(2)] });
      this.box(group, entity, part.id, [1.05, 0.95, 0.9], [0.18, 0.82, -0.14], 0x8d877d, { roughness: 0.96, bevel: 0.34, rotation: [tip(3), tip(4) * 4, tip(5)] });
      this.box(group, entity, part.id, [0.72, 0.66, 0.78], [-0.38, 0.72, 0.26], 0x5e5951, { roughness: 0.98, bevel: 0.36, rotation: [tip(6), tip(7) * 4, tip(2)] });
      this.box(group, entity, part.id, [0.55, 0.5, 0.5], [0.34, 1.28, 0.1], 0x9a9388, { roughness: 0.94, bevel: 0.4, rotation: [tip(1), tip(5) * 4, tip(4)] });
      this.box(group, entity, part.id, [0.9, 0.26, 0.85], [-0.1, 0.12, -0.05], 0x4c473f, { roughness: 1, bevel: 0.42, rotation: [0, tip(3) * 4, 0] });
    } else if (entity.coverKind === "tree") {
      // The old tree was a cube on a stick. This one has a tapered, leaning trunk, two boughs, and
      // a crown of six canted masses in three greens with a darker underside — an irregular
      // silhouette that reads as foliage from the tactical camera and never as a box.
      const v = hash(entity.id);
      const lean = (((v >> 2) % 7) - 3) * 0.03;
      const spin = (v % 13) * 0.24;
      this.cylinder(group, entity, part.id, 0.11, 1.7, [0, 0.85, 0], 0x4a3220, [lean, spin, lean * 0.7], { radiusBottom: 0.27, roughness: 0.95 });
      this.cylinder(group, entity, part.id, 0.06, 0.62, [0.3, 1.34, 0.06], 0x4a3220, [0.1, spin, -0.78], { radiusBottom: 0.1, roughness: 0.95 });
      this.cylinder(group, entity, part.id, 0.06, 0.5, [-0.26, 1.5, -0.1], 0x4a3220, [-0.12, spin, 0.72], { radiusBottom: 0.09, roughness: 0.95 });
      const crown: [number, number, number, number, number, number, number][] = [
        // sx, sy, sz, x, y, z, colour index
        [1.22, 0.86, 1.16, 0.02, 1.94, -0.02, 0],
        [0.96, 0.72, 1.02, -0.42, 2.16, 0.3, 1],
        [0.88, 0.8, 0.86, 0.46, 2.24, -0.24, 1],
        [0.78, 0.62, 0.74, -0.2, 2.62, -0.3, 2],
        [0.66, 0.56, 0.7, 0.26, 2.7, 0.24, 2],
        [1.0, 0.44, 0.94, 0.06, 1.66, 0.04, 3],
      ];
      const greens = [0x35722f, 0x437f36, 0x59963f, 0x27551f];
      for (const [sx, sy, sz, x, y, z, tone] of crown) {
        this.box(group, entity, part.id, [sx, sy, sz], [x, y, z], greens[tone], {
          roughness: 0.94,
          bevel: 0.46,
          rotation: [lean + ((v >> tone) % 5) * 0.04, spin + tone * 0.6, lean * 2 - ((v >> tone) % 5) * 0.03],
          emissive: 0x0f2c0e,
          emissiveIntensity: tone === 3 ? 0.04 : 0.1,
        });
      }
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
  private tintPropToMap(group: THREE.Group, amount = 0.7): void {
    group.traverse((obj) => {
      const mesh = obj as PartMesh;
      if (!(mesh.isMesh) || !(mesh.material instanceof THREE.MeshStandardMaterial)) return;
      if ((mesh.userData.baseEmissiveIntensity as number ?? 0) > 0.12) return; // keep glowing signals
      // Only the BASE colour moves. The live material is pooled and shared across every mesh that
      // currently looks the same, so writing to it here would repaint half the scene; paintPart
      // re-resolves this mesh to the right pooled material on the next frame anyway.
      const tinted = new THREE.Color(mesh.userData.baseColor as number ?? mesh.material.color.getHex()).lerp(this.propTint, amount);
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
    materialOptions: {
      metalness?: number;
      roughness?: number;
      emissive?: number;
      emissiveIntensity?: number;
      accent?: boolean;
      rotation?: [number, number, number];
      /** Chamfer size as a fraction of the smallest dimension. Lower for thin plates. */
      bevel?: number;
      /** Trace this mesh with a dark edge outline. Costs a draw call; silhouette shapes only. */
      outline?: boolean;
    } = {}
  ): PartMesh {
    const roughness = materialOptions.roughness ?? 0.62;
    const metalness = materialOptions.metalness ?? 0.08;
    const mesh = new THREE.Mesh(
      beveledBox(size[0], size[1], size[2], materialOptions.bevel),
      pooledPartMaterial(color, materialOptions.emissive ?? 0x000000, materialOptions.emissiveIntensity ?? 0, roughness, metalness)
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (materialOptions.rotation) mesh.rotation.set(materialOptions.rotation[0], materialOptions.rotation[1], materialOptions.rotation[2]);
    mesh.userData.roughness = roughness;
    mesh.userData.metalness = metalness;
    setShadowBudget(mesh, Math.max(size[0], size[1], size[2]));
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.accent = materialOptions.accent === true;
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    // Outlines are opt-in per mesh (see `outline` in the material options). Each one is a child
    // LineSegments and therefore a whole extra draw call, so only the few shapes that carry a
    // trooper's silhouette at tactical distance are worth tracing.
    if (materialOptions.outline && isInfantryKind(entity.kind) && OUTLINED_PARTS.has(partId)) this.outline(mesh);
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
    materialOptions: { metalness?: number; roughness?: number; emissive?: number; emissiveIntensity?: number; accent?: boolean; radiusBottom?: number; outline?: boolean } = {}
  ): PartMesh {
    const roughness = materialOptions.roughness ?? 0.7;
    const metalness = materialOptions.metalness ?? 0.16;
    const mesh = new THREE.Mesh(
      cylinderGeometry(radius, materialOptions.radiusBottom ?? radius, depth),
      pooledPartMaterial(color, materialOptions.emissive ?? 0x000000, materialOptions.emissiveIntensity ?? 0, roughness, metalness)
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    mesh.userData.roughness = roughness;
    mesh.userData.metalness = metalness;
    setShadowBudget(mesh, Math.max(depth, radius * 2));
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.accent = materialOptions.accent === true;
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    if (materialOptions.outline && isInfantryKind(entity.kind) && OUTLINED_PARTS.has(partId)) this.outline(mesh);
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
    materialOptions: { metalness?: number; emissive?: number; emissiveIntensity?: number; accent?: boolean; scaleY?: number; outline?: boolean } = {}
  ): PartMesh {
    const metalness = materialOptions.metalness ?? 0.12;
    const mesh = new THREE.Mesh(
      sphereGeometry(radius),
      pooledPartMaterial(color, materialOptions.emissive ?? 0x000000, materialOptions.emissiveIntensity ?? 0, 0.55, metalness)
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (materialOptions.scaleY) mesh.scale.y = materialOptions.scaleY;
    mesh.userData.roughness = 0.55;
    mesh.userData.metalness = metalness;
    setShadowBudget(mesh, radius * 2);
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
    // Edge geometry and the two opacity states are pooled: the part geometry itself is already
    // shared, so every trooper of a kind traces the identical edge set.
    const edges = new THREE.LineSegments(edgeGeometry(mesh.geometry), OUTLINE_MATERIALS.solid);
    edges.userData.decor = true;
    edges.userData.outline = true;
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

  private paintPart(actor: THREE.Group, mesh: PartMesh, entity: CombatEntity, part: DamagePart, selected: boolean, targeted: boolean, targetedPart: boolean, ghosted: boolean): void {
    // Part appearance is computed into a scratch spec and resolved to a POOLED material at the
    // end of this function. Every part mesh used to own a unique MeshStandardMaterial (~1970 of
    // them in the stress scenario), which made three re-upload lights/common uniforms per draw —
    // it was the single largest cost in the frame profile. Sharing collapses that to a few dozen.
    const spec = _partSpec;
    spec.emissiveIntensity = 0;
    spec.transparent = false;
    spec.opacity = 1;
    spec.depthWrite = true;
    const basePosition = mesh.userData.basePosition as THREE.Vector3 | undefined;
    const baseRotation = mesh.userData.baseRotation as THREE.Euler | undefined;
    const baseScale = mesh.userData.baseScale as THREE.Vector3 | undefined;
    if (basePosition) mesh.position.copy(basePosition);
    if (baseRotation) mesh.rotation.copy(baseRotation);
    if (baseScale) mesh.scale.copy(baseScale);
    // CARRY POSE. Every kit authors its weapon as a horizontal run of boxes at hip height, so from
    // the tactical camera a trooper reads as holding a plank out to one side. Rotating the whole
    // weapon about its grip -- muzzle up and canted in across the chest -- costs no geometry and is
    // the difference between carrying a rifle and holding a stick. It relaxes to level as a shot
    // winds up, so a firing unit still aims down its barrel.
    if (part.role === "weapon" && isInfantryKind(entity.kind) && entity.status.alive && part.hp > 0 && basePosition) {
      const carry = 1 - Math.min(1, ((actor.userData.attackPhase as number | undefined) === undefined ? 0 : 1));
      if (carry > 0) {
        const pitch = CARRY_PITCH * carry;
        const yaw = CARRY_YAW * carry;
        const dy = basePosition.y - CARRY_PIVOT_Y;
        const dz = basePosition.z - CARRY_PIVOT_Z;
        // Rotate the offset from the grip: X lifts the muzzle, Y swings it toward the centreline.
        const ry = dy * Math.cos(pitch) - dz * Math.sin(pitch);
        const rz = dy * Math.sin(pitch) + dz * Math.cos(pitch);
        mesh.position.y = CARRY_PIVOT_Y + ry;
        mesh.position.z = CARRY_PIVOT_Z + rz * Math.cos(yaw);
        mesh.position.x = basePosition.x + rz * Math.sin(yaw);
        mesh.rotation.x += pitch;
        mesh.rotation.y += yaw;
      }
    }
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
    // The ACTOR group, not mesh.parent: infantry parts sit inside a proportion rig, so the
    // immediate parent is not where syncEntity writes the animation state.
    const parent = actor;
    const walkW = (parent.userData.walkWeight as number | undefined) ?? 0;
    if (limb && part.hp > 0 && entity.status.alive && entity.stance !== "crouched" && walkW > 0.02 && basePosition) {
      const motionTime = (parent.userData.motionTime as number | undefined) ?? 0;
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

    // Attack choreography: wind up, contact, follow through. Applied BEFORE recoil so the recoil
    // punch lands on top of the pose as an accent rather than replacing it.
    const attackPhase = parent.userData.attackPhase as number | undefined;
    if (attackPhase !== undefined && part.hp > 0 && entity.status.alive) {
      const family = (parent.userData.weaponFamily as WeaponFamily) ?? "rifle";
      // Infantry pose from the Blender-authored control bank; everything else keeps the procedural
      // curve. A control bank describes a body, and a tank does not have one. If the generated data
      // is ever absent the bank check fails and the procedural path takes over, so the game still
      // runs with art/ deleted -- the same fallback rule the GLB models follow.
      if (isInfantryKind(entity.kind) && hasMotionBank(family)) {
        const m = sampleMotion(family, attackPhase);
        if (part.id === "rifle" || part.id === "cannon" || part.id === "gun") {
          mesh.position.z -= m.weaponDraw;
          mesh.position.y += m.bodyLift;
          mesh.rotation.x -= m.weaponPitch;
        } else if (part.role === "core") {
          mesh.rotation.x += m.torsoPitch;
          mesh.rotation.y += m.torsoTwist;
          mesh.position.y += m.bodyLift;
        } else if (limb === "arm-r") {
          mesh.rotation.x -= m.shoulderPitch;
          mesh.rotation.y += m.shoulderYaw;
        } else if (limb === "arm-l") {
          mesh.rotation.x -= m.offhandPitch;
        } else if (limb === "leg-l" || limb === "leg-r") {
          mesh.rotation.x += m.kneeBend * 0.4;
          mesh.position.y += m.bodyLift * 0.5;
        }
      } else {
        const pose = attackPose(family, attackPhase);
        if (part.id === "rifle" || part.id === "cannon" || part.id === "gun") {
          mesh.position.z -= pose.draw;
          mesh.rotation.x -= pose.lift;
        } else if (part.role === "core") {
          mesh.rotation.x += pose.brace * 0.5;
        } else if (limb === "arm-l" || limb === "arm-r") {
          mesh.rotation.x -= pose.lift * 0.4;
        }
      }
    }

    // Firing recoil: the weapon kicks back toward the body and tips its muzzle up, and the
    // torso rocks back a touch — a quick punch that decays over the round's first frames.
    const recoil = (parent.userData.recoil as number | undefined) ?? 0;
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
    const color = _paintColor.set(base).lerp(hexColor(0x33120f), injury * 0.55);
    if (ratio < 0.42 && part.hp > 0) color.lerp(hexColor(0xff5f35), 0.16 + injury * 0.18);
    if (!entity.status.alive) color.lerp(hexColor(0x08090a), 0.55);
    if (selected && part.hp > 0) color.lerp(hexColor(0xffffff), 0.24);
    if (targeted && part.hp > 0) color.lerp(hexColor(0xffd166), targetedPart ? 0.58 : 0.3);
    // Hit flash: a freshly-damaged part snaps white for a beat, so the eye catches what got hit.
    const flash = part.hp > 0 ? this.partFlash(entity.id, part.id) : 0;
    if (flash > 0) color.lerp(hexColor(0xffffff), flash * 0.7);
    spec.color.copy(color);
    const baseEmissive = mesh.userData.baseEmissive as number;
    const unitGlow = entity.kind !== "cover" && entity.team !== "neutral";
    const coverGlow = entity.kind === "cover" && part.hp > 0;
    const coverGlowColor = entity.coverKind === "cliff" ? 0x4a2284 : part.role === "volatile" ? 0x7a4200 : entity.coverKind === "ridge" ? 0x5a3a13 : 0x5c4620;
    const unitGlowColor = entity.team === "enemy" ? TEAMS.enemyGlowDim : TEAMS.playerGlowDim;
    spec.emissive.copy(hexColor(part.hp > 0 && targetedPart ? 0x4f3000 : part.hp > 0 && selected ? 0x0b3844 : accent ? baseEmissive : unitGlow ? unitGlowColor : coverGlow ? coverGlowColor : baseEmissive));
    spec.emissiveIntensity = part.hp > 0
      ? (mesh.userData.baseEmissiveIntensity as number) + (unitGlow ? 0.07 : 0) + (coverGlow ? 0.18 : 0) + (selected ? 0.58 : 0) + (targetedPart ? 0.72 : targeted ? 0.34 : 0)
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
    // "Still has orders left" cue: a player unit with command points remaining carries a slow pulse
    // on its weapon. This is a real affordance and it stays -- but it used to run at 0.14 plus up
    // to 0.18 of the team accent, which lit the whole weapon like a lantern. Since the command
    // phase is where the player spends nearly all their time, that meant EVERY gun in the game was
    // a glowing pale slab in almost every frame, and no amount of modelling detail survived it.
    // A third of the strength still reads as a pulse without erasing the metal underneath.
    if (this.commandPhase && entity.team === "player" && entity.status.alive && entity.commandPoints > 0 && part.role === "weapon" && part.hp > 0 && !selected && !targeted) {
      spec.emissive.copy(hexColor(entity.accent ?? this.playerAccent));
      spec.emissiveIntensity = Math.max(spec.emissiveIntensity, 0.05 + (Math.sin(performance.now() * 0.004 + (hash(entity.id) % 63)) + 1) * 0.03);
    }
    // Elites/bosses wear a burning gold trim so they read as the priority target.
    if (entity.elite && entity.status.alive && part.hp > 0 && !selected && !targeted && flash <= 0) {
      spec.emissive.copy(hexColor(0xffb020));
      spec.emissiveIntensity = Math.max(spec.emissiveIntensity, 0.3 + (Math.sin(performance.now() * 0.005) + 1) * 0.12);
    }
    spec.transparent = ghosted && part.hp > 0;
    spec.opacity = ghosted && part.hp > 0 ? (targeted ? 0.48 : 0.34) : 1;
    spec.depthWrite = !(ghosted && part.hp > 0);
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
      spec.emissive.copy(hexColor(0xff5f35));
      spec.emissiveIntensity = 0.18 + (1 - ratio) * 0.28;
    }
    // Gunship rotor: spin fast whenever it's alive so it reads as an idling/flying aircraft.
    if (entity.flying && part.id === "rotor" && entity.status.alive) {
      mesh.rotation.y += performance.now() * 0.03; // any rotorcraft (gunship, transport) spins its rotor
    }
    if (entity.kind === "tank" && part.role === "mobility" && mesh.geometry.type === "CylinderGeometry" && mesh.parent?.userData.moving) {
      mesh.rotation.y += ((mesh.parent.userData.motionTime as number | undefined) ?? 0) * 2.2;
    }
    if (flash > 0) {
      spec.emissive.copy(hexColor(0xffffff));
      spec.emissiveIntensity = Math.max(spec.emissiveIntensity, 0.5 + flash * 0.6);
    }
  
    spec.roughness = mesh.userData.roughness as number;
    spec.metalness = mesh.userData.metalness as number;
    mesh.material = partMaterial(spec);
  }

  private paintOutline(mesh: PartMesh, ghosted: boolean): void {
    for (const child of mesh.children) {
      if (!child.userData.outline) continue;
      (child as THREE.LineSegments).material = ghosted ? OUTLINE_MATERIALS.ghost : OUTLINE_MATERIALS.solid;
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
          this.projectileRoot.add(withoutCulling(puff));
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
      this.projectileRoot.add(withoutCulling(makeProjectileShadow(projectile, style.trailColor)));

      const flash = makeMuzzleFlash(projectile);
      if (flash) this.projectileRoot.add(withoutCulling(flash));

      // The head model + shadow + flash must NEVER frustum-cull: a fast/high round (e.g. a gunship's
      // arc or a shot near a screen edge) would otherwise vanish while the un-culled trail lingers.
      const model = makeProjectileModel(projectile);
      model.position.set(projectile.position.x, projectile.height, projectile.position.z);
      orientAlongShot(model, projectile.previous, projectile.position);
      this.projectileRoot.add(withoutCulling(model));
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

  /**
   * One-shot particulate for the things that happen during a resolve. Each is emitted on the FIRST
   * frame the event is seen, never per frame, so a long-lived blast does not keep spraying.
   *
   * Every burst fades its alpha and colour over life rather than vanishing -- particles that pop out
   * of existence are the single most common thing that makes an effect read as cheap.
   */
  private emitCombatParticles(sim: TacticalSim): void {
    const fx = this.particles;
    if (!fx) return;

    // MUZZLE FLASH. Emitted along the shot's own direction so it reads as gases leaving a barrel
    // rather than a puff hanging in the air, and kept very short-lived.
    for (const projectile of sim.projectiles) {
      if (this.burstIds.has(projectile.id)) continue;
      this.burstIds.add(projectile.id);
      if (projectile.kind === "grenade") continue; // thrown, not fired
      const heavy = projectile.kind === "shell";
      fx.directionalBurst({
        x: projectile.origin.x,
        y: projectile.originHeight,
        z: projectile.origin.z,
        dirX: projectile.direction.x,
        dirY: projectile.verticalSlope,
        dirZ: projectile.direction.z,
        count: heavy ? 14 : 7,
        color: [0xfff0c0, 0xffc46a, 0xff8a3a],
        speed: heavy ? [4.5, 9] : [3, 6],
        spread: heavy ? 0.5 : 0.34,
        size: heavy ? [0.09, 0.2] : [0.05, 0.12],
        life: [0.06, 0.16],
        gravity: 0,
        drag: 5,
        shape: ParticleShape.streak,
      });
      // A little smoke behind the flash on the big guns.
      if (heavy) {
        fx.burst({
          x: projectile.origin.x, y: projectile.originHeight, z: projectile.origin.z,
          count: 6, color: [0x6a6058, 0x8a8078], speed: [0.5, 1.4], up: 0.5, size: [0.22, 0.4],
          life: [0.5, 1.0], gravity: -0.25, drag: 1.6, jitter: 0.2,
        });
      }
    }

    for (const effect of sim.effects) {
      if (this.burstIds.has(effect.id)) continue;
      this.burstIds.add(effect.id);
      const ground = terrainHeightAt(effect.to);

      if (effect.type === "impact") {
        // Sparks fly BACK toward the shooter, the way a real ricochet throws material at the
        // incoming angle, plus a few dark shards of whatever was hit.
        const dx = effect.to.x - effect.from.x;
        const dz = effect.to.z - effect.from.z;
        const len = Math.hypot(dx, dz) || 1;
        fx.directionalBurst({
          x: effect.to.x, y: ground + 0.9, z: effect.to.z,
          dirX: -dx / len, dirY: 0.35, dirZ: -dz / len,
          count: 10, color: [0xffe9b0, 0xffb257], speed: [2.5, 6], spread: 0.9,
          size: [0.04, 0.1], life: [0.14, 0.34], gravity: 5.5, drag: 1.2,
          shape: ParticleShape.streak,
        });
        fx.burst({
          x: effect.to.x, y: ground + 0.8, z: effect.to.z,
          count: 5, color: [0x4a4038, 0x6b5f52], speed: [1.2, 3], up: 0.6,
          size: [0.05, 0.11], life: [0.3, 0.7], gravity: 7, drag: 0.5, jitter: 0.16,
          shape: ParticleShape.shard,
        });
      } else if (effect.type === "blast") {
        const radius = effect.radius ?? 2;
        // Fireball: fast, hot, short. Embers: slower, gravity-bound, longer -- the two together are
        // what make an explosion read as an event rather than a flash.
        fx.burst({
          x: effect.to.x, y: ground + 0.5, z: effect.to.z,
          count: Math.round(20 + radius * 10), color: [0xfff2cc, 0xffb04a, 0xff6a24],
          speed: [3, 9 + radius], up: 0.35, size: [0.18, 0.5], life: [0.18, 0.5],
          gravity: -1.2, drag: 2.4, jitter: radius * 0.2,
        });
        fx.burst({
          x: effect.to.x, y: ground + 0.4, z: effect.to.z,
          count: Math.round(10 + radius * 5), color: [0xffc46a, 0xff7a2e],
          speed: [2, 7], up: 0.55, size: [0.05, 0.13], life: [0.5, 1.3],
          gravity: 6.5, drag: 0.6, jitter: radius * 0.3, shape: ParticleShape.streak,
        });
        // Debris thrown out along the ground, then a smoke column that lingers after the light.
        fx.burst({
          x: effect.to.x, y: ground + 0.3, z: effect.to.z,
          count: Math.round(8 + radius * 4), color: [0x3f382f, 0x5a5044],
          speed: [2.5, 6.5], up: 0.3, vertical: 0.45, size: [0.07, 0.17],
          life: [0.6, 1.4], gravity: 8, drag: 0.4, shape: ParticleShape.shard,
        });
        fx.burst({
          x: effect.to.x, y: ground + 0.7, z: effect.to.z,
          count: Math.round(8 + radius * 3), color: [0x5e564e, 0x8c837a],
          speed: [0.6, 2.2], up: 0.9, size: [0.4, 0.95], life: [1.1, 2.4],
          gravity: -0.5, drag: 1.1, jitter: radius * 0.35,
        });
      } else if (effect.type === "topple") {
        // A falling column throws dust along its whole length, not just where it lands.
        fx.burst({
          x: effect.to.x, y: ground + 0.3, z: effect.to.z,
          count: 22, color: [0x7a6f62, 0x9c9186], speed: [1, 3.4], up: 0.4, vertical: 0.5,
          size: [0.3, 0.7], life: [0.8, 1.9], gravity: -0.2, drag: 1.3, jitter: 0.9,
        });
        fx.burst({
          x: effect.to.x, y: ground + 0.2, z: effect.to.z,
          count: 10, color: [0x4a423a, 0x6a6055], speed: [2, 5], up: 0.25,
          size: [0.08, 0.18], life: [0.5, 1.1], gravity: 8, drag: 0.5, shape: ParticleShape.shard,
        });
      } else if (effect.type === "beam") {
        fx.burst({
          x: effect.to.x, y: ground + 0.6, z: effect.to.z,
          count: 26, color: [0xd8f4ff, 0x8fd8ff, 0xffffff], speed: [1.5, 6], up: 0.8,
          size: [0.07, 0.2], life: [0.3, 0.9], gravity: -1.5, drag: 1.8, jitter: 0.3,
          shape: ParticleShape.streak,
        });
      }
    }

    // The id sets only ever grow otherwise; a long battle would leak a string per shot.
    if (this.burstIds.size > 900) this.burstIds.clear();
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

// Disable frustum culling on an object and all its descendants (projectile head/shadow/flash),
// so a round leaving the camera frustum can't disappear mid-flight while its trail keeps drawing.
function withoutCulling<T extends THREE.Object3D>(obj: T): T {
  obj.traverse((o) => { o.frustumCulled = false; });
  return obj;
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

// Team identity is applied by BLENDING toward a team hue, never by replacing a part's authored
// colour outright.
//
// Weapons used to return a flat near-white (0xeaffff player, 0xffd2bd enemy), which threw away
// every gun's authored gunmetal and turned each one into a pale slab -- a rifle, an auto-cannon and
// a flame projector all rendered as the same white plank, which is most of why the army looked
// unfinished no matter how much detail went into the models. Team readability does not depend on
// it: a unit already carries a team ring, a team emissive rim, and a team-blended torso. Heads got
// the same treatment for the same reason -- a helmet is authored per role and was being bleached.
// Per-side faction hues, set by the composition root at battle start. Defaults reproduce the
// original fixed team colours, so nothing changes until a faction actually declares one.
// The enemy faction tint defaulted to WHITE, and the enemy role blend ends with a 22% lerp toward
// it — so with no faction picked every enemy hull was bleached to pale pink. The default is now a
// rust red: the same slot, the same blend, but it deepens the salmon team read instead of washing
// it out. (Picking a faction overwrites all three at runtime.)
export const FACTION_TINT = { player: 0x5bc6e5, playerCore: 0x6fc4dd, enemy: 0x8f3524 };

function roleColor(entity: CombatEntity, role: PartRole, fallback: number): number {
  if (entity.team === "enemy" && entity.kind !== "cover") {
    if (role === "weapon") return blendHex(fallback, 0xff9c7a, 0.2);
    if (role === "mobility") return blendHex(fallback, 0x211a1b, 0.6);
    if (role === "head") return blendHex(fallback, 0xc08a70, 0.2);
    if (role === "utility") return blendHex(fallback, 0xff9c75, 0.45);
    if (role === "volatile") return blendHex(fallback, 0xff7d38, 0.5);
    // This used to repaint 68% of EVERY enemy surface with a light salmon, which is why enemy
    // armour, walls and HQs all came out pale pink with the modelling washed off. The team read is
    // already carried by the marker ring, the accent trim and the emissive glow; the hull only has
    // to sit in the warm-red family. A deeper blend at under half strength does that and leaves the
    // material visible underneath.
    return blendHex(blendHex(fallback, TEAMS.enemyBlend, 0.42), FACTION_TINT.enemy, 0.22);
  }
  if (entity.team === "player") {
    if (role === "weapon") return blendHex(fallback, 0x9fdcf0, 0.2);
    if (role === "mobility") return blendHex(fallback, 0x172328, 0.6);
    if (role === "head") return blendHex(fallback, 0xbfae90, 0.18);
    if (role === "utility") return blendHex(fallback, 0x8ff2d1, 0.45);
    if (role === "volatile") return blendHex(fallback, 0xffd06a, 0.5);
    // Structures wear the team hue on their CORE, which is most of an emplacement's surface, so a
    // 0.26 blend toward a light cyan turned dark steel and brown sandbags alike into pale teal.
    // Buildings get a lighter touch than a trooper's bodysuit does.
    if (role === "core") return blendHex(fallback, FACTION_TINT.playerCore, isBuildingKind(entity.kind) || isDefenseKind(entity.kind) ? 0.14 : 0.26);
    return blendHex(fallback, FACTION_TINT.player, 0.22);
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
  mesh.frustumCulled = false; // tracer/beam tubes hug the action — never cull (matches the trail/head)
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

interface InfantryBuild {
  /** Torso and limb width (x/z). The "how broad is this soldier" axis. */
  girth: number;
  /** Overall height (y). Combined with girth this is the whole silhouette read. */
  stature: number;
  /** Forward pitch of the whole body, in radians. Aggression, or a marksman's hunch. */
  lean: number;
}

// Per-role body proportions. Every kind used to share one identical chassis with its signature
// kit bolted on top; close up that kit reads clearly, but at the distance the game is actually
// played ~70% of the silhouette was the same shape for all twelve infantry, so the
// black-silhouette test failed even though the detail work was there. Proportion survives at any
// zoom, where greebles do not.
const INFANTRY_BUILDS: Partial<Record<EntityKind, Partial<InfantryBuild>>> = {
  heavy: { girth: 1.32, stature: 0.93, lean: 0.05 },
  flamer: { girth: 1.22, stature: 0.97 },
  striker: { girth: 1.08, stature: 1.02, lean: 0.2 },
  scout: { girth: 0.83, stature: 1.09, lean: 0.12 },
  sniper: { girth: 0.87, stature: 1.05, lean: 0.15 },
  sapper: { girth: 0.97, stature: 0.92, lean: 0.16 },
  mortar: { girth: 1.15, stature: 0.96 },
  grenadier: { girth: 1.12, stature: 0.98 },
  medic: { girth: 0.9, stature: 1.03 },
  engineer: { girth: 1.03, stature: 0.98 },
  droneop: { girth: 0.9, stature: 1.04 },
};

const DEFAULT_BUILD: InfantryBuild = { girth: 1, stature: 1, lean: 0 };

// ATTACK CHOREOGRAPHY.
//
// Firing used to be one thing: a recoil punch on the frame the round left the barrel. That reads as
// a unit twitching, not as a unit shooting, because the two halves that sell a shot are missing --
// the ANTICIPATION before it (settling, bracing, raising the weapon) and the FOLLOW-THROUGH after
// (absorbing it, recovering aim). A shot with no wind-up also gives the player nothing to read: by
// the time the recoil happens the round has already been resolved.
//
// The phase is driven by the ORDER's own elapsed/duration, never by a clock of its own. Combat owns
// durations; animation owns pose. That means an attack animation can never desync from the shot it
// belongs to, and slowing the action pace slows the choreography with it for free.
export type WeaponFamily = "rifle" | "burst" | "marksman" | "cannon" | "launcher" | "flamer" | "melee";

export function weaponFamily(kind: EntityKind): WeaponFamily {
  if (kind === "striker") return "melee";
  if (kind === "heavy") return "burst";
  if (kind === "sniper") return "marksman";
  if (kind === "grenadier" || kind === "mortar") return "launcher";
  if (kind === "flamer") return "flamer";
  if (kind === "tank" || kind === "artillery" || kind === "exturret") return "cannon";
  return "rifle";
}

/** Where in its swing/wind-up a family is at `phase` (0..1 across the order). */
export interface AttackPose {
  /** Weapon pull toward the body (negative = thrust forward). */
  draw: number;
  /** Weapon muzzle pitch, radians. Positive lifts the muzzle. */
  lift: number;
  /** Torso lean into the shot, radians. */
  brace: number;
}

// Each family is authored as anticipation -> contact -> recovery around its own contact point.
// A marksman settles for a long time and barely moves; a melee striker winds all the way back and
// commits through the target; a launcher hoists the tube before it thumps.
const FAMILY_SHAPE: Record<WeaponFamily, { contact: number; draw: number; lift: number; brace: number }> = {
  rifle: { contact: 0.42, draw: 0.05, lift: 0.1, brace: 0.06 },
  burst: { contact: 0.34, draw: 0.07, lift: 0.06, brace: 0.11 },
  marksman: { contact: 0.62, draw: 0.02, lift: 0.03, brace: 0.03 },
  cannon: { contact: 0.46, draw: 0.03, lift: 0.05, brace: 0.04 },
  launcher: { contact: 0.44, draw: 0.09, lift: 0.34, brace: 0.09 },
  flamer: { contact: 0.3, draw: 0.04, lift: 0.05, brace: 0.08 },
  melee: { contact: 0.5, draw: 0.34, lift: 0.5, brace: 0.3 },
};

export function attackPose(family: WeaponFamily, phase: number): AttackPose {
  const shape = FAMILY_SHAPE[family];
  const t = Math.max(0, Math.min(1, phase));
  if (t <= shape.contact) {
    // Wind up. Eased so the weapon drifts back slowly and arrives at contact, rather than snapping.
    const w = shape.contact <= 0 ? 1 : t / shape.contact;
    const eased = w * w;
    return { draw: shape.draw * eased, lift: shape.lift * eased, brace: shape.brace * eased };
  }
  // Follow through and settle. This has to START at the wind-up's peak, or the weapon jumps on the
  // exact frame the shot fires -- a visible pop, which the continuity test caught on first run.
  // A decaying cosine leaves the peak continuously, crosses rest, overshoots slightly the other
  // way, and returns to zero: the shape of something absorbing a shot rather than easing off it.
  const w = (t - shape.contact) / Math.max(0.05, 1 - shape.contact);
  const settle = (1 - w) * Math.cos(w * Math.PI * 1.5);
  return { draw: shape.draw * settle, lift: shape.lift * settle, brace: shape.brace * settle };
}

// THE HARD-EDGE PROBLEM.
//
// Every unit, structure and prop in the game was assembled from raw THREE.BoxGeometry. A raw box
// has three things working against it: its edges are perfectly sharp, so they catch no highlight
// and read as a flat silhouette; its faces are uniformly lit, so form is only legible where two
// faces meet at a visible angle; and the eye has learned to read that exact shape as "placeholder".
// That is most of why the army looked like blocks rather than hardware.
//
// A chamfer fixes all three at once. A bevelled edge is a narrow band whose normal sweeps between
// the two faces, so it picks up a bright rim from the key light and a dark one on the shadow side.
// That band is what makes a shape read as machined metal, and it costs one geometry swap.
//
// Geometries are CACHED BY DIMENSION and marked `userData.shared`, because the same plate size
// recurs constantly across a roster and disposal already skips shared geometry. Without the cache
// this would allocate a fresh bevelled mesh per part per unit, which is both slower to build and
// a real memory cost at ~120 parts per trooper.
/**
 * VERTEX-COLOUR AO. Bakes contact shading into a pooled part geometry: downward-facing surfaces go
 * dark, upward-facing ones lift, and everything gains a slight vertical gradient from the part's
 * own base to its top. This is what a set of flat-shaded boxes is missing compared to a baked
 * asset — not detail, but the darkening under and inside forms that tells the eye where a shape
 * sits. Costs nothing at runtime (the geometry is shared and baked once) and needs no asset.
 */
function bakeVertexAO(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position || !normal) return geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const height = Math.max(1e-4, box.max.y - box.min.y);
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    const up = clamp(normal.getY(i), -1, 1);
    // Facing term: under-surfaces to 0.58, sides ~0.88, tops just over 1.
    const facing = up >= 0 ? 0.88 + up * 0.16 : 0.88 + up * 0.3;
    // Height term: the bottom of a part sits in its own contact shadow.
    const t = (position.getY(i) - box.min.y) / height;
    const shade = clamp(facing * (0.86 + t * 0.16), 0.5, 1.1);
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const bevelCache = new Map<string, THREE.BufferGeometry>();

/**
 * A box with chamfered edges. `bevel` is a fraction of the smallest dimension (0..0.5); the
 * default reads as milled hardware, and a lower value suits thin plates where a big chamfer would
 * eat the whole part.
 */
function beveledBox(w: number, h: number, d: number, bevel = 0.17): THREE.BufferGeometry {
  const min = Math.min(w, h, d);
  // A radius at or above half the smallest dimension degenerates (RoundedBoxGeometry needs room
  // on both sides), and very thin parts look better with a proportionally smaller chamfer anyway.
  const radius = Math.max(0.006, Math.min(min * bevel, min * 0.48));
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${radius.toFixed(4)}`;
  const hit = bevelCache.get(key);
  if (hit) return hit;
  // One segment: enough for the highlight band to exist, cheap enough to put on every part.
  const geo = bakeVertexAO(new RoundedBoxGeometry(w, h, d, 1, radius));
  geo.userData.shared = true;
  bevelCache.set(key, geo);
  return geo;
}

function infantryBuild(kind: EntityKind): InfantryBuild {
  return { ...DEFAULT_BUILD, ...(INFANTRY_BUILDS[kind] ?? {}) };
}

// UNIT PALETTE.
//
// `trim` is the armour: breastplate, hip plates, pauldron rims, and most weapons. Every entry used
// to be a near-white (0xffffff, 0xf0fdff, 0xfff0ba...), which is why the roster read as bright
// plastic toys rather than equipment -- a soldier was a saturated pastel body wearing white kit and
// carrying a white gun. Trim is now dark tempered metal, tinted a little toward each role's hue so
// the units still differ head to toe, and the saturated colour is spent only where it identifies
// the unit: the bodysuit and the signature kit.
//
// Bodies are pulled down in value and saturation for the same reason. They still separate cleanly
// from one another -- the hues are spread right around the wheel -- but they now sit in a range
// where the key light can put a highlight ON them, which a near-white surface cannot receive.
function infantryPalette(kind: string): { body: number; trim: number; pack: number } {
  switch (kind) {
    case "scout": return { body: 0x4f8f63, trim: 0x36443c, pack: 0x24503a };
    case "sniper": return { body: 0x44718c, trim: 0x33414a, pack: 0x1b3a4e };
    case "striker": return { body: 0x7d51ad, trim: 0x3b3350, pack: 0x39235c };
    case "heavy": return { body: 0xa05c30, trim: 0x453930, pack: 0x4a2716 };
    case "grenadier": return { body: 0xba7c2c, trim: 0x4a4030, pack: 0x5c3510 };
    case "mortar": return { body: 0xa17d3c, trim: 0x46402f, pack: 0x54401a };
    case "medic": return { body: 0xb85763, trim: 0x4a3a3d, pack: 0x5e2129 };
    case "engineer": return { body: 0xa89232, trim: 0x474328, pack: 0x54481a };
    case "flamer": return { body: 0xb86133, trim: 0x4a3a30, pack: 0x6a2812 };
    case "droneop": return { body: 0x6d8299, trim: 0x3d4550, pack: 0x2c3f52 };
    case "sapper": return { body: 0x9c8c4c, trim: 0x46422f, pack: 0x4a3f1e };
    default: return { body: 0x2f8f80, trim: 0x35424a, pack: 0x1d5f66 };
  }
}

// Terrain is built from flat-topped raised rectangles. Render each as a crisp box: shaded
// sides, an accent-toned cap, and a dark edge outline so steps read clearly from any angle.
// The playable arena is a raised slab, and before this the world simply ENDED at its rail: you
// could see past the edge into the sky, which made the whole battlefield read as a tabletop
// diorama floating in a void. This lays a continuous landscape around it -- an outer ground plane
// far wider than the arena, plus a ring of distant ridges -- so the ground runs to the horizon and
// dissolves into fog instead of stopping. Deterministic from the map seed; nothing here is
// interactive, collidable, or shadow-casting, so it costs a handful of draw calls.
// A flat-coloured floor is why the big maps measured as having almost no dynamic range: on
// Dustbowl the ground fills most of the frame, so a single uniform tone put ~95% of the image
// inside a 0.05 luminance band regardless of how the lighting was tuned. This bakes a mottled
// value break-up into the floor material -- large soft patches, finer grain, and a few darker
// weathered streaks. Procedural and deterministic, so no asset is required and the game still
// runs with an empty asset dir.
interface GroundSurface {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

function makeGroundTexture(theme: MapTheme): GroundSurface {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // The texture is a MULTIPLIER, not an albedo: it is drawn around white and the material's own
  // `color` supplies the hue. Baking theme.ground into the texture AND setting the material colour
  // to theme.ground multiplied the ground tone by itself, which is why every map read as a muddy,
  // low-contrast field no matter how the lights were tuned. Neutral detail here also lets the arena
  // floor, the mesa caps and the outer plain share one texture at three different tints.
  const ground = new THREE.Color(theme.ground);
  const accent = new THREE.Color(theme.groundAccent);
  // Hue mottling without hue: accent-over-ground as a per-channel ratio, normalised to the same
  // brightness, so patches shift the ground's colour without changing its value.
  const ratio = new THREE.Color(
    clamp(accent.r / Math.max(0.04, ground.r), 0.45, 1.8),
    clamp(accent.g / Math.max(0.04, ground.g), 0.45, 1.8),
    clamp(accent.b / Math.max(0.04, ground.b), 0.45, 1.8),
  );
  const ratioLuma = Math.max(0.2, ratio.r * 0.299 + ratio.g * 0.587 + ratio.b * 0.114);
  ratio.multiplyScalar(1 / ratioLuma);
  const WHITE = new THREE.Color(1, 1, 1);
  const shade = (level: number, toward = 0): THREE.Color =>
    WHITE.clone().lerp(ratio, toward).multiplyScalar(level);
  const css = (c: THREE.Color, a = 1): string =>
    `rgba(${Math.round(clamp(c.r, 0, 1) * 255)},${Math.round(clamp(c.g, 0, 1) * 255)},${Math.round(clamp(c.b, 0, 1) * 255)},${a})`;

  ctx.fillStyle = css(shade(0.94));
  ctx.fillRect(0, 0, size, size);

  let seed = 0x1234567;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  // Everything is stamped through `wrapped`, which repeats any mark that crosses an edge on the
  // opposite side. That makes the tile SEAMLESS, which is what lets it be tiled small enough
  // (~11 world units) to still carry detail under the camera. The previous 19-unit tile was the
  // only way to hide a hard seam, and at that scale the texture had dissolved into soft mush --
  // exactly the "flat empty plane" read.
  const wrapped = (x: number, y: number, reach: number, draw: (px: number, py: number) => void): void => {
    for (const dx of x < reach ? [0, size] : x > size - reach ? [0, -size] : [0]) {
      for (const dy of y < reach ? [0, size] : y > size - reach ? [0, -size] : [0]) draw(x + dx, y + dy);
    }
  };

  // Broad tonal patches: the low-frequency variation the eye reads as "ground", not "surface".
  for (let i = 0; i < 110; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 40 + rand() * 190;
    const tone = shade(0.66 + rand() * 0.5, rand() * 0.9);
    wrapped(x, y, r, (px, py) => {
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, css(tone, 0.62));
      grad.addColorStop(1, css(tone, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }

  // Darker weathered streaks: these are what actually open up the low end of the histogram.
  for (let i = 0; i < 12; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const w = 90 + rand() * 240;
    const h = 40 + rand() * 110;
    const angle = rand() * Math.PI;
    const alpha = 0.08 + rand() * 0.08;
    const streak = shade(0.62);
    wrapped(x, y, w, (px, py) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      grad.addColorStop(0, css(streak, 0));
      grad.addColorStop(0.5, css(streak, alpha));
      grad.addColorStop(1, css(streak, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    });
  }

  // Cracks. Thin dark branching lines are the single cheapest thing that makes a procedural
  // ground read as a SURFACE with a history rather than as a gradient — and they give the normal
  // map something with a hard edge to catch the low key light on.
  ctx.lineCap = "round";
  for (let i = 0; i < 20; i += 1) {
    const x0 = rand() * size;
    const y0 = rand() * size;
    const steps = 5 + Math.floor(rand() * 7);
    const step = 14 + rand() * 26;
    let heading = rand() * Math.PI * 2;
    const pts: [number, number][] = [[0, 0]];
    for (let k = 0; k < steps; k += 1) {
      heading += (rand() - 0.5) * 1.1;
      const [lx, ly] = pts[pts.length - 1];
      pts.push([lx + Math.cos(heading) * step, ly + Math.sin(heading) * step]);
    }
    const reach = steps * step;
    const width = 0.8 + rand() * 1.3;
    const dark = shade(0.5);
    wrapped(x0, y0, reach, (px, py) => {
      ctx.strokeStyle = css(dark, 0.3);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (const [dx, dy] of pts.slice(1)) ctx.lineTo(px + dx, py + dy);
      ctx.stroke();
    });
  }

  // Pebbles and pits: lit crown over a dark seat, so each one reads as a rounded stone half-buried
  // in the ground once the normal map picks it up.
  for (let i = 0; i < 1500; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1.1 + rand() * 3.6;
    const lift = rand() < 0.62;
    const tone = shade(lift ? 1.16 : 0.68, 0.3 + rand() * 0.5);
    wrapped(x, y, r + 2, (px, py) => {
      ctx.fillStyle = css(tone, 0.16 + rand() * 0.24);
      ctx.beginPath();
      ctx.ellipse(px, py, r, r * (0.6 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Fine grain so the surface does not read as smooth plastic when the camera is close.
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 30;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(image, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return { map, normalMap: makeNormalMap(data, size) };
}

/**
 * Paint slow, non-repeating value + hue drift into a geometry's vertex colours. Two octaves of a
 * cheap deterministic wave field over world x/z: the long octave is what breaks up a big empty
 * map, the short one keeps the mid-distance from reading as a gradient. Vertex colours MULTIPLY
 * with map x material colour, so this rides on top of the tiled detail rather than replacing it.
 */
function paintMacroVariation(geometry: THREE.BufferGeometry, warm: THREE.Color): void {
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const tint = new THREE.Color();
  const WHITE = new THREE.Color(1, 1, 1);
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const long = Math.sin(x * 0.031 + 1.7) * Math.cos(z * 0.026 - 0.4)
      + 0.6 * Math.sin((x + z) * 0.017 + 2.3);
    const short = Math.sin(x * 0.11 - 0.8) * Math.cos(z * 0.093 + 1.1);
    const drift = long * 0.5 + short * 0.18; // ~[-0.8, 0.8]
    const value = clamp(1 + drift * 0.28, 0.66, 1.26);
    // The lighter patches also lean toward the map's accent hue, which is what puts colour VARIANCE
    // into an otherwise single-hue field rather than just lightening it.
    tint.copy(WHITE).lerp(warm, Math.max(0, drift) * 0.4).multiplyScalar(value);
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/**
 * Sobel a normal map out of an albedo's luminance. The ground's detail — pebbles, cracks, grain —
 * is already drawn as light-over-dark, so its brightness IS a usable height field, and lighting
 * that relief is what turns a painted plane into a surface under a low sun. Far cheaper than
 * authoring a second texture, and it stays in lockstep with the albedo by construction.
 */
function makeNormalMap(albedo: Uint8ClampedArray, size: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const out = ctx.createImageData(size, size);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < lum.length; i += 1) {
    const o = i * 4;
    lum[i] = (albedo[o] * 0.299 + albedo[o + 1] * 0.587 + albedo[o + 2] * 0.114) / 255;
  }
  const at = (x: number, y: number): number => lum[((y + size) % size) * size + ((x + size) % size)];
  const strength = 1.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const len = Math.hypot(nx, ny, 1);
      const o = (y * size + x) * 4;
      out.data[o] = ((nx / len) * 0.5 + 0.5) * 255;
      out.data[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      out.data[o + 2] = (1 / len) * 0.5 * 255 + 127.5;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function makeSurroundings(theme: MapTheme, width: number, depth: number, surface: GroundSurface): THREE.Group {
  const group = new THREE.Group();
  group.name = "surroundings";
  const ground = new THREE.Color(theme.ground);
  const fog = new THREE.Color(theme.fog);

  // Outer plain: sits a hair below the arena slab so the slab's own edge still reads as a lip
  // rather than z-fighting with it. Tinted toward fog so it recedes instead of competing.
  // The outer plain used to sit at 86% of the arena's own value, so the play space had no edge:
  // the battlefield and everything around it were the same field of colour and the eye had nowhere
  // to land. Into the Breach's strongest compositional move is a BRIGHT BOARD ON A DARK SURROUND,
  // and it costs one multiply. The plain drops to a third of the arena's value and cools toward
  // fog, so the arena reads as a lit stage without a single extra draw call.
  const plainColor = ground.clone().lerp(fog, 0.3).multiplyScalar(0.34);
  // Carries the SAME ground texture as the arena floor (tiled to match world scale), so the
  // battlefield reads as a marked-out part of a landscape rather than a lit diorama sitting on a
  // separate, differently-coloured table.
  const plainMap = surface.map.clone();
  plainMap.needsUpdate = true;
  plainMap.repeat.set((width * 9) / GROUND_TILE, (depth * 9) / GROUND_TILE);
  const plain = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 9, depth * 9),
    new THREE.MeshStandardMaterial({ map: plainMap, color: plainColor, roughness: 1, metalness: 0 }),
  );
  plain.rotation.x = -Math.PI / 2;
  plain.position.y = -0.22;
  group.add(plain);

  // Distant ridges: a ring of low-poly bluffs well outside the play space. They give the eye a
  // horizon line and a sense of scale, and being progressively fog-tinted by distance they read
  // as depth rather than as props. Seeded so a map always looks like itself.
  let seed = 0x9e3779b9;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const ridgeGeo = new THREE.BoxGeometry(1, 1, 1);
  ridgeGeo.userData.shared = true;
  const radius = Math.max(width, depth) * 0.78;
  const rings = 3;
  for (let ring = 0; ring < rings; ring += 1) {
    const distance = radius * (1.15 + ring * 0.42);
    // Farther ridges sit closer to pure fog colour, which is what sells the depth.
    const blend = 0.42 + ring * 0.22;
    const material = new THREE.MeshStandardMaterial({
      color: ground.clone().lerp(fog, blend).multiplyScalar(0.9 - ring * 0.06),
      roughness: 1,
      metalness: 0,
    });
    const count = 26 + ring * 8;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + rand() * 0.16;
      const jitter = 0.86 + rand() * 0.4;
      const height = (3.2 + rand() * 7.5) * (1 + ring * 0.55);
      const spanX = (7 + rand() * 16) * (1 + ring * 0.3);
      const spanZ = (7 + rand() * 16) * (1 + ring * 0.3);
      const bluff = new THREE.Mesh(ridgeGeo, material);
      bluff.position.set(Math.cos(angle) * distance * jitter, height * 0.5 - 1.2, Math.sin(angle) * distance * jitter);
      bluff.scale.set(spanX, height, spanZ);
      bluff.rotation.y = rand() * Math.PI;
      group.add(bluff);
    }
  }
  return group;
}


/**
 * SURFACE PLATES — the board read.
 *
 * A tactics battlefield has to be *composed of readable things*, the way an Into the Breach board
 * is: patches of ground that differ in value and hue so the eye has something to hold on to. A
 * single continuous plane, however well textured, reads as empty no matter what is painted on it.
 *
 * These are cosmetic only and deliberately DO NOT create affordances: each plate is a flat patch
 * whose top sits fractionally BELOW standing height, so no plate edge can be mistaken for a step
 * the way a real terrain block (>TERRAIN_STEP) is. Movement stays continuous; nothing here is
 * collided with, targeted or walked around.
 *
 * All plates of a variant merge into ONE geometry, so the whole layer is three draw calls.
 */
/** One ground-texture tile per this many world units. Floor, mesa caps and plates all use it. */
const GROUND_TILE = 11;
const PLATE_THICKNESS = 0.01;

/**
 * Replace a (roughly flat, ground-lying) geometry's UVs with world-space ones at `tile` units per
 * texture repeat, so it tiles in lockstep with everything else on the ground.
 */
function rewriteWorldUvs(geometry: THREE.BufferGeometry, tile: number): void {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  if (!position || !uv) return;
  for (let i = 0; i < position.count; i += 1) {
    uv.setXY(i, position.getX(i) / tile, position.getZ(i) / tile);
  }
  uv.needsUpdate = true;
}

function makeGroundPlates(theme: MapTheme, width: number, depth: number, surface: GroundSurface): THREE.Group {
  const group = new THREE.Group();
  group.name = "plates";
  let seed = 0x51ed5eed ^ (theme.ground >>> 0);
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const ground = new THREE.Color(theme.ground);
  const accent = new THREE.Color(theme.groundAccent);
  // Three surface variants spread around the map's own two authored tones: a darker damp/shadowed
  // patch, a paler dried/dusty one, and a mid gravel bed. Value spread is the point — a hue-only
  // difference vanishes in a greyscale pass, which is how the eye reads a board at a glance.
  const variants = [
    { color: ground.clone().lerp(new THREE.Color(0x0a0d10), 0.17), roughness: 0.98 },
    { color: ground.clone().lerp(accent, 0.55).multiplyScalar(1.13), roughness: 0.93 },
    { color: ground.clone().lerp(accent, 0.22).multiplyScalar(0.82), roughness: 0.96 },
  ];
  // The plate layer addresses the ground textures at repeat 1 and gets its tiling from the
  // world-space UVs above, so one clone pair serves all three variants.
  const plateMap = surface.map.clone();
  plateMap.needsUpdate = true;
  plateMap.repeat.set(1, 1);
  const plateNormal = surface.normalMap.clone();
  plateNormal.needsUpdate = true;
  plateNormal.repeat.set(1, 1);
  const area = width * depth;
  const perVariant = Math.max(5, Math.round(area / 620));
  for (const variant of variants) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < perVariant; i += 1) {
      // Two overlapping rounded slabs per patch, so the outline is irregular rather than a rectangle.
      const cx = (rand() - 0.5) * width * 0.92;
      const cz = (rand() - 0.5) * depth * 0.92;
      const spin = rand() * Math.PI;
      // Four overlapping rounded slabs per patch at scattered angles. Two gave a rectangle with
      // soft corners, which reads as something PAINTED on the ground; four at spread angles give a
      // lumpy union outline that reads as the ground itself changing.
      for (let k = 0; k < 4; k += 1) {
        const w = 5 + rand() * 11;
        const d = 4 + rand() * 9;
        // 2cm thick and topping out exactly at ground level. A patch of ground must never grow a
        // visible SIDE: at this camera a few centimetres of lit edge reads as a terrace, and a
        // terrace the player can walk straight over is a lie about the terrain.
        const geo = new RoundedBoxGeometry(w, PLATE_THICKNESS, d, 1, Math.min(1.4, Math.min(w, d) * 0.3));
        const m = new THREE.Matrix4()
          .makeRotationY(spin + (rand() - 0.5) * 1.6)
          .setPosition(cx + (rand() - 0.5) * 7, 0, cz + (rand() - 0.5) * 7);
        geo.applyMatrix4(m);
        parts.push(geo);
      }
    }
    const merged = mergeGeometries(parts, false);
    for (const geo of parts) geo.dispose();
    if (!merged) continue;
    // WORLD-SPACE UVs. Each slab's own UVs run 0..1 across a ~7-unit patch, so with the floor's
    // repeat (one tile per 11 world units) applied on top, the plates tiled roughly eleven times
    // finer than the ground they sit on -- which aliased into diagonal moiré hatching at tactical
    // distance. Rewriting the UVs from world position makes plate and floor tile identically, so
    // the texture reads as one continuous surface with the colour changing on top of it.
    rewriteWorldUvs(merged, GROUND_TILE);
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        map: plateMap,
        normalMap: plateNormal,
        normalScale: new THREE.Vector2(0.45, 0.45),
        color: variant.color,
        roughness: variant.roughness,
        metalness: 0.02,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function makeTerrainBlocks(groundColor: number, accentColor: number, surface: GroundSurface): THREE.Group {
  const group = new THREE.Group();
  const sideColor = new THREE.Color(groundColor).multiplyScalar(0.66);
  // The cap used to be a near-white tint of the accent, which made every mesa read as a pale slab
  // sitting ON the battlefield rather than a rise OF it. Keeping it near the ground tone and
  // sharing the ground texture ties them together; the lit/shadowed side faces carry the height
  // read instead, which is what the stronger key light is for.
  const capColor = new THREE.Color(accentColor).lerp(new THREE.Color(groundColor), 0.45);
  const sideMaterial = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.95, metalness: 0.03 });
  // polygonOffset keeps the cap's top from z-fighting the body when surfaces nearly coincide.
  const capMaterial = new THREE.MeshStandardMaterial({ map: surface.map, normalMap: surface.normalMap, normalScale: new THREE.Vector2(0.45, 0.45), color: capColor, roughness: 0.9, metalness: 0.03, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
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

// Impassable water footprints render as a translucent, faintly reflective surface just above the
// floor; walkable bridge strips are raised timber decks that read clearly as the way across.
function makeWaterAndBridges(theme: MapTheme, surface: GroundSurface): THREE.Group {
  const group = new THREE.Group();
  const water = terrainWater();
  if (!water.length) return group;

  // The SIM keeps water at ground height on purpose -- it blocks movement but must not block a
  // flat line of fire. Visually that made a channel read as blue paper laid on the ground. So the
  // rendering sinks it: a dark channel bed below grade, sloped banks around the lip, and the water
  // surface just under the ground plane. Purely cosmetic -- nothing here changes a single
  // collision or line-of-sight test, which still see a flat rect at height zero.
  const BED = -0.55;
  const SURFACE = -0.06;
  const bedColor = new THREE.Color(theme.ground).multiplyScalar(0.34);
  const bedMat = new THREE.MeshStandardMaterial({ color: bedColor, roughness: 1, metalness: 0 });
  const bankMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.ground).multiplyScalar(0.62), roughness: 0.98, metalness: 0 });
  const waterColor = new THREE.Color(0x2f6d94).lerp(new THREE.Color(theme.fog), 0.22);
  // Smoother and glossier than the ground so it catches the key light and reads as a liquid
  // surface rather than a flat panel; still short of a mirror, which would strobe as the camera moves.
  // A flat translucent panel reads as blue tape laid on the ground however dark you make it: with
  // no surface normal there is nothing for the key light to break up. Borrowing the ground's normal
  // map (tiled tight, scrolled slowly by syncWater) gives it a moving ripple for the cost of one
  // texture clone -- the single change that makes a channel read as water rather than as paint.
  const ripple = surface.normalMap.clone();
  ripple.needsUpdate = true;
  ripple.repeat.set(2.4, 2.4);
  const waterMat = new THREE.MeshStandardMaterial({
    color: waterColor,
    transparent: true,
    opacity: 0.82,
    roughness: 0.18,
    metalness: 0.42,
    depthWrite: false,
    normalMap: ripple,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  group.userData.ripple = ripple;

  for (const r of water) {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;

    // Channel bed, sunk below grade so the banks have something to fall away to.
    const bed = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), bedMat);
    bed.position.set(cx, BED, cz);
    bed.receiveShadow = true;
    group.add(bed);

    // Bank lips: four thin walls around the rim. These are what actually sell the depth from the
    // tactical camera, because they catch the key light on one side and fall into shadow on the other.
    const lip = 0.34;
    for (const [ox, oz, sx, sz] of [
      [0, -(d / 2), w + lip * 2, lip],
      [0, d / 2, w + lip * 2, lip],
      [-(w / 2), 0, lip, d],
      [w / 2, 0, lip, d],
    ] as const) {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.42, sz), bankMat);
      bank.position.set(cx + ox, -0.14, cz + oz);
      bank.castShadow = true;
      bank.receiveShadow = true;
      group.add(bank);
    }

    const plane = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, d), waterMat);
    plane.position.set(cx, SURFACE, cz);
    plane.receiveShadow = true;
    group.add(plane);
  }

  const deckMat = new THREE.MeshStandardMaterial({ color: 0x6b5136, roughness: 0.82, metalness: 0.04 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x4a3722, roughness: 0.85, metalness: 0.04 });
  const pileMat = new THREE.MeshStandardMaterial({ color: 0x3d2c1b, roughness: 0.9, metalness: 0.03 });
  for (const r of terrainBridges()) {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const along = w >= d;
    const span = along ? w : d;

    const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), deckMat);
    deck.position.set(cx, 0.09, cz);
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    // Piles down into the channel bed. A deck floating over open water was the other half of why
    // a crossing read as a painted rectangle rather than a structure.
    const piles = Math.max(2, Math.round(span / 3));
    for (let i = 0; i < piles; i += 1) {
      const t = piles === 1 ? 0.5 : i / (piles - 1);
      const at = -span / 2 + span * t;
      for (const side of [-1, 1]) {
        const off = (along ? d : w) / 2 - 0.18;
        const pile = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.16), pileMat);
        pile.position.set(
          cx + (along ? at : side * off),
          -0.27,
          cz + (along ? side * off : at),
        );
        pile.castShadow = true;
        group.add(pile);
      }
    }

    // Low side rails along the bridge's long axis so it reads as a crossing, not just a plank.
    const railThick = 0.14;
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(along ? span : railThick, 0.34, along ? railThick : span),
        railMat,
      );
      const off = (along ? d : w) / 2 - railThick / 2;
      rail.position.set(cx + (along ? 0 : side * off), 0.26, cz + (along ? side * off : 0));
      rail.castShadow = true;
      group.add(rail);
    }
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
/**
 * The sky gradient AND the horizon colour it ends on. These were two separately-eyeballed values:
 * the sky faded to `sky.lerp(fog, 0.65) * 1.08` while the fog used `theme.fog` raw. When the fog
 * colour does not equal the sky's horizon colour, distant objects read as TURNING GREY instead of
 * receding into haze — the single loudest "this is a demo" tell in an outdoor scene. One constant
 * now feeds both.
 */
function makeThemeSky(theme: MapTheme): { texture: THREE.CanvasTexture; horizon: THREE.Color } {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const sky = new THREE.Color(theme.sky);
  const horizon = sky.clone().lerp(new THREE.Color(theme.fog), 0.65).multiplyScalar(1.08);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const zenith = sky.clone().multiplyScalar(0.42).lerp(new THREE.Color(0x101b30), 0.35);
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
  return { texture, horizon };
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
  enemyBlend: 0x9e3c2a,
  playerGlowDim: 0x063a44,
  playerAccentGlow: 0x5ff1ff,
};
const TEAMS_DEFAULT = { ...TEAMS };
const TEAMS_HIGH_CONTRAST = {
  enemyAccent: 0xffa11e,
  enemyMarker: 0xffb020,
  enemyGlowDim: 0x4f3300,
  enemyBlend: 0xa8690f,
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

// ---------------------------------------------------------------------------
// POOLED PART MATERIALS
//
// Every procedural part mesh used to own its own MeshStandardMaterial: ~1970 of them in the
// stress scenario. three refreshes the common + lights uniform blocks once per material per
// frame, so that count — not the triangle count — was the top of the CPU profile. Parts now
// resolve their painted appearance to a SHARED material every frame, which also lets the
// painter sort draw identical-looking parts back to back with no program or uniform change.
//
// The key quantizes: 6 bits per albedo channel, 5 per emissive channel, 0.05 emissive
// intensity, 16 roughness/metalness steps, 8 opacity steps. All below the eye's threshold at
// tactical distance, and — the point — BOUNDED, so a sine-driven glow pulse can't re-create the
// per-mesh explosion one frame at a time.
export interface PartMatSpec {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}

const _partSpec: PartMatSpec = {
  color: new THREE.Color(),
  emissive: new THREE.Color(),
  emissiveIntensity: 0,
  roughness: 0.62,
  metalness: 0.08,
  transparent: false,
  opacity: 1,
  depthWrite: true,
};
const _poolColor = new THREE.Color();
const _poolEmissive = new THREE.Color();
const partMaterialPool = new Map<number, THREE.MeshStandardMaterial>();

const q = (value: number, steps: number): number => Math.min(steps, Math.max(0, Math.round(value * steps)));

function partMaterial(spec: PartMatSpec): THREE.MeshStandardMaterial {
  const c = (q(spec.color.r, 63) * 64 + q(spec.color.g, 63)) * 64 + q(spec.color.b, 63);
  const e = (q(spec.emissive.r, 31) * 32 + q(spec.emissive.g, 31)) * 32 + q(spec.emissive.b, 31);
  const i = Math.min(127, Math.round(spec.emissiveIntensity / 0.05));
  const key = ((((c * 32768 + e) * 128 + i) * 16 + q(spec.roughness, 15)) * 16 + q(spec.metalness, 15)) * 16
    + q(spec.opacity, 7) * 2 + (spec.depthWrite ? 1 : 0);
  let material = partMaterialPool.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      vertexColors: true, // baked AO — see bakeVertexAO
      color: spec.color,
      emissive: spec.emissive,
      emissiveIntensity: i * 0.05,
      roughness: q(spec.roughness, 15) / 15,
      metalness: q(spec.metalness, 15) / 15,
      transparent: spec.transparent,
      opacity: q(spec.opacity, 7) / 7,
      depthWrite: spec.depthWrite,
    });
    material.userData.shared = true; // pooled — disposeSubtree must never free it
    partMaterialPool.set(key, material);
  }
  return material;
}

/** Build-time entry point: the same pool, addressed by the hex colors the builders carry. */
function pooledPartMaterial(color: number, emissive: number, emissiveIntensity: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  _partSpec.color.copy(_poolColor.setHex(color));
  _partSpec.emissive.copy(_poolEmissive.setHex(emissive));
  _partSpec.emissiveIntensity = emissiveIntensity;
  _partSpec.roughness = roughness;
  _partSpec.metalness = metalness;
  _partSpec.transparent = false;
  _partSpec.opacity = 1;
  _partSpec.depthWrite = true;
  return partMaterial(_partSpec);
}

// Shadow budget. At tactical camera distance the sun shadow reads as the unit's SILHOUETTE, so
// only parts big enough to change that silhouette need to be in the shadow map or to sample it.
// Every bolt, buckle and sight used to do both: 1793 casters in the stress scenario, each one a
// second draw of the same geometry every frame.
const SHADOW_MIN_SIZE = 0.3;

function setShadowBudget(mesh: THREE.Mesh, size: number): void {
  const big = size >= SHADOW_MIN_SIZE;
  mesh.castShadow = big;
  mesh.receiveShadow = big;
}

const OUTLINE_MATERIALS = {
  solid: new THREE.LineBasicMaterial({ color: 0x050708, transparent: true, opacity: 0.38, depthWrite: true }),
  ghost: new THREE.LineBasicMaterial({ color: 0x050708, transparent: true, opacity: 0.16, depthWrite: false }),
};
OUTLINE_MATERIALS.solid.userData.shared = true;
OUTLINE_MATERIALS.ghost.userData.shared = true;

const edgeGeometries = new Map<string, THREE.BufferGeometry>();

function edgeGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = edgeGeometries.get(source.uuid);
  if (!geometry) {
    geometry = new THREE.EdgesGeometry(source, 35);
    geometry.userData.shared = true;
    edgeGeometries.set(source.uuid, geometry);
  }
  return geometry;
}

const cylinderGeometries = new Map<string, THREE.CylinderGeometry>();
const sphereGeometries = new Map<string, THREE.SphereGeometry>();

function cylinderGeometry(radiusTop: number, radiusBottom: number, depth: number): THREE.CylinderGeometry {
  const key = `${radiusTop.toFixed(3)}|${radiusBottom.toFixed(3)}|${depth.toFixed(3)}`;
  let geometry = cylinderGeometries.get(key);
  if (!geometry) {
    geometry = bakeVertexAO(new THREE.CylinderGeometry(radiusTop, radiusBottom, depth, 14)) as THREE.CylinderGeometry;
    geometry.userData.shared = true;
    cylinderGeometries.set(key, geometry);
  }
  return geometry;
}

function sphereGeometry(radius: number): THREE.SphereGeometry {
  const key = radius.toFixed(3);
  let geometry = sphereGeometries.get(key);
  if (!geometry) {
    geometry = bakeVertexAO(new THREE.SphereGeometry(radius, 14, 10)) as THREE.SphereGeometry;
    geometry.userData.shared = true;
    sphereGeometries.set(key, geometry);
  }
  return geometry;
}

/** Idle weapon carry: muzzle lifted and canted in across the chest, pivoting about the grip. */
const CARRY_PITCH = 0.34;
const CARRY_YAW = -0.26;
const CARRY_PIVOT_Y = 0.93;
const CARRY_PIVOT_Z = 0.12;

// Hex -> Color memo. THREE.Color.setHex re-runs the sRGB->linear conversion on every call, and
// paintPart asks for a handful of fixed tint/glow constants for every part mesh every frame — that
// conversion alone was 5% of the frame profile.
const hexColors = new Map<number, THREE.Color>();

function hexColor(hex: number): THREE.Color {
  let color = hexColors.get(hex);
  if (!color) {
    color = new THREE.Color(hex);
    hexColors.set(hex, color);
  }
  return color;
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
