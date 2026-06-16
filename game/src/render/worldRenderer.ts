import * as THREE from "three";
import { clamp01 } from "../core/math";
import type { CombatEntity, DamagePart, PartRole } from "../game/damageModel";
import type { Projectile, TacticalSim, VisualEvent } from "../game/sim";

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
  private readonly targetRing: THREE.Mesh;

  constructor(private readonly scene: THREE.Scene) {
    this.scene.add(this.sceneryRoot, this.debrisRoot, this.entityRoot, this.orderRoot, this.previewRoot, this.projectileRoot, this.effectRoot);
    this.addArena();

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.22, 56),
      new THREE.MeshBasicMaterial({ color: 0x9dfcff, transparent: true, opacity: 0.86, side: THREE.DoubleSide })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.035;
    this.scene.add(this.ring);

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(1.08, 1.18, 56),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.88, side: THREE.DoubleSide })
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.position.y = 0.055;
    this.scene.add(this.targetRing);
  }

  update(sim: TacticalSim, targetId?: string, targetPartId?: string): void {
    if (sim.entities.every((e) => e.parts.every((p) => p.hp === p.maxHp))) {
      this.destroyedPartKeys.clear();
      this.debrisRoot.clear();
    }
    this.pickables.splice(0);
    const liveIds = new Set(sim.entities.map((e) => e.id));
    for (const [id, group] of this.groups) {
      if (!liveIds.has(id)) {
        this.entityRoot.remove(group);
        this.groups.delete(id);
      }
    }
    for (const entity of sim.entities) this.syncEntity(entity, sim.selectedId, targetId, targetPartId);
    this.syncSelection(sim);
    this.syncTarget(sim, targetId);
    this.syncOrders(sim);
    this.syncShotPreview(sim, targetId, targetPartId);
    this.syncProjectiles(sim.projectiles);
    this.syncEffects(sim.effects);
  }

  private addArena(): void {
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(28, 0.18, 18),
      new THREE.MeshStandardMaterial({ color: 0x1d2425, roughness: 0.86, metalness: 0.08 })
    );
    floor.position.y = -0.11;
    floor.receiveShadow = true;
    this.sceneryRoot.add(floor);

    const grid = new THREE.GridHelper(28, 28, 0x5e7c80, 0x344044);
    grid.position.y = 0.005;
    this.sceneryRoot.add(grid);

    const railMat = new THREE.MeshStandardMaterial({ color: 0x14191c, roughness: 0.7, metalness: 0.35 });
    for (const [x, z, sx, sz] of [
      [0, -9.1, 28.4, 0.22],
      [0, 9.1, 28.4, 0.22],
      [-14.1, 0, 0.22, 18.4],
      [14.1, 0, 0.22, 18.4],
    ] as const) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.34, sz), railMat);
      rail.position.set(x, 0.1, z);
      rail.castShadow = true;
      rail.receiveShadow = true;
      this.sceneryRoot.add(rail);
    }

    const padMat = new THREE.MeshStandardMaterial({ color: 0x123457, roughness: 0.82, emissive: 0x071c2a, emissiveIntensity: 0.45 });
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0x552420, roughness: 0.82, emissive: 0x2a0806, emissiveIntensity: 0.38 });
    const playerPad = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.08, 7.6), padMat);
    playerPad.position.set(-8.2, 0.01, -0.7);
    playerPad.receiveShadow = true;
    this.sceneryRoot.add(playerPad);
    const enemyPad = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.08, 7.6), enemyMat);
    enemyPad.position.set(8.2, 0.01, -0.7);
    enemyPad.receiveShadow = true;
    this.sceneryRoot.add(enemyPad);

    for (const z of [-4.4, -2.2, 0, 2.2]) {
      this.strip(-8.2, z, 5.0, 0x59d4ff);
      this.strip(8.2, z, 5.0, 0xff7d66);
    }

    for (const [x, z, radius, color] of [
      [-4.5, 4.2, 1.1, 0x15313a],
      [4.5, -4.2, 1.35, 0x40201b],
      [0.8, 0.1, 0.9, 0x2b2418],
    ] as const) {
      const scorch = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 28),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, depthWrite: false })
      );
      scorch.rotation.x = -Math.PI / 2;
      scorch.position.set(x, 0.012, z);
      this.sceneryRoot.add(scorch);
    }

    const playerLight = new THREE.PointLight(0x60d7ff, 0.8, 8);
    playerLight.position.set(-8.2, 3, -0.7);
    const enemyLight = new THREE.PointLight(0xff7c5e, 0.8, 8);
    enemyLight.position.set(8.2, 3, -0.7);
    this.sceneryRoot.add(playerLight, enemyLight);
  }

  private syncEntity(entity: CombatEntity, selectedId: string, targetId: string | undefined, targetPartId: string | undefined): void {
    let group = this.groups.get(entity.id);
    if (!group) {
      group = this.buildEntity(entity);
      this.groups.set(entity.id, group);
      this.entityRoot.add(group);
    }
    group.position.set(entity.position.x, 0, entity.position.z);
    group.rotation.y = entity.yaw;
    group.scale.setScalar(entity.status.alive ? 1 : 0.94);
    group.traverse((object) => {
      if (!("isMesh" in object)) return;
      const mesh = object as PartMesh;
      const partId = mesh.userData.partId as string | undefined;
      if (!partId) return;
      const part = entity.parts.find((p) => p.id === partId);
      if (!part) return;
      this.syncDebris(entity, part);
      this.paintPart(mesh, entity, part, entity.id === selectedId, entity.id === targetId, part.id === targetPartId);
      this.pickables.push(mesh);
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
    if (entity.kind === "soldier") this.buildSoldier(group, entity);
    if (entity.kind === "base") this.buildBase(group, entity);
    if (entity.kind === "cover") this.buildCover(group, entity);
    return group;
  }

  private buildTank(group: THREE.Group, entity: CombatEntity): void {
    this.box(group, entity, "hull", [2.35, 0.72, 1.35], [0, 0.58, 0], 0x6fb7d7);
    this.box(group, entity, "front-plate", [2.28, 0.5, 0.22], [0, 0.68, 0.82], 0xc0cdc9);
    this.box(group, entity, "turret", [1.08, 0.44, 0.86], [0, 1.12, 0.04], 0x5ba2c5);
    this.box(group, entity, "cannon", [0.24, 0.24, 1.45], [0, 1.16, 1.03], 0xd9e6df, { metalness: 0.35 });
    this.box(group, entity, "cannon", [0.36, 0.34, 0.22], [0, 1.16, 1.8], 0xffffff, { emissive: 0x88ecff, emissiveIntensity: 0.28 });
    this.box(group, entity, "left-tread", [0.34, 0.5, 1.72], [-1.32, 0.32, 0], 0x22282a);
    this.box(group, entity, "right-tread", [0.34, 0.5, 1.72], [1.32, 0.32, 0], 0x22282a);
    for (const side of [-1, 1]) {
      for (const z of [-0.58, 0, 0.58]) {
        this.cylinder(group, entity, side < 0 ? "left-tread" : "right-tread", 0.28, 0.16, [side * 1.36, 0.32, z], 0x0d1112);
      }
    }
    this.box(group, entity, "turret", [0.44, 0.16, 0.18], [-0.58, 1.34, -0.16], 0xdaf7ff, { emissive: 0x50d7ff, emissiveIntensity: 0.4 });
    this.box(group, entity, "turret", [0.44, 0.16, 0.18], [0.58, 1.34, -0.16], 0xdaf7ff, { emissive: 0x50d7ff, emissiveIntensity: 0.4 });
  }

  private buildSoldier(group: THREE.Group, entity: CombatEntity): void {
    this.box(group, entity, "body", [0.52, 0.82, 0.34], [0, 0.77, 0], 0x6ad1a3);
    this.box(group, entity, "head", [0.36, 0.36, 0.36], [0, 1.35, 0.02], 0xd8d2bd);
    this.box(group, entity, "rifle", [0.18, 0.18, 0.9], [0.45, 0.92, 0.28], 0xd8e5e4);
    this.box(group, entity, "pack", [0.38, 0.45, 0.18], [0, 0.82, -0.3], 0x385c62);
    this.box(group, entity, "body", [0.18, 0.52, 0.18], [-0.42, 0.72, 0.02], 0x4f987c);
    this.box(group, entity, "body", [0.18, 0.52, 0.18], [0.42, 0.72, 0.02], 0x4f987c);
    this.box(group, entity, "body", [0.18, 0.58, 0.2], [-0.18, 0.24, 0], 0x243336);
    this.box(group, entity, "body", [0.18, 0.58, 0.2], [0.18, 0.24, 0], 0x243336);
    this.box(group, entity, "head", [0.26, 0.08, 0.12], [0, 1.38, 0.24], 0x141819, { emissive: 0x9dfcff, emissiveIntensity: 0.2 });
  }

  private buildBase(group: THREE.Group, entity: CombatEntity): void {
    this.box(group, entity, "core", [2.45, 1.35, 2.05], [0, 0.68, 0], 0xd06458);
    this.box(group, entity, "turret", [0.92, 0.48, 0.92], [0.2, 1.62, 0.15], 0xef8a65);
    this.box(group, entity, "turret", [0.24, 0.24, 1.35], [0.2, 1.66, 0.98], 0xffd0bc, { metalness: 0.25 });
    this.box(group, entity, "comms", [0.18, 1.7, 0.18], [-0.9, 2.05, -0.15], 0xd9ded2);
    this.box(group, entity, "comms", [0.72, 0.12, 0.12], [-0.9, 2.88, -0.15], 0xffffff, { emissive: 0xffa08a, emissiveIntensity: 0.55 });
    this.box(group, entity, "power", [0.72, 0.9, 0.72], [0.92, 0.62, -0.62], 0xffc857, { emissive: 0xff9e2b, emissiveIntensity: 0.4 });
    this.box(group, entity, "gate", [2.75, 0.68, 0.34], [0, 0.38, 1.24], 0x8b4d47);
    for (const x of [-0.75, 0, 0.75]) this.box(group, entity, "core", [0.28, 0.12, 0.08], [x, 1.2, 1.06], 0xfff0bf, { emissive: 0xff9d6c, emissiveIntensity: 0.45 });
  }

  private buildCover(group: THREE.Group, entity: CombatEntity): void {
    const part = entity.parts[0];
    const volatile = part.role === "volatile";
    if (volatile) {
      this.box(group, entity, part.id, [0.82, 0.98, 0.82], [0, 0.5, 0], 0xffb02e, { emissive: 0xff6b1a, emissiveIntensity: 0.35 });
      this.box(group, entity, part.id, [0.56, 0.28, 0.56], [0, 1.14, 0], 0xffd06a, { emissive: 0xffb02e, emissiveIntensity: 0.45 });
      this.box(group, entity, part.id, [0.16, 0.82, 0.9], [0, 0.56, 0], 0x5a3516);
    } else {
      this.box(group, entity, part.id, [1.82, 1.25, 0.56], [0, 0.63, 0], 0x8f9894);
      this.box(group, entity, part.id, [1.66, 0.22, 0.62], [0, 1.37, 0], 0xb5bbb5);
      this.box(group, entity, part.id, [0.14, 1.12, 0.66], [-0.58, 0.7, 0], 0x737d7a);
      this.box(group, entity, part.id, [0.14, 1.12, 0.66], [0.58, 0.7, 0], 0x737d7a);
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
    color: number
  ): PartMesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, depth, 14),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.16 })
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = entity.id;
    mesh.userData.partId = partId;
    mesh.userData.baseColor = color;
    mesh.userData.baseEmissive = 0x000000;
    mesh.userData.baseEmissiveIntensity = 0;
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
    const count = part.role === "armor" || part.role === "core" ? 7 : part.role === "mobility" ? 6 : 4;
    const color = roleColor(entity, part.role, entity.team === "enemy" ? 0xd96a5d : 0x7bc5d8);
    const seed = hash(`${entity.id}:${part.id}`);
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.outline(mesh);
      this.debrisRoot.add(mesh);
    }

    const spark = new THREE.PointLight(part.role === "volatile" ? 0xff9c3b : part.role === "utility" ? 0x9dfcff : 0xffd27a, 0.75, 3.2);
    spark.position.set(entity.position.x, 1.2, entity.position.z);
    this.debrisRoot.add(spark);
  }

  private paintPart(mesh: PartMesh, entity: CombatEntity, part: DamagePart, selected: boolean, targeted: boolean, targetedPart: boolean): void {
    const material = mesh.material;
    const base = roleColor(entity, part.role, mesh.userData.baseColor as number);
    const ratio = clamp01(part.hp / part.maxHp);
    const color = new THREE.Color(base).lerp(new THREE.Color(0x121517), 1 - ratio);
    if (!entity.status.alive) color.lerp(new THREE.Color(0x08090a), 0.55);
    if (selected && part.hp > 0) color.lerp(new THREE.Color(0xffffff), 0.12);
    if (targeted && part.hp > 0) color.lerp(new THREE.Color(0xffd166), targetedPart ? 0.46 : 0.18);
    material.color.copy(color);
    const baseEmissive = mesh.userData.baseEmissive as number;
    material.emissive.setHex(part.hp > 0 && targetedPart ? 0x4f3000 : part.hp > 0 && selected ? 0x0b3844 : baseEmissive);
    material.emissiveIntensity = part.hp > 0
      ? (mesh.userData.baseEmissiveIntensity as number) + (selected ? 0.42 : 0) + (targetedPart ? 0.58 : targeted ? 0.18 : 0)
      : 0;
    mesh.visible = part.hp > 0 || entity.kind !== "cover";
    if (part.hp <= 0) {
      mesh.rotation.z = 0.28;
      mesh.position.y = Math.max(0.15, mesh.position.y - 0.012);
    } else if (ratio < 0.45) {
      material.emissive.setHex(0xff5f35);
      material.emissiveIntensity = 0.18 + (1 - ratio) * 0.28;
    }
  }

  private syncSelection(sim: TacticalSim): void {
    const selected = sim.selected;
    this.ring.visible = Boolean(selected);
    if (!selected) return;
    this.ring.position.x = selected.position.x;
    this.ring.position.z = selected.position.z;
    this.ring.scale.setScalar(selected.radius * 1.25);
    const mat = this.ring.material as THREE.MeshBasicMaterial;
    mat.color.setHex(selected.team === "player" ? 0x9dfcff : selected.team === "enemy" ? 0xff8f7f : 0xf6d776);
  }

  private syncTarget(sim: TacticalSim, targetId: string | undefined): void {
    const target = sim.entity(targetId);
    this.targetRing.visible = Boolean(target);
    if (!target) return;
    this.targetRing.position.x = target.position.x;
    this.targetRing.position.z = target.position.z;
    this.targetRing.scale.setScalar(target.radius * 1.42);
    const mat = this.targetRing.material as THREE.MeshBasicMaterial;
    mat.color.setHex(target.team === "enemy" ? 0xffd166 : 0xf6d776);
  }

  private syncOrders(sim: TacticalSim): void {
    this.orderRoot.clear();
    for (const order of sim.orders) {
      const actor = sim.entity(order.actorId);
      if (!actor) continue;
      const to = order.destination ?? sim.entity(order.targetId)?.position;
      if (!to) continue;
      const color = order.kind === "move" ? 0x9dfcff : order.kind === "ram" ? 0xffbf4d : 0xff7f67;
      this.orderRoot.add(makeTubeLine(actor.position, to, color, 0.3, 0.13, 0.025));
      this.orderRoot.add(makeLine(actor.position, to, color, 0.55, 0.18));
    }
  }

  private syncShotPreview(sim: TacticalSim, targetId: string | undefined, targetPartId: string | undefined): void {
    this.previewRoot.clear();
    const actor = sim.selected;
    if (!actor || actor.team !== "player" || !targetId || !targetPartId || sim.phase !== "command") return;
    const target = sim.entity(targetId);
    const preview = sim.previewShot(actor.id, targetId, targetPartId);
    if (!target || !preview) return;

    const impact = sim.entity(preview.impactEntityId);
    if (!impact) return;
    const clear = !preview.blockedById;
    this.previewRoot.add(makeTubeLine(actor.position, impact.position, clear ? 0x8de4ff : 0xffbf69, clear ? 0.48 : 0.56, 0.28, 0.05));
    this.previewRoot.add(makeLine(actor.position, impact.position, clear ? 0x8de4ff : 0xffbf69, clear ? 0.88 : 0.96, 0.22));
    this.previewRoot.add(makeEndpoint(impact.position, clear ? 0x8de4ff : 0xffbf69, impact.radius + 0.18));
    if (preview.blockedById) {
      this.previewRoot.add(makeTubeLine(impact.position, target.position, 0xff765f, 0.26, 0.2, 0.035));
      this.previewRoot.add(makeLine(impact.position, target.position, 0xff765f, 0.42, 0.12));
      this.previewRoot.add(makeEndpoint(target.position, 0xff765f, target.radius + 0.1));
    }
  }

  private syncProjectiles(projectiles: readonly Projectile[]): void {
    this.projectileRoot.clear();
    for (const projectile of projectiles) {
      this.projectileRoot.add(makeTubeLine(projectile.previous, projectile.position, projectile.color, 0.62, 0.58, 0.045));
      const tracer = makeLine(projectile.previous, projectile.position, projectile.color, 0.92, 0.18);
      this.projectileRoot.add(tracer);

      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 14, 10),
        new THREE.MeshBasicMaterial({ color: projectile.color, transparent: true, opacity: 0.96 })
      );
      shell.position.set(projectile.position.x, 0.58, projectile.position.z);
      this.projectileRoot.add(shell);

      const glow = new THREE.PointLight(projectile.color, 0.65, 2.8);
      glow.position.set(projectile.position.x, 0.68, projectile.position.z);
      this.projectileRoot.add(glow);
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
      } else {
        const hit = new THREE.Mesh(
          new THREE.SphereGeometry((effect.radius ?? 0.45) * (1 + t), 12, 8),
          new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, opacity: opacity * 0.55 })
        );
        hit.position.set(effect.to.x, 0.8, effect.to.z);
        this.effectRoot.add(hit);
      }
    }
  }
}

function roleColor(entity: CombatEntity, role: PartRole, fallback: number): number {
  if (entity.team === "enemy" && entity.kind !== "cover") {
    if (role === "weapon") return 0xffc0a8;
    if (role === "mobility") return 0x2d2727;
    return 0xd96a5d;
  }
  if (entity.team === "player") {
    if (role === "weapon") return 0xd7fbff;
    if (role === "mobility") return 0x222a2c;
    if (role === "head") return 0xded4bf;
    return fallback;
  }
  return fallback;
}

function makeLine(from: { x: number; z: number }, to: { x: number; z: number }, color: number, opacity: number, y = 0.16): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, y, from.z),
    new THREE.Vector3(to.x, y, to.z),
  ]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  return new THREE.Line(geo, mat);
}

function makeTubeLine(
  from: { x: number; z: number },
  to: { x: number; z: number },
  color: number,
  opacity: number,
  y = 0.18,
  radius = 0.035
): THREE.Object3D {
  const start = new THREE.Vector3(from.x, y, from.z);
  const end = new THREE.Vector3(to.x, y, to.z);
  const delta = new THREE.Vector3().subVectors(end, start);
  const length = delta.length();
  if (length < 0.01) return new THREE.Group();

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 10, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  return mesh;
}

function makeEndpoint(position: { x: number; z: number }, color: number, radius: number): THREE.Mesh {
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(radius, radius + 0.08, 44),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, side: THREE.DoubleSide })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.set(position.x, 0.12, position.z);
  return marker;
}

function makeBeam(from: { x: number; z: number }, to: { x: number; z: number }, color: number, opacity: number): THREE.Group {
  const group = new THREE.Group();
  group.add(makeLine(from, to, color, opacity));
  group.add(makeLine({ x: from.x, z: from.z + 0.04 }, { x: to.x, z: to.z + 0.04 }, 0xffffff, opacity * 0.45));
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
