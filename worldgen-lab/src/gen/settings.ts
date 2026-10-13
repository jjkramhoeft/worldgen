/**
 * The complete, JSON-serialisable settings model for every mode.
 * Workers receive a structured clone of this object, so it must stay plain data.
 */
import type { FractalSettings, WarpSettings } from '../core/fractal';
import type { NoiseKind } from '../core/noise';
import type { SplinePoint } from '../core/spline';
import type { BiomeMode } from './biomes';

export type ModeId = 'terrain' | 'voxel' | 'planet' | 'erosion';
export const MODES: { id: ModeId; label: string; icon: string; blurb: string }[] = [
  { id: 'terrain', label: 'Terrain', icon: '⛰', blurb: 'Infinite heightmap world with LOD, biomes, rivers and vegetation' },
  { id: 'voxel', label: 'Voxel', icon: '▦', blurb: 'Minecraft-style blocks: 3D density, caves, ores, trees, editable' },
  { id: 'planet', label: 'Planet', icon: '◍', blurb: "No Man's Sky style planets from a galaxy seed, with continuous LOD" },
  { id: 'erosion', label: 'Erosion', icon: '≋', blurb: 'Hydraulic + thermal erosion simulation on a finite map' },
];

export interface ClimateNoise {
  noise: NoiseKind;
  /** Wavelength of the first octave (m). */
  scale: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /** Contrast multiplier applied before clamping to [-1, 1]. */
  amplitude: number;
  /** Shifts the whole field (more land, warmer climate, ...). */
  offset: number;
}

export interface DetailSettings extends FractalSettings {
  /** Height of the detail layer (m). */
  amplitude: number;
  /** 0 = same everywhere, 1 = detail only in mountainous areas. */
  mountainBias: number;
}

export interface TerrainSettings {
  horizontalScale: number;
  verticalScale: number;
  seaLevel: number;
  warp: WarpSettings;
  continentalness: ClimateNoise;
  erosion: ClimateNoise;
  weirdness: ClimateNoise;
  temperature: ClimateNoise;
  humidity: ClimateNoise;
  splines: {
    /** continentalness → base height (m). */
    continentalness: SplinePoint[];
    /** erosion → mountain factor (0 … 1). */
    erosion: SplinePoint[];
    /** peaks & valleys → peak multiplier. */
    peaks: SplinePoint[];
  };
  mountainHeight: number;
  /** Share of the mountain height shaped by peaks & valleys ridges (the rest is a smooth massif). */
  ridgeShare: number;
  detail: DetailSettings;
  rivers: { enabled: boolean; width: number; bankWidth: number; depth: number };
  terraces: { enabled: boolean; steps: number; smoothness: number; strength: number };
  island: { enabled: boolean; radius: number; falloff: number; shape: 'circle' | 'square' | 'bump' };
  /** Exponent applied to land heights (Red Blob Games' "redistribution"). */
  redistribution: number;
  biomes: { mode: BiomeMode; beachHeight: number; peakHeight: number; snowLine: number };
}

export type ColorMode =
  | 'natural'
  | 'biome'
  | 'height'
  | 'slope'
  | 'continentalness'
  | 'erosion'
  | 'weirdness'
  | 'pv'
  | 'temperature'
  | 'humidity'
  | 'river'
  | 'lod';

export const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'natural', label: 'Natural' },
  { value: 'biome', label: 'Biome map colors' },
  { value: 'height', label: 'Height' },
  { value: 'slope', label: 'Slope' },
  { value: 'continentalness', label: 'Continentalness' },
  { value: 'erosion', label: 'Erosion' },
  { value: 'weirdness', label: 'Weirdness' },
  { value: 'pv', label: 'Peaks & valleys' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'humidity', label: 'Humidity' },
  { value: 'river', label: 'Rivers' },
  { value: 'lod', label: 'LOD level' },
];

export interface TerrainViewSettings {
  viewDistance: number;
  /** Vertex spacing of the finest LOD (m). */
  vertexSpacing: number;
  nodeResolution: number;
  lodFactor: number;
  colorMode: ColorMode;
  hueShift: number;
  saturation: number;
  vegetation: { enabled: boolean; density: number; distance: number };
  water: { enabled: boolean; opacity: number; shallowColor: string; deepColor: string };
  flatShading: boolean;
  wireframe: boolean;
}

export interface VoxelSettings {
  viewDistance: number;
  heightScale: number;
  seaLevel: number;
  overhangs: { enabled: boolean; strength: number; scale: number; octaves: number };
  caves: {
    cheese: { enabled: boolean; scale: number; threshold: number; stretch: number };
    spaghetti: { enabled: boolean; scale: number; radius: number };
    noodle: { enabled: boolean; scale: number; radius: number };
    surfaceDepth: number;
    entrances: boolean;
    lavaLevel: number;
  };
  ores: { enabled: boolean; abundance: number };
  trees: { enabled: boolean; density: number };
  deepslate: boolean;
  ao: { enabled: boolean; strength: number };
  colorJitter: number;
  wireframe: boolean;
}

export type PlanetType = 'lush' | 'desert' | 'frozen' | 'toxic' | 'scorched' | 'barren' | 'exotic' | 'ocean';
export const PLANET_TYPES: PlanetType[] = ['lush', 'desert', 'frozen', 'toxic', 'scorched', 'barren', 'exotic', 'ocean'];

export interface PlanetPalette {
  deep: string;
  shallow: string;
  beach: string;
  lowDry: string;
  lowWet: string;
  high: string;
  rock: string;
  snow: string;
}

export interface PlanetSettings {
  /** Galaxy seed the parameters were last derived from ('' = never). */
  derivedSeed: string;
  region: { x: number; y: number; z: number };
  system: number;
  planet: number;
  name: string;
  type: PlanetType;
  radius: number;
  /** Elevation 1.0 corresponds to radius × heightScale. */
  heightScale: number;
  seaLevel: number;
  continents: FractalSettings & { warp: number };
  mountains: { amplitude: number; scale: number; octaves: number; coverage: number };
  detail: FractalSettings & { amplitude: number };
  craters: { enabled: boolean; density: number; size: number; depth: number };
  terraces: { enabled: boolean; steps: number; smoothness: number; strength: number };
  climate: { polarCaps: number; temperature: number; humidity: number };
  palette: PlanetPalette;
  ocean: { enabled: boolean; color: string; deepColor: string; opacity: number; lava: boolean };
  atmosphere: { enabled: boolean; color: string; intensity: number; thickness: number };
  clouds: { enabled: boolean; coverage: number; color: string; speed: number; scale: number; opacity: number };
  rings: { enabled: boolean; inner: number; outer: number; color: string; tilt: number; opacity: number };
  moons: number;
  view: {
    resolution: number;
    lodFactor: number;
    maxLevel: number;
    flatShading: boolean;
    wireframe: boolean;
    colorMode: 'natural' | 'height' | 'slope' | 'temperature' | 'humidity' | 'lod';
    rotationSpeed: number;
  };
}

export interface ErosionSettings {
  resolution: number;
  extent: number;
  centerX: number;
  centerZ: number;
  heightScale: number;
  island: boolean;
  hydraulic: {
    enabled: boolean;
    dropletsPerFrame: number;
    maxDroplets: number;
    inertia: number;
    capacity: number;
    minCapacity: number;
    erodeSpeed: number;
    depositSpeed: number;
    evaporateSpeed: number;
    gravity: number;
    maxLifetime: number;
    radius: number;
    initialWater: number;
    initialSpeed: number;
  };
  thermal: { enabled: boolean; talusAngle: number; strength: number };
  colorMode: 'natural' | 'erosion' | 'flow' | 'height';
  autoRun: boolean;
}

export interface RenderSettings {
  timeOfDay: number;
  dayCycle: boolean;
  dayLength: number;
  sunAzimuth: number;
  fog: number;
  shadows: boolean;
  clouds: boolean;
  exposure: number;
  renderScale: number;
  fov: number;
  minimap: boolean;
  hud: boolean;
}

export type CameraMode = 'orbit' | 'fly' | 'walk';

export interface CameraSettings {
  mode: CameraMode;
  flySpeed: number;
  walkSpeed: number;
  sensitivity: number;
  collide: boolean;
  autopilot: boolean;
  autopilotAltitude: number;
}

export interface AppSettings {
  version: 1;
  mode: ModeId;
  seed: string;
  terrain: TerrainSettings;
  terrainView: TerrainViewSettings;
  voxel: VoxelSettings;
  planet: PlanetSettings;
  erosion: ErosionSettings;
  render: RenderSettings;
  camera: CameraSettings;
}

const climate = (scale: number, octaves: number, amplitude: number): ClimateNoise => ({
  noise: 'simplex',
  scale,
  octaves,
  lacunarity: 2,
  gain: 0.5,
  amplitude,
  offset: 0,
});

export function defaultTerrain(): TerrainSettings {
  return {
    horizontalScale: 1,
    verticalScale: 1,
    seaLevel: 0,
    warp: { enabled: true, strength: 260, scale: 1400, octaves: 3, iterations: 1 },
    // Continent/erosion wavelengths follow Minecraft's noise router (2048 blocks); climate zones are a bit larger.
    continentalness: climate(2048, 5, 1.6),
    erosion: climate(2048, 4, 1.6),
    weirdness: climate(1200, 4, 1.3),
    temperature: climate(6000, 3, 1.25),
    humidity: climate(3000, 3, 1.25),
    splines: {
      // Ocean floors near Minecraft's (≈ −28 deep ocean, ≈ −15 ocean), then coast → far inland.
      continentalness: [
        [-1, -32],
        [-0.51, -28],
        [-0.44, -16],
        [-0.19, -12],
        [-0.15, -2],
        [-0.11, 1.5],
        [0.03, 8],
        [0.3, 22],
        [0.6, 40],
        [1, 60],
      ],
      erosion: [
        [-1, 1],
        [-0.78, 0.92],
        [-0.375, 0.62],
        [-0.2225, 0.4],
        [0.05, 0.16],
        [0.45, 0.05],
        [0.55, 0.02],
        [1, 0],
      ],
      peaks: [
        [-1, -0.35],
        [-0.85, -0.2],
        [-0.2, 0.02],
        [0.2, 0.25],
        [0.7, 0.75],
        [1, 1],
      ],
    },
    mountainHeight: 200,
    ridgeShare: 0.55,
    detail: {
      noise: 'simplex',
      fractal: 'uber',
      scale: 420,
      octaves: 7,
      lacunarity: 2,
      gain: 0.5,
      sharpness: 0.35,
      slopeErosion: 0.6,
      altitudeErosion: 0.3,
      ridgeErosion: 0.15,
      perturb: 0.2,
      featureAmp: 0.15,
      amplitude: 38,
      mountainBias: 0.75,
    },
    rivers: { enabled: true, width: 0.03, bankWidth: 0.09, depth: 5 },
    terraces: { enabled: false, steps: 12, smoothness: 0.25, strength: 1 },
    island: { enabled: false, radius: 1800, falloff: 0.5, shape: 'circle' },
    redistribution: 1,
    biomes: { mode: 'minecraft', beachHeight: 3, peakHeight: 170, snowLine: 150 },
  };
}

export function defaultTerrainView(): TerrainViewSettings {
  return {
    viewDistance: 4000,
    vertexSpacing: 1,
    nodeResolution: 64,
    lodFactor: 2,
    colorMode: 'natural',
    hueShift: 0,
    saturation: 1,
    vegetation: { enabled: true, density: 1, distance: 700 },
    water: { enabled: true, opacity: 0.86, shallowColor: '#3aa7b8', deepColor: '#0b3a5c' },
    flatShading: false,
    wireframe: false,
  };
}

export function defaultVoxel(): VoxelSettings {
  return {
    viewDistance: 6,
    heightScale: 0.85,
    seaLevel: 63,
    overhangs: { enabled: true, strength: 14, scale: 56, octaves: 3 },
    caves: {
      cheese: { enabled: true, scale: 90, threshold: 0.42, stretch: 1.8 },
      spaghetti: { enabled: true, scale: 110, radius: 0.075 },
      noodle: { enabled: true, scale: 40, radius: 0.035 },
      surfaceDepth: 8,
      entrances: true,
      lavaLevel: -54,
    },
    ores: { enabled: true, abundance: 1 },
    trees: { enabled: true, density: 1 },
    deepslate: true,
    ao: { enabled: true, strength: 0.75 },
    colorJitter: 0.07,
    wireframe: false,
  };
}

export function defaultPlanet(): PlanetSettings {
  return {
    derivedSeed: '',
    region: { x: 0, y: 0, z: 0 },
    system: 0,
    planet: 0,
    name: 'Ehrvan Prime',
    type: 'lush',
    radius: 1000,
    heightScale: 0.025,
    seaLevel: 0,
    continents: {
      noise: 'simplex',
      fractal: 'fbm',
      scale: 0.9,
      octaves: 6,
      lacunarity: 2,
      gain: 0.5,
      sharpness: 0,
      slopeErosion: 0,
      altitudeErosion: 0,
      ridgeErosion: 0,
      perturb: 0,
      featureAmp: 0,
      warp: 0.35,
    },
    mountains: { amplitude: 1.3, scale: 0.35, octaves: 6, coverage: 0.15 },
    detail: {
      noise: 'simplex',
      fractal: 'uber',
      scale: 0.12,
      octaves: 8,
      lacunarity: 2.1,
      gain: 0.5,
      sharpness: 0.4,
      slopeErosion: 0.5,
      altitudeErosion: 0.35,
      ridgeErosion: 0.2,
      perturb: 0.25,
      featureAmp: 0.2,
      amplitude: 0.35,
    },
    craters: { enabled: false, density: 1, size: 1, depth: 0.5 },
    terraces: { enabled: false, steps: 8, smoothness: 0.2, strength: 1 },
    climate: { polarCaps: 0.6, temperature: 0, humidity: 0 },
    palette: {
      deep: '#1a2f4f',
      shallow: '#3d7d8c',
      beach: '#d8c897',
      lowDry: '#a7a35a',
      lowWet: '#3f7f3a',
      high: '#6f7a4c',
      rock: '#78716a',
      snow: '#f2f5f7',
    },
    ocean: { enabled: true, color: '#2a86a8', deepColor: '#0a2a4a', opacity: 0.88, lava: false },
    atmosphere: { enabled: true, color: '#6fb3ff', intensity: 1, thickness: 0.06 },
    clouds: { enabled: true, coverage: 0.5, color: '#ffffff', speed: 0.004, scale: 2.2, opacity: 0.9 },
    rings: { enabled: false, inner: 1.6, outer: 2.5, color: '#d9c7a6', tilt: 0.4, opacity: 0.8 },
    moons: 1,
    view: {
      resolution: 32,
      lodFactor: 2.2,
      maxLevel: 12,
      flatShading: false,
      wireframe: false,
      colorMode: 'natural',
      rotationSpeed: 0.02,
    },
  };
}

export function defaultErosion(): ErosionSettings {
  return {
    resolution: 256,
    extent: 2048,
    centerX: 0,
    centerZ: 0,
    heightScale: 1,
    island: true,
    hydraulic: {
      enabled: true,
      dropletsPerFrame: 3000,
      maxDroplets: 300000,
      inertia: 0.05,
      capacity: 4,
      minCapacity: 0.01,
      erodeSpeed: 0.3,
      depositSpeed: 0.3,
      evaporateSpeed: 0.01,
      gravity: 4,
      maxLifetime: 30,
      radius: 3,
      initialWater: 1,
      initialSpeed: 1,
    },
    thermal: { enabled: true, talusAngle: 38, strength: 0.35 },
    colorMode: 'natural',
    autoRun: true,
  };
}

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    mode: 'terrain',
    seed: 'worldgen-lab',
    terrain: defaultTerrain(),
    terrainView: defaultTerrainView(),
    voxel: defaultVoxel(),
    planet: defaultPlanet(),
    erosion: defaultErosion(),
    render: {
      timeOfDay: 10.5,
      dayCycle: false,
      dayLength: 240,
      sunAzimuth: 115,
      fog: 1,
      shadows: true,
      clouds: true,
      exposure: 1,
      renderScale: 1,
      fov: 60,
      minimap: true,
      hud: true,
    },
    camera: {
      mode: 'orbit',
      flySpeed: 60,
      walkSpeed: 6,
      sensitivity: 1,
      collide: true,
      autopilot: false,
      autopilotAltitude: 70,
    },
  };
}

// ───────────────────────────── presets ─────────────────────────────

export interface TerrainPreset {
  name: string;
  description: string;
  apply(s: AppSettings): void;
}

const scaleSpline = (pts: SplinePoint[], fn: (y: number, x: number) => number): SplinePoint[] =>
  pts.map(([x, y]) => [x, fn(y, x)]);

export const TERRAIN_PRESETS: TerrainPreset[] = [
  {
    name: 'Minecraft-like (default)',
    description: 'Multi-noise climate, splines and biomes modelled on Minecraft 1.18+.',
    apply: () => {},
  },
  {
    name: 'Amplified',
    description: 'Like the Amplified world type: towering mountains everywhere.',
    apply: (s) => {
      const t = s.terrain;
      t.mountainHeight = 520;
      t.splines.continentalness = scaleSpline(t.splines.continentalness, (y) => (y > 0 ? y * 1.8 : y));
      t.detail.amplitude = 70;
      t.erosion.offset = -0.15;
      t.biomes.peakHeight = 300;
    },
  },
  {
    name: 'Large Biomes',
    description: 'Climate and continent noise stretched 3×, like the Large Biomes option.',
    apply: (s) => {
      const t = s.terrain;
      for (const n of [t.continentalness, t.erosion, t.weirdness, t.temperature, t.humidity]) n.scale *= 3;
      t.warp.scale *= 2;
    },
  },
  {
    name: 'Archipelago',
    description: 'Warm seas dotted with many small islands.',
    apply: (s) => {
      const t = s.terrain;
      t.continentalness.offset = -0.4;
      t.continentalness.scale = 1400;
      t.continentalness.amplitude = 1.9;
      t.erosion.offset = 0.3;
      t.temperature.offset = 0.45;
      t.humidity.offset = 0.25;
      t.warp.strength = 300;
      t.mountainHeight = 110;
      t.detail.amplitude = 20;
      t.biomes.beachHeight = 4;
    },
  },
  {
    name: 'Alpine',
    description: 'Cold, high and rugged: mostly inland with low erosion.',
    apply: (s) => {
      const t = s.terrain;
      t.continentalness.offset = 0.5;
      t.erosion.offset = -0.45;
      t.temperature.offset = -0.35;
      t.mountainHeight = 320;
      t.biomes.snowLine = 110;
    },
  },
  {
    name: 'Badlands Mesas',
    description: 'Hot, dry plateaus with terraced cliffs.',
    apply: (s) => {
      const t = s.terrain;
      t.temperature.offset = 0.9;
      t.humidity.offset = -0.8;
      t.terraces = { enabled: true, steps: 14, smoothness: 0.15, strength: 1 };
      t.erosion.offset = -0.2;
      t.detail.sharpness = -0.2;
      t.continentalness.offset = 0.35;
    },
  },
  {
    name: 'Lone Island',
    description: 'A single tropical island shaped by a radial falloff mask.',
    apply: (s) => {
      const t = s.terrain;
      t.island = { enabled: true, radius: 1800, falloff: 0.55, shape: 'circle' };
      t.continentalness.offset = 0.35;
      t.temperature.offset = 0.45;
      t.humidity.offset = 0.3;
    },
  },
  {
    name: 'Superflat',
    description: 'Every spline flattened — the classic Superflat world.',
    apply: (s) => {
      const t = s.terrain;
      t.splines.continentalness = [
        [-1, 4],
        [1, 4],
      ];
      t.splines.erosion = [
        [-1, 0],
        [1, 0],
      ];
      t.splines.peaks = [
        [-1, 0],
        [1, 0],
      ];
      t.detail.amplitude = 0;
      t.rivers.enabled = false;
      t.warp.enabled = false;
    },
  },
  {
    name: 'Dreamscape (domain warp)',
    description: 'Heavy two-pass domain warping (Inigo Quilez) for swirling, organic shapes.',
    apply: (s) => {
      const t = s.terrain;
      t.warp = { enabled: true, strength: 620, scale: 1800, octaves: 4, iterations: 2 };
      t.detail.perturb = 0.5;
      t.detail.sharpness = 0.6;
      t.temperature.offset = 0.2;
    },
  },
  {
    name: 'Eroded Highlands (IQ)',
    description: "Derivative-damped fBm: Inigo Quilez's fake erosion with gullies and smooth valleys.",
    apply: (s) => {
      const t = s.terrain;
      t.detail = { ...t.detail, fractal: 'erosion', slopeErosion: 1.2, amplitude: 110, scale: 800, octaves: 9, mountainBias: 0.4 };
      t.mountainHeight = 170;
      t.continentalness.offset = 0.35;
    },
  },
  {
    name: "Alien World (NMS-ish)",
    description: 'Uber noise with strong feature amplification, terraces and an alien palette.',
    apply: (s) => {
      const t = s.terrain;
      t.warp = { enabled: true, strength: 420, scale: 1400, octaves: 3, iterations: 2 };
      t.detail = { ...t.detail, sharpness: 0.8, featureAmp: 0.6, perturb: 0.6, amplitude: 60 };
      t.terraces = { enabled: true, steps: 8, smoothness: 0.3, strength: 0.6 };
      t.seaLevel = 14;
      s.terrainView.hueShift = 150;
      s.terrainView.saturation = 1.3;
      s.terrainView.water.shallowColor = '#b04fd6';
      s.terrainView.water.deepColor = '#3a0f57';
    },
  },
];

// ───────────────────────────── persistence ─────────────────────────────

/** Deep-merges `saved` onto `defaults`, ignoring unknown keys and wrong types. */
export function mergeSettings<T>(defaults: T, saved: unknown): T {
  if (saved === undefined || saved === null) return defaults;
  if (Array.isArray(defaults)) return (Array.isArray(saved) ? saved : defaults) as T;
  if (typeof defaults === 'object' && defaults !== null) {
    if (typeof saved !== 'object' || Array.isArray(saved)) return defaults;
    const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
    for (const key of Object.keys(out)) {
      out[key] = mergeSettings((defaults as Record<string, unknown>)[key], (saved as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return (typeof saved === typeof defaults ? saved : defaults) as T;
}

/** Returns only the values that differ from `base` (for compact share links). */
export function diffSettings(base: unknown, value: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(value)) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof base !== 'object' || base === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const d = diffSettings((base as Record<string, unknown>)[key], (value as Record<string, unknown>)[key]);
    if (d !== undefined) out[key] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const res = new Response(blob.stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** Encodes the settings diff as a compact, URL-safe string. */
export async function encodeShare(settings: AppSettings): Promise<string> {
  const diff = diffSettings(defaultSettings(), settings) ?? {};
  const json = new TextEncoder().encode(JSON.stringify(diff));
  return toBase64Url(await pipeBytes(json, new CompressionStream('deflate-raw')));
}

export async function decodeShare(text: string): Promise<AppSettings> {
  const bytes = await pipeBytes(fromBase64Url(text), new DecompressionStream('deflate-raw'));
  const diff = JSON.parse(new TextDecoder().decode(bytes));
  return mergeSettings(defaultSettings(), deepAssign(defaultSettings(), diff));
}

function deepAssign(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const t = (typeof target === 'object' && target !== null ? target : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) t[k] = deepAssign(t[k], v);
  return t;
}

/**
 * Copies `source` into `target` recursively while keeping the identity of
 * nested objects — the UI binds directly to them, so they must never be replaced.
 */
export function assignDeep<T>(target: T, source: T): T {
  const t = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const current = t[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      assignDeep(current, value);
    } else {
      t[key] = Array.isArray(value) ? structuredClone(value) : value;
    }
  }
  return target;
}
