/**
 * Application root: owns the renderer, scene, camera rig, worker pool, the four
 * world modes, the settings object (bound live to the UI) and the frame loop.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { CameraRig } from '../engine/CameraRig';
import { Environment } from '../engine/Environment';
import { WorkerPool } from '../engine/WorkerPool';
import {
  TERRAIN_PRESETS,
  WATERSHED_PRESETS,
  assignDeep,
  decodeShare,
  defaultSettings,
  defaultTerrain,
  defaultTerrainView,
  defaultWatershed,
  encodeShare,
  mergeSettings,
  type AppSettings,
  type ModeId,
} from '../gen/settings';
import { TerrainGenerator, emptySample, type TerrainSample } from '../gen/terrain';
import { PlanetGenerator, emptyPlanetSample, type PlanetSample } from '../gen/planet/planetGen';
import { derivePlanet, systemPlanetCount } from '../gen/planet/universe';
import { ErosionMode } from '../modes/ErosionMode';
import type { WorldMode } from '../modes/Mode';
import { PlanetMode } from '../modes/PlanetMode';
import { TerrainMode } from '../modes/TerrainMode';
import { VoxelMode } from '../modes/VoxelMode';
import { WatershedMode } from '../modes/WatershedMode';
import { BIOMES } from '../gen/biomes';
import { download } from '../ui/dom';
import type { CameraChoice } from '../ui/Toolbar';
import { UI } from '../ui/UI';

export type ChangeScope = 'gen' | 'visual' | 'render' | 'erosion' | 'none';

const STORAGE_KEY = 'worldgen-lab:settings:v1';

const SEED_A = ['amber', 'azure', 'basalt', 'cinder', 'coral', 'dusk', 'ember', 'fern', 'frost', 'glacier', 'granite', 'haze', 'iron', 'jade', 'lunar', 'moss', 'nova', 'opal', 'pine', 'quartz', 'raven', 'sable', 'solar', 'tidal', 'umber', 'velvet', 'willow', 'zephyr'];
const SEED_B = ['vale', 'ridge', 'fjord', 'mesa', 'delta', 'grove', 'peaks', 'reef', 'steppe', 'tundra', 'canyon', 'atoll', 'dunes', 'highlands', 'marsh', 'basin', 'plateau', 'isles'];

interface SavedPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  quaternion: THREE.Quaternion;
  rigMode: AppSettings['camera']['mode'];
}

/** Reads the initial settings: share link (#s=…) → local storage → defaults. */
export async function loadInitialSettings(): Promise<{ settings: AppSettings; source: 'link' | 'storage' | 'default' }> {
  const m = location.hash.match(/[#&]s=([^&]+)/);
  if (m) {
    try {
      return { settings: await decodeShare(m[1]), source: 'link' };
    } catch (e) {
      console.warn('Could not decode share link', e);
    }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { settings: mergeSettings(defaultSettings(), JSON.parse(raw)), source: 'storage' };
  } catch {
    /* storage unavailable or corrupt */
  }
  return { settings: defaultSettings(), source: 'default' };
}

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.5, 10000);
  readonly env: Environment;
  readonly rig: CameraRig;
  readonly pool = new WorkerPool();
  readonly modes: { terrain: TerrainMode; watershed: WatershedMode; voxel: VoxelMode; planet: PlanetMode; erosion: ErosionMode };
  mode: WorldMode;
  ui: UI;
  genVersion = 1;
  time = 0;
  private readonly timer = new THREE.Timer();
  private regenTimer = 0;
  private saveTimer = 0;
  private lastSeed: string;
  private readonly seedHistory: string[] = [];
  private readonly poses: Partial<Record<ModeId, SavedPose>> = {};
  private pixelRatio = 0;
  private probeTerrain: { version: number; gen: TerrainGenerator } | null = null;
  private probePlanet: { version: number; gen: PlanetGenerator } | null = null;
  private readonly terrainSample = emptySample();
  private readonly planetSample = emptyPlanetSample();
  private lastPanelRefresh = 0;

  constructor(
    readonly container: HTMLElement,
    readonly settings: AppSettings,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral (Khronos PBR) tone mapping keeps biome colors close to their sRGB values.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const canvas = this.renderer.domElement;
    canvas.id = 'view';
    canvas.tabIndex = 0;
    container.append(canvas);

    this.env = new Environment(this.scene);
    this.rig = new CameraRig(this.camera, canvas, () => this.settings.camera);
    this.lastSeed = settings.seed;

    this.pool.setSettings(this.settings, this.genVersion);
    this.modes = {
      terrain: new TerrainMode(this),
      watershed: new WatershedMode(this),
      voxel: new VoxelMode(this),
      planet: new PlanetMode(this),
      erosion: new ErosionMode(this),
    };
    this.mode = this.modes[settings.mode];
    this.ui = new UI(this);
    if (settings.mode === 'planet' && settings.planet.derivedSeed !== settings.seed) this.derivePlanetQuiet();

    this.mode.regenerate(this.genVersion);
    this.mode.applyVisual();
    this.mode.activate();
    this.ui.onModeChanged();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.timer.connect(document);
    this.renderer.setAnimationLoop(this.frame);
  }

  // ───────────────────────────── settings flow ─────────────────────────────

  /** Called by the UI whenever a setting changes. `final` is false while a slider is being dragged. */
  changed(scope: ChangeScope, final = true): void {
    if (this.settings.seed !== this.lastSeed) {
      this.seedHistory.push(this.lastSeed);
      this.lastSeed = this.settings.seed;
      if (this.settings.mode === 'planet') {
        this.derivePlanet();
        return;
      }
      scope = 'gen';
    }
    switch (scope) {
      case 'gen':
        window.clearTimeout(this.regenTimer);
        this.regenTimer = window.setTimeout(() => this.regenerateNow(), final ? 20 : 140);
        break;
      case 'visual':
        this.mode.applyVisual();
        break;
      case 'erosion':
        this.modes.erosion.updateParams();
        break;
      default:
        break;
    }
    this.scheduleSave();
  }

  /** Publishes the current settings to the workers and regenerates the active world. */
  regenerateNow(): void {
    window.clearTimeout(this.regenTimer);
    this.genVersion++;
    this.pool.setSettings(this.settings, this.genVersion);
    this.mode.regenerate(this.genVersion);
    this.ui.onRegenerated();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch {
        /* storage unavailable */
      }
    }, 600);
  }

  /** Replaces all settings in place (UI bindings keep pointing at the same objects). */
  replaceSettings(next: AppSettings): void {
    const mode = next.mode;
    assignDeep(this.settings, next);
    this.lastSeed = this.settings.seed;
    this.ui.panel.refresh();
    if (mode !== this.mode.id) this.setMode(mode);
    this.regenerateNow();
  }

  // ───────────────────────────── modes & camera ─────────────────────────────

  setMode(id: ModeId): void {
    if (this.mode.id === id) return;
    this.poses[this.mode.id] = {
      position: this.camera.position.clone(),
      target: this.rig.orbit.target.clone(),
      quaternion: this.camera.quaternion.clone(),
      rigMode: this.rig.mode,
    };
    this.mode.deactivate();
    this.settings.mode = id;
    this.mode = this.modes[id];
    this.rig.hooks = {};
    this.rig.orbit.autoRotate = false;
    this.rig.autopilot = false;
    if (id !== 'planet') {
      this.rig.orbit.enableZoom = true;
      this.rig.orbit.enablePan = true;
      this.rig.orbit.maxPolarAngle = Math.PI * 0.495;
      this.rig.orbit.rotateSpeed = 1;
    }
    if (id === 'planet' && this.rig.mode === 'walk') this.rig.setMode('orbit');

    if (id === 'planet' && this.settings.planet.derivedSeed !== this.settings.seed) this.derivePlanetQuiet();
    if (id === 'erosion' && !this.poses.erosion && this.settings.erosion.centerX === 0 && this.settings.erosion.centerZ === 0) {
      this.findRuggedErosionRegion();
    }
    this.mode.regenerate(this.genVersion);
    this.mode.applyVisual();
    this.mode.activate();

    const pose = this.poses[id];
    if (pose) {
      this.rig.setMode(pose.rigMode);
      this.rig.setPose(pose.position, pose.target);
      if (pose.rigMode !== 'orbit') {
        this.camera.quaternion.copy(pose.quaternion);
        this.rig.setMode('orbit');
        this.rig.setMode(pose.rigMode);
      }
    } else if (this.rig.mode !== 'orbit') {
      this.rig.setMode('orbit');
    }
    this.ui.onModeChanged();
    this.scheduleSave();
  }

  cameraChoice(): CameraChoice {
    if (this.rig.autopilot || (this.settings.mode === 'planet' && this.rig.orbit.autoRotate)) return 'tour';
    return this.rig.mode;
  }

  setCameraChoice(choice: CameraChoice): void {
    const planet = this.settings.mode === 'planet';
    if (choice === 'walk' && planet) return;
    this.rig.orbit.autoRotate = false;
    if (choice === 'tour') {
      if (planet) {
        this.rig.setMode('orbit');
        this.rig.orbit.autoRotate = true;
        this.rig.orbit.autoRotateSpeed = 0.8;
      } else {
        this.rig.setMode('fly');
        this.rig.autopilot = true;
        this.ui.toasts.show('Autopilot on — press F (or T) to take control');
      }
    } else {
      this.rig.setMode(choice);
      if (choice !== 'orbit') this.ui.toasts.show('Click the view to capture the mouse · Esc releases it');
    }
    this.settings.camera.mode = this.rig.mode;
    this.ui.toolbar.sync(this.ui.splines.isOpen);
  }

  resetCamera(): void {
    const m = this.mode as WorldMode & { resetCamera?: () => void };
    this.rig.setMode('orbit');
    m.resetCamera?.();
  }

  focusXZ(): [number, number] {
    const p = this.rig.mode === 'orbit' ? this.rig.orbit.target : this.camera.position;
    return [p.x, p.z];
  }

  // ───────────────────────────── seeds, presets, planets ─────────────────────────────

  randomSeed(): void {
    const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    this.settings.seed = `${pick(SEED_A)}-${pick(SEED_B)}-${Math.floor(Math.random() * 1000)}`;
    this.ui.panel.refresh();
    this.changed('gen');
    this.ui.toasts.show(`Seed: ${this.settings.seed}`);
  }

  previousSeed(): void {
    const prev = this.seedHistory.pop();
    if (prev === undefined) {
      this.ui.toasts.show('No previous seed');
      return;
    }
    this.settings.seed = prev;
    this.lastSeed = prev;
    this.ui.panel.refresh();
    if (this.settings.mode === 'planet') this.derivePlanet();
    else this.regenerateNow();
    this.ui.toasts.show(`Seed: ${prev}`);
  }

  applyPreset(index: number): void {
    const preset = TERRAIN_PRESETS[index];
    if (!preset) return;
    const next = structuredClone(this.settings);
    next.terrain = defaultTerrain();
    const dv = defaultTerrainView();
    next.terrainView.hueShift = dv.hueShift;
    next.terrainView.saturation = dv.saturation;
    next.terrainView.water = { ...next.terrainView.water, shallowColor: dv.water.shallowColor, deepColor: dv.water.deepColor };
    preset.apply(next);
    assignDeep(this.settings, next);
    this.ui.panel.refresh();
    this.regenerateNow();
    this.ui.toasts.show(`Preset: ${preset.name}`);
  }

  applyWatershedPreset(index: number): void {
    const preset = WATERSHED_PRESETS[index];
    if (!preset) return;
    const next = structuredClone(this.settings);
    next.watershed = { ...defaultWatershed(), colorMode: this.settings.watershed.colorMode };
    preset.apply(next);
    assignDeep(this.settings, next);
    this.ui.panel.refresh();
    this.regenerateNow();
    this.ui.toasts.show(`Preset: ${preset.name}`);
  }

  /** Re-derives every planet parameter from (seed, region, system, planet). */
  derivePlanet(type?: AppSettings['planet']['type']): void {
    this.derivePlanetQuiet(type);
    this.regenerateNow();
  }

  /** Derives the planet parameters and publishes them to the workers, without regenerating yet. */
  private derivePlanetQuiet(type?: AppSettings['planet']['type']): void {
    const p = structuredClone(this.settings.planet);
    derivePlanet(this.settings.seed, p, type);
    assignDeep(this.settings.planet, p);
    this.ui.panel.refresh();
    this.genVersion++;
    this.pool.setSettings(this.settings, this.genVersion);
  }

  stepPlanet(delta: number): void {
    const p = this.settings.planet;
    const count = systemPlanetCount(this.settings.seed, p.region, p.system);
    p.planet += delta;
    if (p.planet >= count) {
      p.planet = 0;
      p.system = (p.system + 1) % 1000;
    } else if (p.planet < 0) {
      p.system = (p.system + 999) % 1000;
      p.planet = systemPlanetCount(this.settings.seed, p.region, p.system) - 1;
    }
    this.derivePlanet();
    this.ui.toasts.show(`${p.name} — ${p.type} world`);
  }

  randomSystem(): void {
    const p = this.settings.planet;
    const r = () => Math.floor(Math.random() * 41) - 20;
    p.region.x = r();
    p.region.y = r();
    p.region.z = r();
    p.system = Math.floor(Math.random() * 1000);
    p.planet = 0;
    this.derivePlanet();
    this.ui.toasts.show(`${p.name} — ${p.type} world`);
  }

  /**
   * Moves the erosion region to the most rugged land near the current one
   * (largest relief within the region, mostly above sea level).
   */
  findRuggedErosionRegion(): void {
    const e = this.settings.erosion;
    const sea = this.settings.terrain.seaLevel;
    let best = { score: -Infinity, x: e.centerX, z: e.centerZ };
    for (let i = -5; i <= 5; i++) {
      for (let j = -5; j <= 5; j++) {
        const cx = e.centerX + i * e.extent * 0.8;
        const cz = e.centerZ + j * e.extent * 0.8;
        let lo = Infinity;
        let hi = -Infinity;
        let land = 0;
        for (let a = 0; a < 5; a++) {
          for (let b = 0; b < 5; b++) {
            const h = this.sampleTerrain(cx + (a / 4 - 0.5) * e.extent * 0.7, cz + (b / 4 - 0.5) * e.extent * 0.7).height;
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
            if (h > sea) land++;
          }
        }
        const score = hi - lo + land * 4 - Math.hypot(i, j) * 6;
        if (score > best.score) best = { score, x: Math.round(cx), z: Math.round(cz) };
      }
    }
    e.centerX = best.x;
    e.centerZ = best.z;
    this.ui.panel.refresh();
    this.modes.erosion.updateParams();
    this.scheduleSave();
  }

  lookAtPlanetPoint(lat: number, lon: number): void {
    const R = this.settings.planet.radius;
    const dir = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    const dist = Math.max(this.camera.position.length(), R * 1.5);
    this.rig.setMode('orbit');
    this.rig.setPose(dir.multiplyScalar(dist), new THREE.Vector3());
  }

  // ───────────────────────────── sampling helpers ─────────────────────────────

  sampleTerrain(x: number, z: number): TerrainSample {
    if (!this.probeTerrain || this.probeTerrain.version !== this.genVersion) {
      this.probeTerrain = { version: this.genVersion, gen: new TerrainGenerator(this.settings.seed, structuredClone(this.settings.terrain)) };
    }
    return this.probeTerrain.gen.sample(x, z, this.terrainSample);
  }

  /** Text for the world map's "under the cursor" box. */
  mapReadout(x: number, z: number): string {
    if (this.settings.mode === 'watershed') {
      const d = this.modes.watershed.generator.describe(x, z);
      const s = d.sample;
      return (
        `x ${x.toFixed(0)}  z ${z.toFixed(0)}\n` +
        `${BIOMES[s.biome].name}\n` +
        `height      ${s.height.toFixed(1)} m\n` +
        `water       ${Number.isNaN(s.water) ? '—' : `${s.water.toFixed(1)} m${s.lake >= 0 ? ' lake' : ''}`}\n` +
        `region      ${s.regionI}, ${s.regionJ}${s.land ? '' : ' (sea)'}\n` +
        `upstream    ${s.area.toFixed(s.area < 10 ? 2 : 0)} km²\n` +
        `discharge   ${d.discharge.toFixed(d.discharge < 1 ? 3 : 1)} m³/s\n` +
        `order       ${s.order || '—'}`
      );
    }
    const s = this.sampleTerrain(x, z);
    return (
      `x ${x.toFixed(0)}  z ${z.toFixed(0)}\n` +
      `${BIOMES[s.biome].name}\n` +
      `height      ${s.height.toFixed(1)} m\n` +
      `continent.  ${s.continentalness.toFixed(3)}\n` +
      `erosion     ${s.erosion.toFixed(3)}\n` +
      `weird / PV  ${s.weirdness.toFixed(2)} / ${s.pv.toFixed(2)}\n` +
      `temp / hum  ${s.temperature.toFixed(2)} / ${s.humidity.toFixed(2)}`
    );
  }

  samplePlanet(lat: number, lon: number): PlanetSample {
    if (!this.probePlanet || this.probePlanet.version !== this.genVersion) {
      this.probePlanet = { version: this.genVersion, gen: new PlanetGenerator(this.settings.seed, structuredClone(this.settings.planet)) };
    }
    this.probePlanet.gen.sample(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon), this.planetSample);
    return this.planetSample;
  }

  // ───────────────────────────── export & share ─────────────────────────────

  private fileStem(): string {
    return `worldgen-${this.settings.mode}-${this.settings.seed.replace(/[^\w-]+/g, '_')}`;
  }

  screenshot(): void {
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      download(blob, `${this.fileStem()}.png`);
      this.ui.toasts.show('Screenshot saved');
    }, 'image/png');
  }

  exportGlb(): void {
    const obj = this.mode.exportObject?.();
    if (!obj) {
      this.ui.toasts.show('Nothing to export yet', 'error');
      return;
    }
    new GLTFExporter().parse(
      obj,
      (result) => {
        download(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' }), `${this.fileStem()}.glb`);
        this.ui.toasts.show('Mesh exported (.glb)');
      },
      (err) => this.ui.toasts.show(`Export failed: ${String(err)}`, 'error'),
      { binary: true },
    );
  }

  async exportHeightmap(): Promise<void> {
    const mode = this.settings.mode;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    let name = '';
    if (mode === 'erosion') {
      const img = this.modes.erosion.heightmapImage();
      if (!img) return;
      canvas.width = canvas.height = img.size;
      ctx.putImageData(new ImageData(img.pixels, img.size, img.size), 0, 0);
      name = `${this.fileStem()}-heightmap-${img.min.toFixed(0)}_${img.max.toFixed(0)}m.png`;
    } else if (mode === 'planet') {
      const W = 2048;
      const H = 1024;
      canvas.width = W;
      canvas.height = H;
      this.ui.toasts.show('Rendering planet surface map…');
      const strips = await Promise.all(
        Array.from({ length: 8 }, (_, k) => this.pool.run('planetMap', { width: W, height: H, rowStart: (k * H) / 8, rowEnd: ((k + 1) * H) / 8 }, { priority: -30 })),
      );
      for (const s of strips) if (s) ctx.putImageData(new ImageData(new Uint8ClampedArray(s.result.pixels), W, s.result.rowEnd - s.result.rowStart), 0, s.result.rowStart);
      name = `${this.fileStem()}-surface-equirect.png`;
    } else {
      const watershed = mode === 'watershed';
      const N = 1024;
      const scale = watershed ? 16 : 2;
      const [cx, cz] = this.focusXZ();
      const vs = watershed ? this.settings.watershed.verticalScale : this.settings.terrain.verticalScale;
      const minH = (watershed ? -40 : -80) * vs;
      const maxH = (watershed ? 700 : 420) * vs;
      canvas.width = canvas.height = N;
      this.ui.toasts.show('Rendering heightmap…');
      const strips = await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          this.pool.run(
            watershed ? 'watershedMap' : 'map',
            { x0: cx - (N / 2) * scale, z0: cz - (N / 2) * scale, scale, width: N, height: N, rowStart: (k * N) / 8, rowEnd: ((k + 1) * N) / 8, layer: 'heightmap', histograms: false, minH, maxH },
            { priority: -30 },
          ),
        ),
      );
      for (const s of strips) if (s) ctx.putImageData(new ImageData(new Uint8ClampedArray(s.result.pixels), N, s.result.rowEnd - s.result.rowStart), 0, s.result.rowStart);
      name = `${this.fileStem()}-heightmap-${N * scale}m-${minH.toFixed(0)}_${maxH.toFixed(0)}m.png`;
    }
    canvas.toBlob((blob) => {
      if (blob) download(blob, name);
      this.ui.toasts.show('Heightmap saved');
    }, 'image/png');
  }

  async share(): Promise<void> {
    const code = await encodeShare(this.settings);
    const url = `${location.origin}${location.pathname}#s=${code}`;
    history.replaceState(null, '', `#s=${code}`);
    try {
      await navigator.clipboard.writeText(url);
      this.ui.toasts.show('Share link copied to the clipboard');
    } catch {
      this.ui.toasts.show('Share link is in the address bar');
    }
  }

  saveSettingsFile(): void {
    download(new Blob([JSON.stringify(this.settings, null, 2)], { type: 'application/json' }), `${this.fileStem()}-settings.json`);
  }

  loadSettingsFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const next = mergeSettings(defaultSettings(), JSON.parse(await file.text()));
        this.replaceSettings(next);
        this.ui.toasts.show(`Loaded ${file.name}`);
      } catch (e) {
        this.ui.toasts.show(`Could not read settings: ${String(e)}`, 'error');
      }
    });
    input.click();
  }

  resetAll(): void {
    const next = defaultSettings();
    next.mode = this.settings.mode;
    this.replaceSettings(next);
    this.ui.toasts.show('All settings reset to defaults');
  }

  // ───────────────────────────── frame loop ─────────────────────────────

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private readonly frame = (timestamp?: number): void => {
    this.timer.update(timestamp);
    const dt = Math.max(0, Math.min(0.1, this.timer.getDelta()));
    this.time += dt;
    const r = this.settings.render;

    const ratio = Math.min(2, window.devicePixelRatio || 1) * r.renderScale;
    if (Math.abs(ratio - this.pixelRatio) > 1e-3) {
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.resize();
    }
    this.renderer.toneMappingExposure = r.exposure;
    if (this.camera.fov !== r.fov) {
      this.camera.fov = r.fov;
      this.camera.updateProjectionMatrix();
    }
    if (r.dayCycle) {
      r.timeOfDay = (r.timeOfDay + (dt * 24) / Math.max(1, r.dayLength)) % 24;
      if (this.time - this.lastPanelRefresh > 1) {
        this.lastPanelRefresh = this.time;
        this.ui.panel.refresh();
      }
    }

    this.rig.update(dt);
    this.mode.update(dt, this.time);
    this.updateClip();
    if (this.mode.id !== 'planet') {
      const focus = this.rig.mode === 'orbit' ? this.rig.orbit.target : this.camera.position;
      const vs = this.settings.terrain.verticalScale;
      const cloudHeight =
        this.mode.id === 'voxel'
          ? 230
          : this.mode.id === 'erosion'
            ? this.settings.erosion.extent * 1.1
            : this.mode.id === 'watershed'
              ? 950 * this.settings.watershed.verticalScale
              : 520 * vs;
      this.env.update({
        render: r,
        camera: this.camera,
        viewDistance: this.mode.viewDistance(),
        cloudHeight,
        focus,
        shadowRadius: this.mode.id === 'voxel' ? 90 : this.mode.id === 'erosion' ? this.settings.erosion.extent * 0.6 : 260,
        time: this.time,
      });
    }
    this.renderer.render(this.scene, this.camera);
    this.ui.frame(dt);
  };

  private updateClip(): void {
    const custom = (this.mode as WorldMode & { clip?: () => [number, number] }).clip?.();
    const near = custom ? custom[0] : this.rig.mode === 'walk' || this.mode.id === 'voxel' ? 0.1 : 0.5;
    const far = custom ? custom[1] : this.mode.viewDistance() * 1.6 + 1500;
    if (Math.abs(this.camera.near - near) > near * 0.05 || Math.abs(this.camera.far - far) > far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }
}
