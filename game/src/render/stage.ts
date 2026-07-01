import * as THREE from "three";
import { clamp, lerp, type Vec2 } from "../core/math";
import { ARENA_BOUNDS } from "../game/terrain";

export interface PickResult {
  entityId: string;
  partId?: string;
}

export interface CameraGuideTarget {
  focus: Vec2;
  zoom?: number;
  pitch?: number;
  yaw?: number;
}

type CameraGuideMode = "aim" | "resolve";

interface CameraGuide extends CameraGuideTarget {
  mode: CameraGuideMode;
  strength: number;
  expiresAt: number;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly raycaster = new THREE.Raycaster();
  readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private pointer = new THREE.Vector2();
  private readonly projectScratch = new THREE.Vector3();
  private readonly focus: Vec2 = { x: 0, z: 0 };
  private zoom = 1;
  private orbitYaw = 0;
  private orbitPitch: number;
  private readonly baseOffset = new THREE.Vector3(-10, 17, 15);
  private readonly baseDistance = this.baseOffset.length();
  private readonly baseAzimuth = Math.atan2(this.baseOffset.x, this.baseOffset.z);
  private guide: CameraGuide | undefined;
  private guideSuppressUntil = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.orbitPitch = Math.atan2(this.baseOffset.y, Math.hypot(this.baseOffset.x, this.baseOffset.z));
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.15));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // A vertical gradient sky gives the scene depth and a dusk atmosphere.
    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.FogExp2(0x6a4a33, 0.019);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 160);
    this.updateCamera();

    // Soft, near-neutral sky fill + warm ground bounce. Kept low-saturation so shadows
    // (where the warm key is blocked) don't pick up a teal cast.
    const hemi = new THREE.HemisphereLight(0xd7dde4, 0x4a3424, 0.95);
    this.scene.add(hemi);

    // Warm key "sun" with soft shadows covering the full arena.
    const key = new THREE.DirectionalLight(0xfff0d6, 2.7);
    key.position.set(-8, 18, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    // Sized to cover the largest battlefield (Frozen Causeway spans x = ±32).
    key.shadow.camera.left = -36;
    key.shadow.camera.right = 36;
    key.shadow.camera.top = 24;
    key.shadow.camera.bottom = -24;
    key.shadow.camera.near = 2;
    key.shadow.camera.far = 72;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    // Cool rim light makes units and buildings pop off the warm ground.
    const rim = new THREE.DirectionalLight(0x8fdcff, 1.15);
    rim.position.set(12, 9, -14);
    this.scene.add(rim);

    // Warm fill from the opposite side to lift shadow detail toward sand tones.
    const fill = new THREE.DirectionalLight(0xffc890, 0.6);
    fill.position.set(7, 5, 11);
    this.scene.add(fill);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  // True when a world point sits comfortably on-screen (not at the very edges or behind
  // the HUD panels), so we can skip recentering the camera on it.
  isInView(point: Vec2, height = 0.8): boolean {
    this.projectScratch.set(point.x, height, point.z);
    this.projectScratch.project(this.camera);
    const { x, y, z } = this.projectScratch;
    if (z >= 1) return false; // behind the camera / beyond far plane
    // Only treat a point as off-screen when it is genuinely near/past an edge, so we don't
    // yank the camera back onto a unit that is already comfortably visible.
    return x > -0.94 && x < 0.96 && y > -0.94 && y < 0.95;
  }

  // Project a world point (at the given height) to CSS pixel coordinates plus a visibility
  // flag. Used by the debug overlay + the AI scene-description to place entity labels and to
  // tell whether an entity is actually on-screen. `behind` is true when the point is behind
  // the camera (its projected x/y are meaningless then).
  projectToScreen(point: Vec2, height = 0.8): { x: number; y: number; visible: boolean; behind: boolean } {
    this.projectScratch.set(point.x, height, point.z);
    this.projectScratch.project(this.camera);
    const { x, y, z } = this.projectScratch;
    const behind = z >= 1;
    const px = (x * 0.5 + 0.5) * window.innerWidth;
    const py = (-y * 0.5 + 0.5) * window.innerHeight;
    const visible = !behind && x >= -1 && x <= 1 && y >= -1 && y <= 1;
    return { x: px, y: py, visible, behind };
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
    if (x || y) {
      this.panScreen(x * 8.2 * dt, y * 8.2 * dt);
      return;
    }
    this.updateGuide(dt);
  }

  pan(dx: number, dz: number): void {
    this.suppressGuide();
    this.focus.x = Math.max(ARENA_BOUNDS.minX + 4, Math.min(ARENA_BOUNDS.maxX - 4, this.focus.x + dx));
    this.focus.z = Math.max(ARENA_BOUNDS.minZ + 3, Math.min(ARENA_BOUNDS.maxZ - 3, this.focus.z + dz));
    this.updateCamera();
  }

  focusOn(point: Vec2): void {
    this.guide = undefined;
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
    this.suppressGuide();
    this.zoom = Math.max(0.62, Math.min(1.55, this.zoom + delta));
    this.updateCamera();
  }

  orbitBy(deltaYawRadians: number, deltaPitchRadians = 0): void {
    this.suppressGuide();
    this.orbitYaw += deltaYawRadians;
    this.orbitPitch = Math.max(0.12, Math.min(1.18, this.orbitPitch + deltaPitchRadians));
    this.updateCamera();
  }

  guideTo(target: CameraGuideTarget, options: { mode?: CameraGuideMode; strength?: number; durationMs?: number } = {}): void {
    if (performance.now() < this.guideSuppressUntil) return;
    this.guide = {
      focus: this.clampFocus(target.focus),
      zoom: target.zoom === undefined ? undefined : clamp(target.zoom, 0.62, 1.55),
      pitch: target.pitch === undefined ? undefined : clamp(target.pitch, 0.12, 1.18),
      yaw: target.yaw,
      mode: options.mode ?? "aim",
      strength: options.strength ?? (options.mode === "resolve" ? 2.0 : 3.2),
      expiresAt: performance.now() + (options.durationMs ?? (options.mode === "resolve" ? 260 : 1500)),
    };
  }

  viewState(): { x: number; z: number; zoom: number; yaw: number; pitch: number } {
    return { x: this.focus.x, z: this.focus.z, zoom: this.zoom, yaw: this.orbitYaw, pitch: this.orbitPitch };
  }

  // Debug-only: hard-set the camera (bypasses the interactive zoom clamp) so test/capture
  // scripts can frame tight inspection shots of models. Not used by normal gameplay input.
  debugSetView(view: { x?: number; z?: number; zoom?: number; yaw?: number; pitch?: number }): void {
    this.suppressGuide();
    if (view.x !== undefined) this.focus.x = view.x;
    if (view.z !== undefined) this.focus.z = view.z;
    if (view.zoom !== undefined) this.zoom = Math.max(0.18, Math.min(1.55, view.zoom));
    if (view.yaw !== undefined) this.orbitYaw = view.yaw;
    if (view.pitch !== undefined) this.orbitPitch = Math.max(0.05, Math.min(1.4, view.pitch));
    this.updateCamera();
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

  /** Graphics-quality knob: render at `cap`× pixels, never above the device's own ratio. */
  setPixelRatioCap(cap: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
    this.resize();
  }

  private updateGuide(dt: number): void {
    if (!this.guide) return;
    if (performance.now() > this.guide.expiresAt) {
      this.guide = undefined;
      return;
    }

    const amount = 1 - Math.exp(-this.guide.strength * dt);
    this.focus.x = lerp(this.focus.x, this.guide.focus.x, amount);
    this.focus.z = lerp(this.focus.z, this.guide.focus.z, amount);
    if (this.guide.zoom !== undefined) this.zoom = lerp(this.zoom, this.guide.zoom, amount);
    if (this.guide.pitch !== undefined) this.orbitPitch = lerp(this.orbitPitch, this.guide.pitch, amount);
    if (this.guide.yaw !== undefined) this.orbitYaw = lerpAngle(this.orbitYaw, this.guide.yaw, amount);
    this.updateCamera();
  }

  private suppressGuide(durationMs = 1150): void {
    this.guide = undefined;
    this.guideSuppressUntil = performance.now() + durationMs;
  }

  private clampFocus(point: Vec2): Vec2 {
    return {
      x: Math.max(ARENA_BOUNDS.minX + 4, Math.min(ARENA_BOUNDS.maxX - 4, point.x)),
      z: Math.max(ARENA_BOUNDS.minZ + 3, Math.min(ARENA_BOUNDS.maxZ - 3, point.z)),
    };
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

function lerpAngle(from: number, to: number, amount: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * amount;
}

function makeSkyTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#16213a"); // upper sky — dusk indigo
    gradient.addColorStop(0.42, "#33304a"); // mid haze
    gradient.addColorStop(0.72, "#7a4f37"); // warm band
    gradient.addColorStop(1, "#c79a63"); // horizon sand glow
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
