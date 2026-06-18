import * as THREE from "three";
import type { Vec2 } from "../core/math";
import { ARENA_BOUNDS } from "../game/terrain";

export interface PickResult {
  entityId: string;
  partId?: string;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly raycaster = new THREE.Raycaster();
  readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private pointer = new THREE.Vector2();
  private readonly focus: Vec2 = { x: 0, z: 0 };
  private zoom = 1;
  private orbitYaw = 0;
  private orbitPitch: number;
  private readonly baseOffset = new THREE.Vector3(-10, 17, 15);
  private readonly baseDistance = this.baseOffset.length();
  private readonly baseAzimuth = Math.atan2(this.baseOffset.x, this.baseOffset.z);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.orbitPitch = Math.atan2(this.baseOffset.y, Math.hypot(this.baseOffset.x, this.baseOffset.z));
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x25190f);
    this.scene.fog = new THREE.FogExp2(0x25190f, 0.022);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 120);
    this.updateCamera();

    const hemi = new THREE.HemisphereLight(0xffe0b8, 0x2b1a10, 1.42);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffead0, 2.2);
    key.position.set(-7, 16, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -22;
    key.shadow.camera.right = 22;
    key.shadow.camera.top = 18;
    key.shadow.camera.bottom = -18;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 50;
    key.shadow.bias = -0.0007;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x7ad9ff, 0.78);
    rim.position.set(10, 8, -12);
    this.scene.add(rim);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  screenToWorld(clientX: number, clientY: number): Vec2 {
    this.setPointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.ground, hit);
    return { x: hit.x, z: hit.z };
  }

  pick(clientX: number, clientY: number, objects: THREE.Object3D[]): PickResult | undefined {
    this.setPointer(clientX, clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(objects, true);
    for (const hit of hits) {
      const data = hit.object.userData as Partial<PickResult>;
      if (typeof data.entityId === "string") return { entityId: data.entityId, partId: data.partId };
    }
    return undefined;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  update(dt: number, input: { up: boolean; down: boolean; left: boolean; right: boolean }): void {
    const x = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const y = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    if (x || y) this.panScreen(x * 8.2 * dt, y * 8.2 * dt);
  }

  pan(dx: number, dz: number): void {
    this.focus.x = Math.max(ARENA_BOUNDS.minX + 4, Math.min(ARENA_BOUNDS.maxX - 4, this.focus.x + dx));
    this.focus.z = Math.max(ARENA_BOUNDS.minZ + 3, Math.min(ARENA_BOUNDS.maxZ - 3, this.focus.z + dz));
    this.updateCamera();
  }

  focusOn(point: Vec2): void {
    this.focus.x = Math.max(ARENA_BOUNDS.minX + 4, Math.min(ARENA_BOUNDS.maxX - 4, point.x));
    this.focus.z = Math.max(ARENA_BOUNDS.minZ + 3, Math.min(ARENA_BOUNDS.maxZ - 3, point.z));
    this.updateCamera();
  }

  panScreen(rightAmount: number, upAmount: number): void {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    right.y = 0;
    if (right.lengthSq() < 0.0001) right.set(1, 0, 0);
    right.normalize();

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
    forward.normalize();

    this.pan(
      right.x * rightAmount + forward.x * upAmount,
      right.z * rightAmount + forward.z * upAmount
    );
  }

  zoomBy(delta: number): void {
    this.zoom = Math.max(0.62, Math.min(1.55, this.zoom + delta));
    this.updateCamera();
  }

  orbitBy(deltaYawRadians: number, deltaPitchRadians = 0): void {
    this.orbitYaw += deltaYawRadians;
    this.orbitPitch = Math.max(0.12, Math.min(1.18, this.orbitPitch + deltaPitchRadians));
    this.updateCamera();
  }

  viewState(): { x: number; z: number; zoom: number; yaw: number; pitch: number } {
    return { x: this.focus.x, z: this.focus.z, zoom: this.zoom, yaw: this.orbitYaw, pitch: this.orbitPitch };
  }

  private setPointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private updateCamera(): void {
    const azimuth = this.baseAzimuth + this.orbitYaw;
    const horizontal = Math.cos(this.orbitPitch) * this.baseDistance;
    const offsetX = Math.sin(azimuth) * horizontal;
    const offsetZ = Math.cos(azimuth) * horizontal;
    const offsetY = Math.sin(this.orbitPitch) * this.baseDistance;
    this.camera.position.set(
      this.focus.x + offsetX * this.zoom,
      offsetY * this.zoom,
      this.focus.z + offsetZ * this.zoom
    );
    this.camera.lookAt(this.focus.x, 0, this.focus.z);
  }
}
