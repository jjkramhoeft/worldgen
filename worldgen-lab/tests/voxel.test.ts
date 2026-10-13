import { describe, expect, it } from 'vitest';
import { CHUNK, EDIT_W, MIN_Y, VoxelGenerator, type VoxelChunkResult } from '../src/gen/voxel/voxelGen';
import { AIR, LAVA } from '../src/gen/voxel/blocks';
import { defaultTerrain, defaultVoxel } from '../src/gen/settings';

const NO_EDITS = new Int32Array(0);

/** Block id at world (wx, wy, wz) from a chunk result (chunk columns plus a 1-block margin). */
function blockAt(r: VoxelChunkResult, wx: number, wy: number, wz: number): number {
  const x = wx - r.cx * CHUNK + 1;
  const z = wz - r.cz * CHUNK + 1;
  return r.blocks[((wy - MIN_Y) * EDIT_W + z) * EDIT_W + x];
}

describe('voxel generator', () => {
  it('keeps thin noodle caves that are narrower than the density lattice', () => {
    // Only noodles carve, so every air block well below the surface is a noodle.
    const v = defaultVoxel();
    v.overhangs.enabled = false;
    v.caves.cheese.enabled = false;
    v.caves.spaghetti.enabled = false;
    v.ores.enabled = false;
    v.trees.enabled = false;
    const gen = new VoxelGenerator('noodles', defaultTerrain(), v);
    let generated = 0;
    let exact = 0;
    for (const [cx, cz] of [[0, 0], [3, -2], [-5, 4], [7, 7]]) {
      const r = gen.generate({ cx, cz, edits: NO_EDITS });
      for (let wz = cz * CHUNK; wz < (cz + 1) * CHUNK; wz++) {
        for (let wx = cx * CHUNK; wx < (cx + 1) * CHUNK; wx++) {
          const sy = gen.surfaceY(wx, wz);
          for (let wy = MIN_Y; wy < MIN_Y + r.height && sy - wy > 12; wy++) {
            const id = blockAt(r, wx, wy, wz);
            if (id === AIR || id === LAVA) generated++;
            if (gen.isNoodle(wx, wy, wz)) exact++;
          }
        }
      }
    }
    expect(exact).toBeGreaterThan(1000);
    // Evaluating abs() and max() on the lattice kept only 10–18 % of this volume.
    expect(generated / exact).toBeGreaterThan(0.85);
    expect(generated / exact).toBeLessThan(1.15);
  });

  it('generates identical blocks where neighbouring chunks overlap', () => {
    const gen = new VoxelGenerator('seams', defaultTerrain(), defaultVoxel());
    const a = gen.generate({ cx: 2, cz: -1, edits: NO_EDITS });
    const b = gen.generate({ cx: 3, cz: -1, edits: NO_EDITS });
    const height = Math.min(a.height, b.height);
    let compared = 0;
    // The two columns of world x where chunk a's margin meets chunk b's first column, and vice versa.
    for (const wx of [3 * CHUNK - 1, 3 * CHUNK]) {
      for (let wz = -CHUNK - 1; wz <= 0; wz++) {
        for (let wy = MIN_Y; wy < MIN_Y + height; wy++) {
          expect(blockAt(a, wx, wy, wz), `block ${wx}, ${wy}, ${wz}`).toBe(blockAt(b, wx, wy, wz));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
