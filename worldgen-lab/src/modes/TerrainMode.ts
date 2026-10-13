/**
 * Infinite heightmap terrain streamed as a quadtree of LOD nodes around the camera.
 */
import * as THREE from 'three';
import type { App } from '../app/App';
import { BIOMES } from '../gen/biomes';
import { TerrainGenerator, emptySample } from '../gen/terrain';
import { gridIndex, type TerrainNodeResult } from '../gen/terrainMesh';
import { QuadtreeLod, type LodNode } from '../engine/QuadtreeLod';
import { createWaterMaterial } from '../engine/shaders';
import { Vegetation } from './Vegetation';
import type { ProbeInfo, WorldMode } from './Mode';

interface TDesc {
  level: number;
  ix: number;
  iz: number;
  size: number;
}

const indexCache = new Map<string, THREE.BufferAttribute>();
export function sharedGridIndex(res: number, skirt: boolean): THREE.BufferAttribute {
  const key = `${res}:${skirt}`;
  let attr = indexCache.get(key);
  if (!attr) {
    attr = new THREE.BufferAttribute(gridIndex(res, skirt), 1);
    indexCache.set(key, attr);
  }
  return attr;
}

const VEG_MAX_NODE = 256;

class TerrainLod extends QuadtreeLod<TDesc, TerrainNodeResult> {
  constructor(
    private readonly app: App,
    private readonly material: THREE.Material,
    private readonly water: THREE.Material,
  ) {
    super();
  }

  private get view() {
    return this.app.settings.terrainView;
  }

  get leafSize(): number {
    return this.view.nodeResolution * this.view.vertexSpacing;
  }

  get rootLevel(): number {
    return THREE.MathUtils.clamp(Math.ceil(Math.log2(this.view.viewDistance / this.leafSize)) - 1, 1, 12);
  }

  protected roots(): TDesc[] {
    const level = this.rootLevel;
    const size = this.leafSize * 2 ** level;
    const cam = this.app.camera.position;
    const R = this.view.viewDistance;
    const out: TDesc[] = [];
    for (let iz = Math.floor((cam.z - R) / size); iz <= Math.floor((cam.z + R) / size); iz++) {
      for (let ix = Math.floor((cam.x - R) / size); ix <= Math.floor((cam.x + R) / size); ix++) {
        const dx = Math.max(ix * size - cam.x, 0, cam.x - (ix + 1) * size);
        const dz = Math.max(iz * size - cam.z, 0, cam.z - (iz + 1) * size);
        if (dx * dx + dz * dz < R * R) out.push({ level, ix, iz, size });
      }
    }
    return out;
  }

  protected children(d: TDesc): TDesc[] {
    const level = d.level - 1;
    const size = d.size / 2;
    return [
      { level, ix: d.ix * 2, iz: d.iz * 2, size },
      { level, ix: d.ix * 2 + 1, iz: d.iz * 2, size },
      { level, ix: d.ix * 2, iz: d.iz * 2 + 1, size },
      { level, ix: d.ix * 2 + 1, iz: d.iz * 2 + 1, size },
    ];
  }

  protected keyOf(d: TDesc): string {
    return `${d.level}:${d.ix}:${d.iz}`;
  }

  private distance(d: TDesc, node: LodNode<TDesc> | undefined): number {
    const cam = this.app.camera.position;
    const x0 = d.ix * d.size;
    const z0 = d.iz * d.size;
    const vs = this.app.settings.terrain.verticalScale;
    const lo = node && !Number.isNaN(node.minH) ? node.minH : -60 * vs;
    const hi = node && !Number.isNaN(node.maxH) ? node.maxH : 260 * vs;
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + d.size));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + d.size));
    const dy = Math.max(lo - cam.y, 0, cam.y - hi);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  protected shouldSplit(d: TDesc, node: LodNode<TDesc> | undefined): boolean {
    return d.level > 0 && this.distance(d, node) < d.size * this.view.lodFactor;
  }

  protected priority(d: TDesc, node: LodNode<TDesc>): number {
    return this.distance(d, node) / d.size + (node.object ? 4 : 0);
  }

  protected request(d: TDesc, node: LodNode<TDesc>, valid: () => boolean) {
    return this.app.pool.run(
      'terrainNode',
      {
        x0: d.ix * d.size,
        z0: d.iz * d.size,
        size: d.size,
        res: this.view.nodeResolution,
        level: d.level,
        vegetation: d.size <= VEG_MAX_NODE,
      },
      { priority: () => this.priority(d, node), valid },
    );
  }

  protected createObject(d: TDesc, r: TerrainNodeResult, node: LodNode<TDesc>): THREE.Object3D {
    const res = this.view.nodeResolution;
    const group = new THREE.Group();
    group.position.set(d.ix * d.size, 0, d.iz * d.size);
    group.updateMatrix();
    group.matrixAutoUpdate = false;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
    geo.setIndex(sharedGridIndex(res, true));
    geo.userData.sharedIndex = true;
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, r.minY - d.size * 0.1, 0), new THREE.Vector3(d.size, r.maxY, d.size));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.castShadow = d.level <= 2;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'terrain';
    group.add(mesh);

    if (r.water) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(r.water.positions, 3));
      wg.setAttribute('waterColor', new THREE.BufferAttribute(r.water.colors, 4));
      wg.setIndex(sharedGridIndex(res, false));
      wg.userData.sharedIndex = true;
      wg.boundingBox = new THREE.Box3(new THREE.Vector3(0, r.minY, 0), new THREE.Vector3(d.size, this.app.settings.terrain.seaLevel + 1, d.size));
      wg.boundingSphere = wg.boundingBox.getBoundingSphere(new THREE.Sphere());
      const wm = new THREE.Mesh(wg, this.water);
      wm.matrixAutoUpdate = false;
      wm.renderOrder = 2;
      wm.name = 'water';
      group.add(wm);
    }
    node.extra = r.veg;
    node.minH = r.minY;
    node.maxH = r.maxY;
    return group;
  }
}

export class TerrainMode implements WorldMode {
  readonly id = 'terrain' as const;
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  readonly waterMaterial = createWaterMaterial(false);
  private readonly lod: TerrainLod;
  private readonly vegetation = new Vegetation();
  private gen: TerrainGenerator;
  private readonly sample = emptySample();
  private leafKey = '';
  private initialized = false;

  constructor(private readonly app: App) {
    this.lod = new TerrainLod(app, this.material, this.waterMaterial);
    this.gen = new TerrainGenerator(app.settings.seed, app.settings.terrain);
    this.applyVisual();
  }

  activate(): void {
    this.app.scene.add(this.lod.group, this.vegetation.group);
    this.app.env.setVisible(true);
    this.syncHooks();
    if (!this.initialized) {
      this.initialized = true;
      this.resetCamera();
    }
  }

  resetCamera(): void {
    const g = Math.max(this.groundAt(0, 0), this.app.settings.terrain.seaLevel);
    this.app.rig.setPose(new THREE.Vector3(-420, g + 260, 520), new THREE.Vector3(0, g, 0));
  }

  deactivate(): void {
    this.app.scene.remove(this.lod.group, this.vegetation.group);
    this.lod.clear();
    this.vegetation.clear();
  }

  private syncHooks(): void {
    this.app.rig.hooks = {
      ground: (x, z) => this.groundAt(x, z),
      waterLevel: this.app.settings.terrain.seaLevel,
    };
  }

  groundAt(x: number, z: number): number {
    return this.gen.height(x, z);
  }

  regenerate(version: number): void {
    const v = this.app.settings.terrainView;
    const key = `${v.nodeResolution}:${v.vertexSpacing}`;
    if (key !== this.leafKey) {
      this.leafKey = key;
      this.lod.clear();
    }
    this.gen = new TerrainGenerator(this.app.settings.seed, this.app.settings.terrain);
    this.lod.invalidate(version);
    this.vegetation.invalidate();
    this.syncHooks();
  }

  applyVisual(): void {
    const v = this.app.settings.terrainView;
    this.material.wireframe = v.wireframe;
    this.material.flatShading = v.flatShading;
    this.material.needsUpdate = true;
  }

  update(_dt: number, time: number): void {
    this.lod.update();
    const v = this.app.settings.terrainView;
    this.vegetation.setGrade(v.hueShift, v.saturation);
    const sources = this.lod.visible.map((n) => ({ veg: n.extra as Float32Array | null, key: n.key }));
    this.vegetation.update(sources, this.lod.visibleSignature, this.app.camera.position, v.vegetation.distance, v.vegetation.enabled);

    const env = this.app.env;
    const u = this.waterMaterial.uniforms;
    u.uTime.value = time;
    u.uSunDir.value.copy(env.sunDir.y >= 0 ? env.sunDir : env.sun.position.clone().sub(env.sun.target.position).normalize());
    u.uSunColor.value.copy(env.sunColor).multiplyScalar(env.sunDir.y > 0 ? 1 : 0.15);
    u.uSkyColor.value.copy(env.skyReflection);
    u.uAmbient.value = 0.25 + 0.75 * env.day;
  }

  viewDistance(): number {
    return this.app.settings.terrainView.viewDistance;
  }

  probe(): ProbeInfo {
    const p = this.app.rig.mode === 'orbit' ? this.app.rig.orbit.target : this.app.camera.position;
    const s = this.gen.sample(p.x, p.z, this.sample);
    return {
      title: BIOMES[s.biome].name,
      rows: [
        ['Position', `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`],
        ['Height', `${s.height.toFixed(1)} m`],
        ['Continentalness', s.continentalness.toFixed(3)],
        ['Erosion', s.erosion.toFixed(3)],
        ['Weirdness / PV', `${s.weirdness.toFixed(3)} / ${s.pv.toFixed(3)}`],
        ['Temperature', s.temperature.toFixed(3)],
        ['Humidity', s.humidity.toFixed(3)],
        ['River', s.river.toFixed(2)],
      ],
    };
  }

  /** Current climate sample under the probe point (used by the spline editor markers). */
  probeSample() {
    const p = this.app.rig.mode === 'orbit' ? this.app.rig.orbit.target : this.app.camera.position;
    return this.gen.sample(p.x, p.z, this.sample);
  }

  stats(): [string, string][] {
    return [
      ['LOD nodes', `${this.lod.visible.length} visible / ${this.lod.nodeCount} cached`],
      ['Generating', `${this.lod.pendingCount}`],
      ['Vegetation', `${this.vegetation.count.toLocaleString()} instances`],
      ['Leaf size', `${this.lod.leafSize} m · ${this.lod.rootLevel + 1} levels`],
    ];
  }

  exportObject(): THREE.Object3D | null {
    const group = new THREE.Group();
    for (const n of this.lod.visible) {
      if (!n.object) continue;
      const mesh = n.object.children.find((c) => c.name === 'terrain') as THREE.Mesh | undefined;
      if (!mesh) continue;
      const copy = new THREE.Mesh(mesh.geometry.clone(), new THREE.MeshStandardMaterial({ vertexColors: true }));
      copy.position.copy(n.object.position);
      group.add(copy);
    }
    return group.children.length ? group : null;
  }
}
