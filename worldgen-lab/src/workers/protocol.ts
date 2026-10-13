import type { AppSettings, ErosionSettings } from '../gen/settings';
import type { TerrainNodeRequest, TerrainNodeResult } from '../gen/terrainMesh';
import type { MapRequest, MapResult } from '../gen/map';
import type { VoxelChunkRequest, VoxelChunkResult } from '../gen/voxel/voxelGen';
import type { PlanetNodeRequest, PlanetNodeResult } from '../gen/planet/planetMesh';
import type { ErosionSnapshot } from '../gen/erosion';

export interface PlanetMapRequest {
  width: number;
  height: number;
  rowStart: number;
  rowEnd: number;
}

export interface JobPayloads {
  terrainNode: TerrainNodeRequest;
  map: MapRequest;
  voxelChunk: VoxelChunkRequest;
  planetNode: PlanetNodeRequest;
  planetMap: PlanetMapRequest;
}

export interface JobResults {
  terrainNode: TerrainNodeResult;
  map: MapResult;
  voxelChunk: VoxelChunkResult;
  planetNode: PlanetNodeResult;
  planetMap: { pixels: Uint8ClampedArray; rowStart: number; rowEnd: number };
}

export type JobKind = keyof JobPayloads;

export type ToGenWorker =
  | { type: 'settings'; version: number; settings: AppSettings }
  | { type: 'job'; id: number; kind: JobKind; payload: unknown };

export type FromGenWorker =
  | { type: 'result'; id: number; version: number; result: unknown }
  | { type: 'error'; id: number; message: string };

export type ToErosionWorker =
  | { type: 'init'; settings: AppSettings; run: boolean }
  | { type: 'params'; erosion: ErosionSettings }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'step'; droplets: number };

export type FromErosionWorker =
  | { type: 'snapshot'; snapshot: ErosionSnapshot; running: boolean; done: boolean }
  | { type: 'error'; message: string };

/** Collects the ArrayBuffers of all typed arrays in a result so they can be transferred. */
export function collectTransferables(value: unknown, out: Transferable[] = [], seen = new Set<ArrayBufferLike>()): Transferable[] {
  if (!value || typeof value !== 'object') return out;
  if (ArrayBuffer.isView(value)) {
    const buf = value.buffer;
    if (!seen.has(buf) && buf instanceof ArrayBuffer) {
      seen.add(buf);
      out.push(buf);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectTransferables(v, out, seen);
    return out;
  }
  for (const v of Object.values(value)) collectTransferables(v, out, seen);
  return out;
}
