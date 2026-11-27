// Nelder-Mead minimisation for the keying fitting scripts.

export function nelderMead(f: (x: number[]) => number, x0: number[], iterations = 4000, step = 0.2): number[] {
  type Point = { x: number[]; f: number };
  const point = (x: number[]): Point => ({ x, f: f(x) });
  let simplex: Point[] = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v * (1 + step) + 1e-3 : v)))].map(point);
  const n = x0.length;
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.f - b.f);
    const centroid = x0.map((_, j) => simplex.slice(0, n).reduce((s, v) => s + v.x[j], 0) / n);
    const worst = simplex[n];
    const along = (k: number) => centroid.map((c, j) => c + k * (worst.x[j] - c));
    const r = point(along(-1));
    if (r.f < simplex[0].f) {
      const e = point(along(-2));
      simplex[n] = e.f < r.f ? e : r;
    } else if (r.f < simplex[n - 1].f) simplex[n] = r;
    else {
      const c = point(along(0.5));
      if (c.f < worst.f) simplex[n] = c;
      else simplex = simplex.map((v, i) => (i === 0 ? v : point(v.x.map((x, j) => simplex[0].x[j] + 0.5 * (x - simplex[0].x[j])))));
    }
  }
  return simplex.sort((a, b) => a.f - b.f)[0].x;
}
