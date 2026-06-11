/**
 * Shared bot-player primitives for the balance harnesses (simulate.ts, sweep.ts).
 *
 * The poverty start makes purchase ORDER part of play quality: the rush ladder
 * (constants.ts rushSchedule) assumes a perfect player funds capacity purchases
 * cheapest-first, just in time. Bots here mirror that: capacity buys lead, cheap
 * kiosks ride the surplus, big shops and upgrades come once capacity is maxed.
 * Everything is derived from SLOT_YS/SERVICE_X/BUILDABLE so board resizes keep
 * the layouts valid.
 */
import {
  BUILDABLE,
  CHECKPOINTS_TOTAL,
  MAX_LEVEL,
  SERVICE_X,
  SLOT_YS,
  laneUpgradeCost,
  shopCost,
} from '../src/constants';
import {
  laneOpenCost,
  placeFence,
  toggleCheckpoint,
  toggleShop,
  upgradeCheckpoint,
  upgradeShop,
} from '../src/sim';
import type { Game } from '../src/types';

/** Lanes that get fenced approach corridors (the poverty lane + first two opens). */
export const CORRIDOR_LANES = [1, 2, 4].map((i) => SLOT_YS[i] ?? 0);
/** Reinvest income biggest-first (anchor 4, stores 2/3, kiosks 0/1/5) once rich. */
export const SHOP_BUY_ORDER = [4, 2, 3, 0, 1, 5];
/** Cheapest-first shop order for the climb (kiosks are pocket change, big relief/$). */
export const SHOP_CHEAP_ORDER = [0, 1, 5, 2, 3, 4];
/** Extra lanes to open as profits allow (closest to the poverty lane first). */
export const LANE_OPEN_ORDER = [3, 1, 4, 0, 5];

/** Open another lane if below the cap and affordable; true if one opened. */
export function openLanesUpTo(game: Game, maxOpen: number): boolean {
  if (game.slots.filter((s) => s.state !== 'closed').length >= maxOpen) return false;
  for (const i of LANE_OPEN_ORDER) {
    if (game.slots[i]?.state === 'closed' && toggleCheckpoint(game, i) === 'opened') return true;
  }
  return false;
}

export function capacityMaxed(game: Game, maxLanes = CHECKPOINTS_TOTAL): boolean {
  const open = game.slots.filter((s) => s.state !== 'closed');
  return open.length >= maxLanes && open.every((s) => s.level >= MAX_LEVEL);
}

/**
 * Buy the single cheapest capacity purchase (lane open vs lane upgrade) if
 * affordable — the exact cheapest-first ladder rushSchedule() pressure-tests.
 * Returns true if money was spent.
 */
export function buyCheapestCapacity(game: Game, maxLanes = CHECKPOINTS_TOTAL): boolean {
  const open = game.slots.filter((s) => s.state !== 'closed').length;
  let bestCost = open < maxLanes ? laneOpenCost(game) : Infinity;
  let bestSlot = -1; // -1 = open a new lane
  for (const [i, slot] of game.slots.entries()) {
    if (slot.state !== 'open' || slot.level >= MAX_LEVEL) continue;
    const cost = laneUpgradeCost(slot.level);
    if (cost < bestCost) {
      bestCost = cost;
      bestSlot = i;
    }
  }
  if (!Number.isFinite(bestCost) || game.money < bestCost) return false;
  if (bestSlot >= 0) return upgradeCheckpoint(game, bestSlot);
  return openLanesUpTo(game, maxLanes);
}

/** Buy the next shop in the given order if affordable; true if one was bought. */
export function buyNextShop(game: Game, order: readonly number[], maxCost = Infinity): boolean {
  for (const i of order) {
    const shop = game.shops[i];
    if (!shop || shop.built) continue;
    if (shopCost(shop.tier) > maxCost) continue;
    if (toggleShop(game, i) === 'built') return true;
  }
  return false;
}

/** Upgrade the next upgradable shop, biggest first; true if money was spent. */
export function upgradeNextShop(game: Game): boolean {
  for (const i of SHOP_BUY_ORDER) {
    const shop = game.shops[i];
    if (shop?.built && shop.level < MAX_LEVEL && upgradeShop(game, i)) return true;
  }
  return false;
}

/**
 * The "perfect player" reinvestment plan, per the search elites under the
 * INVERTED economy: build the FLOOR first — lanes opened and shops
 * cheapest-first interleaved (the mall finances the tree and shaves the peaks)
 * — then convert the late surplus into lane upgrades (throughput = service
 * quality = survival under the walkout rule), then shop upgrades.
 */
export function reinvest(game: Game, maxLanes = CHECKPOINTS_TOTAL): void {
  const opens = game.slots.filter((s) => s.state !== 'closed').length;
  if (opens < maxLanes && openLanesUpTo(game, maxLanes)) return;
  if (buyNextShop(game, SHOP_CHEAP_ORDER)) return;
  if (opens < maxLanes || !game.shops.every((s) => s.built)) return; // floor first
  if (buyCheapestCapacity(game, maxLanes)) return; // endgame: lane upgrades
  upgradeNextShop(game);
}

/**
 * Single-file fenced approach corridors directly upstream of each corridor lane.
 * Walls run all the way TO the service column — sealing (SERVICE_X, y±1) is what
 * stops the mob from flowing around the channel and wedging at the lane mouth.
 */
export function buildCorridors(game: Game, depth: number): number {
  let placed = 0;
  for (const laneY of CORRIDOR_LANES) {
    for (let x = SERVICE_X - depth; x <= SERVICE_X; x++) {
      if (placeFence(game, { x, y: laneY - 1 })) placed++;
      if (placeFence(game, { x, y: laneY + 1 })) placed++;
    }
  }
  return placed;
}

/**
 * Mouth-sealed channel walls around EVERY open lane, to the given depth — the
 * build the balance pegs assume (board storage ≈ lanes × channel depth). Cheap
 * to call every tick: existing walls are skipped, missing ones are filled in as
 * money allows, newly opened lanes get fenced automatically. Fencing over a
 * future shop footprint is fine: construction clears its lot (full refund) and
 * the building itself becomes wall mass.
 */
export function ensureChannels(game: Game, depth: number): void {
  for (const slot of game.slots) {
    if (slot.state !== 'open') continue;
    for (let x = SERVICE_X; x >= SERVICE_X - depth; x--) {
      placeFence(game, { x, y: slot.y - 1 });
      placeFence(game, { x, y: slot.y + 1 });
    }
  }
}

/** Lengthen the corridors leftward as profits allow (depth for deep rushes). */
export function extendCorridors(game: Game): boolean {
  for (let x = SERVICE_X - 4; x >= BUILDABLE.x0 + 8; x--) {
    for (const laneY of CORRIDOR_LANES) {
      for (const y of [laneY - 1, laneY + 1]) {
        const i = y * game.grid.cols + x;
        if (game.grid.tiles[i] !== 'floor') continue;
        if (placeFence(game, { x, y })) return true;
      }
    }
  }
  return false;
}
