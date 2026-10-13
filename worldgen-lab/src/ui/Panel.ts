/**
 * The settings panel (Tweakpane). Sections are shown or hidden per mode.
 * Every binding reports a change scope to the App:
 *   gen      → regenerate the world (old meshes stay until replaced)
 *   visual   → material-only changes
 *   render   → environment / renderer
 *   erosion  → erosion simulation parameters
 */
import { Pane, type FolderApi, type ListBladeApi, type TabPageApi } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import type { App, ChangeScope } from '../app/App';
import {
  MODES,
  TERRAIN_PRESETS,
  WATERSHED_PRESETS,
  COLOR_MODES,
  WATERSHED_COLOR_MODES,
  PLANET_TYPES,
  type ModeId,
  type ClimateNoise,
  type DetailSettings,
  type PlanetType,
} from '../gen/settings';
import { NOISE_KINDS } from '../core/noise';
import { FRACTAL_KINDS } from '../core/fractal';
import { systemPlanetCount } from '../gen/planet/universe';
import { h } from './dom';

type Container = FolderApi | TabPageApi;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ALL: ModeId[] = ['terrain', 'watershed', 'voxel', 'planet', 'erosion'];
/** Modes built on the Terrain generator. */
const FLAT: ModeId[] = ['terrain', 'voxel', 'erosion'];
/** Modes with a sky over a flat world. */
const SKY: ModeId[] = ['terrain', 'watershed', 'voxel', 'erosion'];
const WS: ModeId[] = ['watershed'];

const opts = <T extends string | number>(values: readonly T[], labels?: Record<string, string>) =>
  Object.fromEntries(values.map((v) => [labels?.[String(v)] ?? String(v), v]));

const NOISE_OPTS = opts(NOISE_KINDS, { simplex: 'Simplex', perlin: 'Perlin', value: 'Value', worley: 'Worley (bumps)', cells: 'Cells (ridges)' });
const FRACTAL_OPTS = opts(FRACTAL_KINDS, {
  fbm: 'fBm',
  billow: 'Billow',
  ridged: 'Ridged multifractal',
  erosion: 'IQ derivative erosion',
  uber: 'Uber noise (NMS-style)',
});

export class Panel {
  readonly root: HTMLElement;
  readonly pane: Pane;
  private readonly sections: { item: { hidden: boolean }; modes: ModeId[] }[] = [];
  private readonly blurb: HTMLElement;
  private readonly title: HTMLElement;
  /** Values shown by read-only monitors. */
  readonly monitor = { planet: '', erosion: '', edits: '0 edited blocks' };

  constructor(private readonly app: App) {
    this.title = h('h2', { text: 'Settings' });
    this.blurb = h('div', { class: 'mode-blurb' });
    const scroll = h('div', { class: 'panel-scroll' });
    this.root = h('aside', { class: 'panel glass ui' }, h('div', { class: 'panel-head' }, this.title), this.blurb, scroll);
    this.pane = new Pane({ container: scroll });
    this.pane.registerPlugin(EssentialsPlugin);

    this.buildHeader();
    this.buildTerrainShape();
    this.buildTerrainView();
    this.buildWatershed();
    this.buildVoxel();
    this.buildPlanet();
    this.buildErosion();
    this.buildEnvironment();
    this.buildExport();
    this.onModeChanged();
  }

  refresh(): void {
    this.pane.refresh();
  }

  onModeChanged(): void {
    const mode = this.app.settings.mode;
    for (const s of this.sections) s.item.hidden = !s.modes.includes(mode);
    const m = MODES.find((x) => x.id === mode)!;
    this.title.textContent = `${m.icon}  ${m.label} settings`;
    this.blurb.textContent = m.blurb;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private folder(parent: Container, title: string, modes: ModeId[] = ALL, expanded = false): FolderApi {
    const f = parent.addFolder({ title, expanded });
    if (modes !== ALL) this.sections.push({ item: f, modes });
    return f;
  }

  private bind(c: Container, obj: object, key: string, params: Record<string, unknown> = {}, scope: ChangeScope = 'gen') {
    const b = c.addBinding(obj as Any, key as Any, params as Any);
    b.on('change', (ev: { last: boolean }) => this.app.changed(scope, ev.last));
    return b;
  }

  private num(c: Container, obj: object, key: string, label: string, min: number, max: number, step: number, scope: ChangeScope = 'gen') {
    return this.bind(c, obj, key, { label, min, max, step }, scope);
  }

  private buttons(c: Container, cells: [string, () => void][], cols = cells.length) {
    const rows = Math.ceil(cells.length / cols);
    const grid = c.addBlade({
      view: 'buttongrid',
      size: [cols, rows],
      cells: (x: number, y: number) => ({ title: cells[y * cols + x]?.[0] ?? '' }),
    } as Any) as Any;
    grid.on('click', (ev: { index: [number, number] }) => cells[ev.index[1] * cols + ev.index[0]]?.[1]());
    return grid;
  }

  private climate(page: Container, n: ClimateNoise, scaleMax: number): void {
    this.bind(page, n, 'noise', { label: 'Noise', options: NOISE_OPTS });
    this.num(page, n, 'scale', 'Wavelength (m)', 50, scaleMax, 10);
    this.num(page, n, 'octaves', 'Octaves', 1, 10, 1);
    this.num(page, n, 'lacunarity', 'Lacunarity', 1.2, 3.5, 0.01);
    this.num(page, n, 'gain', 'Gain', 0.1, 0.9, 0.01);
    this.num(page, n, 'amplitude', 'Contrast', 0.2, 4, 0.01);
    this.num(page, n, 'offset', 'Offset', -1, 1, 0.01);
  }

  // ───────────────────────────── header ─────────────────────────────

  private buildHeader(): void {
    const s = this.app.settings;
    this.bind(this.pane, s, 'seed', { label: 'Seed' });
    this.buttons(this.pane, [
      ['🎲 Random seed', () => this.app.randomSeed()],
      ['◀ Previous', () => this.app.previousSeed()],
      ['⌖ Reset view', () => this.app.resetCamera()],
    ]);
    const presets = this.pane.addBlade({
      view: 'list',
      label: 'Preset',
      options: TERRAIN_PRESETS.map((p, i) => ({ text: p.name, value: i })),
      value: 0,
    }) as ListBladeApi<number>;
    presets.on('change', (ev) => this.app.applyPreset(ev.value));
    this.sections.push({ item: presets, modes: FLAT });
    const wsPresets = this.pane.addBlade({
      view: 'list',
      label: 'Preset',
      options: WATERSHED_PRESETS.map((p, i) => ({ text: p.name, value: i })),
      value: 0,
    }) as ListBladeApi<number>;
    wsPresets.on('change', (ev) => this.app.applyWatershedPreset(ev.value));
    this.sections.push({ item: wsPresets, modes: WS });
  }

  // ───────────────────────────── terrain shape ─────────────────────────────

  private buildTerrainShape(): void {
    const t = this.app.settings.terrain;

    const world = this.folder(this.pane, 'World shape', FLAT, true);
    this.num(world, t, 'horizontalScale', 'Horizontal scale', 0.1, 8, 0.01);
    this.num(world, t, 'verticalScale', 'Vertical scale', 0.1, 4, 0.01);
    this.num(world, t, 'seaLevel', 'Sea level (m)', -60, 120, 0.5);
    this.num(world, t, 'mountainHeight', 'Mountain height (m)', 0, 900, 1);
    this.num(world, t, 'ridgeShare', 'Ridge share', 0, 1, 0.01);
    this.num(world, t, 'redistribution', 'Redistribution exp.', 0.3, 3, 0.01);

    const climate = this.folder(this.pane, 'Climate noise (multi-noise)', FLAT);
    const tabs = climate.addTab({
      pages: [{ title: 'Cont.' }, { title: 'Erosion' }, { title: 'Weird' }, { title: 'Temp' }, { title: 'Humid' }],
    });
    this.climate(tabs.pages[0], t.continentalness, 12000);
    this.climate(tabs.pages[1], t.erosion, 12000);
    this.climate(tabs.pages[2], t.weirdness, 6000);
    this.climate(tabs.pages[3], t.temperature, 16000);
    this.climate(tabs.pages[4], t.humidity, 12000);
    this.buttons(climate, [['Open spline editor (K)', () => this.app.ui.toggleSplines(true)]]);

    const d = t.detail;
    const detail = this.folder(this.pane, 'Detail noise', FLAT);
    this.bind(detail, d, 'fractal', { label: 'Fractal', options: FRACTAL_OPTS });
    this.bind(detail, d, 'noise', { label: 'Noise', options: NOISE_OPTS });
    this.num(detail, d, 'amplitude', 'Amplitude (m)', 0, 300, 0.5);
    this.num(detail, d, 'scale', 'Wavelength (m)', 10, 4000, 1);
    this.num(detail, d, 'octaves', 'Octaves', 1, 12, 1);
    this.num(detail, d, 'lacunarity', 'Lacunarity', 1.3, 3.5, 0.01);
    this.num(detail, d, 'gain', 'Gain', 0.1, 0.9, 0.01);
    this.num(detail, d, 'mountainBias', 'Mountain bias', 0, 1, 0.01);
    const uber = detail.addFolder({ title: 'Uber / erosion parameters', expanded: true });
    this.num(uber, d, 'sharpness', 'Sharp ↔ round', -1, 1, 0.01);
    this.num(uber, d, 'slopeErosion', 'Slope erosion', 0, 3, 0.01);
    this.num(uber, d, 'altitudeErosion', 'Altitude erosion', 0, 1, 0.01);
    this.num(uber, d, 'ridgeErosion', 'Ridge erosion', 0, 1, 0.01);
    this.num(uber, d, 'perturb', 'Perturb features', 0, 2, 0.01);
    this.num(uber, d, 'featureAmp', 'Amplify features', 0, 1.5, 0.01);

    const warp = this.folder(this.pane, 'Domain warp', FLAT);
    this.bind(warp, t.warp, 'enabled', { label: 'Enabled' });
    this.num(warp, t.warp, 'strength', 'Strength (m)', 0, 2500, 1);
    this.num(warp, t.warp, 'scale', 'Wavelength (m)', 100, 8000, 10);
    this.num(warp, t.warp, 'octaves', 'Octaves', 1, 6, 1);
    this.num(warp, t.warp, 'iterations', 'Iterations', 1, 2, 1);

    const rivers = this.folder(this.pane, 'Rivers', FLAT);
    this.bind(rivers, t.rivers, 'enabled', { label: 'Enabled' });
    this.num(rivers, t.rivers, 'width', 'Width', 0.002, 0.15, 0.001);
    this.num(rivers, t.rivers, 'bankWidth', 'Bank width', 0.01, 0.5, 0.005);
    this.num(rivers, t.rivers, 'depth', 'Depth (m)', 0, 30, 0.5);

    const terr = this.folder(this.pane, 'Terraces', FLAT);
    this.bind(terr, t.terraces, 'enabled', { label: 'Enabled' });
    this.num(terr, t.terraces, 'steps', 'Steps', 2, 40, 1);
    this.num(terr, t.terraces, 'smoothness', 'Smoothness', 0.01, 0.5, 0.01);
    this.num(terr, t.terraces, 'strength', 'Strength', 0, 1, 0.01);

    const island = this.folder(this.pane, 'Island mask', FLAT);
    this.bind(island, t.island, 'enabled', { label: 'Enabled' });
    this.bind(island, t.island, 'shape', { label: 'Shape', options: { Circle: 'circle', Square: 'square', 'Square bump': 'bump' } });
    this.num(island, t.island, 'radius', 'Radius (m)', 200, 10000, 10);
    this.num(island, t.island, 'falloff', 'Falloff', 0.05, 1, 0.01);

    const biomes = this.folder(this.pane, 'Biomes', FLAT);
    this.bind(biomes, t.biomes, 'mode', {
      label: 'Classifier',
      options: { 'Minecraft multi-noise': 'minecraft', 'Whittaker (temp × moisture)': 'whittaker', 'Height bands': 'height' },
    });
    this.num(biomes, t.biomes, 'beachHeight', 'Beach height (m)', 0, 15, 0.1);
    this.num(biomes, t.biomes, 'peakHeight', 'Peaks above (m)', 30, 700, 1);
    this.num(biomes, t.biomes, 'snowLine', 'Snow line (m)', 20, 700, 1);
  }

  private buildTerrainView(): void {
    this.heightmapView('Terrain rendering', ['terrain'], this.app.settings.terrainView, COLOR_MODES);
  }

  /** LOD, water, vegetation and colouring of a heightmap world (Terrain and Watershed share `terrainView`). */
  private heightmapView(title: string, modes: ModeId[], colorTarget: object, colors: readonly { value: string; label: string }[]): void {
    const v = this.app.settings.terrainView;
    const f = this.folder(this.pane, title, modes);
    this.bind(f, colorTarget, 'colorMode', { label: 'Color by', options: Object.fromEntries(colors.map((c) => [c.label, c.value])) });
    this.num(f, v, 'viewDistance', 'View distance (m)', 500, 16000, 50);
    this.num(f, v, 'vertexSpacing', 'Finest spacing (m)', 0.25, 8, 0.25);
    this.bind(f, v, 'nodeResolution', { label: 'Node grid', options: { '32²': 32, '48²': 48, '64²': 64, '96²': 96, '128²': 128 } });
    this.num(f, v, 'lodFactor', 'LOD detail', 1, 5, 0.05);
    this.num(f, v, 'hueShift', 'Hue shift (°)', -180, 180, 1);
    this.num(f, v, 'saturation', 'Saturation', 0, 2, 0.01);
    this.bind(f, v, 'flatShading', { label: 'Flat shading' }, 'visual');
    this.bind(f, v, 'wireframe', { label: 'Wireframe' }, 'visual');
    const water = f.addFolder({ title: 'Water', expanded: false });
    this.bind(water, v.water, 'enabled', { label: 'Enabled' });
    this.num(water, v.water, 'opacity', 'Opacity', 0.3, 1, 0.01);
    this.bind(water, v.water, 'shallowColor', { label: 'Shallow', view: 'color' });
    this.bind(water, v.water, 'deepColor', { label: 'Deep', view: 'color' });
    const veg = f.addFolder({ title: 'Vegetation', expanded: false });
    this.bind(veg, v.vegetation, 'enabled', { label: 'Enabled' });
    this.num(veg, v.vegetation, 'density', 'Density', 0, 3, 0.05);
    this.num(veg, v.vegetation, 'distance', 'Draw distance (m)', 100, 2500, 10, 'none');
  }

  // ───────────────────────────── watershed ─────────────────────────────

  private buildWatershed(): void {
    const w = this.app.settings.watershed;

    const world = this.folder(this.pane, 'Continents', WS, true);
    this.bind(world, w.regions, 'size', { label: 'Region size (m)', min: 16000, max: 128000, step: 1000 });
    this.num(world, w.regions, 'landChance', 'Land chance', 0, 1, 0.01);
    this.num(world, w.regions, 'jitter', 'Site jitter', 0, 1, 0.01);
    this.num(world, w.regions, 'warp', 'Border warp (m)', 0, 15000, 100);
    this.num(world, w.regions, 'warpScale', 'Warp wavelength (m)', 5000, 120000, 500);
    this.num(world, w.coast, 'margin', 'Sea margin (m)', 1000, 20000, 100);
    this.num(world, w.coast, 'setback', 'Coast setback (m)', 0, 40000, 100);
    this.num(world, w.coast, 'scale', 'Coast wavelength (m)', 2000, 80000, 500);
    this.num(world, w.coast, 'octaves', 'Coast octaves', 1, 10, 1);
    this.num(world, w.coast, 'sizeVariation', 'Size variation', 0, 1, 0.01);
    this.num(world, w, 'seaLevel', 'Sea level (m)', -50, 50, 0.5);
    this.num(world, w, 'verticalScale', 'Vertical scale', 0.2, 3, 0.01);

    const net = this.folder(this.pane, 'Drainage network', WS, true);
    this.bind(net, w.network, 'grid', { label: 'Grid spacing', options: { '128 m': 128, '192 m': 192, '256 m': 256, '384 m': 384, '512 m': 512 } });
    this.num(net, w.network, 'jitter', 'Growth jitter', 0, 0.9, 0.01);
    this.num(net, w.network, 'mouthBias', 'Mouth bias', 0, 3, 0.01);
    this.num(net, w.climate, 'runoff', 'Runoff (mm/yr)', 20, 2000, 10);
    const rain = net.addFolder({ title: 'Rain noise', expanded: false });
    this.climate(rain, w.climate.rain, 120000);

    const relief = this.folder(this.pane, 'Relief (stream power)', WS);
    this.num(relief, w.relief, 'k', 'Slope constant k', 0.005, 0.2, 0.001);
    this.num(relief, w.relief, 'concavity', 'Concavity θ', 0.2, 0.8, 0.01);
    this.num(relief, w.relief, 'minSlope', 'Min slope', 0.0001, 0.01, 0.0001);
    this.num(relief, w.relief, 'maxSlope', 'Max slope', 0.2, 1.5, 0.01);
    const uplift = relief.addFolder({ title: 'Uplift noise (mountain belts)', expanded: false });
    this.climate(uplift, w.relief.uplift, 120000);
    this.detailFolder(relief, w.relief.detail);

    const rivers = this.folder(this.pane, 'Rivers & lakes', WS);
    this.num(rivers, w.rivers, 'threshold', 'River starts at (km²)', 0.3, 40, 0.1);
    this.num(rivers, w.rivers, 'width100', 'Width at 100 km² (m)', 2, 120, 0.5);
    this.num(rivers, w.rivers, 'depth100', 'Depth at 100 km² (m)', 0.3, 12, 0.1);
    this.num(rivers, w.rivers, 'floodplain', 'Floodplain (× width)', 0.5, 8, 0.1);
    this.num(rivers, w.rivers, 'bank', 'Bank height (m)', 0.1, 5, 0.1);
    this.num(rivers, w.rivers, 'meander', 'Meanders', 0, 2, 0.01);
    this.bind(rivers, w.lakes, 'enabled', { label: 'Lakes' });
    this.num(rivers, w.lakes, 'chance', 'Lake chance', 0, 1, 0.01);
    this.num(rivers, w.lakes, 'radius', 'Lake radius (m)', 300, 8000, 50);

    const bio = this.folder(this.pane, 'Climate & biomes', WS);
    const temp = bio.addFolder({ title: 'Temperature noise', expanded: false });
    this.climate(temp, w.climate.temperature, 200000);
    this.bind(bio, w.biomes, 'mode', { label: 'Classifier', options: { 'Whittaker + wetlands': 'whittaker', 'Height bands': 'height' } });
    this.num(bio, w.biomes, 'lapse', 'Cooling (m per unit)', 100, 3000, 10);
    this.num(bio, w.biomes, 'beachHeight', 'Beach height (m)', 0, 15, 0.1);
    this.num(bio, w.biomes, 'peakHeight', 'Peaks above (m)', 50, 1500, 1);
    this.num(bio, w.biomes, 'snowLine', 'Snow line (m)', 50, 1500, 1);

    this.heightmapView('Watershed rendering', WS, w, WATERSHED_COLOR_MODES);
  }

  private detailFolder(parent: Container, d: DetailSettings): void {
    const detail = parent.addFolder({ title: 'Detail noise', expanded: false });
    this.bind(detail, d, 'fractal', { label: 'Fractal', options: FRACTAL_OPTS });
    this.bind(detail, d, 'noise', { label: 'Noise', options: NOISE_OPTS });
    this.num(detail, d, 'amplitude', 'Amplitude (m)', 0, 200, 0.5);
    this.num(detail, d, 'scale', 'Wavelength (m)', 10, 6000, 1);
    this.num(detail, d, 'octaves', 'Octaves', 1, 12, 1);
    this.num(detail, d, 'gain', 'Gain', 0.1, 0.9, 0.01);
    this.num(detail, d, 'mountainBias', 'Mountain bias', 0, 1, 0.01);
    this.num(detail, d, 'sharpness', 'Sharp ↔ round', -1, 1, 0.01);
    this.num(detail, d, 'slopeErosion', 'Slope erosion', 0, 3, 0.01);
  }

  // ───────────────────────────── voxel ─────────────────────────────

  private buildVoxel(): void {
    const v = this.app.settings.voxel;
    const world = this.folder(this.pane, 'Voxel world', ['voxel'], true);
    this.num(world, v, 'viewDistance', 'View distance (chunks)', 2, 16, 1);
    this.num(world, v, 'heightScale', 'Height scale', 0.25, 2.5, 0.01);
    this.num(world, v, 'seaLevel', 'Sea level (Y)', 0, 160, 1);

    const over = this.folder(this.pane, 'Overhangs (3D density)', ['voxel']);
    this.bind(over, v.overhangs, 'enabled', { label: 'Enabled' });
    this.num(over, v.overhangs, 'strength', 'Strength (blocks)', 0, 60, 0.5);
    this.num(over, v.overhangs, 'scale', 'Wavelength', 8, 250, 1);
    this.num(over, v.overhangs, 'octaves', 'Octaves', 1, 5, 1);

    const c = v.caves;
    const caves = this.folder(this.pane, 'Caves', ['voxel']);
    const tabs = caves.addTab({ pages: [{ title: 'Cheese' }, { title: 'Spaghetti' }, { title: 'Noodle' }] });
    this.bind(tabs.pages[0], c.cheese, 'enabled', { label: 'Enabled' });
    this.num(tabs.pages[0], c.cheese, 'scale', 'Wavelength', 20, 300, 1);
    this.num(tabs.pages[0], c.cheese, 'threshold', 'Threshold', 0, 0.9, 0.005);
    this.num(tabs.pages[0], c.cheese, 'stretch', 'Vertical squash', 0.5, 4, 0.05);
    this.bind(tabs.pages[1], c.spaghetti, 'enabled', { label: 'Enabled' });
    this.num(tabs.pages[1], c.spaghetti, 'scale', 'Wavelength', 20, 400, 1);
    this.num(tabs.pages[1], c.spaghetti, 'radius', 'Radius', 0.005, 0.3, 0.001);
    this.bind(tabs.pages[2], c.noodle, 'enabled', { label: 'Enabled' });
    this.num(tabs.pages[2], c.noodle, 'scale', 'Wavelength', 8, 200, 1);
    this.num(tabs.pages[2], c.noodle, 'radius', 'Radius', 0.005, 0.2, 0.001);
    this.num(caves, c, 'surfaceDepth', 'Surface shell (blocks)', 0, 30, 1);
    this.bind(caves, c, 'entrances', { label: 'Cave entrances' });
    this.num(caves, c, 'lavaLevel', 'Lava level (Y)', -64, 40, 1);

    const feat = this.folder(this.pane, 'Ores & features', ['voxel']);
    this.bind(feat, v.ores, 'enabled', { label: 'Ores' });
    this.num(feat, v.ores, 'abundance', 'Ore abundance', 0, 6, 0.05);
    this.bind(feat, v.trees, 'enabled', { label: 'Trees' });
    this.num(feat, v.trees, 'density', 'Tree density', 0, 5, 0.05);
    this.bind(feat, v, 'deepslate', { label: 'Deepslate below Y 0' });

    const shade = this.folder(this.pane, 'Block shading', ['voxel']);
    this.bind(shade, v.ao, 'enabled', { label: 'Ambient occlusion' });
    this.num(shade, v.ao, 'strength', 'AO strength', 0, 1, 0.01);
    this.num(shade, v, 'colorJitter', 'Color jitter', 0, 0.3, 0.005);
    this.bind(shade, v, 'wireframe', { label: 'Wireframe' }, 'visual');

    const edits = this.folder(this.pane, 'Edits (stored deltas)', ['voxel']);
    edits.addBinding(this.monitor, 'edits', { label: 'Changed', readonly: true, interval: 500 } as Any);
    this.buttons(edits, [['Clear all edits', () => this.app.modes.voxel.clearEdits()]]);
  }

  // ───────────────────────────── planet ─────────────────────────────

  private buildPlanet(): void {
    const p = this.app.settings.planet;
    const uni = this.folder(this.pane, 'Universe', ['planet'], true);
    uni.addBinding(this.monitor, 'planet', { label: 'Planet', readonly: true, multiline: true, rows: 3, interval: 400 } as Any);
    const coord = (key: 'x' | 'y' | 'z') => {
      const b = uni.addBinding(p.region, key, { label: `Region ${key.toUpperCase()}`, min: -64, max: 64, step: 1 });
      b.on('change', (ev) => ev.last && this.app.derivePlanet());
    };
    coord('x');
    coord('y');
    coord('z');
    uni.addBinding(p, 'system', { label: 'Star system', min: 0, max: 999, step: 1 }).on('change', (ev) => ev.last && this.app.derivePlanet());
    uni.addBinding(p, 'planet', { label: 'Planet #', min: 0, max: 5, step: 1 }).on('change', (ev) => {
      if (!ev.last) return;
      p.planet = Math.min(p.planet, systemPlanetCount(this.app.settings.seed, p.region, p.system) - 1);
      this.app.derivePlanet();
    });
    this.buttons(
      uni,
      [
        ['◀ Prev planet', () => this.app.stepPlanet(-1)],
        ['Next planet ▶', () => this.app.stepPlanet(1)],
        ['🎲 Random system', () => this.app.randomSystem()],
        ['⟳ Re-derive', () => this.app.derivePlanet()],
      ],
      2,
    );
    const typeList = uni.addBlade({
      view: 'list',
      label: 'Force type',
      options: [{ text: '(from seed)', value: '' }, ...PLANET_TYPES.map((t) => ({ text: t, value: t }))],
      value: '',
    }) as ListBladeApi<string>;
    typeList.on('change', (ev) => this.app.derivePlanet((ev.value || undefined) as PlanetType | undefined));

    const shape = this.folder(this.pane, 'Planet shape', ['planet']);
    this.num(shape, p, 'radius', 'Radius', 200, 3000, 10);
    this.num(shape, p, 'heightScale', 'Height scale', 0.002, 0.12, 0.001);
    this.num(shape, p, 'seaLevel', 'Sea level', -1, 1.5, 0.01);
    const cont = shape.addFolder({ title: 'Continents', expanded: false });
    this.num(cont, p.continents, 'scale', 'Wavelength', 0.15, 3, 0.01);
    this.num(cont, p.continents, 'octaves', 'Octaves', 1, 10, 1);
    this.num(cont, p.continents, 'warp', 'Domain warp', 0, 1.5, 0.01);
    const mtn = shape.addFolder({ title: 'Mountains (ridged)', expanded: false });
    this.num(mtn, p.mountains, 'amplitude', 'Amplitude', 0, 4, 0.01);
    this.num(mtn, p.mountains, 'scale', 'Wavelength', 0.05, 1.5, 0.005);
    this.num(mtn, p.mountains, 'octaves', 'Octaves', 1, 10, 1);
    this.num(mtn, p.mountains, 'coverage', 'Inland start', -0.5, 1, 0.01);
    const det = shape.addFolder({ title: 'Detail (uber noise)', expanded: false });
    this.bind(det, p.detail, 'fractal', { label: 'Fractal', options: FRACTAL_OPTS });
    this.num(det, p.detail, 'amplitude', 'Amplitude', 0, 1.5, 0.01);
    this.num(det, p.detail, 'scale', 'Wavelength', 0.01, 0.6, 0.001);
    this.num(det, p.detail, 'octaves', 'Octaves', 1, 12, 1);
    this.num(det, p.detail, 'sharpness', 'Sharp ↔ round', -1, 1, 0.01);
    this.num(det, p.detail, 'slopeErosion', 'Slope erosion', 0, 3, 0.01);
    this.num(det, p.detail, 'altitudeErosion', 'Altitude erosion', 0, 1, 0.01);
    this.num(det, p.detail, 'ridgeErosion', 'Ridge erosion', 0, 1, 0.01);
    this.num(det, p.detail, 'perturb', 'Perturb features', 0, 2, 0.01);
    this.num(det, p.detail, 'featureAmp', 'Amplify features', 0, 1.5, 0.01);
    const cr = shape.addFolder({ title: 'Craters', expanded: false });
    this.bind(cr, p.craters, 'enabled', { label: 'Enabled' });
    this.num(cr, p.craters, 'density', 'Density', 0, 3, 0.01);
    this.num(cr, p.craters, 'size', 'Size', 0.2, 3, 0.01);
    this.num(cr, p.craters, 'depth', 'Depth', 0, 2, 0.01);
    const te = shape.addFolder({ title: 'Terraces', expanded: false });
    this.bind(te, p.terraces, 'enabled', { label: 'Enabled' });
    this.num(te, p.terraces, 'steps', 'Steps', 2, 30, 1);
    this.num(te, p.terraces, 'smoothness', 'Smoothness', 0.01, 0.5, 0.01);
    this.num(te, p.terraces, 'strength', 'Strength', 0, 1, 0.01);

    const look = this.folder(this.pane, 'Climate & palette', ['planet']);
    this.num(look, p.climate, 'polarCaps', 'Polar caps', 0, 1, 0.01);
    this.num(look, p.climate, 'temperature', 'Temperature', -1.5, 1.5, 0.01);
    this.num(look, p.climate, 'humidity', 'Humidity', -1.5, 1.5, 0.01);
    for (const [key, label] of [
      ['lowWet', 'Lowland (wet)'],
      ['lowDry', 'Lowland (dry)'],
      ['high', 'Highland'],
      ['rock', 'Rock'],
      ['snow', 'Snow / ice'],
      ['beach', 'Beach'],
      ['shallow', 'Shelf'],
      ['deep', 'Seafloor'],
    ] as const) {
      this.bind(look, p.palette, key, { label, view: 'color' });
    }

    const ocean = this.folder(this.pane, 'Ocean', ['planet']);
    this.bind(ocean, p.ocean, 'enabled', { label: 'Enabled' });
    this.bind(ocean, p.ocean, 'lava', { label: 'Lava' });
    this.bind(ocean, p.ocean, 'color', { label: 'Shallow', view: 'color' });
    this.bind(ocean, p.ocean, 'deepColor', { label: 'Deep', view: 'color' });
    this.num(ocean, p.ocean, 'opacity', 'Opacity', 0.4, 1, 0.01);

    const sky = this.folder(this.pane, 'Atmosphere, clouds & rings', ['planet']);
    this.bind(sky, p.atmosphere, 'enabled', { label: 'Atmosphere' }, 'none');
    this.bind(sky, p.atmosphere, 'color', { label: 'Air color', view: 'color' }, 'none');
    this.num(sky, p.atmosphere, 'intensity', 'Density', 0, 3, 0.01, 'none');
    this.num(sky, p.atmosphere, 'thickness', 'Thickness', 0.01, 0.25, 0.001, 'none');
    this.bind(sky, p.clouds, 'enabled', { label: 'Clouds' }, 'none');
    this.num(sky, p.clouds, 'coverage', 'Coverage', 0, 1, 0.01, 'none');
    this.num(sky, p.clouds, 'scale', 'Cloud scale', 0.5, 6, 0.01, 'none');
    this.num(sky, p.clouds, 'speed', 'Cloud speed', 0, 0.05, 0.0005, 'none');
    this.bind(sky, p.clouds, 'color', { label: 'Cloud color', view: 'color' }, 'none');
    this.bind(sky, p.rings, 'enabled', { label: 'Rings' }, 'none');
    this.num(sky, p.rings, 'inner', 'Ring inner', 1.1, 3, 0.01, 'none');
    this.num(sky, p.rings, 'outer', 'Ring outer', 1.3, 4, 0.01, 'none');
    this.num(sky, p.rings, 'tilt', 'Ring tilt', -1.2, 1.2, 0.01, 'none');
    this.bind(sky, p.rings, 'color', { label: 'Ring color', view: 'color' }, 'none');
    this.num(sky, p, 'moons', 'Moons', 0, 4, 1);

    const view = this.folder(this.pane, 'Planet LOD & view', ['planet']);
    this.bind(view, p.view, 'colorMode', {
      label: 'Color by',
      options: { Natural: 'natural', Height: 'height', Slope: 'slope', Temperature: 'temperature', Humidity: 'humidity', 'LOD level': 'lod' },
    });
    this.bind(view, p.view, 'resolution', { label: 'Node grid', options: { '16²': 16, '24²': 24, '32²': 32, '48²': 48, '64²': 64 } });
    this.num(view, p.view, 'lodFactor', 'LOD detail', 1, 5, 0.05);
    this.num(view, p.view, 'maxLevel', 'Max depth', 3, 16, 1);
    this.num(view, p.view, 'rotationSpeed', 'Day cycle speed', 0, 0.3, 0.001, 'none');
    this.bind(view, p.view, 'flatShading', { label: 'Flat shading' }, 'visual');
    this.bind(view, p.view, 'wireframe', { label: 'Wireframe' }, 'visual');
  }

  // ───────────────────────────── erosion ─────────────────────────────

  private buildErosion(): void {
    const e = this.app.settings.erosion;
    const sim = this.folder(this.pane, 'Simulation', ['erosion'], true);
    sim.addBinding(this.monitor, 'erosion', { label: 'Status', readonly: true, multiline: true, rows: 2, interval: 250 } as Any);
    const em = this.app.modes.erosion;
    this.buttons(
      sim,
      [
        ['▶ Run', () => em.run()],
        ['⏸ Pause', () => em.pause()],
        ['⏭ Step', () => em.step()],
        ['↺ Reset', () => em.reset()],
      ],
      4,
    );
    this.bind(sim, e, 'autoRun', { label: 'Auto-run on reset' }, 'none');

    const map = this.folder(this.pane, 'Map region', ['erosion']);
    this.bind(map, e, 'resolution', { label: 'Grid', options: { '128²': 128, '256²': 256, '384²': 384, '512²': 512 } }, 'erosion');
    this.num(map, e, 'extent', 'Extent (m)', 256, 12000, 16, 'erosion');
    this.num(map, e, 'centerX', 'Centre X', -50000, 50000, 16, 'erosion');
    this.num(map, e, 'centerZ', 'Centre Z', -50000, 50000, 16, 'erosion');
    this.bind(map, e, 'island', { label: 'Island edges' }, 'erosion');
    this.buttons(map, [['⛰ Find rugged terrain nearby', () => this.app.findRuggedErosionRegion()]]);
    this.num(map, e, 'heightScale', 'Display height', 0.2, 3, 0.01, 'erosion');

    const hy = e.hydraulic;
    const hyd = this.folder(this.pane, 'Hydraulic erosion', ['erosion']);
    this.bind(hyd, hy, 'enabled', { label: 'Enabled' }, 'erosion');
    this.num(hyd, hy, 'maxDroplets', 'Total droplets', 10000, 3000000, 10000, 'erosion');
    this.num(hyd, hy, 'dropletsPerFrame', 'Batch size', 100, 30000, 100, 'erosion');
    this.num(hyd, hy, 'inertia', 'Inertia', 0, 0.6, 0.005, 'erosion');
    this.num(hyd, hy, 'capacity', 'Sediment capacity', 0.5, 16, 0.1, 'erosion');
    this.num(hyd, hy, 'minCapacity', 'Min capacity', 0, 0.1, 0.001, 'erosion');
    this.num(hyd, hy, 'erodeSpeed', 'Erode speed', 0, 1, 0.01, 'erosion');
    this.num(hyd, hy, 'depositSpeed', 'Deposit speed', 0, 1, 0.01, 'erosion');
    this.num(hyd, hy, 'evaporateSpeed', 'Evaporation', 0.001, 0.1, 0.001, 'erosion');
    this.num(hyd, hy, 'gravity', 'Gravity', 0.5, 20, 0.1, 'erosion');
    this.num(hyd, hy, 'maxLifetime', 'Max lifetime', 5, 120, 1, 'erosion');
    this.num(hyd, hy, 'radius', 'Brush radius', 1, 8, 1, 'erosion');
    this.num(hyd, hy, 'initialWater', 'Initial water', 0.2, 4, 0.05, 'erosion');
    this.num(hyd, hy, 'initialSpeed', 'Initial speed', 0, 4, 0.05, 'erosion');

    const th = this.folder(this.pane, 'Thermal erosion', ['erosion']);
    this.bind(th, e.thermal, 'enabled', { label: 'Enabled' }, 'erosion');
    this.num(th, e.thermal, 'talusAngle', 'Talus angle (°)', 5, 75, 0.5, 'erosion');
    this.num(th, e.thermal, 'strength', 'Strength', 0, 1, 0.01, 'erosion');

    const disp = this.folder(this.pane, 'Display', ['erosion']);
    this.bind(disp, e, 'colorMode', { label: 'Color by', options: { Natural: 'natural', 'Erosion / deposition': 'erosion', 'Water flow': 'flow', Height: 'height' } }, 'erosion');
    this.bind(disp, this.app.settings.terrainView, 'wireframe', { label: 'Wireframe' }, 'visual');
  }

  // ───────────────────────────── environment & export ─────────────────────────────

  private buildEnvironment(): void {
    const r = this.app.settings.render;
    const sky = this.folder(this.pane, 'Sky & lighting', SKY);
    this.num(sky, r, 'timeOfDay', 'Time of day (h)', 0, 24, 0.05, 'render');
    this.bind(sky, r, 'dayCycle', { label: 'Day/night cycle' }, 'render');
    this.num(sky, r, 'dayLength', 'Day length (s)', 20, 1200, 5, 'render');
    this.num(sky, r, 'sunAzimuth', 'Sun azimuth (°)', 0, 360, 1, 'render');
    this.num(sky, r, 'fog', 'Fog', 0, 3, 0.01, 'render');
    this.bind(sky, r, 'clouds', { label: 'Cloud layer' }, 'render');
    this.bind(sky, r, 'shadows', { label: 'Shadows' }, 'render');

    const disp = this.folder(this.pane, 'Display & camera');
    this.num(disp, r, 'exposure', 'Exposure', 0.2, 3, 0.01, 'render');
    this.num(disp, r, 'renderScale', 'Render scale', 0.4, 2, 0.05, 'render');
    this.num(disp, r, 'fov', 'Field of view', 25, 110, 1, 'render');
    this.bind(disp, r, 'minimap', { label: 'Minimap' }, 'render');
    this.bind(disp, r, 'hud', { label: 'Info overlay' }, 'render');
    const c = this.app.settings.camera;
    this.num(disp, c, 'flySpeed', 'Fly speed (m/s)', 2, 1500, 1, 'none');
    this.num(disp, c, 'walkSpeed', 'Walk speed (m/s)', 1, 40, 0.5, 'none');
    this.num(disp, c, 'sensitivity', 'Mouse sensitivity', 0.1, 3, 0.05, 'none');
    this.bind(disp, c, 'collide', { label: 'Collide in flight' }, 'none');
    this.num(disp, c, 'autopilotAltitude', 'Tour altitude (m)', 5, 600, 1, 'none');
  }

  private buildExport(): void {
    const f = this.folder(this.pane, 'Export & share');
    this.buttons(
      f,
      [
        ['Screenshot PNG', () => this.app.screenshot()],
        ['Mesh .glb', () => this.app.exportGlb()],
        ['Heightmap PNG', () => this.app.exportHeightmap()],
        ['Copy share link', () => this.app.share()],
        ['Save settings', () => this.app.saveSettingsFile()],
        ['Load settings', () => this.app.loadSettingsFile()],
      ],
      2,
    );
    this.buttons(f, [['Reset everything to defaults', () => this.app.resetAll()]]);
  }
}
