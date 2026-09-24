import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ParticleShape, Particles } from "./particles";
import { hasMotionBank, sampleMotion } from "./infantryMotion";
import { ANKLE_Y, CROUCH_GAIT, GAIT_TIERS, HIP_Y, HIP_Z, KNEE_Y, bodyAt, footAt, gaitTier, solveLeg, type GaitParams, type LegPose } from "./gait";
import { splitAtKnee } from "./legSplit";
import { clamp, clamp01, dist, pointToSegmentDistance, segmentProgress, type Vec2 } from "../core/math";
import { isAirKind, isBuildingKind, isDefenseKind, isInfantryKind, isLandmarkKind, isVehicleKind, type CombatEntity, type CoverKind, type DamagePart, type Team, type EntityKind, type PartRole } from "../game/damageModel";
import { factionDef, type FactionId } from "../game/factions";
import type { OrderKind, Projectile, ShotPreview, TacticalSim, VisualEvent } from "../game/sim";
import { carpetDropPoints } from "../game/sim";
import { MAPS, type MapTheme, type AmbientKind, type AmbientSpec, type SkylineKind } from "../game/maps";
import type { TroopKind } from "../game/units";
import { ARENA_BOUNDS, TERRAIN_STEP, arenaDepth, arenaWidth, climbsAlong, onTerrainEdge, pointInWater, terrainBlocks, terrainBridges, terrainHeightAt, terrainWater } from "../game/terrain";
import { kitGeometry, modelsVersion, propGeometry, toonGradient, vehicleGeometry, vehiclesKitReady, type KitPart, type PropsKind, type VehiclesPart } from "./models";
import { VEHICLE_LAYOUT } from "./vehiclesLayout";
import {
  blastAfterlife, GROUND_CHEW_S, isSmallArms, makeBlast, makeBlastAfterlife, makeGroundChew, makeImpact,
  isLobbed, makeLightning, makeMuzzleFlash, makePing, makeProjectileModel, makeProjectileShadow, makeProjectileTrail,
  makeScorchStar, makeStrikeFlash, orientAlongVelocity, prewarmProjectileFx, projectileFamily,
  projectileFxWarmUpMaterials, projectileGeometry, projectileMaterial, pushTrailPoint, setFxViewer,
  carpetFallU, makeCarpetFall, makeGunRun, type LandingHint, type ProjectileFamily, type TrailPoint,
} from "./projectileFx";

// Cover kinds built by buildBiomeProp (the per-map furniture added 2026-09-23).
const BIOME_PROPS: ReadonlySet<CoverKind> = new Set<CoverKind>([
  "girder", "coil", "ingot", "haybale", "fence", "grave", "boat", "rack", "iceblock",
  "obelisk", "urn", "brazier", "hedgehog", "tower", "bones",
]);

// Part materials are toon (see partMaterial); PartMaterial names the shared shape both use.
type PartMaterial = THREE.MeshToonMaterial;
type PartMesh = THREE.Mesh<THREE.BufferGeometry, PartMaterial>;

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
  private readonly attackFamilyByActor = new Map<string, WeaponFamily>();
  /** Melee targets by actor, for the lunge; only set while a strike order is live. */
  private readonly meleeTargetByActor = new Map<string, Vec2>();
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
  private readonly ringInk: THREE.Mesh;
  private lastRingSig = "";
  private readonly targetRing: THREE.Mesh;
  private readonly actionRangeRing: THREE.Mesh;
  private readonly shootRangeRing: THREE.Mesh;
  private lastRangeSig = "";
  private resolving = false;
  private waterWaves: THREE.Texture | undefined;
  private lastPlacementSig = "";
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
  private rockTint = new THREE.Color(0x8a7a5c);
  /** True while the silhouette shape test is rendering (see setSilhouette). */
  private silhouetteMode = false;
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
  private readonly trailHistory = new Map<string, TrailPoint[]>();
  // What a round was doing when it ended, so an impact/blast can be drawn in its family's shape and
  // along its line of flight. Keyed by the projectile id; the effect's id carries the same suffix.
  private readonly landingHints = new Map<string, LandingHint>();
  private readonly lastSeenProjectile = new Map<string, { family: ProjectileFamily; dirX: number; dirZ: number; x: number; z: number; ground: number }>();
  // A small-arms round that ended with no sim effect kicked the dirt where it stopped: the renderer
  // draws the puff + pebble chips on its own clock (the sim has no event for a miss).
  private readonly groundChews: { x: number; z: number; at: number; seed: number; size: number }[] = [];
  // A blast's smoke column outlives the sim's effect, so it is drawn from a record of its own.
  private readonly blastEchoes = new Map<string, { effect: VisualEvent; at: number; life: number; hint?: LandingHint; ground: number }>();
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

    // SELECTION RING: a toon band of fixed proportion (14% of the unit's radius) with an ink rim
    // under it, draped and lifted clear of the ground plates. The old 0.9–1.86 donut scaled by the
    // unit's radius became a four-metre cyan puddle around a base, buried under the plates except
    // for a stray wedge — the "circle around the base blends into the map" report.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.14, 96, 1),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.98, side: THREE.DoubleSide, depthWrite: false })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.045;
    this.ringInk = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.2, 96, 1),
      new THREE.MeshBasicMaterial({ color: 0x0b0e12, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    this.ringInk.rotation.x = -Math.PI / 2;
    this.scene.add(this.ringInk, this.ring);

    this.selectionDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1.34, 64),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false })
    );
    this.selectionDisc.rotation.x = -Math.PI / 2;
    this.selectionDisc.position.y = 0.026;
    this.scene.add(this.selectionDisc);

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(1.08, 1.18, 56),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.88, side: THREE.DoubleSide })
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.position.y = 0.055;
    this.scene.add(this.targetRing);

    // The action range used to be a 4%-thick hairline ring: at tactical distance that reads as a
    // wireframe overlaid on the game, not as part of the board. It is a FIELD now — a soft tinted
    // area that brightens into a defined rim — which is how a tactics board shows reach. Same one
    // mesh, one draw call; the shape lives in a 256px gradient texture instead of in geometry.
    this.actionRangeRing = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2, 56, 56), // subdivided so drapeToTerrain can lay it over steps
      new THREE.MeshBasicMaterial({
        color: 0xffbf4d,
        map: rangeFieldTexture(),
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.actionRangeRing.rotation.x = -Math.PI / 2;
    this.actionRangeRing.position.y = 0.06;
    this.scene.add(this.actionRangeRing);
    // Weapon reach is a HAIRLINE, never a field: the move field is the only filled shape a
    // selected unit projects, so the two can never be mistaken for each other or stack into a blur.
    this.shootRangeRing = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1.0, 160, 1),
      new THREE.MeshBasicMaterial({ color: 0xffa24d, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
    );
    this.shootRangeRing.rotation.x = -Math.PI / 2;
    this.shootRangeRing.visible = false;
    this.scene.add(this.shootRangeRing);

    this.placementRing = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1.0, 160, 1),
      new THREE.MeshBasicMaterial({ color: 0x8ef2d1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
    );
    this.placementRing.rotation.x = -Math.PI / 2;
    this.placementRing.visible = false;
    this.scene.add(this.placementRing);

    this.placementDisc = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2, 48, 48), // subdivided so drapeToTerrain can lay it over steps
      new THREE.MeshBasicMaterial({ color: 0x8ef2d1, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, map: discMaskTexture() })
    );
    this.placementDisc.rotation.x = -Math.PI / 2;
    this.placementDisc.visible = false;
    this.scene.add(this.placementDisc);
  }

  private prewarmActionAssets(): void {
    prewarmProjectileFx();
    for (const radius of [0.026, 0.035, 0.04, 0.052, 0.07, 0.085, 0.11, 0.13]) tubeGeometry(radius);
    for (const radius of [0.5]) projectileShadowGeometry(radius);
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
    FACTION_OF_TEAM.player = sim.factionIdOf("player");
    FACTION_OF_TEAM.enemy = sim.factionIdOf("enemy");
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
    _crouchMovers.clear();
    for (const order of sim.orders) if (order.startedCrouched) _crouchMovers.add(order.actorId);
    const crouchMovers = _crouchMovers;
    for (const entity of sim.entities) {
      // A unit carried by an air transport is aboard/hidden — don't draw it (nor make it clickable).
      if (entity.carriedById) {
        const group = this.groups.get(entity.id);
        if (group) group.visible = false;
        continue;
      }
      const existing = this.groups.get(entity.id);
      if (existing && !existing.visible) existing.visible = true; // reappears when dropped off
      this.resolving = sim.phase === "resolve";
      this.syncEntity(entity, sim.selectedId, targetId, targetPartId, sim.defending.has(entity.id), this.ghostedEntityIds.has(entity.id), crouchMovers.has(entity.id));
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
      ? `${sim.sidesSwapped ? "p2" : "p1"}|${sim.selectedId}|${targetId ?? ""}|${targetPartId ?? ""}|${sim.intent}|${sim.orders.map((o) => `${o.kind}:${o.actorId}:${o.targetId ?? ""}:${o.destination ? `${o.destination.x.toFixed(1)},${o.destination.z.toFixed(1)}` : ""}`).join(",")}|${groundAim ? `${groundAim.x.toFixed(1)},${groundAim.z.toFixed(1)}` : ""}|t${sim.placementTurn}`
      : `~resolve${sim.projectiles.length}`;
    if (sim.phase !== "command" || overlaySig !== this.lastOverlaySig) {
      this.lastOverlaySig = overlaySig;
      this.syncOrders(sim);
      this.syncShotPreview(sim, targetId, targetPartId);
      this.syncGroundAim(sim, groundAim);
    }
    resetFxLinePool(); // recycle the projectile/effect trail lines instead of reallocating them
    // Flat cut-outs (the impact star, the POW burst) turn to face the camera; the FX module needs
    // to know where it is, and it changes once a frame.
    if (camera) setFxViewer(camera.position);
    this.syncProjectiles(sim.projectiles);
    this.syncCarpetFalls(sim);
    this.syncEffects(sim.effects);
    this.syncFlashLights();
    this.syncDamageNumbers(sim);
    this.syncEnvironment(sim);
    this.syncAmbient();
    this.syncWater();
    this.syncClouds();
    if (this.silhouetteMode) this.setSilhouette(true);
    this.syncObjectives(sim);
  }

  // Dynamic map events: ease the sandstorm haze (fog + sky tint) and draw pulsing danger rings
  // over barrage/collapse zones so the player can read — and clear — the threatened ground.
  private syncEnvironment(sim: TacticalSim): void {
    this.disposeAndClear(this.environmentRoot);
    const env = sim.environment();
    this.sandstormBlend += (env.sandstorm - this.sandstormBlend) * 0.06;
    const fog = this.scene.fog as THREE.FogExp2 | null;
    // The silhouette shape test owns the sky and the fog while it runs; the weather sync would
    // repaint its white field with the map's sky colour on the very next frame.
    if (this.silhouetteMode) return;
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
      const y = drawnGroundAt(burn) + 0.07;
      const ring = new THREE.Mesh(
        drapedDisc(burn.x, burn.z, burn.radius - 0.25, burn.radius, 40, 0.07),
        new THREE.MeshBasicMaterial({ color: 0xff6b1a, transparent: true, opacity: 0.35 + flicker * 0.3, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      this.environmentRoot.add(ring);
      const glow = new THREE.Mesh(
        drapedDisc(burn.x, burn.z, 0, burn.radius * 0.9, 24, 0.05),
        new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.12 + flicker * 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
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
    // GAS CLOUDS: a drifting, breathing dome of pale green with a low skirt, so its reach reads
    // on the ground and its volume reads against the units inside it. Sickly, never pretty.
    for (const cloud of sim.gasClouds) {
      const y = drawnGroundAt(cloud) + 0.05;
      const skirt = new THREE.Mesh(
        drapedDisc(cloud.x, cloud.z, 0, cloud.radius, 40, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x9bd44a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.environmentRoot.add(skirt);
      const rim = new THREE.Mesh(
        drapedDisc(cloud.x, cloud.z, cloud.radius - 0.14, cloud.radius, 48, 0.06),
        new THREE.MeshBasicMaterial({ color: 0xc8f06a, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.environmentRoot.add(rim);
      for (let b = 0; b < 7; b += 1) {
        const t = performance.now() * 0.00035 + b * 2.1 + (hash(cloud.id) % 11);
        const r = cloud.radius * (0.15 + ((b * 37) % 60) / 100);
        const blob = new THREE.Mesh(
          new THREE.SphereGeometry(cloud.radius * (0.3 + (b % 3) * 0.08), 10, 7),
          new THREE.MeshBasicMaterial({ color: b % 2 ? 0xa8dc55 : 0x86b83a, transparent: true, opacity: 0.13, depthWrite: false }),
        );
        blob.position.set(cloud.x + Math.cos(t) * r, y + 0.45 + Math.sin(t * 1.7) * 0.2, cloud.z + Math.sin(t * 0.8) * r);
        blob.scale.y = 0.55;
        this.environmentRoot.add(blob);
      }
    }
    // SMOKE: a mortar smoke round. Grey, dense, harmless — it reads as a wall you cannot shoot
    // through, so the blobs are opaque-ish and stacked high rather than a low sickly skirt.
    for (const cloud of sim.smokeClouds) {
      const y = drawnGroundAt(cloud) + 0.05;
      const fade = Math.min(1, cloud.turnsLeft / 2);
      const skirt = new THREE.Mesh(
        drapedDisc(cloud.x, cloud.z, 0, cloud.radius, 40, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x6f757a, transparent: true, opacity: 0.22 * fade, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.environmentRoot.add(skirt);
      for (let b = 0; b < 10; b += 1) {
        const t = performance.now() * 0.00025 + b * 1.9 + (hash(cloud.id) % 13);
        const r = cloud.radius * (0.1 + ((b * 41) % 65) / 100);
        const blob = new THREE.Mesh(
          new THREE.SphereGeometry(cloud.radius * (0.34 + (b % 3) * 0.1), 10, 7),
          new THREE.MeshBasicMaterial({ color: b % 2 ? 0xa3a9ae : 0x767d83, transparent: true, opacity: 0.36 * fade, depthWrite: false }),
        );
        blob.position.set(cloud.x + Math.cos(t) * r, y + 0.6 + (b % 4) * 0.35 + Math.sin(t * 1.5) * 0.15, cloud.z + Math.sin(t * 0.9) * r);
        blob.scale.y = 0.8;
        this.environmentRoot.add(blob);
      }
    }
    // DOWNED troopers: a medic-red pulse on the ground under the body — "reach me".
    const downPulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    for (const entity of sim.entities) {
      if (!entity.downed || !entity.status.alive) continue;
      const disc = new THREE.Mesh(
        drapedDisc(entity.position.x, entity.position.z, 0.55, 0.7, 32, 0.06),
        new THREE.MeshBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0.45 + downPulse * 0.35, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.environmentRoot.add(disc);
    }
    // Friendly mines only — the enemy never sees yours until they step on one.
    const minePulse = Math.sin(performance.now() * 0.009) > 0.2;
    for (const mine of sim.mines) {
      if (mine.team !== "player") continue;
      const y = drawnGroundAt(mine) + 0.05;
      const disc = new THREE.Mesh(
        drapedDisc(mine.x, mine.z, 0, 0.26, 16, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x39434a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
      );
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
      const y = drawnGroundAt(cache) + 0.05;
      const ring = new THREE.Mesh(
        drapedDisc(cache.x, cache.z, 0.5, 0.74, 32, 0.05),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.26 + cachePulse * 0.24, side: THREE.DoubleSide, depthWrite: false }),
      );
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
        drapedDisc(cache.x, cache.z, 0, 0.74, 16, 0.08),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      hit.userData.pickupId = cache.id;
      this.environmentRoot.add(hit);
      this.pickables.push(hit, coin);
    }
    const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    for (const zone of env.zones) {
      const color = zone.kind === "barrage" ? 0xff5a3c : zone.kind === "lightning" ? 0xbfe4ff : 0xffb24a;
      const ring = new THREE.Mesh(
        drapedDisc(zone.x, zone.z, zone.radius - 0.4, zone.radius, 72, 0.07),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 + pulse * 0.42, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.environmentRoot.add(ring);
      const disc = new THREE.Mesh(
        drapedDisc(zone.x, zone.z, 0, zone.radius, 56, 0.06),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06 + pulse * 0.05, side: THREE.DoubleSide, depthWrite: false }),
      );
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
  /** Flinch every living non-cover body within `radius` of `point`, away from `from` (or from the
   *  point itself). Only ever raises an existing flinch, never dampens one. */
  private shoveNear(sim: TacticalSim, point: Vec2, radius: number, power: number, from?: Vec2): void {
    const now = performance.now();
    for (const entity of sim.entities) {
      if (!entity.status.alive || entity.kind === "cover" || entity.flying || entity.carriedById) continue;
      const d = dist(entity.position, point);
      if (d > radius + entity.radius) continue;
      const origin = from ?? point;
      let dx = entity.position.x - origin.x;
      let dz = entity.position.z - origin.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) { dx = -Math.sin(entity.yaw); dz = -Math.cos(entity.yaw); } else { dx /= len; dz /= len; }
      const mag = Math.min(1.4, power * (from ? 1 : clamp(1.15 - d / (radius + entity.radius), 0.35, 1)));
      const prev = this.flinchByEntity.get(entity.id);
      if (prev && now - prev.at < FLINCH_MS && prev.mag >= mag) continue;
      this.flinchByEntity.set(entity.id, { at: now, mag, dx, dz });
    }
  }

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
  /**
   * One mesh per RESOLVE-ONLY material family, for stage.warmUp(). The warm-up compiles whatever
   * is in the scene, and these only exist while something is exploding, toppling or dying, so the
   * first resolve of a session paid a 70-300ms shader compile in the middle of the action
   * (measured on the real GPU by soak:gpu, which diffs the program list across a resolve).
   */
  /** Test seam: how many order overlays are drawn right now (smoke:hotseat). */
  overlayCounts(): { orders: number } {
    return { orders: this.orderRoot.children.length };
  }

  warmUpSamplers(): THREE.Object3D[] {
    // A program key is material x GEOMETRY attributes, so every material is sampled on three
    // geometries: RGB vertex colour + uv (the procedural parts), RGBA vertex colour + uv (every
    // Blender kit exports COLOR_0 as VEC4 -> three's `vertexAlphas` variant), and RGB with no uv.
    // soak:gpu caught the RGBA transparent twin (a fading kit part) compiling mid-resolve.
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const n = geo.getAttribute("position").count;
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    const geo4 = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    geo4.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
    const geoNoUv = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    geoNoUv.deleteAttribute("uv");
    geoNoUv.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    const geos = [geo, geo4, geoNoUv];
    const out: THREE.Object3D[] = [];
    // Every opaque standard material in the scene gets a TRANSPARENT twin compiled now. Units and
    // props fade out when they die, and that fade is the only thing that flips a material's
    // `opaque` program bit — measured by soak:gpu as the two programs that compiled mid-resolve
    // (a GLB hull with map + normal map, and a pooled vertex-coloured part). Cloning the live
    // materials guarantees the exact key; guessing the parameter list by hand did not.
    const seen = new Set<string>();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!(m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshToonMaterial)) continue;
        const key = `${m.uuid.slice(0, 8)}|${mesh.receiveShadow}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // SYMMETRIC: the twin is the opposite of the live state. A material that is transparent at
        // warm-up (a fading part) is drawn opaque again later, and soak:gpu caught that opaque
        // variant (program-key bit 17) compiling mid-resolve when only opaque->transparent was covered.
        const twin = m.clone();
        twin.transparent = !m.transparent;
        twin.opacity = twin.transparent ? 0.5 : 1;
        for (const g of geos) {
          const sampler = new THREE.Mesh(g, twin);
          sampler.receiveShadow = mesh.receiveShadow;
          sampler.castShadow = mesh.castShadow;
          out.push(sampler);
        }
      }
    });
    for (const m of [
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false }),
      new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.92 }),
      new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.92, transparent: true, opacity: 0.5 }),
      // Projectile FX: opaque flat bodies and their BackSide inverted-hull rims are their own programs.
      ...projectileFxWarmUpMaterials(),
      // The vehicles kit's inverted-hull ink rim.
      inkMaterial(),
    ]) for (const g of geos) out.push(new THREE.Mesh(g, m));
    return out;
  }

  /** What the projectile and effect roots are drawing THIS frame (the smoke:attacks seam): object
   *  counts, and how many effect objects hang well above the ground (a gun run's tracers). */
  fxCounts(): { projectiles: number; effects: number; airborneEffects: number } {
    let airborneEffects = 0;
    for (const child of this.effectRoot.children) if (child.position.y > 2.5) airborneEffects += 1;
    return { projectiles: this.projectileRoot.children.length, effects: this.effectRoot.children.length, airborneEffects };
  }

  limbPose(entityId: string): { limb: string; rotX: number; rotY: number; posY: number; posZ: number }[] {
    const group = this.groups.get(entityId);
    if (!group) return [];
    const out: { limb: string; rotX: number; rotY: number; posY: number; posZ: number }[] = [];
    // The actor group itself, so a smoke can see the whole-body idle (weight shift, scan turn).
    out.push({ limb: "body", rotX: group.rotation.x, rotY: group.rotation.y, posY: group.position.y, posZ: group.position.z });
    group.traverse((node) => {
      const limb = node.userData?.limb as string | undefined;
      // Weapons are not limbs (they do not swing from a joint) but they ARE animated, by the attack
      // choreography, and a stopped attack pose is just as invisible in a still as a stopped walk.
      const partId = node.userData?.partId as string | undefined;
      // Leg segments: the thigh keeps the bare limb tag (it is the hip-driven piece the older
      // assertions read); the shin and boot are suffixed.
      const segment = node.userData?.segment as string | undefined;
      const tagged = limb && segment && segment !== "thigh" ? `${limb}:${segment}` : limb;
      const label = tagged ?? (partId === "rifle" || partId === "cannon" || partId === "gun" ? "weapon" : partId === "head" ? "head" : undefined);
      if (!label) return;
      out.push({ limb: label, rotX: node.rotation.x, rotY: node.rotation.y, posY: node.position.y, posZ: node.position.z });
    });
    return out;
  }

  /**
   * FOOT-SKATE GATE SUPPORT. While tracked, every rendered frame records the world position of
   * each boot mesh alongside the body's, so a smoke can measure the planted foot's ground
   * velocity directly (a planted foot that moves is skating, whatever the pose looks like).
   * Sampling from outside the frame loop cannot do this: a headless step can be a third of a
   * cycle, and the foot that was planted is a different one by the next sample.
   */
  private readonly trackedFeet = new Map<string, FootFrame[]>();

  trackFeet(entityId: string, on: boolean): void {
    if (on) this.trackedFeet.set(entityId, []);
    else this.trackedFeet.delete(entityId);
  }

  footTrack(entityId: string): FootFrame[] {
    return this.trackedFeet.get(entityId) ?? [];
  }

  private recordFeet(entity: CombatEntity, group: THREE.Group): void {
    const track = this.trackedFeet.get(entity.id);
    if (!track || track.length > 4000) return;
    const feet: { side: string; x: number; y: number; z: number }[] = [];
    group.updateWorldMatrix(true, true);
    group.traverse((node) => {
      if (node.userData?.segment !== "foot") return;
      const w = node.getWorldPosition(_footWorld);
      feet.push({ side: node.userData.limb as string, x: w.x, y: w.y, z: w.z });
    });
    track.push({ t: performance.now(), x: entity.position.x, z: entity.position.z, ground: (group.userData.renderElevation as number | undefined) ?? 0, feet });
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
      if (!mesh.isMesh || !(mesh.material instanceof THREE.MeshStandardMaterial || mesh.material instanceof THREE.MeshToonMaterial)) return;
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
        const ring = new THREE.Mesh(
          drapedDisc(sector.x, sector.z, radius - 0.24, radius, 56, 0.06),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
        );
        this.objectiveRoot.add(ring);
        const disc = new THREE.Mesh(
          drapedDisc(sector.x, sector.z, 0, radius, 40, 0.04),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }),
        );
        this.objectiveRoot.add(disc);
      });
      return;
    }
    if (sim.mode === "hill") {
      const color = s.hillHolder === "player" ? 0x6fd7ff : s.hillHolder === "enemy" ? 0xff7c5e : 0xffe08a;
      const ring = new THREE.Mesh(
        drapedDisc(s.hill.x, s.hill.z, s.hillRadius - 0.28, s.hillRadius, 64, 0.06),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.objectiveRoot.add(ring);
      const disc = new THREE.Mesh(
        drapedDisc(s.hill.x, s.hill.z, 0, s.hillRadius, 48, 0.04),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
      );
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
        pole.position.set(flag.pos.x, drawnGroundAt(flag.pos), flag.pos.z);
        this.objectiveRoot.add(pole);
        const homeRing = new THREE.Mesh(
          drapedDisc(flag.home.x, flag.home.z, 1.0, 1.2, 32, 0.05),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
        );
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
  /**
   * Black-silhouette mode: hide everything that is not a UNIT, so the entity shapes stand alone
   * against a white field. The shape test is only meaningful with the terrain out of the way --
   * with the ground left in, the override material paints the whole frame black.
   */
  setSilhouette(on: boolean): void {
    for (const root of [this.sceneryRoot, this.markerRoot, this.orderRoot, this.previewRoot,
      this.objectiveRoot, this.groundAimRoot, this.auraRoot, this.environmentRoot, this.craterRoot,
      this.debrisRoot, this.damageNumberRoot]) {
      root.visible = !on;
    }
    if (this.ambientPoints) this.ambientPoints.visible = !on;
    this.silhouetteMode = on;
  }

  setHighContrastTeams(on: boolean): void {
    Object.assign(TEAMS, on ? TEAMS_HIGH_CONTRAST : TEAMS_DEFAULT);
    TEAMS.version += 1;
  }

  // Re-theme the whole scene for a map: fog, sky, ground, terrain, grid, and lights.
  applyMap(theme: MapTheme, keepClear: Vec2[] = []): void {
    plateKeepClear.splice(0, plateKeepClear.length, ...keepClear);
    clearDrapedDiscs();
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
    // Natural stone is OF the map: it takes the ground's own hue at a slightly lower value, so a
    // rock on the ice is grey-blue and a rock in the dust bowl is ochre, from one greyscaled hull.
    this.rockTint = new THREE.Color(theme.ground).lerp(new THREE.Color(theme.groundAccent), 0.3).multiplyScalar(1.15);
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
    // A soft round mote with a CLAMPED screen size that fades out near the lens. A bare
    // PointsMaterial draws every point as its full square quad and grows without limit toward the
    // camera -- that was a 35px solid white square lying over the ice on Frozen Causeway.
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(spec.color) },
        uOpacity: { value: m.opacity },
        uSize: { value: m.size * window.innerHeight * 0.5 * Math.min(2, window.devicePixelRatio || 1) },
      },
      vertexShader: `uniform float uSize; varying float vFade;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(7.0, uSize / -mv.z);
          vFade = smoothstep(3.0, 7.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vFade;
        void main() {
          float a = smoothstep(1.0, 0.25, length(gl_PointCoord - 0.5) * 2.0) * uOpacity * vFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.ambientPoints = new THREE.Points(geometry, material);
    this.ambientPoints.frustumCulled = false;
    this.ambientVel = vel;
    this.scene.add(this.ambientPoints);
  }

  // Scroll the water's ripple normal. Two axes at different rates so the pattern never reads as a
  // texture sliding in one direction, and slow enough that a still frame looks still.
  /** Drift the cloud deck. Very slow — a shadow should take the better part of a minute to cross. */
  private syncClouds(): void {
    const now = performance.now();
    const t = now * 0.0000075;
    cloudUniforms.uCloudOffset.value.set(t, t * 0.55);
    windUniforms.uTime.value = now * 0.001;
  }

  private syncWater(): void {
    const ripple = this.waterRipple;
    if (!ripple) return;
    const t = performance.now() * 0.00004;
    ripple.offset.set(t, t * 0.62);
    if (this.waterWaves) this.waterWaves.offset.set(-t * 0.5, t * 0.3);
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
        normalScale: new THREE.Vector2(0.36, 0.36),
        color: new THREE.Color(theme.ground),
        roughness: 0.95,
        metalness: 0.02,
      })
    );
    applyCloudShadows(floor.material as THREE.MeshStandardMaterial, surface.normalMap);
    floor.position.y = -0.11;
    floor.receiveShadow = true;
    this.sceneryRoot.add(floor);

    this.sceneryRoot.add(makeGroundPlates(theme, width, depth, surface));
    this.sceneryRoot.add(makeGroundDetail(theme, width, depth));
    this.sceneryRoot.add(makeTerrainBlocks(theme.ground, theme.groundAccent, surface));
    const water = makeWaterAndBridges(theme, surface);
    this.waterRipple = (water.userData.ripple as THREE.Texture | undefined) ?? undefined;
    this.waterWaves = (water.userData.waves as THREE.Texture | undefined) ?? undefined;
    this.sceneryRoot.add(water);
    this.sceneryRoot.add(makeSurroundings(theme, width, depth));

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
      // SNIPER MARK: a spinning red diamond over the marked unit until it wears off.
      const marked = entity.markedUntilTurn !== undefined && entity.markedUntilTurn >= sim.turn;
      let bracket = marker.userData.bracket as THREE.Mesh | undefined;
      if (marked && !bracket) {
        bracket = new THREE.Mesh(
          new THREE.RingGeometry(0.62, 0.74, 4),
          new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
        );
        bracket.rotation.x = -Math.PI / 2;
        bracket.position.y = 0.02;
        marker.userData.bracket = bracket;
        marker.add(bracket);
      }
      if (bracket) {
        bracket.visible = marked;
        bracket.rotation.z = performance.now() * 0.0015;
        (bracket.material as THREE.MeshBasicMaterial).opacity = 0.6 + pulse * 0.4;
      }
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
    this.attackFamilyByActor.clear();
    this.meleeTargetByActor.clear();
    if (sim.phase !== "resolve") return;
    for (const order of sim.orders) {
      if (order.done) continue;
      const actor = sim.entity(order.actorId);
      const family = actor && attackFamilyForOrder(actor.kind, order.kind);
      if (!family) continue;
      const duration = order.duration > 0 ? order.duration : 1;
      const phase = Math.max(0, Math.min(1, order.elapsed / duration));
      this.attackPhaseByActor.set(order.actorId, phase);
      this.attackFamilyByActor.set(order.actorId, family);
      if (order.kind === "melee" && order.targetId) {
        const target = sim.entity(order.targetId);
        if (target) this.meleeTargetByActor.set(order.actorId, target.position);
      }
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

  private syncEntity(entity: CombatEntity, selectedId: string, targetId: string | undefined, targetPartId: string | undefined, defending: boolean, ghosted: boolean, crouchMoving: boolean): void {
    let group = this.groups.get(entity.id);
    // Captured structures change team: rebuild so team-colored trim/glow follows the flag -- and a
    // faction change (new battle, a hotseat swap) rebuilds too, because the faction DRESS is geometry.
    const teamKey = `${entity.team}:${factionOfEntity(entity) ?? ""}`;
    if (group && group.userData.team !== teamKey) {
      disposeSubtree(group);
      this.entityRoot.remove(group);
      this.groups.delete(entity.id);
      group = undefined;
    }
    if (!group) {
      group = this.buildEntity(entity);
      group.userData.team = teamKey;
      group.userData.entitySnapshot = entity; // live reference, read by auditTerrainClip
      this.groups.set(entity.id, group);
      this.entityRoot.add(group);
    }
    group.userData.ghosted = ghosted;
    const digRing = group.userData.digInRing as THREE.Group | undefined;
    if (digRing) digRing.visible = Boolean(entity.dugIn) && entity.status.alive && !entity.carriedById;
    // DEATH. A unit used to vanish on the frame it died. Now it stays for deathMs() and plays its
    // family's death (poseDeath: thrown / crumple / spin / wreck / spiral) before sinking.
    if (!entity.status.alive && group.userData.diedAt === undefined && entity.kind !== "cover") {
      group.userData.diedAt = performance.now();
      const last = this.flinchByEntity.get(entity.id);
      group.userData.deathDir = last ? { dx: last.dx, dz: last.dz } : { dx: Math.sin(entity.yaw), dz: Math.cos(entity.yaw) };
      group.userData.deathStyle = deathStyle(entity, last?.mag ?? 0);
      group.userData.deathBeats = 0;
      this.deathBurst(entity, group, "start");
    }
    if (entity.status.alive) group.userData.diedAt = undefined;
    const dying = !entity.status.alive && group.userData.diedAt !== undefined && performance.now() - (group.userData.diedAt as number) < deathMs(entity);
    group.visible = entity.status.alive || dying;
    const previousPosition = group.userData.previousPosition as Vec2 | undefined;
    const moved = previousPosition ? dist(previousPosition, entity.position) : 0;
    const moving = entity.kind !== "cover" && moved > 0.001 && !(entity.flying && isInfantryKind(entity.kind));
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
    const meleeTarget = this.meleeTargetByActor.get(entity.id);
    group.userData.weaponFamily = this.attackFamilyByActor.get(entity.id) ?? weaponFamily(entity.kind);
    group.userData.meleeTarget = meleeTarget;
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
    // INFANTRY LOCOMOTION (gait.ts). The gait phase advances by metres moved over the tier's
    // stride -- never by time -- so a planted boot has zero ground velocity by construction. The
    // start phase is seeded from the id so a squad does not step in lockstep, and from then on
    // every trooper obeys the same distance rule. The hip curve lowers the whole group (`bob`);
    // paintPart poses the legs by IK against that, and the torso counters the pelvis twist.
    let bob = 0;
    if (isInfantryKind(entity.kind)) {
      // The sim stands a crouched unit up the moment it moves (its order remembers it started
      // crouched and slows it); the renderer keeps it low the whole way, on short steps.
      const crouched = entity.stance === "crouched" || crouchMoving;
      group.userData.crouched = crouched;
      const gait = crouched ? CROUCH_GAIT : GAIT_TIERS[gaitTier(entity.kind)];
      const phase = ((group.userData.gaitPhase as number | undefined) ?? (hash(entity.id) % 97) / 97) + (moving ? moved / gait.stride : 0);
      const body = bodyAt(gait, phase);
      group.userData.gaitPhase = phase;
      group.userData.gait = gait;
      // A crouch already lowers the hip by CROUCH_DROP on every part; only the residual bobs the group.
      bob = (body.bob - (crouched ? CROUCH_DROP : 0)) * walkWeight;
      group.userData.gaitBob = bob;
      group.userData.gaitLean = body.lean * walkWeight;
      group.userData.gaitSway = body.sway * walkWeight;
      group.userData.gaitTwist = body.pelvisYaw * walkWeight;
    }
    // Ease the rendered ground height so stepping on/off cover or terrain ledges glides
    // instead of snapping.
    // FEET ON THE GROUND. The sim's elevation is the terrain height under the unit's CENTRE, so a
    // walker approaching a step sank into the block face until its centre crossed the edge, and a
    // unit on a ground plate stood up to 6cm inside it. The rendered height is the highest walkable
    // ground under the FOOTPRINT (never a cliff face — that would hoist a unit standing at its foot)
    // plus the plate it stands on, eased quickly on the way up and gently on the way down.
    let targetElevation = entity.elevation;
    if (!entity.flying && entity.kind !== "cover" && !isBuildingKind(entity.kind) && entity.status.alive) {
      const centreGround = terrainHeightAt(entity.position);
      const r = entity.radius * 0.7;
      let footprint = visualGroundAt(entity.position);
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
        footprint = Math.max(footprint, visualGroundAt({ x: entity.position.x + dx, z: entity.position.z + dz }));
      }
      // Never more than one walkable step above the sim's ground: a unit at a cliff's foot stands
      // on the talus, not halfway up the face.
      const stepUp = Math.min(TERRAIN_STEP, footprint - centreGround);
      if (stepUp > 0) targetElevation += stepUp;
      if (Math.abs(entity.elevation - centreGround) < 0.01) targetElevation += plateLiftAt(entity.position, centreGround);
    } else if (entity.kind === "cover") {
      // Props stand on the DRAWN ground too: a crate on a talus tier or a ground plate sat at the
      // sim height and was cut off flat by the hillside. Static, so measured once per position.
      const key = `${entity.position.x},${entity.position.z}`;
      if (group.userData.liftKey !== key) {
        group.userData.liftKey = key;
        group.userData.groundLift = Math.max(0, Math.min(TERRAIN_STEP, drawnGroundAt(entity.position) - terrainHeightAt(entity.position)));
      }
      targetElevation += group.userData.groundLift as number;
    }
    const prevElevation = group.userData.renderElevation as number | undefined;
    const ease = prevElevation !== undefined && targetElevation > prevElevation ? 0.45 : 0.2;
    const renderElevation = prevElevation === undefined ? targetElevation : prevElevation + (targetElevation - prevElevation) * ease;
    group.userData.renderElevation = renderElevation;
    group.position.set(entity.position.x, renderElevation - bob, entity.position.z);
    // THROWN, NOT TELEPORTED (owner 2026-09-24: "explosions blowing characters back with a fun
    // animation"). A blast or a push moves a body in the sim in one step; here a sudden jump of a
    // living ground unit becomes a FLIGHT from where it was to where it landed -- infantry arc high
    // and tumble backwards (a full flip on a long throw), vehicles only hop and rock -- with a dust
    // puff on landing. Renderer-only: the sim position is already final.
    this.flyThrownBody(entity, group, renderElevation - bob);
    // PER-INSTANCE VARIETY on scenery. Every rock, tree and crate was the same mesh at the same
    // size on the same bearing, so a map read as stamped rather than grown — the single most
    // obvious "placeholder" tell left on the board once the shapes themselves were fixed. Cover
    // gets a deterministic yaw and a modest scale jitter from its own id.
    //
    // Yaw is FREE: collision here is a circle of entity.radius, so turning a prop cannot change
    // what it blocks. Scale is deliberately kept to +/-11% and applied to the visual group only, so
    // the mesh never drifts far enough from its collision radius for a unit to look like it stopped
    // early or walked into thin air.
    // A landmark is PLACED: authored yaw, true size. Only the small scatter props get the free spin
    // and the +/-11% jitter that keeps a wood from looking stamped.
    const scenery = entity.kind === "cover" && !isLandmarkKind(entity.coverKind);
    const variety = scenery ? hash(entity.id) : 0;
    // Trees sway from the root: a slow gust plus a faster flutter, phased by id so a wood never
    // nods in unison. Same wind the ground blades bend to.
    const tree = entity.coverKind === "tree" && entity.status.alive;
    const swayT = performance.now() * 0.001 + (variety % 97) * 0.13;
    const sway = tree ? (Math.sin(swayT * 0.7) * 0.6 + Math.sin(swayT * 2.1) * 0.4) * 0.028 : 0;
    // Emplacements TRAVERSE to their target instead of snapping: the sim sets yaw the instant an
    // order starts, and the wind-up before the shot is long enough for a 4 rad/s turn to arrive.
    let shownYaw = entity.yaw;
    if (entity.kind === "turret" || entity.kind === "exturret") {
      const prev = group.userData.shownYaw as number | undefined;
      if (prev === undefined) shownYaw = entity.yaw;
      else {
        const delta = Math.atan2(Math.sin(entity.yaw - prev), Math.cos(entity.yaw - prev));
        const maxStep = 4 * (1 / 60);
        shownYaw = prev + Math.max(-maxStep, Math.min(maxStep, delta));
      }
      group.userData.shownYaw = shownYaw;
    }
    const flip = (group.userData.flightPitch as number | undefined) ?? 0;
    const tilt = (group.userData.flightRoll as number | undefined) ?? 0;
    group.rotation.set(
      sway * 0.45 + flip,
      shownYaw + (scenery ? ((variety % 360) / 360) * Math.PI * 2 : 0),
      (entity.kind === "tank" ? Math.sin(motionTime * 4.8) * 0.018 * walkWeight : 0) + sway + ((group.userData.gaitSway as number | undefined) ?? 0) + tilt
    );
    if (defending && isInfantryKind(entity.kind) && entity.status.alive) {
      group.scale.set(1.08, 1, 1.08);
    } else if (scenery) {
      const jitter = 0.89 + ((variety >> 9) % 23) / 100;
      group.scale.set(jitter, 0.92 + ((variety >> 14) % 19) / 100, jitter);
    } else {
      group.scale.setScalar(entity.status.alive ? 1 : 0.94);
    }
    // Flyers hover: a gentle idle bob + pitch so an airborne unit never sits dead-still in the sky.
    if (entity.flying && entity.status.alive) {
      const t = performance.now() * 0.0018 + (hash(entity.id) % 63);
      group.position.y += Math.sin(t) * 0.18;
      group.rotation.x += Math.sin(t * 0.8) * 0.03;
    }
    // WHOLE-BODY IDLE, readable at tactical zoom. The per-part breathing in paintPart is real but
    // a centimetre of chest rise vanishes at this camera. What the eye catches from up here is the
    // silhouette moving: a standing trooper shifts weight side to side and turns a little as they
    // scan; a parked vehicle sits on a running engine (a fast, tiny tremor) and settles on its
    // suspension. Everything is phased by id so a squad never moves in lockstep, and weighted by
    // (1 - walkWeight) so it hands over cleanly to the walk cycle.
    if (entity.status.alive && !entity.flying && entity.kind !== "cover" && !isBuildingKind(entity.kind)) {
      const idle = 1 - walkWeight;
      const phase = (hash(entity.id) % 89) * 0.37;
      const t = performance.now() * 0.001 + phase;
      if (isInfantryKind(entity.kind) && entity.stance !== "prone") {
        const shift = Math.sin(t * 0.55) * 0.045 * idle;
        group.position.x += Math.cos(entity.yaw) * shift;
        group.position.z -= Math.sin(entity.yaw) * shift;
        group.rotation.z += shift * 0.9;
        group.rotation.y += (Math.sin(t * 0.31) * 0.11 + Math.sin(t * 0.83) * 0.03) * idle;
      } else if (isVehicleKind(entity.kind)) {
        // Hull down: the tank sits lower on its suspension and the engine tremor dies away.
        if (entity.kind === "tank" && entity.hullDown) { group.position.y -= 0.09; group.rotation.x += 0.02; }
        // Deployed artillery: settled onto its outriggers — lower, still, and nosed up a touch.
        else if (entity.kind === "artillery" && entity.deployed) { group.position.y -= 0.07; group.rotation.x -= 0.03; }
        if (entity.kind === "artillery") {
          const legs = group.children.find((c) => c.userData.outriggers) as THREE.Group | undefined;
          if (legs) legs.scale.setScalar(entity.deployed ? 1 : 0.001);
        }
        else group.position.y += Math.sin(t * 52) * 0.004 * idle;
        group.rotation.x += Math.sin(t * 0.7) * 0.006 * idle + Math.sin(t * 47) * 0.0025 * idle;
        group.rotation.z += Math.sin(t * 0.45) * 0.005 * idle;
      } else if (entity.kind === "turret" || entity.kind === "exturret") {
        // Emplacements: a slow traverse hunt while PLANNING, like a gun looking for work. During
        // the resolve the barrel must point exactly where the round goes — the hunt (up to 7°)
        // made a turret fire visibly off its own muzzle. (Walls stay put.)
        if (!this.resolving) group.rotation.y += Math.sin(t * 0.25) * 0.12;
      }
    }
    // Damage you can see from the camera: a legless trooper is down on one knee, a vehicle with a
    // dead track sits listing toward it, and any unit with a destroyed part trails smoke.
    if (entity.status.alive && entity.kind !== "cover" && !isBuildingKind(entity.kind)) {
      const deadMobility = entity.parts.filter((p) => p.role === "mobility" && p.hp <= 0);
      if (deadMobility.length && isInfantryKind(entity.kind)) {
        group.position.y -= 0.3;
        group.rotation.x += 0.12;
      } else if (deadMobility.length && isVehicleKind(entity.kind)) {
        const left = deadMobility.some((p) => p.id.startsWith("left"));
        const right = deadMobility.some((p) => p.id.startsWith("right"));
        group.rotation.z += (left ? 0.07 : 0) - (right ? 0.07 : 0);
        if (left && right) group.position.y -= 0.12;
      }
      const wrecked = entity.parts.filter((p) => p.hp <= 0 && p.role !== "armor").length;
      if (wrecked > 0 && this.particles) {
        const now = performance.now();
        const lastSmoke = (group.userData.lastSmokeAt as number | undefined) ?? 0;
        if (now - lastSmoke > 420 / Math.min(3, wrecked)) {
          group.userData.lastSmokeAt = now;
          this.particles.burst({
            x: entity.position.x + (Math.random() - 0.5) * entity.radius, y: group.position.y + entity.height * 0.7, z: entity.position.z + (Math.random() - 0.5) * entity.radius,
            count: 1, color: [0x3a3632, 0x6a6058], speed: [0.2, 0.5], up: 1, size: [0.22, 0.4],
            life: [1.2, 2.2], gravity: -0.6, drag: 1.2, jitter: 0.1,
          });
        }
      }
    }
    // AIRBORNE INFANTRY (a jump trooper mid-leap): lean into the arc and pour thrust out of the
    // pack. The sim owns the arc; this is only the read of it.
    if (entity.flying && isInfantryKind(entity.kind) && entity.status.alive) {
      group.rotation.x += 0.42;
      const fx = this.particles;
      if (fx) {
        const back = { x: -Math.sin(entity.yaw) * 0.45, z: -Math.cos(entity.yaw) * 0.45 };
        fx.directionalBurst({
          x: entity.position.x + back.x, y: group.position.y + 0.6, z: entity.position.z + back.z,
          dirX: back.x * 0.6, dirY: -1, dirZ: back.z * 0.6,
          count: 3, color: [0xfff1c8, 0xffb14a, 0xff6a1a], speed: [3, 6], spread: 0.3,
          size: [0.08, 0.18], life: [0.08, 0.2], gravity: 0, drag: 4, shape: ParticleShape.streak,
        });
        fx.burst({
          x: entity.position.x + back.x, y: group.position.y + 0.5, z: entity.position.z + back.z,
          count: 1, color: [0x8a8078, 0xb0a89e], speed: [0.3, 0.9], up: 0.2, size: [0.2, 0.4],
          life: [0.5, 0.9], gravity: -0.3, drag: 1.5, jitter: 0.1,
        });
      }
    }
    // MELEE LUNGE. The striker's whole body commits: it coils back through the wind-up, drives
    // ~0.6 units INTO the target at contact and recovers. The per-part swing alone reads as a
    // wave from the tactical camera; the body moving is what makes a strike look like it has
    // weight behind it.
    const lungeTarget = group.userData.meleeTarget as Vec2 | undefined;
    const lungePhase = group.userData.attackPhase as number | undefined;
    if (lungeTarget && lungePhase !== undefined && entity.status.alive) {
      const dx = lungeTarget.x - entity.position.x;
      const dz = lungeTarget.z - entity.position.z;
      const len = Math.hypot(dx, dz) || 1;
      const contact = 0.5;
      // -0.22 (coil) at 60% of the wind-up, +1 at contact, then a damped settle back to 0.
      const drive = lungePhase < contact
        ? -0.22 * Math.sin((lungePhase / contact) * Math.PI)
        : Math.cos(((lungePhase - contact) / (1 - contact)) * Math.PI * 1.4) * (1 - (lungePhase - contact) / (1 - contact));
      const reach = Math.min(0.6, Math.max(0, len - entity.radius - 0.5));
      group.position.x += (dx / len) * drive * reach;
      group.position.z += (dz / len) * drive * reach;
      group.rotation.x += Math.max(0, drive) * 0.22;
      group.position.y -= Math.max(0, drive) * 0.06;
    }
    if (entity.downed && entity.status.alive && isInfantryKind(entity.kind)) {
      // Down but not dead: flat on the ground, a slow breathing heave so it reads as alive.
      group.rotation.x += 1.35 + Math.sin(performance.now() * 0.0025) * 0.03;
      group.position.y -= 0.08;
    }
    if (dying) this.poseDeath(group, entity);
    // Hit flinch: the struck unit lurches away from the shooter with a quick pitch + roll
    // shudder and a brief downward absorb, so a landed hit reads as a physical reaction.
    const flinch = entity.status.alive && entity.kind !== "cover" ? this.entityFlinch(entity.id) : undefined;
    if (flinch) {
      const kindScale = isVehicleKind(entity.kind) ? 0.4 : isInfantryKind(entity.kind) ? 1.6 : 0.6;
      const s = flinch.f * kindScale;
      group.position.x += flinch.dx * s * 0.18;
      group.position.z += flinch.dz * s * 0.18;
      group.position.y -= s * 0.05;
      group.rotation.x += s * 0.14;
      group.rotation.z += Math.sin(performance.now() * 0.075) * s * 0.07;
    }
    const renderGhosted = ghosted;
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
      this.paintPart(group, mesh, entity, part, entity.id === selectedId, entity.id === targetId, part.id === targetPartId, renderGhosted);
      if (entity.status.alive) this.pickables.push(mesh);
      if (dying && (part.id === "turret" || part.id === "cannon") && isVehicleKind(entity.kind) && !isAirKind(entity.kind)) this.blowOffTurret(mesh, group);
    });
    if (this.trackedFeet.size) this.recordFeet(entity, group);
  }

  /**
   * DEATHS (2026-09-22). One generic topple read as a unit falling asleep. Now each family dies
   * its own way, all on the renderer's clock and seeded from the entity (the sim is untouched):
   *   thrown  -- infantry killed by a big hit: launched back along the killing blow with a flip,
   *              lands flat, bounces once, kicks up dust.
   *   crumple -- knees give, then the body folds forward onto the ground.
   *   spin    -- twists round and drops sideways.
   *   wreck   -- a ground vehicle hops on its internal blast, rolls, throws its turret, then sits
   *              charred and smoking before it sinks.
   *   spiral  -- an aircraft spins nose-down to the ground and explodes on impact.
   * Group-level transforms only (plus the turret throw), so the pooled part paint, per-part
   * damage and the rig contract never know a death is playing.
   */
  private poseDeath(group: THREE.Group, entity: CombatEntity): void {
    const t = Math.min(1, (performance.now() - (group.userData.diedAt as number)) / deathMs(entity));
    const dir = group.userData.deathDir as { dx: number; dz: number };
    const style = group.userData.deathStyle as DeathStyle;
    const local = Math.atan2(dir.dx, dir.dz) - entity.yaw; // shove direction in the group's own frame
    const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 2.4);
    const tilt = (angle: number): void => {
      group.rotation.x += Math.cos(local) * angle;
      group.rotation.z -= Math.sin(local) * angle;
    };
    const sinkFrom = style === "wreck" || style === "spiral" ? 0.8 : 0.72;
    const sink = Math.max(0, (t - sinkFrom) / (1 - sinkFrom));
    const hash01 = (hash(entity.id) % 1000) / 1000;
    const beat = (bit: number, at: number, fire: () => void): void => {
      const beats = group.userData.deathBeats as number;
      if (t >= at && (beats & bit) === 0) {
        group.userData.deathBeats = beats | bit;
        fire();
      }
    };
    if (style === "thrown") {
      const a = clamp01(t / 0.3); // airborne for the first ~0.8s
      const land = clamp01((t - 0.3) / 0.12);
      group.position.x += dir.dx * 1.35 * easeOut(a);
      group.position.z += dir.dz * 1.35 * easeOut(a);
      group.position.y += 4 * 0.6 * a * (1 - a) + (land > 0 && land < 1 ? Math.sin(land * Math.PI) * 0.1 : 0);
      tilt(-1.5 * easeOut(a * 1.15)); // flips onto its back, away from the blow
      group.rotation.y += (hash01 - 0.5) * 1.4 * easeOut(a);
      beat(1, 0.3, () => this.deathBurst(entity, group, "land"));
    } else if (style === "crumple") {
      const knees = easeOut(t / 0.22);
      const fold = easeOut((t - 0.18) / 0.34);
      group.scale.y *= 1 - 0.18 * knees * (1 - fold);
      group.position.y -= 0.16 * knees;
      tilt(1.48 * fold * (hash01 > 0.5 ? 1 : 0.85));
      beat(1, 0.5, () => this.deathBurst(entity, group, "land"));
    } else if (style === "spin") {
      const f = easeOut(t / 0.45);
      group.rotation.y += (hash01 > 0.5 ? 1 : -1) * 1.9 * f;
      group.rotation.z += (hash01 > 0.5 ? -1 : 1) * 1.45 * f;
      group.position.y -= 0.06 * f;
      beat(1, 0.42, () => this.deathBurst(entity, group, "land"));
    } else if (style === "wreck") {
      const hop = clamp01(t / 0.1);
      group.position.y += Math.sin(hop * Math.PI) * 0.5 - 0.16 * easeOut(t / 0.2);
      tilt(0.14 * Math.sin(hop * Math.PI) + 0.07 * easeOut(t / 0.2));
      group.rotation.y += (hash01 - 0.5) * 0.3 * easeOut(t / 0.2);
      beat(1, 0.34, () => this.deathBurst(entity, group, "land"));
    } else {
      // spiral: fall the full altitude with a quickening spin, nose down, then burn on the ground.
      const agl = entity.agl ?? 6;
      const fall = clamp01(t / 0.42);
      group.position.y -= agl * fall * fall;
      group.rotation.y += (hash01 > 0.5 ? 1 : -1) * 7 * fall * fall;
      // On impact the airframe slaps down onto its belly (it stood on its nose otherwise).
      const settle = clamp01((t - 0.42) / 0.08);
      group.rotation.x += 0.75 * fall - 0.62 * settle;
      group.rotation.z += 0.5 * fall - 0.28 * settle;
      group.position.y += 0.35 * settle;
      group.position.x += dir.dx * 2.2 * fall;
      group.position.z += dir.dz * 2.2 * fall;
      beat(1, 0.42, () => this.deathBurst(entity, group, "impact"));
    }
    group.position.y -= sink * (isVehicleKind(entity.kind) ? 2.4 : 1.6);
  }

  /** A vehicle's turret/gun thrown clear by the blast: up, over, and down onto the deck beside it. */
  private blowOffTurret(mesh: THREE.Mesh, group: THREE.Group): void {
    const t = Math.min(1, (performance.now() - (group.userData.diedAt as number)) / 4200);
    const u = clamp01(t / 0.34);
    const side = hash(String(group.userData.entityId)) % 2 ? 1 : -1;
    mesh.position.y += 4 * 1.9 * u * (1 - u) - 0.45 * u;
    mesh.position.x += side * 1.3 * u;
    mesh.rotation.x += 2.6 * u;
    mesh.rotation.z += side * 1.1 * u;
  }

  /** The one-shot bursts a death fires: the moment of death, a body landing, an aircraft hitting. */
  private deathBurst(entity: CombatEntity, group: THREE.Group, beat: "start" | "land" | "impact"): void {
    const p = { x: group.position.x, z: group.position.z };
    const ground = drawnGroundAt(p);
    if (beat === "impact" || (beat === "start" && isVehicleKind(entity.kind) && !isAirKind(entity.kind))) {
      this.flashLight(p, 0xff8a3a, 7, 320, 1.6);
      this.spawnSmokeColumn(p, 5, 0x2a2521, 0.42, 2.6, ground + 0.4);
      this.spawnSmokeColumn(p, 3, 0xff9a3c, 0.55, 0.7, ground + 0.3); // the fire ball inside it
    } else if (beat === "start" && isAirKind(entity.kind)) {
      this.flashLight(p, 0xffb05a, 4, 200, (entity.agl ?? 6) + 1);
    } else if (beat === "land") {
      this.spawnSmokeColumn(p, isVehicleKind(entity.kind) ? 3 : 2, this.propTint.getHex(), 0.34, 0.9, ground + 0.05);
    }
  }

  private flyThrownBody(entity: CombatEntity, group: THREE.Group, groundY: number): void {
    const last = group.userData.lastSimPos as { x: number; z: number; y: number } | undefined;
    group.userData.lastSimPos = { x: entity.position.x, z: entity.position.z, y: groundY };
    const infantry = isInfantryKind(entity.kind);
    const thrownKind = infantry || isVehicleKind(entity.kind);
    if (last && thrownKind && !entity.flying && entity.kind !== "jumper") {
      const d = Math.hypot(entity.position.x - last.x, entity.position.z - last.z);
      // Nothing walks 0.8m between two frames; only a throw (or a teleport-style placement) does.
      if (d > 0.8 && d < 20 && !this.commandPhase) { // only in a resolve: deploys and restores place, they do not throw
        const dx = (entity.position.x - last.x) / d;
        const dz = (entity.position.z - last.z) / d;
        group.userData.flight = {
          from: { ...last }, start: performance.now(), dur: infantry ? 380 + d * 70 : 320,
          height: infantry ? Math.min(3, 0.6 + d * 0.35) : 0.35,
          // Backwards along the throw: a pitch about the unit's own axis, signed by its facing.
          spin: infantry ? (d > 3 ? Math.PI * 2 : Math.PI * 0.7) : 0.12,
          side: -Math.sin(entity.yaw) * dz + Math.cos(entity.yaw) * dx,
        };
      }
    }
    const f = group.userData.flight as { from: { x: number; z: number; y: number }; start: number; dur: number; height: number; spin: number; side: number } | undefined;
    if (!f) { group.userData.flightPitch = 0; group.userData.flightRoll = 0; return; }
    const t = (performance.now() - f.start) / f.dur;
    if (t >= 1) {
      group.userData.flight = undefined;
      group.userData.flightPitch = 0;
      group.userData.flightRoll = 0;
      // Landing: a puff of dust where it came down.
      this.particles?.burst({
        x: entity.position.x, y: groundY + 0.12, z: entity.position.z,
        count: infantry ? 14 : 8, color: [0xa89e92, 0xcfc4b4], speed: [1.2, 3.2], up: 0.3, size: [0.25, 0.5],
        life: [0.4, 0.9], gravity: -0.2, drag: 2.2, jitter: 0.3,
      });
      return;
    }
    const e = 1 - (1 - t) * (1 - t); // ease-out: fast off the ground, settling into the landing
    group.position.x = f.from.x + (entity.position.x - f.from.x) * e;
    group.position.z = f.from.z + (entity.position.z - f.from.z) * e;
    group.position.y = f.from.y + (groundY - f.from.y) * e + Math.sin(Math.PI * t) * f.height;
    group.userData.flightPitch = -f.spin * e;
    group.userData.flightRoll = f.side * Math.sin(Math.PI * t) * 0.35;
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
    const group = new THREE.Group();
    group.userData.entityId = entity.id;
    // Vehicles and structures: the Blender vehicles kit (art/vehicles) assembles authored parts
    // through the pooled part path; until it has loaded (or if it never does) the older
    // procedural builders stand in, so the game runs with public/models/ empty.
    const kit = vehiclesKitReady();
    if (entity.kind === "gunship") this.buildGunship(group, entity);
    else if (entity.kind === "interceptor") this.buildInterceptor(group, entity);
    else if (entity.kind === "bomber") this.buildBomber(group, entity);
    else if (entity.kind === "transport") this.buildTransport(group, entity);
    else if (entity.kind === "flak") this.buildFlak(group, entity);
    else if (isVehicleKind(entity.kind)) { if (kit) this.buildVehicleKit(group, entity); else this.buildTank(group, entity); }
    if (isInfantryKind(entity.kind)) this.buildSoldier(group, entity);
    if (entity.kind === "base") { if (kit) this.buildBaseKit(group, entity); else this.buildBase(group, entity); }
    if (isDefenseKind(entity.kind)) { if (kit && entity.kind === "turret") this.buildTurretKit(group, entity); else this.buildDefense(group, entity); }
    if (entity.kind === "cover") this.buildCover(group, entity);
    if (entity.kind === "artillery") group.add(makeOutriggers());
    this.buildDigInRing(group, entity);
    // Flyers add their own ground shadow (dropped to terrain level) in buildGunship; everyone else
    // gets a contact shadow at their feet.
    if (entity.kind !== "cover" && !entity.flying) group.add(makeContactShadow(entity.radius));
    return group;
  }

  // ===========================================================================
  // VEHICLES KIT (art/vehicles/author_vehicles.py → vehicles-kit.glb + vehiclesLayout.ts)
  //
  // One authored mesh per damage-model part, placed at the bbox the layout file recorded, so
  // per-part damage, cannon recoil, dead-track listing and the pooled team paint all work on it
  // exactly as on a procedural part. Team colour is what it is everywhere else: the part's base
  // hue goes through `roleColor` (hull sits in the team hue family) and the saturated read is a
  // handful of small ACCENT boxes — headlamps, a turret stripe, a cupola lamp — in the faction
  // glow. Every part carries an inverted-hull ink rim (`ink`), the same line the troopers wear.
  // The procedural builders below stay as the fallback while the GLB is missing.
  // ===========================================================================
  private vpart(
    group: THREE.Group,
    entity: CombatEntity,
    partId: string,
    part: VehiclesPart,
    color: number,
    options: { dx?: number; metalness?: number; roughness?: number; emissive?: number; emissiveIntensity?: number; accent?: boolean; rotation?: [number, number, number]; ink?: number } = {},
  ): PartMesh {
    const layout = VEHICLE_LAYOUT[part];
    const { dx = 0, ...rest } = options;
    return this.box(group, entity, partId, layout.size, [layout.center[0] + dx, layout.center[1], layout.center[2]], color, {
      geometry: vehicleGeometry(part),
      ink: VEHICLE_INK,
      bevel: 0.06,
      metalness: 0.12,
      roughness: 0.7,
      ...rest,
    });
  }

  private buildVehicleKit(actor: THREE.Group, entity: CombatEntity): void {
    // The kit is authored at a comfortable modelling scale; the board wants toy proportions — a
    // tank about a trooper-and-a-half long, turret top at head height (Advance Wars, not a scale
    // model next to a giant). One rig scale keeps the authored parts fitting each other exactly.
    const group = new THREE.Group();
    group.scale.setScalar(VEHICLE_KIT_SCALE);
    actor.add(group);
    const glow = entity.team === "enemy" ? TEAMS.enemyAccent : (entity.accent ?? this.playerAccent);
    const lamp = { accent: true, emissive: glow, emissiveIntensity: 0.4, bevel: 0.3 } as const;
    const stripe = { accent: true, emissive: glow, emissiveIntensity: 0.22, bevel: 0.3 } as const;
    const TRACK = 0x2a3034;
    if (entity.kind === "apc") {
      // Wheeled 6x6 troop carrier: tall slab-sided box on big tyres, cupola autogun, rear ramp.
      this.vpart(group, entity, "hull", "apc-hull", 0x557784);
      this.vpart(group, entity, "front-plate", "apc-front", 0x7d918f);
      this.vpart(group, entity, "left-tread", "apc-wheels", TRACK, { dx: -0.9, metalness: 0.2 });
      this.vpart(group, entity, "right-tread", "apc-wheels", TRACK, { dx: 0.9, metalness: 0.2 });
      this.vpart(group, entity, "turret", "apc-cupola", 0x2b4a5a);
      this.vpart(group, entity, "cannon", "apc-autogun", 0x8e9c98, { metalness: 0.3 });
      for (const x of [-0.6, 0.6]) this.box(group, entity, "front-plate", [0.34, 0.12, 0.1], [x, 1.02, 1.56], 0xd8b870, lamp);
      for (const side of [-1, 1]) for (const z of [-0.5, 0.0, 0.5]) this.box(group, entity, "hull", [0.05, 0.16, 0.2], [side * 0.95, 1.42, z], 0x121a1e, stripe);
      this.box(group, entity, "hull", [1.0, 0.1, 0.06], [0, 1.24, -1.47], 0x3a5563, stripe); // ramp stripe
      this.cylinder(group, entity, "turret", 0.025, 0.7, [0.82, 2.3, -0.62], 0xdfeaf2, [0, 0, 0], { accent: true, emissive: glow, emissiveIntensity: 0.16 });
      this.box(group, entity, "turret", [0.08, 0.08, 0.08], [0.82, 2.66, -0.62], 0x9dfcff, { accent: true, emissive: glow, emissiveIntensity: 0.85 });
      this.factionVehicleDress(group, entity);
      return;
    }
    if (entity.kind === "artillery") {
      // Self-propelled gun: low tracked carriage, dozer blade, howitzer parked at elevation.
      this.vpart(group, entity, "hull", "arty-hull", 0x527570);
      this.vpart(group, entity, "front-plate", "arty-front", 0x7d918f);
      this.vpart(group, entity, "left-tread", "arty-track", TRACK, { dx: -0.9, metalness: 0.2 });
      this.vpart(group, entity, "right-tread", "arty-track", TRACK, { dx: 0.9, metalness: 0.2 });
      this.vpart(group, entity, "turret", "arty-mount", 0x2b4a5a);
      this.vpart(group, entity, "cannon", "arty-gun", 0x8e9c98, { metalness: 0.32 });
      for (const x of [-0.5, 0.5]) this.box(group, entity, "front-plate", [0.3, 0.12, 0.1], [x, 1.16, 1.42], 0xd8b870, lamp);
      for (const x of [-0.58, 0.58]) this.box(group, entity, "turret", [0.06, 0.1, 0.6], [x, 1.7, -0.3], 0xdaf7ff, stripe);
      this.box(group, entity, "hull", [0.3, 0.06, 0.3], [0.92, 0.78, 0.4], 0xffd9a0, { accent: true, emissive: 0xffa04a, emissiveIntensity: 0.25, bevel: 0.3 });
      this.factionVehicleDress(group, entity);
      return;
    }
    // Tank: tracked hull, sloped glacis, big rounded turret, long gun.
    this.vpart(group, entity, "hull", "tank-hull", 0x527c88);
    this.vpart(group, entity, "front-plate", "tank-front", 0x7d918f);
    this.vpart(group, entity, "left-tread", "tank-track", TRACK, { dx: -0.9, metalness: 0.2 });
    this.vpart(group, entity, "right-tread", "tank-track", TRACK, { dx: 0.9, metalness: 0.2 });
    this.vpart(group, entity, "turret", "tank-turret", 0x2b4a5a);
    this.vpart(group, entity, "cannon", "tank-cannon", 0x8e9c98, { metalness: 0.32 });
    for (const x of [-0.7, 0.7]) this.box(group, entity, "front-plate", [0.4, 0.14, 0.1], [x, 0.95, 1.5], 0xd8b870, lamp);
    for (const x of [-0.8, 0.8]) this.box(group, entity, "turret", [0.06, 0.12, 0.9], [x, 1.42, 0.05], 0xdaf7ff, stripe);
    this.box(group, entity, "turret", [0.12, 0.1, 0.12], [0.34, 1.8, -0.12], 0x8df0ff, { accent: true, emissive: glow, emissiveIntensity: 0.85, bevel: 0.3 });
    for (const x of [-0.7, 0.7]) this.box(group, entity, "hull", [0.14, 0.14, 0.06], [x, 1.1, -1.72], 0x151b1d, { emissive: 0xff7d26, emissiveIntensity: 0.18, bevel: 0.3 });
    this.factionVehicleDress(group, entity);
  }

  private buildBaseKit(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x5fe6ff;
    this.vpart(group, entity, "core", "hq-core", 0x585a52, { roughness: 0.9, metalness: 0.06 });
    this.vpart(group, entity, "comms", "hq-comms", 0x8f958b, { metalness: 0.3 });
    this.vpart(group, entity, "power", "hq-power", 0x4b4a3f, { metalness: 0.22, roughness: 0.86 });
    this.vpart(group, entity, "gate", "hq-gate", 0x3b3d37, { metalness: 0.2, roughness: 0.85 });
    // Accents, as on the procedural HQ: lit window band, team banner, roof lamps, comms beacon,
    // reactor vent glow, gate sill lamps. Same positions — the kit was authored to the same numbers.
    const glass = { emissive: factionGlow, emissiveIntensity: 0.32, metalness: 0.3, bevel: 0.3 } as const;
    this.box(group, entity, "core", [1.28, 0.2, 0.06], [0.1, 2.16, 0.69], 0x1d2a2e, glass);
    this.box(group, entity, "core", [0.06, 0.2, 1.1], [-0.62, 2.16, 0.05], 0x1d2a2e, glass);
    this.cylinder(group, entity, "core", 0.045, 1.15, [1.06, 2.5, 0.66], 0x9aa096, [0, 0, 0], { metalness: 0.34 });
    this.box(group, entity, "core", [0.05, 0.46, 0.66], [1.06, 2.82, 0.99], factionGlow, { emissive: factionGlow, emissiveIntensity: 0.45 });
    this.box(group, entity, "core", [0.05, 0.46, 0.16], [1.06, 2.82, 1.4], factionGlow, { emissive: factionGlow, emissiveIntensity: 0.28 });
    for (const x of [-0.9, 0.9]) this.box(group, entity, "core", [0.12, 0.08, 0.12], [x, 1.82, -0.94], 0xffd9a0, { emissive: 0xffa04a, emissiveIntensity: 0.5 });
    this.box(group, entity, "comms", [0.1, 0.1, 0.1], [-0.92, 3.58, -0.2], 0xffb08a, { emissive: 0xff6a4a, emissiveIntensity: 0.6, bevel: 0.4 });
    this.box(group, entity, "power", [0.5, 0.16, 0.06], [1.0, 0.68, -0.34], 0xffb347, { emissive: 0xff8c1a, emissiveIntensity: 0.55, bevel: 0.35 });
    for (const x of [-0.5, 0, 0.5]) this.box(group, entity, "gate", [0.26, 0.06, 0.06], [x, 1.02, 1.4], 0xffd9a0, { emissive: 0xffa04a, emissiveIntensity: 0.4, bevel: 0.4 });
    this.factionBaseDress(group, entity);
  }

  // ---------------------------------------------------------------------------------------------
  // FACTION DRESS: extra geometry that changes a SILHOUETTE per faction, hung on existing part ids
  // so it rides the rig, takes damage paint and is pooled like any part. Accent colours stay put.
  // ---------------------------------------------------------------------------------------------
  private factionInfantryDress(rig: THREE.Group, entity: CombatEntity): void {
    const f = factionOfEntity(entity);
    // 2026-09-23 ("the factions still feel too similar"): each faction also carries ONE saturated
    // secondary read -- Vanguard pale-steel helmets, Syndicate rust hoods, Bastion gorgets with
    // hazard-yellow chevrons -- so a rank reads as its faction before its kinds are told apart.
    if (f === "syndicate") {
      // Irregulars: a rust neck scarf with a tail blowing off the back, a bandolier, and a rust
      // cloth HOOD draped over the back of the helmet down onto the shoulders -- a hunched outline.
      this.cylinder(rig, entity, "body", 0.19, 0.12, [0, 1.19, 0.01], 0xa8472a, [0, 0, 0], { accent: true, metalness: 0.02, roughness: 0.95 });
      this.box(rig, entity, "body", [0.12, 0.3, 0.04], [0.07, 1.04, -0.2], 0xa8472a, { accent: true, rotation: [0.35, 0, 0.15], roughness: 0.95 });
      this.box(rig, entity, "body", [0.07, 0.62, 0.36], [0, 0.93, 0.02], 0x3b2a1c, { rotation: [0, 0, 0.75], metalness: 0.05, roughness: 0.9 });
      this.box(rig, entity, "body", [0.4, 0.34, 0.12], [0, 1.24, -0.2], 0x9a3f22, { accent: true, rotation: [-0.22, 0, 0], roughness: 0.95, bevel: 0.2 });
      for (const side of [-1, 1]) this.box(rig, entity, "body", [0.12, 0.22, 0.26], [side * 0.22, 1.2, -0.08], 0x9a3f22, { accent: true, rotation: [0, 0, side * 0.3], roughness: 0.95, bevel: 0.2 });
    } else if (f === "bastion") {
      // Fortress troops: a heavy chest plate, broad square shoulder plates, and a raised armoured
      // GORGET the helmet sinks into -- a boxier, neckless outline. Hazard-yellow chevrons on the plate.
      this.box(rig, entity, "body", [0.4, 0.3, 0.07], [0, 0.95, 0.21], 0x4c5240, { metalness: 0.3, bevel: 0.25 });
      for (const side of [-1, 1]) this.box(rig, entity, "body", [0.26, 0.08, 0.36], [side * 0.34, 1.17, 0.01], 0x4c5240, { metalness: 0.32, rotation: [0, 0, side * -0.18], bevel: 0.3 });
      this.box(rig, entity, "body", [0.46, 0.16, 0.4], [0, 1.2, -0.01], 0x4c5240, { metalness: 0.32, bevel: 0.3 });
      for (const side of [-1, 1]) this.box(rig, entity, "body", [0.16, 0.05, 0.02], [side * 0.07, 0.99, 0.25], 0xe0b12a, { accent: true, rotation: [0, 0, side * 0.6] });
    } else if (f === "vanguard") {
      // Regulars: a back-mounted radio with a tall whip antenna -- the one thing that sticks up --
      // under a pale-steel helmet (FACTION_HELMET).
      this.box(rig, entity, "body", [0.2, 0.24, 0.1], [-0.08, 1.02, -0.24], 0x2c3a44, { metalness: 0.25 });
      this.cylinder(rig, entity, "body", 0.012, 0.62, [-0.14, 1.42, -0.26], 0x1a2226, [0, 0, 0.08], { metalness: 0.4 });
    }
  }

  // DIG IN (Bastion doctrine): a low arc of sandbags across a dug-in unit's front, shown only while
  // the sim says it is dug in. Its part id names no damage part, so paintPart leaves it alone and it
  // is never picked; the terrain-clip audit skips it (it sits in the ground on purpose).
  private buildDigInRing(group: THREE.Group, entity: CombatEntity): void {
    const f = factionOfEntity(entity);
    if (!f || !factionDef(f).doctrine.digIn || entity.flying || entity.kind === "tank" || !(isInfantryKind(entity.kind) || isVehicleKind(entity.kind))) return;
    const ring = new THREE.Group();
    ring.userData.digInRing = true;
    const r = entity.radius + (isInfantryKind(entity.kind) ? 0.35 : 0.5);
    const bags = isInfantryKind(entity.kind) ? 5 : 7;
    for (let i = 0; i < bags; i += 1) {
      const a = -1.25 + (2.5 * i) / (bags - 1);
      const bag = this.box(ring, entity, "dug-in", [0.46, 0.2, 0.26], [Math.sin(a) * r, 0.08, Math.cos(a) * r], 0x8a7f66, { accent: true, rotation: [0, a, 0], roughness: 0.95, bevel: 0.45 });
      bag.userData.sunk = true;
    }
    ring.visible = false;
    group.userData.digInRing = ring;
    group.add(ring);
  }

  private factionVehicleDress(group: THREE.Group, entity: CombatEntity): void {
    const f = factionOfEntity(entity);
    const hullPart = entity.kind === "apc" ? "apc-hull" : entity.kind === "artillery" ? "arty-hull" : "tank-hull";
    const { size, center } = VEHICLE_LAYOUT[hullPart];
    const halfW = size[0] / 2;
    const halfL = size[2] / 2;
    const deck = center[1] + size[1] / 2;
    if (f === "syndicate") {
      // Scrap-built: slat-cage armour bolted along both sides, jerrycans and a spare wheel on the back.
      for (const side of [-1, 1]) {
        this.box(group, entity, "hull", [0.06, 0.08, size[2] * 0.92], [side * (halfW + 0.16), deck - 0.1, center[2]], 0x3a2f24, { metalness: 0.3 });
        for (let i = 0; i < 6; i += 1) {
          const z = center[2] - halfL * 0.85 + (i / 5) * halfL * 1.7;
          this.box(group, entity, "hull", [0.05, size[1] * 0.75, 0.05], [side * (halfW + 0.16), deck - size[1] * 0.42, z], 0x3a2f24, { metalness: 0.3 });
        }
      }
      for (const x of [-0.45, 0, 0.45]) this.box(group, entity, "hull", [0.34, 0.44, 0.22], [x, deck - 0.2, center[2] - halfL - 0.12], 0x6e3a22, { accent: true, roughness: 0.8 });
      this.cylinder(group, entity, "hull", 0.34, 0.2, [halfW * 0.6, deck + 0.14, center[2] - halfL * 0.6], 0x1c1c1c, [Math.PI / 2, 0, 0], { roughness: 0.95 });
      // A welded RAM PLOUGH: a raked wedge of scrap on the nose with three rust-tipped spikes.
      this.box(group, entity, "front-plate", [size[0] * 0.95, size[1] * 0.55, 0.14], [0, deck - size[1] * 0.62, center[2] + halfL + 0.2], 0x4a3a2a, { metalness: 0.35, rotation: [0.55, 0, 0] });
      for (const x of [-0.5, 0, 0.5]) this.box(group, entity, "front-plate", [0.1, 0.1, 0.42], [x * size[0] * 0.7, deck - size[1] * 0.62, center[2] + halfL + 0.4], 0xa8472a, { accent: true, metalness: 0.3 });
    } else if (f === "bastion") {
      // Fortress armour: thick skirts hung over the running gear and a row of armour bricks.
      for (const side of [-1, 1]) this.box(group, entity, "hull", [0.14, size[1] * 0.62, size[2] * 0.96], [side * (halfW + 0.1), deck - size[1] * 0.4, center[2]], 0x5a6048, { metalness: 0.28, bevel: 0.2 });
      for (let i = 0; i < 4; i += 1) this.box(group, entity, "front-plate", [size[0] * 0.2, 0.18, 0.2], [-size[0] * 0.33 + i * size[0] * 0.22, deck - 0.02, center[2] + halfL - 0.1], 0x4c5240, { metalness: 0.3, bevel: 0.2 });
      // A DOZER BLADE across the nose, striped in hazard chevrons -- siege engineering you can read.
      const bladeZ = center[2] + halfL + 0.28;
      this.box(group, entity, "front-plate", [size[0] * 1.08, size[1] * 0.62, 0.14], [0, deck - size[1] * 0.66, bladeZ], 0x585e46, { metalness: 0.32, rotation: [-0.18, 0, 0], bevel: 0.2 });
      for (let i = 0; i < 4; i += 1) this.box(group, entity, "front-plate", [0.16, size[1] * 0.4, 0.04], [-size[0] * 0.36 + i * size[0] * 0.24, deck - size[1] * 0.64, bladeZ + 0.1], 0xe0b12a, { accent: true, rotation: [-0.18, 0, 0.6] });
    } else if (f === "vanguard") {
      // Issued kit: a stowage bin on the back deck and two whip antennas.
      this.box(group, entity, "hull", [size[0] * 0.7, 0.28, 0.42], [0, deck + 0.14, center[2] - halfL * 0.72], 0x3a4f5e, { metalness: 0.2, bevel: 0.2 });
      for (const x of [-halfW * 0.7, halfW * 0.7]) this.cylinder(group, entity, "hull", 0.02, 1.3, [x, deck + 0.65, center[2] - halfL * 0.5], 0x1a2226, [0, 0, 0], { metalness: 0.4 });
      // SMOKE-LAUNCHER racks on both front corners and a bone-white chevron across the deck.
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i += 1) this.cylinder(group, entity, "hull", 0.07, 0.3, [side * (halfW - 0.2), deck + 0.12, center[2] + halfL * 0.62 - i * 0.16], 0x2c3a44, [-0.9, 0, side * 0.5], { metalness: 0.35 });
        this.box(group, entity, "hull", [size[0] * 0.4, 0.03, 0.14], [side * size[0] * 0.17, deck + 0.02, center[2] + halfL * 0.2], 0xe6e2d4, { accent: true, rotation: [0, side * 0.55, 0] });
      }
    }
  }

  private factionBaseDress(group: THREE.Group, entity: CombatEntity): void {
    const f = factionOfEntity(entity);
    if (f === "vanguard") {
      // Radar dish on a lattice mast, and a helipad slab with its H.
      this.cylinder(group, entity, "comms", 0.07, 2.2, [1.6, 1.1, 1.2], 0x33424c, [0, 0, 0], { metalness: 0.4 });
      this.cylinder(group, entity, "comms", 0.62, 0.1, [1.6, 2.3, 1.2], 0x8a9aa4, [Math.PI / 2.6, 0, 0.2], { metalness: 0.45 });
      this.box(group, entity, "core", [1.8, 0.1, 1.8], [-1.8, 0.05, 1.5], 0x39454d, { roughness: 0.9 });
      for (const x of [-0.35, 0.35]) this.box(group, entity, "core", [0.12, 0.02, 0.9], [-1.8 + x, 0.11, 1.5], 0xe8e2d0, { accent: true });
      this.box(group, entity, "core", [0.6, 0.02, 0.12], [-1.8, 0.11, 1.5], 0xe8e2d0, { accent: true });
    } else if (f === "syndicate") {
      // A camp: two tarp tents and a tall scrap mast flying a rust pennant.
      // A tent is a square prism turned 45deg about its length: the top half is the ridged roof,
      // the bottom half sits under the ground.
      for (const [x, z] of [[-2.1, 1.3], [2.0, -1.7]] as const) {
        const tent = this.box(group, entity, "core", [1.4, 0.95, 0.95], [x, 0.02, z], 0x8f5a34, { accent: true, rotation: [Math.PI / 4, 0, 0], roughness: 0.95, bevel: 0.08 });
        tent.userData.sunk = true; // half below ground on purpose; the terrain-clip audit skips it
      }
      this.cylinder(group, entity, "comms", 0.06, 4.2, [-1.7, 2.1, -1.3], 0x3a2f24, [0, 0, 0.05], { metalness: 0.3 });
      this.box(group, entity, "comms", [0.05, 0.4, 0.8], [-1.7, 3.95, -0.9], 0xb8502a, { accent: true, roughness: 0.9 });
      for (const [x, z] of [[1.9, 1.4], [2.2, 1.0]] as const) this.cylinder(group, entity, "power", 0.2, 0.5, [x, 0.25, z], 0x5a3a22, [0, 0, 0], { roughness: 0.85 });
    } else if (f === "bastion") {
      // A bunker: concrete revetment walls round three sides and a squat armoured dome on the roof.
      for (const [x, z, yaw, len] of [[0, -1.95, 0, 3.8], [-2.05, 0, Math.PI / 2, 3.2], [2.05, 0.2, Math.PI / 2, 2.8]] as const) {
        this.box(group, entity, "core", [len, 0.9, 0.42], [x, 0.45, z], 0x6a6e5c, { rotation: [0, yaw, 0], roughness: 0.95, bevel: 0.15 });
      }
      this.cylinder(group, entity, "core", 0.8, 0.5, [0.3, 2.78, -0.4], 0x4c5240, [0, 0, 0], { metalness: 0.3, radiusBottom: 0.95 });
      this.box(group, entity, "core", [0.9, 0.08, 0.14], [0.3, 2.9, 0.42], 0x1d2a2e, { emissive: 0xffa04a, emissiveIntensity: 0.3 });
    }
  }

  // Authored plinth + traverse ring, dug in behind a sandbag berm on three sides (an emplacement
  // on a bare plinth reads as furniture). Sand-coloured accents so the team paint leaves them alone.
  private buildTurretMountKit(group: THREE.Group, entity: CombatEntity): void {
    this.vpart(group, entity, "mount", "turret-mount", 0x333a42, { metalness: 0.24 });
    const bags = vehicleGeometry("sandbags");
    for (const [x, z, yaw] of [[0, -0.98, 0], [-0.98, 0.04, Math.PI / 2], [0.98, 0.04, Math.PI / 2]] as const) {
      this.box(group, entity, "mount", [1.5, 0.5, 0.56], [x, 0.25, z], 0x8a7f66, { geometry: bags, ink: VEHICLE_INK, accent: true, metalness: 0.04, roughness: 0.95, rotation: [0, yaw, 0], bevel: 0.4 });
    }
  }

  private buildTurretKit(group: THREE.Group, entity: CombatEntity): void {
    const glow = entity.team === "enemy" ? TEAMS.enemyAccent : 0x5fe6ff;
    this.buildTurretMountKit(group, entity);
    this.vpart(group, entity, "gun", "turret-gun", 0x3c454f, { metalness: 0.28 });
    this.vpart(group, entity, "sensor", "turret-sensor", 0x1a2024, { metalness: 0.3 });
    // The lens is the only thing that emits; the belt box is the one warm hardware accent.
    this.box(group, entity, "sensor", [0.12, 0.1, 0.05], [-0.34, 1.36, 0.03], 0xdaf7ff, { accent: true, emissive: glow, emissiveIntensity: 0.5, bevel: 0.3 });
    this.box(group, entity, "gun", [0.1, 0.06, 0.3], [0.5, 0.86, 0.06], 0x8a7340, { accent: true, metalness: 0.4, bevel: 0.35 });
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
      this.box(group, entity, "cannon", [0.14, 0.14, 0.78], [0.16, 1.78, 0.46], 0x7c8a84, { metalness: 0.3 });
      this.box(group, entity, "cannon", [0.2, 0.18, 0.14], [0.16, 1.78, 0.86], 0x2c3e48, { emissive: factionGlow, emissiveIntensity: 0.32 });
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
    this.box(group, entity, "cannon", [0.24, 0.24, 1.45], [0, 1.16, 1.03], 0x7c8a84, { metalness: 0.35 });
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
    this.box(group, entity, "hull", [0.72, 0.4, 0.8], [0, 0.16, 0.72], 0x5b8aa0, { metalness: 0.22 });   // cockpit
    this.box(group, entity, "hull", [0.3, 0.28, 1.4], [0, 0.06, -1.25], 0x466070, { metalness: 0.2 });   // tail boom
    this.box(group, entity, "hull", [0.5, 0.34, 0.12], [0, 0.28, -1.85], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.22 }); // tail fin
    // Main rotor (mobility): a mast + two crossed blades — spun each frame in syncEntity.
    this.cylinder(group, entity, "rotor", 0.06, 0.4, [0, 0.5, 0.05], 0x2a3236);
    this.box(group, entity, "rotor", [3.0, 0.04, 0.16], [0, 0.7, 0.05], 0x14181a);
    this.box(group, entity, "rotor", [0.16, 0.04, 3.0], [0, 0.7, 0.05], 0x14181a);
    this.box(group, entity, "rotor", [0.06, 0.72, 0.06], [0.2, 0.06, -1.9], 0x14181a);                    // tail rotor
    // Chin autocannon (weapon).
    this.box(group, entity, "gun", [0.26, 0.26, 0.7], [0, -0.3, 0.92], 0x7c8a84, { metalness: 0.35 });
    this.box(group, entity, "gun", [0.32, 0.32, 0.16], [0, -0.3, 1.32], 0x2c3e48, { emissive: factionGlow, emissiveIntensity: 0.4 });
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
    this.box(group, entity, "hull", [0.34, 0.32, 0.7], [0, 0.04, 1.25], 0x5b8aa0, { metalness: 0.3 });  // canopy
    this.box(group, entity, "hull", [0.16, 0.14, 0.5], [0, 0, 1.7], 0x7c8a84, { metalness: 0.35 });      // nose tip
    for (const side of [-1, 1]) this.box(group, entity, "wing", [1.5, 0.06, 0.9], [side * 0.9, -0.02, -0.2], 0x4a6472, { rotation: [0, side * 0.5, 0], metalness: 0.25 }); // swept delta wings
    for (const side of [-1, 1]) this.box(group, entity, "hull", [0.06, 0.42, 0.42], [side * 0.22, 0.22, -1.05], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.26 }); // twin tail fins
    for (const side of [-1, 1]) this.box(group, entity, "gun", [0.1, 0.1, 0.8], [side * 0.5, -0.06, 0.62], 0x7c8a84, { metalness: 0.4 }); // wing cannons
    for (const side of [-1, 1]) this.box(group, entity, "gun", [0.14, 0.14, 0.14], [side * 0.5, -0.06, 1.02], 0x2c3e48, { emissive: factionGlow, emissiveIntensity: 0.4 }); // muzzles
    for (const side of [-1, 1]) this.box(group, entity, "hull", [0.22, 0.22, 0.34], [side * 0.16, 0, -1.3], 0xff8c3a, { emissive: 0xff6a1e, emissiveIntensity: 0.55 }); // engine cans
    const shadow = makeContactShadow(entity.radius * 1.1);
    shadow.position.y = -(entity.agl ?? 7.5);
    group.add(shadow);
  }

  // Bomber: a big heavy bomber — fat fuselage, long straight wings, four engine nacelles, a belly
  // bomb bay. No gun. Slow and unmistakably a bomb truck, distinct from the fighter and the gunship.
  private buildBomber(group: THREE.Group, entity: CombatEntity): void {
    this.box(group, entity, "hull", [1.1, 0.7, 3.0], [0, 0, 0], 0x5f6f66, { metalness: 0.18 });        // fuselage
    this.box(group, entity, "hull", [0.7, 0.5, 0.9], [0, 0.22, 1.3], 0x6f8479, { metalness: 0.2 });     // cockpit
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
    this.box(group, entity, "hull", [0.9, 0.5, 0.7], [0, 0.2, 1.2], 0x5b8aa0, { metalness: 0.2 });     // cockpit glass
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
    for (const x of [-0.15, 0.15]) this.cylinder(group, entity, "gun", 0.07, 1.15, [x, 1.55, 0.15], 0x7c8a84, [0.95, 0, 0], { metalness: 0.35 }); // barrels angled up
    this.box(group, entity, "gun", [0.42, 0.16, 0.16], [0, 2.05, 0.6], 0x2c3e48, { emissive: factionGlow, emissiveIntensity: 0.42 }); // muzzle
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
    // Authored helmets are the biggest single surface on a trooper now, so they carry the kind's
    // hue at a readable value: the old per-kit literals were dark olive/brown and read as black
    // bowling balls once the helmet stopped being a thin cap.
    // ...and, since 2026-09-23, the FACTION's helmet colour over half of it: pale steel Vanguard,
    // rust Syndicate, dark olive Bastion. The helmet is the one surface every kind has and the
    // camera always sees, so it is where a rank reads as its faction first.
    const factionId = factionOfEntity(entity);
    const helmetColor = blendHex(blendHex(bodyColor, 0xd8d0c0, 0.3), factionId ? FACTION_HELMET[factionId] : 0xd8d0c0, factionId ? 0.55 : 0);
    const rig = new THREE.Group();
    const build = infantryBuild(entity.kind);
    rig.scale.set(build.girth, build.stature, build.girth);
    // Weapons and packs are gear, not body: they must not balloon with a broad build. The heavy's
    // 1.52 girth turned its MG into a slab wider than the trooper. Compensated per mesh after the
    // build (see the traverse at the end of this function).
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
    // AUTHORED BODY. Every chassis piece below is a Blender part (art/infantry/author_kinds.py):
    // hips with hanging thigh plates and a buckle, a torso with chest plates, straps, side pouches
    // and a back plate, a head with a jaw and neck under the helmet, arms with shoulder caps,
    // elbow pads and gloves, legs with kneepads and shin guards. The primitives they replace were
    // the reason a trooper stood next to a photoreal tank hull and read as a different game.
    this.box(rig, entity, "legs", [0.42, 0.22, 0.3], [0, 0.52, 0], trimColor, { metalness: 0.16, kit: "hips" });
    // Utility belt with pouches. Three small blocks around the front is the cheapest thing that
    // reads as "kit carried by a person" instead of a smooth mannequin.
    this.box(rig, entity, "body", [0.46, 0.09, 0.32], [0, 0.6, 0], 0x1c2326, { metalness: 0.2 });
    for (const [x, z] of [[-0.17, 0.16], [0.17, 0.16], [0, 0.185]] as const) {
      this.box(rig, entity, "body", [0.11, 0.11, 0.08], [x, 0.6, z], 0x2b343a, { metalness: 0.12, bevel: 0.3 });
    }
    // Torso: a tapered barrel with a SEPARATE upper chest mass that overhangs it. The overhang is
    // what gives the trooper a shoulder line and a shadow under the chest -- a single cylinder
    // reads as a bottle no matter how it is lit.
    // PER-KIND BODY (2026-09-20). The torso is the largest shape on a trooper and it used to be the
    // same authored chest on all thirteen kinds, so a squad read as one uniform in thirteen hats.
    // Each kind now wears its own torso variant (barrel chest + shelf pauldrons, cropped jacket +
    // scarf, ghillie ruff, asymmetric sword guard, hazmat barrel...), and where the read needs it
    // its own arm/leg variant too. Same part id, same pivot, same unit-cube contract — the rig,
    // the walk cycle, the pooled paint and per-part damage are untouched (INFANTRY_KIT_PARTS).
    const kitParts = INFANTRY_KIT_PARTS[entity.kind] ?? DEFAULT_KIT_PARTS;
    this.box(rig, entity, "body", kitParts.torsoSize, [0, 0.9, 0], bodyColor, { metalness: 0.14, outline: true, kit: kitParts.torso });
    // The glowing core seam stays: it is the one lit thing on the chest and carries the team read.
    this.box(rig, entity, "body", [0.1, 0.16, 0.05], [0, 1.0, 0.22], 0x10171a, { emissive: teamGlow, emissiveIntensity: 0.21, rotation: [-0.16, 0, 0] });
    // Gorget + neck column.
    this.cylinder(rig, entity, "body", 0.13, 0.1, [0, 1.2, 0.01], trimColor, [0, 0, 0], { metalness: 0.24 });
    this.cylinder(rig, entity, "body", 0.085, 0.12, [0, 1.25, 0.01], 0x1a2226, [0, 0, 0], { metalness: 0.3 });
    // Pauldrons: angled, bevelled plates with a rim, canted outward off the shoulder. Squashed
    // spheres read as balls at any distance; a plate with a lit top edge reads as armour.
    // ...unless the kind's own torso carries its shoulders (heavy shelves, striker guard, flamer
    // seal ring, scout's cropped jacket, sniper's ghillie ruff): a plate on top of those reads as
    // a second pair of shoulders.
    if (kitParts.pauldrons) {
      for (const side of [-1, 1]) {
        this.box(rig, entity, "body", [0.25, 0.18, 0.32], [side * 0.35, 1.05, 0.01], 0x39434a, { metalness: 0.32, rotation: [0, 0, side * -0.3], bevel: 0.3 });
        this.box(rig, entity, "body", [0.26, 0.05, 0.33], [side * 0.37, 1.15, 0.01], trimColor, { metalness: 0.4, rotation: [0, 0, side * -0.3], bevel: 0.4 });
      }
    }
    // Head: skull, a brow ridge over the visor, and a rear comms block. The brow is the single
    // detail that stops a head reading as a featureless ball.
    this.box(rig, entity, "head", [0.3, 0.36, 0.32], [0, 1.28, 0.02], 0x7b6a58, { outline: true, kit: "head" });
    this.box(rig, entity, "head", [0.216, 0.07, 0.072], [0, 1.4, 0.145], 0x2b343a, { metalness: 0.26, rotation: [-0.24, 0, 0], bevel: 0.35 });
    this.box(rig, entity, "head", [0.202, 0.085, 0.05], [0, 1.33, 0.17], 0x0c1418, { emissive: teamGlow, emissiveIntensity: 0.23 });
    this.box(rig, entity, "head", [0.101, 0.11, 0.072], [0, 1.32, -0.15], 0x2b343a, { metalness: 0.24, bevel: 0.3 });
    if (entity.kind === "sniper") {
      // Marksman: extra-long bipod-steadied rifle, a fat glowing scope, and a camo ghillie
      // hood/cloak that ragged-edges the silhouette — clearly the patient long-range shooter.
      this.box(rig, entity, "rifle", [0.18, 0.26, 1.6], [0.46, 0.95, 0.5], trimColor, { metalness: 0.34, kit: "weapon-longrifle" });
      this.box(rig, entity, "rifle", [0.22, 0.2, 0.28], [0.46, 1.08, 0.12], 0x12161a, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.21 });
      this.box(rig, entity, "rifle", [0.1, 0.1, 0.12], [0.46, 1.13, -0.06], 0x8de4ff, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.38 });
      this.cylinder(rig, entity, "rifle", 0.03, 0.44, [0.38, 0.74, 1.04], 0x14181a, [0.5, 0, 0.32], { metalness: 0.3 });
      this.cylinder(rig, entity, "rifle", 0.03, 0.44, [0.54, 0.74, 1.04], 0x14181a, [0.5, 0, -0.32], { metalness: 0.3 });
      // A ragged ghillie CAPE down the back (torso part, so it turns and breathes with the chest)
      // over the ghillie ruff the torso itself carries; a rangefinder on the chest is the accent.
      this.box(rig, entity, "body", [0.52, 0.72, 0.16], [0, 0.76, -0.3], 0x4c5436, { accent: true, rotation: [0.1, 0, 0], kit: "cape-sniper" });
      this.box(rig, entity, "body", [0.16, 0.1, 0.08], [0.12, 1.0, 0.25], 0x0a1418, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.3 });
      this.box(rig, entity, "head", [0.5, 0.4, 0.52], [0, 1.4, -0.02], helmetColor, { kit: "helmet-sniper" });
      this.box(rig, entity, "head", [0.36, 0.1, 0.101], [0, 1.4, 0.2], 0x0a1418, { accent: true, emissive: 0x8de4ff, emissiveIntensity: 0.23 });
    } else if (entity.kind === "grenadier") {
      // Splash specialist: stubby fat-muzzled launcher, a bandolier of amber rounds across
      // the chest, more on the pack, and a round pot helmet.
      this.box(rig, entity, "rifle", [0.3, 0.4, 0.96], [0.48, 0.93, 0.3], trimColor, { metalness: 0.2, kit: "weapon-launcher" });
      this.cylinder(rig, entity, "rifle", 0.21, 0.2, [0.48, 0.93, 0.74], 0x2b2418, [0.5, 0, 0], { accent: true, emissive: 0xffb02e, emissiveIntensity: 0.18 });
      // The torso is a padded vest of drum pouches; the two chest drums get lit amber heads (the
      // accent), and a pair of fat ammo drums rides the hips.
      for (const x of [-0.14, 0.14]) this.cylinder(rig, entity, "body", 0.075, 0.05, [x, 0.98, 0.27], 0xffb84a, [Math.PI / 2, 0, 0], { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.2 });
      this.box(rig, entity, "legs", [0.66, 0.24, 0.26], [0, 0.56, 0], 0x4a4030, { accent: true, metalness: 0.3, kit: "drums-grenadier" });
      for (const x of [-0.16, 0, 0.16]) this.box(rig, entity, "pack", [0.11, 0.16, 0.11], [x, 1.08, -0.42], 0xffca6b, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.35 });
      this.box(rig, entity, "head", [0.44, 0.36, 0.46], [0, 1.4, 0.0], helmetColor, { kit: "helmet-grenadier" });
      this.box(rig, entity, "head", [0.36, 0.09, 0.13], [0, 1.42, 0.22], 0x6a5626, { accent: true });
    } else if (entity.kind === "striker") {
      // Close-assault: a long glowing arc-blade, a buckler on the off arm, a shoulder
      // pauldron, and a sleek crested visor helm — aggressive and unmistakably melee.
      this.box(rig, entity, "rifle", [0.14, 0.4, 1.3], [0.52, 0.9, 0.42], 0xc6bce0, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.3, kit: "weapon-blade" });
      this.box(rig, entity, "rifle", [0.16, 0.2, 0.22], [0.52, 0.92, -0.12], 0x2a2142, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.19 });
      this.box(rig, entity, "body", [0.12, 0.6, 0.5], [-0.52, 0.86, 0.06], 0x3a2c5c, { accent: true });
      this.box(rig, entity, "body", [0.08, 0.4, 0.1], [-0.58, 0.86, 0.06], 0x8a6ecf, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.15 });
      // (The sword-shoulder guard is authored into torso-striker; the off arm is bare — arm-striker.)
      // A long scabbard on the left hip: the one unit with a blade-length diagonal below the belt.
      this.box(rig, entity, "legs", [0.1, 0.72, 0.16], [-0.3, 0.46, -0.08], 0x2a2142, { accent: true, metalness: 0.3, rotation: [0.12, 0, 0.22], kit: "sheath-striker" });
      this.box(rig, entity, "head", [0.42, 0.5, 0.46], [0, 1.44, 0.0], helmetColor, { metalness: 0.2, kit: "helmet-striker" });
      this.box(rig, entity, "head", [0.346, 0.08, 0.115], [0, 1.4, 0.22], 0xc6a8ff, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.34 });
      this.box(rig, entity, "head", [0.072, 0.26, 0.086], [0, 1.66, -0.04], 0x6a4fae, { accent: true, emissive: 0xb48cff, emissiveIntensity: 0.21 });
    } else if (entity.kind === "heavy") {
      // Anchor: the widest, bulkiest frame, armor pauldrons, a drum-fed auto-cannon with an
      // ammo belt looping to a big glowing back drum, and a slab face-visor helmet.
      // (The old chest slab and shoulder yoke are gone: with the authored torso underneath they
      // read as a plank laid across the shoulders. Bulk is the build's girth plus big pauldrons.)
      // Layered, ridged pauldrons on the barrel-chest torso's shelves (mirrored by a half turn).
      for (const side of [-1, 1]) this.box(rig, entity, "body", [0.3, 0.16, 0.38], [side * 0.44, 1.14, 0.02], 0x3e3430, { accent: true, metalness: 0.34, rotation: [0, 0, side * -0.3], kit: "pauldron-heavy" });
      this.box(rig, entity, "rifle", [0.3, 0.36, 1.1], [0.5, 0.92, 0.4], 0x2b2f31, { metalness: 0.32, kit: "weapon-mg" });
      // (accent, so the team tint never turns the ammo drum into a pale blue disc at the hip)
      this.cylinder(rig, entity, "rifle", 0.22, 0.22, [0.54, 0.76, 0.5], 0x1a1c1e, [0, 0, 0], { accent: true, metalness: 0.3 });
      this.box(rig, entity, "rifle", [0.34, 0.3, 0.22], [0.54, 0.92, 1.12], 0xb2842f, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.12 });
      for (let i = 0; i < 4; i++) this.box(rig, entity, "rifle", [0.12, 0.09, 0.1], [0.34 - i * 0.07, 0.8 - i * 0.015, 0.18 - i * 0.13], 0xb2842f, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.14 });
      // The back ammunition box (drum + feed chute + frame) replaces the generic rucksack.
      this.box(rig, entity, "pack", [0.44, 0.38, 0.26], [0, 0.92, -0.34], 0x6a4a2a, { accent: true, metalness: 0.32, kit: "ammobox-heavy" });
      this.box(rig, entity, "pack", [0.3, 0.08, 0.1], [0, 1.2, -0.3], 0xc8871f, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.16, bevel: 0.35 });
      this.box(rig, entity, "head", [0.46, 0.5, 0.46], [0, 1.36, 0.0], helmetColor, { metalness: 0.18, kit: "helmet-heavy" });
      this.box(rig, entity, "head", [0.389, 0.14, 0.115], [0, 1.32, 0.22], 0x141819, { accent: true, emissive: 0xffb02e, emissiveIntensity: 0.25 });
    } else if (entity.kind === "mortar") {
      // Indirect-fire team: long mortar tube slung high over the shoulder, a round olive
      // baseplate + folded bipod legs on the back, and a heavy olive-drab steel helmet.
      this.box(rig, entity, "rifle", [0.46, 0.56, 0.86], [0.5, 0.9, 0.24], trimColor, { metalness: 0.2, kit: "weapon-mortar" });
      this.cylinder(rig, entity, "rifle", 0.13, 1.1, [0.14, 1.2, -0.12], 0x2a2f31, [Math.PI * 0.32, 0, 0], { metalness: 0.34 });
      this.cylinder(rig, entity, "rifle", 0.16, 0.12, [-0.06, 1.6, -0.42], 0xffd27a, [Math.PI * 0.32, 0, 0], { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.19 });
      // Baseplate + folded bipod authored as one back piece (replaces the generic rucksack); the
      // torso carries the shoulder saddle the tube rides on. Accent: a range card on the chest.
      this.box(rig, entity, "pack", [0.66, 0.66, 0.2], [0, 0.98, -0.44], 0x4a4f33, { accent: true, metalness: 0.3, kit: "bipod-mortar" });
      this.box(rig, entity, "body", [0.16, 0.18, 0.06], [0.16, 0.98, 0.26], 0xffd27a, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.2 });
      this.box(rig, entity, "head", [0.46, 0.34, 0.44], [0, 1.4, 0.0], helmetColor, { metalness: 0.16, kit: "helmet-mortar" });
      this.box(rig, entity, "head", [0.36, 0.09, 0.13], [0, 1.41, 0.22], 0x3a3f28, { accent: true });
    } else if (entity.kind === "medic") {
      // Support: a clean white vest + helmet emblazoned with a bold red cross, a hip med
      // satchel, a glowing green heal vial, and only a small sidearm — reads as "help."
      this.box(rig, entity, "rifle", [0.16, 0.3, 0.48], [0.45, 0.92, 0.24], 0xb8b2ae, { metalness: 0.2, kit: "weapon-pistol" });
      // The vest and crossed satchel straps are authored into torso-medic; the red cross sits on
      // its sternum plate (the accent) and a red armband rides the left upper arm — a "body"
      // mesh tagged as the arm limb, so it swings with the arm in the walk cycle.
      this.box(rig, entity, "body", [0.18, 0.42, 0.05], [0, 0.9, 0.24], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
      this.box(rig, entity, "body", [0.42, 0.16, 0.05], [0, 0.94, 0.24], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
      this.box(rig, entity, "body", [0.23, 0.1, 0.25], [-0.43, 0.9, 0.03], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.12, bevel: 0.2 }).userData.limb = "arm-l";
      // SILHOUETTE. In the black-shape test the medic, engineer and sapper were the same outline:
      // a human with small chest kit that vanishes the moment colour does. Each now carries one
      // LARGE shape that changes the outline itself. Medic: a rolled stretcher standing proud of
      // the shoulder, and a satchel that hangs clear of the hip.
      this.box(rig, entity, "pack", [0.28, 1.08, 0.28], [-0.24, 1.28, -0.3], 0xaba695, { accent: true, rotation: [0.22, 0, 0.28], kit: "stretcher-medic" });
      this.box(rig, entity, "pack", [0.38, 0.42, 0.3], [0.44, 0.6, -0.02], 0xa39e8e, { accent: true, kit: "pack-medic" });
      this.box(rig, entity, "pack", [0.36, 0.06, 0.28], [0.44, 0.8, -0.02], 0x7d7a6c, { accent: true });
      this.box(rig, entity, "pack", [0.14, 0.05, 0.05], [0.36, 0.7, 0.07], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.19 });
      this.box(rig, entity, "pack", [0.05, 0.14, 0.05], [0.36, 0.7, 0.07], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.19 });
      this.box(rig, entity, "body", [0.1, 0.16, 0.1], [-0.3, 0.7, 0.16], 0x9dffd0, { accent: true, emissive: 0x4ce0a0, emissiveIntensity: 0.29 });
      this.box(rig, entity, "head", [0.44, 0.38, 0.44], [0, 1.4, 0.0], helmetColor, { kit: "helmet-medic" });
      this.box(rig, entity, "head", [0.072, 0.05, 0.115], [0, 1.48, 0.22], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
      this.box(rig, entity, "head", [0.036, 0.14, 0.115], [0, 1.48, 0.22], 0xff3b4e, { accent: true, emissive: 0xff2a44, emissiveIntensity: 0.21 });
    } else if (entity.kind === "scout") {
      // Light recon: stubby carbine, chest binoculars with glowing green lenses, a tall whip
      // antenna with a blinking tip, and a soft beret with goggles — the leanest silhouette.
      this.box(rig, entity, "rifle", [0.2, 0.26, 0.72], [0.46, 0.95, 0.22], trimColor, { metalness: 0.22, kit: "weapon-carbine" });
      this.box(rig, entity, "body", [0.28, 0.14, 0.12], [0, 1.0, 0.22], 0x1c2a24, { accent: true });
      for (const x of [-0.09, 0.09]) this.cylinder(rig, entity, "body", 0.05, 0.07, [x, 1.0, 0.3], 0x9dffcf, [Math.PI / 2, 0, 0], { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.36 });
      this.cylinder(rig, entity, "pack", 0.028, 0.95, [-0.2, 1.42, -0.34], 0xbcd8c6, [0, 0, 0], { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.21 });
      this.box(rig, entity, "pack", [0.08, 0.08, 0.08], [-0.2, 1.92, -0.34], 0x9dffcf, { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.38 });
      this.box(rig, entity, "head", [0.42, 0.42, 0.46], [0, 1.42, 0.0], helmetColor, { kit: "helmet-scout" });
      this.box(rig, entity, "head", [0.086, 0.1, 0.058], [0.16, 1.52, -0.04], 0x244d39, { accent: true });
      this.box(rig, entity, "head", [0.302, 0.1, 0.101], [0, 1.38, 0.2], 0x0e2a24, { accent: true, emissive: 0x6ff0b0, emissiveIntensity: 0.25 });
    } else if (entity.kind === "engineer") {
      // Builder crew: a welding torch with a blazing tip, a big steel wrench on the back,
      // a hi-vis hard hat with a head-lamp, and a tool belt of hanging gear.
      this.box(rig, entity, "rifle", [0.3, 0.16, 0.9], [0.46, 0.92, 0.22], 0x3a3320, { metalness: 0.3, kit: "weapon-wrench" });
      this.box(rig, entity, "rifle", [0.11, 0.11, 0.16], [0.46, 0.92, 0.5], 0xe4d8ae, { accent: true, emissive: 0xffce4a, emissiveIntensity: 0.38 });
      // Engineer: a heavy power-wrench slung across the back, head rising past the shoulder and
      // canted out — a hard diagonal nothing else in the roster has.
      this.box(rig, entity, "pack", [0.13, 1.0, 0.13], [-0.3, 1.12, -0.3], 0x8f979e, { accent: true, metalness: 0.42, rotation: [0.16, 0, 0.34] });
      this.box(rig, entity, "pack", [0.42, 0.2, 0.2], [-0.52, 1.62, -0.22], 0x8f979e, { accent: true, metalness: 0.42, rotation: [0.16, 0, 0.34] });
      this.box(rig, entity, "pack", [0.16, 0.2, 0.22], [-0.68, 1.66, -0.22], 0x5c6268, { accent: true, metalness: 0.4, rotation: [0.16, 0, 0.34] });
      // Hi-vis: the tool harness is authored into torso-engineer (tool tubes, belly pocket, hip
      // pouches) and leg-engineer (square kneepads); a yellow chest tab is the accent and a tool
      // roll hangs off the belt.
      this.box(rig, entity, "body", [0.3, 0.12, 0.05], [0, 1.02, 0.25], 0xffce4a, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.2 });
      this.box(rig, entity, "legs", [0.32, 0.22, 0.2], [0.32, 0.5, 0.08], 0x4a4a3a, { accent: true, metalness: 0.3, kit: "toolroll-engineer" });
      this.box(rig, entity, "head", [0.5, 0.34, 0.52], [0, 1.42, 0.0], helmetColor, { emissive: 0xff9e2b, emissiveIntensity: 0.14, kit: "helmet-engineer" });
      this.box(rig, entity, "head", [0.115, 0.1, 0.058], [0, 1.46, 0.24], 0xbfe8ff, { accent: true, emissive: 0xbfe8ff, emissiveIntensity: 0.38 });
    } else if (entity.kind === "flamer") {
      // Incendiary specialist: fat twin-nozzle projector with a pilot flame, hazard-striped
      // shoulder guard, and big glowing fuel tanks on the back — unmistakably "fire".
      this.box(rig, entity, "rifle", [0.3, 0.38, 0.98], [0.47, 0.92, 0.3], 0x3a3230, { metalness: 0.3, kit: "weapon-flamethrower" });
      this.cylinder(rig, entity, "rifle", 0.09, 0.3, [0.47, 0.92, 0.78], 0x1d1a18, [Math.PI / 2, 0, 0], { metalness: 0.36 });
      this.sphere(rig, entity, "rifle", 0.06, [0.47, 0.92, 0.96], 0xffb02e, { accent: true, emissive: 0xff6b1a, emissiveIntensity: 0.38 });
      this.box(rig, entity, "rifle", [0.1, 0.1, 0.34], [0.47, 1.04, 0.4], 0x5a2f10, { accent: true });
      this.box(rig, entity, "body", [0.34, 0.16, 0.4], [-0.36, 1.08, 0.02], 0xffb02e, { accent: true, emissive: 0xff7d26, emissiveIntensity: 0.2 });
      this.box(rig, entity, "pack", [0.56, 0.7, 0.3], [0, 0.86, -0.42], 0xd84a14, { accent: true, emissive: 0xff5a1a, emissiveIntensity: 0.3, metalness: 0.3, kit: "pack-flamer" });
      // The fuel HOSE arcs from the tanks over the right shoulder toward the projector — a pack
      // part, so a shot-out pack drags the hose down with it.
      this.box(rig, entity, "pack", [0.36, 0.56, 0.5], [0.34, 1.0, -0.14], 0x2a2422, { accent: true, metalness: 0.2, kit: "hose-flamer" });
      this.box(rig, entity, "head", [0.44, 0.46, 0.48], [0, 1.36, 0.0], helmetColor, { metalness: 0.2, kit: "helmet-flamer" });
    } else if (entity.kind === "droneop") {
      // Drone operator: a signal wand, a control slate on the chest, and the recon drone
      // itself hovering overhead with a spinning-ring rotor and a scanning eye.
      this.box(rig, entity, "rifle", [0.3, 0.3, 0.72], [0.46, 0.92, 0.22], 0x3a4450, { metalness: 0.3, kit: "weapon-wand" });
      this.box(rig, entity, "body", [0.3, 0.22, 0.06], [0, 0.96, 0.23], 0x0e1a26, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.23 });
      this.box(rig, entity, "head", [0.46, 0.4, 0.46], [0, 1.4, 0.0], helmetColor, { kit: "helmet-droneop" });
      this.box(rig, entity, "head", [0.144, 0.08, 0.173], [0.16, 1.48, 0.14], 0x9fdcff, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.29 });
      // The relay pack on the back (dish + whip mast) replaces the generic rucksack...
      this.box(rig, entity, "pack", [0.36, 0.62, 0.22], [0, 1.0, -0.34], 0x35485c, { accent: true, metalness: 0.3, kit: "antenna-droneop" });
      // ...and the drone (pack part, so shooting the pack downs the optics — cause and effect).
      this.box(rig, entity, "pack", [0.6, 0.16, 0.6], [0, 2.25, -0.1], 0x35485c, { accent: true, metalness: 0.3, kit: "pack-drone" });
      this.cylinder(rig, entity, "pack", 0.26, 0.05, [0, 2.33, -0.1], 0x9fdcff, [0, 0, 0], { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.21 });
      this.sphere(rig, entity, "pack", 0.07, [0, 2.18, 0.08], 0xff5a4d, { accent: true, emissive: 0xff3b30, emissiveIntensity: 0.36 });
    } else if (entity.kind === "jumper") {
      // Jump trooper: the silhouette is the JET PACK -- two fat thruster bells angled out behind
      // the shoulders with glowing nozzles, a stub carbine, knee guards and a full visor. From
      // above the twin bells read even when the body does not.
      // Its own gun: a short FAT suppressed bullpup (the scout's carbine is short and thin).
      this.box(rig, entity, "rifle", [0.22, 0.3, 0.74], [0.46, 0.92, 0.26], 0x2f333a, { metalness: 0.34, kit: "weapon-smg" });
      this.box(rig, entity, "rifle", [0.06, 0.1, 0.16], [0.46, 1.04, 0.2], 0x9fdcff, { accent: true, emissive: 0x6fd7ff, emissiveIntensity: 0.2 });
      for (const side of [-1, 1]) {
        this.cylinder(rig, entity, "pack", 0.1, 0.05, [side * 0.3, 0.6, -0.5], 0xffc266, [0.35, 0, side * -0.28], { accent: true, emissive: 0xff8a2a, emissiveIntensity: 0.5 });
      }
      // Flight harness in the torso, control gauntlet on the arms, stabiliser fins on the legs
      // (kit variants); an altimeter on the chest plate is the accent.
      this.box(rig, entity, "body", [0.14, 0.14, 0.06], [0.14, 1.0, 0.26], 0xffb14a, { accent: true, emissive: 0xff7d1e, emissiveIntensity: 0.24 });
      this.box(rig, entity, "pack", [0.62, 0.66, 0.34], [0, 0.94, -0.4], 0x2b3036, { metalness: 0.4, kit: "pack-jumper" });
      this.box(rig, entity, "head", [0.42, 0.44, 0.5], [0, 1.42, 0.0], helmetColor, { metalness: 0.3, kit: "helmet-jumper" });
      this.box(rig, entity, "head", [0.3, 0.09, 0.09], [0, 1.44, 0.16], 0xffb14a, { accent: true, emissive: 0xff7d1e, emissiveIntensity: 0.4 });
    } else if (entity.kind === "sapper") {
      // Combat sapper: stubby demolition launcher with a fat drum, mine discs clipped to
      // the belt, blast apron, and a heavy face shield — the wall-breaker.
      this.box(rig, entity, "rifle", [0.26, 0.36, 0.84], [0.47, 0.92, 0.26], 0x4a4232, { metalness: 0.3, kit: "weapon-shotgun" });
      this.cylinder(rig, entity, "rifle", 0.14, 0.2, [0.47, 0.8, 0.2], 0x2a2620, [0, 0, Math.PI / 2], { accent: true, metalness: 0.3 });
      this.box(rig, entity, "rifle", [0.14, 0.14, 0.16], [0.47, 0.92, 0.62], 0xffca6b, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.17 });
      // Sapper: a mine-detector paddle swept out and down on a long pole. The one unit in the
      // roster with a wide flat disc low in its outline.
      this.cylinder(rig, entity, "pack", 0.045, 1.15, [-0.5, 0.72, 0.16], 0x6a6250, [0.5, 0, 0.62], { accent: true, metalness: 0.34 });
      this.cylinder(rig, entity, "pack", 0.3, 0.05, [-0.92, 0.2, 0.44], 0x8a7a3a, [Math.PI / 2.1, 0, 0.1], { accent: true, metalness: 0.3 });
      this.cylinder(rig, entity, "pack", 0.1, 0.06, [-0.92, 0.26, 0.44], 0xffca6b, [Math.PI / 2.1, 0, 0.1], { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.26 });
      // Bandolier of charges + blast apron are authored into torso-sapper. A detonator box on the
      // belt, a stack of mine discs on the back (replaces the generic rucksack), and a lit charge
      // on the bandolier at chest height as the accent.
      this.box(rig, entity, "legs", [0.2, 0.24, 0.18], [0.3, 0.52, 0.12], 0x4a4232, { accent: true, metalness: 0.3, kit: "detonator-sapper" });
      this.box(rig, entity, "pack", [0.5, 0.5, 0.22], [0, 0.92, -0.36], 0x5a5038, { accent: true, metalness: 0.3, kit: "mines-sapper" });
      this.box(rig, entity, "body", [0.12, 0.1, 0.08], [0.06, 1.0, 0.26], 0xffca6b, { accent: true, emissive: 0xff9e2b, emissiveIntensity: 0.24 });
      this.box(rig, entity, "head", [0.346, 0.26, 0.072], [0, 1.34, 0.2], 0x3a342a, { accent: true, metalness: 0.24 });
      this.box(rig, entity, "head", [0.44, 0.42, 0.46], [0, 1.38, 0.0], helmetColor, { kit: "helmet-sapper" });
    } else {
      // Line infantry (soldier): standard bayoneted rifle, a brimmed helmet with a comms
      // bead, chest webbing/pouches and a slung frag — the plain baseline trooper.
      // A rifle, not a plank: receiver, a slimmer barrel with a muzzle device, a magazine
      // hanging below, a stock behind the grip and a low optic on top. This is the shape the
      // player sees on the most common unit in the game, so it earns the extra meshes.
      this.box(rig, entity, "rifle", [0.14, 0.2, 0.86], [0.45, 0.93, 0.26], trimColor, { metalness: 0.34, bevel: 0.22, kit: "rifle" });
      this.cylinder(rig, entity, "rifle", 0.032, 0.46, [0.45, 0.95, 0.63], 0x1d2529, [Math.PI / 2, 0, 0], { metalness: 0.44 });
      this.box(rig, entity, "rifle", [0.07, 0.07, 0.11], [0.45, 0.95, 0.88], 0x11181b, { metalness: 0.5, bevel: 0.3 });
      this.box(rig, entity, "rifle", [0.075, 0.19, 0.11], [0.45, 0.81, 0.16], 0x232c31, { metalness: 0.3, bevel: 0.26 });
      this.box(rig, entity, "rifle", [0.09, 0.12, 0.26], [0.45, 0.9, -0.13], 0x2b343a, { metalness: 0.26, bevel: 0.28 });
      this.box(rig, entity, "rifle", [0.05, 0.06, 0.16], [0.45, 1.03, 0.16], 0x11181b, { metalness: 0.42, bevel: 0.3 });
      this.box(rig, entity, "rifle", [0.05, 0.05, 0.16], [0.45, 0.96, 0.98], 0xcfe2e4, { accent: true, metalness: 0.5 });
      this.box(rig, entity, "body", [0.5, 0.12, 0.06], [0, 0.94, 0.2], 0x2c3a30, { accent: true });
      for (const x of [-0.16, 0.16]) this.box(rig, entity, "body", [0.14, 0.18, 0.1], [x, 0.74, 0.2], 0x35463a, { accent: true });
      this.box(rig, entity, "body", [0.12, 0.16, 0.12], [-0.3, 0.66, 0.12], 0x3f5036, { accent: true });
      // Rank chevron on the chest webbing: the baseline trooper's one saturated mark.
      this.box(rig, entity, "body", [0.18, 0.08, 0.05], [0, 1.03, 0.25], 0x8df0ff, { accent: true, emissive: 0x5ff1ff, emissiveIntensity: 0.2 });
      this.box(rig, entity, "head", [0.42, 0.34, 0.44], [0, 1.42, 0.0], helmetColor, { metalness: 0.14, kit: "helmet" });
      this.box(rig, entity, "head", [0.346, 0.07, 0.115], [0, 1.39, 0.22], 0x141819, { accent: true });
      this.box(rig, entity, "head", [0.065, 0.08, 0.05], [0.2, 1.46, 0.1], 0x8df0ff, { accent: true, emissive: 0x5ff1ff, emissiveIntensity: 0.29 });
    }
    // The generic rucksack — unless the kind's authored back piece (ammo box, bipod, relay,
    // mine stack) already fills that slot.
    if (kitParts.rucksack) this.box(rig, entity, "pack", [0.38, 0.44, 0.2], [0, 0.84, -0.3], packColor, entity.kind === "grenadier" ? { emissive: 0xff7d26, emissiveIntensity: 0.26, kit: "pack" } : { kit: "pack" });
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
      const arm = side < 0 ? kitParts.armL : kitParts.armR;
      this.box(rig, entity, "body", kitParts.armSize, [side * 0.43, 0.68, 0.03], bodyColor, { metalness: 0.18, kit: arm }).userData.limb = tag;
    }
    // Legs: TWO segments per side -- the authored leg mesh split at the knee at load (legSplit.ts),
    // thigh and shin each a separate part mesh so the walk cycle can break the knee (a one-piece
    // pendulum leg is the amateur tell the owner called out). Both halves keep the whole leg's
    // base transform (the split preserves unit-cube coordinates), and the gait code moves each
    // about its own pivot: the thigh from the hip, the shin from the knee, the boot from the ankle.
    // Without the kit the fallback is two boxes at the same pivots.
    const legGeo = kitGeometry(kitParts.leg);
    const halves = legGeo ? splitAtKnee(legGeo, LEG_KNEE_CUT, LEG_KNEE_OVERLAP) : undefined;
    for (const side of [-1, 1]) {
      const tag = side < 0 ? "leg-l" : "leg-r";
      const x = side * 0.18;
      const [w, , d] = kitParts.legSize;
      const thigh = halves
        ? this.box(rig, entity, "legs", kitParts.legSize, [x, 0.36, 0.02], 0x162225, { metalness: 0.2, outline: true, geometry: halves.upper })
        : this.box(rig, entity, "legs", [w, HIP_Y - KNEE_Y + 0.05, d], [x, (HIP_Y + KNEE_Y) / 2, 0.02], 0x162225, { metalness: 0.2, outline: true });
      thigh.userData.limb = tag;
      thigh.userData.segment = "thigh";
      const shin = halves
        ? this.box(rig, entity, "legs", kitParts.legSize, [x, 0.36, 0.02], 0x162225, { metalness: 0.2, outline: true, geometry: halves.lower })
        : this.box(rig, entity, "legs", [w * 0.88, KNEE_Y - ANKLE_Y + 0.03, d * 0.88], [x, (KNEE_Y + ANKLE_Y) / 2, 0.02], 0x162225, { metalness: 0.2, outline: true });
      shin.userData.limb = tag;
      shin.userData.segment = "shin";
      const boot = this.box(rig, entity, "legs", [0.22, 0.14, 0.32], [x, 0.07, 0.06], 0x101516, { metalness: 0.14, kit: "boot" });
      boot.userData.limb = tag;
      boot.userData.segment = "foot";
    }
    this.factionInfantryDress(rig, entity);
    if (build.girth !== 1) {
      const undo = 1 / build.girth;
      rig.traverse((o) => {
        const m = o as PartMesh;
        if (!m.isMesh || (m.userData.partId !== "rifle" && m.userData.partId !== "pack")) return;
        m.scale.x *= undo;
        m.scale.z *= undo;
        (m.userData.baseScale as THREE.Vector3).copy(m.scale);
      });
    }
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
    if (entity.kind === "exturret" && vehiclesKitReady()) {
      // The mortar battery shares the gun turret's authored plinth and sandbag berm (one
      // emplacement language), and keeps its own procedural twin tubes + shell rack on top.
      this.buildTurretMountKit(group, entity);
      this.buildMortarBattery(group, entity);
      return;
    }
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
      this.buildMortarBattery(group, entity);
    } else {
      this.buildAutoCannon(group, entity, glow);
    }
  }

  // Twin mortar tubes on a braced cradle, fed from a rack of shells behind.
  private buildMortarBattery(group: THREE.Group, entity: CombatEntity): void {
    {
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
    }
  }

  // Single auto-cannon: gun housing, a slimmer barrel with a brake, a belt box and a sensor head
  // (the procedural gun turret; the kit version is buildTurretKit).
  private buildAutoCannon(group: THREE.Group, entity: CombatEntity, glow: number): void {
    {
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
    // Landmarks first: a wrecked truck is volatile (it burns), and the fuel-drum branch below would
    // otherwise claim it.
    if (isLandmarkKind(entity.coverKind)) {
      this.buildLandmark(group, entity);
    } else if (entity.coverKind === "ammo") {
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
    } else if (entity.coverKind === "gas") {
      // Gas canister: a tall pressure bottle in a wire cage with a valve wheel and a pale
      // sickly-green band, so it reads as "chemical" next to the warm fuel drum.
      this.box(group, entity, part.id, [0.7, 0.08, 0.7], [0, 0.04, 0], 0x3b3a33, { bevel: 0.2 });
      this.cylinder(group, entity, part.id, 0.27, 1.0, [0, 0.58, 0], 0x8a9a7a, [0, 0, 0], { metalness: 0.4 });
      this.sphere(group, entity, part.id, 0.27, [0, 1.08, 0], 0x8a9a7a, { metalness: 0.4 });
      this.cylinder(group, entity, part.id, 0.285, 0.14, [0, 0.62, 0], 0xb9ea5a, [0, 0, 0], { accent: true, emissive: 0x7fbf2a, emissiveIntensity: 0.22 });
      this.cylinder(group, entity, part.id, 0.07, 0.18, [0, 1.4, 0], 0x2b3238, [0, 0, 0], { metalness: 0.5 });
      this.cylinder(group, entity, part.id, 0.13, 0.04, [0, 1.5, 0], 0xb03a2a, [0, 0, 0], { metalness: 0.4 });
      for (const a of [0, 1, 2, 3]) {
        this.box(group, entity, part.id, [0.04, 1.1, 0.04], [Math.cos(a * Math.PI / 2) * 0.33, 0.6, Math.sin(a * Math.PI / 2) * 0.33], 0x2b3238, { metalness: 0.45 });
      }
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
    } else if (entity.coverKind && BIOME_PROPS.has(entity.coverKind)) {
      // Before the fuel drum: the brazier is volatile too.
      this.buildBiomeProp(group, entity);
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
    } else if (entity.coverKind === "barricade" && vehicleGeometry("barricade")) {
      this.vpart(group, entity, part.id, "barricade", 0x9b7045, { roughness: 0.9, rotation: [0, ((hash(entity.id) % 5) - 2) * 0.08, 0] });
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
    } else if (entity.coverKind === "rock" && propGeometry("rock", hash(entity.id))) {
      // Authored boulder from the props kit (one of four seeded facet variants), scaled to the
      // entity's own radius/height so signature rocks keep their authored size. Sunk a few cm so
      // it never stands on a rounded belly over a talus flare.
      const v = hash(entity.id);
      const s = entity.radius / 1.0;
      this.box(group, entity, part.id, [2.0 * s, entity.height, 1.7 * s], [0, entity.height / 2 - 0.08, 0], 0x7d776c,
        { geometry: propGeometry("rock", v), roughness: 0.98, rotation: [0, (v % 16) * 0.39, 0] });
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
    } else if (entity.coverKind === "stump" && propGeometry("stump", hash(entity.id))) {
      const v = hash(entity.id);
      this.box(group, entity, part.id, [1.3, 0.7, 1.3], [0, 0.33, 0], 0x5a3f2a, { geometry: propGeometry("stump", v), roughness: 0.96, rotation: [0, (v % 9) * 0.7, 0] });
      // The pale cut face is the read from above.
      this.cylinder(group, entity, part.id, 0.34, 0.04, [0, 0.7, 0], 0xb8a07a, [0, 0, 0], { roughness: 0.9 });
      this.cylinder(group, entity, part.id, 0.2, 0.03, [0, 0.725, 0], 0x8d7454, [0, 0, 0], { roughness: 0.9 });
    } else if (entity.coverKind === "stump") {
      // A cut trunk with a pale ring on top, bark ridges and two exposed roots.
      const v = hash(entity.id);
      this.cylinder(group, entity, part.id, 0.42, 0.62, [0, 0.31, 0], 0x4a3220, [0, (v % 7) * 0.4, 0], { radiusBottom: 0.5, roughness: 0.96 });
      this.cylinder(group, entity, part.id, 0.36, 0.05, [0, 0.64, 0], 0xb8a07a, [0, 0, 0], { roughness: 0.9 });
      this.cylinder(group, entity, part.id, 0.22, 0.04, [0, 0.67, 0], 0x8d7454, [0, 0, 0], { roughness: 0.9 });
      for (const a of [0.4, 2.1, 3.9]) this.box(group, entity, part.id, [0.18, 0.16, 0.5], [Math.cos(a) * 0.5, 0.08, Math.sin(a) * 0.5], 0x3d2a1a, { rotation: [0, -a, 0], bevel: 0.3, roughness: 0.98 });
    } else if (entity.coverKind === "log" && propGeometry("log", hash(entity.id))) {
      const v = hash(entity.id);
      const yaw = (v % 13) * 0.24;
      this.box(group, entity, part.id, [2.6, 0.6, 0.9], [0, 0.27, 0], 0x4f3622, { geometry: propGeometry("log", v), roughness: 0.96, rotation: [0, yaw, 0] });
      this.box(group, entity, part.id, [0.5, 0.1, 0.4], [-Math.cos(yaw) * 0.5, 0.05, Math.sin(yaw) * 0.5], 0x3f5a2c, { bevel: 0.4, roughness: 1 }); // moss
    } else if (entity.coverKind === "log") {
      // A fallen trunk lying across the ground: long, slightly tapered, one broken bough up.
      const v = hash(entity.id);
      const yaw = (v % 13) * 0.24;
      this.cylinder(group, entity, part.id, 0.3, 2.5, [0, 0.3, 0], 0x4f3622, [0, yaw, Math.PI / 2], { radiusBottom: 0.36, roughness: 0.96 });
      this.cylinder(group, entity, part.id, 0.28, 0.06, [Math.cos(yaw) * 1.26, 0.3, -Math.sin(yaw) * 1.26], 0xb39a76, [0, yaw, Math.PI / 2], { roughness: 0.9 });
      this.cylinder(group, entity, part.id, 0.08, 0.5, [Math.cos(yaw) * 0.3, 0.6, -Math.sin(yaw) * 0.3], 0x4f3622, [0.5, yaw, 0.3], { roughness: 0.96 });
      this.box(group, entity, part.id, [0.5, 0.12, 0.4], [-Math.cos(yaw) * 0.6, 0.06, Math.sin(yaw) * 0.6], 0x3f5a2c, { bevel: 0.4, roughness: 1 }); // moss
    } else if (entity.coverKind === "bush" && propGeometry("bush", hash(entity.id))) {
      const v = hash(entity.id);
      const greens = [0x3f7a34, 0x4d8a3a, 0x5e9a44, 0x447f38];
      this.box(group, entity, part.id, [1.6, 0.9, 1.6], [0, 0.44, 0], greens[v % 4], { geometry: propGeometry("bush", v), roughness: 0.95, rotation: [0, (v % 11) * 0.57, 0], emissive: 0x0f2c0e, emissiveIntensity: 0.06 });
      for (let i = 0; i < 3; i += 1) this.sphere(group, entity, part.id, 0.05, [Math.cos(i * 2.2 + v) * 0.42, 0.66, Math.sin(i * 2.2 + v) * 0.42], 0xd94a3a, { accent: true });
    } else if (entity.coverKind === "bush") {
      // A low round shrub: four overlapping green masses, a darker one underneath, a few berries.
      const v = hash(entity.id);
      const greens = [0x3f7a34, 0x4d8a3a, 0x5e9a44, 0x2f5f27];
      for (let i = 0; i < 4; i += 1) {
        const a = ((v >> (i * 3)) % 9) / 9 * Math.PI * 2;
        this.sphere(group, entity, part.id, 0.36 + ((v >> i) % 3) * 0.05, [Math.cos(a) * 0.32, 0.36 + (i % 2) * 0.12, Math.sin(a) * 0.32], greens[i], { scaleY: 0.8 });
      }
      this.sphere(group, entity, part.id, 0.44, [0, 0.28, 0], greens[3], { scaleY: 0.6 });
      for (let i = 0; i < 3; i += 1) this.sphere(group, entity, part.id, 0.05, [Math.cos(i * 2.2) * 0.4, 0.62, Math.sin(i * 2.2) * 0.4], 0xd94a3a, { accent: true });
    } else if (entity.coverKind === "cactus" && propGeometry("cactus", hash(entity.id))) {
      const v = hash(entity.id);
      this.box(group, entity, part.id, [1.0, 2.0, 1.0], [0, 1.0, 0], 0x4f7f3a, { geometry: propGeometry("cactus", v), roughness: 0.94, rotation: [0, (v % 7) * 0.9, 0] });
      this.sphere(group, entity, part.id, 0.1, [0, 2.02, 0], 0xf2dfa0, { accent: true });
    } else if (entity.coverKind === "cactus") {
      // A saguaro: ribbed column, two arms, and a pale flower on top.
      const v = hash(entity.id);
      this.cylinder(group, entity, part.id, 0.24, 1.9, [0, 0.95, 0], 0x4f7f3a, [0, 0, 0], { radiusBottom: 0.28, roughness: 0.94 });
      for (const side of [-1, 1]) {
        if (((v >> (side + 2)) % 3) === 0) continue;
        this.cylinder(group, entity, part.id, 0.14, 0.5, [side * 0.42, 1.0, 0], 0x4f7f3a, [0, 0, side * Math.PI / 2], { roughness: 0.94 });
        this.cylinder(group, entity, part.id, 0.14, 0.7, [side * 0.56, 1.42, 0], 0x4f7f3a, [0, 0, 0], { roughness: 0.94 });
      }
      this.sphere(group, entity, part.id, 0.1, [0, 1.94, 0], 0xf2dfa0, { accent: true });
    } else if (entity.coverKind === "tent") {
      // A ridge tent: two canted canvas panels on a pole, guy pegs, a dark open flap.
      this.box(group, entity, part.id, [2.0, 0.06, 1.3], [0, 0.72, 0.62], 0xb39a6a, { rotation: [-0.85, 0, 0], roughness: 0.96 });
      this.box(group, entity, part.id, [2.0, 0.06, 1.3], [0, 0.72, -0.62], 0xa8905f, { rotation: [0.85, 0, 0], roughness: 0.96 });
      this.cylinder(group, entity, part.id, 0.04, 2.1, [0, 1.2, 0], 0x5a4630, [0, 0, Math.PI / 2], { roughness: 0.9 });
      this.box(group, entity, part.id, [0.5, 0.7, 0.06], [0.98, 0.36, 0], 0x2b2218, { rotation: [0, 0, 0] });
      for (const x of [-1.2, 1.2]) for (const z of [-1.0, 1.0]) this.cylinder(group, entity, part.id, 0.03, 0.3, [x, 0.12, z], 0x3a2e20, [0, 0, 0], {});
    } else if (entity.coverKind === "pipe") {
      // An industrial pipe run on trestles with a valve wheel and a flanged joint.
      const v = hash(entity.id);
      const yaw = (v % 5) * 0.31;
      this.cylinder(group, entity, part.id, 0.28, 2.8, [0, 0.62, 0], 0x5a5f66, [0, yaw, Math.PI / 2], { metalness: 0.5, roughness: 0.55 });
      for (const t of [-0.9, 0.9]) {
        this.cylinder(group, entity, part.id, 0.34, 0.14, [Math.cos(yaw) * t, 0.62, -Math.sin(yaw) * t], 0x3d4248, [0, yaw, Math.PI / 2], { metalness: 0.5, roughness: 0.5 });
        this.box(group, entity, part.id, [0.16, 0.5, 0.5], [Math.cos(yaw) * t, 0.25, -Math.sin(yaw) * t], 0x2f3439, { rotation: [0, yaw, 0], metalness: 0.4 });
      }
      this.cylinder(group, entity, part.id, 0.18, 0.05, [0, 1.0, 0], 0xb03a2a, [0, 0, 0], { metalness: 0.4 });
      this.cylinder(group, entity, part.id, 0.04, 0.2, [0, 0.9, 0], 0x8a8f96, [0, 0, 0], { metalness: 0.5 });
    } else if (entity.coverKind === "silo") {
      // A storage silo: a tall riveted drum on legs with a conical lid and a ladder.
      this.cylinder(group, entity, part.id, 0.82, 1.9, [0, 1.35, 0], 0x6c7178, [0, 0, 0], { metalness: 0.45, roughness: 0.6 });
      this.cylinder(group, entity, part.id, 0.86, 0.1, [0, 1.0, 0], 0x3f444a, [0, 0, 0], { metalness: 0.5 });
      this.cylinder(group, entity, part.id, 0.86, 0.1, [0, 1.95, 0], 0x3f444a, [0, 0, 0], { metalness: 0.5 });
      this.cylinder(group, entity, part.id, 0.1, 0.5, [0, 2.55, 0], 0x8a8f96, [0, 0, 0], { radiusBottom: 0.88, metalness: 0.45 });
      for (const a of [0.6, 2.7, 4.8]) this.box(group, entity, part.id, [0.14, 0.5, 0.14], [Math.cos(a) * 0.62, 0.25, Math.sin(a) * 0.62], 0x2f3439, { metalness: 0.4 });
      this.box(group, entity, part.id, [0.06, 1.8, 0.3], [0.86, 1.3, 0], 0x9aa0a6, { metalness: 0.5 });
      this.box(group, entity, part.id, [0.3, 0.2, 0.06], [0, 1.5, 0.84], 0xd8b43a, { accent: true, emissive: 0x8a6a10, emissiveIntensity: 0.15 });
    } else if (entity.coverKind === "statue" && propGeometry("statue", hash(entity.id))) {
      const v = hash(entity.id);
      this.box(group, entity, part.id, [1.9, 2.4, 1.9], [0, 1.2, 0], 0x9a948a, { geometry: propGeometry("statue", v), roughness: 0.92, rotation: [0, (v % 8) * 0.78, 0] });
    } else if (entity.coverKind === "statue") {
      // A broken monument: a plinth, a robed figure snapped off at the shoulder, one arm raised.
      const v = hash(entity.id);
      this.box(group, entity, part.id, [1.2, 0.5, 1.2], [0, 0.25, 0], 0x8a8478, { bevel: 0.2, roughness: 0.9 });
      this.box(group, entity, part.id, [0.9, 0.16, 0.9], [0, 0.58, 0], 0x9c968a, { bevel: 0.3, roughness: 0.9 });
      this.cylinder(group, entity, part.id, 0.3, 1.2, [0, 1.26, 0], 0x9a948a, [0, (v % 6) * 0.5, 0], { radiusBottom: 0.42, roughness: 0.92 });
      this.box(group, entity, part.id, [0.66, 0.34, 0.5], [0, 1.95, 0], 0x9a948a, { bevel: 0.3, rotation: [0.1, (v % 6) * 0.5, -0.08], roughness: 0.92 });
      this.cylinder(group, entity, part.id, 0.1, 0.7, [0.36, 2.2, 0.1], 0x9a948a, [0.3, 0, -0.9], { roughness: 0.92 });
      this.box(group, entity, part.id, [0.3, 0.26, 0.3], [-0.26, 2.16, 0.02], 0x8f8980, { bevel: 0.36, rotation: [0.3, 0.6, 0.5], roughness: 0.94 }); // the broken shoulder
      this.box(group, entity, part.id, [0.5, 0.3, 0.44], [0.7, 0.15, 0.55], 0x8a8478, { bevel: 0.3, rotation: [0.2, 0.7, 0.1], roughness: 0.92 }); // a fallen head at the foot
    } else if (entity.coverKind === "tree" && propGeometry("trunk", hash(entity.id)) && propGeometry("canopy", hash(entity.id))) {
      // Authored trunk + canopy variants; the group-level sway is unchanged.
      const v = hash(entity.id);
      const greens = [0x35722f, 0x437f36, 0x59963f];
      const spin = (v % 13) * 0.48;
      this.box(group, entity, part.id, [0.7, 1.75, 0.7], [0, 0.87, 0], 0x4a3220, { geometry: propGeometry("trunk", v), roughness: 0.95, rotation: [0, spin, 0] });
      this.box(group, entity, part.id, [2.3, 1.7, 2.3], [0, 2.05, 0], greens[v % 3], { geometry: propGeometry("canopy", v >> 3), roughness: 0.94, rotation: [0, spin + 1.1, 0], emissive: 0x0f2c0e, emissiveIntensity: 0.08 });
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
    } else if (entity.coverKind === "crate" && vehicleGeometry("crates")) {
      this.vpart(group, entity, part.id, "crates", 0x9a6a3a, { roughness: 0.9, rotation: [0, (hash(entity.id) % 4) * (Math.PI / 2) + 0.1, 0] });
    } else if (entity.coverKind === "sandbag" && vehicleGeometry("sandbags")) {
      this.vpart(group, entity, part.id, "sandbags", 0xb8a86a, { roughness: 0.95, metalness: 0.02 });
    } else if (entity.coverKind === "crate") {
      this.box(group, entity, part.id, [0.92, 0.7, 0.92], [0, 0.35, 0], 0x9a6a3a);
      this.box(group, entity, part.id, [0.72, 0.55, 0.72], [0.1, 0.96, -0.06], 0xb07c45);
      this.box(group, entity, part.id, [0.94, 0.07, 0.07], [0, 0.55, 0], 0x4a2f18);
      this.box(group, entity, part.id, [0.07, 0.07, 0.94], [0, 0.55, 0], 0x4a2f18);
    } else if (entity.coverKind === "sandbag") {
      for (const [x, y] of [[-0.46, 0.18], [0.46, 0.18], [0, 0.18], [-0.24, 0.5], [0.24, 0.5]] as const) {
        this.box(group, entity, part.id, [0.5, 0.34, 0.72], [x, y, 0], 0xb8a86a, { metalness: 0.02 });
      }
    } else if (entity.coverKind === "rubble" && propGeometry("rubble", hash(entity.id))) {
      const v = hash(entity.id);
      this.box(group, entity, part.id, [2.1, 0.9, 1.8], [0, 0.42, 0], 0x7c756a, { geometry: propGeometry("rubble", v), roughness: 0.96, rotation: [0, (v % 10) * 0.63, 0] });
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
    } else if (entity.coverKind === "span") {
      // A BRIDGE SPAN is the destructible middle of a crossing: it reads as part of the deck —
      // plank runs, two rail posts a side and a low rail — never as a crate parked on the bridge.
      // Oriented along the crossing (the bridge rect's long axis) via the bridge under it.
      const bridge = terrainBridges().find((b) => entity.position.x >= b.minX - 0.5 && entity.position.x <= b.maxX + 0.5 && entity.position.z >= b.minZ - 0.5 && entity.position.z <= b.maxZ + 0.5);
      const along = bridge ? (bridge.maxX - bridge.minX >= bridge.maxZ - bridge.minZ ? 0 : Math.PI / 2) : 0;
      const w = bridge ? Math.min(bridge.maxX - bridge.minX, bridge.maxZ - bridge.minZ) : 2.4;
      // Local frame: +x runs ALONG the crossing; `along` turns it for a z-long bridge.
      const at = (ax: number, az: number): [number, number, number] => [Math.cos(along) * ax + Math.sin(along) * az, 0, -Math.sin(along) * ax + Math.cos(along) * az];
      for (const t of [-0.7, 0, 0.7]) {
        const [px, , pz] = at(0, t * (w / 2.4));
        this.box(group, entity, part.id, [1.9, 0.06, 0.42], [px, 0.2, pz], 0x6a4a2c, { rotation: [0, along, 0] });
      }
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.12);
        for (const t of [-0.85, 0.85]) {
          const [px, , pz] = at(t, off);
          this.box(group, entity, part.id, [0.12, 0.5, 0.12], [px, 0.42, pz], 0x4f3620, { rotation: [0, along, 0] });
        }
        const [rx, , rz] = at(0, off);
        this.box(group, entity, part.id, [1.9, 0.08, 0.1], [rx, 0.66, rz], 0x7c5a36, { rotation: [0, along, 0] });
      }
    } else {
      // WALL BLOCK: a precast concrete blast wall (T-wall) on its foot — the harbour mole and the
      // foundry both pour them. It used to be a tan plank box with two glowing strips, which read as
      // a crate and belonged to no map at all.
      this.box(group, entity, part.id, [2.0, 0.3, 1.0], [0, 0.15, 0], 0x6f6c65, { bevel: 0.2, roughness: 0.95 });
      this.box(group, entity, part.id, [1.9, 1.3, 0.36], [0, 0.95, 0], 0x86827a, { bevel: 0.12, roughness: 0.95 });
      this.box(group, entity, part.id, [1.94, 0.12, 0.42], [0, 1.55, 0], 0x77736b, { bevel: 0.3, roughness: 0.95 });
      // One painted hazard band and the two lifting eyes: the small accents, not the slab.
      this.box(group, entity, part.id, [1.92, 0.12, 0.38], [0, 0.5, 0], 0xc89a3a, { bevel: 0.3, roughness: 0.9 });
      for (const x of [-0.6, 0.6]) this.box(group, entity, part.id, [0.12, 0.12, 0.08], [x, 1.66, 0], 0x2f3236, { bevel: 0.3, metalness: 0.4 });
    }
    const stone = entity.coverKind === "rock" || entity.coverKind === "rubble" || entity.coverKind === "statue"
      || entity.coverKind === "chapel" || entity.coverKind === "colossus" || entity.coverKind === "cistern"
      || entity.coverKind === "grave" || entity.coverKind === "obelisk";
    // A steel landmark keeps its own colour: at the prop tint the furnace and the hull went the
    // colour of the slag and the ice they stand on.
    const steel = isLandmarkKind(entity.coverKind) && !stone;
    // Light touch: this tint was a silent no-op for months (it tested for MeshStandardMaterial after
    // the parts went toon) and the prop palette was tuned without it; at 0.7 every trunk and log went
    // the ground colour. Stone leans further into the map (a rock is OF the ground); wood, foliage
    // and hardware keep most of their own hue and only pick up the map's cast.
    this.tintPropToMap(group, stone ? 0.5 : steel ? 0.12 : 0.3, stone ? this.rockTint : this.propTint);
  }

  /**
   * BIOME PROPS (2026-09-23): the furniture that says which map this is — a foundry's steel, a
   * farm's hay and fences, an ice harbour's boats and racks, a temple's obelisks, jars and braziers,
   * a border's tank traps and watchtower, a desert carcass. Box-built in the same flat toon parts
   * as the tent, pipe and silo (every mesh a pooled part, so per-part damage and paint never know),
   * and each built round ONE read from the tactical camera: the silhouette, then a single small
   * accent. The group is spun per entity in syncEntity, so none of these picks its own yaw.
   */
  private buildBiomeProp(group: THREE.Group, entity: CombatEntity): void {
    const id = entity.parts[0].id;
    const v = hash(entity.id);
    switch (entity.coverKind) {
      case "girder": {
        // A rusted I-beam gantry leg on its base plate, a torn-off brace stub, a hazard-striped foot.
        this.box(group, entity, id, [1.0, 0.12, 1.0], [0, 0.06, 0], 0x3a3a3c, { metalness: 0.4, bevel: 0.25 });
        for (const z of [-0.2, 0.2]) this.box(group, entity, id, [0.52, 2.4, 0.1], [0, 1.3, z], 0x7a4a34, { metalness: 0.4, bevel: 0.3 });
        this.box(group, entity, id, [0.1, 2.4, 0.32], [0, 1.3, 0], 0x6a4030, { metalness: 0.4, bevel: 0.3 });
        this.box(group, entity, id, [0.64, 0.1, 0.56], [0, 2.54, 0], 0x4a4a4e, { metalness: 0.45, bevel: 0.3 });
        this.box(group, entity, id, [0.12, 1.0, 0.12], [0.36, 2.0, 0], 0x6a4030, { metalness: 0.4, rotation: [0, 0, -0.62] });
        this.box(group, entity, id, [0.56, 0.16, 0.46], [0, 0.34, 0], 0xd8a53a, { accent: true, bevel: 0.3 });
        break;
      }
      case "coil": {
        // A coil of strip steel on its side in a timber cradle, strapped, the dark eye showing.
        for (const x of [-0.42, 0.42]) this.box(group, entity, id, [0.22, 0.24, 1.2], [x, 0.12, 0], 0x5a4630, { bevel: 0.25, roughness: 0.95 });
        this.cylinder(group, entity, id, 0.52, 0.96, [0, 0.62, 0], 0x8a9096, [Math.PI / 2, 0, 0], { metalness: 0.5, roughness: 0.5 });
        this.cylinder(group, entity, id, 0.2, 0.98, [0, 0.62, 0], 0x23272b, [Math.PI / 2, 0, 0], { metalness: 0.3 });
        for (const z of [-0.26, 0.26]) this.cylinder(group, entity, id, 0.535, 0.06, [0, 0.62, z], 0x3d4248, [Math.PI / 2, 0, 0], { metalness: 0.5 });
        break;
      }
      case "ingot": {
        // Square steel billets stacked crosswise, three courses, the top bar still glowing from the mill.
        for (const z of [-0.38, 0, 0.38]) this.box(group, entity, id, [1.5, 0.22, 0.3], [0, 0.11, z], 0x62676e, { metalness: 0.5, bevel: 0.25 });
        for (const x of [-0.38, 0, 0.38]) this.box(group, entity, id, [0.3, 0.22, 1.5], [x, 0.33, 0], 0x6e737a, { metalness: 0.5, bevel: 0.25 });
        this.box(group, entity, id, [1.5, 0.22, 0.3], [0, 0.55, -0.2], 0x7a8087, { metalness: 0.5, bevel: 0.25 });
        this.box(group, entity, id, [1.4, 0.2, 0.28], [0, 0.55, 0.2], 0xff8a3a, { accent: true, emissive: 0xff5a1a, emissiveIntensity: 0.55, bevel: 0.25 });
        break;
      }
      case "haybale": {
        // Round bales: one stood on its end (the wound face is the read from above), one on its
        // flank beside it, apart enough that the pair never reads as one bent tube.
        this.cylinder(group, entity, id, 0.42, 0.84, [-0.48, 0.42, 0.05], 0xc9a24a, [0, 0, 0], { roughness: 0.98 });
        this.cylinder(group, entity, id, 0.28, 0.03, [-0.48, 0.85, 0.05], 0xa9842f, [0, 0, 0], { roughness: 0.98 });
        this.cylinder(group, entity, id, 0.12, 0.04, [-0.48, 0.86, 0.05], 0x8a6a24, [0, 0, 0], { roughness: 0.98 });
        this.cylinder(group, entity, id, 0.38, 0.76, [0.42, 0.38, -0.05], 0xbf9842, [Math.PI / 2, 0, 0], { roughness: 0.98 });
        this.cylinder(group, entity, id, 0.4, 0.07, [0.42, 0.38, -0.05], 0x7a5a2a, [Math.PI / 2, 0, 0], { roughness: 0.98 }); // twine band
        break;
      }
      case "fence": {
        // A split-rail field fence: three posts, two rails, one rail sagged off its post.
        for (const x of [-1.05, 0, 1.05]) this.box(group, entity, id, [0.14, 0.92, 0.14], [x, 0.46, 0], 0x5a4128, { bevel: 0.3, roughness: 0.96 });
        this.box(group, entity, id, [2.3, 0.1, 0.08], [0, 0.72, 0], 0x7a5a36, { bevel: 0.35, roughness: 0.96 });
        this.box(group, entity, id, [2.3, 0.1, 0.08], [0.04, 0.36, 0.02], 0x6f5131, { bevel: 0.35, roughness: 0.96, rotation: [0, 0, (v % 2 ? 1 : -1) * 0.12] });
        break;
      }
      case "grave": {
        // Churchyard headstones: a round-topped slab, a cross, a sunk ledger, all leaning with age.
        const lean = ((v % 5) - 2) * 0.05;
        this.box(group, entity, id, [0.5, 0.72, 0.14], [-0.3, 0.34, 0.12], 0x8f8a80, { bevel: 0.35, roughness: 0.94, rotation: [lean, 0.15, lean * 0.6] });
        this.sphere(group, entity, id, 0.25, [-0.3, 0.68, 0.12], 0x8f8a80, { scaleY: 0.5 });
        this.box(group, entity, id, [0.12, 0.84, 0.12], [0.38, 0.42, -0.1], 0x7d786e, { bevel: 0.3, roughness: 0.94, rotation: [-lean, -0.2, 0.08] });
        this.box(group, entity, id, [0.46, 0.11, 0.12], [0.38, 0.6, -0.1], 0x7d786e, { bevel: 0.3, roughness: 0.94, rotation: [-lean, -0.2, 0.08] });
        this.box(group, entity, id, [0.46, 0.08, 0.76], [0.02, 0.04, -0.46], 0x6f6a60, { bevel: 0.3, roughness: 0.96 });
        break;
      }
      case "boat": {
        // A rowboat hauled out for the winter, keel up on its chocks: a broad, flat hull with a square
        // transom and a wedge bow, a pale painted strake round the gunwale, the oars stowed beside it.
        for (const x of [-0.6, 0.5]) this.box(group, entity, id, [0.2, 0.18, 1.2], [x, 0.09, 0], 0x5a4630, { bevel: 0.3 });
        this.box(group, entity, id, [1.7, 0.2, 1.1], [-0.2, 0.26, 0], 0xd8cbb0, { bevel: 0.15, roughness: 0.9 });
        this.box(group, entity, id, [1.7, 0.34, 1.02], [-0.2, 0.52, 0], 0x8a3a2a, { bevel: 0.15, roughness: 0.9 });
        this.box(group, entity, id, [0.78, 0.52, 0.78], [0.66, 0.44, 0], 0x8a3a2a, { bevel: 0.15, roughness: 0.9, rotation: [0, Math.PI / 4, 0] });
        this.box(group, entity, id, [2.3, 0.08, 0.1], [0.1, 0.72, 0], 0x4a2f1c, { bevel: 0.3 });
        this.box(group, entity, id, [1.7, 0.05, 0.1], [-0.1, 0.05, 0.78], 0x9a7a52, { bevel: 0.3, rotation: [0, 0.12, 0] });
        break;
      }
      case "rack": {
        // A fish-drying rack: two A-frames, a ridge pole, the catch hung in a row beneath it.
        for (const x of [-0.9, 0.9]) {
          for (const side of [-1, 1]) this.box(group, entity, id, [0.08, 1.72, 0.08], [x, 0.8, side * 0.22], 0x5a4128, { bevel: 0.3, rotation: [side * 0.26, 0, 0] });
        }
        this.cylinder(group, entity, id, 0.045, 2.1, [0, 1.56, 0], 0x6f5131, [0, 0, Math.PI / 2], { roughness: 0.95 });
        this.cylinder(group, entity, id, 0.035, 1.9, [0, 0.72, 0], 0x6f5131, [0, 0, Math.PI / 2], { roughness: 0.95 });
        for (let i = 0; i < 6; i += 1) {
          const x = -0.62 + i * 0.25;
          this.box(group, entity, id, [0.1, 0.44, 0.05], [x, 1.26, 0], i % 2 ? 0x9aa4a6 : 0xb3ad98, { bevel: 0.4, rotation: [0, 0, ((v >> i) % 3 - 1) * 0.08] });
        }
        break;
      }
      case "iceblock": {
        // Pressure ice: slabs the freeze heaved up and tipped, pale faces catching the low sun.
        const tip = (n: number): number => (((v >> (n * 3)) % 9) - 4) * 0.09;
        this.box(group, entity, id, [1.5, 0.5, 1.2], [0, 0.2, 0], 0xa9c8dc, { bevel: 0.2, roughness: 0.4, rotation: [tip(0), tip(1) * 4, tip(2)] });
        this.box(group, entity, id, [1.1, 1.2, 0.34], [0.1, 0.7, -0.1], 0xcfe3ef, { bevel: 0.25, roughness: 0.35, rotation: [0.35 + tip(3), tip(4) * 4, tip(5)] });
        this.box(group, entity, id, [0.8, 0.9, 0.3], [-0.42, 0.5, 0.34], 0xbcd7e8, { bevel: 0.25, roughness: 0.35, rotation: [-0.4 + tip(6), tip(7) * 4, 0.3] });
        this.box(group, entity, id, [0.5, 0.36, 0.44], [0.5, 0.16, 0.42], 0x96b8cf, { bevel: 0.3, roughness: 0.4, rotation: [0, tip(2) * 4, 0] });
        break;
      }
      case "obelisk": {
        // A sandstone obelisk on its plinth, one carved band, a gilded cap.
        this.box(group, entity, id, [1.12, 0.32, 1.12], [0, 0.16, 0], 0x8a7a60, { bevel: 0.25, roughness: 0.94 });
        this.box(group, entity, id, [0.64, 1.1, 0.64], [0, 0.86, 0], 0xb49a72, { bevel: 0.12, roughness: 0.92 });
        this.box(group, entity, id, [0.7, 0.14, 0.7], [0, 1.47, 0], 0x8f7a58, { bevel: 0.25, roughness: 0.92 });
        this.box(group, entity, id, [0.54, 1.0, 0.54], [0, 2.04, 0], 0xb49a72, { bevel: 0.12, roughness: 0.92 });
        this.box(group, entity, id, [0.44, 0.34, 0.44], [0, 2.7, 0], 0xa88e66, { bevel: 0.14, roughness: 0.92 });
        this.box(group, entity, id, [0.3, 0.3, 0.3], [0, 2.9, 0], 0xd8b45a, { accent: true, metalness: 0.5, bevel: 0.2, rotation: [Math.PI / 4, Math.PI / 4, 0] });
        break;
      }
      case "urn": {
        // Store jars: two amphorae standing, one fallen on its side and cracked.
        const jar = (x: number, z: number, r: number): void => {
          this.sphere(group, entity, id, r, [x, r * 1.3, z], 0xa4552e, { scaleY: 1.3 });
          this.cylinder(group, entity, id, r * 0.32, r * 0.8, [x, r * 2.7, z], 0x96492a, [0, 0, 0], { radiusBottom: r * 0.4, roughness: 0.9 });
          this.cylinder(group, entity, id, r * 0.44, r * 0.14, [x, r * 3.1, z], 0x7e3d22, [0, 0, 0], { roughness: 0.9 });
          this.cylinder(group, entity, id, r * 1.01, r * 0.18, [x, r * 1.4, z], 0x3a2a1e, [0, 0, 0], { accent: true, roughness: 0.9 });
        };
        jar(-0.14, -0.1, 0.3);
        jar(0.38, 0.22, 0.24);
        this.sphere(group, entity, id, 0.24, [-0.3, 0.2, 0.42], 0xa4552e, { scaleY: 0.85 });
        this.box(group, entity, id, [0.2, 0.06, 0.16], [-0.62, 0.03, 0.56], 0x96492a, { bevel: 0.3, rotation: [0, 0.6, 0.2] });
        break;
      }
      case "brazier": {
        // A temple oil brazier: bronze bowl on a tripod, oil jar at its foot, the fire the one light.
        for (let i = 0; i < 3; i += 1) {
          const a = (i / 3) * Math.PI * 2;
          this.box(group, entity, id, [0.07, 0.92, 0.07], [Math.cos(a) * 0.2, 0.44, Math.sin(a) * 0.2], 0x4a3a24, { metalness: 0.45, rotation: [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3] });
        }
        this.cylinder(group, entity, id, 0.44, 0.28, [0, 0.96, 0], 0x8a6a3a, [0, 0, 0], { radiusBottom: 0.24, metalness: 0.5, roughness: 0.5 });
        this.cylinder(group, entity, id, 0.46, 0.06, [0, 1.1, 0], 0x6a5028, [0, 0, 0], { metalness: 0.5 });
        // The fire: three canted tongues, orange round a yellow core — a flame, never a ball.
        for (let i = 0; i < 3; i += 1) {
          const a = (i / 3) * Math.PI * 2 + (v % 7) * 0.3;
          this.cylinder(group, entity, id, 0.01, 0.42, [Math.cos(a) * 0.12, 1.3, Math.sin(a) * 0.12], 0xff8a2a, [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3], { radiusBottom: 0.17, accent: true, emissive: 0xff5a14, emissiveIntensity: 0.75 });
        }
        this.cylinder(group, entity, id, 0.01, 0.5, [0, 1.34, 0], 0xffc85a, [0, 0, 0], { radiusBottom: 0.14, accent: true, emissive: 0xff9a2a, emissiveIntensity: 0.85 });
        this.cylinder(group, entity, id, 0.16, 0.36, [0.46, 0.18, 0.28], 0xa4552e, [0, 0, 0], { radiusBottom: 0.12, roughness: 0.9 });
        break;
      }
      case "hedgehog": {
        // A Czech hedgehog: three rusted steel angles welded through one another, standing on their ends.
        for (let i = 0; i < 3; i += 1) {
          this.box(group, entity, id, [0.2, 1.6, 0.2], [0, 0.52, 0], 0x5a4a40, { metalness: 0.45, bevel: 0.25, rotation: [0, (i / 3) * Math.PI * 2, 0.86] });
        }
        this.box(group, entity, id, [0.34, 0.34, 0.34], [0, 0.52, 0], 0x3d3430, { metalness: 0.45, bevel: 0.3 });
        break;
      }
      case "tower": {
        // A border watchtower: four timber legs, cross-braces, a railed platform, a tin roof and one lamp.
        for (const x of [-0.62, 0.62]) {
          for (const z of [-0.62, 0.62]) this.box(group, entity, id, [0.14, 2.62, 0.14], [x, 1.31, z], 0x5a4128, { bevel: 0.3, rotation: [z * -0.05, 0, x * 0.05] });
        }
        for (const z of [-0.64, 0.64]) this.box(group, entity, id, [0.08, 1.7, 0.08], [0, 1.1, z], 0x6f5131, { rotation: [0, 0, 0.72] });
        for (const x of [-0.64, 0.64]) this.box(group, entity, id, [0.08, 1.7, 0.08], [x, 1.1, 0], 0x6f5131, { rotation: [0.72, 0, 0] });
        this.box(group, entity, id, [1.66, 0.12, 1.66], [0, 2.62, 0], 0x6a4a2c, { bevel: 0.3 });
        for (const z of [-0.8, 0.8]) this.box(group, entity, id, [1.66, 0.42, 0.06], [0, 2.9, z], 0x7c5a36, { bevel: 0.35 });
        for (const x of [-0.8, 0.8]) this.box(group, entity, id, [0.06, 0.42, 1.66], [x, 2.9, 0], 0x7c5a36, { bevel: 0.35 });
        this.box(group, entity, id, [1.9, 0.1, 1.9], [0, 3.36, 0], 0x565c62, { metalness: 0.35, bevel: 0.3, rotation: [0.12, 0, 0] });
        this.cylinder(group, entity, id, 0.12, 0.2, [0.62, 3.06, 0.62], 0xffe6a8, [0.5, 0, 0], { accent: true, emissive: 0xffc46a, emissiveIntensity: 0.6 });
        break;
      }
      case "bones": {
        // A carcass the basin picked clean: spine, a tall cage of ribs, the pelvis, and the horned
        // skull turned away — sized to its footprint so it reads as a beast, not a fishbone.
        this.box(group, entity, id, [1.5, 0.12, 0.12], [-0.15, 0.07, 0], 0xb8ab8c, { bevel: 0.4, roughness: 0.9 });
        for (let i = 0; i < 5; i += 1) {
          const x = -0.62 + i * 0.26;
          const h = 0.78 - Math.abs(i - 1.5) * 0.1;
          for (const side of [-1, 1]) this.box(group, entity, id, [0.09, h, 0.08], [x, h * 0.44, side * 0.26], 0xc2b596, { bevel: 0.4, rotation: [side * -0.5, 0, 0] });
        }
        this.box(group, entity, id, [0.36, 0.2, 0.5], [-0.98, 0.12, 0], 0xb8ab8c, { bevel: 0.4, roughness: 0.9, rotation: [0, 0, 0.2] });
        this.box(group, entity, id, [0.5, 0.3, 0.36], [0.9, 0.17, 0.14], 0xc2b596, { bevel: 0.4, rotation: [0, 0.4, 0.15] });
        for (const side of [-1, 1]) this.cylinder(group, entity, id, 0.035, 0.6, [0.96 + side * 0.08, 0.34, 0.14 + side * 0.34], 0x9a8c6c, [side * 1.1, 0.4, 0.3], { radiusBottom: 0.08 });
        break;
      }
    }
  }

  /**
   * MAP LANDMARKS (2026-09-20) — the one or two big authored pieces that make each battlefield a
   * place: the Dust Bowl's dead convoy and derricks, the Ironworks furnace and rail cars, Verdant's
   * chapel and mill, the hull beached on the Causeway, the colossus and cistern of Karak, the
   * Crossfire checkpoint and radar. Each is a props-kit part authored at world scale (sizes below
   * are the authored bounding boxes from art/props/author_landmarks.py — the kit mesh is a unit
   * cube, so `size` restores it) and a box-built fallback so the game runs with public/models/
   * empty. The pieces are placed with an authored yaw (never spun or jittered — see the transform
   * block in syncEntity) and the accents that carry the read (an ember, a beacon, a lamp) are
   * separate small meshes so the pooled body material stays one flat colour under the toon ramp.
   */
  private buildLandmark(group: THREE.Group, entity: CombatEntity): void {
    const part = entity.parts[0];
    const v = hash(entity.id);
    const kind = entity.coverKind;
    const authored = (k: PropsKind): THREE.BufferGeometry | undefined => propGeometry(k, v);
    const rough = { roughness: 0.94 };
    if (kind === "convoy") {
      const g = authored("convoy");
      // Olive drab, well below the sand's value: the first cut was the ground colour and vanished.
      if (g) this.box(group, entity, part.id, [4.51, 1.94, 1.95], [0.16, 0.81, 0], 0x454a36, { geometry: g, ...rough });
      else {
        this.box(group, entity, part.id, [2.2, 0.22, 1.6], [-0.55, 0.7, 0], 0x454a36, rough);
        this.box(group, entity, part.id, [1.15, 1.1, 1.45], [1.1, 1.15, 0], 0x454a36, { ...rough, rotation: [0, 0, -0.16] });
        this.box(group, entity, part.id, [0.7, 0.7, 0.7], [-0.2, 1.11, 0.25], 0x8a6f3f, rough);
        for (const [x, z] of [[-1.1, -0.8], [-1.1, 0.8], [0.95, 0.8]] as const) this.cylinder(group, entity, part.id, 0.42, 0.3, [x, 0.42, z], 0x242220, [Math.PI / 2, 0, 0], rough);
      }
      // The burn: an ember seam where the engine was, and a scorched patch under the cab.
      this.box(group, entity, part.id, [0.6, 0.18, 0.9], [1.55, 0.95, 0], 0xff7d26, { emissive: 0xff5a1a, emissiveIntensity: 0.55 });
      this.cylinder(group, entity, part.id, 1.6, 0.03, [0.9, 0.015, 0], 0x1c1916, [0, 0, 0], { roughness: 1 });
    } else if (kind === "derrick") {
      const g = authored("derrick");
      if (g) this.box(group, entity, part.id, [3.01, 4.5, 1.91], [-0.585, 2.25, 0], 0x4b4742, { geometry: g, roughness: 0.7, metalness: 0.3 });
      else {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.box(group, entity, part.id, [0.13, 4.0, 0.13], [sx * 0.55, 2.0, sz * 0.55], 0x4b4742, { rotation: [sz * 0.14, 0, -sx * 0.14], metalness: 0.3 });
        this.box(group, entity, part.id, [0.9, 0.22, 0.9], [0, 4.05, 0], 0x4b4742, { metalness: 0.3 });
        this.box(group, entity, part.id, [1.4, 0.16, 1.4], [0, 2.2, 0], 0x4b4742, { metalness: 0.3 });
      }
      // Warning lamp on the crown — the thing you see from the far side of the basin.
      this.sphere(group, entity, part.id, 0.14, [0, 4.55, 0], 0xff4a3a, { emissive: 0xff3a2a, emissiveIntensity: 0.8, accent: true });
    } else if (kind === "furnace") {
      const g = authored("furnace");
      if (g) this.box(group, entity, part.id, [5.13, 4.4, 3.1], [-0.765, 2.2, 0], 0x33353a, { geometry: g, roughness: 0.75, metalness: 0.32 });
      else {
        this.box(group, entity, part.id, [3.2, 0.7, 3.0], [0, 0.35, 0], 0x4d4b50, { metalness: 0.3 });
        this.cylinder(group, entity, part.id, 0.95, 3.0, [0, 2.2, 0], 0x4d4b50, [0, 0, 0], { radiusBottom: 1.35, metalness: 0.32 });
        this.cylinder(group, entity, part.id, 0.95, 0.5, [0, 4.1, 0], 0x4d4b50, [0, 0, 0], { metalness: 0.32 });
      }
      // The tap hole and the throat glow: the furnace is lit from inside, nothing else here is.
      this.box(group, entity, part.id, [0.7, 0.5, 0.3], [0, 0.95, 1.45], 0xff8a2a, { emissive: 0xff5a10, emissiveIntensity: 0.75 });
      this.cylinder(group, entity, part.id, 0.4, 0.06, [0, 4.3, 0], 0xffb040, [0, 0, 0], { emissive: 0xff7a1a, emissiveIntensity: 0.6 });
      // Molten slag in the ladle. Blender +Y exports to -Z, so the ladle authored at y=-0.9 sits at z=+0.9.
      this.box(group, entity, part.id, [0.5, 0.12, 0.6], [2.1, 0.86, 0.9], 0xffa030, { emissive: 0xff6a10, emissiveIntensity: 0.5 });
    } else if (kind === "railcar") {
      const g = authored("railcar");
      const body = v % 2 === 0 ? 0x6d3b2c : 0x4a5560;
      if (g) this.box(group, entity, part.id, [3.9, 1.78, 1.6], [0, 0.89, 0], body, { geometry: g, roughness: 0.8, metalness: 0.25 });
      else {
        this.box(group, entity, part.id, [3.6, 0.2, 1.2], [0, 0.5, 0], 0x3a3a3c, { metalness: 0.3 });
        this.box(group, entity, part.id, [3.4, 1.1, 1.4], [0, 1.15, 0], body, { metalness: 0.25 });
        for (const x of [-1.25, 1.25]) for (const z of [-0.62, 0.62]) this.cylinder(group, entity, part.id, 0.22, 0.12, [x, 0.22, z], 0x2a2a2c, [Math.PI / 2, 0, 0], { metalness: 0.4 });
      }
      this.box(group, entity, part.id, [0.5, 0.3, 0.04], [0.9, 1.2, 0.79], 0xd8c27a, { roughness: 0.8 }); // stencilled placard
    } else if (kind === "chapel") {
      const g = authored("chapel");
      if (g) this.box(group, entity, part.id, [4.68, 3.65, 4.1], [0.04, 1.825, 0], 0x9c9484, { geometry: g, ...rough });
      else {
        this.box(group, entity, part.id, [0.45, 3.4, 3.0], [-2.1, 1.7, 0], 0x9c9484, rough);
        for (const z of [-1.4, 1.4]) this.box(group, entity, part.id, [3.0, 1.6, 0.4], [-0.5, 0.8, z], 0x9c9484, rough);
        this.box(group, entity, part.id, [4.6, 0.12, 3.0], [0, 0.06, 0], 0x8a8274, rough);
      }
      // Ivy on the north wall and a candle still lit at the altar.
      this.box(group, entity, part.id, [1.0, 1.1, 0.08], [-1.2, 0.95, 1.62], 0x3f6a2c, { roughness: 1, bevel: 0.4 });
      this.sphere(group, entity, part.id, 0.09, [-1.5, 1.0, 0], 0xffd88a, { emissive: 0xffb040, emissiveIntensity: 0.7, accent: true });
    } else if (kind === "mill") {
      const g = authored("mill");
      if (g) this.box(group, entity, part.id, [3.36, 3.22, 2.85], [0.02, 1.43, 0], 0x6b5236, { geometry: g, ...rough });
      else {
        this.box(group, entity, part.id, [2.0, 1.7, 2.2], [-0.55, 0.85, 0], 0x6b5236, rough);
        this.box(group, entity, part.id, [2.3, 1.0, 2.5], [-0.55, 2.2, 0], 0x5a4530, { ...rough, bevel: 0.3 });
        this.cylinder(group, entity, part.id, 1.2, 0.22, [1.15, 1.25, 0], 0x4f3b28, [0, 0, Math.PI / 2], rough);
      }
      this.box(group, entity, part.id, [0.5, 0.6, 0.06], [-1.58, 1.5, -0.6], 0xffd28a, { emissive: 0xffa040, emissiveIntensity: 0.5 }); // lit window
    } else if (kind === "hull") {
      const g = authored("hull");
      // Drawn a third over its authored size: at 1:1 it read as a launch next to the containers.
      if (g) this.box(group, entity, part.id, [7.5, 5.8, 3.65], [0.01, 2.9, 0.32], 0x2f3a44, { geometry: g, roughness: 0.82, metalness: 0.3 });
      else {
        this.box(group, entity, part.id, [5.6, 1.9, 2.4], [0, 1.05, 0], 0x3f4b55, { rotation: [0.22, 0, 0], metalness: 0.3 });
        this.box(group, entity, part.id, [1.6, 1.1, 1.5], [-1.5, 2.6, 0], 0x55606a, { rotation: [0.22, 0, 0], metalness: 0.3 });
        this.cylinder(group, entity, part.id, 0.3, 1.1, [-2.3, 2.9, 0], 0x2f3236, [0.22, 0, 0], { metalness: 0.3 });
      }
      // Rust at the waterline and a navigation lamp still burning on the bridge.
      this.box(group, entity, part.id, [5.4, 0.6, 0.1], [-0.4, 0.95, -1.6], 0x7a4a2c, { roughness: 1 });
      this.sphere(group, entity, part.id, 0.14, [-1.95, 4.8, -0.4], 0x7fe8ff, { emissive: 0x4fd8ff, emissiveIntensity: 0.8, accent: true });
    } else if (kind === "hut") {
      const g = authored("hut");
      const tent = v % 2 === 1;
      const color = tent ? 0x9a8a72 : 0x7a6244;
      if (g) this.box(group, entity, part.id, tent ? [2.14, 1.9, 1.75] : [1.7, 1.95, 2.2], [0, tent ? 0.95 : 0.975, 0], color, { geometry: g, ...rough });
      else {
        this.box(group, entity, part.id, [1.5, 1.15, 1.6], [0, 0.58, 0], color, rough);
        this.box(group, entity, part.id, [1.7, 0.55, 1.8], [0, 1.42, 0], 0x5a4530, { ...rough, bevel: 0.35 });
      }
      this.box(group, entity, part.id, [0.3, 0.3, 0.05], [0.3, 0.9, tent ? 0.84 : 0.85], 0xffc870, { emissive: 0xff9a30, emissiveIntensity: 0.45 }); // lamp in the window
    } else if (kind === "colossus") {
      const g = authored("colossus");
      if (g) this.box(group, entity, part.id, [5.96, 1.73, 2.2], [0.03, 0.865, 0], 0x9a948a, { geometry: g, roughness: 0.92 });
      else {
        this.box(group, entity, part.id, [2.6, 1.3, 1.7], [0.3, 0.65, 0], 0x9a948a, { roughness: 0.92, bevel: 0.35 });
        this.sphere(group, entity, part.id, 0.7, [-2.05, 0.62, 0.15], 0x9a948a);
        this.box(group, entity, part.id, [0.7, 0.9, 2.2], [2.6, 0.35, 0], 0x8a8478, { roughness: 0.92 });
      }
      // Moss in the seams and the one gilded thing left: the eye.
      this.box(group, entity, part.id, [1.2, 0.08, 0.9], [0.5, 1.2, 0.3], 0x4a6a34, { roughness: 1, bevel: 0.4 });
      this.sphere(group, entity, part.id, 0.1, [-2.5, 0.95, 0.35], 0xe0b040, { emissive: 0xa06a10, emissiveIntensity: 0.3, accent: true });
    } else if (kind === "cistern") {
      const g = authored("cistern");
      if (g) this.box(group, entity, part.id, [4.1, 1.76, 4.4], [0, 0.88, -0.15], 0x8f887a, { geometry: g, roughness: 0.92 });
      else {
        this.cylinder(group, entity, part.id, 1.7, 0.95, [0, 0.48, 0], 0x8f887a, [0, 0, 0], { radiusBottom: 1.8, roughness: 0.92 });
        this.cylinder(group, entity, part.id, 1.85, 0.14, [0, 0.98, 0], 0x8f887a, [0, 0, 0], { roughness: 0.92 });
      }
      // The water: a still dark disc a step down inside the rim (the authored ring is hollow).
      this.cylinder(group, entity, part.id, 1.46, 0.04, [0, 0.56, 0], 0x1f3b44, [0, 0, 0], { roughness: 0.2, metalness: 0.1 });
    } else if (kind === "gate") {
      const g = authored("gate");
      if (g) this.box(group, entity, part.id, [4.64, 2.55, 1.85], [-0.17, 1.275, 0], 0x8a8478, { geometry: g, roughness: 0.85, metalness: 0.1 });
      else {
        this.box(group, entity, part.id, [1.2, 2.0, 1.3], [-1.4, 1.0, 0], 0x8a8478, { roughness: 0.85 });
        this.box(group, entity, part.id, [1.7, 0.14, 1.8], [-1.3, 2.08, 0], 0x6a655c, { roughness: 0.85 });
        this.cylinder(group, entity, part.id, 0.07, 3.2, [1.0, 1.65, 0.2], 0xd8d0c0, [0, 0, -1.2], { roughness: 0.8 });
      }
      // Red-white stripes on the boom (a second thin bar along it) and the booth's amber lamp.
      for (const t of [0.35, 0.65, 0.95] as const) {
        const x = -0.5 + Math.cos(0.384) * 3.2 * t;
        const y = 1.05 + Math.sin(0.384) * 3.2 * t;
        this.box(group, entity, part.id, [0.34, 0.16, 0.16], [x, y, 0.2], 0xd63a2a, { rotation: [0, 0, 0.384], roughness: 0.8 });
      }
      this.box(group, entity, part.id, [0.3, 0.16, 0.16], [-1.4, 2.22, 0.5], 0xffb040, { emissive: 0xff8a20, emissiveIntensity: 0.6 });
      this.box(group, entity, part.id, [0.8, 0.4, 0.05], [0.4, 2.3, -0.79], 0xd8d0c0, { roughness: 0.9 });
    } else if (kind === "radar") {
      const g = authored("radar");
      if (g) this.box(group, entity, part.id, [2.96, 3.51, 2.5], [-0.07, 1.755, 0.05], 0x7f8a90, { geometry: g, roughness: 0.7, metalness: 0.35 });
      else {
        this.box(group, entity, part.id, [2.2, 0.7, 1.6], [0, 0.55, 0], 0x7f8a90, { metalness: 0.35 });
        this.cylinder(group, entity, part.id, 0.32, 1.0, [0, 1.4, 0], 0x7f8a90, [0, 0, 0], { metalness: 0.35 });
        this.cylinder(group, entity, part.id, 0.5, 0.3, [0, 2.5, 0.25], 0x9aa4aa, [-0.87, 0, 0], { radiusBottom: 1.45, metalness: 0.35 });
      }
      // Beacon on the mast and the dish's feed lit: it is still sweeping.
      this.sphere(group, entity, part.id, 0.12, [1.25, 3.25, 0.5], 0xff4a3a, { emissive: 0xff3a2a, emissiveIntensity: 0.85, accent: true });
      this.sphere(group, entity, part.id, 0.1, [0, 3.35, 1.25], 0x7fe8ff, { emissive: 0x4fd8ff, emissiveIntensity: 0.6, accent: true });
    }
  }

  // Nudge a prop's structural surfaces toward the active map's palette so it belongs to the
  // scene. Glowing gameplay-signal props (fuel/ammo/conduit, anything emissive) are left alone
  // so their cues stay legible. Both the live material and the stored baseColor are updated so
  // the per-part damage shading keeps the tint.
  private tintPropToMap(group: THREE.Group, amount = 0.7, tint: THREE.Color = this.propTint): void {
    group.traverse((obj) => {
      const mesh = obj as PartMesh;
      if (!(mesh.isMesh) || !(mesh.material instanceof THREE.MeshStandardMaterial || mesh.material instanceof THREE.MeshToonMaterial)) return;
      if ((mesh.userData.baseEmissiveIntensity as number ?? 0) > 0.12) return; // keep glowing signals
      // Only the BASE colour moves. The live material is pooled and shared across every mesh that
      // currently looks the same, so writing to it here would repaint half the scene; paintPart
      // re-resolves this mesh to the right pooled material on the next frame anyway.
      const tinted = new THREE.Color(mesh.userData.baseColor as number ?? mesh.material.color.getHex()).lerp(tint, amount);
      mesh.userData.baseColor = tinted.getHex();
    });
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
      /**
       * Use a Blender-authored shape from the infantry kit instead of a rounded box. The kit mesh
       * is normalised to a unit cube, so `size` still means exactly what it means for a box — and
       * if the GLB is missing or still loading, this silently stays a box. Shape comes from art;
       * proportion stays here.
       */
      kit?: KitPart;
      /** An already-resolved unit-cube geometry (props / vehicles kit part) — same contract as `kit`. */
      geometry?: THREE.BufferGeometry;
      /**
       * Inverted-hull ink rim of this width (world units): the same geometry drawn again BackSide,
       * pushed out so the line stays this thick in world space whatever the part's size. The
       * vehicles kit wears it on every part — the same ink line the troopers and the projectile
       * FX carry. One extra draw call per part, so hulls only.
       */
      ink?: number;
    } = {}
  ): PartMesh {
    const roughness = materialOptions.roughness ?? 0.62;
    const metalness = materialOptions.metalness ?? 0.08;
    const authored = materialOptions.geometry ?? (materialOptions.kit ? kitGeometry(materialOptions.kit) : undefined);
    // Pooled part materials read vertex colours (baked AO). An authored GLB part has none, and a
    // missing colour attribute samples as BLACK — the bowling-ball helmets. Bake once per shared
    // geometry, same as every procedural part.
    if (authored && !authored.getAttribute("color")) bakeVertexAO(authored);
    const mesh = new THREE.Mesh(
      authored ?? beveledBox(size[0], size[1], size[2], materialOptions.bevel),
      pooledPartMaterial(color, materialOptions.emissive ?? 0x000000, materialOptions.emissiveIntensity ?? 0, roughness, metalness)
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    // An authored unit-cube mesh is scaled to the requested size; a box is already that size.
    if (authored) mesh.scale.set(size[0], size[1], size[2]);
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
    const ink = materialOptions.ink ?? this.defaultInk(entity, materialOptions.accent);
    if (ink) this.inkRim(mesh, size, ink);
    group.add(mesh);
    return mesh;
  }

  /**
   * Every procedurally built machine (aircraft, flak, the fallback hulls) wears the same ink rim as
   * the vehicles kit. Without it the flyers were the one family of soft, outline-less boxes on the
   * board and read as blurry next to everything else. Troopers and scenery keep their own rules;
   * accent lamps stay rimless so a glow is never boxed in black.
   */
  private defaultInk(entity: CombatEntity, accent?: boolean): number {
    return !accent && entity.kind !== "cover" && !isInfantryKind(entity.kind) ? VEHICLE_INK : 0;
  }

  // Inverted-hull ink rim: a BackSide copy of the part, scaled so the rim is `width` thick in
  // world units on every axis (the child lives in the part's pre-scale space, so a uniform 1.03
  // would make a thin plate's rim thin and a long gun's rim fat). Pooled material; never a caster;
  // hidden while the part is ghosted (see paintOutline).
  private inkRim(mesh: PartMesh, size: [number, number, number], width: number): void {
    const rim = new THREE.Mesh(mesh.geometry, inkMaterial());
    rim.scale.set((size[0] + 2 * width) / size[0], (size[1] + 2 * width) / size[1], (size[2] + 2 * width) / size[2]);
    rim.castShadow = false;
    rim.receiveShadow = false;
    rim.userData.decor = true;
    rim.userData.ink = true;
    mesh.add(rim);
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
    const ink = this.defaultInk(entity, materialOptions.accent);
    if (ink) this.inkRim(mesh, [radius * 2, depth, radius * 2], ink);
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
        new THREE.MeshToonMaterial({
          color,
          gradientMap: toonGradient(),
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
      // Chunks used to be permanent: after one wiped squad the field was a litter of saturated
      // red and blue chips for the rest of the battle. They settle, then sink into the ground
      // over a few seconds and are freed.
      const lived = now - born;
      if (lived > DEBRIS_SINK_AT + DEBRIS_SINK_FOR) { this.debrisRoot.remove(mesh); continue; }
      const sink = Math.max(0, lived - DEBRIS_SINK_AT) / DEBRIS_SINK_FOR;
      const age = Math.min(2.2, lived);
      mesh.position.set(
        origin.x + velocity.x * age,
        Math.max(0.07, origin.y + velocity.y * age - 2.65 * age * age) - sink * 0.4,
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
        // Long weapons (MG, long rifle, mortar tube, launcher) are carried muzzle-high, so their
        // length runs up the body instead of across it: a 1.1m gun held level across the chest
        // read as a slab wider than the trooper.
        const long = entity.kind === "heavy" || entity.kind === "sniper" || entity.kind === "mortar" || entity.kind === "grenadier";
        const pitch = (long ? CARRY_PITCH_LONG : CARRY_PITCH) * carry;
        const yaw = (long ? CARRY_YAW * 0.5 : CARRY_YAW) * carry;
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
    // POSTURE + LOCOMOTION (infantry only). Everything below reads the gait state syncEntity wrote
    // on the actor group and poses the rig from pivots: legs by two-bone IK from the hip to a
    // stride-locked foot target (gait.ts), the free arm counter-swinging the opposite leg, the
    // upper body leaning from the hip and countering the pelvis twist, the head kept level.
    const limb = mesh.userData.limb as string | undefined;
    const segment = mesh.userData.segment as "thigh" | "shin" | "foot" | undefined;
    // The ACTOR group, not mesh.parent: infantry parts sit inside a proportion rig, so the
    // immediate parent is not where syncEntity writes the animation state.
    const parent = actor;
    const walkW = (parent.userData.walkWeight as number | undefined) ?? 0;
    const crouched = (parent.userData.crouched as boolean | undefined) ?? entity.stance === "crouched";
    const kneeling = entity.status.alive && isInfantryKind(entity.kind) && entity.parts.some((p) => p.role === "mobility" && p.hp <= 0);
    if (isInfantryKind(entity.kind) && part.hp > 0 && entity.status.alive && basePosition) {
      const gait = (parent.userData.gait as GaitParams | undefined) ?? GAIT_TIERS.walk;
      const phase = (parent.userData.gaitPhase as number | undefined) ?? 0;
      const bob = (parent.userData.gaitBob as number | undefined) ?? 0;
      const lean = (parent.userData.gaitLean as number | undefined) ?? 0;
      const twist = (parent.userData.gaitTwist as number | undefined) ?? 0;
      // The hip pivot drops with a crouch or a kneel; the ground stays where it is.
      const drop = kneeling ? KNEEL_DROP : crouched ? CROUCH_DROP : 0;
      const hipY = HIP_Y - drop;
      if (limb?.startsWith("leg") && segment) {
        const side = limb === "leg-l" ? -1 : 1;
        let pose: LegPose;
        if (kneeling) {
          // Left knee on the ground, right leg braced forward. Authored angles, not IK.
          pose = side < 0 ? kneelPose(0.05, -1.55, -1.1, hipY) : kneelPose(1.45, 0.05, 0, hipY);
        } else {
          // Rest: straight legs standing, or a squat when crouched. Walk: the gait's foot target.
          const rest = crouched
            ? solveLeg({ y: ANKLE_Y, z: HIP_Z + 0.03 * side, pitch: 0, planted: true }, hipY)
            : solveLeg({ y: ANKLE_Y, z: HIP_Z, pitch: 0, planted: true }, hipY);
          pose = copyPose(rest, _restPose);
          if (walkW > 0.02) {
            const u = side > 0 ? phase : phase + 0.5;
            const walk = solveLeg(footAt(gait, u, bob), hipY);
            blendPose(pose, walk, walkW);
          }
        }
        // Place the segment about its pivot: rest pivot -> posed pivot, offset rotated by the
        // segment's angle (forward positive, which is a NEGATIVE rotation about x in three).
        let restPivotY = HIP_Y, restPivotZ = HIP_Z, pivotY = hipY, pivotZ = HIP_Z, angle = pose.thigh;
        if (segment === "shin") { restPivotY = KNEE_Y; pivotY = pose.kneeY; pivotZ = pose.kneeZ; angle = pose.shin; }
        else if (segment === "foot") { restPivotY = ANKLE_Y; pivotY = pose.ankleY; pivotZ = pose.ankleZ; angle = pose.foot; }
        const dy = basePosition.y - restPivotY;
        const dz = basePosition.z - restPivotZ;
        const c = Math.cos(angle), s = Math.sin(angle);
        mesh.position.y = pivotY + dy * c + dz * s;
        mesh.position.z = pivotZ - dy * s + dz * c;
        mesh.position.x = basePosition.x + side * gait.width * walkW;
        mesh.rotation.x = (baseRotation ? baseRotation.x : 0) - angle;
      } else if (part.role === "mobility" || (part.id === "legs" && !limb)) {
        // Pelvis (belt, hip-hung gear): follows the hip drop and twists toward the leading leg.
        mesh.position.y -= drop;
        if (crouched) mesh.position.z += 0.05;
        mesh.rotation.y += twist;
      } else {
        // Upper body: arms swing from the shoulder first, then everything leans from the hip and
        // counter-rotates against the pelvis. The head keeps its heading and half of the bob.
        if (limb === "arm-l" || limb === "arm-r") {
          const free = limb === "arm-l";
          const u = free ? phase : phase + 0.5; // the free (left) arm follows the RIGHT leg
          const swing = walkW > 0.02 ? solveLeg(footAt(gait, u, bob), hipY).thigh * gait.armSwing * (free ? 1 : 0.22) * walkW : 0;
          const reach = SHOULDER_Y - basePosition.y;
          mesh.rotation.x = (baseRotation ? baseRotation.x : 0) - swing;
          mesh.position.y = SHOULDER_Y - reach * Math.cos(swing);
          mesh.position.z = basePosition.z + reach * Math.sin(swing);
        }
        mesh.position.y -= drop;
        if (crouched) {
          mesh.position.z += part.role === "head" ? 0.12 : part.role === "core" ? 0.08 : 0.05;
          if (part.role === "core") mesh.rotation.x += 0.16;
        }
        // Lean from the hip.
        const ly = mesh.position.y - hipY;
        const lz = mesh.position.z - HIP_Z;
        mesh.position.y = hipY + ly * Math.cos(lean) - lz * Math.sin(lean);
        mesh.position.z = HIP_Z + ly * Math.sin(lean) + lz * Math.cos(lean);
        mesh.rotation.x += lean;
        // Counter-twist about the spine (the head stays on its heading, and stays level).
        if (part.role === "head") {
          mesh.position.y += bob * 0.5;
        } else {
          const yaw = -twist;
          const tx = mesh.position.x;
          const tz = mesh.position.z - HIP_Z;
          mesh.position.x = tx * Math.cos(yaw) + tz * Math.sin(yaw);
          mesh.position.z = HIP_Z - tx * Math.sin(yaw) + tz * Math.cos(yaw);
          mesh.rotation.y += yaw;
        }
      }
    }

    // DAMAGED PARTS SHOW IT. damageModel tracks per-part HP and until now the only read of it was
    // a tint. A dead part now changes the SHAPE: a shot-out weapon hangs from the hand, a
    // ruptured pack sags off the shoulder and smoulders, and dead legs put the trooper on one knee
    // (the unit is immobilised in the sim -- this is what that looks like, posed above).
    if (entity.status.alive && isInfantryKind(entity.kind) && basePosition && part.hp <= 0) {
      if (part.id === "rifle" || part.id === "cannon" || part.id === "gun") {
        mesh.rotation.x = (baseRotation ? baseRotation.x : 0) + 1.15;
        mesh.position.y = basePosition.y - 0.22;
        mesh.position.z = basePosition.z - 0.12;
      } else if (part.id === "pack") {
        mesh.rotation.z = (baseRotation ? baseRotation.z : 0) - 0.55;
        mesh.rotation.x = (baseRotation ? baseRotation.x : 0) + 0.3;
        mesh.position.y = basePosition.y - 0.18;
      }
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
          if (family === "melee") {
            // The blade is a separate part, so it has to be carried by the arm explicitly: swing
            // it with the shoulder about a grip pivot 0.4 behind its centre. Without this the arm
            // swept ±0.6 rad while the weapon hung motionless in mid-air.
            const a = m.shoulderPitch;
            mesh.rotation.x -= a;
            mesh.rotation.y += m.shoulderYaw;
            mesh.position.y += 0.4 * Math.sin(a);
            mesh.position.z += 0.4 * (Math.cos(a) - 1);
          }
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
          if (segment === "thigh") mesh.rotation.x -= m.kneeBend * 0.4; else if (segment === "shin") mesh.rotation.x += m.kneeBend * 0.4;
          mesh.position.y += m.bodyLift * 0.5;
        }
      } else {
        const pose = attackPose(family, attackPhase);
        if (part.id === "rifle" || part.id === "cannon" || part.id === "gun") {
          mesh.position.z -= pose.draw;
          mesh.rotation.x -= pose.lift;
        } else if (family === "throw" && limb === "arm-l" && basePosition) {
          // BEFORE the core branch: arms are meshes of the "body" part (role core), so a limb test
          // placed after it never runs. The free arm windmills about the SHOULDER (the mesh pivots
          // at its own centre, so the centre is carried round the shoulder as the walk swing does).
          const a = throwArmAngle(attackPhase);
          const reach = SHOULDER_Y - basePosition.y;
          mesh.rotation.x -= a;
          mesh.position.y += reach * (1 - Math.cos(a));
          mesh.position.z += reach * Math.sin(a);
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
    // Selection is a LIFT, not a wash: 24% toward white plus a strong emissive bloomed the selected
    // trooper into a glowing white blob with no model left in it (owner report, 2026-09-23). The
    // cyan ring under the unit carries "selected"; the body only needs to step forward a little.
    if (selected && part.hp > 0) color.lerp(hexColor(0xffffff), 0.07);
    if (targeted && part.hp > 0) color.lerp(hexColor(0xffd166), targetedPart ? 0.58 : 0.3);
    // Hit flash: a freshly-damaged part snaps white for a beat, so the eye catches what got hit.
    const flash = part.hp > 0 ? this.partFlash(entity.id, part.id) : 0;
    if (flash > 0) color.lerp(hexColor(0xffffff), flash * 0.7);
    // VALUE HIERARCHY (the TF2 rule). A trooper reads as a solid, grounded figure when its value
    // climbs with height: darkest at the boots, mid on the body, brightest at the weapon/chest
    // band -- and it reads as a flat toy when every part sits at the same value, which is what
    // twelve independently-authored kits produced. Applied here rather than in twelve branches, so
    // it can't drift, and keyed on the part's authored height in the rig.
    if (isInfantryKind(entity.kind) && basePosition && !accent) color.multiplyScalar(bodyValueAt(basePosition.y));
    // ...and exactly ONE accent zone per unit: the saturated identity colour belongs at the band
    // the eye goes to. Accent kit above or below the chest/weapon band is knocked back so it stops
    // competing -- a trooper covered in bright chips has no focal point at all.
    if (isInfantryKind(entity.kind) && basePosition && accent) color.multiplyScalar(accentValueAt(basePosition.y));
    spec.color.copy(color);
    const baseEmissive = mesh.userData.baseEmissive as number;
    const unitGlow = entity.kind !== "cover" && entity.team !== "neutral";
    const coverGlow = entity.kind === "cover" && part.hp > 0;
    const coverGlowColor = entity.coverKind === "cliff" ? 0x4a2284 : part.role === "volatile" ? 0x7a4200 : entity.coverKind === "ridge" ? 0x5a3a13 : 0x5c4620;
    const unitGlowColor = entity.team === "enemy" ? TEAMS.enemyGlowDim : TEAMS.playerGlowDim;
    spec.emissive.copy(hexColor(part.hp > 0 && targetedPart ? 0x4f3000 : part.hp > 0 && selected ? 0x0b3844 : accent ? baseEmissive : unitGlow ? unitGlowColor : coverGlow ? coverGlowColor : baseEmissive));
    spec.emissiveIntensity = part.hp > 0
      // The team glow is a WHISPER, not a wash. At 0.07 of a teal emissive on every part of every
      // player unit, it tinted the whole roster toward one hue and buried the per-role palette
      // underneath it — which is most of why six different troopers read as six teal blobs. The
      // marker ring above each unit is what actually carries the team read.
      ? (mesh.userData.baseEmissiveIntensity as number) + (unitGlow ? 0.022 : 0) + (coverGlow ? 0.18 : 0) + (selected ? 0.2 : 0) + (targetedPart ? 0.72 : targeted ? 0.34 : 0)
      : 0;
    // Living idle: standing infantry breathe, their arms + held weapon carry a slow sway, and the
    // torso does a subtle weight-shift — phase-offset per unit so a squad doesn't move in lockstep,
    // and weighted by (1 - walkWeight) so it fades out as the unit starts walking. Keeps the roster
    // alive instead of frozen through the long planning phase, without any new geometry.
    const idleW = isInfantryKind(entity.kind) && entity.status.alive && part.hp > 0 && entity.stance !== "crouched" ? 1 - walkW : 0;
    if (idleW > 0.02) {
      const t = performance.now() * 0.0017 + (hash(entity.id) % 100) * 0.11;
      if (part.role === "core") {
        mesh.scale.y *= 1 + Math.sin(t * 1.2) * 0.022 * idleW;
        mesh.rotation.z += Math.sin(t * 0.6) * 0.03 * idleW;
      } else if (part.role === "head") {
        // Scanning: a slow sweep with a quicker glance layered on, and a pause near the ends so it
        // reads as looking, not as nodding. This is the single most legible idle from the camera.
        const sweep = Math.sin(t * 0.36);
        mesh.rotation.y += (Math.sign(sweep) * Math.pow(Math.abs(sweep), 0.6) * 0.42 + Math.sin(t * 1.7) * 0.06) * idleW;
        mesh.rotation.x += Math.sin(t * 0.9) * 0.04 * idleW;
      } else if (limb === "arm-l" || limb === "arm-r") {
        mesh.rotation.x += Math.sin(t + (limb === "arm-r" ? 0.5 : 0)) * 0.11 * idleW;
        mesh.rotation.z += Math.sin(t * 0.7 + (limb === "arm-r" ? 1.2 : 0)) * 0.04 * idleW;
      } else if (part.id === "rifle") {
        mesh.rotation.x += Math.sin(t + 0.3) * 0.09 * idleW;
        mesh.rotation.z += Math.sin(t * 0.8) * 0.04 * idleW;
      }
    }
    // "Still has orders left" cue: a player unit with command points remaining carries a slow pulse
    // on its weapon. This is a real affordance and it stays -- but it used to run at 0.14 plus up
    // to 0.18 of the team accent, which lit the whole weapon like a lantern. Since the command
    // phase is where the player spends nearly all their time, that meant EVERY gun in the game was
    // a glowing pale slab in almost every frame, and no amount of modelling detail survived it.
    // A third of the strength still reads as a pulse without erasing the metal underneath.
    // ...and it is only allowed on the small ACCENT meshes of a weapon (muzzle, sight, power cell),
    // never on the weapon body. A heavy's auto-cannon is a 1.2m slab -- the largest single surface
    // on the unit -- and washing it with the team's cyan turned it into a pale bar with no metal
    // left in it, which is the "one accent zone" rule broken by the very cue that needs the zone.
    if (this.commandPhase && accent && entity.team === "player" && entity.status.alive && entity.commandPoints > 0 && part.role === "weapon" && part.hp > 0 && !selected && !targeted) {
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
      if (child.userData.ink) { child.visible = !ghosted; continue; }
      if (!child.userData.outline) continue;
      (child as THREE.LineSegments).material = ghosted ? OUTLINE_MATERIALS.ghost : OUTLINE_MATERIALS.solid;
    }
  }

  private syncSelection(sim: TacticalSim): void {
    const selected = sim.selected;
    this.ring.visible = Boolean(selected);
    this.ringInk.visible = Boolean(selected);
    this.selectionDisc.visible = Boolean(selected);
    if (!selected) return;
    const color = selected.team === "player" ? (selected.accent ?? this.playerAccent) : selected.team === "enemy" ? TEAMS.enemyMarker : 0xf6d776;
    const scale = Math.max(0.72, selected.radius * 1.12);
    const pulse = (Math.sin(performance.now() * 0.009) + 1) * 0.5;
    const pulseScale = 1.0 + pulse * 0.04;
    this.ring.position.set(selected.position.x, selected.elevation, selected.position.z);
    this.ringInk.position.copy(this.ring.position);
    this.ring.scale.setScalar(scale);
    this.ringInk.scale.setScalar(scale);
    const ringSig = `${selected.id}|${selected.position.x.toFixed(2)}|${selected.position.z.toFixed(2)}|${selected.elevation.toFixed(2)}`;
    if (ringSig !== this.lastRingSig) {
      drapeToTerrain(this.ringInk, 0.075);
      drapeToTerrain(this.ring, 0.085);
      this.lastRingSig = ringSig;
    }
    this.ring.scale.setScalar(scale * pulseScale);
    this.ringInk.scale.setScalar(scale * pulseScale);
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
    const shoot = range?.kind === "shoot";
    this.shootRangeRing.visible = Boolean(selected && shoot);
    this.actionRangeRing.visible = Boolean(selected && range && !shoot);
    if (!selected || !range) return;
    const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    // The overlay is re-draped only when what it covers changes (selection, projected position,
    // radius), not per frame — 3k terrain samples is not a per-frame cost.
    const sig = `${range.kind}|${range.position.x.toFixed(2)}|${range.position.z.toFixed(2)}|${range.radius.toFixed(2)}`;
    if (shoot) {
      this.shootRangeRing.position.set(range.position.x, range.elevation, range.position.z);
      this.shootRangeRing.scale.setScalar(range.radius);
      if (sig !== this.lastRangeSig) drapeToTerrain(this.shootRangeRing, 0.07);
      this.lastRangeSig = sig;
      (this.shootRangeRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + pulse * 0.2;
      return;
    }
    this.actionRangeRing.position.set(range.position.x, range.elevation, range.position.z);
    this.actionRangeRing.scale.setScalar(range.radius);
    if (sig !== this.lastRangeSig) drapeToTerrain(this.actionRangeRing, 0.062);
    this.lastRangeSig = sig;
    this.actionRangeRing.scale.setScalar(range.radius * (1 + pulse * 0.01));
    const mat = this.actionRangeRing.material as THREE.MeshBasicMaterial;
    mat.color.setHex(range.kind === "melee" ? 0xd28cff : range.kind === "grenade" ? 0xff7f67 : range.kind === "move" ? 0x9dfcff : 0xffbf4d);
    // A field carries far more ink than a hairline did, so it sits lower in opacity.
    mat.opacity = 0.46 + pulse * 0.12;
  }

  // Faint rings showing the reach of support/spotter auras (medic, engineer, scout, sniper),
  // so the player can see which allies benefit. Command phase only to avoid resolve clutter.
  // Signature for the aura overlay: the aura-unit content, plus a ~15fps pulse bucket so the slow
  // opacity pulse still animates while the geometry stays static between beats.
  private aurasSignature(sim: TacticalSim): string {
    let sig = `${sim.phase}|${Math.floor(performance.now() / 66)}`;
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
          new THREE.RingGeometry(aura.radius - 0.13, aura.radius, 96, 1),
          new THREE.MeshBasicMaterial({ color: aura.color, transparent: true, opacity: 0.16 + pulse * 0.1, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(entity.position.x, entity.elevation, entity.position.z);
        drapeToTerrain(ring, 0.05); // aura rings cross ledges too (rebuilt only when the signature changes)
        this.auraRoot.add(ring);
      }
    }
  }

  // The circle showing where a base defense can be placed (build flow) or where a troop can be
  // fielded (placed-deploy flow) — one ring, whichever is armed.
  private syncBuildPlacement(sim: TacticalSim): void {
    const placement = sim.buildPlacement() ?? sim.deployPlacement();
    this.placementRing.visible = Boolean(placement);
    this.placementDisc.visible = Boolean(placement);
    if (!placement) return;
    const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5;
    const y = terrainHeightAt(placement.center);
    const sig = `${placement.center.x.toFixed(2)}|${placement.center.z.toFixed(2)}|${placement.radius.toFixed(2)}`;
    this.placementRing.position.set(placement.center.x, y, placement.center.z);
    this.placementRing.scale.setScalar(placement.radius);
    this.placementDisc.position.set(placement.center.x, y, placement.center.z);
    this.placementDisc.scale.setScalar(placement.radius);
    if (sig !== this.lastPlacementSig) {
      // The build radius around a base spans mesa steps and the shoreline; drape both like the move field.
      drapeToTerrain(this.placementRing, 0.07);
      drapeToTerrain(this.placementDisc, 0.05);
      this.lastPlacementSig = sig;
    }
    (this.placementRing.material as THREE.MeshBasicMaterial).opacity = 0.5 + pulse * 0.2;
  }

  private syncOrders(sim: TacticalSim): void {
    this.disposeAndClear(this.orderRoot);
    if (sim.phase !== "command") return;
    const projectedPositions = new Map<string, { x: number; z: number }>();
    for (const order of sim.orders) {
      const actor = sim.entity(order.actorId);
      // Only the planning side's own orders. Against the bot nothing else is queued in the command
      // phase; in hotseat the other human's plan is sitting in this list and must stay hidden
      // (a recon pulse reveals it below, as enemy intents).
      if (!actor || actor.team !== "player") continue;
      const from = projectedPositions.get(actor.id) ?? actor.position;
      if (order.kind === "defend") {
        this.orderRoot.add(makeEndpoint(from, 0x8de4ff, actor.radius + 0.45));
        this.orderRoot.add(makeEndpoint(from, 0xffffff, actor.radius + 0.14));
        continue;
      }
      const to = order.destination ?? sim.entity(order.targetId)?.position;
      if (!to) continue;
      const color = order.kind === "move" ? 0x9dfcff : order.kind === "ram" ? 0xffbf4d : order.kind === "melee" ? 0xb48cff : 0xff7f67;
      if (order.kind === "move" && order.destination) {
        addDrapedMovePath(this.orderRoot, from, to, color, 0.32);
        this.orderRoot.add(makeEndpoint(to, color, actor.radius + 0.22, drawnGroundAt(to) + 0.26));
        projectedPositions.set(actor.id, order.destination);
        continue;
      }
      const fromY = terrainHeightAt(from) + 0.24;
      const toY = terrainHeightAt(to) + 0.24;
      this.orderRoot.add(makeTubeLine(from, to, color, 0.32, fromY, 0.028, toY));
      this.orderRoot.add(makeLine(from, to, color, 0.62, fromY + 0.05, toY + 0.05));
    }
    // RECON PULSE: the enemy's next orders as ghost arrows — enemy red, thinner and fainter than the
    // player's own, with a hollow endpoint so they read as intent, not as an order you gave.
    for (const intent of sim.enemyIntents()) {
      const actor = sim.entity(intent.actorId);
      const to = intent.destination ?? (intent.targetId ? sim.entity(intent.targetId)?.position : undefined);
      if (!actor || !to || !actor.status.alive) continue;
      const from = actor.position;
      const color = intent.kind === "move" ? 0xff8c7a : 0xff5c5c;
      const fromY = terrainHeightAt(from) + 0.22;
      const toY = terrainHeightAt(to) + 0.22;
      this.orderRoot.add(makeLine(from, to, color, 0.5, fromY + 0.05, toY + 0.05));
      this.orderRoot.add(makeEndpoint(to, color, (intent.kind === "move" ? actor.radius : 0.3) + 0.2, toY + 0.035));
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
    // Placing a wall: a ghost of it, turned the way it will be built (T / Rotate turns it).
    if (sim.pendingBuild === "wall" && sim.selected) {
      const yaw = sim.placementYaw(sim.selected.position, point);
      const ok = !sim.buildFailureReason(sim.selected, "wall", point);
      const ghost = new THREE.Mesh(wallGhostGeometry(), wallGhostMaterial(ok));
      ghost.position.set(point.x, drawnGroundAt(point) + 0.78, point.z);
      ghost.rotation.y = yaw;
      this.groundAimRoot.add(ghost);
      return;
    }
    // Targeting a support power: draw the strike footprint instead of a weapon arc.
    if (sim.pendingSupport) {
      this.drawSupportReticle(sim, sim.pendingSupport, point);
      return;
    }
    // Placing a troop: a ghost footprint where it would actually stand (snapped to the nearest
    // clear spot), green when the spot is accepted, red when the click would be rejected.
    if (sim.pendingDeploy && sim.deployPlacement()) {
      this.drawDeployGhost(sim, sim.pendingDeploy, point);
      return;
    }
    // Choosing a move: the path it would really walk, draped on the ground, with a climb marker at
    // every step up — so "this goes up onto the slab" reads before the click, not after.
    if (sim.intent === "move") {
      const move = sim.previewMoveTo(point);
      const actor = sim.selected;
      if (!move || !actor) return;
      addDrapedMovePath(this.groundAimRoot, move.from, move.to, 0x9dfcff, 0.24);
      this.groundAimRoot.add(makeEndpoint(move.to, 0x9dfcff, actor.radius + 0.22, drawnGroundAt(move.to) + 0.26));
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

  private drawDeployGhost(sim: TacticalSim, kind: TroopKind, point: Vec2): void {
    const spot = sim.deployPointPreview(sim.selected, kind, point);
    const ok = !spot.reason;
    // Saturated, not the ring's pale mint: the ghost sits ON the placement disc and has to read
    // against it; the same red as a blocked shot when the click would be rejected.
    const color = ok ? 0x2ee88a : 0xff3b5c;
    const pulse = (Math.sin(performance.now() * 0.008) + 1) * 0.5;
    const y = terrainHeightAt(spot.point) + 0.12;
    const footprint = 0.7 + pulse * 0.08;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(footprint - 0.2, footprint, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(spot.point.x, y, spot.point.z);
    this.groundAimRoot.add(ring);
    this.groundAimRoot.add(makeEndpoint(spot.point, color, 0.22, y));
    // A snapped spot keeps a thin tether back to the cursor so the slide reads as deliberate.
    if (spot.snapped) this.groundAimRoot.add(makeLine(point, spot.point, color, 0.6, y));
  }

  // The hover footprint while calling in a support power: line of bomb circles (airstrike),
  // a wide saturation disc (cluster), or the burning beam line (laser). Line powers align
  // away from the calling base, so the preview shows the true strike axis.
  private drawSupportReticle(sim: TacticalSim, kind: string, point: Vec2): void {
    const base = sim.selected;
    // The line runs the way the player turned it (sim.placementTurn), same as the strike will fly.
    const yaw = sim.placementYaw(base?.position ?? { x: point.x - 1, z: point.z }, point);
    const dir = { x: Math.sin(yaw), z: Math.cos(yaw) };
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
    } else if (kind === "smokescreen") {
      this.groundAimRoot.add(makeSplashDisc(point, 0xc9d3dc, 3)); // SMOKE_RADIUS
      this.groundAimRoot.add(makeEndpoint(point, 0xc9d3dc, 0.6, y));
    } else if (kind === "resupply") {
      this.groundAimRoot.add(makeSplashDisc(point, 0x9ef0b8, 4)); // RESUPPLY_RADIUS
      this.groundAimRoot.add(makeEndpoint(point, 0x9ef0b8, 0.6, y));
    } else if (kind === "reconsweep") {
      // No footprint: it maps the whole enemy army. Just mark the click.
      this.groundAimRoot.add(makeEndpoint(point, 0x9dd8ff, 0.8 + pulse * 0.2, y));
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

  /** Bombers mid-carpet: draw the fall the sim resolves in a single tick (makeCarpetFall). Runs
   *  after syncProjectiles, which clears the root this adds to. */
  private syncCarpetFalls(sim: TacticalSim): void {
    if (sim.phase !== "resolve") return;
    for (const order of sim.orders) {
      if (order.done || order.fired || order.kind !== "grenade") continue;
      const actor = sim.entity(order.actorId);
      if (!actor || actor.kind !== "bomber" || !actor.status.alive) continue;
      const u = carpetFallU(order.elapsed);
      if (u <= 0) continue;
      const top = actor.elevation - 0.6; // the bay, under the fuselage
      for (const part of makeCarpetFall(carpetDropPoints(actor), u, top, actor.team === "player" ? 0x75d8ff : 0xff765f)) this.projectileRoot.add(part);
    }
  }

  private syncProjectiles(projectiles: readonly Projectile[]): void {
    this.disposeAndClear(this.projectileRoot);
    const liveIds = new Set<string>();
    const seen = new Map<string, { family: ProjectileFamily; dirX: number; dirZ: number; x: number; z: number; ground: number }>();
    for (const projectile of projectiles) {
      liveIds.add(projectile.id);
      const family = projectileFamily(projectile);

      // Position history feeds every trail (tapered ribbon, smoke puffs, the flame chain).
      let history = this.trailHistory.get(projectile.id);
      if (!history) {
        history = [];
        this.trailHistory.set(projectile.id, history);
      }
      pushTrailPoint(history, projectile, family);

      // Everything a round draws lives in projectileFx.ts: the body, its trail, its ground shadow
      // and the muzzle event. Nothing here is frustum-culled — a fast/high round near a screen edge
      // would otherwise vanish while its un-culled trail lingers.
      for (const part of makeProjectileTrail(projectile, family, history)) this.projectileRoot.add(part);
      // Only LOBBED rounds cast a ground shadow -- it is how you read where a shell or grenade will
      // land. A flat tracer's shadow was a dark disc sliding over the ground unattached to anything.
      if (isLobbed(family)) this.projectileRoot.add(makeProjectileShadow(projectile, family));
      const flash = makeMuzzleFlash(projectile, family);
      if (flash) this.projectileRoot.add(flash);
      const model = makeProjectileModel(projectile, family);
      model.position.set(projectile.position.x, projectile.height, projectile.position.z);
      orientAlongVelocity(
        model,
        { x: projectile.previous.x, y: projectile.previousHeight, z: projectile.previous.z },
        { x: projectile.position.x, y: projectile.height, z: projectile.position.z },
      );
      model.traverse((o) => { o.frustumCulled = false; });
      this.projectileRoot.add(model);
      // Remember the family and the line of flight: an impact/blast is drawn in the shape of the
      // gun that fired it, and its sparks fly back along the round's own path.
      const len = Math.hypot(projectile.direction.x, projectile.direction.z) || 1;
      seen.set(projectile.id, {
        family, dirX: projectile.direction.x / len, dirZ: projectile.direction.z / len,
        x: projectile.position.x, z: projectile.position.z, ground: terrainHeightAt(projectile.position),
      });
      this.landingHints.set(projectile.id, { family, dirX: projectile.direction.x / len, dirZ: projectile.direction.z / len });
    }
    // A round that vanished this frame: if it was small arms and nothing exploded, it chewed the
    // ground where it stopped — the cue that says a burst walked across the dirt.
    for (const id of this.trailHistory.keys()) {
      if (liveIds.has(id)) continue;
      const last = this.lastSeenProjectile.get(id);
      if (last && isSmallArms(last.family) && this.groundChews.length < 14) {
        this.groundChews.push({ x: last.x, z: last.z, at: performance.now(), seed: hash(id) % 997, size: last.family === "mg" ? 1.15 : last.family === "pellet" ? 0.8 : 1 });
      }
      this.trailHistory.delete(id);
    }
    this.lastSeenProjectile.clear();
    for (const [id, rec] of seen) this.lastSeenProjectile.set(id, rec);
    if (this.landingHints.size > 300) {
      for (const id of this.landingHints.keys()) { if (!liveIds.has(id)) this.landingHints.delete(id); if (this.landingHints.size <= 150) break; }
    }
    this.syncGroundChews();
  }

  /** The dirt kicked up where small-arms rounds stopped, on the renderer's own clock. */
  private syncGroundChews(): void {
    const now = performance.now();
    for (let i = this.groundChews.length - 1; i >= 0; i -= 1) {
      const chew = this.groundChews[i];
      const t = (now - chew.at) / (GROUND_CHEW_S * 1000);
      if (t >= 1) { this.groundChews.splice(i, 1); continue; }
      for (const part of makeGroundChew(chew.x, chew.z, t, terrainHeightAt({ x: chew.x, z: chew.z }), chew.seed, chew.size)) this.projectileRoot.add(part);
    }
  }

  /** Claim the stalest pooled light and flash it at a world point (muzzle or blast). */
  /** Capture seam (__rht.debugKill): record a killing blow of `mag` shoving toward +x. */
  /**
   * TERRAIN-CLIP AUDIT (2026-09-22, owner: a unit's weapon stuck into the map on the title screen).
   * For every living ground unit, every part mesh's world bounding box is sampled at its corners
   * and centre; a sample that sits more than `tolerance` BELOW the drawn ground at its x/z is inside
   * the terrain. Boots may touch the ground (the tolerance); a rifle, pack or hull inside a mesa may not.
   */
  auditTerrainClip(tolerance = 0.12): { id: string; name: string; kind: string; part: string; depth: number; x: number; z: number }[] {
    const out: { id: string; name: string; kind: string; part: string; depth: number; x: number; z: number }[] = [];
    const box = new THREE.Box3();
    for (const [id, group] of this.groups) {
      if (!group.visible || group.userData.diedAt !== undefined) continue;
      const ent = group.userData.entitySnapshot as { name: string; kind: string; flying?: boolean } | undefined;
      if (!ent || ent.kind === "cover" || ent.flying) continue;
      group.updateMatrixWorld(true);
      let worst: { part: string; depth: number; x: number; z: number } | undefined;
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible || !m.userData.partId || m.userData.ink || m.userData.decor || m.userData.sunk) return;
        box.setFromObject(m);
        if (box.isEmpty()) return;
        const xs = [box.min.x, (box.min.x + box.max.x) / 2, box.max.x];
        const zs = [box.min.z, (box.min.z + box.max.z) / 2, box.max.z];
        for (const x of xs) for (const z of zs) {
          const depth = drawnGroundAt({ x, z }) - box.min.y;
          if (depth > tolerance && (!worst || depth > worst.depth)) worst = { part: String(m.userData.partId), depth, x, z };
        }
      });
      if (worst) out.push({ id, name: ent.name, kind: ent.kind, ...worst });
    }
    return out.sort((a, b) => b.depth - a.depth);
  }

  debugFlinch(entityId: string, mag: number): void {
    this.flinchByEntity.set(entityId, { at: performance.now(), mag, dx: 1, dz: 0 });
  }

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
      // BRASS. Small guns kick a casing out sideways and up; it tumbles, catches the light and
      // bounces once. Almost free, and it is the cue that says "gun" rather than "laser".
      if (!heavy) {
        fx.directionalBurst({
          x: projectile.origin.x - projectile.direction.x * 0.35,
          y: projectile.originHeight - 0.05,
          z: projectile.origin.z - projectile.direction.z * 0.35,
          dirX: -projectile.direction.z, dirY: 1.2, dirZ: projectile.direction.x,
          count: 1, color: [0xe0b05a, 0xc9963f], speed: [1.6, 2.6], spread: 0.35,
          size: [0.035, 0.05], life: [0.7, 1.0], gravity: 9, drag: 0.3, shape: ParticleShape.shard,
        });
      }
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
      // HIT REACTION. Every landing round shoves what it lands on or beside, whether or not the sim
      // recorded damage for it: a shell bursting at a trooper's feet, a burn tick, a bomb — the body
      // lurches away from the point of impact (rifle/melee already flinch through the damage report;
      // this is the same spring, keyed off the visual event so no family can land silently).
      if (effect.type === "blast" || effect.type === "impact" || effect.type === "bolt") {
        const radius = (effect.radius ?? 0.5) + (effect.type === "blast" ? 0.6 : 0.2);
        // A long-lived impact is a SHOVE (sim resolveShove): a heavy blow, so its victim's death is thrown.
        const power = effect.type === "blast" ? Math.min(1.4, 0.5 + (effect.radius ?? 1) * 0.3) : effect.type === "impact" && effect.duration >= 0.9 ? 1.1 : 0.55;
        this.shoveNear(sim, effect.to, radius, power, effect.type === "impact" && dist(effect.from, effect.to) > 0.05 ? effect.from : undefined);
      }

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
      } else if (effect.type === "strike") {
        // A blade or butt landing: a bright arc of streaks sweeping across the target at chest
        // height, a spray of dark shards flying ON through it, and a puff of dust at the feet.
        // Pointedly NOT a fireball -- melee used to reuse the blast, and a knife that explodes
        // reads as a grenade.
        const dx = effect.to.x - effect.from.x;
        const dz = effect.to.z - effect.from.z;
        const len = Math.hypot(dx, dz) || 1;
        const px = -dz / len;
        const pz = dx / len;
        for (let i = 0; i < 9; i += 1) {
          const a = (i / 8 - 0.5) * 1.9;
          fx.directionalBurst({
            x: effect.to.x + px * Math.sin(a) * 0.5, y: ground + 0.95 + Math.cos(a) * 0.45, z: effect.to.z + pz * Math.sin(a) * 0.5,
            dirX: px * Math.cos(a), dirY: -Math.sin(a) * 0.6, dirZ: pz * Math.cos(a),
            count: 2, color: [0xffffff, effect.color], speed: [4, 7], spread: 0.15,
            size: [0.05, 0.12], life: [0.1, 0.22], gravity: 0, drag: 6, shape: ParticleShape.streak,
          });
        }
        fx.directionalBurst({
          x: effect.to.x, y: ground + 0.9, z: effect.to.z,
          dirX: dx / len, dirY: 0.5, dirZ: dz / len,
          count: 12, color: [0x3a322b, 0x6b5f52, 0xffe0b0], speed: [2.5, 6.5], spread: 0.7,
          size: [0.05, 0.12], life: [0.25, 0.6], gravity: 8, drag: 0.8, shape: ParticleShape.shard,
        });
        fx.burst({
          x: effect.to.x, y: ground + 0.15, z: effect.to.z,
          count: 8, color: [0x8a8078, 0xa89e92], speed: [0.8, 2.2], up: 0.5,
          size: [0.25, 0.5], life: [0.4, 0.9], gravity: -0.3, drag: 2, jitter: 0.3,
        });
        // The struck body staggers harder than a bullet hit would move it.
        for (const [id, rec] of this.flinchByEntity) {
          const g = this.groups.get(id);
          if (g && Math.hypot(g.position.x - effect.to.x, g.position.z - effect.to.z) < 0.9) {
            rec.mag = Math.min(1.4, rec.mag * 1.5 + 0.3);
            rec.dx = dx / len;
            rec.dz = dz / len;
          }
        }
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
      } else if (effect.type === "land") {
        fx.burst({
          x: effect.to.x, y: ground + 0.12, z: effect.to.z,
          count: 14, color: [0xa89e92, 0xcfc4b4], speed: [1.2, 3.2], up: 0.3, size: [0.25, 0.5],
          life: [0.4, 0.9], gravity: -0.2, drag: 2.2, jitter: 0.3,
        });
      } else if (effect.type === "bolt") {
        fx.burst({
          x: effect.to.x, y: ground + 0.3, z: effect.to.z,
          count: 24, color: [0xffffff, 0xd8ecff, 0x9fc8ff], speed: [3, 8], up: 0.7, size: [0.05, 0.14],
          life: [0.2, 0.6], gravity: 6, drag: 0.8, shape: ParticleShape.streak,
        });
        fx.burst({
          x: effect.to.x, y: ground + 0.4, z: effect.to.z,
          count: 10, color: [0x5e564e, 0x8c837a], speed: [0.6, 2.2], up: 0.9, size: [0.3, 0.7],
          life: [0.9, 1.8], gravity: -0.5, drag: 1.1, jitter: 0.3,
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
        for (const part of makeGunRun(effect, t, terrainHeightAt(effect.to), terrainHeightAt(effect.from))) this.effectRoot.add(part);
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
        const ground = terrainHeightAt(effect.to);
        const hint = this.hintFor(effect);
        for (const part of makeBlast(effect, t, ground, hint)) this.effectRoot.add(part);
        // Register the smoke column that outlives the sim's effect (drawn below on its own clock).
        const life = blastAfterlife(hint?.family, effect.color === 0xff7a2a);
        if (life > 0 && !this.blastEchoes.has(effect.id)) this.blastEchoes.set(effect.id, { effect, at: performance.now(), life, hint, ground });
      } else if (effect.type === "bolt") {
        // LIGHTNING: the jagged bolt, its forks, the ground flash and the debris live in the FX
        // module in the toon language (ink-rimmed white bars, no additive haze). Its shape is
        // rolled from the effect id, so command telegraph, resolve strike and a restored save all
        // draw the same bolt. The scorch star it leaves is kept for the battle.
        const ground = terrainHeightAt(effect.to);
        for (const part of makeLightning(effect, t, ground)) this.effectRoot.add(part);
        if (!this.scorchedIds.has(effect.id)) {
          this.scorchedIds.add(effect.id);
          this.craterRoot.add(makeScorchStar(effect, ground + (this.craterRoot.children.length % 7) * 0.0015, 1.3));
          if (this.craterRoot.children.length > 40) this.craterRoot.remove(this.craterRoot.children[0]);
        }
      } else if (effect.type === "land") {
        // A jump trooper touching down: a ring of dust pushed outward, nothing on the body.
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.2 + t * 1.3, 0.3 + t * 1.3, 32),
          new THREE.MeshBasicMaterial({ color: 0xd9cfbf, transparent: true, opacity: opacity * 0.5, side: THREE.DoubleSide, depthWrite: false })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(effect.to.x, terrainHeightAt(effect.to) + 0.06, effect.to.z);
        this.effectRoot.add(ring);
      } else if (effect.type === "strike") {
        // SLASH ARC: a bright crescent at chest height, swept from the striker's hand THROUGH the
        // target over the effect's life, plus a small hard flash at the contact point and a tight
        // ground ring. Deliberately no dome: a blow is a line, not a volume.
        const dx = effect.to.x - effect.from.x;
        const dz = effect.to.z - effect.from.z;
        const len = Math.hypot(dx, dz) || 1;
        const heading = Math.atan2(dx, dz);
        const sweep = 1.3; // radians of total swing
        const arc = new THREE.Mesh(
          new THREE.TorusGeometry(Math.min(1.3, Math.max(0.6, len * 0.95)), 0.06 + (1 - t) * 0.05, 5, 20, sweep * 0.55),
          new THREE.MeshBasicMaterial({ color: t < 0.3 ? 0xffffff : effect.color, transparent: true, opacity: opacity * 0.9, depthWrite: false, blending: THREE.AdditiveBlending })
        );
        arc.rotation.x = -Math.PI / 2;
        // Torus arcs run from +X in its local plane; after the flat rotation, local +X is world +X
        // and the arc grows toward world -Z, so a yaw of (heading - PI/2) points its start at the
        // target and the sweep term carries it across.
        arc.rotation.z = heading - Math.PI / 2 - sweep * 0.55 + sweep * Math.min(1, t * 1.6);
        arc.position.set(effect.from.x, terrainHeightAt(effect.from) + 0.95, effect.from.z);
        this.effectRoot.add(arc);
        // The contact flash is a flat ink-rimmed star facing the camera — the same language as
        // every other hit in the game, and no additive ball.
        for (const part of makeStrikeFlash(effect, t, terrainHeightAt(effect.to))) this.effectRoot.add(part);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.3 + t * 0.6, 0.34 + t * 0.6, 24),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.5, side: THREE.DoubleSide, depthWrite: false })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(effect.to.x, terrainHeightAt(effect.to) + 0.1, effect.to.z);
        this.effectRoot.add(ring);
      } else if (effect.type === "impact") {
        for (const part of makeImpact(effect, t, terrainHeightAt(effect.to), this.hintFor(effect))) this.effectRoot.add(part);
      } else {
        for (const part of makePing(effect, t, terrainHeightAt(effect.to))) this.effectRoot.add(part);
      }
    }
    this.syncBlastEchoes();
  }

  /** The smoke column and settling dust crown a blast leaves after the sim's effect has ended. */
  private syncBlastEchoes(): void {
    const now = performance.now();
    for (const [id, echo] of this.blastEchoes) {
      const u = (now - echo.at) / (echo.life * 1000);
      if (u >= 1) { this.blastEchoes.delete(id); continue; }
      for (const part of makeBlastAfterlife(echo.effect, u, echo.ground, echo.hint)) this.effectRoot.add(part);
    }
    if (this.blastEchoes.size > 60) { const first = this.blastEchoes.keys().next().value; if (first) this.blastEchoes.delete(first); }
  }

  /** What was flying when this effect fired, if the renderer saw the round. Sim effect ids and
   *  projectile ids share a suffix; the last round to pass within a metre is the fallback. */
  private hintFor(effect: VisualEvent): LandingHint | undefined {
    const direct = this.landingHints.get(effect.id);
    if (direct) return direct;
    let best: LandingHint | undefined;
    let bestD = 2.2;
    for (const [id, rec] of this.lastSeenProjectile) {
      void id;
      const d = Math.hypot(rec.x - effect.to.x, rec.z - effect.to.z);
      if (d < bestD) { bestD = d; best = { family: rec.family, dirX: rec.dirX, dirZ: rec.dirZ }; }
    }
    return best;
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
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + 0.035, 24),
    ringMaterial
  );
  ring.rotation.x = -Math.PI / 2;
  // The ring alone: the white pip that sat inside it bloomed into a soft white blob over every
  // unit -- the brightest thing above an aircraft, and part of why the flyers read blurry.
  group.userData.ringMaterial = ringMaterial;
  group.add(ring);
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

/**
 * Ground overlays are flat discs rotated onto XZ. On stepped terrain a flat disc at the actor's
 * elevation sinks into the next mesa and hangs in the air past a ledge — the "range circle
 * breaks" report. This pulls every vertex of a laid-flat mesh down (or up) to the ground under
 * it, in the mesh's own frame, so the shape follows the steps. Assumes rotation.x === -PI/2 and
 * uniform scale; the mesh's position.y is the reference the offsets are measured from.
 */
let _waveStrokes: THREE.CanvasTexture | undefined;
/**
 * Toon water: a tiling multiplier texture of sparse pale wave arcs on white (the material colour
 * supplies the hue, like the ground texture). Reads as "water, not floor" at any zoom.
 */
function waveStrokeTexture(): THREE.CanvasTexture {
  if (_waveStrokes) return _waveStrokes;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b9c9d3";
  ctx.fillRect(0, 0, size, size);
  let seed = 0xa11ce;
  const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  // Draw each stroke at its position and at the wrapped positions so the tile is seamless.
  for (let i = 0; i < 14; i += 1) {
    const x = rand() * size, y = rand() * size, len = 26 + rand() * 34, lw = 4 + rand() * 3;
    ctx.lineWidth = lw;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.quadraticCurveTo(x + ox + len * 0.5, y + oy - len * 0.22, x + ox + len, y + oy);
      ctx.stroke();
    }
  }
  // A few darker troughs so the surface has two values, not one.
  ctx.strokeStyle = "#7f97a6";
  for (let i = 0; i < 8; i += 1) {
    const x = rand() * size, y = rand() * size, len = 18 + rand() * 24;
    ctx.lineWidth = 2.5;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.quadraticCurveTo(x + ox + len * 0.5, y + oy + len * 0.2, x + ox + len, y + oy);
      ctx.stroke();
    }
  }
  _waveStrokes = new THREE.CanvasTexture(canvas);
  _waveStrokes.wrapS = _waveStrokes.wrapT = THREE.RepeatWrapping;
  _waveStrokes.colorSpace = THREE.SRGBColorSpace;
  return _waveStrokes;
}

/**
 * Artillery outriggers: four dark legs with pads, splayed from the hull's corners, shown only while
 * the piece is DEPLOYED (`entity.deployed`) — the one visible "this cannot move now" cue.
 */
function makeOutriggers(): THREE.Group {
  const group = new THREE.Group();
  group.userData.outriggers = true;
  // Hidden by SCALE, not `visible`: an invisible mesh is skipped by warmUp's traverseVisible and
  // would compile its program the first time a piece deploys mid-resolve.
  group.scale.setScalar(0.001);
  const legMat = new THREE.MeshToonMaterial({ color: 0x2c3136, gradientMap: toonGradient() });
  const padMat = new THREE.MeshToonMaterial({ color: 0x1c2024, gradientMap: toonGradient() });
  legMat.userData.shared = true; padMat.userData.shared = true;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 1.1), legMat);
    const ang = Math.atan2(sx, sz);
    leg.position.set(sx * 1.0, 0.32, sz * 1.0);
    leg.rotation.y = ang;
    leg.rotation.x = -0.35;
    leg.castShadow = true;
    group.add(leg);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.08, 12), padMat);
    pad.position.set(sx * 1.45, 0.04, sz * 1.45);
    group.add(pad);
  }
  return group;
}

let _discMask: THREE.CanvasTexture | undefined;
/** A hard-edged white disc on transparent — turns a subdivided square plane into a fillable circle. */
function discMaskTexture(): THREE.CanvasTexture {
  if (_discMask) return _discMask;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2); ctx.fill();
  _discMask = new THREE.CanvasTexture(canvas);
  return _discMask;
}

/** The ground as DRAWN: talus tiers and the cosmetic plates both rise above terrainHeightAt. */
function drawnGroundAt(p: Vec2): number {
  return Math.max(visualGroundAt(p), terrainHeightAt(p) + plateLiftAt(p, terrainHeightAt(p)));
}

/**
 * A flat ground ring/disc (inner 0 = filled) laid over the DRAWN ground in world space, cached by its
 * arguments and marked shared so the per-frame overlay rebuilds reuse it. A disc placed flat at the
 * sim height buried itself in the next plate or step -- a pickup ring read as a tan comma with the
 * coin floating over it. Cache is cleared per map (clearDrapedDiscs).
 */
const drapedDiscs = new Map<string, THREE.BufferGeometry>();
function drapedDisc(x: number, z: number, inner: number, outer: number, segments: number, lift: number): THREE.BufferGeometry {
  const key = [x, z, inner, outer].map((n) => n.toFixed(2)).join(",") + `,${segments},${lift}`;
  let geo = drapedDiscs.get(key);
  if (geo) return geo;
  // Filled discs get radial rings too, so their interior follows a step instead of bridging it.
  const rings = Math.max(1, Math.min(12, Math.ceil((outer - inner) / 0.45)));
  geo = new THREE.RingGeometry(inner, outer, segments, rings).rotateX(-Math.PI / 2).translate(x, 0, z);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) pos.setY(i, drawnGroundAt({ x: pos.getX(i), z: pos.getZ(i) }) + lift);
  geo.computeBoundingSphere();
  geo.userData.shared = true;
  drapedDiscs.set(key, geo);
  return geo;
}
function clearDrapedDiscs(): void {
  for (const geo of drapedDiscs.values()) geo.dispose();
  drapedDiscs.clear();
}

const DRAPE_TAPS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
function drapeToTerrain(mesh: THREE.Mesh, lift: number): void {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const s = mesh.scale.x || 1;
  // The flat layout, kept from the first drape: vertices are clamped below, and a ring that moves
  // must re-drape from its true shape, not from last time's clamped one.
  const flat = (mesh.geometry.userData.flatXY as Float32Array | undefined) ?? (mesh.geometry.userData.flatXY = Float32Array.from({ length: pos.count * 2 }, (_, k) => (k % 2 ? pos.getY(k >> 1) : pos.getX(k >> 1))));
  const b = ARENA_BOUNDS;
  const params = (mesh.geometry as THREE.PlaneGeometry).parameters;
  const reach = mesh.geometry.type === "PlaneGeometry" ? (params.width / params.widthSegments) * s * 0.5 : 0;
  for (let i = 0; i < pos.count; i += 1) {
    // Clamped to the arena: past the edge the ground drops or climbs the boundary wall, and a
    // triangle spanning that lip pierced the wall in a sawtooth (the "teeth" beside the Ironworks
    // base, 2026-09-23). Nothing an overlay marks can be outside the arena anyway.
    const wx = clamp(mesh.position.x + flat[i * 2] * s, b.minX, b.maxX);
    const wz = clamp(mesh.position.z - flat[i * 2 + 1] * s, b.minZ, b.maxZ); // local +y is world -z once laid flat
    pos.setX(i, (wx - mesh.position.x) / s);
    pos.setY(i, (mesh.position.z - wz) / s);
    // A filled plane's triangle spanning a lip (flat vertex below, rim-top vertex above) cuts UNDER
    // the talus slope between them and is hidden in a stripe per grid cell -- the sawtooth. So a
    // plane vertex rides the highest ground within half a cell: triangles pass over a lip, never
    // into it. Thin rings (not planes) keep the exact point sample.
    let ground = drawnGroundAt({ x: wx, z: wz });
    if (reach > 0) {
      for (const [dx, dz] of DRAPE_TAPS) ground = Math.max(ground, drawnGroundAt({ x: wx + dx * reach, z: wz + dz * reach }));
    }
    pos.setZ(i, (ground + lift - mesh.position.y) / s);
  }
  pos.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}

function makeSplashDisc(position: Vec2, color: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  const y = terrainHeightAt(position) + 0.085;
  const fill = new THREE.Mesh(
    new THREE.RingGeometry(0, radius, 64, 6), // radial rings so the drape follows a step
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
  // Draped like the move field: a flat disc at the landing height sank into the next step.
  drapeToTerrain(fill, 0.085);
  drapeToTerrain(ring, 0.097);
  group.add(fill, ring);
  return group;
}

// How long a floating damage number lives, how long a hit-flash on a part lasts (ms), and the
// cap on concurrent floating numbers (bounds worst-case draw calls in a huge melee).
const DAMAGE_NUMBER_MS = 950;
const DAMAGE_FLASH_MS = 320;
// How long a whole-body hit flinch lasts (ms). Short + snappy — a strike, not a stumble.
const FLINCH_MS = 300;
// A dead unit stays on the board this long: the fall, a beat, then it sinks away.
type DeathStyle = "thrown" | "crumple" | "spin" | "wreck" | "spiral";
/** How long a dead unit stays on the board, per family (wrecks and crashes need time to read). */
function deathMs(entity: CombatEntity): number {
  return isAirKind(entity.kind) ? 3800 : isVehicleKind(entity.kind) ? 4200 : 2600;
}
function deathStyle(entity: CombatEntity, killingBlow: number): DeathStyle {
  if (isAirKind(entity.kind)) return "spiral";
  if (!isInfantryKind(entity.kind)) return "wreck";
  if (killingBlow >= 0.6) return "thrown";
  return hash(entity.id) % 2 ? "crumple" : "spin";
}
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

// Firing recoil window (seconds) and how long debris chunks lie before sinking out of sight.
const RECOIL_TIME = 0.16;
// Debris chunks lie for this long, then sink out of sight over the second span (seconds).
const DEBRIS_SINK_AT = 14;
const DEBRIS_SINK_FOR = 4;

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

/**
 * FACTION LOOK (2026-09-22, owner: "each faction ... looks different"). Which faction each team
 * fields, read from the sim every frame, and the CAMO each faction paints its hulls, bases and
 * uniforms. The team read (red vs blue marker, trim and glow) is layered on top in roleColor, so two
 * armies of the same faction still tell apart; two different factions now also look different.
 *   Vanguard  -- slate blue-grey: clean, issued, regular army.
 *   Syndicate -- desert tan / rust: scrappy irregulars.
 *   Bastion   -- olive-grey concrete: heavy, fortified.
 */
const FACTION_OF_TEAM: Partial<Record<Team, FactionId>> = {};
const FACTION_CAMO: Record<FactionId, number> = { vanguard: 0x4f6d86, syndicate: 0x9d7046, bastion: 0x676e4c };
/** Each faction's helmet: the one-glance read on a rank (kept under ~180 luminance, see audit:unit). */
const FACTION_HELMET: Record<FactionId, number> = { vanguard: 0xa9b6bc, syndicate: 0x9a4a2c, bastion: 0x5d6548 };
function factionOfEntity(entity: CombatEntity): FactionId | undefined {
  return entity.kind === "cover" || entity.team === "neutral" ? undefined : FACTION_OF_TEAM[entity.team];
}

function roleColor(entity: CombatEntity, role: PartRole, fallback: number): number {
  const faction = factionOfEntity(entity);
  if (faction && role !== "weapon" && role !== "head") {
    // Machines and buildings wear the faction camo strongly; troopers keep most of their kind's
    // own hue (scout green, medic red...) so the roster still reads, with the camo under it.
    const machine = !isInfantryKind(entity.kind);
    // Infantry went 0.28 -> 0.42 (2026-09-23): at 0.28 the kind's own hue won outright and two
    // factions' riflemen were the same green man. The kind still carries its accent and outline.
    fallback = blendHex(fallback, FACTION_CAMO[faction], machine ? 0.5 : 0.42);
  }
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
    return blendHex(blendHex(fallback, TEAMS.enemyBlend, 0.3), FACTION_TINT.enemy, 0.2);
  }
  if (entity.team === "player") {
    if (role === "weapon") return blendHex(fallback, 0x9fdcf0, 0.11);
    if (role === "mobility") return blendHex(fallback, 0x172328, 0.6);
    if (role === "head") return blendHex(fallback, 0xbfae90, 0.18);
    if (role === "utility") return blendHex(fallback, 0x8ff2d1, 0.45);
    if (role === "volatile") return blendHex(fallback, 0xffd06a, 0.5);
    // Structures wear the team hue on their CORE, which is most of an emplacement's surface, so a
    // 0.26 blend toward a light cyan turned dark steel and brown sandbags alike into pale teal.
    // Buildings get a lighter touch than a trooper's bodysuit does.
    // A LIGHT TOUCH ON THE BODY. At the distance this game is played a trooper is about forty
    // pixels tall, and at that size the only things that read are its overall hue, its mass, and one
    // bright accent. Blending every unit a quarter of the way to the same faction cyan turned a
    // roster of authored hues -- scout green, sniper blue, striker violet, heavy rust, medic red,
    // engineer amber -- into six identical teal blobs. The team read is carried by the marker ring
    // above each unit and by the accent trim; the hull only needs a hint of it.
    if (role === "core") return blendHex(fallback, FACTION_TINT.playerCore, isBuildingKind(entity.kind) || isDefenseKind(entity.kind) ? 0.14 : 0.12);
    return blendHex(fallback, FACTION_TINT.player, 0.1);
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

/**
 * A move line laid over the DRAWN ground. It used to be one straight tube between the two endpoint
 * heights, which cut through any slab or step in between and vanished under it. Plus an amber
 * climb marker at every step UP the sim terrain takes on the way (the same terrain the walk uses).
 */
function addDrapedMovePath(root: THREE.Object3D, from: Vec2, to: Vec2, color: number, opacity: number): void {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  if (length < 0.05) return;
  const steps = Math.max(1, Math.ceil(length / 0.3));
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    points.push(new THREE.Vector3(p.x, drawnGroundAt(p) + 0.24, p.z));
  }
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 1; i < points.length; i += 1) path.add(new THREE.LineCurve3(points[i - 1], points[i]));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(path, steps * 2, 0.028, 6, false), tubeMaterial(color, opacity));
  tube.frustumCulled = false;
  root.add(tube);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial(color, 0.62));
  line.position.y = 0.05;
  root.add(line);
  for (const climb of climbsAlong(from, to)) root.add(makeClimbMarker(climb.point));
}

// A "▲ CLIMB" tag standing over the lip of a climb: an amber pill with an ink rim, the UI's toon
// language. A 3D arrow read as a diamond from the tactical camera; words and a caret read from any angle.
let climbTagMaterial: THREE.SpriteMaterial | undefined;
function makeClimbMarker(at: Vec2): THREE.Sprite {
  if (!climbTagMaterial) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#14181c";
      ctx.beginPath(); ctx.roundRect(4, 4, 248, 88, 22); ctx.fill();
      ctx.fillStyle = "#ffc24d";
      ctx.beginPath(); ctx.roundRect(12, 12, 232, 72, 16); ctx.fill();
      ctx.fillStyle = "#14181c";
      ctx.font = "900 44px Rajdhani, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("▲ CLIMB", 128, 50);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    climbTagMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    climbTagMaterial.userData.shared = true;
  }
  const tag = new THREE.Sprite(climbTagMaterial);
  tag.scale.set(1.2, 0.45, 1);
  tag.position.set(at.x, drawnGroundAt(at) + 0.75, at.z);
  tag.renderOrder = 10;
  return tag;
}

let _wallGhost: THREE.BoxGeometry | undefined;
function wallGhostGeometry(): THREE.BoxGeometry {
  if (!_wallGhost) { _wallGhost = new THREE.BoxGeometry(2.15, 1.55, 0.62); _wallGhost.userData.shared = true; }
  return _wallGhost;
}
function wallGhostMaterial(ok: boolean): THREE.MeshBasicMaterial {
  return tubeMaterial(ok ? 0x8ef2d1 : 0xff765f, 0.45);
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
  heavy: { girth: 1.22, stature: 0.92, lean: 0.05 }, // bulk comes from the kit; 1.52 stretched every rotated part into a slab
  flamer: { girth: 1.34, stature: 0.94 },
  striker: { girth: 1.06, stature: 1.04, lean: 0.24 },
  scout: { girth: 0.72, stature: 1.14, lean: 0.14 },
  sniper: { girth: 0.78, stature: 1.09, lean: 0.18 },
  sapper: { girth: 1.0, stature: 0.88, lean: 0.18 },
  mortar: { girth: 1.2, stature: 0.94 },
  grenadier: { girth: 1.22, stature: 0.96 },
  medic: { girth: 0.86, stature: 1.06 },
  engineer: { girth: 1.08, stature: 0.96 },
  droneop: { girth: 0.84, stature: 1.08 },
};

const DEFAULT_BUILD: InfantryBuild = { girth: 1, stature: 1, lean: 0 };

// PER-KIND CHASSIS PARTS (2026-09-20). Which authored torso / arm / leg variant a kind wears, the
// `size` each is scaled to (a variant with shelf pauldrons or a ghillie ruff is normalised into
// the same unit cube as the plain chest, so it needs a wider box to come out the same scale), and
// whether the shared procedural pauldrons / rucksack still belong on top. Shape lives in
// art/infantry/author_bodies.py; proportion lives here — same rule as every kit part.
interface InfantryKitParts {
  torso: KitPart;
  torsoSize: [number, number, number];
  armL: KitPart;
  armR: KitPart;
  armSize: [number, number, number];
  leg: KitPart;
  legSize: [number, number, number];
  /** Shared procedural shoulder plates on top of the torso. Off when the torso carries its own. */
  pauldrons: boolean;
  /** The generic rucksack. Off when the kind has an authored back piece in that slot. */
  rucksack: boolean;
}

const DEFAULT_KIT_PARTS: InfantryKitParts = {
  torso: "torso", torsoSize: [0.58, 0.64, 0.42],
  armL: "arm", armR: "arm", armSize: [0.2, 0.62, 0.22],
  leg: "leg", legSize: [0.22, 0.5, 0.26],
  pauldrons: true, rucksack: true,
};

const INFANTRY_KIT_PARTS: Partial<Record<EntityKind, InfantryKitParts>> = {
  heavy: { ...DEFAULT_KIT_PARTS, torso: "torso-heavy", torsoSize: [0.8, 0.66, 0.5], armL: "arm-heavy", armR: "arm-heavy", armSize: [0.24, 0.62, 0.26], leg: "leg-heavy", legSize: [0.26, 0.5, 0.3], pauldrons: false, rucksack: false },
  scout: { ...DEFAULT_KIT_PARTS, torso: "torso-scout", torsoSize: [0.54, 0.64, 0.42], leg: "leg-scout", legSize: [0.2, 0.5, 0.26], pauldrons: false },
  sniper: { ...DEFAULT_KIT_PARTS, torso: "torso-sniper", torsoSize: [0.7, 0.64, 0.5], pauldrons: false },
  striker: { ...DEFAULT_KIT_PARTS, torso: "torso-striker", torsoSize: [0.7, 0.66, 0.44], armL: "arm-striker", pauldrons: false },
  medic: { ...DEFAULT_KIT_PARTS, torso: "torso-medic", torsoSize: [0.58, 0.64, 0.44], armL: "arm-medic", armR: "arm-medic" },
  engineer: { ...DEFAULT_KIT_PARTS, torso: "torso-engineer", torsoSize: [0.62, 0.64, 0.46], leg: "leg-engineer", legSize: [0.24, 0.5, 0.28] },
  flamer: { ...DEFAULT_KIT_PARTS, torso: "torso-flamer", torsoSize: [0.64, 0.64, 0.5], armL: "arm-flamer", armR: "arm-flamer", armSize: [0.24, 0.62, 0.26], pauldrons: false },
  droneop: { ...DEFAULT_KIT_PARTS, torso: "torso-droneop", torsoSize: [0.56, 0.64, 0.42], rucksack: false },
  sapper: { ...DEFAULT_KIT_PARTS, torso: "torso-sapper", torsoSize: [0.6, 0.64, 0.46], rucksack: false },
  mortar: { ...DEFAULT_KIT_PARTS, torso: "torso-mortar", torsoSize: [0.66, 0.64, 0.46], rucksack: false },
  grenadier: { ...DEFAULT_KIT_PARTS, torso: "torso-grenadier", torsoSize: [0.66, 0.64, 0.48] },
  jumper: { ...DEFAULT_KIT_PARTS, torso: "torso-jumper", torsoSize: [0.58, 0.64, 0.44], armL: "arm-jumper", armR: "arm-jumper", leg: "leg-jumper", legSize: [0.26, 0.5, 0.28] },
};

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
export type WeaponFamily = "rifle" | "burst" | "marksman" | "cannon" | "launcher" | "flamer" | "melee" | "shotgun" | "pistol" | "throw";
/** Every attack family, for the tests that must cover them all (a hand-kept list skipped two). */
export const WEAPON_FAMILIES: readonly WeaponFamily[] = ["rifle", "burst", "marksman", "cannon", "launcher", "flamer", "melee", "shotgun", "pistol", "throw"];

export function weaponFamily(kind: EntityKind): WeaponFamily {
  if (kind === "striker") return "melee";
  if (kind === "heavy") return "burst";
  if (kind === "sniper") return "marksman";
  if (kind === "grenadier" || kind === "mortar") return "launcher";
  if (kind === "flamer") return "flamer";
  if (kind === "sapper") return "shotgun";
  if (kind === "medic" || kind === "droneop") return "pistol";
  if (kind === "tank" || kind === "artillery" || kind === "exturret") return "cannon";
  return "rifle";
}

/**
 * Which choreography an ORDER plays on its actor, or undefined when the order is not an attack the
 * body animates. The one place that decides it: `computeAttackPhases` and the attack-coverage test
 * both read it, so an order kind can no longer be left out of the renderer's attack filter (the
 * mortar's smoke round fired from a motionless tube that way).
 */
export function attackFamilyForOrder(kind: EntityKind, orderKind: OrderKind): WeaponFamily | undefined {
  if (orderKind === "melee") return "melee";
  if (orderKind === "shoot" || orderKind === "smoke") return weaponFamily(kind);
  if (orderKind === "grenade") {
    // A hand grenade is THROWN: before this a Recruit raised its rifle and "fired" the grenade.
    // Aircraft bombs fall from a bay -- no gun to swing.
    if (isInfantryKind(kind)) return "throw";
    return isAirKind(kind) ? undefined : weaponFamily(kind);
  }
  return undefined;
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
  shotgun: { contact: 0.36, draw: 0.12, lift: 0.24, brace: 0.1 },
  pistol: { contact: 0.4, draw: 0.05, lift: 0.18, brace: 0.03 },
  // The rifle is lowered out of the way while the free arm throws (see throwArmAngle); the body
  // leans hard into the release. Contact = the sim's release (0.58s of a 1.15s order).
  throw: { contact: 0.5, draw: 0.08, lift: -0.22, brace: 0.3 },
};

/**
 * The THROWING arm's forward swing (radians about the shoulder, positive = hand forward/up) at
 * `phase`. One overhand windmill: the arm drops back and up behind the head, whips over the top
 * to release in front at head height (contact), follows through low, and comes round to hang at
 * rest again -- a full turn, so the end pose IS the rest pose (the angle ends at -2π).
 */
const THROW_KEYS: readonly [number, number][] = [[0, 0], [0.22, -0.9], [0.42, -2.5], [0.5, -3.95], [0.62, -4.95], [0.82, -5.9], [1, -Math.PI * 2]];
export function throwArmAngle(phase: number): number {
  const t = Math.max(0, Math.min(1, phase));
  for (let i = 1; i < THROW_KEYS.length; i += 1) {
    const [t1, a1] = THROW_KEYS[i];
    if (t > t1) continue;
    const [t0, a0] = THROW_KEYS[i - 1];
    // Catmull-Rom through the keys: continuous velocity, so the whip accelerates into the release
    // instead of changing speed at every key.
    const [tp, ap] = THROW_KEYS[Math.max(0, i - 2)];
    const [tn, an] = THROW_KEYS[Math.min(THROW_KEYS.length - 1, i + 1)];
    const u = (t - t0) / Math.max(1e-6, t1 - t0);
    const m0 = ((a1 - ap) / Math.max(1e-6, t1 - tp)) * (t1 - t0);
    const m1 = ((an - a0) / Math.max(1e-6, tn - t0)) * (t1 - t0);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * a0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * a1 + (u3 - u2) * m1;
  }
  return -Math.PI * 2;
}

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
    // HUE **AND** VALUE SPREAD. At forty pixels a unit is one colour, so neighbours in the roster
    // have to differ in more than shade: scout and sniper were adjacent greens/blues at the same
    // value, and the baseline recruit was a saturated teal competing with both. The baseline is
    // now the most desaturated thing on the field -- specialists are the ones that should pop --
    // and each pair that used to collide (scout/sniper, heavy/flamer, sniper/droneop,
    // grenadier/mortar) is pushed apart on value as well as hue.
    case "scout": return { body: 0x63b45c, trim: 0x36443c, pack: 0x24503a };
    case "sniper": return { body: 0x2f5570, trim: 0x2b3742, pack: 0x1b3a4e };
    case "striker": return { body: 0x7d51ad, trim: 0x3b3350, pack: 0x39235c };
    case "heavy": return { body: 0xa85a24, trim: 0x453930, pack: 0x4a2716 };
    case "grenadier": return { body: 0xd0a03a, trim: 0x4a4030, pack: 0x5c3510 };
    case "mortar": return { body: 0x7a6a34, trim: 0x46402f, pack: 0x54401a };
    case "medic": return { body: 0xc44a58, trim: 0x4a3a3d, pack: 0x5e2129 };
    case "engineer": return { body: 0xcaa227, trim: 0x474328, pack: 0x54481a };
    case "flamer": return { body: 0xb33418, trim: 0x4a3a30, pack: 0x6a2812 };
    case "droneop": return { body: 0x7f9fc4, trim: 0x3d4550, pack: 0x2c3f52 };
    case "jumper": return { body: 0x4e6b8c, trim: 0x2b3036, pack: 0x2f3a46 };
    case "sapper": return { body: 0x9c8c4c, trim: 0x46422f, pack: 0x4a3f1e };
    default: return { body: 0x6c7052, trim: 0x35424a, pack: 0x3a4438 };
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
    const alpha = 0.045 + rand() * 0.055;
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

  // ---- THE MAP'S OWN SURFACE ----------------------------------------------------------------
  // Everything above is generic ground: broad tone and weathering. What makes Dust Bowl read as a
  // dry pan and Ironworks as a slag yard is WHAT IS DRAWN HERE, not the tint applied over it. Five
  // maps sharing one generator with a different colour is most of why they felt like one map.
  const kind = theme.surface ?? "cracked";
  ctx.lineCap = "round";

  if (kind === "cracked" || kind === "ice") {
    // A branching fracture network. Dry-pan cracks are short, dark and many; ice fractures are
    // long, pale and few, and they run straighter.
    const count = kind === "ice" ? 12 : 22;
    const tone = kind === "ice" ? shade(1.5) : shade(0.5);
    const alpha = kind === "ice" ? 0.34 : 0.3;
    for (let i = 0; i < count; i += 1) {
      const x0 = rand() * size;
      const y0 = rand() * size;
      const steps = kind === "ice" ? 8 + Math.floor(rand() * 9) : 5 + Math.floor(rand() * 7);
      const step = kind === "ice" ? 30 + rand() * 44 : 14 + rand() * 26;
      let heading = rand() * Math.PI * 2;
      const pts: [number, number][] = [[0, 0]];
      for (let k = 0; k < steps; k += 1) {
        heading += (rand() - 0.5) * (kind === "ice" ? 0.4 : 1.1);
        const [lx, ly] = pts[pts.length - 1];
        pts.push([lx + Math.cos(heading) * step, ly + Math.sin(heading) * step]);
      }
      const width = kind === "ice" ? 1.4 + rand() * 1.6 : 0.8 + rand() * 1.3;
      wrapped(x0, y0, steps * step, (px, py) => {
        ctx.strokeStyle = css(tone, alpha);
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(px, py);
        for (const [dx, dy] of pts.slice(1)) ctx.lineTo(px + dx, py + dy);
        ctx.stroke();
      });
    }
  } else if (kind === "grass") {
    // Tufts: short strokes at a shared-ish lean, two tones, dense. No cracks — a meadow has none,
    // and drawing them anyway is what made the green map read as painted dirt.
    for (let i = 0; i < 2100; i += 1) {
      const x = rand() * size;
      const y = rand() * size;
      const len = 3 + rand() * 7;
      // Full-circle lean. A biased range gave every tuft a shared diagonal, and a shared
      // direction is exactly what makes an 11-unit tile repeat visible as banding.
      const lean = rand() * Math.PI * 2;
      const tone = shade(rand() < 0.5 ? 1.2 : 0.72, 0.4 + rand() * 0.5);
      wrapped(x, y, len + 2, (px, py) => {
        ctx.strokeStyle = css(tone, 0.18 + rand() * 0.2);
        ctx.lineWidth = 1 + rand();
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.sin(lean) * len, py - Math.cos(lean) * len);
        ctx.stroke();
      });
    }
  } else if (kind === "slag") {
    // Clinker: angular chips of burnt aggregate, high contrast, no organic curve anywhere.
    for (let i = 0; i < 1300; i += 1) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 2 + rand() * 6;
      const dark = rand() < 0.55;
      const tone = shade(dark ? 0.5 : 1.3, rand() * 0.4);
      const spin = rand() * Math.PI;
      wrapped(x, y, r + 2, (px, py) => {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(spin);
        ctx.fillStyle = css(tone, 0.2 + rand() * 0.3);
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.5);
        ctx.lineTo(r * 0.7, -r);
        ctx.lineTo(r, r * 0.6);
        ctx.lineTo(-r * 0.5, r);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    }
  } else {
    // Flagstones: an irregular grid of broken slabs with dark joints and a lit top edge each.
    const cell = 74;
    const joint = shade(0.42);
    const lip = shade(1.28);
    for (let gx = 0; gx < size / cell; gx += 1) {
      for (let gy = 0; gy < size / cell; gy += 1) {
        const jx = (rand() - 0.5) * cell * 0.3;
        const jy = (rand() - 0.5) * cell * 0.3;
        const w = cell * (0.62 + rand() * 0.3);
        const h = cell * (0.62 + rand() * 0.3);
        const px = gx * cell + cell / 2 + jx;
        const py = gy * cell + cell / 2 + jy;
        const spin = (rand() - 0.5) * 0.14;
        wrapped(px, py, cell, (dx, dy) => {
          ctx.save();
          ctx.translate(dx, dy);
          ctx.rotate(spin);
          ctx.strokeStyle = css(joint, 0.34);
          ctx.lineWidth = 2.4 + rand() * 1.6;
          ctx.strokeRect(-w / 2, -h / 2, w, h);
          ctx.strokeStyle = css(lip, 0.22);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(-w / 2, -h / 2);
          ctx.lineTo(w / 2, -h / 2);
          ctx.stroke();
          ctx.restore();
        });
      }
    }
  }

  // Fine grain so the surface does not read as smooth plastic when the camera is close.
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 15;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(image, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;
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
  const strength = 1.05;
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
  texture.anisotropy = 16;
  return texture;
}

function makeSurroundings(theme: MapTheme, width: number, depth: number): THREE.Group {
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
  // NO TEXTURE OUT HERE. The plain is nine times the arena's extent, so tiling the ground detail
  // across it minified the texture into aliasing hash — the fine dashed hatching that has been in
  // every screenshot of this game and that survived three rounds of texture tuning, two shadow-bias
  // changes and a shadow-frustum rewrite, because none of those were where it lived. A surface
  // meant to recede into fog wants a flat tone anyway.
  const plain = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 9, depth * 9),
    new THREE.MeshStandardMaterial({ color: plainColor, roughness: 1, metalness: 0 }),
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
  // A ridge is a low, irregular PYRAMID, not a box: a box at the horizon reads as a building, and
  // from the low title-diorama camera the nearest ones loomed like slabs. Five sides with a
  // flattened top gives a mesa/peak silhouette that still costs one shared geometry.
  const ridgeGeo = new THREE.CylinderGeometry(0.28, 0.62, 1, 5, 1);
  ridgeGeo.translate(0, 0.5, 0);
  ridgeGeo.userData.shared = true;
  // A floor on the ring distance: on the small maps 0.78x the arena put the nearest ridge right
  // at the board's edge, where a fog-tinted pyramid reads as a giant brown slab, not a horizon.
  const radius = Math.max(Math.max(width, depth) * 0.78, 48);
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
      bluff.position.set(Math.cos(angle) * distance * jitter, -1.2, Math.sin(angle) * distance * jitter);
      bluff.scale.set(spanX * 1.4, height * 1.35, spanZ * 1.4);
      bluff.rotation.y = rand() * Math.PI;
      group.add(bluff);
    }
  }
  if (theme.skyline) group.add(makeSkyline(theme.skyline, ground, fog, radius, rand));
  return group;
}

/**
 * PER-MAP SKYLINE (2026-09-20). The horizon used to be the same ring of fog-tinted bluffs on every
 * battlefield, so the distance told no story: a foundry and a frozen sea had the same hills behind
 * them. Each family is a handful of cheap flat-shaded shapes (instanced where they repeat, so a
 * 300-tree forest wall is one draw call) placed just inside the first ridge ring, tinted the same
 * way the ridges are so they recede into the fog rather than compete with the board.
 */
function makeSkyline(kind: SkylineKind, ground: THREE.Color, fog: THREE.Color, radius: number, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  group.name = `skyline-${kind}`;
  const tone = (blend: number, value: number, base: THREE.Color = ground): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: base.clone().lerp(fog, blend).multiplyScalar(value), roughness: 1, metalness: 0 });
  const ring = (t: number): number => radius * t;
  const place = (mesh: THREE.Object3D, angle: number, distance: number, y = -1.2): void => {
    mesh.position.set(Math.cos(angle) * distance, y, Math.sin(angle) * distance);
    group.add(mesh);
  };
  const dummy = new THREE.Object3D();
  const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number,
    fill: (i: number, d: THREE.Object3D) => void): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    for (let i = 0; i < count; i += 1) {
      dummy.position.set(0, 0, 0); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
      fill(i, dummy);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  };
  if (kind === "mountains") {
    // A range of sharp peaks — taller and narrower than the bluffs, so the basin reads walled in.
    const peak = new THREE.ConeGeometry(1, 1, 4, 1);
    peak.translate(0, 0.5, 0);
    const material = tone(0.28, 0.62);
    const count = 16;
    group.add(instanced(peak, material, count, (i, d) => {
      const a = (i / count) * Math.PI * 2 + rand() * 0.25;
      const dist = ring(0.98 + rand() * 0.12);
      d.position.set(Math.cos(a) * dist, -1.2, Math.sin(a) * dist);
      const h = 16 + rand() * 18;
      d.scale.set(14 + rand() * 16, h, 12 + rand() * 14);
      d.rotation.y = rand() * Math.PI;
    }));
  } else if (kind === "stacks") {
    // Foundry clusters: a long shed, two or three chimneys, a cooling tower in half of them; each
    // chimney tip carries an ember so the skyline is working at night.
    const shed = tone(0.35, 0.55);
    const iron = tone(0.3, 0.45);
    const ember = new THREE.MeshBasicMaterial({ color: 0xff7a2a });
    const chimney = new THREE.CylinderGeometry(0.85, 1.1, 1, 8, 1);
    chimney.translate(0, 0.5, 0);
    const tower = new THREE.CylinderGeometry(0.7, 1, 1, 12, 1);
    tower.translate(0, 0.5, 0);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    for (let c = 0; c < 6; c += 1) {
      const a = (c / 6) * Math.PI * 2 + 0.3 + rand() * 0.3;
      const dist = ring(0.96 + rand() * 0.08);
      const cluster = new THREE.Group();
      const hall = new THREE.Mesh(box, shed);
      hall.scale.set(22 + rand() * 12, 7 + rand() * 3, 9 + rand() * 4);
      cluster.add(hall);
      const n = 2 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k += 1) {
        const x = -8 + k * 8 + rand() * 3;
        const h = 18 + rand() * 12;
        const stack = new THREE.Mesh(chimney, iron);
        stack.position.set(x, 0, 4);
        stack.scale.set(1.6, h, 1.6);
        cluster.add(stack);
        const tip = new THREE.Mesh(box, ember);
        tip.position.set(x, h, 4);
        tip.scale.set(1.2, 0.5, 1.2);
        cluster.add(tip);
      }
      if (c % 2 === 0) {
        const cool = new THREE.Mesh(tower, iron);
        cool.position.set(14, 0, -3);
        cool.scale.set(7, 14 + rand() * 4, 7);
        cluster.add(cool);
      }
      cluster.rotation.y = -a + Math.PI / 2;
      place(cluster, a, dist);
    }
  } else if (kind === "forest") {
    // A wall of conifers in a deep band: one instanced cone, three hundred trees, one draw call.
    const cone = new THREE.ConeGeometry(1, 1, 6, 1);
    cone.translate(0, 0.5, 0);
    const material = tone(0.2, 0.5);
    const count = 320;
    group.add(instanced(cone, material, count, (i, d) => {
      const a = (i / count) * Math.PI * 2 + rand() * 0.02;
      const dist = ring(0.9 + rand() * 0.26);
      d.position.set(Math.cos(a) * dist, -1.2, Math.sin(a) * dist);
      const h = 9 + rand() * 9;
      d.scale.set(h * 0.42, h, h * 0.42);
    }));
  } else if (kind === "floes") {
    // A frozen sea: broken pack ice in flat slabs and a few grounded bergs, paler than the ground.
    const ice = new THREE.Color(0xd8e4ec);
    const slabMat = tone(0.45, 0.92, ice);
    const bergMat = tone(0.35, 0.98, ice);
    const slab = new THREE.BoxGeometry(1, 1, 1);
    slab.translate(0, 0.5, 0);
    const count = 70;
    group.add(instanced(slab, slabMat, count, (i, d) => {
      const a = (i / count) * Math.PI * 2 + rand() * 0.1;
      const dist = ring(0.88 + rand() * 0.3);
      d.position.set(Math.cos(a) * dist, -1.2, Math.sin(a) * dist);
      d.scale.set(9 + rand() * 12, 0.6 + rand() * 0.6, 7 + rand() * 10);
      d.rotation.y = rand() * Math.PI;
      d.rotation.z = (rand() - 0.5) * 0.08;
    }));
    const berg = new THREE.IcosahedronGeometry(1, 0);
    for (let k = 0; k < 9; k += 1) {
      const a = (k / 9) * Math.PI * 2 + rand() * 0.4;
      const b = new THREE.Mesh(berg, bergMat);
      b.scale.set(7 + rand() * 6, 6 + rand() * 9, 7 + rand() * 6);
      b.rotation.set(rand() * 0.3, rand() * Math.PI, rand() * 0.3);
      place(b, a, ring(1.02 + rand() * 0.1), -3);
    }
  } else if (kind === "ziggurats") {
    // The dead city: stepped pyramids and broken colonnades on the horizon.
    const stone = tone(0.4, 0.7);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    for (let k = 0; k < 7; k += 1) {
      const a = (k / 7) * Math.PI * 2 + 0.2 + rand() * 0.4;
      const zig = new THREE.Group();
      const w = 22 + rand() * 12;
      const tiers = 3 + Math.floor(rand() * 2);
      for (let t = 0; t < tiers; t += 1) {
        const tier = new THREE.Mesh(box, stone);
        const f = 1 - t / tiers;
        tier.position.y = t * 5;
        tier.scale.set(w * f, 5.2, w * f);
        zig.add(tier);
      }
      zig.rotation.y = rand() * Math.PI;
      place(zig, a, ring(1.0 + rand() * 0.1));
    }
    const column = new THREE.CylinderGeometry(1, 1.1, 1, 7, 1);
    column.translate(0, 0.5, 0);
    const count = 22;
    group.add(instanced(column, stone, count, (i, d) => {
      const a = (i / count) * Math.PI * 2 + rand() * 0.2;
      const dist = ring(0.92 + rand() * 0.1);
      d.position.set(Math.cos(a) * dist, -1.2, Math.sin(a) * dist);
      d.scale.set(1.3, 6 + rand() * 9, 1.3);
    }));
  } else if (kind === "fences") {
    // The border: a ring of fence posts, watchtowers at intervals, a few long wall runs.
    const post = new THREE.BoxGeometry(1, 1, 1);
    post.translate(0, 0.5, 0);
    const steel = tone(0.35, 0.5);
    const concrete = tone(0.4, 0.66);
    const count = 180;
    group.add(instanced(post, steel, count, (i, d) => {
      const a = (i / count) * Math.PI * 2;
      const dist = ring(0.93);
      d.position.set(Math.cos(a) * dist, -1.2, Math.sin(a) * dist);
      d.scale.set(0.5, 5.5, 0.5);
    }));
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * Math.PI * 2 + 0.5;
      const tower = new THREE.Group();
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(post, steel);
        leg.position.set(sx * 1.6, 0, sz * 1.6);
        leg.scale.set(0.5, 10, 0.5);
        tower.add(leg);
      }
      const cabin = new THREE.Mesh(post, concrete);
      cabin.position.y = 10;
      cabin.scale.set(5, 3.4, 5);
      tower.add(cabin);
      const roof = new THREE.Mesh(post, steel);
      roof.position.y = 13.4;
      roof.scale.set(6, 0.5, 6);
      tower.add(roof);
      place(tower, a, ring(0.95));
    }
    for (let k = 0; k < 4; k += 1) {
      const a = (k / 4) * Math.PI * 2 + 1.1;
      const wall = new THREE.Mesh(post, concrete);
      wall.scale.set(28 + rand() * 14, 3.2, 1.6);
      wall.rotation.y = -a + Math.PI / 2;
      place(wall, a, ring(1.0));
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
/**
 * CLOUD SHADOWS. A world-space noise multiplier that drifts slowly across every ground surface.
 * A flat-lit field of one colour is the last thing that reads as unfinished once the shapes are
 * right — nothing in the frame moves, so nothing in the frame feels alive. This costs one extra
 * texture fetch on the ground materials and no draw calls, and because it is sampled in WORLD space
 * it lands identically on the floor, the plates and the mesa caps, so a shadow crossing the board
 * runs over all three as one shape.
 *
 * The noise source is the ground's own normal map at a huge scale — no new asset, and its
 * low-frequency structure is exactly the soft blotchy shape a cloud deck wants.
 */
const cloudUniforms = { uCloudOffset: { value: new THREE.Vector2() } };

function applyCloudShadows(material: THREE.MeshStandardMaterial, noise: THREE.Texture): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCloudMap = { value: noise };
    shader.uniforms.uCloudOffset = cloudUniforms.uCloudOffset;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
varying vec2 vCloudXZ;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec2 vCloudXZ;
uniform sampler2D uCloudMap;
uniform vec2 uCloudOffset;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
// ~85 world units per cloud, so a shadow is a feature of the map rather than of a texture.
float cloud = texture2D(uCloudMap, vCloudXZ / 85.0 + uCloudOffset).g;
// Shallow: 0.86 to 1.0. Deeper reads as dirt rather than weather.
diffuseColor.rgb *= mix(0.86, 1.0, smoothstep(0.35, 0.72, cloud));`);
  };
  // A distinct cache key so this variant compiles and warms separately from the plain one.
  material.customProgramCacheKey = () => "cloudshadow";
}

/**
 * GROUND DETAIL — the layer that makes a surface read as a MATERIAL rather than a tint. A grass
 * map gets thousands of blades that move in the wind; dust gets pebbles and dead scrub; ice gets
 * snow clumps and shards; slag gets cinders; paving gets chips with weeds in the joints. Each
 * element kind is ONE InstancedMesh (one draw call), placed on dry, flat, standable ground so
 * nothing pokes out of a cliff face or floats over a channel, with per-instance colour so a
 * field is never one green. Blade-type elements bend in a shared wind (see windUniforms) — the
 * cheapest "alive" cue there is, and the one the eye reads first on a still board.
 */
const windUniforms = { uTime: { value: 0 } };

function applyWind(material: THREE.MeshStandardMaterial, strength: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
uniform float uTime;
uniform float uWind;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
{
  // Bend from the root: displacement scales with height, so the base stays planted. A slow gust
  // wave rides under a faster flutter, keyed to world position so a field ripples instead of
  // nodding in unison.
  vec4 wRoot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float gust = 0.55 + 0.45 * sin(uTime * 0.7 + wRoot.x * 0.12 + wRoot.z * 0.09);
  float flutter = sin(uTime * 2.3 + wRoot.x * 1.7 + wRoot.z * 1.1);
  float bend = (0.35 * gust + 0.25 * flutter * gust) * uWind * position.y;
  transformed.x += bend;
  transformed.z += bend * 0.45;
}`);
  };
  material.customProgramCacheKey = () => "wind";
}

/** A fan of thin tapered blades rising from one root, leaning outward. Height 1 = unit scale. */
function bladeFanGeometry(blades: number, rand: () => number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  for (let b = 0; b < blades; b += 1) {
    const angle = (b / blades) * Math.PI * 2 + rand() * 0.8;
    const lean = 0.18 + rand() * 0.28;
    const height = 0.7 + rand() * 0.5;
    const width = 0.09 + rand() * 0.07;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    // Triangle: two base corners perpendicular to the lean direction, tip leaned outward.
    const px = -dz * width;
    const pz = dx * width;
    // Both windings, FRONT side only. DoubleSide flips the normal on back faces, which turns an
    // up-facing blade seen from behind into an unlit black spike; two front-facing copies keep
    // every blade lit by the sky it points at.
    positions.push(px, 0, pz, -px, 0, -pz, dx * lean, height, dz * lean);
    positions.push(-px, 0, -pz, px, 0, pz, dx * lean, height, dz * lean);
    for (let i = 0; i < 6; i += 1) normals.push(0, 1, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

interface DetailKind {
  geometry: THREE.BufferGeometry;
  /** Instances per 1000 square units of arena. */
  density: number;
  /** [min, max] uniform scale. */
  scale: [number, number];
  /** Vertical squash applied on top of scale (pebbles are flatter than they are wide). */
  squash: number;
  colors: number[];
  wind: number;
  metalness?: number;
  emissive?: number;
}

function makeGroundDetail(theme: MapTheme, width: number, depth: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "ground-detail";
  let seed = (0x51ed ^ (width * 131 + depth * 17)) >>> 0;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const ground = new THREE.Color(theme.ground);
  const accent = new THREE.Color(theme.groundAccent);
  const mix = (t: number, v = 1): number => ground.clone().lerp(accent, t).multiplyScalar(v).getHex();
  // Eight triangles a pebble: at thousands per map the dodecahedron version was 130k triangles.
  const pebble = new THREE.OctahedronGeometry(0.1, 0);
  const clump = new THREE.IcosahedronGeometry(0.16, 0);

  const kinds: DetailKind[] = [];
  switch (theme.surface ?? "cracked") {
    case "grass":
      kinds.push(
        { geometry: bladeFanGeometry(4, rand), density: 1700, scale: [0.15, 0.32], squash: 1, wind: 0.9,
          colors: [mix(0.3, 1.3), mix(0.55, 1.35), mix(0.8, 1.4), mix(0.2, 1.1), 0x9cbd55, 0x7fae48] },
        { geometry: pebble, density: 60, scale: [0.5, 1.1], squash: 0.55, wind: 0, colors: [0x7d7a6c, 0x69675c, 0x8c8779] },
      );
      break;
    case "cracked":
      kinds.push(
        { geometry: pebble, density: 520, scale: [0.4, 1.3], squash: 0.6, wind: 0, colors: [mix(0.2, 0.8), mix(0.5, 0.9), mix(0.8, 1.05), 0x8c7a62] },
        { geometry: bladeFanGeometry(4, rand), density: 140, scale: [0.14, 0.26], squash: 1, wind: 0.6,
          colors: [0xb9a06a, 0xa48c5a, 0xcbb47e, mix(0.9, 1.2)] },
      );
      break;
    case "ice":
      kinds.push(
        { geometry: clump, density: 260, scale: [0.6, 1.6], squash: 0.45, wind: 0, colors: [0xf2f6fa, 0xe4ecf3, 0xd6e2ec] },
        { geometry: bladeFanGeometry(3, rand), density: 90, scale: [0.14, 0.26], squash: 1, wind: 0.15,
          colors: [0xc9dbe8, 0xb4cbdc, 0xe0edf6], metalness: 0.3 },
      );
      break;
    case "slag":
      kinds.push(
        { geometry: pebble, density: 640, scale: [0.5, 1.5], squash: 0.7, wind: 0, colors: [0x2a2d33, 0x3a3d43, 0x1f2126, 0x4a4238] },
        { geometry: pebble, density: 40, scale: [0.35, 0.6], squash: 0.5, wind: 0, colors: [0xff7a2a, 0xff9a3a], emissive: 0xff5a10 },
      );
      break;
    case "paved":
      kinds.push(
        { geometry: pebble, density: 300, scale: [0.4, 1.0], squash: 0.5, wind: 0, colors: [mix(0.3, 0.9), mix(0.6, 1.0), 0x8a8478] },
        { geometry: bladeFanGeometry(4, rand), density: 160, scale: [0.12, 0.24], squash: 1, wind: 0.7,
          colors: [0x6f8a3c, 0x87a04a, 0x5c7532] },
      );
      break;
  }

  const area = width * depth;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (const kind of kinds) {
    const count = Math.round((area / 1000) * kind.density);
    if (count <= 0) continue;
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.95,
      metalness: kind.metalness ?? 0,
      emissive: kind.emissive ?? 0x000000,
      emissiveIntensity: kind.emissive ? 1.4 : 0,
    });
    if (kind.wind > 0) applyWind(material, kind.wind);
    const mesh = new THREE.InstancedMesh(kind.geometry, material, count);
    mesh.receiveShadow = true;
    let placed = 0;
    // Try a few positions per instance; a map that is mostly water or cliff just gets fewer.
    for (let i = 0; i < count * 3 && placed < count; i += 1) {
      const x = (rand() - 0.5) * width * 0.98;
      const z = (rand() - 0.5) * depth * 0.98;
      const p = { x, z };
      if (pointInWater(p) || onTerrainEdge(p, 0.35)) continue;
      const sc = kind.scale[0] + rand() * (kind.scale[1] - kind.scale[0]);
      dummy.position.set(x, terrainHeightAt(p), z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(sc, sc * kind.squash, sc);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      mesh.setColorAt(placed, color.setHex(kind.colors[Math.floor(rand() * kind.colors.length)]));
      placed += 1;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  }
  return group;
}

const GROUND_TILE = 11;
/**
 * A flat, irregular ground blob: a triangle fan whose rim radius wanders per vertex, so the outline
 * has no straight edge and no corner anywhere on it. Lies in the XZ plane at `y`.
 */
type BlobRim = { p1: number; p2: number; a1: number; a2: number };
function blobGeometry(radius: number, x: number, y: number, z: number, rand: () => number, rim?: BlobRim): THREE.BufferGeometry {
  const segments = 22;
  const positions = new Float32Array((segments + 2) * 3);
  const uvs = new Float32Array((segments + 2) * 2);
  positions[0] = x;
  positions[1] = y;
  positions[2] = z;
  // Two low-frequency waves with random phase keep neighbouring rim vertices correlated, so the
  // outline undulates instead of turning into a saw.
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const a1 = 0.16 + rand() * 0.16;
  const a2 = 0.08 + rand() * 0.12;
  if (rim) { rim.p1 = p1; rim.p2 = p2; rim.a1 = a1; rim.a2 = a2; }
  for (let i = 0; i <= segments; i += 1) {
    const t = (i % segments) / segments;
    const angle = t * Math.PI * 2;
    const r = radius * (1 + Math.sin(angle * 2 + p1) * a1 + Math.sin(angle * 3 + p2) * a2);
    const o = (i + 1) * 3;
    positions[o] = x + Math.cos(angle) * r;
    positions[o + 1] = y;
    positions[o + 2] = z + Math.sin(angle) * r;
  }
  const indices: number[] = [];
  for (let i = 1; i <= segments; i += 1) indices.push(0, i + 1, i);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array((segments + 2) * 3).fill(0), 3));
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < normal.count; i += 1) normal.setXYZ(i, 0, 1, 0);
  geometry.setIndex(indices);
  return geometry;
}

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

// Spots the plates must leave alone (base pads): a plate over a base's own concrete pad covered
// it except for a stray wedge, which read as a broken selection circle. Set by applyMap.
const plateKeepClear: Vec2[] = [];
// Where the cosmetic ground plates lie (centre, nominal radius, top height), so units can stand ON
// them instead of in them. Rebuilt with the plates; read by plateLiftAt every frame per unit.
const plateDiscs: { x: number; z: number; r: number; y: number; rim: BlobRim }[] = [];
function plateLiftAt(point: Vec2, groundHeight: number): number {
  if (groundHeight > 0.001) return 0; // plates only lie on the arena floor
  let lift = 0;
  for (const disc of plateDiscs) {
    if (disc.y <= lift) continue;
    const dx = point.x - disc.x, dz = point.z - disc.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > disc.r * disc.r * 2.4) continue; // outside the widest possible rim
    // The exact jittered rim blobGeometry drew, so the lift ends where the plate ends.
    const angle = Math.atan2(dz, dx);
    const r = disc.r * (1 + Math.sin(angle * 2 + disc.rim.p1) * disc.rim.a1 + Math.sin(angle * 3 + disc.rim.p2) * disc.rim.a2);
    if (d2 <= r * r) lift = disc.y;
  }
  return lift;
}

function makeGroundPlates(theme: MapTheme, width: number, depth: number, surface: GroundSurface): THREE.Group {
  plateDiscs.length = 0;
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
  // ...but a value spread the eye reads as a PATCH, not as a paper cutout. At 0.55 toward the
  // accent x1.13 the pale variant on the green map was a hard-edged cream polygon that the grass
  // detail could not sit on; the spread is now roughly half, so patches read through the ground
  // detail as damp/dry variation rather than as shapes laid on top of it.
  const variants = [
    { color: ground.clone().lerp(new THREE.Color(0x0a0d10), 0.1), roughness: 0.98 },
    { color: ground.clone().lerp(accent, 0.3).multiplyScalar(1.05), roughness: 0.93 },
    { color: ground.clone().lerp(accent, 0.14).multiplyScalar(0.9), roughness: 0.96 },
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
  for (const [vi, variant] of variants.entries()) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < perVariant; i += 1) {
      const cx = (rand() - 0.5) * width * 0.92;
      const cz = (rand() - 0.5) * depth * 0.92;
      // Never over water: the plates sit above the water surface (ledger #5) and a 6–15m blob laid
      // across a channel hid the whole crossing under ice-coloured ground. Skip any patch whose
      // widest possible rim could touch a water rect (the three blobs spread ±4.5m from the centre).
      if (plateKeepClear.some((c) => Math.hypot(cx - c.x, cz - c.z) < 6 + 4.5 + 4)) continue;
      const reach = 15 * 1.52 + 4.5;
      if (terrainWater().some((w) => cx > w.minX - reach && cx < w.maxX + reach && cz > w.minZ - reach && cz < w.maxZ + reach
        && Math.max(w.minX - cx, cx - w.maxX, 0) + Math.max(w.minZ - cz, cz - w.maxZ, 0) < 6 + 4.5)) continue;
      // Three overlapping JITTERED BLOBS per patch. The first version used rotated rounded boxes,
      // and the union of rectangles has straight edges and sharp corners — at tactical distance
      // those read as arrowheads and cut corners lying on the ground, i.e. as a rendering glitch
      // rather than as terrain. A polygon whose every rim vertex is jittered has neither.
      for (let k = 0; k < 3; k += 1) {
        const blobRadius = 6 + rand() * 9;
        const blobX = cx + (rand() - 0.5) * 9;
        const blobY = 0.06 - (vi * 3 + k) * 0.005;
        const rim: BlobRim = { p1: 0, p2: 0, a1: 0, a2: 0 };
        plateDiscs.push({ x: blobX, z: 0, r: blobRadius, y: blobY, rim });
        parts.push(blobGeometry(
          blobRadius,
          blobX,
          // 6cm above grade, 5mm per blob AND per variant (nine steps, lowest 2cm). The floor top is
          // at -0.02 and a water surface at -0.015; a 2mm stagger from y=0 put plates within the depth buffer's
          // resolution of both at the far edge of a large map. Worse, the three variants are separate
          // meshes whose k-th blobs sat at IDENTICAL heights, so wherever a light patch overlapped a
          // dark one they were exactly coplanar and fought — the dashed "teeth" along patch rims that
          // survived every shadow-bias change because they were never a shadow (ledger #3).
          blobY,
          (plateDiscs[plateDiscs.length - 1].z = cz + (rand() - 0.5) * 9),
          rand,
          rim,
        ));
      }
    }
    // A variant whose every blob fell over water has nothing to merge — mergeGeometries([]) throws
    // (it reads geometries[0]), and that killed applyMap on Crossfire Basin.
    if (!parts.length) continue;
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
        normalScale: new THREE.Vector2(0.32, 0.32),
        color: variant.color,
        roughness: variant.roughness,
        metalness: 0.02,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    applyCloudShadows(mesh.material as THREE.MeshStandardMaterial, plateNormal);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}


// (Removed: a per-map vertical LANDMARK on the horizon. The idea is sound and it is standard
// composition advice, but it does not survive this camera: pitched down at the board, the frame
// shows sky in a thin band, so a landmark far enough away to read as scenery is off-frame in
// almost every shot, and one close enough to be seen intrudes over the rail as an ambiguous mass
// cut by the frame edge. Tried at 0.92, 0.62 and 0.58 of the map's long axis and at three
// brightnesses. If it is revisited, it needs a camera that shows the horizon, not a nearer prop.)

/**
 * TERRAIN AS ROCK, NOT AS BOXES.
 *
 * Every rise on the board was a grey box with a lighter lid. On a tactics camera that is most of
 * what you look at, and a box reads as a placeholder however well it is lit — it is the single
 * biggest reason the battlefields looked unfinished. Each block is now a rock MASS: the body, a
 * ring of canted talus wedges skirting its base, and a scatter of outcrops broken over its rim.
 * Every piece is derived deterministically from the block's own footprint, so a map always looks
 * like itself and nothing here is random per frame.
 *
 * Gameplay is untouched. The sim reads terrain from the authored rectangles and heights; the talus
 * and outcrops sit strictly INSIDE the block's own silhouette in plan, or below its top, so no
 * added shape can be mistaken for standable ground or change a single collision.
 *
 * Everything merges into two meshes (sides, caps). That keeps the whole terrain layer at two draw
 * calls no matter how many blocks a map authors, and it structurally prevents the cap-overlap
 * shadow bug: there is only ever one cap mesh, so no two caps can fight in the depth pass.
 */
/**
 * The ground as DRAWN, not as simulated: makeTerrainBlocks flares each rise into three tiers that
 * spread past the authored footprint (talus), so a walker's feet meet the drawn surface up to
 * `flare` outside the block. Units are placed on this so they climb the talus instead of wading
 * through it. Same tier constants as makeTerrainBlocks — change both together.
 */
// Thickness of a rise's cap slab (shared by visualGroundAt and makeTerrainBlocks).
const CAP = 0.1;
function visualGroundAt(point: Vec2): number {
  let height = terrainHeightAt(point);
  for (const block of terrainBlocks()) {
    const bodyHeight = Math.max(0.05, block.height - CAP);
    const flare = Math.min(0.55, Math.max(0.12, bodyHeight * 0.34));
    const dx = Math.max(block.minX - point.x, point.x - block.maxX, 0);
    const dz = Math.max(block.minZ - point.z, point.z - block.maxZ, 0);
    const t = Math.max(dx, dz);
    if (t <= 0 || t > flare) continue;
    const tier = t <= flare * 0.45 ? bodyHeight * 0.62 : bodyHeight * 0.3;
    if (tier > height) height = tier;
  }
  return height;
}

function makeTerrainBlocks(groundColor: number, accentColor: number, surface: GroundSurface): THREE.Group {
  const group = new THREE.Group();
  // The cap stays near the ground tone so a mesa reads as a rise OF the battlefield rather than a
  // pale slab sitting on it; the lit and shadowed rock faces carry the height read instead.
  const capColor = new THREE.Color(accentColor).lerp(new THREE.Color(groundColor), 0.45);


  const sides: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  // CLIMBABLE vs CLIFF, readable from the terrain itself. A rise a unit can walk up (drop to the
  // ground outside <= TERRAIN_STEP) wears a lighter ledge tone on that face; a face it cannot
  // climb goes dark and reddened. Before this every mesa face was the same rock, and "why can't I
  // walk there" had no answer on the board. Baked as vertex colour so the layer stays one mesh.
  const ledgeColor = new THREE.Color(groundColor).lerp(new THREE.Color(accentColor), 0.3).multiplyScalar(0.92);
  const cliffColor = new THREE.Color(groundColor).multiplyScalar(0.42).lerp(new THREE.Color(0x4a2a22), 0.35);
  const push = (
    into: THREE.BufferGeometry[],
    sx: number, sy: number, sz: number,
    x: number, y: number, z: number,
    yaw = 0, tilt = 0, bevel = 0.12,
    faces?: { east: boolean; west: boolean; north: boolean; south: boolean },
  ): void => {
    const geo = new RoundedBoxGeometry(sx, sy, sz, 1, Math.min(Math.min(sx, sy, sz) * 0.45, bevel));
    if (faces) {
      const normal = geo.getAttribute("normal");
      const colors = new Float32Array(normal.count * 3);
      for (let i = 0; i < normal.count; i += 1) {
        const nx = normal.getX(i);
        const nz = normal.getZ(i);
        const climbable = Math.abs(nx) >= Math.abs(nz) ? (nx > 0 ? faces.east : faces.west) : (nz > 0 ? faces.north : faces.south);
        const c = climbable ? ledgeColor : cliffColor;
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }
    geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(tilt));
    geo.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z));
    into.push(geo);
  };

  for (const block of terrainBlocks()) {
    const w = block.maxX - block.minX;
    const d = block.maxZ - block.minZ;
    const cx = (block.minX + block.maxX) / 2;
    const cz = (block.minZ + block.maxZ) / 2;
    const bodyHeight = Math.max(0.05, block.height - CAP);
    // BATTERED PROFILE. A rise is three stacked tiers that widen toward the ground, so the face
    // slopes back like weathered rock instead of standing as a vertical grey wall. The TOP tier
    // keeps the authored footprint exactly — that is the standable surface and it must not lie —
    // and only the lower tiers spread, at knee height where they read as talus.
    //
    // (An earlier attempt added canted wedges and rim outcrops instead. At tactical distance the
    // wedges read as flat plates jutting out of the cliff and the outcrops buried themselves in the
    // cap as dark rectangles. Slope the mass; do not bolt shapes onto it.)
    const flare = Math.min(0.55, Math.max(0.12, bodyHeight * 0.34));
    const tiers: [number, number, number][] = [
      [flare, 0, bodyHeight * 0.3],                 // base — widest
      [flare * 0.45, bodyHeight * 0.28, bodyHeight * 0.62], // mid
      [0, bodyHeight * 0.6, bodyHeight],            // top — the authored footprint
    ];
    // Which faces a unit can walk up: sample the ground just outside each edge midpoint.
    const outside = (x: number, z: number): number => terrainHeightAt({ x, z });
    const faces = {
      east: block.height - outside(block.maxX + 0.3, cz) <= TERRAIN_STEP + 0.01,
      west: block.height - outside(block.minX - 0.3, cz) <= TERRAIN_STEP + 0.01,
      north: block.height - outside(cx, block.maxZ + 0.3) <= TERRAIN_STEP + 0.01,
      south: block.height - outside(cx, block.minZ - 0.3) <= TERRAIN_STEP + 0.01,
    };
    for (const [spread, y0, y1] of tiers) {
      const h = Math.max(0.05, y1 - y0);
      push(sides, w + spread * 2, h, d + spread * 2, cx, y0 + h / 2, cz, 0, 0, Math.min(0.22, h * 0.4), faces);
    }

    push(caps, w + 0.02, CAP, d + 0.02, cx, block.height - CAP / 2, cz, 0, 0, 0.03);
  }

  const sideGeo = sides.length ? mergeGeometries(sides, false) : null;
  const capGeo = caps.length ? mergeGeometries(caps, false) : null;
  for (const g of sides) g.dispose();
  for (const g of caps) g.dispose();

  if (sideGeo) {
    const mesh = new THREE.Mesh(sideGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0.03 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (capGeo) {
    // The caps share the ground's own surface, tiled in world space so a mesa top continues the
    // terrain rather than wearing a stretched copy of it.
    rewriteWorldUvs(capGeo, GROUND_TILE);
    const capMap = surface.map.clone();
    capMap.needsUpdate = true;
    capMap.repeat.set(1, 1);
    const capNormal = surface.normalMap.clone();
    capNormal.needsUpdate = true;
    capNormal.repeat.set(1, 1);
    const mesh = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({
      map: capMap,
      normalMap: capNormal,
      normalScale: new THREE.Vector2(0.32, 0.32),
      color: capColor,
      roughness: 0.9,
      metalness: 0.03,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));
    // The caps share the cloud deck too, so a shadow crossing the board runs over the mesa tops
    // as one continuous shape instead of stopping at their edges.
    applyCloudShadows(mesh.material as THREE.MeshStandardMaterial, capNormal);
    mesh.receiveShadow = true;
    // Caps still do not cast: see the ledger in CLAUDE.md. One merged mesh makes the old
    // cap-vs-cap depth fight structurally impossible, but the body casts the same footprint anyway.
    mesh.castShadow = false;
    group.add(mesh);
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
  // Less fog in the tint than before: on the frozen map the channel washed out to the ice's grey
  // and stopped reading as "cannot walk here".
  const waterColor = new THREE.Color(0x3a7fb0).lerp(new THREE.Color(theme.fog), 0.08);
  // Toon shoreline: an inked rim on the bank lip and foam strokes just inside it, the same
  // language as the unit outlines. A channel must read as water at tactical distance.
  const inkMat = new THREE.MeshBasicMaterial({ color: 0x10161c });
  const foamMat = new THREE.MeshBasicMaterial({ color: 0xdfeef6, transparent: true, opacity: 0.55, depthWrite: false });
  // Smoother and glossier than the ground so it catches the key light and reads as a liquid
  // surface rather than a flat panel; still short of a mirror, which would strobe as the camera moves.
  // A flat translucent panel reads as blue tape laid on the ground however dark you make it: with
  // no surface normal there is nothing for the key light to break up. Borrowing the ground's normal
  // map (tiled tight, scrolled slowly by syncWater) gives it a moving ripple for the cost of one
  // texture clone -- the single change that makes a channel read as water rather than as paint.
  const ripple = surface.normalMap.clone();
  ripple.needsUpdate = true;
  ripple.repeat.set(2.4, 2.4);
  // Toon wave strokes over the whole surface (a channel can be wider than the screen, so the rim
  // alone cannot carry the read). World-tiled and scrolled with the ripple by syncWater.
  const waves = waveStrokeTexture();
  const waterMat = new THREE.MeshStandardMaterial({
    color: waterColor,
    map: waves,
    transparent: true,
    opacity: 0.86,
    // Flat, not glossy: a specular hot-spot under bloom blew out to a white sun on the channel.
    roughness: 0.62,
    metalness: 0.04,
    depthWrite: false,
    normalMap: ripple,
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  group.userData.ripple = ripple;
  group.userData.waves = waves;

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
    rewriteWorldUvs(plane.geometry, 7); // one wave tile per 7 world units, continuous across rects
    plane.position.set(cx, SURFACE, cz);
    plane.receiveShadow = true;
    group.add(plane);
    // Ink rim along the inside edge of each bank lip, sitting on the lip's top face.
    const INK = 0.11;
    for (const [ox, oz, sx, sz] of [
      [0, -(d / 2) - INK / 2, w + INK * 2, INK],
      [0, d / 2 + INK / 2, w + INK * 2, INK],
      [-(w / 2) - INK / 2, 0, INK, d],
      [w / 2 + INK / 2, 0, INK, d],
    ] as const) {
      const ink = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.02, sz), inkMat);
      ink.position.set(cx + ox, 0.075, cz + oz); // just above the lip top (-0.14 + 0.21)
      group.add(ink);
    }
    // Foam strokes: short pale dashes a little inside the rim, staggered so they read as lapping
    // water and not as a second outline.
    const dash = (x: number, z: number, len: number, alongX: boolean, i: number): void => {
      const jitter = ((i * 7) % 5) * 0.06;
      const m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.07, 0.015, alongX ? 0.07 : len), foamMat);
      m.position.set(x, SURFACE + 0.06, z);
      m.position[alongX ? "z" : "x"] += (i % 2 ? 1 : -1) * jitter;
      group.add(m);
    };
    for (let x = r.minX + 0.6, i = 0; x < r.maxX - 0.6; x += 1.5, i += 1) {
      dash(x + 0.4, r.minZ + 0.42, 0.7, true, i);
      dash(x + 0.4, r.maxZ - 0.42, 0.7, true, i + 3);
    }
    for (let z = r.minZ + 0.6, i = 0; z < r.maxZ - 0.6; z += 1.5, i += 1) {
      dash(r.minX + 0.42, z + 0.4, 0.7, false, i + 1);
      dash(r.maxX - 0.42, z + 0.4, 0.7, false, i + 4);
    }
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
  // Wide enough to carry a sun and cloud bands: from the tactical pitch the sky is a sliver at
  // the top of the frame, but the title diorama and any low camera look straight at it, and a
  // flat gradient there read as a mock-up.
  const canvas = document.createElement("canvas");
  canvas.width = 512;
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
    // The sun: a warm glow low on the same side the key light comes from.
    const sun = ctx.createRadialGradient(370, 150, 0, 370, 150, 150);
    sun.addColorStop(0, "rgba(255, 236, 200, 0.55)");
    sun.addColorStop(0.18, "rgba(255, 220, 170, 0.22)");
    sun.addColorStop(1, "rgba(255, 210, 160, 0)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Cloud bands: long soft ellipses, lighter than the sky, flatter and thinner toward the
    // horizon the way a real deck foreshortens. Deterministic per theme via its sky colour.
    let seed = (theme.sky * 2654435761) >>> 0 || 7;
    const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    const cloud = horizon.clone().lerp(new THREE.Color(0xffffff), 0.55);
    for (let i = 0; i < 11; i += 1) {
      const y = 70 + rand() * 150;
      const depth = (y - 70) / 150; // 0 high, 1 at the horizon
      const w = (60 + rand() * 120) * (0.6 + depth * 0.9);
      const h = (7 + rand() * 12) * (1 - depth * 0.6);
      const x = rand() * canvas.width;
      const alpha = 0.1 + rand() * 0.14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, w);
      g.addColorStop(0, `rgba(${Math.round(cloud.r * 255)},${Math.round(cloud.g * 255)},${Math.round(cloud.b * 255)},${alpha})`);
      g.addColorStop(1, `rgba(${Math.round(cloud.r * 255)},${Math.round(cloud.g * 255)},${Math.round(cloud.b * 255)},0)`);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, h / w);
      ctx.translate(-x, -y);
      ctx.fillStyle = g;
      ctx.fillRect(x - w, y - w, w * 2, w * 2);
      ctx.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return { texture, horizon };
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
    // Also free materials. Pooled/singleton materials are tagged userData.shared and skipped, so
    // this only frees the per-entity (accent / contact shadow) and per-frame overlay materials
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
const partMaterialPool = new Map<number, PartMaterial>();

const q = (value: number, steps: number): number => Math.min(steps, Math.max(0, Math.round(value * steps)));

function partMaterial(spec: PartMatSpec): PartMaterial {
  const c = (q(spec.color.r, 63) * 64 + q(spec.color.g, 63)) * 64 + q(spec.color.b, 63);
  const e = (q(spec.emissive.r, 31) * 32 + q(spec.emissive.g, 31)) * 32 + q(spec.emissive.b, 31);
  const i = Math.min(127, Math.round(spec.emissiveIntensity / 0.05));
  const key = ((((c * 32768 + e) * 128 + i) * 16 + q(spec.roughness, 15)) * 16 + q(spec.metalness, 15)) * 16
    + q(spec.opacity, 7) * 2 + (spec.depthWrite ? 1 : 0);
  let material = partMaterialPool.get(key);
  if (!material) {
    // Same stepped toon ramp as the stylized hulls (models.ts), so a trooper and the tank beside
    // it shade in the same four bands. Roughness/metalness are kept in the pool key for the
    // material identity but a toon material has neither; the ramp carries the read.
    material = new THREE.MeshToonMaterial({
      vertexColors: true, // baked AO — see bakeVertexAO
      // NO detail normal map. A weave normal under a four-band toon ramp jittered every band edge:
      // speckle up close (units read blurry) and a minified dashed hatch on large facets at range
      // (glitch sweep 4b, tree canopies). Flat bands + the ink rim are the toon read.
      gradientMap: toonGradient(),
      color: spec.color,
      emissive: spec.emissive,
      emissiveIntensity: i * 0.05,
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
function pooledPartMaterial(color: number, emissive: number, emissiveIntensity: number, roughness: number, metalness: number): PartMaterial {
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

// Vehicles-kit ink rim (world units). Matches the trooper edge weight at tactical zoom.
const VEHICLE_INK = 0.03;
// Rig scale for the tank / APC / artillery kit parts (structures and cover are authored 1:1).
const VEHICLE_KIT_SCALE = 0.78;
const _inkMaterial = new THREE.MeshBasicMaterial({ color: 0x0b0d10, side: THREE.BackSide });
_inkMaterial.userData.shared = true;
function inkMaterial(): THREE.MeshBasicMaterial {
  return _inkMaterial;
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

/**
 * Value ramp up the body: boots ~0.6, torso ~0.9, head/weapon band 1.0. Darkest at the feet is
 * what makes a figure sit ON the ground instead of floating over it.
 */
function bodyValueAt(y: number): number {
  if (y <= 0.4) return 0.6;
  if (y >= 1.05) return 1.0;
  return 0.6 + ((y - 0.4) / 0.65) * 0.4;
}

/**
 * The single accent zone: full strength across the chest/weapon band (~0.75-1.3), knocked back
 * outside it. One saturated region per unit, at the height the eye already goes to.
 */
function accentValueAt(y: number): number {
  if (y >= 0.75 && y <= 1.32) return 1;
  const distance = y < 0.75 ? 0.75 - y : y - 1.32;
  return clamp(1 - distance * 1.1, 0.5, 1);
}

/** Idle weapon carry: muzzle lifted and canted in across the chest, pivoting about the grip. */
// Knee cut of the unit-cube leg: the authored knee sits at world 0.35 on a 0.5-tall mesh centred at
// 0.36, i.e. -0.02 in unit-cube space; each half overruns the cut by 2.5cm so the bend shows no gap.
const LEG_KNEE_CUT = (KNEE_Y - 0.36) / 0.5;
const SHOULDER_Y = 0.98;
const _footWorld = new THREE.Vector3();
const _crouchMovers = new Set<string>();
interface FootFrame { t: number; x: number; z: number; ground: number; feet: { side: string; x: number; y: number; z: number }[] }
const _restPose: LegPose = { thigh: 0, shin: 0, knee: 0, foot: 0, kneeY: KNEE_Y, kneeZ: HIP_Z, ankleY: ANKLE_Y, ankleZ: HIP_Z };
function copyPose(from: LegPose, into: LegPose): LegPose {
  into.thigh = from.thigh; into.shin = from.shin; into.knee = from.knee; into.foot = from.foot;
  into.kneeY = from.kneeY; into.kneeZ = from.kneeZ; into.ankleY = from.ankleY; into.ankleZ = from.ankleZ;
  return into;
}
function blendPose(into: LegPose, to: LegPose, t: number): void {
  into.thigh += (to.thigh - into.thigh) * t; into.shin += (to.shin - into.shin) * t; into.knee += (to.knee - into.knee) * t; into.foot += (to.foot - into.foot) * t;
  into.kneeY += (to.kneeY - into.kneeY) * t; into.kneeZ += (to.kneeZ - into.kneeZ) * t; into.ankleY += (to.ankleY - into.ankleY) * t; into.ankleZ += (to.ankleZ - into.ankleZ) * t;
}
/** Forward kinematics for an authored leg pose (kneel): thigh/shin/foot angles from straight down, forward positive. */
function kneelPose(thigh: number, shin: number, foot: number, hipY: number): LegPose {
  const out = _restPose;
  out.thigh = thigh; out.shin = shin; out.knee = thigh - shin; out.foot = foot;
  out.kneeY = hipY - (HIP_Y - KNEE_Y) * Math.cos(thigh); out.kneeZ = HIP_Z + (HIP_Y - KNEE_Y) * Math.sin(thigh);
  out.ankleY = out.kneeY - (KNEE_Y - ANKLE_Y) * Math.cos(shin); out.ankleZ = out.kneeZ + (KNEE_Y - ANKLE_Y) * Math.sin(shin);
  return out;
}
const LEG_KNEE_OVERLAP = 0.05;
// A crouch lowers the hip by this much (0.58 -> 0.30); the legs fold to meet it by IK.
const CROUCH_DROP = 0.28;
const KNEEL_DROP = 0.26;
const CARRY_PITCH = 0.34;
const CARRY_PITCH_LONG = 0.95;
const CARRY_YAW = -0.26;
const CARRY_PIVOT_Y = 0.93;
const CARRY_PIVOT_Z = 0.12;

/**
 * The range-field gradient: transparent at the centre, a low tint across the body, brightening into
 * a defined rim just inside the edge and falling off outside it. Tinted per use by the material's
 * own colour, so one texture serves move / shoot / grenade / melee.
 */
let _rangeFieldTexture: THREE.CanvasTexture | undefined;

function rangeFieldTexture(): THREE.CanvasTexture {
  if (_rangeFieldTexture) return _rangeFieldTexture;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.10)");
    g.addColorStop(0.55, "rgba(255,255,255,0.26)");
    g.addColorStop(0.88, "rgba(255,255,255,0.55)");
    g.addColorStop(0.965, "rgba(255,255,255,1)");
    g.addColorStop(0.995, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.shared = true;
  _rangeFieldTexture = texture;
  return texture;
}

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
// Scratch id->part map reused by syncEntity's per-frame traverse.
const _partById = new Map<string, DamagePart>();


const tubeGeometries = new Map<string, THREE.CylinderGeometry>();
const endpointGeometries = new Map<string, THREE.RingGeometry>();
const projectileShadowGeometries = new Map<string, THREE.CircleGeometry>();
const materials = new Map<string, THREE.Material>();
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


