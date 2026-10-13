/**
 * Controls & concepts overlay (H / ?). Shown automatically on the first visit.
 * The "How it works" section below the quick reference (helpDocs.ts, with KaTeX)
 * is loaded the first time the overlay opens.
 */
import { h } from './dom';

const SEEN_KEY = 'worldgen-lab:seen-help';

export class Help {
  readonly root: HTMLElement;
  isOpen = false;
  private readonly body: HTMLElement;
  private docs: Promise<HTMLElement | null> | null = null;

  constructor() {
    const body = (this.body = h('div', { class: 'help-body' }));
    body.innerHTML = `
      <section>
        <h3>Worlds</h3>
        <table>
          <tr><td>⛰ Terrain</td><td>Infinite heightmap streamed as a quadtree of LOD tiles. Minecraft-style climate noise → splines → biomes, rivers, uber-noise detail, vegetation.</td></tr>
          <tr><td>▦ Voxel</td><td>Blocks from a 3D density field: overhangs, cheese / spaghetti / noodle caves, ores, trees, lava. Break and place blocks — edits are stored as deltas.</td></tr>
          <tr><td>◍ Planet</td><td>No Man's Sky style: galaxy seed → region → system → planet. Fly from orbit to the surface with continuous LOD.</td></tr>
          <tr><td>≋ Erosion</td><td>Watch droplet (hydraulic) and thermal erosion carve a finite map in real time.</td></tr>
        </table>
      </section>
      <section>
        <h3>Camera</h3>
        <table>
          <tr><td><kbd>O</kbd> Orbit</td><td>Drag to rotate, right-drag to pan, wheel to zoom, <kbd>WASD</kbd> to glide, <kbd>Q</kbd>/<kbd>E</kbd> to turn.</td></tr>
          <tr><td><kbd>F</kbd> Fly</td><td>Click to capture the mouse. <kbd>WASD</kbd> move, <kbd>Space</kbd>/<kbd>E</kbd> up, <kbd>Q</kbd>/<kbd>C</kbd> down, <kbd>Shift</kbd> boost, wheel = speed, <kbd>Esc</kbd> releases. On planets: <kbd>Z</kbd>/<kbd>X</kbd> roll.</td></tr>
          <tr><td><kbd>G</kbd> Walk</td><td>Gravity, <kbd>Space</kbd> to jump or swim up, <kbd>Shift</kbd> sprint. Auto-steps up single blocks.</td></tr>
          <tr><td><kbd>T</kbd> Tour</td><td>Autopilot glides over the land (spins the globe on planets).</td></tr>
        </table>
      </section>
      <section>
        <h3>Keys</h3>
        <table>
          <tr><td><kbd>M</kbd></td><td>World map with layers (relief, biomes, raw noises)</td></tr>
          <tr><td><kbd>K</kbd></td><td>Spline editor (continentalness, erosion, peaks & valleys)</td></tr>
          <tr><td><kbd>R</kbd></td><td>Random seed (◀ Previous in the panel goes back)</td></tr>
          <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Time of day −/+ 30 min</td></tr>
          <tr><td><kbd>P</kbd></td><td>Screenshot</td></tr>
          <tr><td><kbd>U</kbd></td><td>Hide / show all UI</td></tr>
          <tr><td><kbd>H</kbd> <kbd>?</kbd></td><td>This help</td></tr>
        </table>
      </section>
      <section>
        <h3>Voxel editing</h3>
        <table>
          <tr><td>Left click</td><td>Break the highlighted block</td></tr>
          <tr><td>Right click</td><td>Place the selected block</td></tr>
          <tr><td>Middle click</td><td>Pick the block type</td></tr>
          <tr><td><kbd>1</kbd>–<kbd>9</kbd></td><td>Select a hotbar slot</td></tr>
        </table>
      </section>
      <section class="wide">
        <h3>How to experiment</h3>
        <ul>
          <li>Everything is a pure function of <b>(seed, position)</b> — change a slider and the world regenerates around you, nearest tiles first, while the old tiles stay visible.</li>
          <li>Set <b>Color by</b> in <i>Terrain rendering</i> to a climate noise (continentalness, erosion, PV…) to see exactly what each layer contributes, or open the map (<kbd>M</kbd>) and switch layers.</li>
          <li>The <b>HUD</b> (top left) shows the climate values and biome under the view; the spline editor marks the same values on its curves.</li>
          <li>Try the presets (Amplified, Archipelago, Badlands, Alien…), then share the result with <b>Share</b> — the link encodes every setting.</li>
        </ul>
      </section>`;
    const close = h('button', { class: 'btn primary', text: 'Start exploring', on: { click: () => this.close() } });
    const more = h('button', {
      class: 'btn',
      text: 'How it works ↓',
      title: 'The mathematics and algorithms behind the worlds',
      on: { click: () => this.showDocs() },
    });
    const card = h('div', { class: 'card help-card' }, h('header', {}, h('h2', { text: 'Worldgen Lab — controls & concepts' }), more, close), body);
    this.root = h('div', { class: 'overlay', attrs: { role: 'dialog', 'aria-label': 'Help' } }, card);
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  /** Opens on the first visit only. */
  maybeShowFirstTime(): void {
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      /* storage unavailable */
    }
    if (!seen) this.open();
  }

  open(): void {
    this.isOpen = true;
    this.root.classList.add('open');
    void this.loadDocs();
  }

  /** Loads the "How it works" section once; it is appended below the quick reference. */
  private loadDocs(): Promise<HTMLElement | null> {
    if (!this.docs) {
      const placeholder = h('section', { class: 'wide help-doc-loading', text: 'Loading “How it works”…' });
      this.body.append(placeholder);
      this.docs = import('./helpDocs')
        .then((m) => m.mountHelpDocs(this.body, this.body))
        .catch((err) => {
          console.error('[help] could not load the docs', err);
          this.docs = null;
          return null;
        })
        .finally(() => placeholder.remove());
    }
    return this.docs;
  }

  private showDocs(): void {
    void this.loadDocs().then((docs) => docs?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
}
