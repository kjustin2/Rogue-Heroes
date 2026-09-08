import * as THREE from "three";

const MAX_PARTICLES = 4096;

/** Shape-atlas cell indices for `BurstOpts.shape`. `mote` (0) is the default so
 *  every existing burst() call site renders exactly as before. */
export const ParticleShape = {
  mote: 0,
  streak: 1,
  shard: 2,
  ring: 3,
} as const;

let shapeAtlas: THREE.CanvasTexture | null = null;

/**
 * Shared 2x2 particle-shape atlas (soft mote / spark streak / debris shard /
 * ring fragment), baked once at boot and reused by every burst. Cell 0 (mote)
 * is a solid white fill so it's a no-op mask — the radial glow shape below is
 * unchanged for callers that never opt into a shape.
 */
function getShapeAtlas(): THREE.CanvasTexture {
  if (shapeAtlas) return shapeAtlas;
  const cell = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = cell * 2;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fff";

  // Cell 0 — mote: full coverage, carves nothing.
  g.fillRect(0, 0, cell, cell);

  // Cell 1 — spark streak: a thin feathered ellipse.
  g.save();
  g.translate(cell * 1.5, cell * 0.5);
  g.filter = "blur(4px)";
  g.beginPath();
  g.ellipse(0, 0, cell * 0.42, cell * 0.09, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Cell 2 — debris shard: an irregular angular quad.
  g.save();
  g.translate(cell * 0.5, cell * 1.5);
  g.filter = "blur(2px)";
  g.beginPath();
  g.moveTo(0, -cell * 0.38);
  g.lineTo(cell * 0.3, cell * 0.1);
  g.lineTo(cell * 0.05, cell * 0.36);
  g.lineTo(-cell * 0.32, cell * 0.05);
  g.closePath();
  g.fill();
  g.restore();

  // Cell 3 — ring fragment: a thick partial arc.
  g.save();
  g.translate(cell * 1.5, cell * 1.5);
  g.filter = "blur(2px)";
  g.strokeStyle = "#fff";
  g.lineWidth = cell * 0.14;
  g.beginPath();
  g.arc(0, 0, cell * 0.3, -Math.PI * 0.15, Math.PI * 0.95);
  g.stroke();
  g.restore();

  shapeAtlas = new THREE.CanvasTexture(cv);
  // Hard cell borders — mipmaps would bleed neighboring cells at distance/glancing sizes.
  shapeAtlas.generateMipmaps = false;
  shapeAtlas.minFilter = THREE.LinearFilter;
  shapeAtlas.magFilter = THREE.LinearFilter;
  return shapeAtlas;
}

export interface BurstOpts {
  x: number;
  y: number;
  z: number;
  count: number;
  /** One color or a palette to pick from per particle. */
  color: number | number[];
  speed?: [number, number];
  /** Upward bias added to the random direction (0 = full sphere). */
  up?: number;
  /** Flatten vertical spread (1 = sphere, 0 = disc). */
  vertical?: number;
  size?: [number, number];
  life?: [number, number];
  gravity?: number;
  drag?: number;
  /** Random spawn offset radius. */
  jitter?: number;
  /** ParticleShape cell (or a palette to pick from per particle). Defaults to `mote`. */
  shape?: number | number[];
}

export interface DirectionalBurstOpts extends Omit<BurstOpts, "up" | "vertical"> {
  dirX: number;
  dirY: number;
  dirZ: number;
  /** Angular/random cone width around the supplied direction. */
  spread?: number;
}

/**
 * Single pooled GPU point cloud for every spark/ember/burst in the game,
 * plus a pool of expanding ring meshes for shockwaves. Additive, bloom-friendly.
 */
export class Particles {
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private fades: Float32Array;
  private shapes: Float32Array;
  private velocities: Float32Array;
  private life: Float32Array;
  private lifeTotal: Float32Array;
  private gravity: Float32Array;
  private drag: Float32Array;
  private tmpColor = new THREE.Color();
  private cursor = 0;
  private points: THREE.Points;

  // Ambient ember emitter
  ambientRate = 0;
  ambientColor = 0xff8844;
  ambientRadius = 20;
  private ambientAcc = 0;

  private rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; dur: number; from: number; to: number; circle:THREE.BufferGeometry; burst?:THREE.BufferGeometry; opacity:number }[] = [];
  private beams: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number }[] = [];

  constructor(private scene: THREE.Scene) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.fades = new Float32Array(MAX_PARTICLES);
    this.shapes = new Float32Array(MAX_PARTICLES); // all-zero = ParticleShape.mote by default
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.lifeTotal = new Float32Array(MAX_PARTICLES);
    this.gravity = new Float32Array(MAX_PARTICLES);
    this.drag = new Float32Array(MAX_PARTICLES);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute("aFade", new THREE.BufferAttribute(this.fades, 1));
    this.geometry.setAttribute("aShape", new THREE.BufferAttribute(this.shapes, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uAtlas: { value: getShapeAtlas() },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aFade;
        attribute float aShape;
        varying vec3 vColor;
        varying float vFade;
        varying float vShape;
        void main() {
          vColor = aColor;
          vFade = aFade;
          vShape = aShape;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * aFade * (240.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        varying vec3 vColor;
        varying float vFade;
        varying float vShape;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv) * 2.0;
          // Coloured corona (original falloff) plus a tight near-white core UNDER
          // it — a sharper second power term keeps the hot center small so it
          // reads as a highlight, not a wash.
          float corona = smoothstep(1.0, 0.15, d);
          float core = pow(clamp(1.0 - d, 0.0, 1.0), 6.0);
          vec3 col = mix(vColor * (1.0 + (1.0 - d) * 1.4), vec3(1.0), core * 0.7);

          // Shape atlas: carve the corona into one of 4 baked masks picked per-
          // particle at spawn (mote's cell is solid white, so shape=0 is a no-op).
          float cellIdx = floor(vShape + 0.5);
          vec2 cell = vec2(mod(cellIdx, 2.0), floor(cellIdx * 0.5));
          float mask = texture2D(uAtlas, (gl_PointCoord + cell) * 0.5).r;

          gl_FragColor = vec4(col, corona * vFade * mask);
          // A custom ShaderMaterial gets the tonemap/colorspace helpers injected but
          // must CALL them (like telegraphs.ts does), else the >1.0 corona/core values
          // bypass the ACES shoulder every lit surface gets and hard-clip to flat white
          // when additive bursts stack. Roll them off so overlaps grade instead of clip.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // Pre-build ring pool
    const ringGeo = new THREE.RingGeometry(0.983, 1.0, 80);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, mat, t: 0, dur: 0, from: 0, to: 0, circle:ringGeo, opacity:.5 });
    }

    // Light-beam pool (spawn pillars, arrivals)
    const beamGeo = new THREE.CylinderGeometry(0.12, 0.44, 3.3, 20, 1, true);
    beamGeo.translate(0, 1.65, 0);
    const beamCanvas = document.createElement("canvas");
    beamCanvas.width = 16; beamCanvas.height = 128;
    const bg = beamCanvas.getContext("2d")!;
    const gradient = bg.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, "black"); gradient.addColorStop(0.7, "#a0a0a0"); gradient.addColorStop(0.96, "white"); gradient.addColorStop(1, "black");
    bg.fillStyle = gradient; bg.fillRect(0, 0, 16, 128);
    const beamAlpha = new THREE.CanvasTexture(beamCanvas);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, alphaMap: beamAlpha,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.beams.push({ mesh, mat, t: -1 });
    }
  }

  /** Vertical light pillar — used when something materializes. */
  beam(x: number, z: number, color: number): void {
    const b = this.beams.find((b) => b.t < 0);
    if (!b) return;
    b.t = 0;
    b.mesh.visible = true;
    b.mesh.position.set(x, 0, z);
    b.mesh.scale.set(1, 1, 1);
    b.mat.color.set(color);
    b.mat.opacity = 0.32;
  }

  burst(opts: BurstOpts): void {
    const speed = opts.speed ?? [3, 8];
    const size = opts.size ?? [0.5, 1.1];
    const life = opts.life ?? [0.3, 0.7];
    const up = opts.up ?? 0.35;
    const vertical = opts.vertical ?? 1;
    const gravity = opts.gravity ?? -9;
    const drag = opts.drag ?? 2.5;
    const jitter = opts.jitter ?? 0.15;
    const palette = Array.isArray(opts.color) ? opts.color : null;
    const shapePalette = Array.isArray(opts.shape) ? opts.shape : null;
    const shape = shapePalette ? null : opts.shape ?? ParticleShape.mote;

    for (let n = 0; n < opts.count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const i3 = i * 3;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      let dx = Math.sin(phi) * Math.cos(theta);
      let dy = Math.cos(phi) * vertical + up;
      let dz = Math.sin(phi) * Math.sin(theta);
      const inv = 1 / Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const spd = speed[0] + Math.random() * (speed[1] - speed[0]);
      dx *= inv * spd;
      dy *= inv * spd;
      dz *= inv * spd;

      this.positions[i3] = opts.x + (Math.random() - 0.5) * jitter * 2;
      this.positions[i3 + 1] = opts.y + (Math.random() - 0.5) * jitter;
      this.positions[i3 + 2] = opts.z + (Math.random() - 0.5) * jitter * 2;
      this.velocities[i3] = dx;
      this.velocities[i3 + 1] = dy;
      this.velocities[i3 + 2] = dz;

      const color = palette ? palette[Math.floor(Math.random() * palette.length)] : opts.color as number;
      this.tmpColor.set(color);
      this.colors[i3] = this.tmpColor.r;
      this.colors[i3 + 1] = this.tmpColor.g;
      this.colors[i3 + 2] = this.tmpColor.b;

      this.sizes[i] = size[0] + Math.random() * (size[1] - size[0]);
      const lf = life[0] + Math.random() * (life[1] - life[0]);
      this.life[i] = lf;
      this.lifeTotal[i] = lf;
      this.fades[i] = 1;
      this.gravity[i] = gravity;
      this.drag[i] = drag;
      this.shapes[i] = shapePalette ? shapePalette[Math.floor(Math.random() * shapePalette.length)] : (shape as number);
    }
    // aColor/aSize/aShape only change when particles spawn — flag them here, not
    // every frame in update(), so quiet-but-alive frames skip these re-uploads.
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aShape.needsUpdate = true;
  }

  /** Target-local impact fan. Unlike burst(), particles inherit a clear attack
   * direction so contact reads as force instead of a spherical fireworks cloud. */
  directionalBurst(opts: DirectionalBurstOpts): void {
    const speed = opts.speed ?? [3, 8];
    const size = opts.size ?? [0.3, 0.7];
    const life = opts.life ?? [0.15, 0.35];
    const gravity = opts.gravity ?? -7;
    const drag = opts.drag ?? 4;
    const jitter = opts.jitter ?? 0.08;
    const spread = opts.spread ?? 0.5;
    const palette = Array.isArray(opts.color) ? opts.color : null;
    const shapePalette = Array.isArray(opts.shape) ? opts.shape : null;
    const shape = shapePalette ? null : opts.shape ?? ParticleShape.streak;
    const baseLen = Math.hypot(opts.dirX, opts.dirY, opts.dirZ) || 1;
    const bx = opts.dirX / baseLen, by = opts.dirY / baseLen, bz = opts.dirZ / baseLen;

    for (let n = 0; n < opts.count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const i3 = i * 3;
      let dx = bx + (Math.random() - 0.5) * spread;
      let dy = by + (Math.random() - 0.5) * spread * 0.65;
      let dz = bz + (Math.random() - 0.5) * spread;
      const inv = 1 / Math.max(0.001, Math.hypot(dx, dy, dz));
      const spd = speed[0] + Math.random() * (speed[1] - speed[0]);
      dx *= inv * spd; dy *= inv * spd; dz *= inv * spd;
      this.positions[i3] = opts.x + (Math.random() - 0.5) * jitter * 2;
      this.positions[i3 + 1] = opts.y + (Math.random() - 0.5) * jitter;
      this.positions[i3 + 2] = opts.z + (Math.random() - 0.5) * jitter * 2;
      this.velocities[i3] = dx;
      this.velocities[i3 + 1] = dy;
      this.velocities[i3 + 2] = dz;
      const color = palette ? palette[Math.floor(Math.random() * palette.length)] : opts.color as number;
      this.tmpColor.set(color);
      this.colors[i3] = this.tmpColor.r;
      this.colors[i3 + 1] = this.tmpColor.g;
      this.colors[i3 + 2] = this.tmpColor.b;
      this.sizes[i] = size[0] + Math.random() * (size[1] - size[0]);
      const lf = life[0] + Math.random() * (life[1] - life[0]);
      this.life[i] = lf;
      this.lifeTotal[i] = lf;
      this.fades[i] = 1;
      this.gravity[i] = gravity;
      this.drag[i] = drag;
      this.shapes[i] = shapePalette ? shapePalette[Math.floor(Math.random() * shapePalette.length)] : (shape as number);
    }
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aShape.needsUpdate = true;
  }

  /** A brief directional cut, pooled with pressure sheets and ground waves. */
  slash(x:number,z:number,opts:{radius:number;angle:number;color:number;duration?:number}):void {
    this.ring(x,z,{radius:opts.radius,color:opts.color,duration:opts.duration??.2,y:.82,cutAngle:opts.angle});
  }

  /** Expanding ground shockwave ring. */
  ring(x: number, z: number, opts: { radius: number; color: number; duration?: number; y?: number; startRadius?: number; burstRadii?: readonly number[]; cutAngle?: number; cutWidth?: number; opacity?: number }): void {
    const slot = this.rings.find((r) => !r.mesh.visible);
    if (!slot) return;
    // Reuse the same finite pool for angular pressure sheets. Each slot owns
    // its mutable geometry; an overlapping blast cannot reshape another blast.
    if(opts.burstRadii || opts.cutAngle!==undefined){
      if(!slot.burst){slot.burst=new THREE.BufferGeometry();slot.burst.setAttribute("position",new THREE.BufferAttribute(new Float32Array(16*9),3));}
      const positions=slot.burst.getAttribute("position") as THREE.BufferAttribute;
      if(opts.cutAngle!==undefined){
        const radius=opts.radius,w=opts.cutWidth ?? .14,angle=opts.cutAngle,s=Math.sin(angle),c=Math.cos(angle);
        const corners=[0,-radius,-w,0,0,radius,0,radius,w,0,0,-radius];
        for(let i=0;i<6;i++){const x=corners[i*2],z=corners[i*2+1];positions.setXYZ(i,c*x+s*z,0,c*z-s*x);}
        slot.burst.setDrawRange(0,6);
      } else {
      slot.burst.setDrawRange(0,48);
      for(let i=0;i<16;i++){
        const angle=i*Math.PI/8,radius=opts.burstRadii![i]??0;
        const inner=Math.min(.22,radius*.2),width=radius*.13;
        const dx=Math.sin(angle),dz=Math.cos(angle);
        positions.setXYZ(i*3,dx*inner-dz*width,.08,dz*inner+dx*width);
        positions.setXYZ(i*3+1,dx*radius,(i%2)*.16,dz*radius);
        positions.setXYZ(i*3+2,dx*inner+dz*width,.08,dz*inner-dx*width);
      }
      }
      positions.needsUpdate=true;slot.burst.computeBoundingSphere();slot.mesh.geometry=slot.burst;
    } else slot.mesh.geometry=slot.circle;
    slot.opacity=opts.opacity ?? (opts.burstRadii || opts.cutAngle!==undefined ? .8 : .5);
    slot.mesh.visible = true;
    slot.mesh.position.set(x, opts.y ?? 0.06, z);
    slot.t = 0;
    slot.dur = opts.duration ?? 0.45;
    slot.from = opts.cutAngle!==undefined ? 1 : opts.burstRadii ? .16 : opts.startRadius ?? opts.radius * 0.15;
    slot.to = opts.burstRadii || opts.cutAngle!==undefined ? 1 : opts.radius;
    slot.mat.color.set(opts.color);
    slot.mat.opacity = slot.opacity;
    slot.mesh.scale.setScalar(slot.from);
  }

  /** Remove transient particles, shockwaves and materialization beams while
   * retaining the pools. Scene changes and presentation plates must never
   * inherit combat flashes from the room they replaced. */
  clear(): void {
    this.life.fill(0);
    this.fades.fill(0);
    for (let i = 1; i < this.positions.length; i += 3) this.positions[i] = -999;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aFade.needsUpdate = true;
    for (const ring of this.rings) {
      ring.t = ring.dur;
      ring.mat.opacity = 0;
      ring.mesh.visible = false;
    }
    for (const beam of this.beams) {
      beam.t = -1;
      beam.mat.opacity = 0;
      beam.mesh.visible = false;
    }
    this.ambientAcc = 0;
  }

  stats(): { particles: number; rings: number; beams: number } {
    let particles = 0;
    for (let i = 0; i < this.life.length; i++) if (this.life[i] > 0) particles++;
    return {
      particles,
      rings: this.rings.reduce((count, ring) => count + (ring.mesh.visible ? 1 : 0), 0),
      beams: this.beams.reduce((count, beam) => count + (beam.mesh.visible ? 1 : 0), 0),
    };
  }

  update(dt: number): void {
    // Ambient embers
    if (this.ambientRate > 0) {
      this.ambientAcc += dt * this.ambientRate;
      while (this.ambientAcc >= 1) {
        this.ambientAcc -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * this.ambientRadius;
        this.burst({
          x: Math.cos(a) * r,
          y: 0.2 + Math.random() * 1.5,
          z: Math.sin(a) * r,
          count: 1,
          color: this.ambientColor,
          speed: [0.2, 0.7],
          up: 1.6,
          vertical: 0.3,
          size: [0.25, 0.55],
          life: [2.2, 4.5],
          gravity: 0.35,
          drag: 0.4,
          jitter: 0.1,
        });
      }
    }

    let anyAlive = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      anyAlive = true;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.fades[i] = 0;
        this.positions[i3 + 1] = -999;
        continue;
      }
      const dragF = Math.exp(-this.drag[i] * dt);
      this.velocities[i3] *= dragF;
      this.velocities[i3 + 1] = this.velocities[i3 + 1] * dragF + this.gravity[i] * dt;
      this.velocities[i3 + 2] *= dragF;
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;
      if (this.positions[i3 + 1] < 0.02) {
        this.positions[i3 + 1] = 0.02;
        this.velocities[i3 + 1] *= -0.35;
      }
      this.fades[i] = Math.min(1, this.life[i] / (this.lifeTotal[i] * 0.55));
    }
    // Skip the (large) buffer re-uploads on quiet frames. Only position + aFade
    // are mutated here; aColor/aSize are flagged in burst() (they change on spawn).
    if (anyAlive) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aFade.needsUpdate = true;
    }

    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      const eased = 1 - Math.pow(1 - k, 3);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * eased);
      r.mat.opacity = r.opacity * (1 - k) * (1 - k);
      if (k >= 1) r.mesh.visible = false;
    }

    for (const b of this.beams) {
      if (b.t < 0) continue;
      b.t += dt;
      const k = Math.min(1, b.t / 0.5);
      b.mesh.scale.set(1 - k * 0.75, 1 + k * 0.3, 1 - k * 0.75);
      b.mat.opacity = 0.32 * (1 - k);
      if (k >= 1) {
        b.t = -1;
        b.mesh.visible = false;
      }
    }
  }
}
