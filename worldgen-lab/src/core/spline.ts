/**
 * Monotone cubic spline (Fritsch–Carlson).
 *
 * Minecraft 1.18+ shapes terrain with splines that map climate noise
 * (continentalness, erosion, peaks & valleys) to height. A monotone spline
 * never overshoots between control points, so dragging a point in the editor
 * behaves predictably.
 */
export type SplinePoint = [x: number, y: number];

export class MonotoneSpline {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly ms: Float64Array;

  constructor(points: readonly SplinePoint[]) {
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    // Drop duplicate x values (keep the last), they would make the slope undefined.
    const clean: SplinePoint[] = [];
    for (const p of pts) {
      if (clean.length && Math.abs(clean[clean.length - 1][0] - p[0]) < 1e-9) clean[clean.length - 1] = p;
      else clean.push(p);
    }
    if (clean.length === 0) clean.push([0, 0]);
    const n = clean.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.ms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = clean[i][0];
      this.ys[i] = clean[i][1];
    }
    if (n < 2) return;

    const delta = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) delta[i] = (this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]);
    this.ms[0] = delta[0];
    this.ms[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      this.ms[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
      if (delta[i] === 0) {
        this.ms[i] = 0;
        this.ms[i + 1] = 0;
        continue;
      }
      const a = this.ms[i] / delta[i];
      const b = this.ms[i + 1] / delta[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        this.ms[i] = t * a * delta[i];
        this.ms[i + 1] = t * b * delta[i];
      }
    }
  }

  eval(x: number): number {
    const xs = this.xs;
    const n = xs.length;
    if (n === 1 || x <= xs[0]) return this.ys[0];
    if (x >= xs[n - 1]) return this.ys[n - 1];
    let i = 0;
    // Control point counts are small, a linear scan beats a binary search here.
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * this.ys[i] +
      (t3 - 2 * t2 + t) * h * this.ms[i] +
      (-2 * t3 + 3 * t2) * this.ys[i + 1] +
      (t3 - t2) * h * this.ms[i + 1]
    );
  }
}
