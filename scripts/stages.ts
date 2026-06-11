/**
 * Stage-segmented balance report: pacing diagnostics per rush-ladder stage.
 *
 * The sweep scores whole days; this slices a day along the rushSchedule() stages
 * so each PHASE of the game can be judged: is the opening boring (idle lanes,
 * piling money, zero threat)? Do mid-ladder rushes bite? Does the late game
 * overwhelm? Run it against a couple of play qualities and read the table.
 *
 * Usage: pnpm tsx scripts/stages.ts [durationSeconds]
 */
import { rushSchedule } from '../src/constants';
import { buildGrid, createShops, createSlots } from '../src/level';
import { createGame, stepGame } from '../src/sim';
import type { Game } from '../src/types';
import { buildCorridors, extendCorridors, openLanesUpTo, reinvest } from './bots';

const DURATION = Number(process.argv[2] ?? 1500);
const SEEDS = [1, 2, 3];

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

type Strategy = { name: string; act(game: Game, t: number): void };

const STRATEGIES: Strategy[] = [
  { name: 'idle', act: () => {} },
  {
    name: 'lanes',
    act: (game) => {
      openLanesUpTo(game, 6);
    },
  },
  {
    name: 'good',
    act: (game, t) => {
      if (t === 0) buildCorridors(game, 3);
      reinvest(game);
      if (game.money > 1000) extendCorridors(game);
    },
  },
];

/** Windows: opening [0, R1), then one window per rush stage (gap + rush). */
type Window = { label: string; start: number; end: number; rate: number };

function makeWindows(horizon: number): Window[] {
  const stages = rushSchedule().filter((s) => s.start < horizon);
  const windows: Window[] = [];
  let prev = 0;
  for (const [k, s] of stages.entries()) {
    if (k === 0) windows.push({ label: 'open', start: 0, end: s.start, rate: 0 });
    windows.push({
      label: `R${k + 1}`,
      start: prev === 0 ? s.start : prev,
      end: s.end,
      rate: s.rate,
    });
    prev = s.end;
  }
  return windows;
}

type Sample = {
  arrivals: number;
  served: number;
  storms: number;
  dMoney: number;
  bank: number;
  inside: number;
  idleShare: number;
};

function runOnce(strategy: Strategy, seed: number, windows: Window[]): Sample[] {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    const rows: Sample[] = [];
    let w = 0;
    let mark = { spawned: 0, served: 0, storms: 0, money: game.money };
    let idleTicks = 0;
    let insideSum = 0;
    let ticks = 0;
    for (let t = 0; t < DURATION; t++) {
      strategy.act(game, t);
      stepGame(game, 1);
      ticks++;
      insideSum += game.passengers.length;
      const openSlots = game.slots.filter((s) => s.state === 'open');
      const busy = game.passengers.filter((p) => p.phase.kind === 'processing').length;
      if (busy < openSlots.length) idleTicks++;
      const win = windows[w];
      if (win && t + 1 >= win.end) {
        const spawned = game.nextId - 1;
        rows.push({
          arrivals: spawned - mark.spawned,
          served: game.stats.served - mark.served,
          storms: game.stats.walkOffs - mark.storms,
          dMoney: Math.round(game.money - mark.money),
          bank: Math.round(game.money),
          inside: Math.round(insideSum / ticks),
          idleShare: Math.round((100 * idleTicks) / ticks),
        });
        mark = {
          spawned,
          served: game.stats.served,
          storms: game.stats.walkOffs,
          money: game.money,
        };
        idleTicks = 0;
        insideSum = 0;
        ticks = 0;
        w++;
      }
    }
    return rows;
  } finally {
    Math.random = realRandom;
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const windows = makeWindows(DURATION);
console.log(`Stage report — ${DURATION}s, seeds [${SEEDS.join(',')}]`);
for (const strategy of STRATEGIES) {
  const runs = SEEDS.map((s) => runOnce(strategy, s, windows));
  console.log(`\n── ${strategy.name}`);
  console.log('stage   t          rate  arrivals served storms  Δmoney   bank  inside idle%');
  for (const [i, win] of windows.entries()) {
    const rows = runs.map((r) => r[i]).filter((r): r is Sample => r !== undefined);
    if (rows.length === 0) break;
    const cells = [
      win.label.padEnd(7),
      `${Math.round(win.start)}-${Math.round(win.end)}`.padEnd(10),
      (win.rate ? win.rate.toFixed(2) : '—').padStart(5),
      String(Math.round(mean(rows.map((r) => r.arrivals)))).padStart(8),
      String(Math.round(mean(rows.map((r) => r.served)))).padStart(6),
      String(Math.round(mean(rows.map((r) => r.storms)))).padStart(6),
      String(Math.round(mean(rows.map((r) => r.dMoney)))).padStart(8),
      String(Math.round(mean(rows.map((r) => r.bank)))).padStart(6),
      String(Math.round(mean(rows.map((r) => r.inside)))).padStart(7),
      String(Math.round(mean(rows.map((r) => r.idleShare)))).padStart(5),
    ];
    console.log(cells.join(' '));
  }
}
