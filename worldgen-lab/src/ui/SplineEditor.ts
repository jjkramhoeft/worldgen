/**
 * Minecraft-style terrain shaping splines, editable with the mouse:
 *   drag a point · double-click to add · right-click a point to remove.
 * Each graph shows the parameter bands Minecraft's biome builder uses, the
 * distribution of the noise around the camera (histogram) and a marker for
 * the value right under the view.
 */
import type { App } from '../app/App';
import { MonotoneSpline, type SplinePoint } from '../core/spline';
import { defaultTerrain } from '../gen/settings';
import { HIST_BINS } from '../gen/map';
import { h } from './dom';

type SplineKey = 'continentalness' | 'erosion' | 'peaks';

interface CurveDef {
  key: SplineKey;
  title: string;
  hint: string;
  yMin: number;
  yMax: number;
  yLabel: (v: number) => string;
  bands: { to: number; label: string }[];
  histIndex: number;
  zeroLine?: number;
}

const DEFS: CurveDef[] = [
  {
    key: 'continentalness',
    title: 'Continentalness',
    hint: '→ base height (m)',
    yMin: -80,
    yMax: 180,
    yLabel: (v) => `${v.toFixed(0)} m`,
    bands: [
      { to: -1.05, label: '' },
      { to: -0.455, label: 'deep ocean' },
      { to: -0.19, label: 'ocean' },
      { to: -0.11, label: 'coast' },
      { to: 0.03, label: 'near' },
      { to: 0.3, label: 'mid inland' },
      { to: 1, label: 'far inland' },
    ],
    histIndex: 0,
    zeroLine: 0,
  },
  {
    key: 'erosion',
    title: 'Erosion',
    hint: '→ mountain factor',
    yMin: 0,
    yMax: 1.2,
    yLabel: (v) => v.toFixed(2),
    bands: [
      { to: -0.78, label: 'E0' },
      { to: -0.375, label: 'E1' },
      { to: -0.2225, label: 'E2' },
      { to: 0.05, label: 'E3' },
      { to: 0.45, label: 'E4' },
      { to: 0.55, label: 'E5' },
      { to: 1, label: 'E6' },
    ],
    histIndex: 1,
  },
  {
    key: 'peaks',
    title: 'Peaks & valleys',
    hint: '→ peak multiplier',
    yMin: -1,
    yMax: 1.5,
    yLabel: (v) => v.toFixed(2),
    bands: [
      { to: -0.85, label: 'valleys' },
      { to: -0.2, label: 'low' },
      { to: 0.2, label: 'mid' },
      { to: 0.7, label: 'high' },
      { to: 1, label: 'peaks' },
    ],
    histIndex: 2,
    zeroLine: 0,
  },
];

const PAD = { l: 34, r: 8, t: 8, b: 18 };

class Curve {
  readonly root: HTMLElement;
  private readonly canvas = h('canvas');
  private dragIndex = -1;
  private hoverIndex = -1;
  hist: Uint32Array | null = null;
  marker: number | null = null;

  constructor(
    private readonly app: App,
    private readonly def: CurveDef,
  ) {
    const reset = h('button', { class: 'iconbtn', text: 'reset', title: 'Reset this spline', style: 'padding:1px 6px;font-size:11px' });
    reset.addEventListener('click', () => {
      this.points = defaultTerrain().splines[def.key];
      this.app.changed('gen', true);
      this.draw();
    });
    this.root = h('div', { class: 'curve' }, h('div', { class: 'title' }, def.title, h('span', { text: def.hint }), reset), this.canvas);
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('dblclick', this.onDbl);
    this.canvas.addEventListener('contextmenu', this.onContext);
  }

  private get points(): SplinePoint[] {
    return this.app.settings.terrain.splines[this.def.key];
  }

  private set points(p: SplinePoint[]) {
    this.app.settings.terrain.splines[this.def.key] = p;
  }

  private size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || 260;
    const hh = this.canvas.clientHeight || 150;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hh * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hh * dpr);
    }
    return { w, h: hh, dpr };
  }

  private toScreen(x: number, y: number, w: number, hh: number): [number, number] {
    const d = this.def;
    return [PAD.l + ((x + 1) / 2) * (w - PAD.l - PAD.r), PAD.t + (1 - (y - d.yMin) / (d.yMax - d.yMin)) * (hh - PAD.t - PAD.b)];
  }

  private fromScreen(sx: number, sy: number, w: number, hh: number): [number, number] {
    const d = this.def;
    const x = ((sx - PAD.l) / (w - PAD.l - PAD.r)) * 2 - 1;
    const y = d.yMin + (1 - (sy - PAD.t) / (hh - PAD.t - PAD.b)) * (d.yMax - d.yMin);
    return [Math.max(-1, Math.min(1, x)), Math.max(d.yMin, Math.min(d.yMax, y))];
  }

  draw(): void {
    const { w, h: hh, dpr } = this.size();
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const d = this.def;

    // Bands (Minecraft parameter levels).
    let from = -1;
    d.bands.forEach((b, i) => {
      const x0 = this.toScreen(Math.max(-1, from), 0, w, hh)[0];
      const x1 = this.toScreen(b.to, 0, w, hh)[0];
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.0)';
      ctx.fillRect(x0, PAD.t, x1 - x0, hh - PAD.t - PAD.b);
      if (b.label && x1 - x0 > 18) {
        ctx.fillStyle = 'rgba(200,210,225,0.45)';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(b.label, (x0 + x1) / 2, hh - 5);
      }
      from = b.to;
    });

    // Histogram of the noise around the camera.
    if (this.hist) {
      let max = 1;
      for (let i = 0; i < HIST_BINS; i++) max = Math.max(max, this.hist[d.histIndex * HIST_BINS + i]);
      ctx.fillStyle = 'rgba(124,196,255,0.16)';
      for (let i = 0; i < HIST_BINS; i++) {
        const v = this.hist[d.histIndex * HIST_BINS + i] / max;
        const [x0] = this.toScreen(-1 + (i / HIST_BINS) * 2, 0, w, hh);
        const [x1] = this.toScreen(-1 + ((i + 1) / HIST_BINS) * 2, 0, w, hh);
        const top = PAD.t + (1 - v) * (hh - PAD.t - PAD.b);
        ctx.fillRect(x0, top, x1 - x0 - 0.5, hh - PAD.b - top);
      }
    }

    // Axes and grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(200,210,225,0.55)';
    for (let k = 0; k <= 4; k++) {
      const y = d.yMin + ((d.yMax - d.yMin) * k) / 4;
      const [, sy] = this.toScreen(0, y, w, hh);
      ctx.beginPath();
      ctx.moveTo(PAD.l, sy);
      ctx.lineTo(w - PAD.r, sy);
      ctx.stroke();
      ctx.fillText(d.yLabel(y), PAD.l - 4, sy + 3);
    }
    if (d.zeroLine !== undefined) {
      const [, sy] = this.toScreen(0, d.zeroLine, w, hh);
      ctx.strokeStyle = 'rgba(79,164,196,0.7)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(PAD.l, sy);
      ctx.lineTo(w - PAD.r, sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The spline.
    const spline = new MonotoneSpline(this.points);
    ctx.strokeStyle = '#ffd479';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 160; i++) {
      const x = -1 + (i / 160) * 2;
      const [sx, sy] = this.toScreen(x, spline.eval(x), w, hh);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // Marker at the value under the camera.
    if (this.marker !== null) {
      const [sx, sy] = this.toScreen(this.marker, spline.eval(this.marker), w, hh);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, PAD.t);
      ctx.lineTo(sx, hh - PAD.b);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    this.points.forEach(([x, y], i) => {
      const [sx, sy] = this.toScreen(x, y, w, hh);
      ctx.fillStyle = i === this.dragIndex || i === this.hoverIndex ? '#7cc4ff' : '#0d1015';
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, i === this.hoverIndex ? 5.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    if (this.hoverIndex >= 0) {
      const [x, y] = this.points[this.hoverIndex];
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(PAD.l + 4, PAD.t + 2, 118, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(`x ${x.toFixed(3)} · y ${d.yLabel(y)}`, PAD.l + 8, PAD.t + 13);
    }
  }

  private nearest(e: PointerEvent | MouseEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const { w, h: hh } = this.size();
    let best = -1;
    let bestD = 11;
    this.points.forEach(([x, y], i) => {
      const [sx, sy] = this.toScreen(x, y, w, hh);
      const dd = Math.hypot(sx - (e.clientX - rect.left), sy - (e.clientY - rect.top));
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    return best;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.dragIndex = this.nearest(e);
    if (this.dragIndex >= 0) this.canvas.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (this.dragIndex < 0) {
      const hi = this.nearest(e);
      if (hi !== this.hoverIndex) {
        this.hoverIndex = hi;
        this.draw();
      }
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const { w, h: hh } = this.size();
    const [x, y] = this.fromScreen(e.clientX - rect.left, e.clientY - rect.top, w, hh);
    const pts = this.points.map((p) => [...p] as SplinePoint);
    // Keep x strictly between neighbours so the order never flips.
    const lo = this.dragIndex > 0 ? pts[this.dragIndex - 1][0] + 0.005 : -1;
    const hi = this.dragIndex < pts.length - 1 ? pts[this.dragIndex + 1][0] - 0.005 : 1;
    pts[this.dragIndex] = [Math.max(lo, Math.min(hi, x)), y];
    this.points = pts;
    this.hoverIndex = this.dragIndex;
    this.draw();
    this.app.changed('gen', false);
  };

  private onUp = (): void => {
    if (this.dragIndex >= 0) this.app.changed('gen', true);
    this.dragIndex = -1;
  };

  private onDbl = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const { w, h: hh } = this.size();
    const [x, y] = this.fromScreen(e.clientX - rect.left, e.clientY - rect.top, w, hh);
    const pts = [...this.points.map((p) => [...p] as SplinePoint), [x, y] as SplinePoint].sort((a, b) => a[0] - b[0]);
    this.points = pts;
    this.draw();
    this.app.changed('gen', true);
  };

  private onContext = (e: MouseEvent): void => {
    e.preventDefault();
    const i = this.nearest(e);
    if (i < 0 || this.points.length <= 2) return;
    this.points = this.points.filter((_, k) => k !== i);
    this.hoverIndex = -1;
    this.draw();
    this.app.changed('gen', true);
  };
}

export class SplineEditor {
  readonly root: HTMLElement;
  private readonly curves: Curve[];
  isOpen = false;
  private last = 0;

  constructor(private readonly app: App) {
    this.curves = DEFS.map((d) => new Curve(app, d));
    const close = h('button', { class: 'btn', text: 'Close', on: { click: () => app.ui.toggleSplines(false) } });
    this.root = h(
      'div',
      { class: 'splines glass ui' },
      h(
        'header',
        {},
        h('h3', { text: 'Terrain shaping splines' }),
        h('p', { text: 'Drag points · double-click to add · right-click to remove. Bars: noise distribution near you; white line: value under the view.' }),
        close,
      ),
      h('div', { class: 'row' }, ...this.curves.map((c) => c.root)),
    );
  }

  setOpen(open: boolean): void {
    this.isOpen = open;
    this.root.classList.toggle('open', open);
    document.body.classList.toggle('splines-open', open);
    if (open) requestAnimationFrame(() => this.redraw());
  }

  setHistograms(hist: Uint32Array): void {
    for (const c of this.curves) c.hist = hist;
    if (this.isOpen) this.redraw();
  }

  redraw(): void {
    for (const c of this.curves) c.draw();
  }

  update(): void {
    if (!this.isOpen) return;
    const now = performance.now();
    if (now - this.last < 150) return;
    this.last = now;
    const s = this.app.sampleTerrain(...this.app.focusXZ());
    this.curves[0].marker = s.continentalness;
    this.curves[1].marker = s.erosion;
    this.curves[2].marker = s.pv;
    this.redraw();
  }
}
