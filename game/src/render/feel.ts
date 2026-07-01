import * as THREE from "three";
import { clamp01, type Vec2 } from "../core/math";
import type { Stage } from "./stage";

/**
 * Trauma-based screenshake + directional kick for the tactics camera, driven by the
 * battle-event diff in main (new projectiles / blasts). Shake intensity is trauma², so
 * rifle fire whispers and artillery roars. Applied as additive offsets through
 * stage.setShake() — the tactical rig's focus/orbit math stays untouched.
 */
export class FeelDirector {
  private trauma = 0;
  private t = 0;
  private readonly kickVel = new THREE.Vector3();
  private readonly kickOffset = new THREE.Vector3();
  private readonly shake = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private reduced = false;

  constructor(private readonly stage: Stage) {}

  setReducedMotion(on: boolean): void {
    this.reduced = on;
    if (on) {
      this.trauma = 0;
      this.kickVel.set(0, 0, 0);
      this.kickOffset.set(0, 0, 0);
    }
  }

  addTrauma(amount: number): void {
    if (!this.reduced) this.trauma = clamp01(this.trauma + amount);
  }

  /** Directional shove away from a blast (from -> to is the shove direction). */
  kick(from: Vec2, to: Vec2, strength: number): void {
    if (this.reduced) return;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    this.kickVel.x += (dx / len) * strength;
    this.kickVel.z += (dz / len) * strength;
  }

  update(dt: number): void {
    this.t += dt;
    // Kick spring: velocity shoves the offset out, both decay exponentially.
    this.kickVel.multiplyScalar(Math.exp(-9 * dt));
    this.kickOffset.addScaledVector(this.kickVel, dt);
    this.kickOffset.multiplyScalar(Math.exp(-7 * dt));
    // Trauma shake — perlin-ish noise via incommensurate sines, intensity = trauma².
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const sh = this.trauma * this.trauma;
    const n1 = Math.sin(this.t * 47.3) + Math.sin(this.t * 29.7) * 0.6;
    const n2 = Math.sin(this.t * 41.1 + 2.1) + Math.sin(this.t * 33.9 + 0.7) * 0.6;
    const n3 = Math.sin(this.t * 53.7 + 4.2) * 0.7;
    this.shake.set(n1 * sh * 0.5 + this.kickOffset.x, n2 * sh * 0.35, n3 * sh * 0.45 + this.kickOffset.z);
    this.look.set(this.shake.x * 0.5, 0, this.shake.z * 0.5);
    this.stage.setShake(this.shake, this.look);
  }
}
