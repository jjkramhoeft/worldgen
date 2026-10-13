import type { App } from '../app/App';
import { MODES, type ModeId } from '../gen/settings';
import { h, LOGO_SVG } from './dom';

export type CameraChoice = 'orbit' | 'fly' | 'walk' | 'tour';

export interface ToolbarActions {
  map(): void;
  splines(): void;
  screenshot(): void;
  share(): void;
  help(): void;
  hideUi(): void;
  togglePanel(): void;
}

const CAMERAS: { id: CameraChoice; label: string; key: string; title: string }[] = [
  { id: 'orbit', label: 'Orbit', key: 'O', title: 'Orbit camera: drag to rotate, right-drag to pan, wheel to zoom, WASD to glide' },
  { id: 'fly', label: 'Fly', key: 'F', title: 'Free flight: click to capture the mouse, WASD + Space/Q, Shift to boost, wheel for speed' },
  { id: 'walk', label: 'Walk', key: 'G', title: 'Walk on the ground with gravity, jumping and swimming' },
  { id: 'tour', label: 'Tour', key: 'T', title: 'Autopilot: glide over the landscape (orbit spin on planets)' },
];

export class Toolbar {
  readonly root: HTMLElement;
  private readonly modeButtons = new Map<ModeId, HTMLButtonElement>();
  private readonly camButtons = new Map<CameraChoice, HTMLButtonElement>();
  private readonly splineBtn: HTMLButtonElement;
  private readonly mapBtn: HTMLButtonElement;

  constructor(
    private readonly app: App,
    actions: ToolbarActions,
  ) {
    const brand = h('div', { class: 'brand glass ui' });
    brand.innerHTML = `${LOGO_SVG}<span>Worldgen Lab</span>`;

    const modes = h('div', { class: 'seg glass ui', attrs: { role: 'tablist', 'aria-label': 'World type' } });
    for (const m of MODES) {
      const b = h('button', { title: m.blurb, attrs: { role: 'tab' } }, h('span', { class: 'glyph', text: m.icon }), m.label);
      b.addEventListener('click', () => app.setMode(m.id));
      this.modeButtons.set(m.id, b);
      modes.append(b);
    }

    const cams = h('div', { class: 'seg glass ui', attrs: { 'aria-label': 'Camera' } });
    for (const c of CAMERAS) {
      const b = h('button', { title: `${c.title} (${c.key})` }, c.label);
      b.addEventListener('click', () => app.setCameraChoice(c.id));
      this.camButtons.set(c.id, b);
      cams.append(b);
    }

    const btn = (label: string, title: string, fn: () => void) => {
      const b = h('button', { class: 'iconbtn', title, text: label });
      b.addEventListener('click', fn);
      return b;
    };
    this.mapBtn = btn('Map', 'World map with layers (M)', actions.map);
    this.splineBtn = btn('Splines', 'Terrain shaping spline editor (K)', actions.splines);
    const tools = h(
      'div',
      { class: 'actions glass ui' },
      this.mapBtn,
      this.splineBtn,
      btn('Screenshot', 'Save a PNG screenshot (P)', actions.screenshot),
      btn('Share', 'Copy a link that recreates this world', actions.share),
      btn('Help', 'Controls and concepts (H)', actions.help),
      btn('Hide UI', 'Hide all panels (U)', actions.hideUi),
      btn('☰', 'Show / hide the settings panel', actions.togglePanel),
    );

    this.root = h('div', { class: 'topbar' }, brand, modes, cams, h('div', { class: 'spacer' }), tools);
    this.sync();
  }

  sync(splinesOpen = false): void {
    const mode = this.app.settings.mode;
    for (const [id, b] of this.modeButtons) {
      b.classList.toggle('active', id === mode);
      b.setAttribute('aria-selected', String(id === mode));
    }
    const choice = this.app.cameraChoice();
    for (const [id, b] of this.camButtons) {
      b.classList.toggle('active', id === choice);
      b.disabled = mode === 'planet' && id === 'walk';
    }
    const flat = mode === 'terrain' || mode === 'voxel' || mode === 'erosion';
    this.splineBtn.disabled = !flat;
    this.splineBtn.classList.toggle('on', splinesOpen);
    this.splineBtn.style.opacity = flat ? '' : '0.35';
    this.mapBtn.style.opacity = mode === 'erosion' ? '0.35' : '';
  }
}
