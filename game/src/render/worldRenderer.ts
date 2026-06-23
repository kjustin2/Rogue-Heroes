import * as THREE from "three";
import { clamp01, dist, pointToSegmentDistance, segmentProgress, type Vec2 } from "../core/math";
import { isDefenseKind, isInfantryKind, isVehicleKind, type CombatEntity, type DamagePart, type PartRole } from "../game/damageModel";
import type { Projectile, ShotPreview, TacticalSim, VisualEvent } from "../game/sim";
import { MAPS, type MapTheme } from "../game/maps";
import { ARENA_BOUNDS, arenaDepth, arenaWidth, terrainBlocks, terrainHeightAt } from "../game/terrain";

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
  private readonly groups = new Map<string, THREE.Group>();
  private readonly unitMarkers = new Map<string, THREE.Group>();
  private readonly destroyedPartKeys = new Set<string>();
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
  // A midtone derived from the active map palette; structural props are tinted toward it so
  // they read as part of the map instead of generic brown crates on every battlefield.
  private propTint = new THREE.Color(0x8a7a5c);
  private debug: WorldRenderDebug = emptyDebug();

  constructor(private readonly scene: THREE.Scene) {
    this.scene.add(this.sceneryRoot, this.debrisRoot, this.entityRoot, this.markerRoot, this.orderRoot, this.previewRoot, this.projectileRoot, this.effectRoot, this.objectiveRoot, this.groundAimRoot, this.auraRoot);
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
    this.ghostedEntityIds = this.computeGhostedEntities(sim, targetId, targetPartId, camera);
    this.debug.ghostedEntities = [...this.ghostedEntityIds];
    if (sim.entities.every((e) => e.parts.every((p) => p.hp === p.maxHp))) {
      this.destroyedPartKeys.clear();
      this.debrisRoot.clear();
    }
    this.animateDebris();
    this.pickables.splice(0);
    const liveIds = new Set(sim.entities.map((e) => e.id));
    for (const [id, group] of this.groups) {
      if (!liveIds.has(id)) {
        this.entityRoot.remove(group);
        this.groups.delete(id);
      }
    }
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
    this.syncProjectiles(sim.projectiles);
    this.syncEffects(sim.effects);
    this.syncObjectives(sim);
  }

  // Flag poles (CTF) and the contested zone ring (Hold the Hill), redrawn each frame.
  private syncObjectives(sim: TacticalSim): void {
    this.objectiveRoot.clear();
    const s = sim.modeState;
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

  // Re-theme the whole scene for a map: fog, sky, ground, terrain, grid, and lights.
  applyMap(theme: MapTheme): void {
    this.scene.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);
    this.scene.background = new THREE.Color(theme.sky);
    // A desaturated blend of the map's ground tones — what structural props get nudged toward.
    this.propTint = new THREE.Color(theme.ground).lerp(new THREE.Color(theme.groundAccent), 0.55);
    this.rebuildArena(theme);
  }

  private rebuildArena(theme: MapTheme): void {
    this.sceneryRoot.clear();
    const width = arenaWidth();
    const depth = arenaDepth();

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.18, depth),
      new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 0.95, metalness: 0.02 })
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

    const playerLight = new THREE.PointLight(theme.playerLight, 0.7, 12);
    playerLight.position.set(ARENA_BOUNDS.minX + 6, 4, 0);
    const enemyLight = new THREE.PointLight(theme.enemyLight, 0.7, 12);
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
      const color = entity.team === "player" ? (entity.accent ?? this.playerAccent) : entity.team === "enemy" ? 0xff8f7f : 0xf6d776;
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
      this.markerRoot.remove(marker);
      this.unitMarkers.delete(id);
    }
  }

  private syncEntity(entity: CombatEntity, selectedId: string, targetId: string | undefined, targetPartId: string | undefined, defending: boolean, ghosted: boolean): void {
    let group = this.groups.get(entity.id);
    if (!group) {
      group = this.buildEntity(entity);
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
    // Body rises on each footfall (two per stride) for a walking bounce, locked to distance.
    const bob = moving && isInfantryKind(entity.kind) ? Math.abs(Math.sin(motionTime * 1.6)) * 0.05 : 0;
    // Ease the rendered ground height so stepping on/off cover or terrain ledges glides
    // instead of snapping.
    const prevElevation = group.userData.renderElevation as number | undefined;
    const renderElevation = prevElevation === undefined ? entity.elevation : prevElevation + (entity.elevation - prevElevation) * 0.2;
    group.userData.renderElevation = renderElevation;
    group.position.set(entity.position.x, renderElevation + bob, entity.position.z);
    group.rotation.set(
      moving && isInfantryKind(entity.kind) ? 0.06 : 0,
      entity.yaw,
      moving && entity.kind === "tank" ? Math.sin(motionTime * 4.8) * 0.018 : 0
    );
    if (defending && isInfantryKind(entity.kind) && entity.status.alive) {
      group.scale.set(1.08, 1, 1.08);
    } else {
      group.scale.setScalar(entity.status.alive ? 1 : 0.94);
    }
    const renderGhosted = ghosted;
    group.traverse((object) => {
      if (!("isMesh" in object)) return;
      const mesh = object as PartMesh;
      const partId = mesh.userData.partId as string | undefined;
      if (!partId) return;
      const part = entity.parts.find((p) => p.id === partId);
      if (!part) return;
      this.syncDebris(entity, part);
      this.paintPart(mesh, entity, part, entity.id === selectedId, entity.id === targetId, part.id === targetPartId, renderGhosted);
      if (entity.status.alive) this.pickables.push(mesh);
    });
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
    if (isVehicleKind(entity.kind)) this.buildTank(group, entity);
    if (isInfantryKind(entity.kind)) this.buildSoldier(group, entity);
    if (entity.kind === "base") this.buildBase(group, entity);
    if (isDefenseKind(entity.kind)) this.buildDefense(group, entity);
    if (entity.kind === "cover") this.buildCover(group, entity);
    return group;
  }

  private buildTank(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? 0xff6d57 : 0x50d7ff;
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
      // Extra-long siege barrel + recoil spade reaching out the back.
      this.box(group, entity, "cannon", [0.26, 0.26, 1.7], [0, 1.3, 1.95], 0xb8c4bd, { metalness: 0.42 });
      this.box(group, entity, "cannon", [0.4, 0.16, 0.5], [0, 1.16, 0.2], 0x2a3133, { metalness: 0.3 });
      this.box(group, entity, "hull", [0.5, 0.16, 0.9], [0, 0.32, -1.1], 0x2a3133, { metalness: 0.2 });
    }
  }

  private buildSoldier(group: THREE.Group, entity: CombatEntity): void {
    const palette = infantryPalette(entity.kind);
    const bodyColor = palette.body;
    const trimColor = palette.trim;
    const packColor = palette.pack;
    const teamGlow = entity.team === "enemy" ? 0xff6d57 : 0x5ff1ff;
    this.box(group, entity, "body", [0.52, 0.82, 0.34], [0, 0.77, 0], bodyColor, { emissive: teamGlow, emissiveIntensity: 0.1 });
    this.box(group, entity, "body", [0.58, 0.12, 0.4], [0, 1.08, 0.03], trimColor, { emissive: teamGlow, emissiveIntensity: 0.22 });
    this.box(group, entity, "body", [0.18, 0.18, 0.38], [-0.44, 1.02, 0.02], trimColor, { metalness: 0.18 });
    this.box(group, entity, "body", [0.18, 0.18, 0.38], [0.44, 1.02, 0.02], trimColor, { metalness: 0.18 });
    this.box(group, entity, "head", [0.36, 0.36, 0.36], [0, 1.35, 0.02], 0xd8d2bd);
    if (entity.kind === "sniper") {
      this.box(group, entity, "rifle", [0.14, 0.16, 1.32], [0.48, 0.95, 0.45], trimColor, { metalness: 0.32 });
      this.box(group, entity, "rifle", [0.22, 0.18, 0.2], [0.48, 1.06, 0.08], 0x141819, { emissive: 0x8de4ff, emissiveIntensity: 0.28 });
      this.box(group, entity, "pack", [0.66, 0.1, 0.52], [0, 0.74, -0.45], 0x19303a, { emissive: 0x8de4ff, emissiveIntensity: 0.1 });
      this.box(group, entity, "head", [0.54, 0.1, 0.14], [0, 1.43, 0.18], 0x0a1418, { emissive: 0x8de4ff, emissiveIntensity: 0.45 });
    } else if (entity.kind === "grenadier") {
      this.box(group, entity, "rifle", [0.28, 0.26, 0.84], [0.48, 0.93, 0.28], trimColor, { metalness: 0.2 });
      this.box(group, entity, "rifle", [0.4, 0.36, 0.24], [0.48, 0.93, 0.74], 0x2b2418, { emissive: 0xffb02e, emissiveIntensity: 0.22 });
      for (const x of [-0.18, 0, 0.18]) this.box(group, entity, "pack", [0.12, 0.18, 0.12], [x, 1.06, -0.42], 0xffca6b, { emissive: 0xff7d26, emissiveIntensity: 0.25 });
      this.box(group, entity, "head", [0.48, 0.12, 0.44], [0, 1.54, 0.0], 0x3a2a1d, { metalness: 0.12 });
    } else if (entity.kind === "striker") {
      this.box(group, entity, "rifle", [0.12, 0.16, 1.16], [0.5, 0.86, 0.32], 0xdad2ff, { metalness: 0.24, emissive: 0xb48cff, emissiveIntensity: 0.44 });
      this.box(group, entity, "rifle", [0.16, 0.1, 0.38], [0.5, 1.08, 0.86], 0x9dfcff, { emissive: 0x9dfcff, emissiveIntensity: 0.7 });
      this.box(group, entity, "pack", [0.52, 0.16, 0.34], [0, 0.92, -0.44], 0x2a2142, { emissive: 0xb48cff, emissiveIntensity: 0.24 });
      this.box(group, entity, "head", [0.46, 0.11, 0.4], [0, 1.54, 0.0], 0x241d34, { emissive: teamGlow, emissiveIntensity: 0.2 });
    } else if (entity.kind === "heavy") {
      // Bulky frame, drum-fed auto-cannon, and a big glowing ammo drum on the back.
      this.box(group, entity, "body", [0.74, 0.52, 0.5], [0, 0.95, 0.03], bodyColor, { metalness: 0.14, emissive: 0x401a08, emissiveIntensity: 0.12 });
      this.box(group, entity, "body", [0.9, 0.2, 0.52], [0, 1.12, 0.0], trimColor, { metalness: 0.18 });
      this.box(group, entity, "rifle", [0.27, 0.27, 1.22], [0.52, 0.92, 0.46], 0x2b2f31, { metalness: 0.32 });
      this.cylinder(group, entity, "rifle", 0.26, 0.24, [0.52, 0.74, 0.5], 0x14181a, [0, 0, 0], { metalness: 0.3 });
      this.box(group, entity, "rifle", [0.34, 0.3, 0.22], [0.52, 0.92, 1.12], 0xffca6b, { emissive: 0xff7d26, emissiveIntensity: 0.4 });
      this.box(group, entity, "pack", [0.58, 0.56, 0.42], [0, 0.9, -0.38], 0xffb02e, { emissive: 0xff6b1a, emissiveIntensity: 0.42 });
      this.box(group, entity, "pack", [0.64, 0.12, 0.48], [0, 1.2, -0.38], 0xfff0bf, { emissive: 0xff7d26, emissiveIntensity: 0.5 });
      this.box(group, entity, "head", [0.48, 0.44, 0.46], [0, 1.36, 0.0], 0xb7b0a0, { metalness: 0.14 });
      this.box(group, entity, "head", [0.52, 0.12, 0.16], [0, 1.4, 0.22], 0x141819, { emissive: 0xffb02e, emissiveIntensity: 0.5 });
    } else if (entity.kind === "mortar") {
      // Stubby sidearm plus a long mortar tube slung over the shoulder.
      this.box(group, entity, "rifle", [0.16, 0.16, 0.46], [0.44, 0.94, 0.2], trimColor, { metalness: 0.2 });
      this.cylinder(group, entity, "rifle", 0.13, 1.05, [0.16, 1.18, -0.12], 0x2a2f31, [Math.PI * 0.32, 0, 0], { metalness: 0.34 });
      this.cylinder(group, entity, "rifle", 0.15, 0.1, [-0.04, 1.55, -0.4], 0xffd27a, [Math.PI * 0.32, 0, 0], { emissive: 0xff9e2b, emissiveIntensity: 0.4 });
      this.box(group, entity, "pack", [0.42, 0.4, 0.26], [0, 0.86, -0.34], 0x6a4a1a, { emissive: 0xffb02e, emissiveIntensity: 0.22 });
      this.box(group, entity, "head", [0.42, 0.12, 0.36], [0, 1.54, 0.0], 0x243336, { emissive: teamGlow, emissiveIntensity: 0.08 });
    } else if (entity.kind === "medic") {
      // White kit with a red cross and a small sidearm.
      this.box(group, entity, "rifle", [0.16, 0.16, 0.5], [0.45, 0.9, 0.24], 0xd8d2cf, { metalness: 0.2 });
      this.box(group, entity, "body", [0.2, 0.5, 0.06], [0, 0.86, 0.2], 0xff5a6a, { emissive: 0xff2a44, emissiveIntensity: 0.45 });
      this.box(group, entity, "body", [0.5, 0.18, 0.06], [0, 0.92, 0.2], 0xff5a6a, { emissive: 0xff2a44, emissiveIntensity: 0.45 });
      this.box(group, entity, "head", [0.42, 0.12, 0.36], [0, 1.54, 0.0], 0xffffff, { emissive: 0xff7f8f, emissiveIntensity: 0.24 });
    } else if (entity.kind === "scout") {
      // Light recon: stubby carbine, a tall whip antenna off the pack, and a low-profile
      // visor cap — the leanest, most lightly-armed silhouette on the field.
      this.box(group, entity, "rifle", [0.13, 0.14, 0.62], [0.46, 0.95, 0.22], trimColor, { metalness: 0.22 });
      this.cylinder(group, entity, "pack", 0.028, 0.92, [-0.2, 1.42, -0.34], 0xdaf7e6, [0, 0, 0], { emissive: 0x6ff0b0, emissiveIntensity: 0.5 });
      this.box(group, entity, "pack", [0.07, 0.07, 0.07], [-0.2, 1.9, -0.34], 0x9dffcf, { emissive: 0x6ff0b0, emissiveIntensity: 0.85 });
      this.box(group, entity, "head", [0.44, 0.16, 0.34], [0, 1.5, 0.02], palette.body, { metalness: 0.1 });
      this.box(group, entity, "head", [0.42, 0.08, 0.16], [0, 1.42, 0.2], 0x0e2a24, { emissive: 0x6ff0b0, emissiveIntensity: 0.5 });
    } else if (entity.kind === "engineer") {
      // Builder crew: a welding torch with a hot tip, a big wrench slung on the back, a
      // bright hard hat and hi-vis tool belt — clearly the support/utility unit.
      this.box(group, entity, "rifle", [0.12, 0.12, 0.46], [0.46, 0.92, 0.2], 0x3a3320, { metalness: 0.3 });
      this.box(group, entity, "rifle", [0.1, 0.1, 0.14], [0.46, 0.92, 0.5], 0xffe39a, { emissive: 0xffce4a, emissiveIntensity: 0.95 });
      this.box(group, entity, "pack", [0.1, 0.64, 0.1], [-0.34, 0.92, -0.32], 0xd9d2b0, { metalness: 0.42 });
      this.box(group, entity, "pack", [0.24, 0.16, 0.12], [-0.34, 1.28, -0.32], 0xd9d2b0, { metalness: 0.42 });
      this.box(group, entity, "body", [0.6, 0.1, 0.4], [0, 0.62, 0.02], 0xffce4a, { emissive: 0xff9e2b, emissiveIntensity: 0.32 });
      this.box(group, entity, "head", [0.48, 0.18, 0.44], [0, 1.5, 0.0], 0xffd23f, { emissive: 0xff9e2b, emissiveIntensity: 0.3 });
    } else {
      // Line infantry (soldier): standard rifle and a clear brimmed combat helmet — the
      // plain baseline trooper every other kind reads against.
      this.box(group, entity, "rifle", [0.18, 0.18, 0.9], [0.45, 0.92, 0.28], trimColor);
      this.box(group, entity, "head", [0.42, 0.18, 0.42], [0, 1.5, 0.0], 0x2c3a3d, { metalness: 0.14 });
      this.box(group, entity, "head", [0.46, 0.06, 0.16], [0, 1.42, 0.22], 0x141819, { emissive: teamGlow, emissiveIntensity: 0.14 });
    }
    this.box(group, entity, "pack", [0.38, 0.45, 0.18], [0, 0.82, -0.3], packColor, entity.kind === "grenadier" ? { emissive: 0xff7d26, emissiveIntensity: 0.26 } : {});
    this.box(group, entity, "pack", [0.12, 0.16, 0.08], [-0.24, 1.04, -0.42], 0xdaf7ff, { emissive: teamGlow, emissiveIntensity: 0.42 });
    // Arms and legs are tagged as limbs so they can swing into a walk cycle while moving.
    this.box(group, entity, "body", [0.18, 0.52, 0.18], [-0.42, 0.72, 0.02], bodyColor).userData.limb = "arm-l";
    this.box(group, entity, "body", [0.18, 0.52, 0.18], [0.42, 0.72, 0.02], bodyColor).userData.limb = "arm-r";
    this.box(group, entity, "legs", [0.18, 0.58, 0.2], [-0.18, 0.24, 0], 0x162225).userData.limb = "leg-l";
    this.box(group, entity, "legs", [0.18, 0.58, 0.2], [0.18, 0.24, 0], 0x162225).userData.limb = "leg-r";
    this.box(group, entity, "legs", [0.24, 0.1, 0.24], [-0.18, 0.05, 0.08], 0x101516, { metalness: 0.14 }).userData.limb = "leg-l";
    this.box(group, entity, "legs", [0.24, 0.1, 0.24], [0.18, 0.05, 0.08], 0x101516, { metalness: 0.14 }).userData.limb = "leg-r";
    this.box(group, entity, "head", [0.26, 0.08, 0.12], [0, 1.38, 0.24], 0x141819, { emissive: 0x9dfcff, emissiveIntensity: 0.2 });
  }

  private buildBase(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? 0xff765f : 0x5fe6ff;
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
    const glow = entity.team === "enemy" ? 0xff6d57 : 0x5fe6ff;
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
    const color = entity.coverKind === "cliff" ? 0xb48cff : volatile ? 0xffca6b : entity.coverKind === "ridge" ? 0xf0c37a : 0x8de4ff;
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
    materialOptions: { metalness?: number; emissive?: number; emissiveIntensity?: number } = {}
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
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    this.outline(mesh);
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
    materialOptions: { metalness?: number; emissive?: number; emissiveIntensity?: number } = {}
  ): PartMesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, depth, 14),
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
    mesh.userData.baseEmissive = materialOptions.emissive ?? 0x000000;
    mesh.userData.baseEmissiveIntensity = materialOptions.emissiveIntensity ?? 0;
    mesh.userData.basePosition = mesh.position.clone();
    mesh.userData.baseRotation = mesh.rotation.clone();
    mesh.userData.baseScale = mesh.scale.clone();
    this.outline(mesh);
    group.add(mesh);
    return mesh;
  }

  private outline(mesh: PartMesh): void {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 35),
      new THREE.LineBasicMaterial({ color: 0x050708, transparent: true, opacity: 0.55 })
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
  }

  private animateDebris(): void {
    const now = performance.now() / 1000;
    for (const object of this.debrisRoot.children) {
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

    // Walk cycle: swing arms and legs from the shoulder/hip while the unit is moving.
    const limb = mesh.userData.limb as string | undefined;
    const parent = mesh.parent;
    if (limb && part.hp > 0 && entity.status.alive && entity.stance !== "crouched" && parent?.userData.moving && basePosition) {
      const motionTime = (parent.userData.motionTime as number | undefined) ?? 0;
      const isLeg = limb.startsWith("leg");
      const forwardPair = limb === "leg-l" || limb === "arm-r";
      // motionTime is distance-scaled, so a ~1.6 multiplier yields one stride per ~1.6m walked.
      const swing = Math.sin(motionTime * 1.6 + (forwardPair ? 0 : Math.PI)) * (isLeg ? 0.5 : 0.42);
      const pivotY = isLeg ? 0.52 : 0.98;
      const reach = pivotY - basePosition.y;
      mesh.rotation.x = (baseRotation ? baseRotation.x : 0) + swing;
      mesh.position.z = basePosition.z + reach * Math.sin(swing);
      mesh.position.y = pivotY - reach * Math.cos(swing);
    }

    const base = roleColor(entity, part.role, mesh.userData.baseColor as number);
    const ratio = clamp01(part.hp / part.maxHp);
    const injury = 1 - ratio;
    const color = new THREE.Color(base).lerp(new THREE.Color(0x33120f), injury * 0.55);
    if (ratio < 0.42 && part.hp > 0) color.lerp(new THREE.Color(0xff5f35), 0.16 + injury * 0.18);
    if (!entity.status.alive) color.lerp(new THREE.Color(0x08090a), 0.55);
    if (selected && part.hp > 0) color.lerp(new THREE.Color(0xffffff), 0.24);
    if (targeted && part.hp > 0) color.lerp(new THREE.Color(0xffd166), targetedPart ? 0.58 : 0.3);
    material.color.copy(color);
    const baseEmissive = mesh.userData.baseEmissive as number;
    const unitGlow = entity.kind !== "cover" && entity.team !== "neutral";
    const coverGlow = entity.kind === "cover" && part.hp > 0;
    const coverGlowColor = entity.coverKind === "cliff" ? 0x4a2284 : part.role === "volatile" ? 0x7a4200 : entity.coverKind === "ridge" ? 0x5a3a13 : 0x0a6472;
    const unitGlowColor = entity.team === "enemy" ? 0x4f160f : 0x063a44;
    material.emissive.setHex(part.hp > 0 && targetedPart ? 0x4f3000 : part.hp > 0 && selected ? 0x0b3844 : unitGlow ? unitGlowColor : coverGlow ? coverGlowColor : baseEmissive);
    material.emissiveIntensity = part.hp > 0
      ? (mesh.userData.baseEmissiveIntensity as number) + (unitGlow ? 0.14 : 0) + (coverGlow ? 0.18 : 0) + (selected ? 0.58 : 0) + (targetedPart ? 0.72 : targeted ? 0.34 : 0)
      : 0;
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
    if (entity.kind === "tank" && part.role === "mobility" && mesh.geometry.type === "CylinderGeometry" && mesh.parent?.userData.moving) {
      mesh.rotation.y += ((mesh.parent.userData.motionTime as number | undefined) ?? 0) * 2.2;
    }
  }

  private paintOutline(mesh: PartMesh, ghosted: boolean): void {
    for (const child of mesh.children) {
      if (!child.userData.decor || !("material" in child)) continue;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!(material instanceof THREE.Material)) continue;
        material.transparent = true;
        material.opacity = ghosted ? 0.16 : 0.55;
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
    const color = selected.team === "player" ? (selected.accent ?? this.playerAccent) : selected.team === "enemy" ? 0xff8f7f : 0xf6d776;
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
  private syncAuras(sim: TacticalSim): void {
    this.auraRoot.clear();
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
    this.orderRoot.clear();
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
    this.previewRoot.clear();
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
    this.groundAimRoot.clear();
    if (!point) return;
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
    this.projectileRoot.clear();
    for (const projectile of projectiles) {
      const style = projectileStyle(projectile);
      this.projectileRoot.add(makeLine(projectile.previous, projectile.position, style.trailColor, 0.92, projectile.previousHeight, projectile.height));
      this.projectileRoot.add(makeProjectileShadow(projectile, style.trailColor));

      const model = makeProjectileModel(projectile);
      model.position.set(projectile.position.x, projectile.height, projectile.position.z);
      orientAlongShot(model, projectile.previous, projectile.position);
      this.projectileRoot.add(model);
    }
  }

  private syncEffects(effects: readonly VisualEvent[]): void {
    this.effectRoot.clear();
    for (const effect of effects) {
      const t = clamp01(effect.age / effect.duration);
      const opacity = 1 - t;
      if (effect.type === "shot") {
        this.effectRoot.add(makeBeam(effect.from, effect.to, effect.color, opacity));
      } else if (effect.type === "blast") {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry((effect.radius ?? 1) * t, (effect.radius ?? 1) * t + 0.08, 32),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.7, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(effect.to.x, 0.08, effect.to.z);
        this.effectRoot.add(ring);
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 1) * (0.24 + t * 0.82), 12, 6),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.22, depthWrite: false })
        );
        dome.scale.y = 0.36;
        dome.position.set(effect.to.x, 0.22 + t * 0.36, effect.to.z);
        this.effectRoot.add(dome);
      } else {
        const hit = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 0.45) * (1 + t), 8, 6),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.55 })
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

function makeLabelSprite(text: string, color: number, size = 0.58, background = 0x101516, opacity = 0.94): THREE.Sprite {
  const textureRecord = labelTexture(text, color, background);
  const material = new THREE.SpriteMaterial({ map: textureRecord.texture, transparent: true, opacity, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(textureRecord.aspect * size, size, 1);
  return sprite;
}

function labelTexture(text: string, color: number, background: number): { texture: THREE.CanvasTexture; aspect: number } {
  const key = `${text}|${color.toString(16)}|${background.toString(16)}`;
  const cached = labelTextures.get(key);
  if (cached) return cached;

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
  return {
    trailColor: projectile.color,
  };
}

function orientAlongShot(mesh: THREE.Object3D, from: { x: number; z: number }, to: { x: number; z: number }): void {
  const delta = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
  if (delta.lengthSq() < 0.0001) return;
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
}

function makeProjectileModel(projectile: Projectile): THREE.Group {
  const group = new THREE.Group();
  if (projectile.kind === "shell") {
    const body = new THREE.Mesh(projectileGeometry("shell-body"), projectileMaterial("shell-body", 0xbfd1cc, 0.98));
    const nose = new THREE.Mesh(projectileGeometry("shell-nose"), projectileMaterial("shell-nose", projectile.color, 0.98));
    const exhaust = new THREE.Mesh(projectileGeometry("shell-exhaust"), projectileMaterial("shell-exhaust", 0xffd166, 0.72));
    const bandA = new THREE.Mesh(projectileGeometry("shell-band"), projectileMaterial("shell-band-a", 0x1d2426, 0.9));
    const bandB = new THREE.Mesh(projectileGeometry("shell-band"), projectileMaterial("shell-band-b", projectile.color, 0.88));
    nose.position.y = 0.33;
    exhaust.position.y = -0.32;
    exhaust.scale.setScalar(1.08 + Math.sin(projectile.age * 24) * 0.16);
    bandA.position.y = 0.02;
    bandB.position.y = -0.14;
    bandA.rotation.x = Math.PI / 2;
    bandB.rotation.x = Math.PI / 2;
    bandA.scale.setScalar(0.95);
    bandB.scale.setScalar(0.78);
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const fin = new THREE.Mesh(projectileGeometry("shell-fin"), projectileMaterial("shell-fin", 0x6e7a78, 0.92));
      fin.position.set(Math.cos(angle) * 0.13, -0.18, Math.sin(angle) * 0.13);
      fin.rotation.y = angle;
      group.add(fin);
    }
    group.add(body, nose, exhaust, bandA, bandB);
    group.scale.setScalar(1.14);
    return group;
  }
  if (projectile.kind === "bolt") {
    const core = new THREE.Mesh(projectileGeometry("bolt-core"), projectileMaterial("bolt-core", 0xffd166, 0.98));
    const ringA = new THREE.Mesh(projectileGeometry("bolt-ring"), projectileMaterial("bolt-ring-a", 0xfff1a6, 0.62));
    const ringB = new THREE.Mesh(projectileGeometry("bolt-ring"), projectileMaterial("bolt-ring-b", 0xff765f, 0.48));
    ringA.rotation.x = Math.PI / 2;
    ringB.rotation.x = Math.PI / 2;
    ringA.rotation.z = projectile.age * 6;
    ringB.rotation.z = Math.PI / 2 - projectile.age * 8;
    ringA.scale.setScalar(0.92);
    ringB.scale.setScalar(0.68);
    core.scale.setScalar(1 + Math.sin(projectile.age * 18) * 0.08);
    group.add(core, ringA, ringB);
    group.scale.setScalar(1.18);
    return group;
  }
  if (projectile.kind === "grenade") {
    const body = new THREE.Mesh(projectileGeometry("grenade-body"), projectileMaterial("grenade-body", 0x2f342a, 0.98));
    const band = new THREE.Mesh(projectileGeometry("grenade-band"), projectileMaterial("grenade-band", 0xffbf69, 0.82));
    const spark = new THREE.Mesh(projectileGeometry("grenade-spark"), projectileMaterial("grenade-spark", 0xfff1a6, 0.6));
    band.rotation.x = Math.PI / 2;
    band.rotation.z = projectile.age * (projectile.state === "rolling" ? 20 : 9);
    spark.position.y = projectile.state === "rolling" ? -0.02 : -0.18;
    spark.position.x = projectile.state === "rolling" ? Math.sin(projectile.age * 18) * 0.12 : 0;
    spark.scale.setScalar((projectile.state === "rolling" ? 0.72 : 1) + Math.sin(projectile.age * 18) * 0.18);
    group.add(body, band, spark);
    if (projectile.state === "rolling") group.rotation.z = projectile.age * 8;
    group.scale.setScalar(projectile.state === "rolling" ? 0.94 : 1.08);
    return group;
  }
  const slug = new THREE.Mesh(projectileGeometry("rifle-slug"), projectileMaterial("rifle-slug", 0xeaffff, 0.98));
  const tip = new THREE.Mesh(projectileGeometry("rifle-tip"), projectileMaterial("rifle-tip", projectile.color, 0.96));
  const spark = new THREE.Mesh(projectileGeometry("rifle-spark"), projectileMaterial("rifle-spark", 0xfff1a6, 0.72));
  const tailA = new THREE.Mesh(projectileGeometry("rifle-tail"), projectileMaterial("rifle-tail-a", projectile.color, 0.42));
  const tailB = new THREE.Mesh(projectileGeometry("rifle-tail"), projectileMaterial("rifle-tail-b", 0xeaffff, 0.28));
  tip.position.y = 0.18;
  spark.position.y = -0.2;
  tailA.position.y = -0.24;
  tailB.position.y = -0.34;
  tailB.scale.setScalar(0.72);
  group.add(slug, tip, spark, tailA, tailB);
  return group;
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
    return blendHex(fallback, 0xe66e5c, 0.68);
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

const tubeGeometries = new Map<string, THREE.CylinderGeometry>();
const endpointGeometries = new Map<string, THREE.RingGeometry>();
const projectileShadowGeometries = new Map<string, THREE.CircleGeometry>();
const materials = new Map<string, THREE.Material>();
const projectileGeometries = new Map<string, THREE.BufferGeometry>();
const labelTextures = new Map<string, { texture: THREE.CanvasTexture; aspect: number }>();

function tubeGeometry(radius: number): THREE.CylinderGeometry {
  const key = radius.toFixed(3);
  let geometry = tubeGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(radius, radius, 1, 10, 1, true);
    tubeGeometries.set(key, geometry);
  }
  return geometry;
}

function endpointGeometry(radius: number): THREE.RingGeometry {
  const key = radius.toFixed(2);
  let geometry = endpointGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.RingGeometry(radius, radius + 0.08, 44);
    endpointGeometries.set(key, geometry);
  }
  return geometry;
}

function projectileShadowGeometry(radius: number): THREE.CircleGeometry {
  const key = radius.toFixed(2);
  let geometry = projectileShadowGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.CircleGeometry(radius, 28);
    projectileShadowGeometries.set(key, geometry);
  }
  return geometry;
}

function lineMaterial(color: number, opacity: number, depthWrite = true): THREE.LineBasicMaterial {
  const key = `line:${color}:${opacity.toFixed(2)}:${depthWrite ? 1 : 0}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite });
    materials.set(key, material);
  }
  return material as THREE.LineBasicMaterial;
}

function tubeMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = `tube:${color}:${opacity.toFixed(2)}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

function endpointMaterial(color: number): THREE.MeshBasicMaterial {
  const key = `endpoint:${color}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false });
    materials.set(key, material);
  }
  return material as THREE.MeshBasicMaterial;
}

function projectileShadowMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = `projectile-shadow:${color}:${opacity.toFixed(2)}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
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
    } else {
      geometry = new THREE.SphereGeometry(0.08, 10, 8);
    }
    projectileGeometries.set(key, geometry);
  }
  return geometry;
}

function projectileMaterial(key: string, color: number, opacity: number): THREE.MeshBasicMaterial {
  const materialKey = `projectile:${key}:${color}:${opacity.toFixed(2)}`;
  let material = materials.get(materialKey);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    materials.set(materialKey, material);
  }
  return material as THREE.MeshBasicMaterial;
}
