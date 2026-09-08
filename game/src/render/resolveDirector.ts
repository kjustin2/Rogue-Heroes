import type { Vec2 } from "../core/math";

/**
 * CAMERA DIRECTION FOR THE RESOLVE PHASE.
 *
 * Orders resolve concurrently across the whole board, and the camera used to stay wherever the
 * player left it during planning. So the turn you spent planning played out partly off screen --
 * the game even acknowledged this by scaling shake and light flashes to 0.3 when the action was
 * out of view, which is treating the symptom. If the best moment of a turn happens off camera, it
 * did not happen.
 *
 * This watches what the sim is already emitting, scores it, and points the camera at whatever is
 * most worth seeing right now. It is a PRESENTATION layer only: it reads outcomes and decides
 * where to look and when to hold. It never re-orders damage, never touches the rng, and never
 * changes a result -- the determinism and chaos suites must pass identically with it on or off.
 *
 * Hitstop is implemented as "do not advance the sim this frame" rather than by scaling dt. Scaling
 * dt would change the step sequence the sim sees; skipping frames only delays everything
 * uniformly, so ordering is untouched.
 */
export interface PointOfInterest {
  x: number;
  z: number;
  /** How much this is worth looking at. Higher wins. */
  weight: number;
  /** Seconds remaining before it stops competing for the camera. */
  life: number;
}

/** What the director wants this frame. */
export interface DirectorFrame {
  /** Where to point the camera, already smoothed. Undefined = leave the camera alone. */
  focus?: Vec2;
  /** Seconds of sim freeze remaining. While above zero the caller must not step the sim. */
  hitstop: number;
}

// Weights are ordered by how much a moment rewards being watched, not by how loud it is.
export const POI_WEIGHT = {
  shot: 1,
  impact: 2.2,
  blast: 4,
  topple: 4.5,
  strike: 5,
  kill: 7,
} as const;

/** How long the player is left alone after they move the camera themselves. */
const PLAYER_CONTROL_GRACE = 2.4;

export class ResolveDirector {
  private pois: PointOfInterest[] = [];
  private smoothed: Vec2 | null = null;
  private hitstop = 0;
  private sincePlayerInput = PLAYER_CONTROL_GRACE;
  private held: PointOfInterest | null = null;

  /** Camera authority is opt-in; reduce-motion players keep a still camera. */
  enabled = true;

  begin(at?: Vec2): void {
    this.pois.length = 0;
    this.held = null;
    this.hitstop = 0;
    this.smoothed = at ? { x: at.x, z: at.z } : null;
  }

  /** The player panned or zoomed: back off and let them look where they want. */
  playerTookControl(): void {
    this.sincePlayerInput = 0;
  }

  /**
   * Register something worth watching. `hold` is how long it stays interesting -- a shot is over
   * almost immediately, a chain detonation deserves a beat.
   */
  note(x: number, z: number, weight: number, hold = 0.9): void {
    this.pois.push({ x, z, weight, life: hold });
  }

  /**
   * Freeze the sim briefly. Used on a killing blow: the eye needs a moment to register that the
   * thing it was watching is gone, and a kill that resolves in the same frame as everything else
   * reads as a unit simply vanishing.
   */
  freeze(seconds: number): void {
    this.hitstop = Math.max(this.hitstop, seconds);
  }

  update(dt: number): DirectorFrame {
    this.sincePlayerInput += dt;

    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - dt);
      // The camera keeps easing during a freeze -- a hard stop on both at once reads as a stutter.
    }

    // Decay ONCE. `held` is a reference to a point that is also in `pois`, so ageing it separately
    // aged it at double rate and every focus expired in half its intended life.
    for (const poi of this.pois) poi.life -= dt;
    if (this.pois.length > 0) this.pois = this.pois.filter((p) => p.life > 0);
    // Held focus expires with the rest, so the camera releases instead of locking on a corpse.
    if (this.held && this.held.life <= 0) this.held = null;

    if (!this.enabled || this.sincePlayerInput < PLAYER_CONTROL_GRACE) {
      return { hitstop: this.hitstop };
    }

    const best = this.best();
    if (best) {
      // Only switch away from what we are holding for something clearly better. Without this the
      // camera ping-pongs between two equally interesting firefights and watches neither.
      if (!this.held || best.weight > this.held.weight * 1.25) this.held = best;
    }
    const target = this.held;
    if (!target) return { hitstop: this.hitstop };

    if (!this.smoothed) this.smoothed = { x: target.x, z: target.z };
    // Frame-rate independent ease. Deliberately unhurried: a camera that snaps to each new event
    // is more disorienting than one that misses a little.
    const k = 1 - Math.exp(-3.2 * dt);
    this.smoothed.x += (target.x - this.smoothed.x) * k;
    this.smoothed.z += (target.z - this.smoothed.z) * k;
    return { focus: { x: this.smoothed.x, z: this.smoothed.z }, hitstop: this.hitstop };
  }

  private best(): PointOfInterest | null {
    let top: PointOfInterest | null = null;
    for (const poi of this.pois) {
      // Interest fades over a point's life, so a fresh shot can outrank a stale explosion.
      const score = poi.weight * Math.max(0.25, poi.life);
      const topScore = top ? top.weight * Math.max(0.25, top.life) : -1;
      if (score > topScore) top = poi;
    }
    return top;
  }

  /** For tests and the smoke: what the director is currently tracking. */
  debugState(): { pois: number; hitstop: number; holding: boolean; yieldingToPlayer: boolean } {
    return {
      pois: this.pois.length,
      hitstop: Number(this.hitstop.toFixed(3)),
      holding: this.held !== null,
      yieldingToPlayer: this.sincePlayerInput < PLAYER_CONTROL_GRACE,
    };
  }
}
