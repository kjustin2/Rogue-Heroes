import * as THREE from "three";
import {
  BloomEffect,
  BrightnessContrastEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  VignetteEffect,
  type Effect,
} from "postprocessing";
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

/** Graphics tiers (named to match the persisted renderScale setting):
 *  - performance: direct render, no composer, 1024 shadows (also the ?lowfx path —
 *    SwiftShader stalls on the HalfFloat bloom chain, so headless smokes force this)
 *  - balanced:    bloom + vignette + SMAA
 *  - quality:     + grade (saturation/contrast) + film grain, 2048 shadows
 *  - ultra:       + subtle chromatic aberration
 */
export type QualityTier = "performance" | "balanced" | "quality" | "ultra";

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

  // Feel-layer seam: additive camera offsets (trauma shake / directional kick) applied on
  // top of the tactical rig each updateCamera. A FeelDirector writes these every frame.
  private readonly shakeOffset = new THREE.Vector3();
  private readonly lookShake = new THREE.Vector3();

  private quality: QualityTier = "quality";
  private pixelRatioCap = 1.15;
  private lowCost = false;
  /** Full battle chain and the lean menu chain. Both null on the performance tier. */
  private composer: EffectComposer | null = null;
  private menuComposer: EffectComposer | null = null;
  private vignette: VignetteEffect | null = null;
  private aberration: ChromaticAberrationEffect | null = null;
  /** 0..1 transient screen stress — punched up by blasts, decays fast (vignette/CA pulse). */
  private stress = 0;
  private readonly baseVignette = 0.32;
  private readonly baseAberration = 0.0011;
  private readonly keyLight: THREE.DirectionalLight;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.orbitPitch = Math.atan2(this.baseOffset.y, Math.hypot(this.baseOffset.x, this.baseOffset.z));
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA in the post chain; MSAA doesn't reach composer render targets
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // the smoke harness readPixels the canvas — keep it
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // A vertical gradient sky gives the scene depth; worldRenderer re-themes it per map.
    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.FogExp2(0x6a4a33, 0.019);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 160);
    this.updateCamera();

    // Soft, near-neutral sky fill + warm ground bounce. Kept low-saturation so shadows
    // (where the warm key is blocked) don't pick up a teal cast.
    const hemi = new THREE.HemisphereLight(0xd7dde4, 0x4a3424, 0.85);
    this.scene.add(hemi);

    // Warm dusty key "sun" with soft shadows covering the full arena.
    const key = new THREE.DirectionalLight(0xffe6c0, 2.4);
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
    this.keyLight = key;
    this.scene.add(key);

    // Cool steel rim light makes units and buildings pop off the warm ground.
    const rim = new THREE.DirectionalLight(0x8fdcff, 1.15);
    rim.position.set(12, 9, -14);
    this.scene.add(rim);

    // Warm fill from the opposite side to lift shadow detail toward sand tones.
    const fill = new THREE.DirectionalLight(0xffc890, 0.55);
    fill.position.set(7, 5, 11);
    this.scene.add(fill);

    this.buildPost();
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  /** (Re)build both post chains for the current quality tier. */
  private buildPost(): void {
    this.composer?.dispose();
    this.menuComposer?.dispose();
    this.composer = null;
    this.menuComposer = null;
    this.vignette = null;
    this.aberration = null;
    if (this.quality === "performance") return; // direct renderer.render path

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const effects: Effect[] = [];
    // Daylight scene: a high threshold so bloom picks out muzzle flashes, tracers, team
    // glows and explosions — not the sand.
    effects.push(new BloomEffect({ intensity: 0.55, luminanceThreshold: 0.75, luminanceSmoothing: 0.2, mipmapBlur: true, radius: 0.62 }));
    if (this.quality === "ultra") {
      this.aberration = new ChromaticAberrationEffect({
        offset: new THREE.Vector2(this.baseAberration, this.baseAberration),
        radialModulation: true,
        modulationOffset: 0.35,
      });
      effects.push(this.aberration);
    }
    this.vignette = new VignetteEffect({ darkness: this.baseVignette, offset: 0.3 });
    effects.push(this.vignette);
    if (this.quality !== "balanced") {
      effects.push(new HueSaturationEffect({ saturation: 0.1 }));
      effects.push(new BrightnessContrastEffect({ contrast: 0.06 }));
      const noise = new NoiseEffect({ premultiply: true });
      noise.blendMode.opacity.value = 0.32;
      effects.push(noise);
    }
    this.composer.addPass(new EffectPass(this.camera, ...effects));
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));

    // Lean chain behind menus: render + vignette + grade only. Built as its own chain —
    // a disabled trailing pass in `postprocessing` leaves the output unrouted (black).
    this.menuComposer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.menuComposer.addPass(new RenderPass(this.scene, this.camera));
    this.menuComposer.addPass(new EffectPass(
      this.camera,
      new VignetteEffect({ darkness: this.baseVignette, offset: 0.3 }),
      new HueSaturationEffect({ saturation: 0.1 }),
      new BrightnessContrastEffect({ contrast: 0.06 }),
    ));
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.composer.setSize(w, h);
    this.menuComposer.setSize(w, h);
  }

  /** Switch graphics tier (wired to the renderScale setting; ?lowfx forces performance). */
  setQuality(tier: QualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    const shadowSize = tier === "performance" ? 1024 : 2048;
    if (this.keyLight.shadow.mapSize.x !== shadowSize) {
      this.keyLight.shadow.mapSize.set(shadowSize, shadowSize);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this.buildPost();
  }

  /**
   * Lean path while full-screen menus are up: lean post chain + key shadows off. Both
   * shadow states are pre-compiled by warmUp(), so the flip never relinks on a live frame.
   */
  setLowCost(on: boolean): void {
    if (on === this.lowCost) return;
    this.lowCost = on;
    this.keyLight.castShadow = !on;
  }

  /** Punch the screen — big blasts. amount 0..1; vignette/aberration pulse, fast decay. */
  punch(amount: number): void {
    this.stress = Math.min(1, this.stress + amount);
  }

  /** Feel-layer seam: additive camera position/look offsets, applied every updateCamera. */
  setShake(offset: THREE.Vector3, look: THREE.Vector3): void {
    this.shakeOffset.copy(offset);
    this.lookShake.copy(look);
    this.updateCamera();
  }

  /**
   * Pre-compile shaders for everything in the scene plus any staged extras (GLB templates,
   * pooled VFX) across BOTH shadow states and BOTH post chains. A directional light's
   * castShadow flag is baked into every lit material's program key, so the menu<->battle
   * flip (setLowCost) would otherwise synchronously relink every material in the scene.
   */
  warmUp(extras: THREE.Object3D[] = []): void {
    const staged: THREE.Object3D[] = [];
    for (const extra of extras) {
      if (extra.parent) continue;
      extra.visible = false; // compile() warms materials regardless of visibility
      this.scene.add(extra);
      staged.push(extra);
    }
    const prevCast = this.keyLight.castShadow;
    try {
      this.keyLight.castShadow = true;
      this.renderer.compile(this.scene, this.camera);
      this.composer?.render(0.016);
      this.keyLight.castShadow = false;
      this.renderer.compile(this.scene, this.camera);
      this.menuComposer?.render(0.016);
      if (!this.composer) this.renderer.render(this.scene, this.camera);
    } catch {
      /* headless / lost context */
    } finally {
      this.keyLight.castShadow = prevCast;
      for (const extra of staged) {
        this.scene.remove(extra);
        extra.visible = true;
      }
    }
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

  render(dt = 0.016): void {
    const chain = this.lowCost ? this.menuComposer : this.composer;
    if (chain) chain.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  update(dt: number, input: { up: boolean; down: boolean; left: boolean; right: boolean }): void {
    // Screen-stress decay (blast vignette/aberration pulse).
    this.stress = Math.max(0, this.stress - this.stress * 6 * dt);
    if (this.vignette) this.vignette.darkness = this.baseVignette + this.stress * 0.4;
    if (this.aberration) {
      const ab = this.baseAberration + this.stress * 0.01;
      this.aberration.offset.set(ab, ab);
    }
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
    this.composer?.setSize(width, height);
    this.menuComposer?.setSize(width, height);
  }

  /** Graphics-quality knob: render at `cap`× pixels, never above the device's own ratio. */
  setPixelRatioCap(cap: number): void {
    this.pixelRatioCap = cap;
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
      this.focus.x + offsetX * this.zoom + this.shakeOffset.x,
      offsetY * this.zoom + this.shakeOffset.y,
      this.focus.z + offsetZ * this.zoom + this.shakeOffset.z
    );
    this.camera.lookAt(this.focus.x + this.lookShake.x, this.lookShake.y, this.focus.z + this.lookShake.z);
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
