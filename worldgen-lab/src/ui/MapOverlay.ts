/**
 * Full-screen world map (M). Shows any generator layer — shaded relief, biomes
 * or a raw climate noise — rendered in parallel strips by the workers.
 * Drag to pan, wheel to zoom, hover for values, click to travel there.
 */
import type { App } from '../app/App';
import { BIOMES } from '../gen/biomes';
import { MAP_LAYERS, type MapLayer } from '../gen/map';
import { RAMPS, rgbToHex } from '../core/color';
import { h } from './dom';

const R = 512;
const STRIPS = 8;

export class MapOverlay {
  readonly root: HTMLElement;
  private readonly canvas = h('canvas', { attrs: { width: String(R), height: String(R) } });
  private readonly image = document.createElement('canvas');
  private readonly view: HTMLElement;
  private readonly loading = h('div', { class: 'loading', text: 'Rendering…' });
  private readonly legend = h('div', { class: 'legend' });
  private readonly readout = h('div', { class: 'readout' });
  private readonly layerSelect = h('select');
  private readonly title = h('h2', { text: 'World map' });
  private layer: MapLayer = 'shaded';
  private cx = 0;
  private cz = 0;
  private mpp = 8;
  private rendered = { cx: 0, cz: 0, mpp: 8, valid: false };
  private token = 0;
  private renderTimer = 0;
  private drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
  isOpen = false;

  constructor(private readonly app: App) {
    this.image.width = R;
    this.image.height = R;
    for (const l of MAP_LAYERS) this.layerSelect.append(h('option', { text: l.label, attrs: { value: l.value } }));
    this.layerSelect.addEventListener('change', () => {
      this.layer = this.layerSelect.value as MapLayer;
      this.render();
    });
    this.view = h('div', { class: 'map-view' }, this.canvas, this.loading);
    const side = h(
      'div',
      { class: 'map-side' },
      h('div', {}, h('h4', { text: 'Layer' }), this.layerSelect),
      h('div', {}, h('h4', { text: 'Under the cursor' }), this.readout),
      h('div', {}, h('h4', { text: 'Legend' }), this.legend),
      h('p', { class: 'readout', text: 'Drag to pan · wheel to zoom\nClick to travel there · Esc to close', style: 'min-height:0' }),
    );
    const close = h('button', { class: 'btn', text: 'Close', on: { click: () => this.close() } });
    const card = h('div', { class: 'card' }, h('header', {}, this.title, close), h('div', { class: 'map-body' }, this.view, side));
    this.root = h('div', { class: 'overlay', attrs: { role: 'dialog', 'aria-label': 'World map' } }, card);
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });

    this.view.addEventListener('pointerdown', (e) => {
      this.view.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false };
    });
    this.view.addEventListener('pointermove', (e) => {
      const p = this.toWorld(e);
      this.hover(p.x, p.z, p.u, p.v);
      if (!this.drag) return;
      const k = R / this.view.clientWidth;
      const dx = (e.clientX - this.drag.x) * k;
      const dy = (e.clientY - this.drag.y) * k;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (this.isPlanet()) return;
      this.cx = this.drag.cx - dx * this.mpp;
      this.cz = this.drag.cz - dy * this.mpp;
      this.redraw();
    });
    this.view.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.moved) {
        this.scheduleRender();
        return;
      }
      const p = this.toWorld(e);
      if (this.isPlanet()) this.app.lookAtPlanetPoint(p.lat, p.lon);
      else this.app.rig.teleport(p.x, p.z);
      this.close();
    });
    this.view.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.isPlanet()) return;
        const before = this.toWorld(e);
        this.mpp = Math.min(512, Math.max(0.5, this.mpp * (e.deltaY > 0 ? 1.25 : 0.8)));
        const after = this.toWorld(e);
        this.cx += before.x - after.x;
        this.cz += before.z - after.z;
        this.redraw();
        this.scheduleRender();
      },
      { passive: false },
    );
  }

  private isPlanet(): boolean {
    return this.app.settings.mode === 'planet';
  }

  open(): void {
    if (this.app.settings.mode === 'erosion') return;
    this.isOpen = true;
    this.root.classList.add('open');
    this.rendered.valid = false;
    const size = Math.max(280, Math.min(window.innerWidth - 330, window.innerHeight - 140, 820));
    const planet = this.isPlanet();
    this.canvas.width = planet ? R * 2 : R;
    this.canvas.height = R;
    this.image.width = this.canvas.width;
    this.image.height = R;
    this.view.style.width = `${planet ? Math.min(size * 1.6, window.innerWidth - 330) : size}px`;
    this.view.style.height = `${planet ? Math.min(size * 1.6, window.innerWidth - 330) / 2 : size}px`;
    this.layerSelect.disabled = planet;
    this.title.textContent = planet ? `${this.app.settings.planet.name} — surface map` : 'World map';
    const c = this.app.rig.mode === 'orbit' ? this.app.rig.orbit.target : this.app.camera.position;
    this.cx = c.x;
    this.cz = c.z;
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.token++;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private toWorld(e: MouseEvent) {
    const rect = this.view.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    const span = R * this.mpp;
    return {
      u,
      v,
      x: this.cx + (u - 0.5) * span,
      z: this.cz + (v - 0.5) * span,
      lon: u * Math.PI * 2 - Math.PI,
      lat: Math.PI / 2 - v * Math.PI,
    };
  }

  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.render(), 220);
  }

  private async render(): Promise<void> {
    const token = ++this.token;
    this.loading.style.display = '';
    const planet = this.isPlanet();
    const view = { cx: this.cx, cz: this.cz, mpp: this.mpp };
    const W = this.image.width;
    // The first render streams in strip by strip; later renders go to a back
    // buffer so the old (re-projected) image stays visible until the new one is done.
    const progressive = !this.rendered.valid;
    const target = progressive ? this.image : document.createElement('canvas');
    target.width = W;
    target.height = R;
    const ctx = target.getContext('2d')!;
    let lo = 0;
    let hi = 0;
    const jobs = Array.from({ length: STRIPS }, (_, k) => {
      const rowStart = Math.floor((k * R) / STRIPS);
      const rowEnd = Math.floor(((k + 1) * R) / STRIPS);
      const done = (pixels: Uint8ClampedArray, rs: number, re: number) => {
        if (token !== this.token) return;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), W, re - rs), 0, rs);
        if (progressive) {
          this.rendered = { ...view, valid: true };
          this.redraw();
        }
      };
      if (planet) {
        return this.app.pool.run('planetMap', { width: W, height: R, rowStart, rowEnd }, { priority: -20 }).then((r) => r && done(r.result.pixels, r.result.rowStart, r.result.rowEnd));
      }
      return this.app.pool
        .run(
          'map',
          {
            x0: view.cx - (R / 2) * view.mpp,
            z0: view.cz - (R / 2) * view.mpp,
            scale: view.mpp,
            width: R,
            height: R,
            rowStart,
            rowEnd,
            layer: this.layer,
            histograms: false,
          },
          { priority: -20, valid: () => token === this.token },
        )
        .then((r) => {
          if (!r) return;
          lo |= r.result.biomes[0];
          hi |= r.result.biomes[1];
          done(r.result.pixels, r.result.rowStart, r.result.rowEnd);
        });
    });
    await Promise.all(jobs);
    if (token !== this.token) return;
    if (!progressive) {
      const main = this.image.getContext('2d')!;
      main.clearRect(0, 0, W, R);
      main.drawImage(target, 0, 0);
      this.rendered = { ...view, valid: true };
      this.redraw();
    }
    this.loading.style.display = 'none';
    this.updateLegend(lo, hi);
  }

  private redraw(): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#0d1015';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.rendered.valid) return;
    if (this.isPlanet()) {
      ctx.drawImage(this.image, 0, 0);
      this.drawGraticule(ctx);
      return;
    }
    const r = this.rendered;
    const s = r.mpp / this.mpp;
    const x = (r.cx - (R / 2) * r.mpp - (this.cx - (R / 2) * this.mpp)) / this.mpp;
    const y = (r.cz - (R / 2) * r.mpp - (this.cz - (R / 2) * this.mpp)) / this.mpp;
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(this.image, x, y, R * s, R * s);
    // Camera marker.
    const c = this.app.camera.position;
    const px = (c.x - (this.cx - (R / 2) * this.mpp)) / this.mpp;
    const py = (c.z - (this.cz - (R / 2) * this.mpp)) / this.mpp;
    ctx.fillStyle = '#ffd479';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Scale bar.
    const target = 120 * this.mpp;
    const nice = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000].find((n) => n >= target * 0.5) ?? 50000;
    const len = nice / this.mpp;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(10, R - 30, len + 16, 22);
    ctx.fillStyle = '#fff';
    ctx.fillRect(18, R - 16, len, 3);
    ctx.font = '600 11px system-ui';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 18, R - 20);
  }

  private drawGraticule(ctx: CanvasRenderingContext2D): void {
    const W = this.canvas.width;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = ((90 - lat) / 180) * R;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (let lon = -150; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, R);
      ctx.stroke();
    }
    const p = this.app.camera.position.clone().normalize();
    const x = ((Math.atan2(p.z, p.x) + Math.PI) / (Math.PI * 2)) * W;
    const y = ((Math.PI / 2 - Math.asin(p.y)) / Math.PI) * R;
    ctx.fillStyle = '#ffd479';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  private hover(x: number, z: number, u: number, v: number): void {
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    if (this.isPlanet()) {
      const lon = u * 360 - 180;
      const lat = 90 - v * 180;
      const s = this.app.samplePlanet((lat * Math.PI) / 180, (lon * Math.PI) / 180);
      this.readout.textContent = `lat ${lat.toFixed(1)}°  lon ${lon.toFixed(1)}°\nelevation  ${s.elevation.toFixed(3)}\ntemperature ${s.temperature.toFixed(2)}\nhumidity   ${s.humidity.toFixed(2)}`;
      return;
    }
    const s = this.app.sampleTerrain(x, z);
    this.readout.textContent =
      `x ${x.toFixed(0)}  z ${z.toFixed(0)}\n` +
      `${BIOMES[s.biome].name}\n` +
      `height      ${s.height.toFixed(1)} m\n` +
      `continent.  ${s.continentalness.toFixed(3)}\n` +
      `erosion     ${s.erosion.toFixed(3)}\n` +
      `weird / PV  ${s.weirdness.toFixed(2)} / ${s.pv.toFixed(2)}\n` +
      `temp / hum  ${s.temperature.toFixed(2)} / ${s.humidity.toFixed(2)}`;
  }

  private updateLegend(lo: number, hi: number): void {
    this.legend.replaceChildren();
    if (this.isPlanet()) {
      this.legend.append(h('div', { text: 'Equirectangular projection; graticule every 30°.' }));
      return;
    }
    if (this.layer === 'shaded' || this.layer === 'biome') {
      for (const b of BIOMES) {
        const present = b.id < 32 ? (lo >>> b.id) & 1 : (hi >>> (b.id - 32)) & 1;
        if (!present) continue;
        this.legend.append(h('div', {}, h('span', { class: 'swatch', style: `background:${b.map}` }), b.name));
      }
      return;
    }
    const ramp = this.layer === 'humidity' ? RAMPS.humidity : this.layer === 'height' ? RAMPS.viridis : this.layer === 'river' ? RAMPS.water : RAMPS.diverging;
    const stops = ramp.map((c, i) => `${rgbToHex(c)} ${(i / (ramp.length - 1)) * 100}%`).join(',');
    const [a, b] = this.layer === 'height' ? ['−80 m', '340 m'] : this.layer === 'river' ? ['0', '1'] : ['−1', '+1'];
    this.legend.append(
      h('div', { style: `height:12px;border-radius:4px;background:linear-gradient(90deg,${stops})` }),
      h('div', { style: 'display:flex;justify-content:space-between;color:var(--faint)' }, h('span', { text: a }), h('span', { text: b })),
    );
  }
}
