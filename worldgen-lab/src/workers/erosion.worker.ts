/// Erosion worker: runs the droplet simulation in time slices and streams snapshots.
import type { AppSettings } from '../gen/settings';
import { TerrainGenerator } from '../gen/terrain';
import { ErosionSim } from '../gen/erosion';
import { collectTransferables, type FromErosionWorker, type ToErosionWorker } from './protocol';

let sim: ErosionSim | null = null;
let settings: AppSettings | null = null;
let running = false;
let lastSnapshot = 0;

const post = (msg: FromErosionWorker) => (self as unknown as Worker).postMessage(msg, collectTransferables(msg));

function done(): boolean {
  return !!sim && !!settings && sim.droplets >= settings.erosion.hydraulic.maxDroplets;
}

function send(): void {
  if (!sim) return;
  lastSnapshot = performance.now();
  post({ type: 'snapshot', snapshot: sim.snapshot(), running, done: done() });
}

function loop(): void {
  if (!running || !sim || !settings) return;
  const e = settings.erosion;
  const start = performance.now();
  while (performance.now() - start < 40) {
    if (done()) {
      running = false;
      break;
    }
    if (e.hydraulic.enabled) sim.erode(Math.min(e.hydraulic.dropletsPerFrame, e.hydraulic.maxDroplets - sim.droplets));
    else sim.droplets += e.hydraulic.dropletsPerFrame;
    if (e.thermal.enabled) sim.thermal();
  }
  if (!running || performance.now() - lastSnapshot > 140) send();
  if (running) setTimeout(loop, 0);
}

self.addEventListener('message', (ev: MessageEvent<ToErosionWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        settings = msg.settings;
        sim = new ErosionSim(new TerrainGenerator(settings.seed, settings.terrain), settings.erosion);
        running = msg.run;
        send();
        if (running) setTimeout(loop, 0);
        break;
      case 'params':
        if (!settings || !sim) return;
        settings = { ...settings, erosion: msg.erosion };
        sim.setSettings(msg.erosion);
        if (!running) send();
        break;
      case 'run':
        if (!sim || running) return;
        running = true;
        setTimeout(loop, 0);
        break;
      case 'pause':
        running = false;
        send();
        break;
      case 'step':
        if (!sim || !settings) return;
        sim.erode(msg.droplets);
        if (settings.erosion.thermal.enabled) sim.thermal();
        send();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});
