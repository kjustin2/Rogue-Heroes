import * as THREE from "three";
import { clamp01 } from "../core/math";
import { isInfantryKind, type CombatEntity, type DamagePart, type PartRole } from "../game/damageModel";
import type { Projectile, TacticalSim, VisualEvent } from "../game/sim";
import { ARENA_DEPTH, ARENA_WIDTH, terrainHeightAt } from "../game/terrain";

type PartMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

export class WorldRenderer {
  readonly pickables: THREE.Object3D[] = [];

  private readonly entityRoot = new THREE.Group();
  private readonly orderRoot = new THREE.Group();
  private readonly previewRoot = new THREE.Group();
  private readonly projectileRoot = new THREE.Group();
  private readonly effectRoot = new THREE.Group();
  private readonly sceneryRoot = new THREE.Group();
  private readonly debrisRoot = new THREE.Group();
  private readonly groups = new Map<string, THREE.Group>();
  private readonly destroyedPartKeys = new Set<string>();
  private readonly ring: THREE.Mesh;
  private readonly selectionDisc: THREE.Mesh;
  private readonly selectionBeacon: THREE.Mesh;
  private readonly selectionLight: THREE.PointLight;
  private readonly targetRing: THREE.Mesh;
  private readonly actionRangeRing: THREE.Mesh;

  constructor(private readonly scene: THREE.Scene) {
    this.scene.add(this.sceneryRoot, this.debrisRoot, this.entityRoot, this.orderRoot, this.previewRoot, this.projectileRoot, this.effectRoot);
    this.addArena();
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

    this.selectionLight = new THREE.PointLight(0x9dfcff, 2.1, 6.6);
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
    for (const radius of [0.028, 0.04]) projectileSparkGeometry(radius);
    for (const color of [0x75d8ff, 0xff765f, 0xffbf69, 0xffd166, 0xeaffff]) {
      lineMaterial(color, 0.5);
      tubeMaterial(color, 0.5);
      endpointMaterial(color);
    }
  }

  update(sim: TacticalSim, targetId?: string, targetPartId?: string): void {
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
    for (const entity of sim.entities) this.syncEntity(entity, sim.selectedId, targetId, targetPartId, sim.defending.has(entity.id));
    this.syncSelection(sim);
    this.syncTarget(sim, targetId);
    this.syncActionRange(sim);
    this.syncOrders(sim);
    this.syncShotPreview(sim, targetId, targetPartId);
    this.syncProjectiles(sim.projectiles);
    this.syncEffects(sim.effects);
  }

  private addArena(): void {
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(ARENA_WIDTH, 0.18, ARENA_DEPTH),
      new THREE.MeshStandardMaterial({ color: 0x6f4f2e, roughness: 0.94, metalness: 0.02 })
    );
    floor.position.y = -0.11;
    floor.receiveShadow = true;
    this.sceneryRoot.add(floor);

    const hill = makeTerrainMesh();
    this.sceneryRoot.add(hill);

    const grid = new THREE.GridHelper(ARENA_WIDTH, 36, 0xd6ad6d, 0x8a6540);
    grid.position.y = 0.005;
    grid.scale.z = ARENA_DEPTH / ARENA_WIDTH;
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) {
      material.opacity = 0.24;
      material.transparent = true;
    }
    this.sceneryRoot.add(grid);

    const railMat = new THREE.MeshStandardMaterial({ color: 0x513822, roughness: 0.92, metalness: 0.02 });
    for (const [x, z, sx, sz] of [
      [0, -12.1, ARENA_WIDTH + 0.4, 0.22],
      [0, 12.1, ARENA_WIDTH + 0.4, 0.22],
      [-18.1, 0, 0.22, ARENA_DEPTH + 0.4],
      [18.1, 0, 0.22, ARENA_DEPTH + 0.4],
    ] as const) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.34, sz), railMat);
      rail.position.set(x, 0.1, z);
      rail.castShadow = true;
      rail.receiveShadow = true;
      this.sceneryRoot.add(rail);
    }

    const padMat = new THREE.MeshStandardMaterial({ color: 0x2f626a, roughness: 0.86, emissive: 0x0b2e33, emissiveIntensity: 0.34 });
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0x7c4030, roughness: 0.86, emissive: 0x3a130d, emissiveIntensity: 0.32 });
    const playerPad = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.08, 10.2), padMat);
    playerPad.position.set(-12.2, 0.01, -0.7);
    playerPad.receiveShadow = true;
    this.sceneryRoot.add(playerPad);
    const enemyPad = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.08, 10.2), enemyMat);
    enemyPad.position.set(12.2, 0.01, -0.7);
    enemyPad.receiveShadow = true;
    this.sceneryRoot.add(enemyPad);

    this.addBattlefieldDressing();

    for (const z of [-6.2, -3.8, -1.4, 1.0, 3.4]) {
      this.strip(-12.2, z, 5.9, 0x59d4ff);
      this.strip(12.2, z, 5.9, 0xff7d66);
    }

    for (const [x, z, radius, color] of [
      [-4.5, 4.2, 1.1, 0x7b4a28],
      [4.5, -4.2, 1.35, 0x8f5a2f],
      [0.8, 0.1, 0.9, 0x5f4128],
      [8.2, -6.5, 1.2, 0x91562e],
      [-9.8, 6.5, 1.05, 0x6d4b2e],
    ] as const) {
      const scorch = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 28),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, depthWrite: false })
      );
      scorch.rotation.x = -Math.PI / 2;
      scorch.position.set(x, 0.012, z);
      this.sceneryRoot.add(scorch);
    }

    const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x9a6a3c, roughness: 0.96, metalness: 0.02 });
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.36, 1.28), ridgeMat);
    ridge.position.set(1.1, terrainHeightAt({ x: 1.1, z: 5.3 }) + 0.16, 5.3);
    ridge.castShadow = true;
    ridge.receiveShadow = true;
    this.sceneryRoot.add(ridge);
    for (const x of [-0.6, 1.1, 2.8]) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.04, 1.4),
        new THREE.MeshStandardMaterial({ color: 0xf1c37a, emissive: 0x6c3a13, emissiveIntensity: 0.28, roughness: 0.72 })
      );
      stripe.position.set(x, 0.38, 5.3);
      stripe.position.y += terrainHeightAt({ x, z: 5.3 });
      stripe.receiveShadow = true;
      this.sceneryRoot.add(stripe);
    }

    const playerLight = new THREE.PointLight(0x60d7ff, 0.7, 8);
    playerLight.position.set(-12.2, 3, -0.7);
    const enemyLight = new THREE.PointLight(0xff7c5e, 0.7, 8);
    enemyLight.position.set(12.2, 3, -0.7);
    this.sceneryRoot.add(playerLight, enemyLight);
  }

  private addBattlefieldDressing(): void {
    const rippleMat = new THREE.MeshStandardMaterial({ color: 0xd8aa69, roughness: 0.96, metalness: 0.01 });
    const trackMat = new THREE.MeshStandardMaterial({ color: 0x5d3a20, roughness: 0.98, metalness: 0.01, transparent: true, opacity: 0.58 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a5f3a, roughness: 0.96, metalness: 0.01 });
    const paleStoneMat = new THREE.MeshStandardMaterial({ color: 0xb9854b, roughness: 0.94, metalness: 0.01 });
    const brushMat = new THREE.MeshStandardMaterial({ color: 0x6b6234, roughness: 1, metalness: 0 });

    for (const [x, z, width, angle] of [
      [-13.0, -1.4, 7.4, -0.12],
      [-12.6, 1.2, 6.8, -0.1],
      [12.4, -1.2, 7.2, 0.11],
      [12.0, 1.4, 6.6, 0.1],
      [4.3, -6.0, 4.2, 0.2],
      [-6.2, 5.6, 3.8, -0.28],
    ] as const) {
      const track = new THREE.Mesh(new THREE.BoxGeometry(width, 0.026, 0.12), trackMat);
      track.rotation.y = angle;
      track.position.set(x, terrainHeightAt({ x, z }) + 0.04, z);
      track.receiveShadow = true;
      this.sceneryRoot.add(track);
    }

    for (const [x, z, sx, angle] of [
      [-7.8, -7.6, 2.4, 0.16],
      [-5.6, -6.9, 1.7, 0.13],
      [-2.1, -5.7, 2.8, 0.08],
      [2.2, -7.2, 2.5, -0.1],
      [6.8, -5.9, 1.9, -0.18],
      [9.4, -4.8, 2.4, -0.22],
      [-10.6, 6.1, 1.8, 0.28],
      [5.4, 6.8, 2.1, -0.3],
      [9.2, 3.2, 1.6, -0.2],
      [-8.8, 1.4, 2.2, 0.08],
    ] as const) {
      const ripple = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.024, 0.045), rippleMat);
      ripple.rotation.y = angle;
      ripple.position.set(x, terrainHeightAt({ x, z }) + 0.052, z);
      ripple.receiveShadow = true;
      this.sceneryRoot.add(ripple);
    }

    for (const [x, z, radius, scaleZ] of [
      [0.9, 5.25, 1.7, 0.54],
      [0.9, 5.25, 2.45, 0.48],
      [0.9, 5.25, 3.2, 0.42],
      [-5.7, -5.4, 2.4, 0.55],
      [8.1, -6.4, 1.8, 0.5],
    ] as const) {
      const contour = new THREE.Mesh(
        new THREE.RingGeometry(radius, radius + 0.025, 80),
        new THREE.MeshBasicMaterial({ color: 0xf0c37a, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false })
      );
      contour.rotation.x = -Math.PI / 2;
      contour.scale.z = scaleZ;
      contour.position.set(x, terrainHeightAt({ x, z }) + 0.08 + radius * 0.025, z);
      this.sceneryRoot.add(contour);
    }

    for (const [x, z, radius, mat, sy] of [
      [-7.5, 4.7, 0.2, stoneMat, 0.58],
      [-6.9, 4.2, 0.13, paleStoneMat, 0.5],
      [-1.8, 6.8, 0.18, stoneMat, 0.62],
      [2.4, 6.8, 0.16, paleStoneMat, 0.52],
      [5.8, -2.6, 0.14, stoneMat, 0.5],
      [10.4, -7.0, 0.2, stoneMat, 0.55],
      [-14.4, -6.2, 0.18, paleStoneMat, 0.52],
      [14.1, 4.4, 0.16, stoneMat, 0.5],
      [7.5, 1.8, 0.12, paleStoneMat, 0.46],
      [-3.4, -1.6, 0.14, stoneMat, 0.48],
    ] as const) {
      const stone = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 0), mat);
      stone.scale.y = sy;
      stone.rotation.set(radius * 7.1, x * 0.17, z * 0.13);
      stone.position.set(x, terrainHeightAt({ x, z }) + radius * sy * 0.42, z);
      stone.castShadow = true;
      stone.receiveShadow = true;
      this.sceneryRoot.add(stone);
    }

    for (const [x, z, scale] of [
      [-15.4, -7.1, 0.42],
      [-9.1, -8.3, 0.36],
      [-6.0, 7.4, 0.34],
      [6.2, 7.2, 0.38],
      [13.8, -6.4, 0.44],
      [10.8, 2.7, 0.32],
    ] as const) {
      const brush = new THREE.Group();
      for (let i = 0; i < 5; i += 1) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.32 + i * 0.015, 0.035), brushMat);
        blade.rotation.z = -0.45 + i * 0.22;
        blade.rotation.y = i * 0.9;
        blade.position.y = 0.15;
        brush.add(blade);
      }
      brush.scale.setScalar(scale);
      brush.position.set(x, terrainHeightAt({ x, z }) + 0.04, z);
      this.sceneryRoot.add(brush);
    }
  }

  private syncEntity(entity: CombatEntity, selectedId: string, targetId: string | undefined, targetPartId: string | undefined, defending: boolean): void {
    let group = this.groups.get(entity.id);
    if (!group) {
      group = this.buildEntity(entity);
      this.groups.set(entity.id, group);
      this.entityRoot.add(group);
    }
    group.visible = entity.status.alive;
    group.position.set(entity.position.x, entity.elevation, entity.position.z);
    group.rotation.y = entity.yaw;
    if (defending && isInfantryKind(entity.kind) && entity.status.alive) {
      group.scale.set(1.08, 1, 1.08);
    } else {
      group.scale.setScalar(entity.status.alive ? 1 : 0.94);
    }
    group.traverse((object) => {
      if (!("isMesh" in object)) return;
      const mesh = object as PartMesh;
      const partId = mesh.userData.partId as string | undefined;
      if (!partId) return;
      const part = entity.parts.find((p) => p.id === partId);
      if (!part) return;
      this.syncDebris(entity, part);
      this.paintPart(mesh, entity, part, entity.id === selectedId, entity.id === targetId, part.id === targetPartId);
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
    if (entity.kind === "tank") this.buildTank(group, entity);
    if (isInfantryKind(entity.kind)) this.buildSoldier(group, entity);
    if (entity.kind === "base") this.buildBase(group, entity);
    if (entity.kind === "cover") this.buildCover(group, entity);
    return group;
  }

  private buildTank(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? 0xff6d57 : 0x50d7ff;
    const factionPanel = entity.team === "enemy" ? 0x6a2722 : 0x123f55;
    this.box(group, entity, "hull", [2.35, 0.72, 1.35], [0, 0.58, 0], 0x6fb7d7);
    this.box(group, entity, "hull", [1.86, 0.16, 1.5], [0, 0.98, -0.02], 0x28474f, { metalness: 0.16 });
    this.box(group, entity, "hull", [0.16, 0.18, 1.42], [-0.86, 1.12, -0.04], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.12 });
    this.box(group, entity, "hull", [0.16, 0.18, 1.42], [0.86, 1.12, -0.04], factionPanel, { emissive: factionGlow, emissiveIntensity: 0.12 });
    this.box(group, entity, "front-plate", [2.28, 0.5, 0.22], [0, 0.68, 0.82], 0xc0cdc9);
    this.box(group, entity, "front-plate", [0.54, 0.18, 0.12], [-0.62, 0.83, 1.0], 0xfff4ca, { emissive: factionGlow, emissiveIntensity: 0.36 });
    this.box(group, entity, "front-plate", [0.54, 0.18, 0.12], [0.62, 0.83, 1.0], 0xfff4ca, { emissive: factionGlow, emissiveIntensity: 0.36 });
    this.box(group, entity, "turret", [1.08, 0.44, 0.86], [0, 1.12, 0.04], 0x5ba2c5);
    this.box(group, entity, "turret", [0.78, 0.16, 0.56], [0, 1.42, -0.08], 0x25444d, { metalness: 0.2 });
    this.box(group, entity, "cannon", [0.24, 0.24, 1.45], [0, 1.16, 1.03], 0xd9e6df, { metalness: 0.35 });
    this.box(group, entity, "cannon", [0.36, 0.34, 0.22], [0, 1.16, 1.8], 0xffffff, { emissive: 0x88ecff, emissiveIntensity: 0.28 });
    this.box(group, entity, "cannon", [0.42, 0.1, 0.16], [0, 1.32, 0.52], 0x121617, { metalness: 0.36 });
    this.box(group, entity, "left-tread", [0.34, 0.5, 1.72], [-1.32, 0.32, 0], 0x22282a);
    this.box(group, entity, "right-tread", [0.34, 0.5, 1.72], [1.32, 0.32, 0], 0x22282a);
    for (const side of [-1, 1]) {
      for (const z of [-0.58, 0, 0.58]) {
        this.cylinder(group, entity, side < 0 ? "left-tread" : "right-tread", 0.28, 0.16, [side * 1.36, 0.32, z], 0x0d1112);
      }
    }
    this.box(group, entity, "turret", [0.44, 0.16, 0.18], [-0.58, 1.34, -0.16], 0xdaf7ff, { emissive: 0x50d7ff, emissiveIntensity: 0.4 });
    this.box(group, entity, "turret", [0.44, 0.16, 0.18], [0.58, 1.34, -0.16], 0xdaf7ff, { emissive: 0x50d7ff, emissiveIntensity: 0.4 });
    this.box(group, entity, "turret", [0.08, 0.58, 0.08], [-0.46, 1.72, -0.32], 0x0d1112, { metalness: 0.28 });
    this.box(group, entity, "turret", [0.28, 0.08, 0.08], [-0.46, 2.03, -0.32], 0xdaf7ff, { emissive: factionGlow, emissiveIntensity: 0.5 });
    this.box(group, entity, "hull", [0.18, 0.22, 0.44], [-0.44, 0.86, -0.88], 0x151b1d, { emissive: 0xff7d26, emissiveIntensity: 0.18 });
    this.box(group, entity, "hull", [0.18, 0.22, 0.44], [0.44, 0.86, -0.88], 0x151b1d, { emissive: 0xff7d26, emissiveIntensity: 0.18 });
  }

  private buildSoldier(group: THREE.Group, entity: CombatEntity): void {
    const bodyColor = entity.kind === "sniper" ? 0x5cc9ff : entity.kind === "grenadier" ? 0xffb23f : entity.kind === "striker" ? 0xd28cff : 0x26f0c8;
    const trimColor = entity.kind === "sniper" ? 0xf0fdff : entity.kind === "grenadier" ? 0xfff0ba : entity.kind === "striker" ? 0xffffff : 0xeaffff;
    const packColor = entity.kind === "sniper" ? 0x16486a : entity.kind === "grenadier" ? 0x784214 : entity.kind === "striker" ? 0x4a2b78 : 0x1d5f66;
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
    } else {
      this.box(group, entity, "rifle", [0.18, 0.18, 0.9], [0.45, 0.92, 0.28], trimColor);
      this.box(group, entity, "head", [0.42, 0.12, 0.36], [0, 1.54, 0.0], 0x243336, { emissive: teamGlow, emissiveIntensity: 0.08 });
    }
    this.box(group, entity, "pack", [0.38, 0.45, 0.18], [0, 0.82, -0.3], packColor, entity.kind === "grenadier" ? { emissive: 0xff7d26, emissiveIntensity: 0.26 } : {});
    this.box(group, entity, "pack", [0.12, 0.16, 0.08], [-0.24, 1.04, -0.42], 0xdaf7ff, { emissive: teamGlow, emissiveIntensity: 0.42 });
    this.box(group, entity, "body", [0.18, 0.52, 0.18], [-0.42, 0.72, 0.02], bodyColor);
    this.box(group, entity, "body", [0.18, 0.52, 0.18], [0.42, 0.72, 0.02], bodyColor);
    this.box(group, entity, "legs", [0.18, 0.58, 0.2], [-0.18, 0.24, 0], 0x162225);
    this.box(group, entity, "legs", [0.18, 0.58, 0.2], [0.18, 0.24, 0], 0x162225);
    this.box(group, entity, "legs", [0.24, 0.1, 0.24], [-0.18, 0.05, 0.08], 0x101516, { metalness: 0.14 });
    this.box(group, entity, "legs", [0.24, 0.1, 0.24], [0.18, 0.05, 0.08], 0x101516, { metalness: 0.14 });
    this.box(group, entity, "head", [0.26, 0.08, 0.12], [0, 1.38, 0.24], 0x141819, { emissive: 0x9dfcff, emissiveIntensity: 0.2 });
  }

  private buildBase(group: THREE.Group, entity: CombatEntity): void {
    const factionGlow = entity.team === "enemy" ? 0xff765f : 0x5fe6ff;
    this.box(group, entity, "core", [2.45, 1.35, 2.05], [0, 0.68, 0], 0xd06458);
    this.box(group, entity, "core", [2.72, 0.22, 2.32], [0, 1.48, 0], 0x51231f, { metalness: 0.18 });
    for (const x of [-1.42, 1.42]) this.box(group, entity, "core", [0.26, 1.52, 0.28], [x, 0.82, -0.52], 0x7c3f39, { metalness: 0.14 });
    this.box(group, entity, "turret", [0.92, 0.48, 0.92], [0.2, 1.62, 0.15], 0xef8a65);
    this.box(group, entity, "turret", [0.24, 0.24, 1.35], [0.2, 1.66, 0.98], 0xffd0bc, { metalness: 0.25 });
    this.box(group, entity, "turret", [0.72, 0.14, 0.28], [0.2, 1.95, 0.18], 0xfff0bf, { emissive: factionGlow, emissiveIntensity: 0.36 });
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
    } else {
      this.box(group, entity, part.id, [1.82, 1.25, 0.56], [0, 0.63, 0], 0xb98b5b);
      this.box(group, entity, part.id, [1.66, 0.22, 0.62], [0, 1.37, 0], 0xe0b673);
      this.box(group, entity, part.id, [0.14, 1.12, 0.66], [-0.58, 0.7, 0], 0x7a5535);
      this.box(group, entity, part.id, [0.14, 1.12, 0.66], [0.58, 0.7, 0], 0x7a5535);
      for (const x of [-0.34, 0.34]) this.box(group, entity, part.id, [0.1, 1.02, 0.08], [x, 0.7, 0.34], 0xf0c37a, { emissive: 0x6c3a13, emissiveIntensity: 0.16 });
    }
    this.interactionGlow(group, entity, volatile);
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

  private strip(x: number, z: number, width: number, color: number): void {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.045, 0.055),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.65, roughness: 0.45 })
    );
    strip.position.set(x, 0.08, z);
    strip.receiveShadow = true;
    this.sceneryRoot.add(strip);
  }

  private spawnDebris(entity: CombatEntity, part: DamagePart): void {
    const count = part.role === "armor" || part.role === "core" ? 11 : part.role === "mobility" ? 8 : part.role === "weapon" ? 7 : 5;
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.outline(mesh);
      this.debrisRoot.add(mesh);
    }

    const spark = new THREE.PointLight(part.role === "volatile" ? 0xff9c3b : part.role === "utility" ? 0x9dfcff : 0xffd27a, 0.75, 3.2);
    spark.position.set(entity.position.x, 1.2, entity.position.z);
    this.debrisRoot.add(spark);
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

  private paintPart(mesh: PartMesh, entity: CombatEntity, part: DamagePart, selected: boolean, targeted: boolean, targetedPart: boolean): void {
    const material = mesh.material;
    const basePosition = mesh.userData.basePosition as THREE.Vector3 | undefined;
    const baseRotation = mesh.userData.baseRotation as THREE.Euler | undefined;
    const baseScale = mesh.userData.baseScale as THREE.Vector3 | undefined;
    if (basePosition) mesh.position.copy(basePosition);
    if (baseRotation) mesh.rotation.copy(baseRotation);
    if (baseScale) mesh.scale.copy(baseScale);
    if (entity.stance === "crouched" && isInfantryKind(entity.kind) && part.hp > 0) {
      if (part.role === "mobility") {
        mesh.scale.y *= 0.72;
        mesh.position.y = Math.max(0.08, mesh.position.y - 0.04);
      } else if (part.role === "head") {
        mesh.position.y -= 0.34;
      } else if (part.role === "core") {
        mesh.position.y -= 0.2;
        mesh.scale.y *= 0.86;
      } else {
        mesh.position.y -= 0.18;
      }
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
    mesh.visible = part.hp > 0 || entity.kind !== "cover";
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
  }

  private syncSelection(sim: TacticalSim): void {
    const selected = sim.selected;
    this.ring.visible = Boolean(selected);
    this.selectionDisc.visible = Boolean(selected);
    this.selectionBeacon.visible = Boolean(selected);
    this.selectionLight.visible = Boolean(selected);
    if (!selected) return;
    const color = selected.team === "player" ? 0x9dfcff : selected.team === "enemy" ? 0xff8f7f : 0xf6d776;
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
    this.selectionDisc.scale.setScalar(scale * (1.32 + pulse * 0.08));
    const discMat = this.selectionDisc.material as THREE.MeshBasicMaterial;
    discMat.color.setHex(color);
    discMat.opacity = 0.2 + pulse * 0.12;
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
    this.selectionLight.intensity = 1.9 + pulse * 1.1;
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
    mat.color.setHex(range.kind === "melee" ? 0xd28cff : 0xffbf4d);
    mat.opacity = 0.34 + pulse * 0.16;
  }

  private syncOrders(sim: TacticalSim): void {
    this.orderRoot.clear();
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
    const preview = sim.previewShot(actor.id, targetId, targetPartId);
    if (!target || target.team === "player" || !preview) return;

    const impact = preview.impactEntityId ? sim.entity(preview.impactEntityId) : undefined;
    const friendlyRisk = Boolean(preview.warningEntityId);
    const clear = !preview.blockedById && !preview.blockedByGround && !friendlyRisk;
    const previewColor = friendlyRisk ? 0xff527a : clear ? 0x8de4ff : preview.blockedByGround ? 0xff6f4f : 0xffbf69;
    this.addPreviewTrajectory(preview.from, preview.impactPoint, previewColor, clear ? 0.48 : 0.6, preview.fromHeight, preview.impactHeight, preview.arcHeight, 0.052);
    this.previewRoot.add(makeEndpoint(preview.impactPoint, previewColor, (impact?.radius ?? 0.72) + 0.18, preview.impactHeight + 0.045));
    if (preview.blockedById) {
      this.addPreviewTrajectory(preview.impactPoint, preview.aimPoint, 0xff765f, 0.3, preview.impactHeight, preview.aimHeight, 0, 0.035);
      this.previewRoot.add(makeEndpoint(preview.aimPoint, 0xff765f, target.radius + 0.1, preview.aimHeight + 0.04));
    } else if (preview.blockedByGround || friendlyRisk) {
      this.addPreviewTrajectory(preview.impactPoint, preview.aimPoint, 0xff765f, 0.3, preview.impactHeight, preview.aimHeight, 0, 0.035);
      this.previewRoot.add(makeEndpoint(preview.aimPoint, 0xff765f, target.radius + 0.1, preview.aimHeight + 0.04));
    }
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
      this.projectileRoot.add(makeTubeLine(projectile.previous, projectile.position, style.trailColor, style.trailOpacity, projectile.previousHeight, style.trailRadius, projectile.height));
      const tracer = makeLine(projectile.previous, projectile.position, style.trailColor, 0.9, projectile.previousHeight, projectile.height);
      this.projectileRoot.add(tracer);
      const heavyVolley = projectiles.length > 8;
      if (!heavyVolley) for (const accent of projectileAccentTrails(projectile)) this.projectileRoot.add(accent);
      this.projectileRoot.add(makeProjectileShadow(projectile, style.trailColor));
      if (!heavyVolley) for (const spark of projectileSparks(projectile, style.trailColor)) this.projectileRoot.add(spark);

      const model = makeProjectileModel(projectile);
      model.position.set(projectile.position.x, projectile.height, projectile.position.z);
      orientAlongShot(model, projectile.previous, projectile.position);
      this.projectileRoot.add(model);

      if (!heavyVolley) {
        const glow = new THREE.PointLight(style.trailColor, style.glow, style.glowRange);
        glow.position.set(projectile.position.x, projectile.height + 0.1, projectile.position.z);
        this.projectileRoot.add(glow);
      }
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
          new THREE.RingGeometry((effect.radius ?? 1) * t, (effect.radius ?? 1) * t + 0.08, 48),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.7, side: THREE.DoubleSide })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(effect.to.x, 0.08, effect.to.z);
        this.effectRoot.add(ring);
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 1) * (0.24 + t * 0.82), 18, 10),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.22, depthWrite: false })
        );
        dome.scale.y = 0.36;
        dome.position.set(effect.to.x, 0.22 + t * 0.36, effect.to.z);
        this.effectRoot.add(dome);
        this.effectRoot.add(makeRadialBurst(effect.to, effect.color, opacity * 0.58, (effect.radius ?? 1) * (0.5 + t * 0.85), 0.18 + t * 0.24));
      } else {
        const hit = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 0.45) * (1 + t), 12, 8),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.55 })
        );
        hit.position.set(effect.to.x, 0.8, effect.to.z);
        this.effectRoot.add(hit);
        const impactRing = new THREE.Mesh(
          new THREE.RingGeometry((effect.radius ?? 0.45) * (0.35 + t * 0.85), (effect.radius ?? 0.45) * (0.35 + t * 0.85) + 0.04, 32),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.52, side: THREE.DoubleSide, depthWrite: false })
        );
        impactRing.rotation.x = -Math.PI / 2;
        impactRing.position.set(effect.to.x, 0.11, effect.to.z);
        this.effectRoot.add(impactRing);
        this.effectRoot.add(makeRadialBurst(effect.to, effect.color, opacity * 0.42, (effect.radius ?? 0.45) * (0.8 + t), 0.72));
      }
    }
  }
}

function projectileStyle(projectile: Projectile): {
  trailColor: number;
  trailOpacity: number;
  trailY: number;
  trailRadius: number;
  lineY: number;
  meshY: number;
  glow: number;
  glowRange: number;
} {
  if (projectile.kind === "shell") {
    return {
      trailColor: projectile.color,
      trailOpacity: 0.78,
      trailY: 0.7,
      trailRadius: 0.085,
      lineY: 0.34,
      meshY: 0.72,
      glow: 0.85,
      glowRange: 3.4,
    };
  }
  if (projectile.kind === "bolt") {
    return {
      trailColor: 0xffd166,
      trailOpacity: 0.74,
      trailY: 0.92,
      trailRadius: 0.065,
      lineY: 0.42,
      meshY: 0.94,
      glow: 0.95,
      glowRange: 3.8,
    };
  }
  if (projectile.kind === "grenade") {
    if (projectile.state === "rolling") {
      return {
        trailColor: 0xffbf69,
        trailOpacity: 0.42,
        trailY: 0.24,
        trailRadius: 0.04,
        lineY: 0.18,
        meshY: 0.2,
        glow: 0.38,
        glowRange: 1.8,
      };
    }
    return {
      trailColor: 0xffbf69,
      trailOpacity: 0.68,
      trailY: 0.64,
      trailRadius: 0.07,
      lineY: 0.3,
      meshY: 0.68,
      glow: 0.72,
      glowRange: 3.0,
    };
  }
  return {
    trailColor: projectile.color,
    trailOpacity: 0.5,
    trailY: 0.54,
    trailRadius: 0.026,
    lineY: 0.18,
    meshY: 0.56,
    glow: 0.45,
    glowRange: 2.1,
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

function projectileAccentTrails(projectile: Projectile): THREE.Object3D[] {
  if (projectile.kind === "shell") {
    return [
      makeTubeLine(projectile.previous, projectile.position, 0xffd166, 0.2, projectile.previousHeight - 0.12, 0.13, projectile.height - 0.12),
      makeLine(offsetPoint(projectile.previous, 0.08), offsetPoint(projectile.position, 0.08), 0xffffff, 0.24, projectile.previousHeight - 0.28, projectile.height - 0.28),
      makeLine(offsetPoint(projectile.previous, -0.11), offsetPoint(projectile.position, -0.11), 0xff765f, 0.22, projectile.previousHeight - 0.18, projectile.height - 0.18),
    ];
  }
  if (projectile.kind === "bolt") {
    return [
      makeTubeLine(projectile.previous, projectile.position, 0xfff1a6, 0.28, projectile.previousHeight + 0.1, 0.11, projectile.height + 0.1),
      makeLine(offsetPoint(projectile.previous, -0.1), offsetPoint(projectile.position, -0.1), 0xff765f, 0.36, projectile.previousHeight - 0.18, projectile.height - 0.18),
    ];
  }
  if (projectile.kind === "grenade") {
    if (projectile.state === "rolling") {
      return [
        makeLine(offsetPoint(projectile.previous, 0.045), offsetPoint(projectile.position, 0.045), 0xffbf69, 0.34, projectile.previousHeight + 0.03, projectile.height + 0.03),
        makeLine(offsetPoint(projectile.previous, -0.04), offsetPoint(projectile.position, -0.04), 0x6b3d1f, 0.28, projectile.previousHeight - 0.03, projectile.height - 0.03),
      ];
    }
    return [
      makeTubeLine(projectile.previous, projectile.position, 0xff7d26, 0.22, projectile.previousHeight - 0.08, 0.11, projectile.height - 0.08),
      makeLine(offsetPoint(projectile.previous, 0.075), offsetPoint(projectile.position, 0.075), 0xfff1a6, 0.32, projectile.previousHeight - 0.16, projectile.height - 0.16),
    ];
  }
  return [
    makeLine(offsetPoint(projectile.previous, 0.045), offsetPoint(projectile.position, 0.045), 0xeaffff, 0.52, projectile.previousHeight + 0.06, projectile.height + 0.06),
    makeLine(offsetPoint(projectile.previous, -0.045), offsetPoint(projectile.position, -0.045), projectile.color, 0.34, projectile.previousHeight - 0.05, projectile.height - 0.05),
  ];
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

function projectileSparks(projectile: Projectile, color: number): THREE.Mesh[] {
  const sparks: THREE.Mesh[] = [];
  const count = projectile.kind === "shell" ? 3 : projectile.kind === "grenade" ? projectile.state === "rolling" ? 2 : 3 : projectile.kind === "bolt" ? 4 : 2;
  const seed = hash(projectile.id);
  for (let i = 0; i < count; i += 1) {
    const phase = projectile.age * (9 + i * 1.7) + seed * 0.0004 + i * 2.1;
    const lateral = Math.sin(phase) * (0.08 + i * 0.014);
    const vertical = projectile.state === "rolling" ? Math.max(-0.015, Math.cos(phase * 1.3) * 0.018) : Math.cos(phase * 1.3) * (0.05 + i * 0.006);
    const behind = 0.09 + i * 0.055;
    const spark = new THREE.Mesh(
      projectileSparkGeometry(projectile.kind === "rifle" ? 0.028 : 0.04),
      projectileMaterial(`spark-${projectile.kind}-${i}`, i % 2 ? color : 0xfff1a6, projectile.kind === "bolt" ? 0.72 : 0.58)
    );
    spark.position.set(
      projectile.position.x - projectile.direction.x * behind + lateral,
      projectile.height + vertical,
      projectile.position.z - projectile.direction.z * behind - lateral
    );
    spark.scale.setScalar(1 + Math.sin(phase * 1.7) * 0.22);
    sparks.push(spark);
  }
  return sparks;
}

function offsetPoint(point: { x: number; z: number }, amount: number): { x: number; z: number } {
  return { x: point.x + amount, z: point.z - amount };
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

function makeRadialBurst(center: { x: number; z: number }, color: number, opacity: number, radius: number, y: number): THREE.Group {
  const group = new THREE.Group();
  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2;
    const inner = {
      x: center.x + Math.sin(angle) * radius * 0.18,
      z: center.z + Math.cos(angle) * radius * 0.18,
    };
    const outer = {
      x: center.x + Math.sin(angle) * radius,
      z: center.z + Math.cos(angle) * radius,
    };
    group.add(makeLine(inner, outer, i % 2 ? color : 0xffffff, opacity * (i % 2 ? 0.82 : 0.42), y, y + 0.08));
  }
  return group;
}

function makeTerrainMesh(): THREE.Mesh {
  const columns = 52;
  const rows = 36;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const low = new THREE.Color(0xb98246);
  const high = new THREE.Color(0x8d5a32);
  const wash = new THREE.Color(0x704525);
  const wind = new THREE.Color(0xe1b36f);
  const rock = new THREE.Color(0x5b371f);
  for (let zIndex = 0; zIndex <= rows; zIndex += 1) {
    const z = -ARENA_DEPTH / 2 + (zIndex / rows) * ARENA_DEPTH;
    for (let xIndex = 0; xIndex <= columns; xIndex += 1) {
      const x = -ARENA_WIDTH / 2 + (xIndex / columns) * ARENA_WIDTH;
      const y = terrainHeightAt({ x, z });
      positions.push(x, y + 0.006, z);
      const ridge = clamp01(y / 1.35);
      const washBlend = clamp01((0.22 - y) * 1.8) * (Math.abs(z + x * 0.18) < 2.6 ? 0.34 : 0.08);
      const stripe = Math.abs((x + z * 0.38) % 4) < 0.08 ? 0.18 : 0;
      const cliff = y > 1.04 && z > 3.7 ? 0.28 : 0;
      const color = low.clone().lerp(high, ridge).lerp(wash, washBlend).lerp(wind, stripe).lerp(rock, cliff);
      colors.push(color.r, color.g, color.b);
    }
  }
  for (let zIndex = 0; zIndex < rows; zIndex += 1) {
    for (let xIndex = 0; xIndex < columns; xIndex += 1) {
      const a = zIndex * (columns + 1) + xIndex;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.03,
    emissive: 0x2b170c,
    emissiveIntensity: 0.1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
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
const projectileSparkGeometries = new Map<string, THREE.SphereGeometry>();
const materials = new Map<string, THREE.Material>();
const projectileGeometries = new Map<string, THREE.BufferGeometry>();

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

function projectileSparkGeometry(radius: number): THREE.SphereGeometry {
  const key = radius.toFixed(3);
  let geometry = projectileSparkGeometries.get(key);
  if (!geometry) {
    geometry = new THREE.SphereGeometry(radius, 8, 6);
    projectileSparkGeometries.set(key, geometry);
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
