/**
 * Biome definitions and classifiers.
 *
 * The default classifier mirrors Minecraft 1.18+'s multi-noise biome builder:
 * temperature, humidity, continentalness, erosion and peaks & valleys are each
 * bucketed into levels and looked up in tables (the "middle biomes" table is
 * the same 5×5 layout Minecraft uses). Alternatives: a Whittaker
 * (temperature × moisture) diagram and plain height bands.
 */
import { hexToRgb, type RGB } from '../core/color';

export type TreeType =
  | 'oak'
  | 'birch'
  | 'spruce'
  | 'acacia'
  | 'jungle'
  | 'darkoak'
  | 'cactus'
  | 'shrub'
  | 'boulder'
  | 'palm';

export const TREE_TYPES: TreeType[] = ['oak', 'birch', 'spruce', 'acacia', 'jungle', 'darkoak', 'cactus', 'shrub', 'boulder', 'palm'];

export interface BiomeDef {
  id: number;
  key: string;
  name: string;
  /** Flat color used on the 2D map and the "biome" debug view. */
  map: string;
  /** Ground color used by the natural 3D shading. */
  ground: string;
  /** Color used on steep slopes. */
  rock: string;
  /** Voxel surface blocks (keys into the voxel block table). */
  top: string;
  filler: string;
  trees: { type: TreeType; weight: number }[];
  /** Trees per 100 m² (roughly). */
  treeDensity: number;
  ocean?: boolean;
  snowy?: boolean;
}

const ROCK = '#7f7b74';

const defs: Omit<BiomeDef, 'id'>[] = [
  { key: 'deep_ocean', name: 'Deep Ocean', map: '#1d3b6e', ground: '#5d5d55', rock: '#4f4f4b', top: 'gravel', filler: 'gravel', trees: [], treeDensity: 0, ocean: true },
  { key: 'ocean', name: 'Ocean', map: '#2a5a9c', ground: '#867f63', rock: '#5e5c58', top: 'sand', filler: 'sand', trees: [], treeDensity: 0, ocean: true },
  { key: 'warm_ocean', name: 'Warm Ocean', map: '#2e93b0', ground: '#d9c99a', rock: '#a99c78', top: 'sand', filler: 'sand', trees: [], treeDensity: 0, ocean: true },
  { key: 'lukewarm_ocean', name: 'Lukewarm Ocean', map: '#2d78a8', ground: '#bcae86', rock: '#8a826c', top: 'sand', filler: 'sand', trees: [], treeDensity: 0, ocean: true },
  { key: 'cold_ocean', name: 'Cold Ocean', map: '#2b4c8a', ground: '#77746a', rock: '#5c5b58', top: 'gravel', filler: 'gravel', trees: [], treeDensity: 0, ocean: true },
  { key: 'frozen_ocean', name: 'Frozen Ocean', map: '#7393c6', ground: '#8d8f93', rock: '#6c6e72', top: 'gravel', filler: 'gravel', trees: [], treeDensity: 0, ocean: true, snowy: true },
  { key: 'river', name: 'River', map: '#3f76e4', ground: '#9a8e6c', rock: '#6f6a5f', top: 'sand', filler: 'dirt', trees: [], treeDensity: 0, ocean: true },
  { key: 'frozen_river', name: 'Frozen River', map: '#a3b8e8', ground: '#a8adb3', rock: '#7c8086', top: 'gravel', filler: 'dirt', trees: [], treeDensity: 0, ocean: true, snowy: true },
  { key: 'beach', name: 'Beach', map: '#e8d9a0', ground: '#e3d4a2', rock: '#b8a77a', top: 'sand', filler: 'sand', trees: [{ type: 'palm', weight: 1 }], treeDensity: 0.04 },
  { key: 'snowy_beach', name: 'Snowy Beach', map: '#f1eddc', ground: '#ebe7da', rock: '#9c9a94', top: 'snow', filler: 'sand', trees: [], treeDensity: 0, snowy: true },
  { key: 'stony_shore', name: 'Stony Shore', map: '#8c8c8c', ground: '#8b8985', rock: '#77756f', top: 'stone', filler: 'stone', trees: [{ type: 'boulder', weight: 1 }], treeDensity: 0.05 },
  { key: 'plains', name: 'Plains', map: '#8db360', ground: '#86b05a', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'oak', weight: 4 }, { type: 'shrub', weight: 6 }, { type: 'boulder', weight: 1 }], treeDensity: 0.12 },
  { key: 'sunflower_plains', name: 'Sunflower Plains', map: '#b6c35a', ground: '#93b65a', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'oak', weight: 2 }, { type: 'shrub', weight: 8 }], treeDensity: 0.12 },
  { key: 'snowy_plains', name: 'Snowy Plains', map: '#f2f5f8', ground: '#eef2f5', rock: '#8a8c90', top: 'snow', filler: 'dirt', trees: [{ type: 'spruce', weight: 1 }], treeDensity: 0.05, snowy: true },
  { key: 'ice_spikes', name: 'Ice Spikes', map: '#b4dcdc', ground: '#d8edf2', rock: '#9fc7d4', top: 'snow', filler: 'packed_ice', trees: [], treeDensity: 0, snowy: true },
  { key: 'desert', name: 'Desert', map: '#e3cf8f', ground: '#dccb94', rock: '#c4a874', top: 'sand', filler: 'sandstone', trees: [{ type: 'cactus', weight: 5 }, { type: 'shrub', weight: 1 }], treeDensity: 0.05 },
  { key: 'swamp', name: 'Swamp', map: '#4c6b3a', ground: '#5d6e3e', rock: '#5b5a4c', top: 'grass', filler: 'mud', trees: [{ type: 'oak', weight: 3 }, { type: 'shrub', weight: 2 }], treeDensity: 0.35 },
  { key: 'mangrove_swamp', name: 'Mangrove Swamp', map: '#3f6b42', ground: '#566d44', rock: '#5b5a4c', top: 'mud', filler: 'mud', trees: [{ type: 'jungle', weight: 2 }, { type: 'shrub', weight: 2 }], treeDensity: 0.45 },
  { key: 'forest', name: 'Forest', map: '#3f8f3a', ground: '#5c973c', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'oak', weight: 6 }, { type: 'birch', weight: 2 }, { type: 'shrub', weight: 2 }], treeDensity: 0.9 },
  { key: 'flower_forest', name: 'Flower Forest', map: '#6aa84f', ground: '#6ca448', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'oak', weight: 4 }, { type: 'birch', weight: 4 }, { type: 'shrub', weight: 3 }], treeDensity: 0.55 },
  { key: 'birch_forest', name: 'Birch Forest', map: '#6fa860', ground: '#78aa58', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'birch', weight: 8 }, { type: 'shrub', weight: 1 }], treeDensity: 0.8 },
  { key: 'dark_forest', name: 'Dark Forest', map: '#2f5a28', ground: '#4a7034', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'darkoak', weight: 8 }, { type: 'oak', weight: 1 }], treeDensity: 1.3 },
  { key: 'taiga', name: 'Taiga', map: '#3c6e5a', ground: '#5c8858', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'spruce', weight: 8 }, { type: 'shrub', weight: 1 }], treeDensity: 0.9 },
  { key: 'snowy_taiga', name: 'Snowy Taiga', map: '#c9d8d4', ground: '#dde6e4', rock: '#8a8c90', top: 'snow', filler: 'dirt', trees: [{ type: 'spruce', weight: 1 }], treeDensity: 0.6, snowy: true },
  { key: 'old_growth_taiga', name: 'Old Growth Taiga', map: '#4f6b48', ground: '#6b7344', rock: ROCK, top: 'podzol', filler: 'dirt', trees: [{ type: 'spruce', weight: 6 }, { type: 'boulder', weight: 1 }], treeDensity: 1.1 },
  { key: 'savanna', name: 'Savanna', map: '#b5b05a', ground: '#b1aa5a', rock: '#8f7e62', top: 'grass', filler: 'dirt', trees: [{ type: 'acacia', weight: 4 }, { type: 'shrub', weight: 3 }], treeDensity: 0.1 },
  { key: 'savanna_plateau', name: 'Savanna Plateau', map: '#a39c4e', ground: '#a69e56', rock: '#8f7e62', top: 'grass', filler: 'dirt', trees: [{ type: 'acacia', weight: 4 }, { type: 'shrub', weight: 2 }], treeDensity: 0.08 },
  { key: 'jungle', name: 'Jungle', map: '#2f9a2a', ground: '#4ea23a', rock: '#6f7a5c', top: 'grass', filler: 'dirt', trees: [{ type: 'jungle', weight: 6 }, { type: 'shrub', weight: 4 }, { type: 'oak', weight: 1 }], treeDensity: 1.4 },
  { key: 'badlands', name: 'Badlands', map: '#c2683a', ground: '#b8653a', rock: '#a2573a', top: 'red_sand', filler: 'terracotta', trees: [{ type: 'shrub', weight: 1 }, { type: 'cactus', weight: 1 }], treeDensity: 0.02 },
  { key: 'meadow', name: 'Meadow', map: '#7fbf6a', ground: '#82ba6c', rock: ROCK, top: 'grass', filler: 'dirt', trees: [{ type: 'birch', weight: 1 }, { type: 'shrub', weight: 6 }], treeDensity: 0.05 },
  { key: 'grove', name: 'Grove', map: '#a8c8b6', ground: '#dfe9e4', rock: '#8a8c90', top: 'snow', filler: 'dirt', trees: [{ type: 'spruce', weight: 1 }], treeDensity: 0.5, snowy: true },
  { key: 'snowy_slopes', name: 'Snowy Slopes', map: '#e6edf3', ground: '#eef3f7', rock: '#8c8e93', top: 'snow', filler: 'snow', trees: [], treeDensity: 0, snowy: true },
  { key: 'jagged_peaks', name: 'Jagged Peaks', map: '#dce4ee', ground: '#eaeff4', rock: '#7d7c7a', top: 'snow', filler: 'stone', trees: [], treeDensity: 0, snowy: true },
  { key: 'frozen_peaks', name: 'Frozen Peaks', map: '#bfd3ea', ground: '#d6e5f2', rock: '#93a9bf', top: 'packed_ice', filler: 'packed_ice', trees: [], treeDensity: 0, snowy: true },
  { key: 'stony_peaks', name: 'Stony Peaks', map: '#9a9a95', ground: '#8f8d88', rock: '#7d7b77', top: 'stone', filler: 'stone', trees: [], treeDensity: 0 },
  { key: 'windswept_hills', name: 'Windswept Hills', map: '#7d8f6e', ground: '#7d8e6a', rock: '#7a7a76', top: 'grass', filler: 'dirt', trees: [{ type: 'spruce', weight: 2 }, { type: 'oak', weight: 1 }, { type: 'boulder', weight: 1 }], treeDensity: 0.15 },
  { key: 'mushroom_fields', name: 'Mushroom Fields', map: '#9a7fa0', ground: '#8e7a8c', rock: '#7a6f78', top: 'mycelium', filler: 'dirt', trees: [{ type: 'shrub', weight: 1 }], treeDensity: 0.05 },
];

export const BIOMES: BiomeDef[] = defs.map((d, id) => ({ ...d, id }));
export const BIOME_RGB: RGB[] = BIOMES.map((b) => hexToRgb(b.map));
export const BIOME_GROUND_RGB: RGB[] = BIOMES.map((b) => hexToRgb(b.ground));
export const BIOME_ROCK_RGB: RGB[] = BIOMES.map((b) => hexToRgb(b.rock));

const byKey = new Map(BIOMES.map((b) => [b.key, b.id]));
function id(key: string): number {
  const v = byKey.get(key);
  if (v === undefined) throw new Error(`Unknown biome ${key}`);
  return v;
}

export const B = {
  DEEP_OCEAN: id('deep_ocean'),
  OCEAN: id('ocean'),
  WARM_OCEAN: id('warm_ocean'),
  LUKEWARM_OCEAN: id('lukewarm_ocean'),
  COLD_OCEAN: id('cold_ocean'),
  FROZEN_OCEAN: id('frozen_ocean'),
  RIVER: id('river'),
  FROZEN_RIVER: id('frozen_river'),
  BEACH: id('beach'),
  SNOWY_BEACH: id('snowy_beach'),
  STONY_SHORE: id('stony_shore'),
  PLAINS: id('plains'),
  SUNFLOWER_PLAINS: id('sunflower_plains'),
  SNOWY_PLAINS: id('snowy_plains'),
  ICE_SPIKES: id('ice_spikes'),
  DESERT: id('desert'),
  SWAMP: id('swamp'),
  MANGROVE_SWAMP: id('mangrove_swamp'),
  FOREST: id('forest'),
  FLOWER_FOREST: id('flower_forest'),
  BIRCH_FOREST: id('birch_forest'),
  DARK_FOREST: id('dark_forest'),
  TAIGA: id('taiga'),
  SNOWY_TAIGA: id('snowy_taiga'),
  OLD_GROWTH_TAIGA: id('old_growth_taiga'),
  SAVANNA: id('savanna'),
  SAVANNA_PLATEAU: id('savanna_plateau'),
  JUNGLE: id('jungle'),
  BADLANDS: id('badlands'),
  MEADOW: id('meadow'),
  GROVE: id('grove'),
  SNOWY_SLOPES: id('snowy_slopes'),
  JAGGED_PEAKS: id('jagged_peaks'),
  FROZEN_PEAKS: id('frozen_peaks'),
  STONY_PEAKS: id('stony_peaks'),
  WINDSWEPT_HILLS: id('windswept_hills'),
  MUSHROOM_FIELDS: id('mushroom_fields'),
} as const;

/** Everything a classifier may look at for one column. */
export interface ClimateSample {
  /** Final terrain height (m, sea level of the world = settings.seaLevel). */
  height: number;
  continentalness: number;
  erosion: number;
  weirdness: number;
  pv: number;
  temperature: number;
  humidity: number;
  /** 0 … 1, 1 = river centre. */
  river: number;
}

export type BiomeMode = 'minecraft' | 'whittaker' | 'height';

export interface BiomeParams {
  mode: BiomeMode;
  seaLevel: number;
  beachHeight: number;
  /** Height (m above sea) where the "peaks" biomes start regardless of noise. */
  peakHeight: number;
}

/** Minecraft-style level thresholds (from OverworldBiomeBuilder). */
export const LEVELS = {
  temperature: [-0.45, -0.15, 0.2, 0.55],
  humidity: [-0.35, -0.1, 0.1, 0.3],
  erosion: [-0.78, -0.375, -0.2225, 0.05, 0.45, 0.55],
  pv: [-0.85, -0.2, 0.2, 0.7],
  continentalness: [-1.05, -0.455, -0.19, -0.11, 0.03, 0.3],
} as const;

export const CONTINENTALNESS_ZONES = [
  'Mushroom fields',
  'Deep ocean',
  'Ocean',
  'Coast',
  'Near inland',
  'Mid inland',
  'Far inland',
];

export function level(v: number, thresholds: readonly number[]): number {
  let i = 0;
  while (i < thresholds.length && v >= thresholds[i]) i++;
  return i;
}

export const MIDDLE = [
  [B.SNOWY_PLAINS, B.SNOWY_PLAINS, B.SNOWY_PLAINS, B.SNOWY_TAIGA, B.TAIGA],
  [B.PLAINS, B.PLAINS, B.FOREST, B.TAIGA, B.OLD_GROWTH_TAIGA],
  [B.FLOWER_FOREST, B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.DARK_FOREST],
  [B.SAVANNA, B.SAVANNA, B.FOREST, B.JUNGLE, B.JUNGLE],
  [B.DESERT, B.DESERT, B.DESERT, B.DESERT, B.DESERT],
];

// Variant biomes used when weirdness > 0 (null = keep the middle biome).
export const MIDDLE_VARIANT: (number | null)[][] = [
  [B.ICE_SPIKES, null, B.SNOWY_TAIGA, null, null],
  [null, null, null, null, B.OLD_GROWTH_TAIGA],
  [B.SUNFLOWER_PLAINS, null, null, B.BIRCH_FOREST, null],
  [null, null, B.PLAINS, B.JUNGLE, B.JUNGLE],
  [null, null, null, null, null],
];

function oceanFor(tl: number, deep: boolean): number {
  if (tl === 0) return B.FROZEN_OCEAN;
  if (tl === 4) return B.WARM_OCEAN;
  if (deep) return B.DEEP_OCEAN;
  if (tl === 1) return B.COLD_OCEAN;
  if (tl === 3) return B.LUKEWARM_OCEAN;
  return B.OCEAN;
}

export function classifyBiome(s: ClimateSample, p: BiomeParams): number {
  switch (p.mode) {
    case 'whittaker':
      return classifyWhittaker(s, p);
    case 'height':
      return classifyHeight(s, p);
    default:
      return classifyMinecraft(s, p);
  }
}

function classifyMinecraft(s: ClimateSample, p: BiomeParams): number {
  const tl = level(s.temperature, LEVELS.temperature);
  const hl = level(s.humidity, LEVELS.humidity);
  const el = level(s.erosion, LEVELS.erosion);
  const pvl = level(s.pv, LEVELS.pv);
  const above = s.height - p.seaLevel;

  if (above < 0) {
    if (s.river > 0.5 && s.continentalness > -0.19) return tl === 0 ? B.FROZEN_RIVER : B.RIVER;
    return oceanFor(tl, above < -28 || s.continentalness < -0.455);
  }
  if (s.river > 0.6 && above < 2) return tl === 0 ? B.FROZEN_RIVER : B.RIVER;
  if (s.continentalness < -0.9) return B.MUSHROOM_FIELDS;

  if (above < p.beachHeight && s.continentalness < 0.0) {
    if (el <= 2 && pvl >= 2) return B.STONY_SHORE;
    if (tl === 0) return B.SNOWY_BEACH;
    if (tl === 4) return B.DESERT;
    return B.BEACH;
  }

  // Peaks: rough, high ground (or simply very high terrain).
  if ((pvl >= 4 && el <= 1) || above > p.peakHeight) {
    if (tl <= 2) return s.weirdness > 0 && hl >= 2 ? B.FROZEN_PEAKS : B.JAGGED_PEAKS;
    if (tl === 3) return B.STONY_PEAKS;
    return B.BADLANDS;
  }
  // Slopes and plateaus on high, weakly eroded terrain.
  if (pvl >= 3 && el <= 2) {
    if (tl <= 1) return hl <= 1 ? B.SNOWY_SLOPES : B.GROVE;
    if (tl === 2) return B.MEADOW;
    if (tl === 3) return B.SAVANNA_PLATEAU;
    return B.BADLANDS;
  }
  if (tl === 4 && el <= 1 && pvl >= 2) return B.BADLANDS;
  if (el === 5 && pvl >= 3 && s.continentalness > 0.3) return tl <= 2 ? B.WINDSWEPT_HILLS : B.SAVANNA;
  if (el === 6 && above < 10 && tl >= 1) return tl >= 3 ? B.MANGROVE_SWAMP : B.SWAMP;

  if (s.weirdness > 0) {
    const v = MIDDLE_VARIANT[tl][hl];
    if (v !== null) return v;
  }
  return MIDDLE[tl][hl];
}

// Whittaker-style: temperature (cooled by altitude) × moisture.
export const WHITTAKER = [
  [B.STONY_PEAKS, B.SNOWY_PLAINS, B.SNOWY_SLOPES, B.SNOWY_SLOPES, B.SNOWY_SLOPES],
  [B.DESERT, B.WINDSWEPT_HILLS, B.TAIGA, B.TAIGA, B.SNOWY_TAIGA],
  [B.DESERT, B.PLAINS, B.FOREST, B.FOREST, B.DARK_FOREST],
  [B.DESERT, B.SAVANNA, B.SAVANNA, B.JUNGLE, B.JUNGLE],
];

function classifyWhittaker(s: ClimateSample, p: BiomeParams): number {
  const above = s.height - p.seaLevel;
  const tl = level(s.temperature, LEVELS.temperature);
  if (above < 0) return s.river > 0.5 ? B.RIVER : oceanFor(tl, above < -28);
  if (s.river > 0.6 && above < 2) return B.RIVER;
  if (above < p.beachHeight && s.continentalness < 0.0) return tl === 0 ? B.SNOWY_BEACH : B.BEACH;
  const t = s.temperature - Math.max(0, above) / 180;
  const row = t < -0.5 ? 0 : t < -0.1 ? 1 : t < 0.35 ? 2 : 3;
  const col = Math.min(4, Math.max(0, Math.floor((s.humidity + 1) * 2.5)));
  return WHITTAKER[row][col];
}

function classifyHeight(s: ClimateSample, p: BiomeParams): number {
  const above = s.height - p.seaLevel;
  if (above < -25) return B.DEEP_OCEAN;
  if (above < 0) return s.river > 0.5 ? B.RIVER : B.OCEAN;
  if (above < p.beachHeight) return B.BEACH;
  if (above < 45) return B.PLAINS;
  if (above < 100) return B.FOREST;
  if (above < 150) return B.TAIGA;
  if (above < p.peakHeight) return B.STONY_PEAKS;
  return B.SNOWY_SLOPES;
}
