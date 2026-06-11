import { SPAWN_TILES, activeVisits, serviceTile, tuning } from './constants';
import type { Fields, Grid, LaneSlot, ShopSlot, Vec } from './types';

/**
 * Per-tile occupant snapshot for directional congestion pricing: `pen` is the
 * tile's base surcharge (0 = empty), `gx/gy` the occupant's grain (movement or
 * intent direction; 0,0 = parked/directionless, whose `pen` already carries
 * their full park price).
 */
export type Congestion = { pen: Float64Array; gx: Int8Array; gy: Int8Array };

export const UNREACHABLE = -1;

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const tileIndex = (grid: Grid, t: Vec): number => t.y * grid.cols + t.x;

export function fieldAt(field: Float64Array, index: number): number {
  return field[index] ?? UNREACHABLE;
}

const isWalkable = (grid: Grid, index: number) =>
  grid.tiles[index] === 'floor' || grid.tiles[index] === 'gateOpen';

/**
 * Weighted distance field over walkable floor, distance 0 at each target tile.
 * `blocked` tiles are treated as walls (target tiles always seed regardless —
 * a shop's own counters are its targets). `congestion`, when given, prices
 * BODIES as well as walls: same-direction occupants are cheap to follow,
 * contraflow is dear, parked bodies cost their remaining park time. Dijkstra,
 * not BFS — costs are real-valued. Without it this degenerates to plain BFS.
 */
/** Surcharge for stepping onto `toI` while traveling toward `fromI` (which is
 * one step closer to the target — Dijkstra expands outward, travel runs inward). */
function edgePenalty(c: Congestion, fromI: number, toI: number, cols: number): number {
  const p = c.pen[toI] ?? 0;
  if (p === 0) return 0;
  const gx = c.gx[toI] ?? 0;
  const gy = c.gy[toI] ?? 0;
  if (gx === 0 && gy === 0) return p; // parked/directionless: full freight
  const tdx = (fromI % cols) - (toI % cols);
  const tdy = Math.floor(fromI / cols) - Math.floor(toI / cols);
  const dot = tdx * gx + tdy * gy;
  return dot > 0 ? p * tuning.followMult : dot < 0 ? p * tuning.againstMult : p;
}

/**
 * Seed price for a shop counter: the seated patron's remaining browse time PLUS
 * the bodies camped beside it. Without the camp term every arrival targets the
 * cheapest (entrance-facing) face, joins the knot, and stresses in it; pricing
 * the crowd into the seat spills later arrivals to the quiet faces exactly in
 * proportion to how mobbed the popular ones are.
 */
export function seatSeed(c: Congestion, i: number, cols: number, rows: number): number {
  let seed = c.pen[i] ?? 0;
  const x = i % cols;
  const y = Math.floor(i / cols);
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
    seed += c.pen[ny * cols + nx] ?? 0;
  }
  return seed;
}

export function computeField(
  grid: Grid,
  targets: readonly Vec[],
  blocked?: ReadonlySet<number>,
  congestion?: Congestion,
  /** Per-target starting cost (default 0). Lets multi-target fields rank their
   * own targets: shop counters seed at the seated patron's remaining browse
   * time, so an open middle seat outranks camping beside the nearest taken one. */
  seedCost?: (tileIndex: number) => number,
): Float64Array {
  const dist = new Float64Array(grid.cols * grid.rows).fill(UNREACHABLE);
  // Min-heap over (cost, tile) as parallel arrays.
  const hCost: number[] = [];
  const hTile: number[] = [];
  const swap = (a: number, b: number): void => {
    const c = hCost[a] ?? 0;
    const t = hTile[a] ?? 0;
    hCost[a] = hCost[b] ?? 0;
    hTile[a] = hTile[b] ?? 0;
    hCost[b] = c;
    hTile[b] = t;
  };
  const push = (c: number, i: number): void => {
    hCost.push(c);
    hTile.push(i);
    let k = hCost.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if ((hCost[p] ?? 0) <= (hCost[k] ?? 0)) break;
      swap(p, k);
      k = p;
    }
  };
  const pop = (): [number, number] | null => {
    if (hCost.length === 0) return null;
    const top: [number, number] = [hCost[0] ?? 0, hTile[0] ?? 0];
    const lc = hCost.pop() ?? 0;
    const lt = hTile.pop() ?? 0;
    if (hCost.length > 0) {
      hCost[0] = lc;
      hTile[0] = lt;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < hCost.length && (hCost[l] ?? Infinity) < (hCost[m] ?? Infinity)) m = l;
        if (r < hCost.length && (hCost[r] ?? Infinity) < (hCost[m] ?? Infinity)) m = r;
        if (m === k) break;
        swap(m, k);
        k = m;
      }
    }
    return top;
  };

  for (const t of targets) {
    const i = tileIndex(grid, t);
    if (isWalkable(grid, i) && fieldAt(dist, i) === UNREACHABLE) {
      const seed = seedCost?.(i) ?? 0;
      dist[i] = seed;
      push(seed, i);
    }
  }
  for (;;) {
    const top = pop();
    if (!top) break;
    const [d, i] = top;
    if (d > (dist[i] ?? Infinity)) continue; // stale heap entry
    const x = i % grid.cols;
    const y = Math.floor(i / grid.cols);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.cols || ny >= grid.rows) continue;
      const ni = ny * grid.cols + nx;
      if (!isWalkable(grid, ni)) continue;
      if (blocked?.has(ni)) continue;
      const nd = d + 1 + (congestion ? edgePenalty(congestion, i, ni, grid.cols) : 0);
      const cur = dist[ni] ?? UNREACHABLE;
      if (cur !== UNREACHABLE && cur <= nd) continue;
      dist[ni] = nd;
      push(nd, ni);
    }
  }
  return dist;
}

export function computeFields(
  grid: Grid,
  slots: readonly LaneSlot[],
  shops: readonly ShopSlot[],
  congestion?: Congestion,
): Fields {
  // Counters are patron-only: walls in every field except their own shop's.
  const counters = new Set<number>();
  for (const s of shops) {
    if (!s.built) continue;
    for (const v of activeVisits(s)) counters.add(tileIndex(grid, v));
  }
  return {
    lanes: slots.map((s) =>
      s.state === 'open' ? computeField(grid, [serviceTile(s.y)], counters, congestion) : null,
    ),
    shops: shops.map((s) => {
      if (!s.built) return null;
      const own = activeVisits(s);
      const blocked = new Set(counters);
      for (const v of own) blocked.delete(tileIndex(grid, v));
      // Seat-aware seeding: a taken counter starts at its patron's remaining
      // park price plus the crowd camped around it (seatSeed), a free quiet one
      // at 0 — shoppers fan across ALL seats by soonest-reachable, and a knot
      // on the popular face pushes later arrivals to the quiet faces.
      return computeField(
        grid,
        own,
        blocked,
        congestion,
        congestion ? (i) => seatSeed(congestion, i, grid.cols, grid.rows) : undefined,
      );
    }),
    entrance: computeField(grid, SPAWN_TILES, counters, congestion),
    counters,
  };
}
