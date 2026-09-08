import { INFANTRY_MOTION, MOTION_CHANNELS } from "../game/infantryMotionData";
import type { WeaponFamily } from "./worldRenderer";

/**
 * Runtime sampler for the Blender-authored infantry control banks.
 *
 * The curves were evaluated in Blender; this only looks them up. There is deliberately no clock
 * here -- the caller passes a phase that comes from the ORDER's own elapsed/duration, so an
 * animation can never drift out of step with the action it belongs to. Combat owns durations;
 * animation owns pose.
 */
export interface MotionPose {
  shoulderPitch: number;
  shoulderYaw: number;
  elbowBend: number;
  offhandPitch: number;
  torsoPitch: number;
  torsoTwist: number;
  /** Metres. Positive pulls the weapon toward the body. */
  weaponDraw: number;
  /** Radians. Positive raises the muzzle. */
  weaponPitch: number;
  /** Metres of whole-body rise (positive) or settle (negative). */
  bodyLift: number;
  kneeBend: number;
}

export const REST_POSE: MotionPose = {
  shoulderPitch: 0, shoulderYaw: 0, elbowBend: 0, offhandPitch: 0, torsoPitch: 0,
  torsoTwist: 0, weaponDraw: 0, weaponPitch: 0, bodyLift: 0, kneeBend: 0,
};

// Weapon families map onto the authored clips. Several families share one -- a flame projector and
// a rifle brace the same way -- and that is a deliberate choice rather than a gap: a clip only
// earns its own bank when the motion genuinely differs.
const CLIP_FOR_FAMILY: Record<WeaponFamily, string> = {
  rifle: "rifle",
  burst: "burst",
  marksman: "marksman",
  cannon: "burst",
  launcher: "launcher",
  flamer: "rifle",
  melee: "melee",
};

/** Does a Blender bank exist for this family? Callers fall back to the procedural pose if not. */
export function hasMotionBank(family: WeaponFamily): boolean {
  return Boolean(INFANTRY_MOTION[CLIP_FOR_FAMILY[family]]);
}

/** The phase at which a family's shot actually connects, as authored. */
export function motionContact(family: WeaponFamily): number {
  return INFANTRY_MOTION[CLIP_FOR_FAMILY[family]]?.contact ?? 0.42;
}

const _out: MotionPose = { ...REST_POSE };

/**
 * Sample a family's clip at `phase` (0..1), linearly between the two nearest of its 101 frames.
 *
 * Returns a SHARED object: this runs per animated part per frame, and allocating a pose object
 * each time was measurable churn in a game that can have forty units on screen. Callers must read
 * the fields they need immediately rather than holding the reference.
 */
export function sampleMotion(family: WeaponFamily, phase: number): MotionPose {
  const clip = INFANTRY_MOTION[CLIP_FOR_FAMILY[family]];
  if (!clip) return REST_POSE;
  const frames = clip.frames;
  const last = frames.length - 1;
  const cursor = Math.max(0, Math.min(1, phase)) * last;
  const lo = Math.floor(cursor);
  const hi = Math.min(last, lo + 1);
  const t = cursor - lo;
  const a = frames[lo];
  const b = frames[hi];
  for (let i = 0; i < MOTION_CHANNELS.length; i += 1) {
    const value = (a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t;
    (_out as unknown as Record<string, number>)[MOTION_CHANNELS[i]] = value;
  }
  return _out;
}
