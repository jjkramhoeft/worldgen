/** Small color helpers shared by workers (vertex colors, map images) and the UI. */

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: RGB): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** out = mix(a, b, t) */
export function mixRgb(out: RGB, a: RGB, b: RGB, t: number): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

type Ramp = RGB[];

function ramp(...hex: string[]): Ramp {
  return hex.map(hexToRgb);
}

export const RAMPS = {
  viridis: ramp('#440154', '#482777', '#3f4a8a', '#31678e', '#26838f', '#1f9d8a', '#6cce5a', '#b6de2b', '#fee825'),
  diverging: ramp('#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'),
  humidity: ramp('#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e'),
  slope: ramp('#1a1d23', '#4a5361', '#9aa5b1', '#f2c14e', '#e4572e'),
  water: ramp('#ffffff', '#9ecae1', '#3182bd', '#08306b'),
} satisfies Record<string, Ramp>;

export type RampName = keyof typeof RAMPS;

/** Samples a ramp at t ∈ [0, 1] into `out`. */
export function sampleRamp(name: RampName, t: number, out: RGB): RGB {
  const r = RAMPS[name];
  const x = clamp01(t) * (r.length - 1);
  const i = Math.min(r.length - 2, Math.floor(x));
  return mixRgb(out, r[i], r[i + 1], x - i);
}
