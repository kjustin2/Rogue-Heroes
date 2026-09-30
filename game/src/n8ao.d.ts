// n8ao ships no types. Only the surface stage.ts uses.
declare module "n8ao" {
  import type { Camera, Scene } from "three";
  import { Pass } from "postprocessing";
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: Record<string, unknown>;
    setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void;
  }
}
