// src/core/dxf/tessellate.ts — curve → polyline tessellation at a chord tolerance
// (docs/04 §4: ~0.1 ft). Pure math, no deps, Node-testable.

/** Default chord tolerance in drawing units (~0.1 ft per docs/04 §4). */
export const DEFAULT_CHORD_TOL = 0.1;

const MIN_SEGS = 2;
const MAX_SEGS = 256;

/** Segments needed so the chord sagitta stays under `tol` for radius `r` over `sweep` rad. */
export function arcSegmentCount(r: number, sweep: number, tol: number): number {
  const a = Math.abs(sweep);
  if (!(r > 0) || a === 0) return MIN_SEGS;
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  const n = maxStep > 0 ? Math.ceil(a / maxStep) : MAX_SEGS;
  return Math.max(MIN_SEGS, Math.min(MAX_SEGS, n));
}

/**
 * Append points along a circular arc (center cx,cy radius r, from `start` to `end` rad,
 * CCW when end > start — pass a smaller `end` + `ccw=false` semantics resolved by caller).
 * Appends `includeFirst ? n+1 : n` x,y,z triples.
 */
export function tessellateArc(
  out: number[],
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
  z: number,
  tol: number,
  includeFirst: boolean,
): void {
  const sweep = end - start;
  const n = arcSegmentCount(r, sweep, tol);
  for (let i = includeFirst ? 0 : 1; i <= n; i++) {
    const a = start + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
  }
}

/**
 * Append the curved segment from (x1,y1) to (x2,y2) with LWPOLYLINE bulge (group 42 —
 * bulge = tan(includedAngle/4), sign = CCW positive). Appends intermediate points + the
 * end point (never the start point). Zero bulge appends the end point only.
 */
export function tessellateBulge(
  out: number[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bulge: number,
  z: number,
  tol: number,
): void {
  if (bulge === 0 || !Number.isFinite(bulge)) {
    out.push(x2, y2, z);
    return;
  }
  const theta = 4 * Math.atan(bulge); // included angle, signed
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return;
  const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
  // center: midpoint + perpendicular offset
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  // perpendicular direction (left of chord); bulge sign + |theta|>π pick the side
  const side = (theta > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const px = (-dy / chord) * h * side;
  const py = (dx / chord) * h * side;
  const cx = mx + px;
  const cy = my + py;
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  const a2 = a1 + theta;
  tessellateArc(out, cx, cy, r, a1, a2, z, tol, false);
  // snap the final point exactly onto the target vertex (kill float drift)
  out[out.length - 3] = x2;
  out[out.length - 2] = y2;
}

/**
 * Append points along a (possibly partial) ellipse. DXF ELLIPSE: center, major-axis END
 * VECTOR (relative to center), minor/major ratio, start/end params in RADIANS (param space,
 * not angle space). Appends n+1 points including the start.
 */
export function tessellateEllipse(
  out: number[],
  cx: number,
  cy: number,
  majorX: number,
  majorY: number,
  ratio: number,
  startParam: number,
  endParam: number,
  z: number,
  tol: number,
): void {
  let sweep = endParam - startParam;
  if (sweep <= 0) sweep += Math.PI * 2;
  const a = Math.hypot(majorX, majorY); // semi-major length
  const n = arcSegmentCount(a, sweep, tol); // conservative: max radius governs the chord error
  const b = a * ratio;
  const rot = Math.atan2(majorY, majorX);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const t = startParam + (sweep * i) / n;
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    out.push(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr, z);
  }
}

/**
 * Sample a NURBS curve (DXF SPLINE) at `samples` points (inclusive of both ends) via
 * de Boor evaluation with optional weights. Control points are [x,y,z] triples.
 * Degenerate inputs fall back to the control polygon.
 */
export function sampleSpline(
  out: number[],
  control: ReadonlyArray<readonly [number, number, number]>,
  degree: number,
  knots: readonly number[],
  weights: readonly number[] | null,
  samples: number,
): void {
  const n = control.length;
  if (n === 0) return;
  const p = Math.max(1, Math.floor(degree) || 3);
  if (n <= p || knots.length < n + p + 1) {
    // not a valid NURBS description — control polygon is the honest fallback
    for (const c of control) out.push(c[0], c[1], c[2]);
    return;
  }
  const tMin = knots[p]!;
  const tMax = knots[n]!;
  const m = Math.max(2, samples);
  for (let s = 0; s < m; s++) {
    const t = tMin + ((tMax - tMin) * s) / (m - 1);
    // find knot span k: knots[k] <= t < knots[k+1]
    let k = p;
    for (let i = p; i < n; i++) {
      if (t >= knots[i]! && (t < knots[i + 1]! || i === n - 1)) {
        k = i;
        break;
      }
    }
    // de Boor on homogeneous coords
    const d: number[][] = [];
    for (let j = 0; j <= p; j++) {
      const idx = k - p + j;
      const w = weights ? (weights[idx] ?? 1) : 1;
      const c = control[idx]!;
      d.push([c[0] * w, c[1] * w, c[2] * w, w]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const denom = knots[i + p - r + 1]! - knots[i]!;
        const alpha = denom === 0 ? 0 : (t - knots[i]!) / denom;
        for (let c = 0; c < 4; c++) {
          d[j]![c] = (1 - alpha) * d[j - 1]![c]! + alpha * d[j]![c]!;
        }
      }
    }
    const w = d[p]![3]! || 1;
    out.push(d[p]![0]! / w, d[p]![1]! / w, d[p]![2]! / w);
  }
}
