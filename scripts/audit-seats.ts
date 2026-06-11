/**
 * Seat-utilization probe: build the anchor (Grand Coffee Bar) at max level
 * (16 perimeter seats), run waves of errand traffic, and tally visits per
 * seat. Healthy seat-aware pathing spreads load across the whole perimeter;
 * the failure mode (naive nearest-tile descent) piles everyone on the
 * flow-facing corner and leaves the far seats permanently empty.
 *
 * Usage: pnpm tsx scripts/audit-seats.ts
 */
import { activeVisits } from '../src/constants';
import { tileIndex } from '../src/flowfield';
import { buildGrid, createShops, createSlots } from '../src/level';
import { createGame, stepGame, toggleCheckpoint, toggleShop, upgradeShop } from '../src/sim';

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PER_SEAT = new Map<number, number>();
const knotSamples: number[] = [];
let seatCount = 0;

for (const seed of [1, 2, 3]) {
  const realRandom = Math.random;
  Math.random = mulberry32(seed * 77 + 5);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    game.money = 100000;
    const anchor = game.shops.findIndex((s) => s.tier === 'large');
    toggleShop(game, anchor);
    upgradeShop(game, anchor);
    upgradeShop(game, anchor);
    toggleCheckpoint(game, 3);
    const shop = game.shops[anchor];
    if (!shop) continue;
    // Key by seat ORDER (position in the visits list, stable across seeds —
    // tile indices differ per seed under random mall placement).
    const seats = activeVisits(shop).map((v) => tileIndex(game.grid, v));
    seatCount = seats.length;
    // Count distinct browse sessions per seat: a seat "starts" a visit when a
    // SHOPPING passenger appears on it after being empty/non-shopping.
    const wasShopping = seats.map(() => false);
    const seatTiles = activeVisits(shop);
    for (let k = 0; k < 3000; k++) {
      stepGame(game, 0.1);
      for (const [order, i] of seats.entries()) {
        const id = game.occupancy.get(i);
        const p = id !== undefined ? game.passengers.find((q) => q.id === id) : undefined;
        const shopping = !!p && p.phase.kind === 'shopping';
        if (shopping && !wasShopping[order]) {
          PER_SEAT.set(order, (PER_SEAT.get(order) ?? 0) + 1);
        }
        wasShopping[order] = shopping;
      }
      // Knot metric: the largest camp of would-be shoppers idling beside any
      // single seat (the entrance-face mob that seat pricing exists to dissolve).
      if (k % 10 === 0) {
        let worst = 0;
        for (const v of seatTiles) {
          let camp = 0;
          for (const p of game.passengers) {
            if (p.phase.kind !== 'queueing' || p.shopTarget !== anchor) continue;
            if (p.tile.x === v.x && p.tile.y === v.y) continue;
            if (Math.abs(p.tile.x - v.x) <= 1 && Math.abs(p.tile.y - v.y) <= 1) camp++;
          }
          worst = Math.max(worst, camp);
        }
        knotSamples.push(worst);
      }
    }
  } finally {
    Math.random = realRandom;
  }
}

const counts = [...PER_SEAT.values()];
const total = counts.reduce((a, b) => a + b, 0);
const used = counts.filter((c) => c > 0).length;
const max = Math.max(...counts, 0);
const min = used === seatCount ? Math.min(...counts) : 0;
console.log(`Anchor seat utilization over 3 seeds × 300s (16 seats at L2):`);
console.log(
  `  total visits ${total} · seats used ${used}/${seatCount} · per-seat min ${min} max ${max}`,
);
console.log(`  spread: ${counts.sort((a, b) => b - a).join(' ')}`);
const knotMean = knotSamples.reduce((a, b) => a + b, 0) / Math.max(1, knotSamples.length);
console.log(
  `  camp beside one seat: mean ${knotMean.toFixed(2)} max ${Math.max(...knotSamples, 0)}`,
);
const pass = used >= seatCount * 0.8;
console.log(pass ? 'PASS: ≥80% of seats see traffic' : 'FAIL: far seats starved');
process.exitCode = pass ? 0 : 1;
