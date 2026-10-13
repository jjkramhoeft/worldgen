/**
 * No Man's Sky style seed hierarchy: one galaxy seed fans out to regions,
 * star systems and planets. Every planet property (type, palette, radius,
 * oceans, rings, moons, name, …) is derived deterministically from its
 * coordinates — nothing is stored.
 */
import { deriveSeed, Rng, seedFromString } from '../../core/rng';
import { hexToRgb, rgbToHex, type RGB } from '../../core/color';
import { planetSeed } from './planetGen';
import type { PlanetPalette, PlanetSettings, PlanetType } from '../settings';

interface TypeProfile {
  weight: number;
  palette: PlanetPalette;
  ocean: { enabled: boolean; color: string; deepColor: string; opacity: number; lava: boolean };
  atmosphere: { enabled: boolean; color: string };
  clouds: { enabled: boolean; coverage: number; color: string };
  seaLevel: [number, number];
  polarCaps: number;
  temperature: number;
  humidity: number;
  craters: boolean;
  terraces: boolean;
  warp: [number, number];
  sharpness: [number, number];
}

export const PROFILES: Record<PlanetType, TypeProfile> = {
  lush: {
    weight: 3,
    palette: { deep: '#13294b', shallow: '#2f7f8f', beach: '#d8c897', lowDry: '#a2a256', lowWet: '#3d7a35', high: '#627048', rock: '#756e66', snow: '#f3f6f8' },
    ocean: { enabled: true, color: '#2a86a8', deepColor: '#0a2a4a', opacity: 0.88, lava: false },
    atmosphere: { enabled: true, color: '#6fb3ff' },
    clouds: { enabled: true, coverage: 0.5, color: '#ffffff' },
    seaLevel: [-0.1, 0.2],
    polarCaps: 0.6,
    temperature: 0,
    humidity: 0.1,
    craters: false,
    terraces: false,
    warp: [0.2, 0.45],
    sharpness: [0.1, 0.5],
  },
  desert: {
    weight: 2,
    palette: { deep: '#3a2a1a', shallow: '#7a5a3a', beach: '#e6c88f', lowDry: '#d9a75f', lowWet: '#c48a4a', high: '#a8653a', rock: '#8a5a3c', snow: '#f0e6d8' },
    ocean: { enabled: true, color: '#3f9f9a', deepColor: '#16424a', opacity: 0.85, lava: false },
    atmosphere: { enabled: true, color: '#f2b26b' },
    clouds: { enabled: true, coverage: 0.12, color: '#fff1dc' },
    seaLevel: [0.45, 0.8],
    polarCaps: 0.2,
    temperature: 0.4,
    humidity: -0.8,
    craters: false,
    terraces: false,
    warp: [0.3, 0.6],
    sharpness: [-0.5, 0.1],
  },
  frozen: {
    weight: 2,
    palette: { deep: '#1a2f4a', shallow: '#6f9fc0', beach: '#cfd8de', lowDry: '#dfe8ee', lowWet: '#c9d9e6', high: '#b8c8d8', rock: '#6f7a86', snow: '#ffffff' },
    ocean: { enabled: true, color: '#9fd0ea', deepColor: '#2f5f8a', opacity: 0.95, lava: false },
    atmosphere: { enabled: true, color: '#bfe0ff' },
    clouds: { enabled: true, coverage: 0.6, color: '#f4f8ff' },
    seaLevel: [-0.1, 0.3],
    polarCaps: 1,
    temperature: -0.9,
    humidity: 0.2,
    craters: false,
    terraces: false,
    warp: [0.2, 0.4],
    sharpness: [0.3, 0.8],
  },
  toxic: {
    weight: 1.5,
    palette: { deep: '#1f2a10', shallow: '#4f6a1a', beach: '#a8a04a', lowDry: '#8f9a2a', lowWet: '#5f7f1a', high: '#6a4f7a', rock: '#5a4a5f', snow: '#d8f07a' },
    ocean: { enabled: true, color: '#8fbf2a', deepColor: '#2a3a0a', opacity: 0.9, lava: false },
    atmosphere: { enabled: true, color: '#c8f05a' },
    clouds: { enabled: true, coverage: 0.55, color: '#e8ffb0' },
    seaLevel: [0, 0.35],
    polarCaps: 0.3,
    temperature: 0.3,
    humidity: 0.4,
    craters: false,
    terraces: false,
    warp: [0.4, 0.8],
    sharpness: [0.4, 0.9],
  },
  scorched: {
    weight: 1.5,
    palette: { deep: '#1a0a08', shallow: '#3a1a10', beach: '#4a2a20', lowDry: '#5a2a1a', lowWet: '#3a1a14', high: '#2a1a18', rock: '#1f1716', snow: '#8a7a70' },
    ocean: { enabled: true, color: '#ff7a1a', deepColor: '#ff3a0a', opacity: 1, lava: true },
    atmosphere: { enabled: true, color: '#ff7a4a' },
    clouds: { enabled: true, coverage: 0.3, color: '#6a4a40' },
    seaLevel: [0.2, 0.5],
    polarCaps: 0,
    temperature: 1,
    humidity: -1,
    craters: true,
    terraces: false,
    warp: [0.3, 0.6],
    sharpness: [0.5, 1],
  },
  barren: {
    weight: 2,
    palette: { deep: '#3a3a3e', shallow: '#5a5a60', beach: '#7a7a80', lowDry: '#8a8a8e', lowWet: '#7e7e84', high: '#9a9aa0', rock: '#6a6a70', snow: '#d8d8de' },
    ocean: { enabled: false, color: '#5a5a60', deepColor: '#3a3a3e', opacity: 1, lava: false },
    atmosphere: { enabled: false, color: '#9aa4b0' },
    clouds: { enabled: false, coverage: 0, color: '#ffffff' },
    seaLevel: [-0.3, 0.1],
    polarCaps: 0.2,
    temperature: -0.2,
    humidity: -0.5,
    craters: true,
    terraces: false,
    warp: [0.1, 0.3],
    sharpness: [-0.2, 0.4],
  },
  exotic: {
    weight: 0.8,
    palette: { deep: '#2a1a4a', shallow: '#4a8ad0', beach: '#f0d0e8', lowDry: '#e07ab8', lowWet: '#b04ad0', high: '#5ad0c0', rock: '#7a5a9a', snow: '#fff0fa' },
    ocean: { enabled: true, color: '#6ad0e0', deepColor: '#24407a', opacity: 0.85, lava: false },
    atmosphere: { enabled: true, color: '#ff9ae0' },
    clouds: { enabled: true, coverage: 0.35, color: '#ffd6f4' },
    seaLevel: [0, 0.4],
    polarCaps: 0.4,
    temperature: 0.2,
    humidity: 0.3,
    craters: false,
    terraces: true,
    warp: [0.6, 1],
    sharpness: [0.6, 1],
  },
  ocean: {
    weight: 1.2,
    palette: { deep: '#0a1f3f', shallow: '#2a9fc0', beach: '#e8d8a8', lowDry: '#8fbf5a', lowWet: '#3f9f4a', high: '#5f8f4a', rock: '#6f7a70', snow: '#f5f8fa' },
    ocean: { enabled: true, color: '#2aa0d0', deepColor: '#06224a', opacity: 0.9, lava: false },
    atmosphere: { enabled: true, color: '#7ac0ff' },
    clouds: { enabled: true, coverage: 0.6, color: '#ffffff' },
    seaLevel: [0.55, 0.85],
    polarCaps: 0.5,
    temperature: 0.2,
    humidity: 0.6,
    craters: false,
    terraces: false,
    warp: [0.2, 0.5],
    sharpness: [0.2, 0.6],
  },
};

const SYLLABLES = ['ka', 'zu', 'ri', 'lo', 've', 'thar', 'on', 'ex', 'ul', 'ma', 'dri', 'sol', 'qua', 'ny', 'ir', 'eb', 'os', 'an', 'tel', 'vor', 'xi', 'ae', 'gu', 'hel', 'ion', 'sar', 'ku', 'mi', 'ten', 'yr'];
const SUFFIXES = ['', '', '', ' Prime', ' Minor', ' IV', ' VII', ' Beta', ' XI', '-Delta', ' Major', ' Tau'];

export function planetName(seed: number): string {
  const rng = new Rng(deriveSeed(seed, 99));
  const n = rng.int(2, 3);
  let name = '';
  for (let i = 0; i < n; i++) name += rng.pick(SYLLABLES);
  return name.charAt(0).toUpperCase() + name.slice(1) + rng.pick(SUFFIXES);
}

/** Number of planets in a star system (2–6), derived from its coordinates. */
export function systemPlanetCount(seedText: string, region: PlanetSettings['region'], system: number): number {
  const rng = new Rng(deriveSeed(seedFromString(seedText), 0x5157, region.x, region.y, region.z, system));
  return rng.int(2, 6);
}

function rotateHue(hex: string, degrees: number): string {
  const c: RGB = hexToRgb(hex);
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const k = (1 - cos) / 3;
  const q = Math.sqrt(1 / 3) * sin;
  return rgbToHex([
    (cos + k) * c[0] + (k - q) * c[1] + (k + q) * c[2],
    (k + q) * c[0] + (cos + k) * c[1] + (k - q) * c[2],
    (k - q) * c[0] + (k + q) * c[1] + (cos + k) * c[2],
  ]);
}

/**
 * Derives every planet parameter from (seed, region, system, planet) and writes
 * it into `p` (view settings are left untouched). Returns the planet seed.
 */
export function derivePlanet(seedText: string, p: PlanetSettings, forcedType?: PlanetType): number {
  const seed = planetSeed(seedText, p);
  const rng = new Rng(seed);
  const type =
    forcedType ??
    rng.weighted((Object.keys(PROFILES) as PlanetType[]).map((t) => ({ value: t, weight: PROFILES[t].weight })));
  const prof = PROFILES[type];
  const hue = rng.range(-22, 22);

  p.derivedSeed = seedText;
  p.type = type;
  p.name = planetName(seed);
  p.radius = Math.round(rng.range(750, 1300));
  p.heightScale = rng.range(0.018, 0.034);
  p.seaLevel = rng.range(prof.seaLevel[0], prof.seaLevel[1]);
  p.continents = {
    ...p.continents,
    scale: rng.range(0.6, 1.3),
    octaves: 6,
    warp: rng.range(prof.warp[0], prof.warp[1]),
  };
  p.mountains = {
    amplitude: rng.range(0.6, 1.8),
    scale: rng.range(0.22, 0.5),
    octaves: 6,
    coverage: rng.range(-0.1, 0.4),
  };
  p.detail = {
    ...p.detail,
    fractal: 'uber',
    scale: rng.range(0.08, 0.18),
    sharpness: rng.range(prof.sharpness[0], prof.sharpness[1]),
    slopeErosion: rng.range(0.2, 0.9),
    altitudeErosion: rng.range(0.1, 0.6),
    perturb: rng.range(0, 0.6),
    featureAmp: rng.range(0, 0.5),
    amplitude: rng.range(0.25, 0.5),
  };
  p.craters = { enabled: prof.craters, density: rng.range(0.6, 1.6), size: rng.range(0.6, 1.4), depth: rng.range(0.35, 0.8) };
  p.terraces = { enabled: prof.terraces, steps: rng.int(5, 12), smoothness: rng.range(0.1, 0.3), strength: rng.range(0.6, 1) };
  p.climate = {
    polarCaps: prof.polarCaps,
    temperature: prof.temperature + rng.range(-0.15, 0.15),
    humidity: prof.humidity + rng.range(-0.2, 0.2),
  };
  p.palette = Object.fromEntries(Object.entries(prof.palette).map(([k, v]) => [k, rotateHue(v, hue)])) as unknown as PlanetPalette;
  p.ocean = { ...prof.ocean, color: rotateHue(prof.ocean.color, hue), deepColor: rotateHue(prof.ocean.deepColor, hue) };
  p.atmosphere = {
    enabled: prof.atmosphere.enabled,
    color: rotateHue(prof.atmosphere.color, hue),
    intensity: rng.range(0.8, 1.3),
    thickness: rng.range(0.045, 0.08),
  };
  p.clouds = {
    enabled: prof.clouds.enabled,
    coverage: Math.max(0, Math.min(0.9, prof.clouds.coverage + rng.range(-0.12, 0.12))),
    color: prof.clouds.color,
    speed: rng.range(0.002, 0.008),
    scale: rng.range(1.6, 3),
    opacity: 0.9,
  };
  const ringed = rng.chance(type === 'barren' ? 0.1 : 0.22);
  p.rings = {
    enabled: ringed,
    inner: rng.range(1.4, 1.8),
    outer: rng.range(2.1, 2.9),
    color: rotateHue(rng.pick(['#d9c7a6', '#bfb7a8', '#c9a27a', '#a8b8c8']), hue),
    tilt: rng.range(0.1, 0.7),
    opacity: rng.range(0.55, 0.9),
  };
  p.moons = rng.weighted([
    { value: 0, weight: 3 },
    { value: 1, weight: 4 },
    { value: 2, weight: 2 },
    { value: 3, weight: 1 },
  ]);
  return seed;
}
