/**
 * Erosion lab: a finite heightmap (sampled from the terrain generator) eroded by
 * a droplet simulation in a dedicated worker. Snapshots stream in while it runs,
 * so you can watch valleys, river networks and alluvial fans form.
 */
import * as THREE from 'three';
import type { App } from '../app/App';
import type { ErosionSnapshot } from '../gen/erosion';
import type { FromErosionWorker, ToErosionWorker } from '../workers/protocol';
import { createWaterMaterial } from '../engine/shaders';
import { sharedGridIndex } from './TerrainMode';
import type { ProbeInfo, WorldMode } from './Mode';

export class ErosionMode implements WorldMode {
  readonly id = 'erosion' as const;
  readonly group = new THREE.Group();
  private worker: Worker | null = null;
  private terrain: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  readonly waterMaterial = createWaterMaterial(false);
  private heights: Float32Array | null = null;
  private size = 0;
  private baseKey = '';
  private initialized = false;
  status = { droplets: 0, running: false, done: false, meanChange: 0 };
  /** Called whenever the simulation status changes (for the UI). */
  onStatus: (() => void) | null = null;

  constructor(private readonly app: App) {}

  activate(): void {
    this.app.scene.add(this.group);
    this.app.env.setVisible(true);
    this.app.rig.hooks = {
      ground: (x, z) => this.groundAt(x, z),
      waterLevel: this.app.settings.terrain.seaLevel,
    };
    this.ensureSimulation();
    if (!this.initialized) {
      this.initialized = true;
      this.resetCamera();
    }
  }

  resetCamera(): void {
    const e = this.app.settings.erosion.extent;
    this.app.rig.setPose(new THREE.Vector3(-e * 0.55, e * 0.42, e * 0.62), new THREE.Vector3(0, 30, 0));
  }

  deactivate(): void {
    this.app.scene.remove(this.group);
    this.post({ type: 'pause' });
  }

  private post(msg: ToErosionWorker): void {
    this.worker?.postMessage(msg);
  }

  private key(): string {
    const s = this.app.settings;
    const e = s.erosion;
    return JSON.stringify([s.seed, s.terrain, e.resolution, e.extent, e.centerX, e.centerZ, e.island]);
  }

  /** (Re)starts the simulation if the base terrain changed. */
  private ensureSimulation(force = false): void {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/erosion.worker.ts', import.meta.url), { type: 'module', name: 'erosion' });
      this.worker.onmessage = (e: MessageEvent<FromErosionWorker>) => this.onMessage(e.data);
    }
    const key = this.key();
    if (force || key !== this.baseKey) {
      this.baseKey = key;
      this.post({ type: 'init', settings: structuredClone(this.app.settings), run: this.app.settings.erosion.autoRun });
    } else {
      this.post({ type: 'params', erosion: structuredClone(this.app.settings.erosion) });
    }
  }

  private onMessage(msg: FromErosionWorker): void {
    if (msg.type === 'error') {
      console.error('[erosion]', msg.message);
      return;
    }
    this.status = { droplets: msg.snapshot.droplets, running: msg.running, done: msg.done, meanChange: msg.snapshot.meanChange };
    this.apply(msg.snapshot);
    this.onStatus?.();
  }

  private apply(s: ErosionSnapshot): void {
    const N = s.size;
    const extent = this.app.settings.erosion.extent;
    const hs = this.app.settings.erosion.heightScale;
    const sea = this.app.settings.terrain.seaLevel;
    if (!this.terrain || this.size !== N || this.terrain.userData.extent !== extent) {
      this.disposeMeshes();
      this.size = N;
      const pos = new Float32Array(N * N * 3);
      const wpos = new Float32Array(N * N * 3);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const k = j * N + i;
          const x = (i / (N - 1) - 0.5) * extent;
          const z = (j / (N - 1) - 0.5) * extent;
          pos[k * 3] = wpos[k * 3] = x;
          pos[k * 3 + 2] = wpos[k * 3 + 2] = z;
          wpos[k * 3 + 1] = sea;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * N * 3), 3));
      geo.setIndex(sharedGridIndex(N - 1, false));
      geo.userData.sharedIndex = true;
      this.terrain = new THREE.Mesh(geo, this.material);
      this.terrain.userData.extent = extent;
      this.terrain.receiveShadow = true;
      this.terrain.castShadow = true;
      this.terrain.name = 'terrain';

      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
      wgeo.setAttribute('waterColor', new THREE.BufferAttribute(new Float32Array(N * N * 4), 4));
      wgeo.setIndex(sharedGridIndex(N - 1, false));
      wgeo.userData.sharedIndex = true;
      wgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, sea, 0), extent);
      this.water = new THREE.Mesh(wgeo, this.waterMaterial);
      this.water.renderOrder = 2;
      this.group.add(this.terrain, this.water);
    }
    const geo = this.terrain.geometry;
    const pos = geo.attributes.position.array as Float32Array;
    for (let k = 0; k < N * N; k++) pos[k * 3 + 1] = s.heights[k] * hs;
    (geo.attributes.normal.array as Float32Array).set(s.normals);
    (geo.attributes.color.array as Float32Array).set(s.colors);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeBoundingSphere();
    const wgeo = this.water!.geometry;
    (wgeo.attributes.waterColor.array as Float32Array).set(s.water);
    wgeo.attributes.waterColor.needsUpdate = true;
    this.heights = s.heights;
  }

  private disposeMeshes(): void {
    for (const m of [this.terrain, this.water]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.setIndex(null);
      m.geometry.dispose();
    }
    this.terrain = this.water = null;
  }

  groundAt(x: number, z: number): number {
    const h = this.heights;
    const N = this.size;
    const e = this.app.settings.erosion;
    if (!h || N < 2) return this.app.settings.terrain.seaLevel;
    const u = (x / e.extent + 0.5) * (N - 1);
    const v = (z / e.extent + 0.5) * (N - 1);
    if (u < 0 || v < 0 || u > N - 1 || v > N - 1) return this.app.settings.terrain.seaLevel - 20;
    const i = Math.min(N - 2, Math.floor(u));
    const j = Math.min(N - 2, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const a = h[j * N + i] + (h[j * N + i + 1] - h[j * N + i]) * fu;
    const b = h[(j + 1) * N + i] + (h[(j + 1) * N + i + 1] - h[(j + 1) * N + i]) * fu;
    return (a + (b - a) * fv) * e.heightScale;
  }

  /** Current heightmap as an 8-bit grayscale image (for PNG export). */
  heightmapImage(): { pixels: Uint8ClampedArray<ArrayBuffer>; size: number; min: number; max: number } | null {
    const hgt = this.heights;
    if (!hgt) return null;
    const N = this.size;
    let min = Infinity;
    let max = -Infinity;
    for (const v of hgt) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const pixels = new Uint8ClampedArray(N * N * 4);
    const k = 255 / Math.max(1e-6, max - min);
    for (let i = 0; i < N * N; i++) {
      const g = (hgt[i] - min) * k;
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = g;
      pixels[i * 4 + 3] = 255;
    }
    return { pixels, size: N, min, max };
  }

  // Simulation controls (used by the panel).
  run(): void {
    this.post({ type: 'run' });
  }
  pause(): void {
    this.post({ type: 'pause' });
  }
  step(): void {
    this.post({ type: 'step', droplets: Math.max(2000, this.app.settings.erosion.hydraulic.dropletsPerFrame * 5) });
  }
  reset(): void {
    this.ensureSimulation(true);
  }

  regenerate(): void {
    if (this.app.mode === this) this.ensureSimulation();
  }

  /** Erosion parameters changed (no new base terrain needed). */
  updateParams(): void {
    if (this.app.mode === this) this.ensureSimulation();
  }

  applyVisual(): void {
    this.material.wireframe = this.app.settings.terrainView.wireframe;
  }

  update(_dt: number, time: number): void {
    const env = this.app.env;
    const u = this.waterMaterial.uniforms;
    u.uTime.value = time;
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(env.sunColor).multiplyScalar(env.sunDir.y > 0 ? 1 : 0.15);
    u.uSkyColor.value.copy(env.skyReflection);
    u.uAmbient.value = 0.25 + 0.75 * env.day;
  }

  viewDistance(): number {
    return Math.max(3000, this.app.settings.erosion.extent * 2.2);
  }

  probe(): ProbeInfo {
    const e = this.app.settings.erosion;
    const pct = Math.min(100, (this.status.droplets / e.hydraulic.maxDroplets) * 100);
    return {
      title: this.status.done ? 'Erosion finished' : this.status.running ? 'Eroding…' : 'Paused',
      rows: [
        ['Droplets', `${this.status.droplets.toLocaleString()} / ${e.hydraulic.maxDroplets.toLocaleString()} (${pct.toFixed(0)}%)`],
        ['Mean |Δh|', `${this.status.meanChange.toFixed(2)} m`],
        ['Grid', `${e.resolution}² · ${(e.extent / (e.resolution - 1)).toFixed(1)} m cells`],
        ['Region', `${e.extent} m around (${e.centerX}, ${e.centerZ})`],
      ],
    };
  }

  stats(): [string, string][] {
    return [['Vertices', `${(this.size * this.size).toLocaleString()}`]];
  }

  exportObject(): THREE.Object3D | null {
    if (!this.terrain) return null;
    const m = new THREE.Mesh(this.terrain.geometry.clone(), new THREE.MeshStandardMaterial({ vertexColors: true }));
    return m;
  }
}
