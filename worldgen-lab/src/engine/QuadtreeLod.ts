/**
 * Generic quadtree level-of-detail manager.
 *
 * Every update walks the tree from the roots, splitting nodes that are close
 * to the camera. Leaves that have no mesh yet are requested from the worker
 * pool. Until all children of a split node are ready, the (cached) parent mesh
 * stays visible instead, so the world never shows holes while streaming — and
 * when settings change, the old meshes stay on screen until replacements land.
 */
import * as THREE from 'three';

export interface LodNode<D> {
  key: string;
  desc: D;
  object: THREE.Object3D | null;
  /** Generation version of the current object (-1 = none). */
  version: number;
  /** Version currently being generated (-1 = none). */
  pending: number;
  wanted: boolean;
  lastUsed: number;
  /** Optional per-node data kept from the worker result (e.g. vegetation). */
  extra: unknown;
  minH: number;
  maxH: number;
}

export abstract class QuadtreeLod<D, R> {
  readonly group = new THREE.Group();
  protected readonly nodes = new Map<string, LodNode<D>>();
  version = 0;
  cacheLimit = 600;
  visible: LodNode<D>[] = [];
  /** Changes whenever the set of visible node objects changes. */
  visibleSignature = '';
  private frame = 0;
  private disposed = false;

  protected abstract roots(): D[];
  protected abstract children(d: D): D[];
  protected abstract keyOf(d: D): string;
  protected abstract shouldSplit(d: D, node: LodNode<D> | undefined): boolean;
  protected abstract priority(d: D, node: LodNode<D>): number;
  protected abstract request(d: D, node: LodNode<D>, valid: () => boolean): Promise<{ result: R; version: number } | null>;
  protected abstract createObject(d: D, result: R, node: LodNode<D>): THREE.Object3D;

  get nodeCount(): number {
    return this.nodes.size;
  }

  get pendingCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.pending >= 0) n++;
    return n;
  }

  /** Marks every node stale; they are regenerated (closest first) while the old meshes stay visible. */
  invalidate(version: number): void {
    this.version = version;
  }

  update(): void {
    this.frame++;
    for (const n of this.nodes.values()) n.wanted = false;
    const visible: LodNode<D>[] = [];
    for (const root of this.roots()) visible.push(...this.visit(root).list);

    for (const n of this.visible) if (n.object) n.object.visible = false;
    let signature = '';
    for (const n of visible) {
      if (!n.object) continue;
      n.object.visible = true;
      n.lastUsed = this.frame;
      signature += n.key + '@' + n.version + ';';
    }
    this.visible = visible;
    this.visibleSignature = signature;
    this.evict();
  }

  private visit(d: D): { list: LodNode<D>[]; complete: boolean } {
    const key = this.keyOf(d);
    let node = this.nodes.get(key);
    if (!this.shouldSplit(d, node)) {
      if (!node) {
        node = { key, desc: d, object: null, version: -1, pending: -1, wanted: false, lastUsed: this.frame, extra: null, minH: NaN, maxH: NaN };
        this.nodes.set(key, node);
      }
      node.wanted = true;
      this.ensure(node);
      return node.object ? { list: [node], complete: true } : { list: [], complete: false };
    }
    const list: LodNode<D>[] = [];
    let complete = true;
    for (const c of this.children(d)) {
      const r = this.visit(c);
      for (const n of r.list) list.push(n);
      if (!r.complete) complete = false;
    }
    if (complete) return { list, complete };
    if (node?.object) return { list: [node], complete: true };
    return { list, complete: false };
  }

  private ensure(node: LodNode<D>): void {
    if (node.object && node.version >= this.version) return;
    if (node.pending === this.version) return;
    const version = this.version;
    node.pending = version;
    this.request(node.desc, node, () => node.wanted && node.pending === version && !this.disposed)
      .then((res) => {
        if (node.pending === version) node.pending = -1;
        if (!res || this.disposed || this.nodes.get(node.key) !== node) return;
        if (node.object && res.version < node.version) return;
        const obj = this.createObject(node.desc, res.result, node);
        obj.visible = false;
        if (node.object) {
          obj.visible = node.object.visible;
          this.group.remove(node.object);
          disposeObject(node.object);
        }
        node.object = obj;
        node.version = res.version;
        this.group.add(obj);
      })
      .catch((err) => {
        if (node.pending === version) node.pending = -1;
        console.error(err);
      });
  }

  private evict(): void {
    if (this.nodes.size <= this.cacheLimit) return;
    const candidates = [...this.nodes.values()].filter((n) => !n.wanted && (!n.object || !n.object.visible));
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.nodes.size - Math.floor(this.cacheLimit * 0.8);
    for (const n of candidates) {
      if (excess-- <= 0) break;
      this.removeNode(n);
    }
  }

  protected removeNode(n: LodNode<D>): void {
    if (n.object) {
      this.group.remove(n.object);
      disposeObject(n.object);
    }
    this.nodes.delete(n.key);
  }

  /** Drops every cached node (used when the topology changes, e.g. a new resolution). */
  clear(): void {
    for (const n of [...this.nodes.values()]) this.removeNode(n);
    this.visible = [];
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

/** Disposes geometries of an object tree, leaving shared index buffers alive. */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) {
      if (mesh.geometry.userData.sharedIndex) mesh.geometry.setIndex(null);
      mesh.geometry.dispose();
    }
  });
}
