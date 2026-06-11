import {
  COLS,
  DOOR_Y0,
  DOOR_Y1,
  INITIAL_OPEN_SLOTS,
  MACHINE_X0,
  MALL_PLACEMENT,
  ROWS,
  SHOP_SLOTS,
  SLOT_YS,
  activeVisits,
  exitPath,
} from './constants';
import type { Grid, LaneSlot, Rect, ShopSlot, TileKind, Vec } from './types';

/** All tiles on a footprint's perimeter (every tile of a 1-wide/1-tall rect). */
function perimeterTiles(rect: Rect): Vec[] {
  const out: Vec[] = [];
  for (let dx = 0; dx < rect.w; dx++) {
    for (let dy = 0; dy < rect.h; dy++) {
      if (dx === 0 || dy === 0 || dx === rect.w - 1 || dy === rect.h - 1) {
        out.push({ x: rect.x + dx, y: rect.y + dy });
      }
    }
  }
  return out;
}

/**
 * Counter unlock order for an arbitrary footprint: ROUND-ROBIN across the four
 * faces, each face center-out, starting with the edge that faces the hall.
 * Base counters therefore open on DIFFERENT sides of the building — seats all
 * on one face make every shopper converge there and stress in the knot, and no
 * assignment policy can spread what geometry has stacked. Upgrades keep
 * alternating faces, so growth reads as the storefront wrapping around.
 */
function generateVisits(rect: Rect): Vec[] {
  const cx = rect.x + (rect.w - 1) / 2;
  const cy = rect.y + (rect.h - 1) / 2;
  const dxc = COLS / 2 - cx;
  const dyc = ROWS / 2 - cy;
  // Face order: hall-facing first, then the two sides, the back last.
  const horizontal = rect.w > 1 && Math.abs(dxc) >= Math.abs(dyc);
  const east = { x: rect.x + rect.w - 1, y: cy };
  const west = { x: rect.x, y: cy };
  const north = { x: cx, y: rect.y };
  const south = { x: cx, y: rect.y + rect.h - 1 };
  const mids = horizontal
    ? dxc >= 0
      ? [east, north, south, west]
      : [west, north, south, east]
    : dyc >= 0
      ? [south, east, west, north]
      : [north, east, west, south];
  const tiles = perimeterTiles(rect);
  const byFace = mids.map((mid) =>
    tiles
      .filter((t) => {
        const d2 = (t.x - mid.x) ** 2 + (t.y - mid.y) ** 2;
        return mids.every((m) => d2 <= (t.x - m.x) ** 2 + (t.y - m.y) ** 2);
      })
      .sort(
        (a, b) =>
          (a.x - mid.x) ** 2 + (a.y - mid.y) ** 2 - ((b.x - mid.x) ** 2 + (b.y - mid.y) ** 2),
      ),
  );
  const out: Vec[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < tiles.length; i++) {
    const t = byFace[i % byFace.length]?.shift();
    if (!t) continue;
    const key = `${t.x},${t.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Random mall layout: drop each footprint (biggest first — anchors are hardest
 * to fit) uniformly inside the MALL_PLACEMENT margins, keeping every storefront
 * `gap` tiles clear of the rest. Rejection sampling with a relaxing gap
 * guarantees termination; a template's curated rect is the last-resort
 * fallback. Uses Math.random, so harness runs stay seed-reproducible.
 */
function placeFootprints(): Rect[] {
  const order = [...SHOP_SLOTS.keys()].sort((a, b) => {
    const ra = SHOP_SLOTS[a]?.rect;
    const rb = SHOP_SLOTS[b]?.rect;
    return (rb?.w ?? 0) * (rb?.h ?? 0) - (ra?.w ?? 0) * (ra?.h ?? 0);
  });
  const placed = new Map<number, Rect>();
  for (const i of order) {
    const template = SHOP_SLOTS[i];
    if (!template) continue;
    const { w, h } = template.rect;
    let rect: Rect | null = null;
    for (let gap = MALL_PLACEMENT.gap; gap >= 1 && !rect; gap--) {
      for (let tries = 0; tries < 120 && !rect; tries++) {
        const xSpan = MALL_PLACEMENT.xMax - w + 1 - MALL_PLACEMENT.xMin + 1;
        const ySpan = MALL_PLACEMENT.yMax - h + 1 - MALL_PLACEMENT.yMin + 1;
        const candidate: Rect = {
          x: MALL_PLACEMENT.xMin + Math.floor(Math.random() * xSpan),
          y: MALL_PLACEMENT.yMin + Math.floor(Math.random() * ySpan),
          w,
          h,
        };
        const clash = [...placed.values()].some(
          (r) =>
            candidate.x < r.x + r.w + gap &&
            r.x < candidate.x + candidate.w + gap &&
            candidate.y < r.y + r.h + gap &&
            r.y < candidate.y + candidate.h + gap,
        );
        if (!clash) rect = candidate;
      }
    }
    placed.set(i, rect ?? { ...template.rect });
  }
  return SHOP_SLOTS.map((t, i) => placed.get(i) ?? { ...t.rect });
}

export function createShops(): ShopSlot[] {
  const rects = placeFootprints();
  return SHOP_SLOTS.map((s, i) => {
    const rect = rects[i] ?? { ...s.rect };
    return { ...s, rect, visits: generateVisits(rect), built: false, level: 0 };
  });
}

export function createSlots(): LaneSlot[] {
  return SLOT_YS.map((y, i) => ({
    y,
    state: INITIAL_OPEN_SLOTS.includes(i) ? 'open' : 'closed',
    level: 0,
  }));
}

export function buildGrid(slots: readonly LaneSlot[]): Grid {
  const tiles: TileKind[] = new Array<TileKind>(COLS * ROWS).fill('floor');
  const grid: Grid = { cols: COLS, rows: ROWS, tiles };

  for (let x = 0; x < COLS; x++) {
    setTile(grid, x, 0, 'wall');
    setTile(grid, x, ROWS - 1, 'wall');
  }
  for (let y = 0; y < ROWS; y++) {
    setTile(grid, 0, y, 'wall');
    setTile(grid, COLS - 1, y, 'wall');
  }
  for (let y = DOOR_Y0; y <= DOOR_Y1; y++) setTile(grid, 0, y, 'door');

  // Machine-room block behind the scanners; active slots carve their lane out of it.
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = MACHINE_X0; x < COLS; x++) setTile(grid, x, y, 'wall');
  }
  for (const slot of slots) applySlotTiles(grid, slot);

  return grid;
}

/** Carve an open/draining slot's scanner+exit lane out of the machine wall, or fill it in. */
export function applySlotTiles(grid: Grid, slot: LaneSlot): void {
  const path = exitPath(slot.y);
  const carved = slot.state !== 'closed';
  for (const [i, p] of path.entries()) {
    const kind: TileKind = carved ? (i === path.length - 1 ? 'exit' : 'scanner') : 'wall';
    setTile(grid, p.x, p.y, kind);
  }
}

/**
 * Make a built shop's footprint solid except its ACTIVE counter tiles — a walk-in
 * storefront inside the envelope. Level-locked counters stay solid until unlocked;
 * selling restores everything to floor.
 */
export function applyShopTiles(grid: Grid, shop: ShopSlot): void {
  const counters = new Set(activeVisits(shop).map((v) => `${v.x},${v.y}`));
  for (let dx = 0; dx < shop.rect.w; dx++) {
    for (let dy = 0; dy < shop.rect.h; dy++) {
      const x = shop.rect.x + dx;
      const y = shop.rect.y + dy;
      const solid = shop.built && !counters.has(`${x},${y}`);
      setTile(grid, x, y, solid ? 'shop' : 'floor');
    }
  }
}

function setTile(grid: Grid, x: number, y: number, kind: TileKind): void {
  grid.tiles[y * grid.cols + x] = kind;
}
