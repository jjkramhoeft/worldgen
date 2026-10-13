import type { ModeId } from '../gen/settings';

export interface ProbeInfo {
  title: string;
  rows: [string, string][];
}

/** One of the four world types. The App owns the renderer, camera and settings. */
export interface WorldMode {
  readonly id: ModeId;
  activate(): void;
  deactivate(): void;
  update(dt: number, time: number): void;
  /** Generation settings changed: regenerate (old meshes stay until replaced). */
  regenerate(version: number): void;
  /** Visual-only settings changed (wireframe, shading, colors handled on the GPU, …). */
  applyVisual(): void;
  probe(): ProbeInfo | null;
  stats(): [string, string][];
  /** Distance at which the world ends (for fog and the far plane). */
  viewDistance(): number;
  /** Ground height at a world position, if the mode has a heightfield. */
  groundAt?(x: number, z: number): number;
  /** Builds a mesh snapshot of what is currently visible (for GLB export). */
  exportObject?(): import('three').Object3D | null;
}
