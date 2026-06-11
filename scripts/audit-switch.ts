/**
 * Targeted audit for the line-collapse bug: build a mazed line of ~10 on the
 * poverty lane, open a NEW checkpoint mid-queue, and count how many of the
 * pre-existing line defect within 5s. Healthy behavior: at most the tail
 * (1-2) peels; the line never collapses backward.
 *
 * Usage: pnpm tsx scripts/audit-switch.ts
 */
import { SERVICE_X, SLOT_YS } from '../src/constants';
import { buildGrid, createShops, createSlots } from '../src/level';
import { createGame, placeFence, stepGame, toggleCheckpoint } from '../src/sim';
import type { Game } from '../src/types';

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

function channel(game: Game, laneY: number, depth: number): void {
  for (let x = SERVICE_X; x >= SERVICE_X - depth; x--) {
    placeFence(game, { x, y: laneY - 1 });
    placeFence(game, { x, y: laneY + 1 });
  }
}

const POVERTY = 2; // slot index of the starting lane
const NEW_SLOT = 3;

for (const seed of [1, 2, 3, 4, 5]) {
  const realRandom = Math.random;
  Math.random = mulberry32(seed * 31 + 7);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    game.money = 5000;
    channel(game, SLOT_YS[POVERTY] ?? 10, 16);
    // Let a line build up on the poverty lane.
    while (game.time < 120 && game.passengers.filter((p) => p.lane === POVERTY).length < 10) {
      stepGame(game, 1);
    }
    const lineIds = new Set(
      game.passengers
        .filter((p) => p.lane === POVERTY && p.phase.kind === 'queueing')
        .map((p) => p.id),
    );
    toggleCheckpoint(game, NEW_SLOT);
    let defected = 0;
    const counted = new Set<number>();
    for (let t = 0; t < 5; t++) {
      stepGame(game, 1);
      for (const p of game.passengers) {
        if (lineIds.has(p.id) && p.lane !== POVERTY && !counted.has(p.id)) {
          counted.add(p.id);
          defected++;
        }
      }
    }
    console.log(
      `seed ${seed}: line of ${lineIds.size} → ${defected} defected within 5s of opening lane ${NEW_SLOT}`,
    );
  } finally {
    Math.random = realRandom;
  }
}
