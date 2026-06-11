import { MAX_FRUSTRATION, TILE, activeVisits, exitPath, serviceTile } from './constants';
import { createSprites, cycle } from './sprites';
import type { PersonFrames, Skin, SpriteSet } from './sprites';
import type { Game, Grid, Passenger, ShopSlot, Vec } from './types';

import type { Selection } from './input';

/** Cosmetic options shared by renderer and HUD (mutated by the HUD toggle). */
export type ViewOptions = { skin: Skin };

export type Renderer = {
  draw(game: Game, selected: Selection | null): void;
};

export function createRenderer(canvas: HTMLCanvasElement, options: ViewOptions): Renderer {
  const screen = canvas.getContext('2d');
  if (!screen) throw new Error('2d context unavailable');

  const buffer = document.createElement('canvas');
  const ctx = buffer.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  // Sprite sets build lazily per skin and are kept (toggling back is free).
  const spriteSets = new Map<Skin, SpriteSet>();
  const sprites = (): SpriteSet => {
    let set = spriteSets.get(options.skin);
    if (!set) {
      set = createSprites(options.skin);
      spriteSets.set(options.skin, set);
    }
    return set;
  };

  return {
    draw(game: Game, selected: Selection | null): void {
      const w = game.grid.cols * TILE;
      const h = game.grid.rows * TILE;
      if (buffer.width !== w || buffer.height !== h) {
        buffer.width = w;
        buffer.height = h;
      }
      drawTiles(ctx, game);
      drawRopes(ctx, game.grid);
      drawShops(ctx, game);
      drawPendingBuilds(ctx, game);
      drawPassengers(ctx, game, sprites());
      drawMoneyPops(ctx, game);
      drawSelection(ctx, game, selected);
      screen.imageSmoothingEnabled = false;
      screen.drawImage(buffer, 0, 0, canvas.width, canvas.height);
    },
  };
}

/**
 * Terminal floor: a faintly warm, low-saturation checker. Each tile gets a
 * whisper of relief (half-strength top/bottom edges only) and a fixed 8-bit
 * terrazzo motif — a 2×2 center inset plus four corner flecks — identical on
 * every tile, alternating shade with the checker parity.
 */
function drawFloorTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  px: number,
  py: number,
): void {
  const even = (x + y) % 2 === 0;
  const base = even ? '#d7d5cd' : '#d1cfc7';
  const hi = even ? '#dad8d0' : '#d4d2ca';
  const lo = even ? '#d3d1c9' : '#cdcbc3';
  const sheen = even ? '#dddbd3' : '#d7d5cd';
  fill(ctx, base, px, py, TILE, TILE);
  fill(ctx, hi, px, py, TILE, 1);
  fill(ctx, lo, px, py + TILE - 1, TILE, 1);
  // Polished-tile sheen: a faint dashed diagonal streak, same on every tile.
  fill(ctx, sheen, px + 11, py + 3, 2, 1);
  fill(ctx, sheen, px + 8, py + 6, 2, 1);
  fill(ctx, sheen, px + 5, py + 9, 2, 1);
  fill(ctx, sheen, px + 2, py + 12, 2, 1);
}

const fill = (
  ctx: CanvasRenderingContext2D,
  c: string,
  x: number,
  y: number,
  w: number,
  h: number,
) => {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, w, h);
};

function drawTiles(ctx: CanvasRenderingContext2D, game: Game): void {
  const { grid } = game;
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const kind = grid.tiles[y * grid.cols + x] ?? 'wall';
      const px = x * TILE;
      const py = y * TILE;
      switch (kind) {
        case 'floor':
        case 'rope':
          drawFloorTile(ctx, x, y, px, py);
          break;
        case 'gateOpen':
        case 'gateClosed': {
          // Retractable belt gate: steel posts always; belt drawn when closed.
          drawFloorTile(ctx, x, y, px, py);
          fill(ctx, '#4f7be0', px + 1, py + 1, 3, TILE - 2);
          fill(ctx, '#4f7be0', px + TILE - 4, py + 1, 3, TILE - 2);
          fill(ctx, '#9db4e8', px + 1, py + 1, 3, 2);
          fill(ctx, '#9db4e8', px + TILE - 4, py + 1, 3, 2);
          if (kind === 'gateClosed') {
            fill(ctx, '#1d3461', px + 3, py + TILE / 2 - 2, TILE - 6, 4);
            fill(ctx, '#4f7be0', px + 3, py + TILE / 2 - 1, TILE - 6, 1);
          }
          break;
        }
        case 'wall':
          fill(ctx, '#3b4252', px, py, TILE, TILE);
          fill(ctx, '#4c566a', px, py, TILE, 3);
          break;
        case 'door':
          fill(ctx, '#74c69d', px, py, TILE, TILE);
          fill(ctx, '#52b788', px + 2, py + 2, TILE - 4, TILE - 4);
          break;
        case 'scanner': {
          fill(ctx, '#495057', px, py, TILE, TILE);
          // Animated belt stripes; upgraded lanes run visibly faster.
          const level = game.slots.find((s) => s.y === y)?.level ?? 0;
          for (let s = 0; s < 3; s++) {
            const offset = (Math.floor(game.time * (8 + level * 6)) + s * 5) % TILE;
            fill(ctx, '#343a40', px + offset, py + 4, 2, TILE - 8);
          }
          break;
        }
        case 'exit':
          fill(ctx, '#2f3e46', px, py, TILE, TILE);
          fill(ctx, '#2a9d8f', px + 4, py + 6, 6, 4);
          fill(ctx, '#2a9d8f', px + 8, py + 3, 3, 10);
          break;
        case 'shop':
          // Base only; the building is drawn by drawShops over the footprint.
          fill(ctx, '#39404f', px, py, TILE, TILE);
          break;
      }
    }
  }

  for (const slot of game.slots) {
    if (slot.state === 'closed') {
      drawGhostSlot(ctx, slot.y);
      continue;
    }
    if (slot.state === 'open') drawServiceMarker(ctx, serviceTile(slot.y));
    const arch = exitPath(slot.y)[0];
    if (arch) drawScannerArch(ctx, arch, game.time, slot.state === 'draining', slot.level);
  }
}

/** Inactive checkpoint slot: a faint dashed lane with a "+" so it reads as clickable. */
function drawGhostSlot(ctx: CanvasRenderingContext2D, slotY: number): void {
  const path = exitPath(slotY);
  for (const p of path) {
    fill(ctx, '#454e61', p.x * TILE + 1, p.y * TILE + 4, TILE - 2, TILE - 8);
    fill(ctx, '#5b6678', p.x * TILE + 2, p.y * TILE + 4, TILE - 4, 1);
    fill(ctx, '#5b6678', p.x * TILE + 2, p.y * TILE + TILE - 5, TILE - 4, 1);
  }
  const cx = (path[1]?.x ?? path[0]?.x ?? 0) * TILE + TILE / 2;
  const cy = slotY * TILE + TILE / 2;
  fill(ctx, '#9aa3b2', cx - 1, cy - 4, 2, 8);
  fill(ctx, '#9aa3b2', cx - 4, cy - 1, 8, 2);
}

function drawServiceMarker(ctx: CanvasRenderingContext2D, t: Vec): void {
  const px = t.x * TILE;
  const py = t.y * TILE;
  ctx.fillStyle = '#f7b32b';
  for (const [cx, cy] of [
    [0, 0],
    [TILE - 4, 0],
    [0, TILE - 4],
    [TILE - 4, TILE - 4],
  ] as const) {
    // Mirror both strokes into their corner: bottom brackets hug the bottom edge.
    ctx.fillRect(px + cx, py + cy + (cy === 0 ? 0 : 2), 4, 2);
    ctx.fillRect(px + cx + (cx === 0 ? 0 : 2), py + cy, 2, 4);
  }
}

function drawScannerArch(
  ctx: CanvasRenderingContext2D,
  t: Vec,
  time: number,
  draining: boolean,
  level: number,
): void {
  const px = t.x * TILE;
  const py = t.y * TILE;
  // Upgraded machines get a brighter, brassier housing.
  const housing = level === 0 ? '#6c757d' : level === 1 ? '#7d8aa0' : '#9aa8c2';
  fill(ctx, housing, px, py - 2, TILE, 4);
  fill(ctx, housing, px, py + TILE - 2, TILE, 4);
  fill(ctx, '#868e96', px, py - 2, 3, TILE + 4);
  // Status light: slow green blink when open, fast red blink while draining.
  const blink = Math.floor(time * (draining ? 6 : 2)) % 2 === 0;
  const color = draining ? (blink ? '#e63946' : '#5c2429') : blink ? '#80ed99' : '#38543c';
  fill(ctx, color, px + 6, py - 2, 3, 2);
  // Gold level pips on the housing.
  for (let l = 0; l < level; l++) {
    fill(ctx, '#f7b32b', px + 10 + l * 4, py - 2, 3, 2);
  }
}

function drawRopes(ctx: CanvasRenderingContext2D, grid: Grid): void {
  const isRope = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < grid.cols && y < grid.rows && grid.tiles[y * grid.cols + x] === 'rope';

  // Rope bands first, posts on top.
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      if (!isRope(x, y)) continue;
      const cx = x * TILE + TILE / 2;
      const cy = y * TILE + TILE / 2;
      if (isRope(x + 1, y)) fill(ctx, '#c1121f', cx, cy - 4, TILE, 2);
      if (isRope(x, y + 1)) fill(ctx, '#c1121f', cx - 1, cy - 4, 2, TILE);
    }
  }
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      if (!isRope(x, y)) continue;
      const px = x * TILE;
      const py = y * TILE;
      fill(ctx, 'rgba(0,0,0,0.15)', px + 4, py + 12, 8, 2);
      fill(ctx, '#8a6d2f', px + 5, py + 11, 6, 2);
      fill(ctx, '#caa84a', px + 7, py + 3, 2, 9);
      fill(ctx, '#e3c878', px + 6, py + 2, 4, 2);
    }
  }
}

function passengerPixelPos(p: Passenger): { x: number; y: number } {
  if (p.step.kind === 'stepping') {
    const t = Math.min(p.step.progress, 1);
    return {
      x: (p.step.from.x + (p.step.to.x - p.step.from.x) * t) * TILE,
      y: (p.step.from.y + (p.step.to.y - p.step.from.y) * t) * TILE,
    };
  }
  return { x: p.tile.x * TILE, y: p.tile.y * TILE };
}

function drawPassengers(ctx: CanvasRenderingContext2D, game: Game, sprites: SpriteSet): void {
  const sorted = [...game.passengers].sort(
    (a, b) => passengerPixelPos(a).y - passengerPixelPos(b).y,
  );
  for (const p of sorted) {
    const pos = passengerPixelPos(p);
    const frames = cycle(sprites.variants, p.spriteIndex);
    const { image, bobY } = walkCycleFrame(p, frames);

    fill(ctx, 'rgba(0,0,0,0.18)', pos.x + 4, pos.y + 14, 8, 2);
    ctx.drawImage(image, pos.x, pos.y + bobY);

    drawFrustrationBar(ctx, p, pos);
    if (p.vip) {
      // Gold crown: the wave's VIP, worth a wave-scaled bonus if served calm.
      fill(ctx, '#ffd166', pos.x + 5, pos.y - 5 + bobY, 6, 2);
      fill(ctx, '#ffd166', pos.x + 5, pos.y - 7 + bobY, 1, 2);
      fill(ctx, '#ffd166', pos.x + 7, pos.y - 8 + bobY, 2, 3);
      fill(ctx, '#ffd166', pos.x + 10, pos.y - 7 + bobY, 1, 2);
    }
    if (p.phase.kind === 'queueing') {
      if (p.crowded && p.step.kind === 'idle') {
        // Personal-space anger tick: a red spark jittering above the head.
        const jx = Math.floor(game.time * 9) % 2;
        fill(ctx, '#e63946', pos.x + 12 + jx, pos.y - 7, 2, 2);
        fill(ctx, '#e63946', pos.x + 14 + jx, pos.y - 5, 1, 1);
      } else if (p.prepped) {
        // Ready glow: prepped on-deck passengers carry a little green check-dot.
        fill(ctx, '#80ed99', pos.x + 13, pos.y - 6, 2, 2);
      }
    }
    if (p.phase.kind === 'processing' || p.phase.kind === 'shopping') {
      const f = 1 - p.phase.remaining / p.phase.total;
      const color = p.phase.kind === 'processing' ? '#48bfe3' : '#c77dff';
      fill(ctx, '#22223b', pos.x + 2, pos.y + 16, 12, 2);
      fill(ctx, color, pos.x + 2, pos.y + 16, Math.round(12 * f), 2);
    }
    if (p.phase.kind === 'storming') {
      fill(ctx, '#e63946', pos.x + 7, pos.y - 6, 2, 3);
      fill(ctx, '#e63946', pos.x + 7, pos.y - 2, 2, 1);
    }
  }
}

type ShopPalette = {
  wall: string;
  wallLight: string;
  trim: string;
  awning: string;
  sign: string;
};

/** Every named shop has its own storefront identity, not just a tier color. */
const SHOP_STYLES: Record<string, ShopPalette> = {
  Newsstand: {
    wall: '#b23a48',
    wallLight: '#c94f5d',
    trim: '#6e1f2a',
    awning: '#f1faee',
    sign: '#ffd166',
  },
  'Currency Exchange': {
    wall: '#2d6a4f',
    wallLight: '#38815f',
    trim: '#1b4332',
    awning: '#ffd166',
    sign: '#b7e4c7',
  },
  'Charging Station': {
    wall: '#3d5a80',
    wallLight: '#4d6f9d',
    trim: '#243b55',
    awning: '#ffd166',
    sign: '#98c1d9',
  },
  'Luggage Wrap': {
    wall: '#a47148',
    wallLight: '#bb8558',
    trim: '#6b4226',
    awning: '#e76f51',
    sign: '#ffe8c2',
  },
  'Zen Lounge': {
    wall: '#4a7c59',
    wallLight: '#5c9670',
    trim: '#2f5239',
    awning: '#cdb4db',
    sign: '#e9f5db',
  },
  'Grand Coffee Bar': {
    wall: '#5e3023',
    wallLight: '#7a4234',
    trim: '#3d1f16',
    awning: '#e9c46a',
    sign: '#ffe97a',
  },
};

const DEFAULT_STYLE: ShopPalette = {
  wall: '#a96a32',
  wallLight: '#c08146',
  trim: '#6e441f',
  awning: '#e0564f',
  sign: '#f7e07a',
};

/** 8×8 pixel glyph for each shop's trade; scale 2 renders it 16×16 and bold. */
function drawShopIcon(
  ctx: CanvasRenderingContext2D,
  name: string,
  gx: number,
  gy: number,
  time: number,
  scale = 1,
): void {
  const p = (c: string, x: number, y: number, w = 1, h = 1) =>
    fill(ctx, c, gx + x * scale, gy + y * scale, w * scale, h * scale);
  switch (name) {
    case 'Newsstand': {
      // An open magazine: white pages, a fold, headline bars.
      p('#f1faee', 0, 1, 8, 6);
      p('#8d99ae', 4, 1, 1, 6);
      p('#e63946', 1, 2, 2, 1);
      p('#5b6678', 1, 4, 2, 1);
      p('#5b6678', 5, 2, 2, 1);
      p('#5b6678', 5, 4, 2, 1);
      break;
    }
    case 'Currency Exchange': {
      // A pixel "$".
      p('#ffd166', 2, 0, 4, 1);
      p('#ffd166', 1, 1, 1, 1);
      p('#ffd166', 2, 3, 4, 1);
      p('#ffd166', 6, 5, 1, 1);
      p('#ffd166', 2, 6, 4, 1);
      p('#ffd166', 3, 0, 1, 8); // center bar
      break;
    }
    case 'Charging Station': {
      // Lightning bolt.
      p('#ffd166', 4, 0, 2, 1);
      p('#ffd166', 3, 1, 2, 1);
      p('#ffd166', 2, 2, 4, 1);
      p('#ffd166', 3, 3, 2, 1);
      p('#ffd166', 2, 4, 2, 1);
      p('#ffd166', 1, 5, 2, 1);
      p('#ffd166', 1, 6, 1, 1);
      break;
    }
    case 'Luggage Wrap': {
      // A wrapped suitcase: handle, body, bright wrap band.
      p('#3d1f16', 3, 0, 3, 1);
      p('#3d1f16', 3, 1, 1, 1);
      p('#3d1f16', 5, 1, 1, 1);
      p('#c08146', 1, 2, 7, 5);
      p('#e76f51', 4, 2, 1, 5);
      p('#8a5a33', 1, 6, 7, 1);
      break;
    }
    case 'Zen Lounge': {
      // A potted plant mid-breath.
      p('#52b788', 3, 0, 2, 1);
      p('#2d6a4f', 2, 1, 1, 1);
      p('#52b788', 5, 1, 1, 1);
      p('#2d6a4f', 4, 2, 1, 2);
      p('#52b788', 3, 2, 1, 1);
      p('#9c6644', 2, 4, 5, 2);
      p('#7f5539', 3, 6, 3, 1);
      break;
    }
    case 'Grand Coffee Bar': {
      // Steaming cup; the steam pixels flicker with time.
      p('#f1faee', 1, 3, 5, 4);
      p('#f1faee', 6, 4, 1, 2);
      p('#9c6644', 2, 4, 3, 2);
      p('#e9c46a', 0, 7, 8, 1);
      const puff = Math.floor(time * 2) % 2 === 0;
      p('#dee2e6', puff ? 2 : 3, 0, 1, 1);
      p('#dee2e6', puff ? 4 : 3, 1, 1, 1);
      break;
    }
  }
}

function drawShops(ctx: CanvasRenderingContext2D, game: Game): void {
  for (const shop of game.shops) {
    if (shop.built) drawBuiltShop(ctx, shop, game.time);
    else drawGhostShop(ctx, shop);
  }
}

function drawGhostShop(ctx: CanvasRenderingContext2D, shop: ShopSlot): void {
  const { x, y, w, h } = shop.rect;
  const px = x * TILE;
  const py = y * TILE;
  const pw = w * TILE;
  const ph = h * TILE;
  fill(ctx, 'rgba(0,0,0,0.10)', px + 1, py + 1, pw - 2, ph - 2);
  fill(ctx, '#8d99ae', px + 1, py + 1, pw - 2, 1);
  fill(ctx, '#8d99ae', px + 1, py + ph - 2, pw - 2, 1);
  fill(ctx, '#8d99ae', px + 1, py + 1, 1, ph - 2);
  fill(ctx, '#8d99ae', px + pw - 2, py + 1, 1, ph - 2);
  drawInfoBadge(ctx, px + pw - 7, py + 2);
}

/** Tiny ⓘ badge marking hover-for-info spots. */
function drawInfoBadge(ctx: CanvasRenderingContext2D, px: number, py: number): void {
  fill(ctx, '#4f7be0', px, py, 5, 5);
  fill(ctx, '#fff', px + 2, py + 1, 1, 1);
  fill(ctx, '#fff', px + 2, py + 3, 1, 1);
}

/** A recessed walk-in counter slot — the openings that grow with shop level. */
function drawCounterOpening(ctx: CanvasRenderingContext2D, v: Vec, c: ShopPalette): void {
  const px = v.x * TILE;
  const py = v.y * TILE;
  fill(ctx, '#15181f', px, py, TILE, TILE); // door frame
  fill(ctx, '#c9a472', px + 1, py + 1, TILE - 2, TILE - 2); // warm interior floor
  fill(ctx, '#a3804f', px + 1, py + 1, TILE - 2, 2); // lintel shadow
  fill(ctx, '#7f5539', px + 2, py + TILE - 6, TILE - 4, 4); // counter desk
  fill(ctx, '#9c6644', px + 2, py + TILE - 6, TILE - 4, 1);
  fill(ctx, c.awning, px + 6, py + TILE - 5, 4, 2); // till in the shop's color
}

/**
 * 8-bit storefront: a slatted roof in the shop's color, the trade icon
 * as the sign, recessed counter openings (the changing slots ARE the detail),
 * and a scalloped awning on the storefront face. No windows, no fake lettering.
 */
function drawBuiltShop(ctx: CanvasRenderingContext2D, shop: ShopSlot, time: number): void {
  const c = SHOP_STYLES[shop.name] ?? DEFAULT_STYLE;
  const { x, y, w, h } = shop.rect;
  const px = x * TILE;
  const py = y * TILE;
  const pw = w * TILE;
  const ph = h * TILE;
  const visits = activeVisits(shop);

  // Roof: outline, body, ridge highlight, slats, eave shadow.
  fill(ctx, '#15181f', px, py, pw, ph);
  fill(ctx, c.wall, px + 1, py + 1, pw - 2, ph - 2);
  fill(ctx, c.wallLight, px + 1, py + 1, pw - 2, 2);
  ctx.globalAlpha = 0.16;
  for (let ry = py + 5; ry < py + ph - 3; ry += 4) {
    fill(ctx, c.trim, px + 1, ry, pw - 2, 1);
  }
  ctx.globalAlpha = 1;
  fill(ctx, c.trim, px + 1, py + ph - 3, pw - 2, 2);

  // Counter openings cut into the roof (drawn before plaque so big shops keep
  // their icon on top even when interior counters unlock).
  for (const v of visits) drawCounterOpening(ctx, v, c);

  // The trade icon is the sign: plaque on the solid roof tile nearest the center
  // (so the 2× logo never spills off a corner of the building).
  const counters = new Set(visits.map((v) => `${v.x},${v.y}`));
  let plaque: Vec | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const cx = x + (w - 1) / 2;
  const cy = y + (h - 1) / 2;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (counters.has(`${x + dx},${y + dy}`)) continue;
      const d = (x + dx - cx) ** 2 + (y + dy - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        plaque = { x: x + dx, y: y + dy };
      }
    }
  }
  if (plaque) {
    // The LOGO is the star: a bordered plaque with a drop shadow; big shops get
    // the glyph at 2× so the cup / bolt / $ reads from across the hall.
    const scale = w > 1 ? 2 : 1;
    const size = scale === 2 ? 20 : 12;
    const ix = plaque.x * TILE + Math.floor(TILE / 2 - size / 2);
    const iy = plaque.y * TILE + Math.floor(TILE / 2 - size / 2);
    fill(ctx, 'rgba(0,0,0,0.35)', ix + 2, iy + 2, size, size); // drop shadow
    fill(ctx, '#11141a', ix, iy, size, size);
    fill(ctx, c.sign, ix, iy, size, 1);
    fill(ctx, c.sign, ix, iy + size - 1, size, 1);
    fill(ctx, c.sign, ix, iy, 1, size);
    fill(ctx, c.sign, ix + size - 1, iy, 1, size);
    const pad = Math.floor((size - 8 * scale) / 2);
    drawShopIcon(ctx, shop.name, ix + pad, iy + pad, time, scale);
  }

  // Scalloped awning along the storefront face (where the counters mostly sit).
  const faces = { north: 0, south: 0, west: 0, east: 0 };
  for (const v of visits) {
    if (v.y === y) faces.north++;
    if (v.y === y + h - 1) faces.south++;
    if (v.x === x) faces.west++;
    if (v.x === x + w - 1) faces.east++;
  }
  const vertical = Math.max(faces.west, faces.east);
  const face =
    vertical > faces.north && vertical > faces.south
      ? faces.east >= faces.west
        ? 'east'
        : 'west'
      : faces.north >= faces.south
        ? 'north'
        : 'south';
  const scallopH = (ax: number, ay: number, length: number): void => {
    for (let i = 0; i < length; i += 6) {
      const stripe = (i / 6) % 2 === 0 ? c.awning : '#f1faee';
      fill(ctx, stripe, ax + i, ay, Math.min(6, length - i), 3);
      fill(ctx, stripe, ax + i + 1, ay + 3, Math.min(4, length - i - 2), 2);
    }
  };
  const scallopV = (ax: number, ay: number, length: number): void => {
    for (let i = 0; i < length; i += 6) {
      const stripe = (i / 6) % 2 === 0 ? c.awning : '#f1faee';
      fill(ctx, stripe, ax, ay + i, 3, Math.min(6, length - i));
      fill(ctx, stripe, ax + 3, ay + i + 1, 2, Math.min(4, length - i - 2));
    }
  };
  if (face === 'west') scallopV(px - 2, py + 1, ph - 2);
  else if (face === 'east') scallopV(px + pw - 3, py + 1, ph - 2);
  else if (face === 'north') scallopH(px + 1, py - 2, pw - 2);
  else scallopH(px + 1, py + ph - 2, pw - 2);

  // Gold level pips on the roof corner.
  for (let l = 0; l < shop.level; l++) {
    fill(ctx, '#f7b32b', px + pw - 6 - l * 4, py + 3, 3, 3);
  }
}

/** Marching-ants style highlight around the selected facility. */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  game: Game,
  selected: Selection | null,
): void {
  if (!selected) return;
  let rx = 0;
  let ry = 0;
  let rw = 0;
  let rh = 0;
  if (selected.kind === 'shop') {
    const shop = game.shops[selected.index];
    if (!shop) return;
    rx = shop.rect.x * TILE;
    ry = shop.rect.y * TILE;
    rw = shop.rect.w * TILE;
    rh = shop.rect.h * TILE;
  } else {
    const slot = game.slots[selected.index];
    if (!slot) return;
    // Service tile through the exit tile, derived from the lane geometry.
    const path = exitPath(slot.y);
    const endX = (path[path.length - 1]?.x ?? serviceTile(slot.y).x) + 1;
    rx = serviceTile(slot.y).x * TILE;
    ry = slot.y * TILE - 2;
    rw = endX * TILE - rx;
    rh = TILE + 4;
  }
  ctx.strokeStyle = '#f7b32b';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx - 1.5, ry - 1.5, rw + 3, rh + 3);
}

/** Pending actions waiting for their square to clear: translucent previews. */
function drawPendingBuilds(ctx: CanvasRenderingContext2D, game: Game): void {
  ctx.globalAlpha = 0.45;
  for (const b of game.pending) {
    const px = b.tile.x * TILE;
    const py = b.tile.y * TILE;
    if (b.kind === 'gateShut') {
      // The belt hovering, about to drop into the first gap.
      fill(ctx, '#1d3461', px + 3, py + TILE / 2 - 2, TILE - 6, 4);
    } else {
      fill(ctx, '#8a6d2f', px + 5, py + 11, 6, 2);
      fill(ctx, '#caa84a', px + 7, py + 3, 2, 9);
      fill(ctx, '#e3c878', px + 6, py + 2, 4, 2);
    }
  }
  ctx.globalAlpha = 1;
}

/** Floating "+$12"/"−$30" texts: rise and fade over their lifetime (sim ages them). */
function drawMoneyPops(ctx: CanvasRenderingContext2D, game: Game): void {
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  for (const pop of game.pops) {
    const px = pop.x * TILE + TILE / 2;
    const py = pop.y * TILE - 4 - pop.age * 10;
    const label = pop.amount >= 0 ? `+$${pop.amount}` : `-$${-pop.amount}`;
    ctx.globalAlpha = Math.max(0, 1 - pop.age / 1.4);
    ctx.fillStyle = '#11141a';
    ctx.fillText(label, px + 1, py + 1);
    ctx.fillStyle = pop.amount >= 0 ? '#52e07f' : '#ff5d68';
    ctx.fillText(label, px, py);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'start';
}

/**
 * Four-beat walk cycle (strideA, stand, strideB, stand) driven by distance walked,
 * so the gait stays continuous across tile boundaries. Stride beats bob up 1px.
 */
function walkCycleFrame(
  p: Passenger,
  frames: PersonFrames,
): { image: HTMLCanvasElement; bobY: number } {
  if (p.step.kind !== 'stepping') return { image: frames.stand, bobY: 0 };
  const beat = Math.floor(p.walkPhase * 8) % 4;
  if (beat === 0) return { image: frames.strideA, bobY: -1 };
  if (beat === 2) return { image: frames.strideB, bobY: -1 };
  return { image: frames.stand, bobY: 0 };
}

function drawFrustrationBar(
  ctx: CanvasRenderingContext2D,
  p: Passenger,
  pos: { x: number; y: number },
): void {
  if (p.phase.kind === 'storming') return;
  // Patience bar: starts full green and drains toward an empty red sliver.
  // Shop visits can bank patience past full; the bar just shows full.
  const patience = Math.min(1, 1 - p.frustration / MAX_FRUSTRATION);
  const hue = 120 * patience;
  fill(ctx, 'rgba(0,0,0,0.4)', pos.x + 3, pos.y - 3, 10, 2);
  ctx.fillStyle = `hsl(${hue}, 75%, 50%)`;
  ctx.fillRect(pos.x + 3, pos.y - 3, Math.round(10 * patience), 2);
}
