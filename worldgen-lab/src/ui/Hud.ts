/** Top-left overlay: FPS graph, renderer stats, mode stats and a probe of the ground under the view. */
import type { App } from '../app/App';
import { MODES } from '../gen/settings';
import { BIOMES } from '../gen/biomes';
import { h } from './dom';

export class Hud {
  readonly root: HTMLElement;
  private readonly title = h('h3');
  private readonly sub = h('div', { class: 'sub' });
  private readonly fpsEl = h('div', { class: 'fps' });
  private readonly graph = h('canvas', { attrs: { width: '200', height: '52' } });
  private readonly perf = h('dl', { class: 'collapsible' });
  private readonly stats = h('dl', { class: 'section collapsible' });
  private readonly probeTitle = h('div', { class: 'probe-title' });
  private readonly probe = h('dl');
  private readonly history: number[] = [];
  private acc = 0;
  private frames = 0;
  private lastText = 0;
  fps = 0;

  constructor(private readonly app: App) {
    this.root = h(
      'div',
      { class: 'hud glass ui' },
      this.title,
      this.sub,
      h('div', { class: 'perf collapsible' }, this.fpsEl, this.graph),
      this.perf,
      this.stats,
      h('div', { class: 'section' }, this.probeTitle, this.probe),
    );
    this.root.title = 'Click to collapse';
    this.root.addEventListener('click', () => this.root.classList.toggle('collapsed'));
  }

  frame(dt: number): void {
    this.acc += dt;
    this.frames++;
    this.history.push(dt * 1000);
    if (this.history.length > 100) this.history.shift();
    if (this.acc >= 0.5) {
      this.fps = this.frames / this.acc;
      this.acc = 0;
      this.frames = 0;
    }
    const now = performance.now();
    if (now - this.lastText > 220) {
      this.lastText = now;
      this.updateText();
    }
    this.drawGraph();
  }

  private drawGraph(): void {
    const c = this.graph;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width;
    const hh = c.height;
    ctx.clearRect(0, 0, w, hh);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    const y16 = hh - (16.7 / 50) * hh;
    ctx.moveTo(0, y16);
    ctx.lineTo(w, y16);
    ctx.stroke();
    ctx.strokeStyle = '#7cc4ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.history.forEach((ms, i) => {
      const x = (i / 99) * w;
      const y = hh - Math.min(1, ms / 50) * hh;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  private updateText(): void {
    const app = this.app;
    const m = MODES.find((x) => x.id === app.settings.mode)!;
    this.title.textContent = `${m.icon}  ${m.label}`;
    this.sub.textContent = `seed “${app.settings.seed}” · ${app.cameraChoice()} camera${app.rig.mode !== 'orbit' ? ` · speed ×${app.rig.speedScale.toFixed(2)}` : ''}`;
    const ms = this.history.length ? this.history.reduce((a, b) => a + b, 0) / this.history.length : 0;
    this.fpsEl.innerHTML = `${Math.round(this.fps)}<small> fps</small>`;
    const info = app.renderer.info;
    const rows: [string, string][] = [
      ['Frame', `${ms.toFixed(1)} ms`],
      ['Draw calls', `${info.render.calls}`],
      ['Triangles', formatCount(info.render.triangles)],
      ['Workers', `${app.pool.active}/${app.pool.size} busy · ${app.pool.queued} queued`],
    ];
    fill(this.perf, rows);
    fill(this.stats, app.mode.stats());

    const probe = app.mode.probe();
    this.probeTitle.replaceChildren();
    if (probe) {
      const biome = BIOMES.find((b) => b.name === probe.title);
      if (biome) this.probeTitle.append(h('span', { class: 'swatch', style: `background:${biome.map}` }));
      this.probeTitle.append(probe.title);
      fill(this.probe, probe.rows);
    }
    this.root.style.display = app.settings.render.hud ? '' : 'none';
  }
}

function fill(dl: HTMLElement, rows: [string, string][]): void {
  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v, title: v })]));
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return String(n);
}
