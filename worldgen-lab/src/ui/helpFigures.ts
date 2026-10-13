/**
 * Figures and tables for the "How it works" part of the help.
 *
 * Every plot and image is computed live by the app's own generator code with
 * the default settings and seed, so the pictures always match the code the text
 * explains. SVG plots are drawn at once; canvas figures lay out their tiles
 * immediately and compute the pixels when they are scrolled into view.
 */
import { sampleRamp, smoothstep, type RGB } from '../core/color';
import { DEFAULT_FRACTAL, DomainWarp2, FRACTAL_KINDS, Fractal2, octaveFade, type FractalKind } from '../core/fractal';
import { NOISE_KINDS, Noise, type NoiseKind } from '../core/noise';
import { MonotoneSpline, type SplinePoint } from '../core/spline';
import { BIOMES, CONTINENTALNESS_ZONES, LEVELS, MIDDLE, MIDDLE_VARIANT, WHITTAKER } from '../gen/biomes';
import type { ErosionSnapshot } from '../gen/erosion';
import { renderMapStrip, type MapLayer } from '../gen/map';
import { craterProfile, PlanetGenerator } from '../gen/planet/planetGen';
import { cubeToSphere, renderPlanetMapStrip } from '../gen/planet/planetMesh';
import { derivePlanet, PROFILES } from '../gen/planet/universe';
import { defaultErosion, defaultPlanet, defaultSettings, defaultTerrain, defaultTerrainView, PLANET_TYPES, type ClimateNoise, type PlanetType } from '../gen/settings';
import { LOD_COLORS } from '../gen/shading';
import { peaksAndValleys, TerrainGenerator } from '../gen/terrain';
import { BLOCKS, ORES } from '../gen/voxel/blocks';
import type { FromErosionWorker, ToErosionWorker } from '../workers/protocol';
import { h } from './dom';

const SEED = defaultSettings().seed;
const C = { blue: '#7cc4ff', yellow: '#ffd479', green: '#8fdc7a', red: '#ff8a7a', violet: '#c9a6ff', grey: '#8a93a3' };

/** Lets the browser paint between chunks of figure work. */
const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Lays out a figure in its slot; may return the (expensive) part to run once the figure is visible. */
export type Figure = (slot: HTMLElement) => (() => Promise<void>) | void;

// ───────────────────────────── SVG plots ─────────────────────────────

interface Series {
  f: (x: number) => number;
  color: string;
  label?: string;
  dash?: boolean;
  width?: number;
}

interface PlotSpec {
  title?: string;
  x: [number, number];
  y: [number, number];
  series: Series[];
  xTicks: number[];
  yTicks: number[];
  xLabel?: string;
  yLabel?: string;
  points?: readonly SplinePoint[];
  marks?: { x: number; label?: string }[];
  w?: number;
  h?: number;
}

let clipCounter = 0;

const minus = (s: string) => s.replace('-', '−');
const fmt = (v: number) => minus(Math.abs(v) >= 100 ? v.toFixed(0) : String(Math.round(v * 1000) / 1000));

function plot(s: PlotSpec): string {
  const W = s.w ?? 340;
  const H = s.h ?? 200;
  const ml = s.yLabel ? 46 : 36;
  const mr = 12;
  const mt = s.title ? 26 : 12;
  const mb = s.xLabel ? 36 : 22;
  const [x0, x1] = s.x;
  const [y0, y1] = s.y;
  const X = (x: number) => ml + ((x - x0) / (x1 - x0)) * (W - ml - mr);
  const Y = (y: number) => H - mb - ((y - y0) / (y1 - y0)) * (H - mt - mb);
  const id = `doc-clip-${++clipCounter}`;
  const out = [`<defs><clipPath id="${id}"><rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${H - mt - mb}"/></clipPath></defs>`];
  for (const t of s.yTicks) {
    out.push(`<line class="grid" x1="${ml}" x2="${W - mr}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${ml - 6}" y="${Y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`);
  }
  for (const t of s.xTicks) {
    out.push(`<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${mt}" y2="${H - mb}"/><text x="${X(t)}" y="${H - mb + 14}" text-anchor="middle">${fmt(t)}</text>`);
  }
  if (y0 < 0 && y1 > 0) out.push(`<line class="axis" x1="${ml}" x2="${W - mr}" y1="${Y(0)}" y2="${Y(0)}"/>`);
  for (const m of s.marks ?? []) {
    out.push(`<line class="mark" x1="${X(m.x)}" x2="${X(m.x)}" y1="${mt}" y2="${H - mb}"/>`);
    if (m.label) out.push(`<text class="mark-label" x="${X(m.x) + 4}" y="${mt + 11}">${m.label}</text>`);
  }
  for (const se of s.series) {
    const n = 400;
    let d = '';
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      d += `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(se.f(x)).toFixed(1)}`;
    }
    out.push(
      `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width ?? 1.8}" stroke-linejoin="round"${se.dash ? ' stroke-dasharray="4 3"' : ''} clip-path="url(#${id})"/>`,
    );
  }
  for (const [px, py] of s.points ?? []) {
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) out.push(`<circle class="pt" cx="${X(px)}" cy="${Y(py)}" r="3.2"/>`);
  }
  if (s.title) out.push(`<text class="title" x="${ml}" y="15">${s.title}</text>`);
  if (s.xLabel) out.push(`<text x="${(ml + W - mr) / 2}" y="${H - 6}" text-anchor="middle">${s.xLabel}</text>`);
  if (s.yLabel) out.push(`<text transform="translate(12 ${(mt + H - mb) / 2}) rotate(-90)" text-anchor="middle">${s.yLabel}</text>`);
  // Cap the size so labels never grow much beyond their design size.
  return `<svg class="plot" viewBox="0 0 ${W} ${H}" style="max-width:${Math.round(W * 1.2)}px" role="img"${s.title ? ` aria-label="${s.title}"` : ''}>${out.join('')}</svg>`;
}

function legend(series: Series[]): string {
  const items = series.filter((s) => s.label).map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`);
  return `<div class="plot-legend">${items.join('')}</div>`;
}

// ───────────────────────────── canvas tiles ─────────────────────────────

function tileGrid(slot: HTMLElement, cls = ''): HTMLElement {
  const grid = h('div', { class: `fig-tiles ${cls}` });
  slot.append(grid);
  return grid;
}

function addTile(grid: HTMLElement, label: string, w: number, hgt: number): CanvasRenderingContext2D {
  const canvas = h('canvas', { attrs: { width: String(w), height: String(hgt) } });
  grid.append(h('div', { class: 'tile' }, canvas, h('span', { text: label })));
  return canvas.getContext('2d')!;
}

/** Fills a canvas pixel by pixel; `pixel` writes sRGB values in [0, 1]. */
function paint(ctx: CanvasRenderingContext2D, w: number, hgt: number, pixel: (i: number, j: number, out: RGB) => void): void {
  const img = ctx.createImageData(w, hgt);
  const rgb: RGB = [0, 0, 0];
  for (let j = 0; j < hgt; j++) {
    for (let i = 0; i < w; i++) {
      pixel(i, j, rgb);
      const o = (j * w + i) * 4;
      img.data[o] = rgb[0] * 255;
      img.data[o + 1] = rgb[1] * 255;
      img.data[o + 2] = rgb[2] * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const LIGHT = (() => {
  const v = [-0.55, 0.65, -0.52];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();

/** Lambert term of a heightfield lit from the north-west; `k` = vertical exaggeration / cell size. */
function hillshade(hs: ArrayLike<number>, n: number, i: number, j: number, k: number): number {
  const l = hs[j * n + Math.max(0, i - 1)];
  const r = hs[j * n + Math.min(n - 1, i + 1)];
  const u = hs[Math.max(0, j - 1) * n + i];
  const d = hs[Math.min(n - 1, j + 1) * n + i];
  const nx = (l - r) * k;
  const nz = (u - d) * k;
  return Math.max(0, (nx * LIGHT[0] + 2 * LIGHT[1] + nz * LIGHT[2]) / Math.hypot(nx, 2, nz));
}

const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// ───────────────────────────── figures ─────────────────────────────

const toolbox: Figure = (slot) => {
  const series: Series[] = [
    { f: (t) => t, color: C.grey, label: 'linear', dash: true },
    { f: (t) => smoothstep(0, 1, t), color: C.blue, label: 'smoothstep 3t² − 2t³' },
    { f: (t) => t * t * t * (t * (t * 6 - 15) + 10), color: C.yellow, label: 'quintic fade 6t⁵ − 15t⁴ + 10t³' },
  ];
  slot.innerHTML =
    plot({ x: [0, 1], y: [0, 1], series, xTicks: [0, 0.25, 0.5, 0.75, 1], yTicks: [0, 0.5, 1], xLabel: 't', w: 560, h: 190 }) + legend(series);
};

const NOISE_LABELS: Record<NoiseKind, string> = {
  simplex: 'Simplex',
  perlin: 'Gradient (Perlin)',
  value: 'Value',
  worley: 'Worley (F₁)',
  cells: 'Cells (F₂ − F₁)',
};

const noiseKinds: Figure = (slot) => {
  const N = 112;
  const grid = tileGrid(slot);
  const ctxs = NOISE_KINDS.map((k) => addTile(grid, NOISE_LABELS[k], N, N));
  return async () => {
    const noise = new Noise(1234);
    const span = 6;
    for (let k = 0; k < NOISE_KINDS.length; k++) {
      const kind = NOISE_KINDS[k];
      paint(ctxs[k], N, N, (i, j, out) => {
        const v = (noise.sample2(kind, (i / N) * span, (j / N) * span) + 1) / 2;
        out[0] = out[1] = out[2] = v;
      });
      await idle();
    }
  };
};

const octaves: Figure = (slot) => {
  const W = 640;
  const rowH = 46;
  const gap = 10;
  const ml = 126;
  const noises = [0, 1, 2, 3].map((o) => new Noise(700 + o));
  const oct = (o: number, x: number) => noises[o].simplex2(x * 2 ** o, 0.37 + o * 3.1) * 0.5 ** o;
  const rows = [
    { label: 'octave 1 · f, a = 1', f: (x: number) => oct(0, x), color: C.blue },
    { label: 'octave 2 · 2f, a = ½', f: (x: number) => oct(1, x), color: '#93b9f5' },
    { label: 'octave 3 · 4f, a = ¼', f: (x: number) => oct(2, x), color: '#adaff0' },
    { label: 'octave 4 · 8f, a = ⅛', f: (x: number) => oct(3, x), color: C.violet },
    { label: 'sum ÷ Σa (fBm)', f: (x: number) => (oct(0, x) + oct(1, x) + oct(2, x) + oct(3, x)) / 1.875, color: C.yellow },
  ];
  let g = '';
  rows.forEach((r, k) => {
    const y0 = k * (rowH + gap) + rowH / 2 + gap / 2;
    g += `<line class="axis" x1="${ml}" x2="${W - 8}" y1="${y0}" y2="${y0}"/>`;
    g += `<text x="${ml - 10}" y="${y0 + 3.5}" text-anchor="end">${r.label}</text>`;
    let d = '';
    const n = 640;
    for (let i = 0; i <= n; i++) {
      const x = (4 * i) / n;
      d += `${i ? 'L' : 'M'}${(ml + ((W - 8 - ml) * i) / n).toFixed(1)} ${(y0 - r.f(x) * (rowH / 2)).toFixed(1)}`;
    }
    g += `<path d="${d}" fill="none" stroke="${r.color}" stroke-width="${k === rows.length - 1 ? 2 : 1.5}" stroke-linejoin="round"/>`;
  });
  slot.innerHTML = `<svg class="plot" viewBox="0 0 ${W} ${rows.length * (rowH + gap)}" role="img" aria-label="Octaves of fractal noise">${g}</svg>`;
};

const shapeOctave = (n: number, s: number) => (s > 0 ? n + s * (1 - 2 * Math.abs(n) - n) : n - s * (2 * Math.abs(n) - 1 - n));

const sharpness: Figure = (slot) => {
  const series: Series[] = [
    { f: (n) => shapeOctave(n, -1), color: C.green, label: 'σ = −1 (billow)' },
    { f: (n) => shapeOctave(n, -0.5), color: '#c2e8b4', label: 'σ = −½', width: 1.2 },
    { f: (n) => n, color: C.grey, label: 'σ = 0 (plain)', dash: true },
    { f: (n) => shapeOctave(n, 0.5), color: '#ffc9bf', label: 'σ = ½', width: 1.2 },
    { f: (n) => shapeOctave(n, 1), color: C.red, label: 'σ = 1 (ridged)' },
  ];
  slot.innerHTML =
    plot({ x: [-1, 1], y: [-1, 1], series, xTicks: [-1, -0.5, 0, 0.5, 1], yTicks: [-1, 0, 1], xLabel: 'raw octave value n', yLabel: 'shaped value v', w: 420, h: 240 }) +
    legend(series);
};

const FRACTAL_LABELS: Record<FractalKind, string> = {
  fbm: 'fBm',
  billow: 'Billow',
  ridged: 'Ridged multifractal',
  erosion: 'IQ derivative erosion',
  uber: 'Uber (default detail)',
};

const fractalKinds: Figure = (slot) => {
  const N = 120;
  const grid = tileGrid(slot);
  const ctxs = FRACTAL_KINDS.map((k) => addTile(grid, FRACTAL_LABELS[k], N, N));
  return async () => {
    const detail = defaultTerrain().detail;
    const span = 3;
    const step = span / N;
    const maxFreq = 1 / (2 * step);
    for (let k = 0; k < FRACTAL_KINDS.length; k++) {
      const f = new Fractal2(4242, { ...detail, fractal: FRACTAL_KINDS[k], scale: 1 });
      const hs = new Float64Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hs[j * N + i] = f.sample(i * step, j * step, maxFreq);
      // Stretch each tile to [-1, 1]: derivative-damped types span a much smaller range.
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of hs) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      for (let p = 0; p < hs.length; p++) hs[p] = ((hs[p] - lo) / Math.max(1e-9, hi - lo)) * 2 - 1;
      paint(ctxs[k], N, N, (i, j, out) => {
        const shade = 0.2 + 0.85 * hillshade(hs, N, i, j, 0.16 / step);
        out[0] = out[1] = out[2] = (0.5 + 0.32 * hs[j * N + i]) * shade;
      });
      await idle();
    }
  };
};

const warp: Figure = (slot) => {
  const N = 120;
  const grid = tileGrid(slot);
  const labels = ['No warp', 'Warped once: p + k·q', 'Warped twice: p + k·r'];
  const ctxs = labels.map((l) => addTile(grid, l, N, N));
  return async () => {
    const span = 4;
    const step = span / N;
    const maxFreq = 1 / (2 * step);
    const base = new Fractal2(31, { ...DEFAULT_FRACTAL, scale: 1, octaves: 6 });
    const p = new Float64Array(2);
    for (let k = 0; k < labels.length; k++) {
      const w = k === 0 ? null : new DomainWarp2(32, { enabled: true, strength: 0.55, scale: 1.6, octaves: 3, iterations: k });
      paint(ctxs[k], N, N, (i, j, out) => {
        p[0] = i * step;
        p[1] = j * step;
        if (w) w.apply(p[0], p[1], p, maxFreq);
        sampleRamp('viridis', 0.5 + 0.9 * base.sample(p[0], p[1], maxFreq), out);
      });
      await idle();
    }
  };
};

const octaveFadeFig: Figure = (slot) => {
  const series: Series[] = [{ f: (x) => (x >= 1 ? 0 : octaveFade(x, 1)), color: C.blue }];
  slot.innerHTML = plot({
    x: [0, 1.3],
    y: [0, 1.1],
    series,
    xTicks: [0, 0.25, 0.5, 0.75, 1, 1.25],
    yTicks: [0, 0.5, 1],
    xLabel: 'octave frequency ÷ Nyquist limit of the grid',
    yLabel: 'weight',
    marks: [{ x: 0.5, label: 'fade starts' }, { x: 1, label: 'skipped' }],
    w: 560,
    h: 190,
  });
};

const pvFig: Figure = (slot) => {
  const series: Series[] = [
    { f: (w) => 1 - Math.abs(3 * Math.abs(w) - 2), color: C.grey, label: 'exact fold 1 − |3|W| − 2|', dash: true },
    { f: peaksAndValleys, color: C.blue, label: 'soft fold used by the generator' },
  ];
  slot.innerHTML =
    plot({
      x: [-1, 1],
      y: [-1.1, 1.1],
      series,
      xTicks: [-1, -0.5, 0, 0.5, 1],
      yTicks: [-1, 0, 1],
      xLabel: 'weirdness W',
      yLabel: 'PV',
      marks: [{ x: -2 / 3, label: 'peaks' }, { x: 0, label: 'valley' }, { x: 2 / 3, label: 'peaks' }],
      w: 560,
      h: 210,
    }) + legend(series);
};

const splines: Figure = (slot) => {
  const s = defaultTerrain().splines;
  const curve = (pts: SplinePoint[]) => {
    const sp = new MonotoneSpline(pts);
    return (x: number) => sp.eval(x);
  };
  const ticks = [-1, -0.5, 0, 0.5, 1];
  const plots = [
    plot({
      title: 'Continentalness → base height (m)',
      x: [-1, 1],
      y: [-40, 70],
      series: [{ f: curve(s.continentalness), color: C.blue }],
      points: s.continentalness,
      xTicks: ticks,
      yTicks: [-30, 0, 30, 60],
      marks: LEVELS.continentalness.filter((t) => t > -1).map((x) => ({ x })),
      w: 250,
      h: 180,
    }),
    plot({
      title: 'Erosion → mountain factor',
      x: [-1, 1],
      y: [-0.05, 1.05],
      series: [{ f: curve(s.erosion), color: C.yellow }],
      points: s.erosion,
      xTicks: ticks,
      yTicks: [0, 0.5, 1],
      w: 250,
      h: 180,
    }),
    plot({
      title: 'Peaks & valleys → peak multiplier',
      x: [-1, 1],
      y: [-0.45, 1.05],
      series: [{ f: curve(s.peaks), color: C.green }],
      points: s.peaks,
      xTicks: ticks,
      yTicks: [0, 0.5, 1],
      w: 250,
      h: 180,
    }),
  ];
  slot.innerHTML = `<div class="fig-plots">${plots.join('')}</div>`;
};

const CLIMATE_LAYERS: [MapLayer, string][] = [
  ['continentalness', 'Continentalness'],
  ['erosion', 'Erosion'],
  ['pv', 'Peaks & valleys'],
  ['temperature', 'Temperature'],
  ['biome', 'Biomes'],
  ['shaded', 'Shaded relief'],
];

const climate: Figure = (slot) => {
  const N = 192;
  const grid = tileGrid(slot, 'big');
  const ctxs = CLIMATE_LAYERS.map(([, label]) => addTile(grid, label, N, N));
  return async () => {
    const gen = new TerrainGenerator(SEED, defaultTerrain());
    const view = defaultTerrainView();
    const extent = 8192;
    const rows = 32;
    for (let k = 0; k < CLIMATE_LAYERS.length; k++) {
      for (let r = 0; r < N; r += rows) {
        const res = renderMapStrip(gen, view, {
          x0: -extent / 2,
          z0: -extent / 2,
          scale: extent / N,
          width: N,
          height: N,
          rowStart: r,
          rowEnd: r + rows,
          layer: CLIMATE_LAYERS[k][0],
          histograms: false,
        });
        ctxs[k].putImageData(new ImageData(new Uint8ClampedArray(res.pixels), N, rows), 0, r);
        await idle();
      }
    }
  };
};

const css = (c: RGB) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`;

const quadtree: Figure = (slot) => {
  const view = defaultTerrainView();
  const leaf = view.nodeResolution * view.vertexSpacing;
  const R = view.viewDistance;
  const lambda = view.lodFactor;
  // Same root level and split rule as TerrainMode, for a camera 120 m up over ground at 0–60 m.
  const rootLevel = Math.min(12, Math.max(1, Math.ceil(Math.log2(R / leaf)) - 1));
  const rootSize = leaf * 2 ** rootLevel;
  const cam = { x: 380, y: 120, z: -260 };
  const lo = 0;
  const hi = 60;
  const nodes: { x: number; z: number; s: number; level: number }[] = [];
  const dist = (x: number, z: number, s: number) =>
    Math.hypot(Math.max(x - cam.x, 0, cam.x - (x + s)), Math.max(lo - cam.y, 0, cam.y - hi), Math.max(z - cam.z, 0, cam.z - (z + s)));
  const visit = (x: number, z: number, s: number, level: number): void => {
    if (level > 0 && dist(x, z, s) < lambda * s) {
      const q = s / 2;
      visit(x, z, q, level - 1);
      visit(x + q, z, q, level - 1);
      visit(x, z + q, q, level - 1);
      visit(x + q, z + q, q, level - 1);
    } else {
      nodes.push({ x, z, s, level });
    }
  };
  for (let iz = Math.floor((cam.z - R) / rootSize); iz <= Math.floor((cam.z + R) / rootSize); iz++) {
    for (let ix = Math.floor((cam.x - R) / rootSize); ix <= Math.floor((cam.x + R) / rootSize); ix++) {
      const dx = Math.max(ix * rootSize - cam.x, 0, cam.x - (ix + 1) * rootSize);
      const dz = Math.max(iz * rootSize - cam.z, 0, cam.z - (iz + 1) * rootSize);
      if (dx * dx + dz * dz < R * R) visit(ix * rootSize, iz * rootSize, rootSize, rootLevel);
    }
  }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const counts = new Map<number, number>();
  let rects = '';
  for (const n of nodes) {
    x0 = Math.min(x0, n.x);
    z0 = Math.min(z0, n.z);
    x1 = Math.max(x1, n.x + n.s);
    z1 = Math.max(z1, n.z + n.s);
    counts.set(n.level, (counts.get(n.level) ?? 0) + 1);
    const color = css(LOD_COLORS[Math.min(LOD_COLORS.length - 1, n.level)]);
    rects += `<rect x="${n.x}" y="${n.z}" width="${n.s}" height="${n.s}" fill="${color}" fill-opacity="0.78" stroke="#0a0d12" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`;
  }
  const svg =
    `<svg class="plot quadtree" viewBox="${x0} ${z0} ${x1 - x0} ${z1 - z0}" role="img" aria-label="Quadtree tiles around the camera">${rects}` +
    `<circle cx="${cam.x}" cy="${cam.z}" r="${R}" fill="none" stroke="#e7eaf0" stroke-width="1.2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${cam.x}" cy="${cam.z}" r="${rootSize / 28}" fill="#fff" stroke="#0a0d12" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
  const items = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, n]) => `<span><i style="background:${css(LOD_COLORS[Math.min(LOD_COLORS.length - 1, level)])}"></i>${leaf * 2 ** level} m × ${n}</span>`);
  slot.innerHTML = `<div class="fig-narrow">${svg}</div><div class="plot-legend">${items.join('')}<span>${nodes.length} tiles in total</span></div>`;
};

const cubeSphere: Figure = (slot) => {
  const n = 12;
  const maps: [string, (a: number, b: number, out: number[]) => void][] = [
    [
      'Normalised cube c / ‖c‖',
      (a, b, out) => {
        const l = Math.hypot(a, b, 1);
        out[0] = a / l;
        out[1] = b / l;
        out[2] = 1 / l;
      },
    ],
    ['Spherified cube (used here)', (a, b, out) => cubeToSphere(4, a, b, out)],
  ];
  const panels = maps.map(([label, map]) => {
    const pts: number[][][] = [];
    for (let j = 0; j <= n; j++) {
      const row: number[][] = [];
      for (let i = 0; i <= n; i++) {
        const o = [0, 0, 0];
        map(-1 + (2 * i) / n, -1 + (2 * j) / n, o);
        row.push(o);
      }
      pts.push(row);
    }
    const tri = (a: number[], b: number[], c: number[]) => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    };
    const areas: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) areas.push(tri(pts[j][i], pts[j][i + 1], pts[j + 1][i]) + tri(pts[j + 1][i + 1], pts[j + 1][i], pts[j][i + 1]));
    }
    const mean = areas.reduce((s, a) => s + a, 0) / areas.length;
    let polys = '';
    const rgb: RGB = [0, 0, 0];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const corners = [pts[j][i], pts[j][i + 1], pts[j + 1][i + 1], pts[j + 1][i]];
        sampleRamp('diverging', 0.5 + 0.38 * Math.log2(areas[j * n + i] / mean), rgb);
        polys += `<polygon points="${corners.map((p) => `${p[0].toFixed(4)},${(-p[1]).toFixed(4)}`).join(' ')}" fill="${css(rgb)}" stroke="#0a0d12" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`;
      }
    }
    const ratio = Math.max(...areas) / Math.min(...areas);
    return `<div><svg class="plot sphere" viewBox="-0.86 -0.86 1.72 1.72" role="img" aria-label="${label}"><circle r="1" fill="none" stroke="#3a4250" stroke-width="1" vector-effect="non-scaling-stroke"/>${polys}</svg><div class="plot-caption">${label}<br>largest / smallest cell: ${ratio.toFixed(2)}×</div></div>`;
  });
  slot.innerHTML = `<div class="fig-plots two">${panels.join('')}</div>`;
};

const planets: Figure = (slot) => {
  const W = 240;
  const H = 120;
  const types: PlanetType[] = ['lush', 'desert', 'frozen', 'scorched'];
  const grid = tileGrid(slot, 'wide');
  const specs = types.map((type, i) => {
    const p = defaultPlanet();
    p.planet = i;
    derivePlanet(SEED, p, type);
    return p;
  });
  const ctxs = specs.map((p) => addTile(grid, `${p.name} · ${p.type}`, W, H));
  return async () => {
    const rows = 8;
    for (let k = 0; k < specs.length; k++) {
      const gen = new PlanetGenerator(SEED, specs[k]);
      for (let r = 0; r < H; r += rows) {
        const px = renderPlanetMapStrip(gen, specs[k], W, H, r, r + rows);
        ctxs[k].putImageData(new ImageData(new Uint8ClampedArray(px), W, rows), 0, r);
        await idle();
      }
    }
  };
};

const crater: Figure = (slot) => {
  slot.innerHTML = plot({
    x: [0, 2],
    y: [-1.05, 0.45],
    series: [{ f: craterProfile, color: C.yellow }],
    xTicks: [0, 0.5, 1, 1.5, 2],
    yTicks: [-1, -0.5, 0],
    xLabel: 't = distance from the centre ÷ crater radius',
    yLabel: 'c(t)',
    marks: [{ x: 1, label: 'rim' }, { x: 1.8, label: 'cut-off' }],
    w: 560,
    h: 190,
  });
};

/** The region the Erosion mode picks on its first visit: largest relief, mostly land, near the origin. */
function ruggedRegion(gen: TerrainGenerator, extent: number, sea: number): [number, number] {
  let best = { score: -Infinity, x: 0, z: 0 };
  for (let i = -5; i <= 5; i++) {
    for (let j = -5; j <= 5; j++) {
      const cx = i * extent * 0.8;
      const cz = j * extent * 0.8;
      let lo = Infinity;
      let hi = -Infinity;
      let land = 0;
      for (let a = 0; a < 5; a++) {
        for (let b = 0; b < 5; b++) {
          const v = gen.height(cx + (a / 4 - 0.5) * extent * 0.7, cz + (b / 4 - 0.5) * extent * 0.7);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
          if (v > sea) land++;
        }
      }
      const score = hi - lo + land * 4 - Math.hypot(i, j) * 6;
      if (score > best.score) best = { score, x: Math.round(cx), z: Math.round(cz) };
    }
  }
  return [best.x, best.z];
}

function drawSnapshot(ctx: CanvasRenderingContext2D, s: ErosionSnapshot, sea: number, extent: number, relief: number): void {
  const N = s.size;
  const k = 2.5 / (extent / (N - 1));
  paint(ctx, N, N, (i, j, out) => {
    const p = j * N + i;
    const shade = 1 - relief + relief * (0.3 + 0.85 * hillshade(s.heights, N, i, j, k));
    for (let c = 0; c < 3; c++) out[c] = toSrgb(s.colors[p * 3 + c]) * shade;
    if (relief === 1 && s.heights[p] < sea) {
      const a = s.water[p * 4 + 3];
      for (let c = 0; c < 3; c++) out[c] += (toSrgb(s.water[p * 4 + c]) - out[c]) * a;
    }
  });
}

/**
 * Runs the Erosion mode's own worker with its default settings (256² grid,
 * 300 000 droplets) and streams the result into the tiles.
 */
const erosion: Figure = (slot) => {
  const settings = defaultSettings();
  const e = settings.erosion;
  const N = e.resolution;
  const sea = settings.terrain.seaLevel;
  const grid = tileGrid(slot);
  const labels = ['Before', 'After the droplets', 'Water flow (log scale)', 'Eroded (blue) · deposited (red)'];
  const ctxs = labels.map((l) => addTile(grid, l, N, N));
  const note = h('p', { class: 'fig-note', text: 'Waiting to start…' });
  slot.append(note);
  return async () => {
    [e.centerX, e.centerZ] = ruggedRegion(new TerrainGenerator(SEED, settings.terrain), e.extent, sea);
    const worker = new Worker(new URL('../workers/erosion.worker.ts', import.meta.url), { type: 'module', name: 'help-erosion' });
    const inbox: FromErosionWorker[] = [];
    let wake: (() => void) | null = null;
    worker.onmessage = (ev: MessageEvent<FromErosionWorker>) => {
      inbox.push(ev.data);
      wake?.();
    };
    const next = async (): Promise<ErosionSnapshot & { done: boolean }> => {
      while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      const msg = inbox.shift()!;
      if (msg.type === 'error') throw new Error(msg.message);
      return { ...msg.snapshot, done: msg.done };
    };
    try {
      worker.postMessage({ type: 'init', settings, run: false } satisfies ToErosionWorker);
      drawSnapshot(ctxs[0], await next(), sea, e.extent, 1);
      worker.postMessage({ type: 'run' } satisfies ToErosionWorker);
      let snap: ErosionSnapshot & { done: boolean };
      do {
        snap = await next();
        drawSnapshot(ctxs[1], snap, sea, e.extent, 1);
        note.textContent = `Eroding… ${Math.round((snap.droplets / e.hydraulic.maxDroplets) * 100)} %`;
      } while (!snap.done);
      worker.postMessage({ type: 'params', erosion: { ...e, colorMode: 'flow' } } satisfies ToErosionWorker);
      drawSnapshot(ctxs[2], await next(), sea, e.extent, 0);
      worker.postMessage({ type: 'params', erosion: { ...e, colorMode: 'erosion' } } satisfies ToErosionWorker);
      drawSnapshot(ctxs[3], await next(), sea, e.extent, 0.35);
      note.textContent = `${snap.droplets.toLocaleString('en-US')} droplets on a ${N}² grid over ${e.extent} m around (${e.centerX}, ${e.centerZ}). Mean height change: ${snap.meanChange.toFixed(2)} m.`;
    } finally {
      worker.terminate();
    }
  };
};

export const FIGURES: Record<string, Figure> = {
  toolbox,
  noise: noiseKinds,
  octaves,
  sharpness,
  fractals: fractalKinds,
  warp,
  octaveFade: octaveFadeFig,
  pv: pvFig,
  splines,
  climate,
  quadtree,
  cubeSphere,
  planets,
  crater,
  erosion,
};

// ───────────────────────────── tables ─────────────────────────────

function table(head: string[], rows: string[][], cls = ''): string {
  const th = head.map((x) => `<th>${x}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="doc-table-wrap"><table class="doc-table ${cls}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

const num = (v: number) => minus(String(v));
const biomeCell = (id: number) => `<span class="swatch" style="background:${BIOMES[id].map}"></span>${BIOMES[id].name}`;

export const TABLES: Record<string, () => string> = {
  climate: () => {
    const t = defaultTerrain();
    const rows: [string, string, ClimateNoise][] = [
      ['Continentalness <i>C</i>', 'ocean ↔ far inland; base height', t.continentalness],
      ['Erosion <i>E</i>', 'mountainous ↔ flat', t.erosion],
      ['Weirdness <i>W</i>', 'peaks & valleys, rivers, biome variants', t.weirdness],
      ['Temperature <i>T</i>', 'biomes, snow line', t.temperature],
      ['Humidity <i>H</i>', 'biomes', t.humidity],
    ];
    return table(
      ['Layer', 'Controls', 'Wavelength', 'Octaves', 'Contrast <i>A</i>'],
      rows.map(([name, what, c]) => [name, what, `${c.scale} m`, String(c.octaves), String(c.amplitude)]),
    );
  },
  levels: () =>
    table(
      ['Value', 'Level thresholds', 'Levels'],
      [
        ['Temperature <i>T</i>', LEVELS.temperature.map(num).join(', '), '0 frozen … 4 hot'],
        ['Humidity <i>H</i>', LEVELS.humidity.map(num).join(', '), '0 arid … 4 humid'],
        ['Erosion <i>E</i>', LEVELS.erosion.map(num).join(', '), '0 mountainous … 6 flat'],
        ['Peaks & valleys', LEVELS.pv.map(num).join(', '), '0 valleys … 4 peaks'],
        ['Continentalness <i>C</i>', LEVELS.continentalness.map(num).join(', '), CONTINENTALNESS_ZONES.join(' · ')],
      ],
    ),
  middle: () => {
    const rows = MIDDLE.map((row, t) => [
      `<b>T${t}</b>`,
      ...row.map((id, hum) => {
        const v = MIDDLE_VARIANT[t][hum];
        return biomeCell(id) + (v !== null && v !== id ? `<small>W &gt; 0: ${biomeCell(v)}</small>` : '');
      }),
    ]);
    return table(['', 'H0 (arid)', 'H1', 'H2', 'H3', 'H4 (humid)'], rows, 'biome-grid');
  },
  whittaker: () => {
    const rowLabels = ['T′ &lt; −0.5', '−0.5 ≤ T′ &lt; −0.1', '−0.1 ≤ T′ &lt; 0.35', 'T′ ≥ 0.35'];
    const rows = WHITTAKER.map((row, r) => [`<b>${rowLabels[r]}</b>`, ...row.map(biomeCell)]);
    return table(['', 'H &lt; −0.6', '−0.6 … −0.2', '−0.2 … 0.2', '0.2 … 0.6', 'H ≥ 0.6'], rows, 'biome-grid');
  },
  ores: () => {
    const total = ORES.reduce((s, o) => s + o.chance, 0);
    return table(
      ['Ore', 'Height range (y)', 'Share of ore cells'],
      ORES.map((o) => [BLOCKS[o.id].name, `${num(o.minY)} … ${num(o.maxY)}`, `${((o.chance / total) * 100).toFixed(1)} %`]),
    );
  },
  planetTypes: () => {
    const total = PLANET_TYPES.reduce((s, t) => s + PROFILES[t].weight, 0);
    const yes = (b: boolean) => (b ? '✓' : '–');
    return table(
      ['Type', 'Weight', 'Probability', 'Sea level', 'Liquid', 'Atmosphere', 'Craters', 'Terraces'],
      PLANET_TYPES.map((t) => {
        const p = PROFILES[t];
        return [
          `<b>${t}</b>`,
          String(p.weight),
          `${((p.weight / total) * 100).toFixed(1)} %`,
          `${num(p.seaLevel[0])} … ${num(p.seaLevel[1])}`,
          p.ocean.enabled ? (p.ocean.lava ? 'lava' : 'water') : 'none',
          yes(p.atmosphere.enabled),
          yes(p.craters),
          yes(p.terraces),
        ];
      }),
    );
  },
  erosion: () => {
    const e = defaultErosion();
    const p = e.hydraulic;
    return table(
      ['Parameter', 'Symbol', 'Default', 'Effect'],
      [
        ['Inertia', 'ι', String(p.inertia), 'how much a droplet keeps its direction'],
        ['Sediment capacity', '<i>K</i><sub>c</sub>', String(p.capacity), 'how much a fast, steep droplet can carry'],
        ['Minimum capacity', '<i>c</i><sub>min</sub>', String(p.minCapacity), 'keeps eroding on nearly flat ground'],
        ['Erode speed', '<i>K</i><sub>e</sub>', String(p.erodeSpeed), 'fraction of the free capacity taken per step'],
        ['Deposit speed', '<i>K</i><sub>d</sub>', String(p.depositSpeed), 'fraction of the excess dropped per step'],
        ['Evaporation', '<i>e</i>', String(p.evaporateSpeed), 'water lost per step'],
        ['Gravity', '<i>g</i>', String(p.gravity), 'how strongly a drop speeds up downhill'],
        ['Lifetime', '', `${p.maxLifetime} steps`, 'maximum path length'],
        ['Erosion radius', '<i>r</i>', `${p.radius} cells`, 'width of the erosion brush'],
        ['Talus angle', 'θ', `${e.thermal.talusAngle}°`, 'steepest slope loose material keeps (thermal)'],
        ['Thermal strength', 'σ', String(e.thermal.strength), 'share of the excess moved per sweep'],
      ],
    );
  },
};
