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
import { GradeEffect } from "./gradeEffect";

export interface PickResult {
  entityId: string;
  partId?: string;
  pickupId?: string; // set instead of entityId when a ground cash-cache is clicked
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

/**
 * Half-width of the shadow window that follows the camera focus, in world units. It has to cover
 * everything ON SCREEN: three clamps the shadow map at its edges, so anything outside the window
 * gets the border texels smeared across it as long parallel streaks. 26 was tight enough to do
 * that to half the field. 42 still gives ~2cm texels -- more than twice the density of the old
 * whole-arena frustum -- while comfortably covering the widest tactical zoom.
 */
const SHADOW_RADIUS = 42;
/** Direction from the focus point to the key light. Fixed, so the sun angle never changes. */
const KEY_LIGHT_OFFSET = new THREE.Vector3(-13, 14, 9);

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

  private silhouetteBackground: THREE.Scene["background"] | undefined;
  private silhouetteFog: THREE.Scene["fog"] | undefined;
  private silhouetteQuality: QualityTier | undefined;
  private quality: QualityTier = "quality";
  private pixelRatioCap = 1.15;
  private lowCost = false;
  /** Full battle chain and the lean menu chain. Both null on the performance tier. */
  private composer: EffectComposer | null = null;
  private menuComposer: EffectComposer | null = null;
  private vignette: VignetteEffect | null = null;
  private aberration: ChromaticAberrationEffect | null = null;
  private grade: GradeEffect | null = null;
  private menuGrade: GradeEffect | null = null;
  /** 0..1 transient screen stress — punched up by blasts, decays fast (vignette/CA pulse). */
  private stress = 0;
  /** When on, blasts don't punch the screen (vignette darken + chromatic aberration) — the
   *  reduced-motion setting was suppressing camera shake but this full-screen pulse still fired. */
  private reducedMotion = false;
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
// NOTE: renderer.toneMappingExposure is NOT a live lever here. Driving it from 1.06 to 2.6
    // changed the measured frame luminance by 0.0001 -- the composer chain is what determines the
    // final image, so brightness is adjusted in the post stack instead (see buildPost).
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // A vertical gradient sky gives the scene depth; worldRenderer re-themes it per map.
    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.FogExp2(0x6a4a33, 0.019);

    this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 160);
    this.updateCamera();

    // LIGHT BUDGET. The rig previously summed to ~5.0 across four sources, three of which were
    // omnidirectional fill. That lifted shadowed surfaces almost to key brightness, so the image
    // measured FLAT (luminance sigma ~0.05 against a 0.10 floor) -- there was light everywhere and
    // shade nowhere. The key now dominates and the fills only keep shadows from going to mud.
    const hemi = new THREE.HemisphereLight(0xd7dde4, 0x4a3424, 0.40);
    this.scene.add(hemi);

    // Warm dusty key "sun" with soft shadows covering the full arena.
    const key = new THREE.DirectionalLight(0xffe6c0, 3.2);
    // Lower sun angle than before: a steep noon key casts almost no visible shadow at this camera
    // pitch, and the cast shadow is most of what gives the units and terrain their form.
    key.position.copy(KEY_LIGHT_OFFSET);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    // Sized to cover the largest enlarged battlefield (LARGE maps now span ~x = ±52, z = ±31 after
    // scaleMapDef). Kept at 2048² — wider frustum means slightly softer shadows on the biggest maps,
    // traded for no shadow-map perf hit.
    // FIT THE SHADOW FRUSTUM TO THE VIEW, not to the biggest map. It used to span the whole
    // enlarged arena (112 x 68 units) at 2048^2 -- about 5.5cm per shadow texel -- so every prop's
    // shadow broke into blocky dashes at tactical distance, which read across the ground as a
    // texture artefact and survived three rounds of texture tuning because it never was one.
    // A window that follows the camera focus is ~2.2cm per texel for the same map size, and it only
    // has to cover what is on screen. See syncShadowFrustum for the texel snapping that keeps it
    // from shimmering as the camera pans.
    key.shadow.camera.left = -SHADOW_RADIUS;
    key.shadow.camera.right = SHADOW_RADIUS;
    key.shadow.camera.top = SHADOW_RADIUS;
    key.shadow.camera.bottom = -SHADOW_RADIUS;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 120;
    key.shadow.bias = -0.0008;
    // NORMAL BIAS IS SIZED TO THE TEXEL, NOT PICKED BY EYE. The shadow frustum spans 112x68 world
    // units at 2048^2, so one shadow texel is ~5.5cm on the ground. At 0.05 the bias was a tenth of
    // a texel, and the near-flat arena floor under a low sun self-shadowed into regular diagonal
    // banding — the dashes visible across the ground in every screenshot, which read as a texture
    // artefact and are not one. Roughly four texels of normal bias clears it without detaching
    // contact shadows from the units that cast them.
    key.shadow.normalBias = 0.14;
    this.keyLight = key;
    this.scene.add(key);

    // Cool steel rim light makes units and buildings pop off the warm ground.
    const rim = new THREE.DirectionalLight(0x8fdcff, 0.62);
    rim.position.set(12, 9, -14);
    this.scene.add(rim);

    // Warm fill from the opposite side to lift shadow detail toward sand tones.
    const fill = new THREE.DirectionalLight(0xffc890, 0.20);
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
    this.grade = null;
    this.menuGrade = null;
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
    // Split-tone grade: shadows cool, highlights warm. This is the single biggest step away from
    // "raw Three.js default" — the maps are each authored around ONE hue (all-green Verdant,
    // all-ochre Karak) and collapse into a flat monochrome band without it. Runs on every tier
    // that has a composer at all: no texture lookup, ~15 lines of ALU.
    this.grade = new GradeEffect();
    effects.push(this.grade);
    this.vignette = new VignetteEffect({ darkness: this.baseVignette, offset: 0.3 });
    effects.push(this.vignette);
    if (this.quality !== "balanced") {
      // Low saturation push + firmer contrast: the desert themes collapse into one ochre
      // band if saturation is boosted, and anchored blacks are what keep units readable.
      effects.push(new HueSaturationEffect({ saturation: 0.06 }));
      // Brightness lift. Two rounds of deliberate darkening -- ground palettes pulled down to widen
      // their value range, props pushed back behind the units, and volatile scenery that no longer
      // glows like a pickup -- were each right on their own, and cumulatively left the darkest maps
      // near black with eight frames failing the flatness gate. This recovers the mid-tones without
      // undoing any of those decisions.
      // Firmer than the old 0.09. With the fill lights cut back there is real shade in the frame
      // now, and the contrast curve is what stops the mid-tones collapsing back together.
      effects.push(new BrightnessContrastEffect({ brightness: 0.1, contrast: 0.24 }));
      const noise = new NoiseEffect({ premultiply: true });
      // A light filmic grain. 0.32 read as visible static/dither over the low-frequency sky and on
      // small distant infantry (competing with unit readability); ~0.16 keeps the texture subtle.
      noise.blendMode.opacity.value = 0.16;
      effects.push(noise);
    }
    this.composer.addPass(new EffectPass(this.camera, ...effects));
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));

    // Lean chain behind menus: render + vignette + grade only. Built as its own chain —
    // a disabled trailing pass in `postprocessing` leaves the output unrouted (black).
    this.menuComposer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.menuComposer.addPass(new RenderPass(this.scene, this.camera));
    this.menuGrade = new GradeEffect();
    this.menuComposer.addPass(new EffectPass(
      this.camera,
      this.menuGrade,
      new VignetteEffect({ darkness: this.baseVignette, offset: 0.3 }),
      new HueSaturationEffect({ saturation: 0.1 }),
      new BrightnessContrastEffect({ contrast: 0.06 }),
    ));
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.composer.setSize(w, h);
    this.menuComposer.setSize(w, h);
  }

  /**
   * Push the whole image toward a mood colour: sandstorm ochre, ion-storm blue, victory warmth,
   * defeat drain. Applied to both chains so a menu opened mid-battle keeps the same look.
   */
  setMoodTint(color: THREE.Color, amount: number, saturation = 0): void {
    for (const grade of [this.grade, this.menuGrade]) {
      if (!grade) continue;
      grade.setTint(color, amount);
      grade.saturation = saturation;
    }
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
    if (this.reducedMotion) return;
    this.stress = Math.min(1, this.stress + amount);
  }

  /** Reduced-motion: suppress the blast screen pulse and settle any in-flight vignette/aberration. */
  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    if (!on) return;
    this.stress = 0;
    if (this.vignette) this.vignette.darkness = this.baseVignette;
    if (this.aberration) this.aberration.offset.set(this.baseAberration, this.baseAberration);
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
      if (typeof data.pickupId === "string") return { entityId: "", pickupId: data.pickupId };
    }
    return undefined;
  }

  /**
   * Black-silhouette mode for the shape test: everything renders flat black on white, so a unit
   * can only be identified by its OUTLINE. Recolour variants and same-chassis kits fail it on
   * sight, which is exactly what it exists to catch.
   */
  setSilhouette(on: boolean): void {
    if (on) {
      this.silhouetteBackground = this.scene.background;
      this.silhouetteFog = this.scene.fog;
      this.silhouetteQuality = this.quality;
      // The graded post chain would tone-map and vignette the white ground away, and fog would
      // grey the shapes out — both defeat the test. Silhouette mode renders direct.
      this.setQuality("performance");
      this.scene.background = new THREE.Color(0xffffff);
      this.scene.fog = null;
      this.scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
      return;
    }
    if (this.scene.overrideMaterial) {
      (this.scene.overrideMaterial as THREE.Material).dispose();
      this.scene.overrideMaterial = null;
    }
    if (this.silhouetteBackground !== undefined) this.scene.background = this.silhouetteBackground;
    if (this.silhouetteFog !== undefined) this.scene.fog = this.silhouetteFog;
    if (this.silhouetteQuality) this.setQuality(this.silhouetteQuality);
  }

  /**
   * Slide the shadow window onto whatever the camera is looking at, snapped to whole shadow texels.
   * Without the snap, sub-texel movement makes every shadow edge crawl as the camera pans -- the
   * classic cascaded-shadow shimmer, and far more objectionable than the low resolution it fixes.
   */
  private syncShadowFrustum(): void {
    const texel = (SHADOW_RADIUS * 2) / this.keyLight.shadow.mapSize.x;
    const x = Math.round(this.focus.x / texel) * texel;
    const z = Math.round(this.focus.z / texel) * texel;
    this.keyLight.position.set(x + KEY_LIGHT_OFFSET.x, KEY_LIGHT_OFFSET.y, z + KEY_LIGHT_OFFSET.z);
    this.keyLight.target.position.set(x, 0, z);
    this.keyLight.target.updateMatrixWorld();
  }

  render(dt = 0.016): void {
    this.syncShadowFrustum();
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
    // Max raised from 1.55 so the enlarged large maps (~104u wide) can be framed by pulling back.
    this.zoom = Math.max(0.62, Math.min(2.6, this.zoom + delta));
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
