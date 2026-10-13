import { describe, expect, it } from 'vitest';
import { TerrainGenerator, emptySample } from '../src/gen/terrain';
import { TERRAIN_PRESETS, defaultSettings, assignDeep, mergeSettings, diffSettings } from '../src/gen/settings';
import { MonotoneSpline } from '../src/core/spline';
import { PlanetGenerator, emptyPlanetSample } from '../src/gen/planet/planetGen';
import { derivePlanet } from '../src/gen/planet/universe';
import { Rng } from '../src/core/rng';

/**
 * Finds the largest height change between samples 5 cm apart along random lines,
 * then bisects that interval 24 times, always following the half with the bigger
 * change. On a continuous surface the change shrinks towards zero (it halves
 * per step once the interval is small); a tear in the terrain would keep it.
 */
function continuity(gen: TerrainGenerator, lines = 40, steps = 400, dx = 0.05): { worst: number; residual: number } {
  const rng = new Rng(99);
  let worst = 0;
  let at = [0, 0, 0, 0];
  for (let l = 0; l < lines; l++) {
    const x0 = rng.range(-4000, 4000);
    const z0 = rng.range(-4000, 4000);
    const a = rng.range(0, Math.PI * 2);
    const ca = Math.cos(a) * dx;
    const sa = Math.sin(a) * dx;
    let prev = gen.height(x0, z0);
    for (let i = 1; i < steps; i++) {
      const h = gen.height(x0 + ca * i, z0 + sa * i);
      if (Math.abs(h - prev) > worst) {
        worst = Math.abs(h - prev);
        at = [x0 + ca * (i - 1), z0 + sa * (i - 1), x0 + ca * i, z0 + sa * i];
      }
      prev = h;
    }
  }
  let [ax, az, bx, bz] = at;
  for (let d = 0; d < 24; d++) {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    const ha = gen.height(ax, az);
    const hm = gen.height(mx, mz);
    const hb = gen.height(bx, bz);
    if (Math.abs(hm - ha) > Math.abs(hb - hm)) {
      bx = mx;
      bz = mz;
    } else {
      ax = mx;
      az = mz;
    }
  }
  return { worst, residual: Math.abs(gen.height(bx, bz) - gen.height(ax, az)) };
}

describe('terrain generator', () => {
  it('is continuous for the default settings and every preset', () => {
    for (const preset of TERRAIN_PRESETS) {
      const s = defaultSettings();
      preset.apply(s);
      const { worst, residual } = continuity(new TerrainGenerator(s.seed, s.terrain));
      // No tears: after 24 bisections (≈ 3 nm) the steepest step must have vanished.
      expect(residual, preset.name).toBeLessThan(1e-3);
      // And no absurd cliffs (terrace risers are deliberately steep): under 8 m per 5 cm.
      expect(worst, preset.name).toBeLessThan(8);
    }
  });

  it('is deterministic and seed dependent', () => {
    const s = defaultSettings();
    const a = new TerrainGenerator('alpha', s.terrain);
    const b = new TerrainGenerator('alpha', s.terrain);
    const c = new TerrainGenerator('beta', s.terrain);
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      expect(a.height(i * 37, i * -19)).toBe(b.height(i * 37, i * -19));
      diff += Math.abs(a.height(i * 37, i * -19) - c.height(i * 37, i * -19));
    }
    expect(diff).toBeGreaterThan(10);
  });

  it('produces a sensible mix of land, ocean and biomes', () => {
    const s = defaultSettings();
    const gen = new TerrainGenerator(s.seed, s.terrain);
    const smp = emptySample();
    const biomes = new Set<number>();
    let land = 0;
    const N = 4000;
    const rng = new Rng(5);
    for (let i = 0; i < N; i++) {
      gen.sample(rng.range(-20000, 20000), rng.range(-20000, 20000), smp);
      if (smp.height > s.terrain.seaLevel) land++;
      biomes.add(smp.biome);
    }
    const landRatio = land / N;
    expect(landRatio).toBeGreaterThan(0.35);
    expect(landRatio).toBeLessThan(0.85);
    expect(biomes.size).toBeGreaterThan(12);
  });

  it('fades octaves on coarse grids without changing the large-scale height', () => {
    const s = defaultSettings();
    const gen = new TerrainGenerator(s.seed, s.terrain);
    const rng = new Rng(11);
    let total = 0;
    for (let i = 0; i < 500; i++) {
      const x = rng.range(-5000, 5000);
      const z = rng.range(-5000, 5000);
      total += Math.abs(gen.height(x, z) - gen.height(x, z, 32));
    }
    // Coarse samples lose detail but stay close on average.
    expect(total / 500).toBeLessThan(8);
  });
});

describe('splines', () => {
  it('interpolates through the control points without overshoot', () => {
    const pts: [number, number][] = [
      [-1, 0],
      [-0.5, 0],
      [0, 10],
      [0.5, 10],
      [1, 20],
    ];
    const sp = new MonotoneSpline(pts);
    for (const [x, y] of pts) expect(sp.eval(x)).toBeCloseTo(y, 6);
    for (let x = -1; x <= 1; x += 0.01) {
      const v = sp.eval(x);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(20 + 1e-9);
    }
    // Flat segment stays flat (monotone).
    expect(sp.eval(-0.75)).toBeCloseTo(0, 6);
  });
});

describe('settings helpers', () => {
  it('assignDeep keeps nested object identity', () => {
    const a = defaultSettings();
    const warp = a.terrain.warp;
    const b = defaultSettings();
    b.terrain.warp.strength = 999;
    assignDeep(a, b);
    expect(a.terrain.warp).toBe(warp);
    expect(a.terrain.warp.strength).toBe(999);
  });

  it('mergeSettings tolerates missing and wrongly typed keys', () => {
    const merged = mergeSettings(defaultSettings(), { seed: 42, terrain: { seaLevel: 12, splines: 'nope' } });
    expect(merged.seed).toBe(defaultSettings().seed);
    expect(merged.terrain.seaLevel).toBe(12);
    expect(Array.isArray(merged.terrain.splines.continentalness)).toBe(true);
  });

  it('diffSettings only keeps changed values', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    b.terrain.seaLevel = 5;
    expect(diffSettings(a, b)).toEqual({ terrain: { seaLevel: 5 } });
  });
});

describe('planets', () => {
  it('derives deterministic, varied planets from coordinates', () => {
    const types = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const p = defaultSettings().planet;
      p.system = i;
      derivePlanet('galaxy', p);
      const q = defaultSettings().planet;
      q.system = i;
      derivePlanet('galaxy', q);
      expect(q.name).toBe(p.name);
      expect(q.type).toBe(p.type);
      types.add(p.type);
    }
    expect(types.size).toBeGreaterThan(4);
  });

  it('planet elevation is continuous on the sphere', () => {
    const s = defaultSettings();
    const gen = new PlanetGenerator(s.seed, s.planet);
    const smp = emptyPlanetSample();
    const rng = new Rng(3);
    let worst = 0;
    for (let l = 0; l < 30; l++) {
      const lat = rng.range(-1.4, 1.4);
      const lon0 = rng.range(-Math.PI, Math.PI);
      let prev = NaN;
      for (let i = 0; i < 300; i++) {
        const lon = lon0 + i * 2e-5;
        const e = gen.sample(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon), smp);
        if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(e - prev));
        prev = e;
      }
    }
    expect(worst).toBeLessThan(0.02);
  });
});
