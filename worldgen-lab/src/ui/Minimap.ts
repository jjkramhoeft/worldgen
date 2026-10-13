/**
 * Bottom-left minimap. Rendered by the workers (same generator as the 3D
 * world), re-requested when the camera moves far enough. Its climate
 * histograms feed the spline editor. Planets get an equirectangular map.
 */
import * as THREE from 'three';
import type { App } from '../app/App';
import { HIST_BINS, MAP_LAYERS, WATERSHED_MAP_LAYERS, type MapLayer } from '../gen/map';
import { h } from './dom';

const RES = 192;
const EXTENTS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];

export class Minimap {
  readonly root: HTMLElement;
  private readonly canvas = h('canvas', { attrs: { width: String(RES * 2), height: String(RES * 2) } });
  private readonly image = document.createElement('canvas');
  private readonly select = h('select', { attrs: { 'aria-label': 'Minimap layer' } });
  private readonly scaleLabel = h('span', { class: 'scale' });
  private extentIndex = 2;
  layer: MapLayer = 'shaded';
  private rendered = { x: NaN, z: NaN, version: -1, layer: '', extent: 0, mode: '' };
  private pending = false;
  private layersFor = '';
  /** Zoom level per world family (Watershed continents need a wider view). */
  private readonly zoom = { terrain: 2, watershed: 6 };
  /** Called with the latest continentalness / erosion / PV histograms. */
  onHistograms: ((h: Uint32Array) => void) | null = null;

  constructor(private readonly app: App) {
    this.image.width = RES;
    this.image.height = RES;
    this.syncLayers();
    this.select.addEventListener('change', () => {
      this.layer = this.select.value as MapLayer;
      this.invalidate();
    });
    const zoom = (d: number) => {
      this.extentIndex = THREE.MathUtils.clamp(this.extentIndex + d, 0, EXTENTS.length - 1);
      this.zoom[this.family()] = this.extentIndex;
      this.invalidate();
    };
    const frame = h('div', { class: 'frame' }, this.canvas);
    frame.addEventListener('click', (e) => this.onClick(e, frame));
    this.root = h(
      'div',
      { class: 'minimap glass ui' },
      frame,
      h(
        'div',
        { class: 'bar' },
        this.select,
        h('button', { class: 'iconbtn', text: '−', title: 'Zoom out', on: { click: () => zoom(1) } }),
        this.scaleLabel,
        h('button', { class: 'iconbtn', text: '+', title: 'Zoom in', on: { click: () => zoom(-1) } }),
      ),
    );
  }

  get extent(): number {
    return EXTENTS[this.extentIndex];
  }

  invalidate(): void {
    this.rendered.version = -1;
  }

  private family(): 'terrain' | 'watershed' {
    return this.app.settings.mode === 'watershed' ? 'watershed' : 'terrain';
  }

  /** Watershed mode has its own layers and zoom. */
  private syncLayers(): void {
    const fam = this.family();
    if (fam === this.layersFor) return;
    this.layersFor = fam;
    this.extentIndex = this.zoom[fam];
    const layers = fam === 'watershed' ? WATERSHED_MAP_LAYERS : MAP_LAYERS;
    this.select.replaceChildren(...layers.map((l) => h('option', { text: l.label, attrs: { value: l.value } })));
    if (!layers.some((l) => l.value === this.layer)) this.layer = 'shaded';
    this.select.value = this.layer;
  }

  private center(): THREE.Vector3 {
    return this.app.rig.mode === 'orbit' ? this.app.rig.orbit.target : this.app.camera.position;
  }

  update(): void {
    const mode = this.app.settings.mode;
    const visible = this.app.settings.render.minimap && mode !== 'erosion';
    this.root.style.display = visible ? '' : 'none';
    if (!visible) return;
    this.syncLayers();
    this.root.classList.toggle('planet', mode === 'planet');
    const wantH = mode === 'planet' ? RES : RES * 2;
    if (this.canvas.height !== wantH) this.canvas.height = wantH;
    this.select.disabled = mode === 'planet';
    this.scaleLabel.textContent = mode === 'planet' ? 'globe' : this.extent >= 1000 ? `${this.extent / 1000} km` : `${this.extent} m`;

    const c = this.center();
    const r = this.rendered;
    const stale =
      r.version !== this.app.genVersion ||
      r.layer !== this.layer ||
      r.extent !== this.extent ||
      r.mode !== mode ||
      (mode !== 'planet' && Math.hypot(c.x - r.x, c.z - r.z) > this.extent * 0.12);
    if (stale && !this.pending) this.request(c.x, c.z);
    this.draw();
  }

  private async request(cx: number, cz: number): Promise<void> {
    this.pending = true;
    const mode = this.app.settings.mode;
    const version = this.app.genVersion;
    const layer = this.layer;
    const extent = this.extent;
    try {
      if (mode === 'planet') {
        const W = RES * 2;
        const H = RES;
        const strips = await Promise.all(
          [0, 1].map((k) => this.app.pool.run('planetMap', { width: W, height: H, rowStart: (k * H) / 2, rowEnd: ((k + 1) * H) / 2 }, { priority: -10 })),
        );
        this.image.width = W;
        this.image.height = H;
        const ctx = this.image.getContext('2d')!;
        for (const s of strips) {
          if (!s) continue;
          const rows = s.result.rowEnd - s.result.rowStart;
          ctx.putImageData(new ImageData(new Uint8ClampedArray(s.result.pixels), W, rows), 0, s.result.rowStart);
        }
      } else {
        const scale = extent / RES;
        const strips = await Promise.all(
          [0, 1].map((k) =>
            this.app.pool.run(
              mode === 'watershed' ? 'watershedMap' : 'map',
              {
                x0: cx - extent / 2,
                z0: cz - extent / 2,
                scale,
                width: RES,
                height: RES,
                rowStart: (k * RES) / 2,
                rowEnd: ((k + 1) * RES) / 2,
                layer,
                histograms: true,
              },
              { priority: -10 },
            ),
          ),
        );
        this.image.width = RES;
        this.image.height = RES;
        const ctx = this.image.getContext('2d')!;
        const hist = new Uint32Array(HIST_BINS * 3);
        for (const s of strips) {
          if (!s) continue;
          const rows = s.result.rowEnd - s.result.rowStart;
          ctx.putImageData(new ImageData(new Uint8ClampedArray(s.result.pixels), RES, rows), 0, s.result.rowStart);
          if (s.result.hist) for (let i = 0; i < hist.length; i++) hist[i] += s.result.hist[i];
        }
        if (mode !== 'watershed') this.onHistograms?.(hist);
      }
      this.rendered = { x: cx, z: cz, version, layer, extent, mode };
    } catch (e) {
      console.error(e);
    } finally {
      this.pending = false;
    }
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.fillStyle = '#0d1015';
    ctx.fillRect(0, 0, W, H);
    const cam = this.app.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());

    if (this.app.settings.mode === 'planet') {
      const ph = W / 2;
      ctx.drawImage(this.image, 0, (H - ph) / 2, W, ph);
      const p = cam.position.clone().normalize();
      const lat = Math.asin(p.y);
      const lon = Math.atan2(p.z, p.x);
      const x = ((lon + Math.PI) / (Math.PI * 2)) * W;
      const y = (H - ph) / 2 + ((Math.PI / 2 - lat) / Math.PI) * ph;
      ctx.fillStyle = '#ffd479';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      return;
    }

    if (!Number.isNaN(this.rendered.x)) {
      const c = this.center();
      const pxPerM = W / this.rendered.extent;
      const ox = (this.rendered.x - c.x) * pxPerM;
      const oz = (this.rendered.z - c.z) * pxPerM;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, ox, oz, W, H);
    }
    // View cone + player arrow at the centre (north = −Z is up).
    const cx = W / 2;
    const cy = H / 2;
    const a = Math.atan2(dir.z, dir.x);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, W * 0.38, a - 0.5, a + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = '#ffd479';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-9, 8);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-9, -8);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '600 20px system-ui';
    ctx.fillText('N', W / 2 - 7, 22);
  }

  private onClick(e: MouseEvent, frame: HTMLElement): void {
    const rect = frame.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    if (this.app.settings.mode === 'planet') {
      const W = rect.width;
      const ph = W / 2;
      const top = (rect.height - ph) / 2;
      const lon = u * Math.PI * 2 - Math.PI;
      const lat = Math.PI / 2 - ((e.clientY - rect.top - top) / ph) * Math.PI;
      this.app.lookAtPlanetPoint(lat, lon);
      return;
    }
    const c = this.center();
    this.app.rig.teleport(c.x + (u - 0.5) * this.extent, c.z + (v - 0.5) * this.extent);
  }
}
