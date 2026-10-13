/**
 * The river-first world (docs/WATERSHED-MODE.md): an endless ocean with one
 * continent per 64 km region, streamed with the same LOD quadtree as Terrain
 * mode. Rivers and lakes have their own water levels.
 */
import * as THREE from 'three';
import type { App } from '../app/App';
import { BIOMES } from '../gen/biomes';
import { WatershedGenerator, emptyWatershedSample } from '../gen/watershed/watershedGen';
import { createWaterMaterial } from '../engine/shaders';
import { TerrainLod } from './TerrainMode';
import { Vegetation } from './Vegetation';
import type { ProbeInfo, WorldMode } from './Mode';

export class WatershedMode implements WorldMode {
  readonly id = 'watershed' as const;
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  readonly waterMaterial = createWaterMaterial(false, true);
  private readonly lod: TerrainLod;
  private readonly vegetation = new Vegetation();
  private gen: WatershedGenerator;
  private genKey = '';
  private leafKey = '';
  private initialized = false;
  private probeCache: { x: number; z: number; info: ProbeInfo } | null = null;

  constructor(private readonly app: App) {
    this.lod = new TerrainLod(app, this.material, this.waterMaterial, 'watershedNode', () => {
      const vs = app.settings.watershed.verticalScale;
      return [-40 * vs, 700 * vs];
    });
    this.gen = new WatershedGenerator(app.settings.seed, structuredClone(app.settings.watershed));
    this.applyVisual();
  }

  get generator(): WatershedGenerator {
    return this.gen;
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

  /** Looks at the nearest continent from its south-west, high enough to see its rivers. */
  resetCamera(): void {
    const [sx, sz] = this.gen.nearestLand(0, 0);
    const g = Math.max(this.groundAt(sx, sz), this.app.settings.watershed.seaLevel);
    this.app.rig.setPose(new THREE.Vector3(sx - 1400, g + 1100, sz + 1700), new THREE.Vector3(sx, g, sz));
  }

  deactivate(): void {
    this.app.scene.remove(this.lod.group, this.vegetation.group);
    this.lod.clear();
    this.vegetation.clear();
  }

  private syncHooks(): void {
    this.app.rig.hooks = {
      ground: (x, z) => this.groundAt(x, z),
      waterLevel: this.app.settings.watershed.seaLevel,
      waterAt: (x, z) => this.waterAt(x, z),
    };
  }

  groundAt(x: number, z: number): number {
    return this.gen.height(x, z);
  }

  private readonly waterSample = emptyWatershedSample();
  private waterCache = { x: NaN, z: NaN, w: NaN };

  /** Water level under a point (NaN = dry); cached for the rig's repeated queries. */
  waterAt(x: number, z: number): number {
    const c = this.waterCache;
    if (Math.abs(c.x - x) < 0.25 && Math.abs(c.z - z) < 0.25) return c.w;
    const w = this.gen.sample(x, z, this.waterSample).water;
    this.waterCache = { x, z, w };
    return w;
  }

  regenerate(version: number): void {
    const v = this.app.settings.terrainView;
    const key = `${v.nodeResolution}:${v.vertexSpacing}`;
    if (key !== this.leafKey) {
      this.leafKey = key;
      this.lod.clear();
    }
    const w = this.app.settings.watershed;
    const genKey = JSON.stringify([this.app.settings.seed, { ...w, colorMode: '' }]);
    if (genKey !== this.genKey) {
      this.genKey = genKey;
      this.gen = new WatershedGenerator(this.app.settings.seed, structuredClone(w));
      this.waterCache = { x: NaN, z: NaN, w: NaN };
    }
    this.probeCache = null;
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
    const c = this.probeCache;
    if (c && Math.abs(c.x - p.x) < 0.5 && Math.abs(c.z - p.z) < 0.5) return c.info;
    const d = this.gen.describe(p.x, p.z);
    const s = d.sample;
    const rows: [string, string][] = [
      ['Position', `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`],
      ['Region', `${s.regionI}, ${s.regionJ}${s.land ? '' : ' · open sea'}`],
      ['Height', `${s.height.toFixed(1)} m`],
      ['Water', Number.isNaN(s.water) ? 'dry' : `${s.water.toFixed(1)} m${s.lake >= 0 ? ' (lake)' : ''}`],
    ];
    if (s.land) {
      rows.push(
        ['Upstream area', `${s.area.toFixed(s.area < 10 ? 2 : 0)} km²`],
        ['Discharge', `${d.discharge.toFixed(d.discharge < 1 ? 3 : 1)} m³/s`],
        ['Stream order', s.order > 0 ? String(s.order) : '—'],
        ['To river', Number.isFinite(s.dRiver) ? `${s.dRiver.toFixed(0)} m` : '> 300 m'],
        ['Basin mouth', d.mouth ? `${d.mouth[0].toFixed(0)}, ${d.mouth[1].toFixed(0)}` : '—'],
        ['Uplift', s.uplift.toFixed(2)],
      );
    }
    const info = { title: BIOMES[s.biome].name, rows };
    this.probeCache = { x: p.x, z: p.z, info };
    return info;
  }

  stats(): [string, string][] {
    const b = this.gen.lastBuild;
    return [
      ['LOD nodes', `${this.lod.visible.length} visible / ${this.lod.nodeCount} cached`],
      ['Generating', `${this.lod.pendingCount}`],
      ['Vegetation', `${this.vegetation.count.toLocaleString()} instances`],
      ['Region (main)', b ? `${b.ms.toFixed(0)} ms · ${b.land.toLocaleString()} land nodes` : '—'],
      ['Rivers', b ? `${b.reaches} reaches · ${b.riverKm.toFixed(0)} km · order ≤ ${b.maxOrder} · ${b.lakes} lakes` : '—'],
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
