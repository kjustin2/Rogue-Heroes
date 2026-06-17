import * as THREE from "three";
import type { Vec2 } from "../core/math";

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
  private readonly baseOffset = new THREE.Vector3(-10, 17, 15);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x0a0d12);
    this.scene.fog = new THREE.FogExp2(0x0a0d12, 0.025);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 120);
    this.updateCamera();

    const hemi = new THREE.HemisphereLight(0xb8d7ff, 0x17120f, 1.35);
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

    const rim = new THREE.DirectionalLight(0x78c8ff, 0.9);
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
    const z = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (x || z) this.pan(x * 8.2 * dt, z * 8.2 * dt);
  }

  pan(dx: number, dz: number): void {
    this.focus.x = Math.max(-8, Math.min(8, this.focus.x + dx));
    this.focus.z = Math.max(-5.5, Math.min(5.5, this.focus.z + dz));
    this.updateCamera();
  }

  zoomBy(delta: number): void {
    this.zoom = Math.max(0.62, Math.min(1.55, this.zoom + delta));
    this.updateCamera();
  }

  viewState(): { x: number; z: number; zoom: number } {
    return { x: this.focus.x, z: this.focus.z, zoom: this.zoom };
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
    this.camera.position.set(
      this.focus.x + this.baseOffset.x * this.zoom,
      this.baseOffset.y * this.zoom,
      this.focus.z + this.baseOffset.z * this.zoom
    );
    this.camera.lookAt(this.focus.x, 0, this.focus.z);
  }
}
