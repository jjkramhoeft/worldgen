/// Generation worker: builds terrain nodes, voxel chunks, planet nodes and map strips.
import type { AppSettings } from '../gen/settings';
import { TerrainGenerator } from '../gen/terrain';
import { TerrainShader } from '../gen/shading';
import { buildTerrainNode } from '../gen/terrainMesh';
import { renderMapStrip } from '../gen/map';
import { VoxelGenerator } from '../gen/voxel/voxelGen';
import { PlanetGenerator } from '../gen/planet/planetGen';
import { buildPlanetNode, renderPlanetMapStrip } from '../gen/planet/planetMesh';
import { WatershedGenerator } from '../gen/watershed/watershedGen';
import { WatershedShader } from '../gen/watershed/shading';
import { renderWatershedMapStrip } from '../gen/watershed/map';
import { collectTransferables, type FromGenWorker, type JobPayloads, type ToGenWorker } from './protocol';

let settings: AppSettings | null = null;
let version = 0;
let terrain: { gen: TerrainGenerator; shader: TerrainShader } | null = null;
let watershed: { gen: WatershedGenerator; shader: WatershedShader } | null = null;
let voxel: VoxelGenerator | null = null;
let planet: PlanetGenerator | null = null;

const post = (msg: FromGenWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

function getTerrain(s: AppSettings) {
  if (!terrain) {
    const gen = new TerrainGenerator(s.seed, s.terrain);
    terrain = { gen, shader: new TerrainShader(s.terrain, s.terrainView.colorMode, s.terrainView) };
  }
  return terrain;
}

/** Region networks take a while to build, so a new generator is only made when the world itself changed. */
let watershedKey = '';
let watershedGen: WatershedGenerator | null = null;

function getWatershed(s: AppSettings) {
  if (!watershed) {
    const key = JSON.stringify([s.seed, { ...s.watershed, colorMode: '' }]);
    if (!watershedGen || key !== watershedKey) {
      watershedGen = new WatershedGenerator(s.seed, s.watershed);
      watershedKey = key;
    }
    watershed = { gen: watershedGen, shader: new WatershedShader(s.watershed, s.watershed.colorMode, s.terrainView) };
  }
  return watershed;
}

function getVoxel(s: AppSettings) {
  voxel ??= new VoxelGenerator(s.seed, s.terrain, s.voxel);
  return voxel;
}

function getPlanet(s: AppSettings) {
  planet ??= new PlanetGenerator(s.seed, s.planet);
  return planet;
}

function run(kind: keyof JobPayloads, payload: unknown, s: AppSettings): unknown {
  switch (kind) {
    case 'terrainNode': {
      const t = getTerrain(s);
      return buildTerrainNode(t.gen, t.shader, s.terrainView, payload as JobPayloads['terrainNode']);
    }
    case 'map':
      return renderMapStrip(getTerrain(s).gen, s.terrainView, payload as JobPayloads['map']);
    case 'watershedNode': {
      const w = getWatershed(s);
      return buildTerrainNode(w.gen, w.shader, s.terrainView, payload as JobPayloads['watershedNode']);
    }
    case 'watershedMap':
      return renderWatershedMapStrip(getWatershed(s).gen, s.terrainView, payload as JobPayloads['watershedMap']);
    case 'voxelChunk':
      return getVoxel(s).generate(payload as JobPayloads['voxelChunk']);
    case 'planetNode':
      return buildPlanetNode(getPlanet(s), s.planet, payload as JobPayloads['planetNode']);
    case 'planetMap': {
      const r = payload as JobPayloads['planetMap'];
      return {
        pixels: renderPlanetMapStrip(getPlanet(s), s.planet, r.width, r.height, r.rowStart, r.rowEnd),
        rowStart: r.rowStart,
        rowEnd: r.rowEnd,
      };
    }
  }
}

self.addEventListener('message', (e: MessageEvent<ToGenWorker>) => {
  const msg = e.data;
  if (msg.type === 'settings') {
    settings = msg.settings;
    version = msg.version;
    terrain = null;
    watershed = null;
    voxel = null;
    planet = null;
    return;
  }
  if (!settings) {
    post({ type: 'error', id: msg.id, message: 'No settings received yet' });
    return;
  }
  try {
    const result = run(msg.kind, msg.payload, settings);
    post({ type: 'result', id: msg.id, version, result }, collectTransferables(result));
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  }
});
