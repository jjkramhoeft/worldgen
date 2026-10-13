import type { App } from '../app/App';
import { BLOCKS } from '../gen/voxel/blocks';
import { HOTBAR } from '../modes/VoxelMode';
import { h, isTyping, Toasts } from './dom';
import { Help } from './Help';
import { Hud } from './Hud';
import { MapOverlay } from './MapOverlay';
import { Minimap } from './Minimap';
import { Panel } from './Panel';
import { SplineEditor } from './SplineEditor';
import { Toolbar } from './Toolbar';

export class UI {
  readonly toasts = new Toasts();
  readonly toolbar: Toolbar;
  readonly panel: Panel;
  readonly hud: Hud;
  readonly minimap: Minimap;
  readonly map: MapOverlay;
  readonly splines: SplineEditor;
  readonly help: Help;
  private readonly hint = h('div', { class: 'hint glass ui' });
  private readonly pill = h('div', { class: 'pill glass idle ui' });
  private readonly pillText = h('span');
  private readonly hotbar = h('div', { class: 'hotbar glass ui' });
  private readonly hotbarLabel = h('div', { class: 'hotbar-label ui' });
  private readonly hotbarButtons: HTMLButtonElement[] = [];
  private lastSlow = 0;

  constructor(private readonly app: App) {
    this.toolbar = new Toolbar(app, {
      map: () => this.map.toggle(),
      splines: () => this.toggleSplines(),
      screenshot: () => app.screenshot(),
      share: () => app.share(),
      help: () => this.help.toggle(),
      hideUi: () => this.toggleHidden(),
      togglePanel: () => this.togglePanel(),
    });
    this.panel = new Panel(app);
    this.hud = new Hud(app);
    this.minimap = new Minimap(app);
    this.map = new MapOverlay(app);
    this.splines = new SplineEditor(app);
    this.help = new Help();
    this.pill.append(h('div', { class: 'spinner' }), this.pillText);

    HOTBAR.forEach((id, i) => {
      const def = BLOCKS[id];
      const b = h('button', { title: `${def.name} (${i + 1})` }, h('span', { class: 'num', text: String(i + 1) }), h('span', { class: 'cube', style: `background:${def.top}` }));
      b.addEventListener('click', () => (app.modes.voxel.selected = i));
      this.hotbarButtons.push(b);
      this.hotbar.append(b);
    });

    const crosshair = h('div', { class: 'crosshair' });
    app.container.append(
      this.toolbar.root,
      this.panel.root,
      this.hud.root,
      this.pill,
      this.minimap.root,
      this.splines.root,
      this.hint,
      this.hotbar,
      this.hotbarLabel,
      crosshair,
      this.map.root,
      this.help.root,
      this.toasts.root,
    );

    this.minimap.onHistograms = (hist) => this.splines.setHistograms(hist);
    app.rig.onLockChange = (locked) => document.body.classList.toggle('locked', locked);
    window.addEventListener('keydown', this.onKey);
    if (window.innerWidth < 900) document.body.classList.add('panel-collapsed');
  }

  private onKey = (e: KeyboardEvent): void => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const app = this.app;
    switch (e.code) {
      case 'Escape':
        if (this.map.isOpen) this.map.close();
        else if (this.help.isOpen) this.help.close();
        else if (this.splines.isOpen) this.toggleSplines(false);
        return;
      case 'KeyO':
        app.setCameraChoice('orbit');
        break;
      case 'KeyF':
        app.setCameraChoice('fly');
        break;
      case 'KeyG':
        app.setCameraChoice('walk');
        break;
      case 'KeyT':
        app.setCameraChoice(app.cameraChoice() === 'tour' ? 'fly' : 'tour');
        break;
      case 'KeyM':
        this.map.toggle();
        break;
      case 'KeyK':
        this.toggleSplines();
        break;
      case 'KeyH':
        this.help.toggle();
        break;
      case 'Slash':
        if (e.shiftKey) this.help.toggle();
        break;
      case 'KeyU':
        this.toggleHidden();
        break;
      case 'KeyR':
        app.randomSeed();
        break;
      case 'KeyP':
        app.screenshot();
        break;
      case 'BracketLeft':
      case 'BracketRight': {
        const r = app.settings.render;
        r.timeOfDay = (r.timeOfDay + (e.code === 'BracketLeft' ? -0.5 : 0.5) + 24) % 24;
        this.panel.refresh();
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  toggleSplines(open = !this.splines.isOpen): void {
    // The spline editor shapes the Terrain generator (also used by Voxel and Erosion).
    const mode = this.app.settings.mode;
    const flat = mode !== 'planet' && mode !== 'watershed';
    this.splines.setOpen(open && flat);
    this.toolbar.sync(this.splines.isOpen);
  }

  togglePanel(): void {
    document.body.classList.toggle('panel-collapsed');
    requestAnimationFrame(() => this.splines.redraw());
  }

  toggleHidden(): void {
    document.body.classList.toggle('ui-hidden');
  }

  onModeChanged(): void {
    this.panel.onModeChanged();
    if (this.app.settings.mode === 'planet' || this.app.settings.mode === 'watershed') this.splines.setOpen(false);
    this.toolbar.sync(this.splines.isOpen);
    this.minimap.invalidate();
    if (this.map.isOpen) this.map.close();
  }

  onRegenerated(): void {
    this.minimap.invalidate();
  }

  frame(dt: number): void {
    this.hud.frame(dt);
    this.minimap.update();
    this.splines.update();
    const now = performance.now();
    if (now - this.lastSlow < 200) return;
    this.lastSlow = now;
    this.slowUpdate();
  }

  private slowUpdate(): void {
    const app = this.app;
    // The toolbar wraps on narrow windows; keep the HUD just below it.
    const top = Math.round(this.toolbar.root.getBoundingClientRect().bottom + 8);
    document.documentElement.style.setProperty('--top-h', `${top}px`);
    const mode = app.settings.mode;
    const voxel = mode === 'voxel';
    this.hotbar.style.display = voxel ? '' : 'none';
    this.hotbarLabel.style.display = voxel ? '' : 'none';
    if (voxel) {
      const sel = app.modes.voxel.selected;
      this.hotbarButtons.forEach((b, i) => b.classList.toggle('active', i === sel));
      this.hotbarLabel.textContent = BLOCKS[HOTBAR[sel]].name;
    }

    // Generation / simulation progress pill.
    let busy = '';
    const jobs = app.pool.queued + app.pool.active;
    if (mode === 'erosion') {
      const st = app.modes.erosion.status;
      const pct = (st.droplets / app.settings.erosion.hydraulic.maxDroplets) * 100;
      if (st.running) busy = `Eroding… ${pct.toFixed(0)}% · ${st.droplets.toLocaleString()} droplets`;
      this.panel.monitor.erosion = `${st.running ? 'Running' : st.done ? 'Finished' : 'Paused'} · ${pct.toFixed(1)}%\n${st.droplets.toLocaleString()} droplets · mean |Δh| ${st.meanChange.toFixed(2)} m`;
    } else if (jobs > 0) {
      busy = `Generating… ${jobs} job${jobs === 1 ? '' : 's'}`;
    }
    this.pill.classList.toggle('idle', !busy);
    if (busy) this.pillText.textContent = busy;

    this.panel.monitor.edits = `${app.modes.voxel.editCount} edited block${app.modes.voxel.editCount === 1 ? '' : 's'}`;
    const p = app.settings.planet;
    this.panel.monitor.planet = `${p.name}\n${p.type} · radius ${p.radius}${p.rings.enabled ? ' · ringed' : ''} · ${p.moons} moon${p.moons === 1 ? '' : 's'}\nR(${p.region.x},${p.region.y},${p.region.z}) S${p.system} P${p.planet}`;

    this.hint.textContent = this.hintText();
    this.toolbar.sync(this.splines.isOpen);
  }

  private hintText(): string {
    const app = this.app;
    const cam = app.cameraChoice();
    const planet = app.settings.mode === 'planet';
    const locked = app.rig.locked;
    if (planet) {
      if (cam === 'fly') return `${locked ? '' : 'Click to steer · '}WASD thrust · Space/C up/down · Z/X roll · Shift boost · wheel speed ×${app.rig.speedScale.toFixed(2)} · Esc release`;
      return 'Drag to orbit · wheel to change altitude · F to fly down to the surface · M surface map · ◀ ▶ planets in the panel';
    }
    if (cam === 'orbit') {
      const splines = app.settings.mode === 'watershed' ? '' : ' · K splines';
      return `Drag rotate · right-drag pan · wheel zoom · WASD glide · Q/E turn · M map${splines} · H help`;
    }
    if (cam === 'walk') {
      const base = `${locked ? '' : 'Click to look · '}WASD walk · Space jump/swim · Shift sprint`;
      return app.settings.mode === 'voxel' ? `${base} · LMB break · RMB place · 1–9 blocks · Esc release` : `${base} · Esc release`;
    }
    if (cam === 'tour') return `Autopilot · wheel speed ×${app.rig.speedScale.toFixed(2)} · T or F to take control`;
    return `${locked ? '' : 'Click to look · '}WASD fly · Space/E up · Q/C down · Shift boost · wheel speed ×${app.rig.speedScale.toFixed(2)} · Esc release`;
  }
}
