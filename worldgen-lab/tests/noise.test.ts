import { describe, expect, it } from 'vitest';
import { Noise } from '../src/core/noise';
import { seedFromString, Rng } from '../src/core/rng';

function stats(fn: (x: number, y: number, z: number) => number, n = 200_000) {
  const rng = new Rng(1234);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = fn(rng.range(-500, 500), rng.range(-500, 500), rng.range(-500, 500));
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  return { min, max, mean, std: Math.sqrt(sq / n - mean * mean) };
}

describe('noise ranges', () => {
  const noise = new Noise(seedFromString('calibration'));

  it.each([
    ['simplex2', (x: number, y: number) => noise.simplex2(x, y)],
    ['perlin2', (x: number, y: number) => noise.perlin2(x, y)],
    ['value2', (x: number, y: number) => noise.value2(x, y)],
    ['worley2', (x: number, y: number) => noise.cellular2('worley', x, y)],
    ['cells2', (x: number, y: number) => noise.cellular2('cells', x, y)],
    ['simplex3', (x: number, y: number, z: number) => noise.simplex3(x, y, z)],
    ['perlin3', (x: number, y: number, z: number) => noise.perlin3(x, y, z)],
    ['value3', (x: number, y: number, z: number) => noise.value3(x, y, z)],
    ['worley3', (x: number, y: number, z: number) => noise.sample3('worley', x, y, z)],
    ['cells3', (x: number, y: number, z: number) => noise.sample3('cells', x, y, z)],
  ])('%s stays roughly within [-1, 1]', (name, fn) => {
    const s = stats(fn);
    console.log(name, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(4)])));
    expect(s.min).toBeGreaterThan(-1.15);
    expect(s.max).toBeLessThan(1.15);
    expect(Math.abs(s.mean)).toBeLessThan(0.3);
  });
});

describe('analytic derivatives match finite differences', () => {
  const noise = new Noise(42);
  const d = new Float64Array(3);
  const e = 1e-5;

  it.each([
    ['simplex2', (x: number, y: number, out: Float64Array) => noise.simplex2(x, y, out)],
    ['perlin2', (x: number, y: number, out: Float64Array) => noise.perlin2(x, y, out)],
    ['value2', (x: number, y: number, out: Float64Array) => noise.value2(x, y, out)],
  ])('%s', (_name, fn) => {
    const rng = new Rng(7);
    const tmp = new Float64Array(3);
    for (let i = 0; i < 2000; i++) {
      const x = rng.range(-50, 50);
      const y = rng.range(-50, 50);
      fn(x, y, d);
      const ddx = (fn(x + e, y, tmp) - fn(x - e, y, tmp)) / (2 * e);
      const ddy = (fn(x, y + e, tmp) - fn(x, y - e, tmp)) / (2 * e);
      expect(d[0]).toBeCloseTo(ddx, 3);
      expect(d[1]).toBeCloseTo(ddy, 3);
    }
  });

  it('simplex3', () => {
    const rng = new Rng(9);
    const tmp = new Float64Array(3);
    for (let i = 0; i < 2000; i++) {
      const x = rng.range(-50, 50);
      const y = rng.range(-50, 50);
      const z = rng.range(-50, 50);
      noise.simplex3(x, y, z, d);
      const ddx = (noise.simplex3(x + e, y, z, tmp) - noise.simplex3(x - e, y, z, tmp)) / (2 * e);
      const ddy = (noise.simplex3(x, y + e, z, tmp) - noise.simplex3(x, y - e, z, tmp)) / (2 * e);
      const ddz = (noise.simplex3(x, y, z + e, tmp) - noise.simplex3(x, y, z - e, tmp)) / (2 * e);
      expect(d[0]).toBeCloseTo(ddx, 3);
      expect(d[1]).toBeCloseTo(ddy, 3);
      expect(d[2]).toBeCloseTo(ddz, 3);
    }
  });
});

describe('determinism', () => {
  it('same seed gives same values, different seeds differ', () => {
    const a = new Noise(seedFromString('alpha'));
    const b = new Noise(seedFromString('alpha'));
    const c = new Noise(seedFromString('beta'));
    for (let i = 0; i < 100; i++) {
      expect(a.simplex2(i * 0.37, i * 0.11)).toBe(b.simplex2(i * 0.37, i * 0.11));
    }
    let diff = 0;
    for (let i = 0; i < 100; i++) diff += Math.abs(a.simplex2(i * 0.37, 1.5) - c.simplex2(i * 0.37, 1.5));
    expect(diff).toBeGreaterThan(1);
  });

  it('seedFromString follows Java String.hashCode for text and passes numbers through', () => {
    expect(seedFromString('hello')).toBe(99162322);
    expect(seedFromString('12345')).toBe(12345);
  });
});
