/**
 * Instanced low-poly trees, cacti, shrubs and boulders. Instances come from
 * the worker (placed on a jittered grid with biome densities) and are rebuilt
 * whenever the set of visible terrain nodes changes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TREE_TYPES } from '../gen/biomes';
import { VEG_STRIDE } from '../gen/terrainMesh';

function part(geo: THREE.BufferGeometry, color: string, y: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.scale(sx, sy, sz);
  g.translate(0, y, 0);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

function treeGeometry(type: string): THREE.BufferGeometry {
  const bark = '#6a4f32';
  switch (type) {
    case 'oak':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6), bark, 1.6),
        part(new THREE.IcosahedronGeometry(2.3, 1), '#3f7f2c', 4.4, 1, 0.85, 1),
      ])!;
    case 'birch':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.18, 0.24, 4.2, 6), '#ddd8cc', 2.1),
        part(new THREE.IcosahedronGeometry(1.8, 1), '#6a9a40', 5.0, 1, 1.15, 1),
      ])!;
    case 'spruce':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.2, 0.3, 2.2, 6), '#4a3622', 1.1),
        part(new THREE.ConeGeometry(2.3, 3.4, 7), '#2f5a3a', 3.2),
        part(new THREE.ConeGeometry(1.75, 3.0, 7), '#335f3e', 5.0),
        part(new THREE.ConeGeometry(1.1, 2.4, 7), '#386544', 6.6),
      ])!;
    case 'acacia':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.2, 0.3, 3.6, 5), '#6e5c48', 1.8),
        part(new THREE.CylinderGeometry(3.0, 2.4, 0.8, 8), '#6d9432', 3.9),
      ])!;
    case 'jungle':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.35, 0.55, 7.5, 6), '#57451c', 3.75),
        part(new THREE.IcosahedronGeometry(3.3, 1), '#3c952a', 8.0, 1, 0.7, 1),
      ])!;
    case 'darkoak':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.45, 0.62, 3.6, 6), '#3e2a14', 1.8),
        part(new THREE.IcosahedronGeometry(3.0, 1), '#2f6122', 4.8, 1.25, 0.75, 1.25),
      ])!;
    case 'cactus':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.34, 0.36, 2.8, 8), '#4f8f2f', 1.4),
        part(new THREE.CylinderGeometry(0.2, 0.2, 1.0, 6), '#4f8f2f', 1.9, 1, 1, 1).translate(0.55, 0, 0),
      ])!;
    case 'shrub':
      return part(new THREE.IcosahedronGeometry(0.85, 0), '#4f7f2c', 0.45, 1, 0.75, 1);
    case 'boulder':
      return part(new THREE.DodecahedronGeometry(1.1, 0), '#8a8984', 0.35, 1.1, 0.7, 1);
    case 'palm':
    default: {
      const fronds: THREE.BufferGeometry[] = [part(new THREE.CylinderGeometry(0.18, 0.3, 6, 6), '#7a6440', 3)];
      for (let i = 0; i < 6; i++) {
        const f = part(new THREE.ConeGeometry(0.5, 3.2, 4), '#4a9a30', 0, 1, 1, 0.35);
        f.rotateZ(Math.PI / 2.4);
        f.translate(1.3, 0, 0);
        f.rotateY((i / 6) * Math.PI * 2);
        f.translate(0, 6, 0);
        fronds.push(f);
      }
      return mergeGeometries(fronds)!;
    }
  }
}

export class Vegetation {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  private signature = '';
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private grade = '0:1';
  private readonly baseColors: Float32Array[] = [];
  count = 0;

  constructor() {
    for (const type of TREE_TYPES) {
      const mesh = new THREE.InstancedMesh(treeGeometry(type), this.material, 1024);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.name = `veg-${type}`;
      this.meshes.push(mesh);
      this.baseColors.push((mesh.geometry.attributes.color.array as Float32Array).slice());
      this.group.add(mesh);
    }
  }

  /** Applies the terrain's hue shift / saturation grading to the plant colors (alien palettes). */
  setGrade(hueShift: number, saturation: number): void {
    const key = `${hueShift}:${saturation}`;
    if (key === this.grade) return;
    this.grade = key;
    const a = (hueShift * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const k = (1 - c) / 3;
    const q = Math.sqrt(1 / 3) * s;
    const m = [c + k, k - q, k + q, k + q, c + k, k - q, k - q, k + q, c + k];
    this.meshes.forEach((mesh, t) => {
      const base = this.baseColors[t];
      const attr = mesh.geometry.attributes.color as THREE.BufferAttribute;
      const out = attr.array as Float32Array;
      for (let i = 0; i < base.length; i += 3) {
        const r = base[i], g = base[i + 1], b = base[i + 2];
        let nr = m[0] * r + m[1] * g + m[2] * b;
        let ng = m[3] * r + m[4] * g + m[5] * b;
        let nb = m[6] * r + m[7] * g + m[8] * b;
        const l = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
        nr = l + (nr - l) * saturation;
        ng = l + (ng - l) * saturation;
        nb = l + (nb - l) * saturation;
        out[i] = Math.max(0, nr);
        out[i + 1] = Math.max(0, ng);
        out[i + 2] = Math.max(0, nb);
      }
      attr.needsUpdate = true;
    });
  }

  /** Rebuilds instance buffers when the visible node set or the camera moved enough. */
  update(sources: { veg: Float32Array | null; key: string }[], signature: string, camera: THREE.Vector3, maxDistance: number, enabled: boolean): void {
    this.group.visible = enabled;
    if (!enabled) return;
    const moved = camera.distanceToSquared(this.lastCam) > (maxDistance * 0.08) ** 2;
    if (signature === this.signature && !moved) return;
    this.signature = signature;
    this.lastCam.copy(camera);

    const counts = new Array<number>(TREE_TYPES.length).fill(0);
    const max2 = maxDistance * maxDistance;
    for (const s of sources) {
      const v = s.veg;
      if (!v) continue;
      for (let i = 0; i < v.length; i += VEG_STRIDE) {
        const dx = v[i] - camera.x;
        const dz = v[i + 2] - camera.z;
        if (dx * dx + dz * dz < max2) counts[v[i + 3]]++;
      }
    }
    counts.forEach((n, t) => this.ensureCapacity(t, n));

    const fill = new Array<number>(TREE_TYPES.length).fill(0);
    const color = new THREE.Color();
    for (const s of sources) {
      const v = s.veg;
      if (!v) continue;
      for (let i = 0; i < v.length; i += VEG_STRIDE) {
        const dx = v[i] - camera.x;
        const dz = v[i + 2] - camera.z;
        if (dx * dx + dz * dz >= max2) continue;
        const t = v[i + 3];
        const mesh = this.meshes[t];
        const k = fill[t]++;
        const sc = v[i + 4];
        const c = Math.cos(v[i + 5]) * sc;
        const sn = Math.sin(v[i + 5]) * sc;
        const m = mesh.instanceMatrix.array as Float32Array;
        const o = k * 16;
        m[o] = c; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = sc; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
        m[o + 12] = v[i]; m[o + 13] = v[i + 1] - 0.25; m[o + 14] = v[i + 2]; m[o + 15] = 1;
        const tint = 0.82 + ((v[i + 5] * 7.13) % 0.36);
        color.setRGB(tint, tint + ((sc * 3.7) % 0.08), tint * 0.95);
        mesh.setColorAt(k, color);
      }
    }
    this.count = 0;
    this.meshes.forEach((mesh, t) => {
      mesh.count = fill[t];
      this.count += fill[t];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  private ensureCapacity(t: number, n: number): void {
    const mesh = this.meshes[t];
    if (n <= mesh.instanceMatrix.count) return;
    const cap = Math.ceil(n * 1.5);
    const next = new THREE.InstancedMesh(mesh.geometry, this.material, cap);
    next.count = 0;
    next.castShadow = true;
    next.receiveShadow = true;
    next.frustumCulled = false;
    next.name = mesh.name;
    this.group.remove(mesh);
    mesh.dispose();
    this.group.add(next);
    this.meshes[t] = next;
  }

  /** Forces a rebuild on the next update. */
  invalidate(): void {
    this.signature = '';
  }

  clear(): void {
    for (const m of this.meshes) m.count = 0;
    this.signature = '';
    this.count = 0;
  }
}
