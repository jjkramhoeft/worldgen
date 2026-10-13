/**
 * A small pool of generation workers with a priority queue.
 * Priorities are re-evaluated whenever a worker becomes free, so jobs closest
 * to the camera always go first, and jobs that are no longer wanted are
 * dropped before they reach a worker.
 */
import type { AppSettings } from '../gen/settings';
import type { FromGenWorker, JobKind, JobPayloads, JobResults, ToGenWorker } from '../workers/protocol';

export interface JobOptions {
  /** Lower runs first. A function is re-evaluated each time the queue is scanned. */
  priority?: number | (() => number);
  /** Returns false when the job is no longer needed. */
  valid?: () => boolean;
}

interface Job {
  id: number;
  kind: JobKind;
  payload: unknown;
  priority: () => number;
  valid: () => boolean;
  resolve: (r: { result: unknown; version: number } | null) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  version: number;
  started: number;
}

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private settings: AppSettings | null = null;
  private version = 0;
  readonly stats = { completed: 0, errors: 0, avgMs: 0 };

  constructor(size = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('../workers/gen.worker.ts', import.meta.url), { type: 'module', name: `gen-${i}` });
      const slot: Slot = { worker, job: null, version: -1, started: 0 };
      worker.onmessage = (e: MessageEvent<FromGenWorker>) => this.onMessage(slot, e.data);
      worker.onerror = (e) => console.error('[worker]', e.message);
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  get queued(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.slots.filter((s) => s.job).length;
  }

  /** Publishes a new settings snapshot; workers pick it up before their next job. */
  setSettings(settings: AppSettings, version: number): void {
    this.settings = structuredClone(settings);
    this.version = version;
    this.pump();
  }

  run<K extends JobKind>(kind: K, payload: JobPayloads[K], opts: JobOptions = {}): Promise<{ result: JobResults[K]; version: number } | null> {
    return new Promise((resolve, reject) => {
      const p = opts.priority;
      this.queue.push({
        id: this.nextId++,
        kind,
        payload,
        priority: typeof p === 'function' ? p : () => p ?? 0,
        valid: opts.valid ?? (() => true),
        resolve: resolve as Job['resolve'],
        reject,
      });
      this.pump();
    });
  }

  /** Resolves (with null) and removes queued jobs of the given kinds. */
  cancel(kinds: JobKind[]): void {
    const keep: Job[] = [];
    for (const job of this.queue) {
      if (kinds.includes(job.kind)) job.resolve(null);
      else keep.push(job);
    }
    this.queue = keep;
  }

  private pump(): void {
    if (!this.settings) return;
    for (const slot of this.slots) {
      if (slot.job) continue;
      const job = this.takeBest();
      if (!job) return;
      if (slot.version !== this.version) {
        slot.worker.postMessage({ type: 'settings', version: this.version, settings: this.settings } satisfies ToGenWorker);
        slot.version = this.version;
      }
      slot.job = job;
      slot.started = performance.now();
      slot.worker.postMessage({ type: 'job', id: job.id, kind: job.kind, payload: job.payload } satisfies ToGenWorker);
    }
  }

  private takeBest(): Job | null {
    let best = -1;
    let bestPriority = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      if (!job.valid()) {
        this.queue.splice(i--, 1);
        job.resolve(null);
        continue;
      }
      const p = job.priority();
      if (p < bestPriority) {
        bestPriority = p;
        best = i;
      }
    }
    return best < 0 ? null : this.queue.splice(best, 1)[0];
  }

  private onMessage(slot: Slot, msg: FromGenWorker): void {
    const job = slot.job;
    slot.job = null;
    if (job && job.id === msg.id) {
      if (msg.type === 'result') {
        const ms = performance.now() - slot.started;
        this.stats.completed++;
        this.stats.avgMs = this.stats.avgMs * 0.9 + ms * 0.1;
        job.resolve({ result: msg.result, version: msg.version });
      } else {
        this.stats.errors++;
        console.error('[worker job failed]', msg.message);
        job.reject(new Error(msg.message));
      }
    }
    this.pump();
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    this.queue = [];
  }
}
