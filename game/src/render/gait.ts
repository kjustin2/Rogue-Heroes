/**
 * Infantry locomotion, as pure math.
 *
 * The one rule everything here serves: THE STRIDE IS LOCKED TO DISTANCE. The renderer advances a
 * unit's gait phase by (metres moved / stride length), never by wall time, and a planted foot is
 * placed by the phase alone -- so while it is on the ground it slides backwards under the body at
 * exactly the speed the body moves forward, and its world velocity is zero. Foot skate, the #1
 * amateur tell, is impossible by construction rather than tuned away, and `smoke:animation`
 * measures it on the rendered boots to make sure it stays that way.
 *
 * Rig space is the trooper's: y up, +z forward, the hip pivots at x = ±width. Two-segment legs:
 * the authored leg mesh is split at the knee at load (`splitAtKnee` in legSplit.ts) and each half
 * is posed here by a two-bone IK from the hip to the ankle target. Nothing in here touches three --
 * `gait.test.ts` proves the contract (zero planted velocity, every stance target reachable, tiers
 * distinct) without a renderer.
 */

export type GaitTier = "walk" | "march" | "trudge";

export interface GaitParams {
  /** Metres per full cycle (two steps). */
  stride: number;
  /** Fraction of the cycle each foot is on the ground. < 0.5 is a run (flight phase), > 0.5 a walk (double support). */
  stance: number;
  /** Hip height (m) at contact / mid-stance / toe-off / the peak between steps. The knee follows by IK. */
  hip: [number, number, number, number];
  /** Swing-foot lift at mid-swing, metres. */
  lift: number;
  /** Forward body lean, rad. */
  lean: number;
  /** Side-to-side roll amplitude, rad. */
  sway: number;
  /** Free-arm swing as a fraction of the opposite thigh's angle. */
  armSwing: number;
  /** Pelvis yaw amplitude (rad) toward the leading leg; the torso counters it. */
  twist: number;
  /** Extra stance width per side, metres. */
  width: number;
}

// Leg geometry, shared with the rig in worldRenderer.ts (the leg mesh is 0.5 tall centred at 0.36,
// the authored knee sits at 0.35, the boot centre at 0.07 with its sole on the ground).
export const HIP_Y = 0.58;
export const KNEE_Y = 0.35;
export const ANKLE_Y = 0.10;
export const HIP_Z = 0.02;
export const THIGH = HIP_Y - KNEE_Y;
export const SHIN = KNEE_Y - ANKLE_Y;
/** Boot: heel this far behind the ankle, toe this far ahead (the boot is 0.32 long, centred 0.04 ahead). */
export const HEEL = 0.12;
export const TOE = 0.2;
const HEEL_PITCH = 0.26;
const TOE_PITCH = 0.42;

// The units cross the board at 10-24 m/s (MOVE_RANGE_SCALE doubles the catalog speed), which for
// a 1.7 m figure is a flat sprint, so the in-game gait is a RUN: short ground contact, a flight
// phase, a long stride. A "walking" stride (0.6-0.8 m) at that speed is 20 cycles a second and
// strobes at 60 Hz -- the old cycle ran at 1.64 m for the same reason. The walk-length stride is
// kept for crouched movement, which is the only slow locomotion in the game.
export const GAIT_TIERS: Record<GaitTier, GaitParams> = {
  // The line trooper: an even, economical run.
  walk: { stride: 1.6, stance: 0.30, hip: [0.54, 0.55, 0.585, 0.62], lift: 0.14, lean: 0.07, sway: 0.02, armSwing: 0.7, twist: 0.1, width: 0 },
  // Scout / striker: quick march -- longer stride, more lean, higher knees, the arms pump.
  march: { stride: 1.95, stance: 0.26, hip: [0.535, 0.545, 0.585, 0.63], lift: 0.18, lean: 0.13, sway: 0.015, armSwing: 0.95, twist: 0.12, width: -0.01 },
  // Heavy / mortar / flamer: a trudge -- shorter stride, longer contact, wide stance, the body rolls.
  trudge: { stride: 1.25, stance: 0.40, hip: [0.53, 0.535, 0.57, 0.578], lift: 0.09, lean: 0.05, sway: 0.06, armSwing: 0.45, twist: 0.07, width: 0.035 },
};

/** Crouched movement: low, short, quick steps, no flight -- the only walk-length gait in the game. */
export const CROUCH_GAIT: GaitParams = { stride: 0.55, stance: 0.62, hip: [0.31, 0.335, 0.32, 0.335], lift: 0.04, lean: 0.1, sway: 0.02, armSwing: 0.25, twist: 0.05, width: 0.03 };

export function gaitTier(kind: string): GaitTier {
  switch (kind) {
    case "scout":
    case "striker":
      return "march";
    case "heavy":
    case "mortar":
    case "flamer":
      return "trudge";
    default:
      return "walk";
  }
}

/** Hip-to-ankle distance for a knee flexion. */
export function legReach(knee: number): number {
  return Math.sqrt(THIGH * THIGH + SHIN * SHIN + 2 * THIGH * SHIN * Math.cos(knee));
}

export interface FootTarget {
  /** Ankle position in rig space (x is the hip's own; only y/z are solved). */
  y: number;
  z: number;
  /** Sole pitch, rad, positive = toe up (heel strike), negative = heel up (toe-off). */
  pitch: number;
  planted: boolean;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Where one foot is at cycle phase `u` (0..1, contact at 0), in the body's frame. During stance
 * the ankle moves straight back at the body's own speed -- that IS the stride lock. `bob` is the
 * hip's current drop below HIP_Y (the group is lowered by it, so the ground sits that much HIGHER in rig space).
 */
export function footAt(g: GaitParams, u: number, bob: number): FootTarget {
  const travel = g.stance * g.stride;
  const phase = u - Math.floor(u);
  if (phase < g.stance) {
    const s = phase / g.stance;
    // Where the ankle would be with the sole flat. The heel (HEEL behind it) and toe (TOE ahead)
    // both move back at exactly the body's speed -- whichever is touching is the planted point.
    const flatZ = HIP_Z + travel / 2 - travel * s;
    if (s < 0.3) {
      // Heel strike: the foot pivots about the heel as the sole rolls down.
      const pitch = HEEL_PITCH * (1 - smooth(s / 0.3));
      return { y: ANKLE_Y + bob + HEEL * Math.sin(pitch), z: flatZ - HEEL + HEEL * Math.cos(pitch), pitch, planted: true };
    }
    if (s > 0.7) {
      // Toe-off: the heel rises and the foot pivots about the toe, which lifts the ankle and lets
      // the trailing leg hand its share of the weight over smoothly.
      const pitch = -TOE_PITCH * smooth((s - 0.7) / 0.3);
      return { y: ANKLE_Y + bob + TOE * Math.sin(-pitch), z: flatZ + TOE - TOE * Math.cos(pitch), pitch, planted: true };
    }
    return { y: ANKLE_Y + bob, z: flatZ, pitch: 0, planted: true };
  }
  const s = (phase - g.stance) / (1 - g.stance);
  const arc = Math.sin(Math.PI * s);
  // The swing starts where toe-off left the ankle (raised, ahead of the flat line) and ends where
  // the heel strike puts it, so the arc is continuous at both ends.
  const from = footAt(g, g.stance - 1e-6, bob);
  const fromY = from.y;
  const fromZ = from.z;
  const to = footAt(g, 0, bob);
  const t = smooth(s);
  return {
    y: lerp(fromY, to.y, t) + g.lift * arc,
    z: lerp(fromZ, to.z, t),
    // Toe still down after toe-off, level through the middle, heel leading into the strike.
    pitch: s < 0.4 ? -TOE_PITCH * (1 - s / 0.4) : s > 0.75 ? HEEL_PITCH * ((s - 0.75) / 0.25) : 0,
    planted: false,
  };
}

/**
 * The hip's drop below HIP_Y at cycle phase `p` (leg R at u = p, leg L at u = p + 0.5). An authored
 * curve with a half-cycle period: contact -> mid-stance -> toe-off -> the peak between steps
 * (mid-flight in a run, the high point of double support in a walk) -> the next contact. The knee
 * is whatever the IK needs to put the foot on the ground under it; `gait.test.ts` proves every
 * planted target is within reach of the curve (a hip authored too high hovers the foot).
 */
export function hipBob(g: GaitParams, p: number): number {
  const phase = p - Math.floor(p);
  const u = phase % 0.5;
  const [contact, mid, off, peak] = g.hip;
  // Keys over one half-cycle (one step). A run: contact -> mid-stance -> toe-off -> flight peak ->
  // the other foot's contact. A walk (stance > 0.5): the OTHER foot toes off at stance - 0.5 (end
  // of double support), then mid-stance, then the next contact; there is no flight peak.
  const keys: [number, number][] = g.stance < 0.5
    ? [[0, contact], [g.stance / 2, mid], [g.stance, off], [(g.stance + 0.5) / 2, peak], [0.5, contact]]
    : [[0, contact], [g.stance - 0.5, off], [g.stance / 2, mid], [0.5, contact]];
  let hip = contact;
  for (let i = 1; i < keys.length; i += 1) {
    const [u0, h0] = keys[i - 1];
    const [u1, h1] = keys[i];
    if (u <= u1) { hip = lerp(h0, h1, smooth((u - u0) / (u1 - u0))); break; }
  }
  return HIP_Y - hip;
}

/** The highest the hip can sit at phase `p` with every planted foot still on the ground (straight leg). */
export function hipCeiling(g: GaitParams, p: number): number {
  let ceiling = Number.POSITIVE_INFINITY;
  for (const u of [p, p + 0.5]) {
    const f = footAt(g, u, 0);
    if (!f.planted) continue;
    const dz = f.z - HIP_Z;
    ceiling = Math.min(ceiling, f.y + Math.sqrt(Math.max(0, (THIGH + SHIN) ** 2 - dz * dz)));
  }
  return ceiling;
}

export interface LegPose {
  /** Thigh angle from straight down, rad, positive = forward. */
  thigh: number;
  /** Shin angle from straight down, rad (thigh minus knee flexion). */
  shin: number;
  /** Knee flexion actually solved, rad. */
  knee: number;
  /** Foot pitch passed through. */
  foot: number;
  /** Knee and ankle positions in rig space (for the shin/boot mesh placement). */
  kneeY: number;
  kneeZ: number;
  ankleY: number;
  ankleZ: number;
}

const _leg: LegPose = { thigh: 0, shin: 0, knee: 0, foot: 0, kneeY: KNEE_Y, kneeZ: HIP_Z, ankleY: ANKLE_Y, ankleZ: HIP_Z };

/**
 * Two-bone IK from the hip (HIP_Y, HIP_Z) to an ankle target, knee bending forward. Returns a
 * SHARED object (this runs per leg per unit per frame). An unreachable target straightens the leg
 * and leaves the foot short -- `hipBob` is built so that never happens on a planted foot.
 */
export function solveLeg(target: FootTarget, hipY: number = HIP_Y): LegPose {
  const dy = target.y - hipY;
  const dz = target.z - HIP_Z;
  const d = Math.min(THIGH + SHIN, Math.sqrt(dy * dy + dz * dz));
  // Angle of the hip->ankle line from straight down, forward positive.
  const line = Math.atan2(dz, -dy);
  const straight = d >= THIGH + SHIN - 1e-9;
  const cosKnee = (THIGH * THIGH + SHIN * SHIN - d * d) / (2 * THIGH * SHIN);
  const knee = straight ? 0 : Math.PI - Math.acos(Math.max(-1, Math.min(1, cosKnee)));
  const cosAlpha = (THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d);
  const alpha = straight ? 0 : Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
  const thigh = line + alpha;
  const shin = thigh - knee;
  _leg.thigh = thigh;
  _leg.shin = shin;
  _leg.knee = knee;
  _leg.foot = target.pitch;
  _leg.kneeY = hipY - THIGH * Math.cos(thigh);
  _leg.kneeZ = HIP_Z + THIGH * Math.sin(thigh);
  _leg.ankleY = _leg.kneeY - SHIN * Math.cos(shin);
  _leg.ankleZ = _leg.kneeZ + SHIN * Math.sin(shin);
  return _leg;
}

/** Body-level cues at phase p. Pelvis yaw follows the thigh split; the torso counters it. */
export function bodyAt(g: GaitParams, p: number): { bob: number; lean: number; sway: number; pelvisYaw: number } {
  return {
    bob: hipBob(g, p),
    lean: g.lean,
    sway: Math.sin(2 * Math.PI * p) * g.sway,
    // Right leg forward (p = 0) carries the right hip forward: +x toward +z is a NEGATIVE yaw in three.
    pelvisYaw: -g.twist * Math.cos(2 * Math.PI * p),
  };
}
