/** Block definitions for the voxel mode. Colors are sRGB hex per face group. */
import { hexToRgb, srgbToLinear } from '../../core/color';

export interface BlockDef {
  key: string;
  name: string;
  top: string;
  side: string;
  bottom: string;
  /** Collides with the player. */
  solid: boolean;
  /** Hides the faces of neighbouring blocks and casts ambient occlusion. */
  opaque: boolean;
  liquid?: 'water' | 'lava';
  emissive?: boolean;
  /** Shown in the block picker. */
  placeable?: boolean;
}

const b = (key: string, name: string, top: string, side = top, bottom = side, extra: Partial<BlockDef> = {}): BlockDef => ({
  key,
  name,
  top,
  side,
  bottom,
  solid: true,
  opaque: true,
  ...extra,
});

export const BLOCKS: BlockDef[] = [
  b('air', 'Air', '#000000', '#000000', '#000000', { solid: false, opaque: false }),
  b('stone', 'Stone', '#7f7f7f', '#7a7a7a', '#727272', { placeable: true }),
  b('dirt', 'Dirt', '#8a6142', '#86603f', '#7d5a3b', { placeable: true }),
  b('grass', 'Grass Block', '#79b34a', '#7c7845', '#86603f', { placeable: true }),
  b('sand', 'Sand', '#dccf9d', '#d6c996', '#cfc290', { placeable: true }),
  b('sandstone', 'Sandstone', '#d9c993', '#d0bf86', '#c8b77e', { placeable: true }),
  b('gravel', 'Gravel', '#88817c', '#837c78', '#7c7672'),
  b('snow', 'Snow', '#f5f8fa', '#e9eef2', '#dde3e8', { placeable: true }),
  b('ice', 'Ice', '#a9c8f0', '#9cbce6', '#93b2dc'),
  b('water', 'Water', '#3e74d6', '#3a6cc8', '#3466be', { solid: false, opaque: false, liquid: 'water' }),
  b('lava', 'Lava', '#f06a1e', '#e85e18', '#d95414', { solid: false, opaque: false, liquid: 'lava', emissive: true }),
  b('bedrock', 'Bedrock', '#3b3b3b', '#363636', '#303030'),
  b('deepslate', 'Deepslate', '#55555b', '#4e4e54', '#48484e', { placeable: true }),
  b('oak_log', 'Oak Log', '#a8885a', '#6a5232', '#a8885a', { placeable: true }),
  b('oak_leaves', 'Oak Leaves', '#4a8a30', '#44822c', '#3e7a28', { placeable: true }),
  b('birch_log', 'Birch Log', '#c9b585', '#dcd9d2', '#c9b585'),
  b('birch_leaves', 'Birch Leaves', '#6a9a40', '#64923c', '#5e8a38'),
  b('spruce_log', 'Spruce Log', '#735a39', '#3f2f1d', '#735a39'),
  b('spruce_leaves', 'Spruce Leaves', '#355f3f', '#30583a', '#2b5035'),
  b('cactus', 'Cactus', '#63a63c', '#4f8f2f', '#4a862c'),
  b('coal_ore', 'Coal Ore', '#4b4b4b', '#474747', '#424242'),
  b('iron_ore', 'Iron Ore', '#b49a86', '#ad937f', '#a58b78'),
  b('gold_ore', 'Gold Ore', '#dcc35a', '#d4bb52', '#ccb34b'),
  b('diamond_ore', 'Diamond Ore', '#5fd6dc', '#57cdd3', '#4fc4ca'),
  b('redstone_ore', 'Redstone Ore', '#b8392b', '#ae3327', '#a42e23'),
  b('lapis_ore', 'Lapis Ore', '#3456b0', '#2f4fa6', '#2b489c'),
  b('copper_ore', 'Copper Ore', '#b77650', '#ad6e4a', '#a36744'),
  b('red_sand', 'Red Sand', '#c0692a', '#b86426', '#ae5e23'),
  b('terracotta', 'Terracotta', '#a05e40', '#9a593c', '#925438'),
  b('terracotta_orange', 'Orange Terracotta', '#a8592a', '#a25428', '#9a5026'),
  b('terracotta_yellow', 'Yellow Terracotta', '#bb8a3c', '#b38438', '#ab7e35'),
  b('terracotta_white', 'White Terracotta', '#d3b4a4', '#cbad9d', '#c3a696'),
  b('terracotta_brown', 'Brown Terracotta', '#5a3c2a', '#553927', '#503624'),
  b('terracotta_red', 'Red Terracotta', '#933f30', '#8c3c2d', '#85392b'),
  b('terracotta_light', 'Light Gray Terracotta', '#8b6d63', '#85685e', '#7f6359'),
  b('podzol', 'Podzol', '#6c4c25', '#7a5838', '#86603f'),
  b('mycelium', 'Mycelium', '#76666e', '#7b6a62', '#86603f'),
  b('mud', 'Mud', '#3d3a3a', '#3a3737', '#363333'),
  b('packed_ice', 'Packed Ice', '#8fb5ec', '#88aee4', '#81a7dc'),
  b('acacia_log', 'Acacia Log', '#a85d36', '#686056', '#a85d36'),
  b('acacia_leaves', 'Acacia Leaves', '#6d9432', '#678c2f', '#61842c'),
  b('jungle_log', 'Jungle Log', '#9c7b4b', '#57451c', '#9c7b4b'),
  b('jungle_leaves', 'Jungle Leaves', '#3c952a', '#388c27', '#348325'),
  b('dark_oak_log', 'Dark Oak Log', '#523c24', '#3e2a14', '#523c24'),
  b('dark_oak_leaves', 'Dark Oak Leaves', '#2f6122', '#2c5a20', '#29531d'),
  b('cobblestone', 'Cobblestone', '#7c7c7c', '#767676', '#707070', { placeable: true }),
  b('planks', 'Oak Planks', '#a7864f', '#a2814c', '#9a7a48', { placeable: true }),
  b('bricks', 'Bricks', '#9a5444', '#944f40', '#8c4a3c', { placeable: true }),
  b('glowstone', 'Glowstone', '#f6d886', '#f1d27c', '#ebcb73', { placeable: true, emissive: true }),
  b('clay', 'Clay', '#a2a8b6', '#9da3b1', '#989eab'),
];

export const BLOCK_COUNT = BLOCKS.length;
const ids = new Map(BLOCKS.map((d, i) => [d.key, i]));

export function blockId(key: string): number {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`Unknown block ${key}`);
  return id;
}

export const AIR = 0;
export const STONE = blockId('stone');
export const DIRT = blockId('dirt');
export const GRASS = blockId('grass');
export const SAND = blockId('sand');
export const SANDSTONE = blockId('sandstone');
export const GRAVEL = blockId('gravel');
export const SNOW = blockId('snow');
export const ICE = blockId('ice');
export const WATER = blockId('water');
export const LAVA = blockId('lava');
export const BEDROCK = blockId('bedrock');
export const DEEPSLATE = blockId('deepslate');
export const RED_SAND = blockId('red_sand');
export const CACTUS = blockId('cactus');
export const MUD = blockId('mud');
export const COBBLESTONE = blockId('cobblestone');

export const TERRACOTTA_BANDS = [
  'terracotta',
  'terracotta_orange',
  'terracotta_yellow',
  'terracotta_white',
  'terracotta_brown',
  'terracotta_red',
  'terracotta_light',
  'terracotta_orange',
  'terracotta',
].map(blockId);

export const ORES: { id: number; minY: number; maxY: number; chance: number }[] = [
  { id: blockId('coal_ore'), minY: 0, maxY: 192, chance: 0.014 },
  { id: blockId('copper_ore'), minY: -16, maxY: 112, chance: 0.008 },
  { id: blockId('iron_ore'), minY: -64, maxY: 72, chance: 0.01 },
  { id: blockId('gold_ore'), minY: -64, maxY: 32, chance: 0.0035 },
  { id: blockId('redstone_ore'), minY: -64, maxY: 16, chance: 0.006 },
  { id: blockId('lapis_ore'), minY: -64, maxY: 64, chance: 0.003 },
  { id: blockId('diamond_ore'), minY: -64, maxY: 16, chance: 0.0022 },
];

/** Linear-space face colors: [id][face group: 0 top, 1 side, 2 bottom][rgb]. */
export const FACE_RGB = new Float32Array(BLOCK_COUNT * 9);
BLOCKS.forEach((d, i) => {
  [d.top, d.side, d.bottom].forEach((hex, g) => {
    const c = hexToRgb(hex);
    for (let k = 0; k < 3; k++) FACE_RGB[i * 9 + g * 3 + k] = srgbToLinear(c[k]);
  });
});

export const OPAQUE = new Uint8Array(BLOCKS.map((d) => (d.opaque ? 1 : 0)));
export const SOLID = new Uint8Array(BLOCKS.map((d) => (d.solid ? 1 : 0)));
export const EMISSIVE = new Uint8Array(BLOCKS.map((d) => (d.emissive ? 1 : 0)));
