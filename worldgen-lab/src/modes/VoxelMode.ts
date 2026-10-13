/**
 * Minecraft-style voxel world: 32×32 block chunk columns streamed around the
 * camera, with collision, block picking and editing. Player edits are stored as
 * deltas (like Minecraft and No Man's Sky do) and re-applied whenever a chunk
 * is regenerated — even with different generation settings.
 */
import * as THREE from 'three';
import type { App } from '../app/App';
import { BIOMES } from '../gen/biomes';
import { AIR, BLOCKS, SOLID, WATER, LAVA, blockId } from '../gen/voxel/blocks';
import { CHUNK, EDIT_W, MIN_Y, WORLD_TOP, VoxelGenerator, voxelSeaY, type VoxelChunkResult } from '../gen/voxel/voxelGen';
import { meshVoxels, type MeshArrays } from '../gen/voxel/mesher';
import { emptySample } from '../gen/terrain';
import type { ProbeInfo, WorldMode } from './Mode';

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group | null;
  blocks: Uint8Array | null;
  height: number;
  version: number;
  pending: number;
  dirty: boolean;
}

export const HOTBAR = ['grass', 'dirt', 'stone', 'cobblestone', 'planks', 'oak_log', 'oak_leaves', 'sand', 'glowstone'].map((k) => blockId(k));

export class VoxelMode implements WorldMode {
  readonly id = 'voxel' as const;
  readonly group = new THREE.Group();
  private readonly chunks = new Map<string, Chunk>();
  private readonly opaqueMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly waterMat = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.72, roughness: 0.12, metalness: 0, depthWrite: false });
  private readonly emissiveMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly highlight: THREE.LineSegments;
  private readonly edits = new Map<string, number>();
  private gen: VoxelGenerator;
  private version = 0;
  private initialized = false;
  selected = 0;
  target: { hit: [number, number, number]; normal: [number, number, number]; id: number } | null = null;
  private lastGenMs = 0;

  constructor(private readonly app: App) {
    this.gen = new VoxelGenerator(app.settings.seed, app.settings.terrain, app.settings.voxel);
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this.highlight = new THREE.LineSegments(box, new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.8 }));
    this.highlight.visible = false;
    this.group.add(this.highlight);
    app.renderer.domElement.addEventListener('mousedown', this.onMouseDown);
    app.renderer.domElement.addEventListener('contextmenu', (e) => {
      if (this.app.mode === this) e.preventDefault();
    });
    window.addEventListener('keydown', this.onKey);
  }

  activate(): void {
    this.app.scene.add(this.group);
    this.app.env.setVisible(true);
    this.syncHooks();
    if (!this.initialized) {
      this.initialized = true;
      this.resetCamera();
    }
  }

  resetCamera(): void {
    const sy = Math.max(Math.ceil(this.gen.surfaceY(8, 8)), this.gen.seaY);
    this.app.rig.setPose(new THREE.Vector3(-60, sy + 45, 70), new THREE.Vector3(8, sy, 8));
  }

  deactivate(): void {
    this.app.scene.remove(this.group);
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.highlight.visible = false;
  }

  private syncHooks(): void {
    const v = this.app.settings.voxel;
    this.app.rig.hooks = {
      ground: (x, z) => this.columnTop(x, z),
      waterLevel: voxelSeaY(this.app.settings.terrain, v) + 0.9,
      solid: (x, y, z) => this.isSolid(x, y, z),
    };
  }

  regenerate(version: number): void {
    this.version = version;
    this.gen = new VoxelGenerator(this.app.settings.seed, this.app.settings.terrain, this.app.settings.voxel);
    this.syncHooks();
  }

  applyVisual(): void {
    const w = this.app.settings.voxel.wireframe;
    this.opaqueMat.wireframe = w;
    this.waterMat.wireframe = w;
  }

  viewDistance(): number {
    return (this.app.settings.voxel.viewDistance + 0.5) * CHUNK;
  }

  // ───────────────────────────── streaming ─────────────────────────────

  update(): void {
    const cam = this.app.camera.position;
    const pcx = Math.floor(cam.x / CHUNK);
    const pcz = Math.floor(cam.z / CHUNK);
    const R = this.app.settings.voxel.viewDistance;
    const wanted = new Set<string>();
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = `${cx},${cz}`;
        wanted.add(key);
        let c = this.chunks.get(key);
        if (!c) {
          c = { key, cx, cz, group: null, blocks: null, height: 0, version: -1, pending: -1, dirty: false };
          this.chunks.set(key, c);
        }
        this.ensure(c);
      }
    }
    for (const c of [...this.chunks.values()]) {
      const dx = c.cx - pcx;
      const dz = c.cz - pcz;
      if (!wanted.has(c.key) && dx * dx + dz * dz > (R + 2) * (R + 2)) {
        this.disposeChunk(c);
        this.chunks.delete(c.key);
      }
    }
    for (const c of this.chunks.values()) if (c.dirty) this.remesh(c);
    this.updateTarget();
  }

  private ensure(c: Chunk): void {
    if (c.group && c.version >= this.version) return;
    if (c.pending === this.version) return;
    const version = this.version;
    c.pending = version;
    const cam = this.app.camera.position;
    this.app.pool
      .run(
        'voxelChunk',
        { cx: c.cx, cz: c.cz, edits: this.editsFor(c.cx, c.cz) },
        {
          priority: () => Math.hypot((c.cx + 0.5) * CHUNK - cam.x, (c.cz + 0.5) * CHUNK - cam.z) / CHUNK + (c.group ? 4 : 0),
          valid: () => this.chunks.get(c.key) === c && c.pending === version && this.app.mode === this,
        },
      )
      .then((res) => {
        if (c.pending === version) c.pending = -1;
        if (!res || this.chunks.get(c.key) !== c) return;
        if (c.group && res.version < c.version) return;
        this.applyResult(c, res.result, res.version);
      })
      .catch((e) => {
        c.pending = -1;
        console.error(e);
      });
  }

  private applyResult(c: Chunk, r: VoxelChunkResult, version: number): void {
    this.lastGenMs = this.lastGenMs * 0.8 + r.ms * 0.2;
    c.blocks = r.blocks;
    c.height = r.height;
    c.version = version;
    this.setMeshes(c, r.opaque, r.water, r.emissive);
  }

  private setMeshes(c: Chunk, opaque: MeshArrays | null, water: MeshArrays | null, emissive: MeshArrays | null): void {
    if (c.group) {
      this.group.remove(c.group);
      disposeGroup(c.group);
    }
    const g = new THREE.Group();
    g.position.set(c.cx * CHUNK, MIN_Y, c.cz * CHUNK);
    const add = (m: MeshArrays | null, mat: THREE.Material, name: string, order = 0) => {
      if (!m) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.renderOrder = order;
      mesh.castShadow = name === 'opaque';
      mesh.receiveShadow = true;
      g.add(mesh);
    };
    add(opaque, this.opaqueMat, 'opaque');
    add(water, this.waterMat, 'water', 2);
    add(emissive, this.emissiveMat, 'emissive');
    c.group = g;
    c.dirty = false;
    this.group.add(g);
  }

  private disposeChunk(c: Chunk): void {
    if (c.group) {
      this.group.remove(c.group);
      disposeGroup(c.group);
      c.group = null;
    }
  }

  // ───────────────────────────── blocks ─────────────────────────────

  getBlock(x: number, y: number, z: number): number {
    if (y < MIN_Y) return blockId('bedrock');
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(`${cx},${cz}`);
    if (!c || !c.blocks) return -1;
    const ly = y - MIN_Y;
    if (ly >= c.height) return AIR;
    const lx = x - cx * CHUNK + 1;
    const lz = z - cz * CHUNK + 1;
    return c.blocks[(ly * EDIT_W + lz) * EDIT_W + lx];
  }

  private isSolid(x: number, y: number, z: number): boolean {
    const b = this.getBlock(x, y, z);
    if (b < 0) return y < this.gen.surfaceY(x + 0.5, z + 0.5);
    return SOLID[b] === 1;
  }

  private columnTop(x: number, z: number): number {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const c = this.chunks.get(`${Math.floor(bx / CHUNK)},${Math.floor(bz / CHUNK)}`);
    if (c?.blocks) {
      for (let y = MIN_Y + c.height - 1; y > MIN_Y; y--) {
        const b = this.getBlock(bx, y, bz);
        if (b !== AIR && b !== WATER) return y + 1;
      }
    }
    return this.gen.surfaceY(x, z);
  }

  /** Sets a block, records it as a delta and re-meshes the affected chunks. */
  setBlock(x: number, y: number, z: number, id: number): void {
    if (y <= MIN_Y || y >= WORLD_TOP) return;
    this.edits.set(`${x},${y},${z}`, id);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(`${Math.floor(x / CHUNK) + dx},${Math.floor(z / CHUNK) + dz}`);
        if (!c?.blocks) continue;
        const lx = x - c.cx * CHUNK + 1;
        const lz = z - c.cz * CHUNK + 1;
        if (lx < 0 || lx >= EDIT_W || lz < 0 || lz >= EDIT_W) continue;
        let ly = y - MIN_Y;
        if (ly >= c.height) this.growChunk(c, ly + 4);
        ly = y - MIN_Y;
        c.blocks[(ly * EDIT_W + lz) * EDIT_W + lx] = id;
        c.dirty = true;
      }
    }
  }

  private growChunk(c: Chunk, layers: number): void {
    const H = Math.min(WORLD_TOP - MIN_Y, Math.ceil(layers / 4) * 4);
    if (H <= c.height || !c.blocks) return;
    const next = new Uint8Array(EDIT_W * EDIT_W * H);
    next.set(c.blocks);
    c.blocks = next;
    c.height = H;
  }

  private remesh(c: Chunk): void {
    if (!c.blocks) return;
    const v = this.app.settings.voxel;
    const m = meshVoxels(c.blocks, EDIT_W, EDIT_W, c.height, 1, {
      ao: v.ao.enabled,
      aoStrength: v.ao.strength,
      jitter: v.colorJitter,
      worldX: c.cx * CHUNK - 1,
      worldY: MIN_Y,
      worldZ: c.cz * CHUNK - 1,
    });
    this.setMeshes(c, m.opaque, m.water, m.emissive);
  }

  private editsFor(cx: number, cz: number): Int32Array {
    const out: number[] = [];
    const x0 = cx * CHUNK - 4;
    const z0 = cz * CHUNK - 4;
    for (const [key, id] of this.edits) {
      const [x, y, z] = key.split(',').map(Number);
      if (x >= x0 && x < x0 + CHUNK + 8 && z >= z0 && z < z0 + CHUNK + 8) out.push(x, y, z, id);
    }
    return new Int32Array(out);
  }

  get editCount(): number {
    return this.edits.size;
  }

  clearEdits(): void {
    this.edits.clear();
    this.app.regenerateNow();
  }

  // ───────────────────────────── interaction ─────────────────────────────

  /** Amanatides & Woo voxel traversal from the camera, up to 8 blocks. */
  private updateTarget(): void {
    const rig = this.app.rig;
    const active = rig.mode !== 'orbit';
    this.target = null;
    if (active) {
      const cam = this.app.camera;
      const o = cam.position;
      const d = cam.getWorldDirection(new THREE.Vector3());
      let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
      const stepX = Math.sign(d.x), stepY = Math.sign(d.y), stepZ = Math.sign(d.z);
      const tdx = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
      const tdy = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
      const tdz = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
      let tmx = d.x !== 0 ? (stepX > 0 ? x + 1 - o.x : o.x - x) * tdx : Infinity;
      let tmy = d.y !== 0 ? (stepY > 0 ? y + 1 - o.y : o.y - y) * tdy : Infinity;
      let tmz = d.z !== 0 ? (stepZ > 0 ? z + 1 - o.z : o.z - z) * tdz : Infinity;
      let normal: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < 64; i++) {
        const b = this.getBlock(x, y, z);
        if (b > 0 && b !== WATER && b !== LAVA && i > 0) {
          this.target = { hit: [x, y, z], normal, id: b };
          break;
        }
        if (tmx < tmy && tmx < tmz) {
          if (tmx > 8) break;
          x += stepX;
          tmx += tdx;
          normal = [-stepX, 0, 0];
        } else if (tmy < tmz) {
          if (tmy > 8) break;
          y += stepY;
          tmy += tdy;
          normal = [0, -stepY, 0];
        } else {
          if (tmz > 8) break;
          z += stepZ;
          tmz += tdz;
          normal = [0, 0, -stepZ];
        }
      }
    }
    this.highlight.visible = !!this.target;
    if (this.target) this.highlight.position.set(this.target.hit[0] + 0.5, this.target.hit[1] + 0.5, this.target.hit[2] + 0.5);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (this.app.mode !== this || !this.app.rig.locked || !this.target) return;
    const [x, y, z] = this.target.hit;
    if (e.button === 0) {
      this.setBlock(x, y, z, AIR);
    } else if (e.button === 2) {
      const [nx, ny, nz] = this.target.normal;
      const px = x + nx, py = y + ny, pz = z + nz;
      const cam = this.app.camera.position;
      const feet = cam.y - 1.62;
      const overlaps = px + 1 > cam.x - 0.3 && px < cam.x + 0.3 && pz + 1 > cam.z - 0.3 && pz < cam.z + 0.3 && py + 1 > feet && py < feet + 1.8;
      if (!overlaps || this.app.rig.mode === 'fly') this.setBlock(px, py, pz, HOTBAR[this.selected]);
    } else if (e.button === 1) {
      const i = HOTBAR.indexOf(this.target.id);
      if (i >= 0) this.selected = i;
      e.preventDefault();
    }
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.app.mode !== this) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= HOTBAR.length) this.selected = n - 1;
  };

  // ───────────────────────────── info ─────────────────────────────

  probe(): ProbeInfo {
    const p = this.app.rig.mode === 'orbit' ? this.app.rig.orbit.target : this.app.camera.position;
    const s = this.gen.terrain.sample(p.x, p.z, emptySample());
    const rows: [string, string][] = [
      ['Block pos', `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`],
      ['Chunk', `${Math.floor(p.x / CHUNK)}, ${Math.floor(p.z / CHUNK)}`],
      ['Surface Y', this.gen.surfaceY(p.x, p.z).toFixed(1)],
    ];
    if (this.target) rows.push(['Looking at', `${BLOCKS[this.target.id].name} @ ${this.target.hit.join(', ')}`]);
    rows.push(['Holding', BLOCKS[HOTBAR[this.selected]].name]);
    return { title: BIOMES[s.biome].name, rows };
  }

  stats(): [string, string][] {
    let ready = 0;
    let pending = 0;
    let tris = 0;
    for (const c of this.chunks.values()) {
      if (c.group) ready++;
      if (c.pending >= 0) pending++;
      c.group?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry.index) tris += m.geometry.index.count / 3;
      });
    }
    return [
      ['Chunks', `${ready} loaded · ${pending} generating`],
      ['Chunk gen', `${this.lastGenMs.toFixed(1)} ms (worker)`],
      ['Block faces', Math.round(tris / 2).toLocaleString()],
      ['Edits (deltas)', `${this.edits.size}`],
    ];
  }

  exportObject(): THREE.Object3D | null {
    const group = new THREE.Group();
    const cam = this.app.camera.position;
    for (const c of this.chunks.values()) {
      if (!c.group) continue;
      if (Math.hypot((c.cx + 0.5) * CHUNK - cam.x, (c.cz + 0.5) * CHUNK - cam.z) > 3 * CHUNK) continue;
      const g = c.group.clone();
      group.add(g);
    }
    return group.children.length ? group : null;
  }
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}
