/**
 * Minecraft-style voxel chunk generator.
 *
 *  1. 2D climate/biome columns come from the shared TerrainGenerator.
 *  2. A 3D density field is evaluated on a coarse 4×4×4 lattice and trilinearly
 *     interpolated (Minecraft samples its noise per "cell" the same way):
 *        density = (surfaceY − y) + overhang noise × jaggedness
 *        caves   = min(density, cheese, spaghetti, noodle)
 *  3. Surface rules per column (top block, filler, terracotta bands, deepslate,
 *     bedrock), sea water above the surface and lava pools deep down.
 *  4. Ore clusters, then "features": trees placed on a jittered grid.
 *  5. Player edits (deltas) are re-applied, then the chunk is meshed.
 */
import { DEFAULT_FRACTAL, Fractal3 } from '../../core/fractal';
import { Noise } from '../../core/noise';
import { deriveSeed, hash2i, hash3i, unit } from '../../core/rng';
import { BIOMES, B, type TreeType } from '../biomes';
import { emptySample, TerrainGenerator } from '../terrain';
import type { TerrainSettings, VoxelSettings } from '../settings';
import {
  AIR,
  BEDROCK,
  COBBLESTONE,
  DEEPSLATE,
  DIRT,
  GRASS,
  ICE,
  LAVA,
  MUD,
  ORES,
  RED_SAND,
  SAND,
  SANDSTONE,
  SNOW,
  STONE,
  TERRACOTTA_BANDS,
  WATER,
  CACTUS,
  blockId,
} from './blocks';
import { meshVoxels, type MeshArrays } from './mesher';

export const CHUNK = 32;
export const MIN_Y = -64;
export const WORLD_TOP = 320;
const GEN_MARGIN = 4;
const GW = CHUNK + GEN_MARGIN * 2;
const LW = GW / 4 + 1;
const C = GW + 1;
/** Width of the block region kept on the main thread (chunk + 1 block margin). */
export const EDIT_W = CHUNK + 2;

export interface VoxelChunkRequest {
  cx: number;
  cz: number;
  /** Player edits overlapping this chunk: [x, y, z, blockId] * n (world coords). */
  edits: Int32Array;
}

export interface VoxelChunkResult {
  cx: number;
  cz: number;
  /** Number of block layers stored, starting at MIN_Y. */
  height: number;
  /** EDIT_W × EDIT_W × height blocks, layout (y · EDIT_W + z) · EDIT_W + x. */
  blocks: Uint8Array;
  opaque: MeshArrays | null;
  water: MeshArrays | null;
  emissive: MeshArrays | null;
  ms: number;
}

const PODZOL = blockId('podzol');
const MYCELIUM = blockId('mycelium');
const SOFT_TOPS = new Set([GRASS, SNOW, PODZOL, MYCELIUM]);

const TREE_BLOCKS: Record<string, { log: number; leaves: number }> = {
  oak: { log: blockId('oak_log'), leaves: blockId('oak_leaves') },
  birch: { log: blockId('birch_log'), leaves: blockId('birch_leaves') },
  spruce: { log: blockId('spruce_log'), leaves: blockId('spruce_leaves') },
  acacia: { log: blockId('acacia_log'), leaves: blockId('acacia_leaves') },
  jungle: { log: blockId('jungle_log'), leaves: blockId('jungle_leaves') },
  darkoak: { log: blockId('dark_oak_log'), leaves: blockId('dark_oak_leaves') },
  palm: { log: blockId('jungle_log'), leaves: blockId('jungle_leaves') },
  shrub: { log: blockId('oak_log'), leaves: blockId('oak_leaves') },
};

export function voxelSeaY(t: TerrainSettings, v: VoxelSettings): number {
  return Math.round(v.seaLevel + t.seaLevel * v.heightScale);
}

export class VoxelGenerator {
  readonly terrain: TerrainGenerator;
  private readonly overhang: Fractal3 | null;
  private readonly cheese: Fractal3 | null;
  private readonly spag: [Noise, Noise];
  private readonly noodle: [Noise, Noise];
  private readonly seed: number;
  readonly seaY: number;

  constructor(
    seedText: string,
    t: TerrainSettings,
    private readonly v: VoxelSettings,
  ) {
    this.terrain = new TerrainGenerator(seedText, t);
    this.seed = deriveSeed(this.terrain.seed, 300);
    const s = this.seed;
    this.overhang = v.overhangs.enabled
      ? new Fractal3(deriveSeed(s, 1), { ...DEFAULT_FRACTAL, scale: v.overhangs.scale, octaves: v.overhangs.octaves })
      : null;
    this.cheese = v.caves.cheese.enabled
      ? new Fractal3(deriveSeed(s, 2), { ...DEFAULT_FRACTAL, scale: v.caves.cheese.scale, octaves: 2 })
      : null;
    this.spag = [new Noise(deriveSeed(s, 3)), new Noise(deriveSeed(s, 4))];
    this.noodle = [new Noise(deriveSeed(s, 5)), new Noise(deriveSeed(s, 6))];
    this.seaY = voxelSeaY(t, v);
  }

  /** Surface height in blocks for a column (ignores 3D overhangs and caves). */
  surfaceY(x: number, z: number): number {
    return this.v.seaLevel + this.terrain.height(x, z) * this.v.heightScale;
  }

  private density(wx: number, wy: number, wz: number, sy: number, jag: number): number {
    const v = this.v;
    let d = sy - wy;
    if (this.overhang && Math.abs(d) < v.overhangs.strength * 1.25) {
      d += this.overhang.sample(wx, wy * 1.2, wz) * v.overhangs.strength * jag;
    }
    if (d <= 0) return d;
    const depth = sy - wy;
    const protect = Math.max(0, v.caves.surfaceDepth - depth) * 4;
    const seabed = sy < this.seaY + 3 ? Math.max(0, 9 - depth) * 8 : 0;

    if (this.cheese) {
      const c = this.cheese.sample(wx, wy * v.caves.cheese.stretch, wz);
      const cd = (v.caves.cheese.threshold - c) * 64 + protect + seabed;
      if (cd < d) d = cd;
    }
    if (v.caves.spaghetti.enabled) {
      const k = 1 / v.caves.spaghetti.scale;
      const a = this.spag[0].simplex3(wx * k, wy * k * 1.6, wz * k);
      const b = this.spag[1].simplex3(wx * k, wy * k * 1.6, wz * k);
      const sd = (Math.max(Math.abs(a), Math.abs(b)) - v.caves.spaghetti.radius) * 160 + (v.caves.entrances ? 0 : protect) + seabed;
      if (sd < d) d = sd;
    }
    if (v.caves.noodle.enabled && depth > 6) {
      const k = 1 / v.caves.noodle.scale;
      const a = this.noodle[0].simplex3(wx * k, wy * k, wz * k);
      const b = this.noodle[1].simplex3(wx * k, wy * k, wz * k);
      const nd = (Math.max(Math.abs(a), Math.abs(b)) - v.caves.noodle.radius) * 220 + protect + seabed;
      if (nd < d) d = nd;
    }
    return d;
  }

  generate(req: VoxelChunkRequest): VoxelChunkResult {
    const start = performance.now();
    const v = this.v;
    const X0 = req.cx * CHUNK - GEN_MARGIN;
    const Z0 = req.cz * CHUNK - GEN_MARGIN;
    const seaY = this.seaY;

    // 1) Columns.
    const surf = new Float32Array(C * C);
    const jag = new Float32Array(C * C);
    const biome = new Uint8Array(C * C);
    const smp = emptySample();
    let maxSurf = -Infinity;
    for (let z = 0; z < C; z++) {
      for (let x = 0; x < C; x++) {
        this.terrain.sample(X0 + x, Z0 + z, smp);
        const i = z * C + x;
        const sy = v.seaLevel + smp.height * v.heightScale;
        surf[i] = sy;
        jag[i] = 0.3 + 0.7 * smp.mountain;
        biome[i] = smp.biome;
        if (sy > maxSurf) maxSurf = sy;
      }
    }

    // 2) Vertical extent of this chunk.
    const overhangReach = this.overhang ? v.overhangs.strength : 0;
    const top = Math.min(WORLD_TOP, Math.ceil(Math.max(maxSurf + overhangReach, seaY) + 16));
    const H = Math.max(8, Math.ceil((top - MIN_Y) / 4) * 4);
    const LH = H / 4 + 1;

    // 3) Coarse density lattice.
    const lat = new Float32Array(LH * LW * LW);
    for (let ly = 0; ly < LH; ly++) {
      const wy = MIN_Y + ly * 4;
      for (let lz = 0; lz < LW; lz++) {
        for (let lx = 0; lx < LW; lx++) {
          const ci = lz * 4 * C + lx * 4;
          lat[(ly * LW + lz) * LW + lx] = this.density(X0 + lx * 4, wy, Z0 + lz * 4, surf[ci], jag[ci]);
        }
      }
    }

    // 4) Interpolate to blocks.
    const blocks = new Uint8Array(GW * GW * H);
    for (let y = 0; y < H; y++) {
      const ly = y >> 2;
      const fy = (y & 3) * 0.25;
      for (let z = 0; z < GW; z++) {
        const lz = z >> 2;
        const fz = (z & 3) * 0.25;
        const r00 = (ly * LW + lz) * LW;
        const r01 = (ly * LW + lz + 1) * LW;
        const r10 = ((ly + 1) * LW + lz) * LW;
        const r11 = ((ly + 1) * LW + lz + 1) * LW;
        for (let x = 0; x < GW; x++) {
          const lx = x >> 2;
          const fx = (x & 3) * 0.25;
          const a = lat[r00 + lx] + (lat[r00 + lx + 1] - lat[r00 + lx]) * fx;
          const b = lat[r01 + lx] + (lat[r01 + lx + 1] - lat[r01 + lx]) * fx;
          const c = lat[r10 + lx] + (lat[r10 + lx + 1] - lat[r10 + lx]) * fx;
          const d = lat[r11 + lx] + (lat[r11 + lx + 1] - lat[r11 + lx]) * fx;
          const lo = a + (b - a) * fz;
          const hi = c + (d - c) * fz;
          if (lo + (hi - lo) * fy > 0) blocks[(y * GW + z) * GW + x] = STONE;
        }
      }
    }

    // 5) Surface rules, water and lava.
    for (let z = 0; z < GW; z++) {
      for (let x = 0; x < GW; x++) {
        const ci = z * C + x;
        const sy = surf[ci];
        const def = BIOMES[biome[ci]];
        const wx = X0 + x;
        const wz = Z0 + z;
        const badlands = biome[ci] === B.BADLANDS;
        let topId = blockId(def.top);
        let fillerId = blockId(def.filler);
        if (def.ocean && sy >= seaY) {
          topId = SAND;
          fillerId = SAND;
        }
        const sx = surf[z * C + Math.min(x + 1, C - 1)] - surf[z * C + Math.max(x - 1, 0)];
        const sz = surf[Math.min(z + 1, C - 1) * C + x] - surf[Math.max(z - 1, 0) * C + x];
        const steep = Math.max(Math.abs(sx), Math.abs(sz)) > 3.2;
        const fillerDepth = 3 + (hash2i(wx, wz, this.seed) & 3);
        let open = true;
        let sawSolid = false;
        let fill = 0;
        for (let y = H - 1; y >= 0; y--) {
          const i = (y * GW + z) * GW + x;
          const wy = MIN_Y + y;
          if (blocks[i] !== AIR) {
            let id = STONE;
            if (wy < MIN_Y + 5 && (wy === MIN_Y || unit(hash3i(wx, wy, wz, this.seed)) < (MIN_Y + 5 - wy) / 5)) {
              id = BEDROCK;
            } else if (open && wy >= sy - 6) {
              if (wy < seaY) {
                id = def.ocean ? topId : SOFT_TOPS.has(topId) ? DIRT : topId === RED_SAND ? SAND : topId;
              } else if (badlands) {
                id = steep ? TERRACOTTA_BANDS[band(wy)] : RED_SAND;
              } else if (steep && (SOFT_TOPS.has(topId) || topId === SAND)) {
                id = topId === SAND ? SANDSTONE : def.snowy ? SNOW : STONE;
              } else {
                id = topId;
              }
              fill = fillerDepth;
            } else if (fill > 0) {
              id = badlands ? TERRACOTTA_BANDS[band(wy)] : steep && fillerId === DIRT ? STONE : fillerId;
              fill--;
            } else if (badlands && wy > seaY && wy > sy - 24) {
              id = TERRACOTTA_BANDS[band(wy)];
            } else if (v.deepslate && wy < 8 && (wy < -8 || unit(hash3i(wx, wy, wz, this.seed + 1)) < (8 - wy) / 16)) {
              id = DEEPSLATE;
            }
            blocks[i] = id;
            open = false;
            sawSolid = true;
          } else {
            if (!sawSolid && wy <= seaY) {
              blocks[i] = wy === seaY && def.snowy ? ICE : WATER;
            } else if (sawSolid && wy <= v.caves.lavaLevel) {
              blocks[i] = LAVA;
            }
            open = true;
            fill = 0;
          }
        }
      }
    }

    // 6) Ore clusters (2×2×2 cells pick one ore type, then a per-block roll shapes the blob).
    if (v.ores.enabled) {
      const total = ORES.reduce((s, o) => s + o.chance, 0) * v.ores.abundance;
      for (let y = 0; y < H; y++) {
        const wy = MIN_Y + y;
        for (let z = 0; z < GW; z++) {
          for (let x = 0; x < GW; x++) {
            const i = (y * GW + z) * GW + x;
            const id = blocks[i];
            if (id !== STONE && id !== DEEPSLATE) continue;
            const wx = X0 + x;
            const wz = Z0 + z;
            let r = unit(hash3i(wx >> 1, wy >> 1, wz >> 1, this.seed + 7)) * 8;
            if (r >= total) continue;
            for (const ore of ORES) {
              r -= ore.chance * v.ores.abundance;
              if (r < 0) {
                if (wy >= ore.minY && wy <= ore.maxY && unit(hash3i(wx, wy, wz, this.seed + 8)) < 0.6) blocks[i] = ore.id;
                break;
              }
            }
          }
        }
      }
    }

    // 7) Trees and other features.
    if (v.trees.enabled && v.trees.density > 0) this.placeTrees(blocks, H, X0, Z0, biome);

    // 8) Player edits.
    for (let k = 0; k + 3 < req.edits.length; k += 4) {
      const x = req.edits[k] - X0;
      const y = req.edits[k + 1] - MIN_Y;
      const z = req.edits[k + 2] - Z0;
      if (x >= 0 && x < GW && z >= 0 && z < GW && y >= 0 && y < H) blocks[(y * GW + z) * GW + x] = req.edits[k + 3];
    }

    // 9) Mesh + keep a 1-block-margin copy for editing / collisions on the main thread.
    const mesh = meshVoxels(blocks, GW, GW, H, GEN_MARGIN, {
      ao: v.ao.enabled,
      aoStrength: v.ao.strength,
      jitter: v.colorJitter,
      worldX: X0,
      worldY: MIN_Y,
      worldZ: Z0,
    });
    const keep = new Uint8Array(EDIT_W * EDIT_W * H);
    const off = GEN_MARGIN - 1;
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < EDIT_W; z++) {
        const src = (y * GW + z + off) * GW + off;
        keep.set(blocks.subarray(src, src + EDIT_W), (y * EDIT_W + z) * EDIT_W);
      }
    }

    return { cx: req.cx, cz: req.cz, height: H, blocks: keep, ...mesh, ms: performance.now() - start };
  }

  private placeTrees(blocks: Uint8Array, H: number, X0: number, Z0: number, biome: Uint8Array): void {
    const cell = 5;
    const seed = deriveSeed(this.seed, 40);
    const gx0 = Math.floor(X0 / cell);
    const gz0 = Math.floor(Z0 / cell);
    const gx1 = Math.floor((X0 + GW - 1) / cell);
    const gz1 = Math.floor((Z0 + GW - 1) / cell);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = gx * cell + Math.floor(unit(hash2i(gx, gz, seed)) * cell);
        const wz = gz * cell + Math.floor(unit(hash2i(gx, gz, seed + 1)) * cell);
        const x = wx - X0;
        const z = wz - Z0;
        if (x < 0 || x >= GW || z < 0 || z >= GW) continue;
        const def = BIOMES[biome[z * C + x]];
        if (def.trees.length === 0) continue;
        const p = def.treeDensity * (cell * cell) / 100 * this.v.trees.density;
        if (unit(hash2i(gx, gz, seed + 2)) >= p) continue;

        // Find the ground: first non-air block from the top.
        let y = H - 1;
        while (y > 0 && blocks[(y * GW + z) * GW + x] === AIR) y--;
        const ground = blocks[(y * GW + z) * GW + x];
        if (y >= H - 2) continue;

        const total = def.trees.reduce((s, t) => s + t.weight, 0);
        let r = unit(hash2i(gx, gz, seed + 3)) * total;
        let type: TreeType = def.trees[0].type;
        for (const t of def.trees) {
          r -= t.weight;
          if (r <= 0) {
            type = t.type;
            break;
          }
        }
        const sandy = ground === SAND || ground === RED_SAND;
        if (type === 'cactus' || type === 'palm') {
          if (!sandy && type === 'cactus') continue;
        } else if (type !== 'boulder' && !(ground === GRASS || ground === DIRT || ground === PODZOL || ground === SNOW || ground === MUD || (sandy && type === 'shrub'))) {
          continue;
        }
        if (ground === WATER || ground === ICE || ground === LAVA) continue;
        this.buildTree(blocks, H, x, y + 1, z, type, hash2i(gx, gz, seed + 4));
      }
    }
  }

  private buildTree(blocks: Uint8Array, H: number, x: number, y: number, z: number, type: TreeType, h: number): void {
    const set = (px: number, py: number, pz: number, id: number, force = false) => {
      if (px < 0 || px >= GW || pz < 0 || pz >= GW || py < 0 || py >= H) return;
      const i = (py * GW + pz) * GW + px;
      if (force || blocks[i] === AIR) blocks[i] = id;
    };
    const rnd = (k: number) => unit(Math.imul(h ^ (k * 0x9e3779b1), 0x85ebca6b) >>> 0);
    const disc = (cy: number, radius: number, leaves: number, cut = true, cx = x, cz = z) => {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (cut && radius > 1 && Math.abs(dx) === radius && Math.abs(dz) === radius && rnd(dx * 7 + dz * 13 + cy) < 0.7) continue;
          if (dx * dx + dz * dz > radius * radius + 1) continue;
          set(cx + dx, cy, cz + dz, leaves);
        }
      }
    };

    switch (type) {
      case 'oak':
      case 'birch':
      case 'jungle': {
        const { log, leaves } = TREE_BLOCKS[type];
        const height = type === 'jungle' ? 8 + Math.floor(rnd(1) * 5) : (type === 'birch' ? 5 : 4) + Math.floor(rnd(1) * 3);
        const topY = y + height - 1;
        disc(topY - 2, type === 'jungle' ? 3 : 2, leaves);
        disc(topY - 1, 2, leaves);
        disc(topY, 1, leaves, false);
        disc(topY + 1, 1, leaves);
        for (let k = 0; k < height; k++) set(x, y + k, z, log, true);
        break;
      }
      case 'darkoak': {
        const { log, leaves } = TREE_BLOCKS.darkoak;
        const height = 6 + Math.floor(rnd(1) * 2);
        const topY = y + height - 1;
        disc(topY - 1, 3, leaves);
        disc(topY, 3, leaves);
        disc(topY + 1, 2, leaves);
        for (let k = 0; k < height; k++) {
          set(x, y + k, z, log, true);
          set(x + 1, y + k, z, log, true);
          set(x, y + k, z + 1, log, true);
          set(x + 1, y + k, z + 1, log, true);
        }
        break;
      }
      case 'spruce': {
        const { log, leaves } = TREE_BLOCKS.spruce;
        const height = 7 + Math.floor(rnd(1) * 4);
        const topY = y + height - 1;
        set(x, topY + 1, z, leaves);
        let radius = 0;
        for (let yy = topY; yy >= y + 2; yy--) {
          disc(yy, radius, leaves, false);
          radius = radius >= 3 || (topY - yy) % 3 === 2 ? Math.max(0, radius - 1) : radius + 1;
        }
        for (let k = 0; k < height; k++) set(x, y + k, z, log, true);
        break;
      }
      case 'acacia': {
        const { log, leaves } = TREE_BLOCKS.acacia;
        const lean = rnd(2) < 0.5 ? 1 : -1;
        const axis = rnd(3) < 0.5;
        let cx = x;
        let cz = z;
        const height = 5 + Math.floor(rnd(1) * 2);
        for (let k = 0; k < height; k++) {
          if (k >= 3) {
            if (axis) cx += lean;
            else cz += lean;
          }
          set(cx, y + k, cz, log, true);
        }
        const topY = y + height - 1;
        disc(topY + 1, 2, leaves, true, cx, cz);
        disc(topY + 2, 1, leaves, false, cx, cz);
        break;
      }
      case 'palm': {
        const { log, leaves } = TREE_BLOCKS.palm;
        const height = 5 + Math.floor(rnd(1) * 3);
        for (let k = 0; k < height; k++) set(x, y + k, z, log, true);
        const topY = y + height;
        set(x, topY, z, leaves);
        for (let k = 1; k <= 3; k++) {
          const dy = k === 3 ? -1 : 0;
          set(x + k, topY + dy, z, leaves);
          set(x - k, topY + dy, z, leaves);
          set(x, topY + dy, z + k, leaves);
          set(x, topY + dy, z - k, leaves);
        }
        break;
      }
      case 'cactus': {
        const height = 1 + Math.floor(rnd(1) * 3);
        for (let k = 0; k < height; k++) set(x, y + k, z, CACTUS, true);
        break;
      }
      case 'shrub': {
        const { log, leaves } = TREE_BLOCKS.shrub;
        set(x, y, z, log, true);
        disc(y, 1, leaves, false);
        set(x, y + 1, z, leaves);
        break;
      }
      case 'boulder': {
        for (let dy = 0; dy < 2; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dy === 1 && (Math.abs(dx) + Math.abs(dz) > 1 || rnd(dx * 3 + dz * 5) < 0.3)) continue;
              set(x + dx, y + dy - 1, z + dz, COBBLESTONE, true);
            }
          }
        }
        break;
      }
    }
  }
}

function band(y: number): number {
  let h = Math.imul(Math.floor(y / 2) | 0, 0x2c1b3c6d);
  h ^= h >>> 13;
  return ((h % TERRACOTTA_BANDS.length) + TERRACOTTA_BANDS.length) % TERRACOTTA_BANDS.length;
}

