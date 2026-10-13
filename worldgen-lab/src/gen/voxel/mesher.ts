/**
 * Face-culling voxel mesher with per-vertex ambient occlusion (the classic
 * 0fps technique: each vertex looks at its two side neighbours and the corner).
 * Produces three meshes: opaque blocks, translucent water and emissive blocks.
 *
 * Arrays are laid out as index = (y · D + z) · W + x. Only columns inside
 * [margin, W - margin) × [margin, D - margin) are meshed; the margin supplies
 * neighbour data so faces and AO are correct at chunk borders.
 */
import { hash3i, unit } from '../../core/rng';
import { AIR, EMISSIVE, FACE_RGB, LAVA, OPAQUE, WATER } from './blocks';

export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface MeshOptions {
  ao: boolean;
  aoStrength: number;
  jitter: number;
  /** World coordinates of array cell (0, 0, 0), for per-block color jitter. */
  worldX: number;
  worldY: number;
  worldZ: number;
}

class Buf {
  pos = new Float32Array(4096);
  nrm = new Float32Array(4096);
  col = new Float32Array(4096);
  idx = new Uint32Array(6144);
  v = 0;
  i = 0;

  reserve(quads: number): void {
    const needV = (this.v + quads * 4) * 3;
    if (needV > this.pos.length) {
      const size = Math.max(needV, this.pos.length * 2);
      this.pos = grow(this.pos, size);
      this.nrm = grow(this.nrm, size);
      this.col = grow(this.col, size);
    }
    const needI = this.i + quads * 6;
    if (needI > this.idx.length) {
      const next = new Uint32Array(Math.max(needI, this.idx.length * 2));
      next.set(this.idx);
      this.idx = next;
    }
  }

  result(): MeshArrays | null {
    if (this.i === 0) return null;
    return {
      positions: this.pos.slice(0, this.v * 3),
      normals: this.nrm.slice(0, this.v * 3),
      colors: this.col.slice(0, this.v * 3),
      indices: this.idx.slice(0, this.i),
    };
  }
}

function grow(a: Float32Array, size: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(size);
  next.set(a);
  return next;
}

// Face table: normal, the 4 corners (counter-clockwise seen from outside) and color group.
const FACES: { n: [number, number, number]; c: [number, number, number][]; g: number }[] = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], g: 1 },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], g: 1 },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], g: 0 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], g: 2 },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], g: 1 },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], g: 1 },
];

/** For each face and corner: the (side1, side2, corner) neighbour offsets in the layer in front of the face. */
const AO_OFFSETS: number[][][][] = FACES.map((f) => {
  const axis = f.n.findIndex((v) => v !== 0);
  const tangents = [0, 1, 2].filter((a) => a !== axis);
  return f.c.map((corner) => {
    const s1 = [...f.n];
    const s2 = [...f.n];
    const cc = [...f.n];
    const su = corner[tangents[0]] === 1 ? 1 : -1;
    const sv = corner[tangents[1]] === 1 ? 1 : -1;
    s1[tangents[0]] += su;
    s2[tangents[1]] += sv;
    cc[tangents[0]] += su;
    cc[tangents[1]] += sv;
    return [s1, s2, cc];
  });
});

export function meshVoxels(
  blocks: Uint8Array,
  W: number,
  D: number,
  H: number,
  margin: number,
  opts: MeshOptions,
): { opaque: MeshArrays | null; water: MeshArrays | null; emissive: MeshArrays | null } {
  const opaque = new Buf();
  const water = new Buf();
  const emissive = new Buf();
  const aoLevels = [1 - 0.58 * opts.aoStrength, 1 - 0.38 * opts.aoStrength, 1 - 0.18 * opts.aoStrength, 1];
  const ao = [0, 0, 0, 0];

  const at = (x: number, y: number, z: number): number => {
    if (y >= H) return AIR;
    if (y < 0) return 1; // below the world: treat as solid stone
    return blocks[(y * D + z) * W + x];
  };

  for (let y = 0; y < H; y++) {
    for (let z = margin; z < D - margin; z++) {
      for (let x = margin; x < W - margin; x++) {
        const id = blocks[(y * D + z) * W + x];
        if (id === AIR) continue;
        const isWater = id === WATER;
        const isLava = id === LAVA;
        const buf = isWater ? water : EMISSIVE[id] ? emissive : opaque;
        const jitter =
          opts.jitter > 0 && !isWater
            ? 1 + (unit(hash3i(opts.worldX + x, opts.worldY + y, opts.worldZ + z, 1337)) - 0.5) * 2 * opts.jitter
            : 1;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nb = at(x + face.n[0], y + face.n[1], z + face.n[2]);
          if (isWater) {
            if (nb !== AIR) continue;
          } else if (isLava) {
            if (OPAQUE[nb] || nb === LAVA) continue;
          } else if (OPAQUE[nb]) {
            continue;
          }

          // Water surfaces sit a little lower, like Minecraft's.
          const lowerTop = isWater && at(x, y + 1, z) === AIR ? 0.875 : 1;

          for (let k = 0; k < 4; k++) {
            if (!opts.ao || isWater || EMISSIVE[id]) {
              ao[k] = 3;
              continue;
            }
            const o = AO_OFFSETS[f][k];
            const s1 = OPAQUE[at(x + o[0][0], y + o[0][1], z + o[0][2])];
            const s2 = OPAQUE[at(x + o[1][0], y + o[1][1], z + o[1][2])];
            const c = OPAQUE[at(x + o[2][0], y + o[2][1], z + o[2][2])];
            ao[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + c);
          }

          buf.reserve(1);
          const base = buf.v;
          const ci = id * 9 + face.g * 3;
          for (let k = 0; k < 4; k++) {
            const corner = face.c[k];
            const p = (base + k) * 3;
            buf.pos[p] = x - margin + corner[0];
            buf.pos[p + 1] = y + (corner[1] === 1 ? lowerTop : 0);
            buf.pos[p + 2] = z - margin + corner[2];
            buf.nrm[p] = face.n[0];
            buf.nrm[p + 1] = face.n[1];
            buf.nrm[p + 2] = face.n[2];
            const shade = aoLevels[ao[k]] * jitter;
            buf.col[p] = FACE_RGB[ci] * shade;
            buf.col[p + 1] = FACE_RGB[ci + 1] * shade;
            buf.col[p + 2] = FACE_RGB[ci + 2] * shade;
          }
          buf.v += 4;
          // Split the quad along the darker diagonal to avoid AO anisotropy.
          const ii = buf.i;
          if (ao[0] + ao[2] <= ao[1] + ao[3]) {
            buf.idx[ii] = base;
            buf.idx[ii + 1] = base + 1;
            buf.idx[ii + 2] = base + 2;
            buf.idx[ii + 3] = base;
            buf.idx[ii + 4] = base + 2;
            buf.idx[ii + 5] = base + 3;
          } else {
            buf.idx[ii] = base + 1;
            buf.idx[ii + 1] = base + 2;
            buf.idx[ii + 2] = base + 3;
            buf.idx[ii + 3] = base + 1;
            buf.idx[ii + 4] = base + 3;
            buf.idx[ii + 5] = base;
          }
          buf.i += 6;
        }
      }
    }
  }
  return { opaque: opaque.result(), water: water.result(), emissive: emissive.result() };
}
