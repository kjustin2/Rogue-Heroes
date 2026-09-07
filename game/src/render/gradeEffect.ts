import { Effect, BlendFunction } from "postprocessing";
import { Uniform, Color } from "three";

/**
 * Combined color-grade effect — the cheap ALU work that reads as "graded" instead of "raw
 * Three.js default", all in one pass:
 *  - split-tone: shadows pulled cool, highlights pushed warm (what a LUT bakes)
 *  - mood tint: a subtle push toward a driven color (map weather, victory/defeat)
 *  - saturation nudge (victory blooms warmer, defeat drains)
 *  - stable split-tone and mood controls without screen-space noise
 * Uniforms are damped from Stage.update(); no texture, so it runs on every tier.
 */
const FRAG = /* glsl */ `
uniform vec3 uShadow;
uniform vec3 uHigh;
uniform float uSplit;
uniform vec3 uTint;
uniform float uTintAmt;
uniform float uSat;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Split-tone: lerp a cool→warm multiplier across luminance, then blend in by strength.
  vec3 tone = mix(uShadow, uHigh, smoothstep(0.08, 0.92, l));
  c = mix(c, c * tone, uSplit);
  // Saturation trim/boost around luminance.
  c = mix(vec3(l), c, 1.0 + uSat);
  // Mood / tempo tint — a gentle multiplicative push toward the driven color.
  c = mix(c, c * mix(vec3(1.0), uTint, 0.6), uTintAmt);
  // No screen-space grain/dither here. Even a time-independent UV hash can
  // scintillate through the compositor when geometry or render scale moves by a
  // subpixel; the authored sky gradients are smooth enough without that noise.
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super("GradeEffect", FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ["uShadow", new Uniform(new Color(0.88, 0.95, 1.12))],
        ["uHigh", new Uniform(new Color(1.1, 1.0, 0.88))],
        ["uSplit", new Uniform(0.32)],
        ["uTint", new Uniform(new Color(1, 1, 1))],
        ["uTintAmt", new Uniform(0)],
        ["uSat", new Uniform(0)],
      ]),
    });
  }

  private u(name: string): Uniform {
    return this.uniforms.get(name)!;
  }

  /** Push the grade toward `color` by `amt` (0..1) — sandstorm / ion storm / victory / defeat. */
  setTint(color: Color, amt: number): void {
    (this.u("uTint").value as Color).copy(color);
    this.u("uTintAmt").value = amt;
  }

  /** Extra saturation (+victory) or drain (−defeat). */
  get saturation(): number { return this.u("uSat").value as number; }
  set saturation(v: number) { this.u("uSat").value = v; }
  get tintAmt(): number { return this.u("uTintAmt").value as number; }
}
