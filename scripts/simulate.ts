/**
 * Headless speed-runner for balance stress-testing.
 *
 * Drives the REAL game engine — the same sim.ts/level.ts/flowfield.ts modules the
 * browser runs, integrated through the same stepGame() entry point — so harness
 * results can never drift from in-game behavior. Only the driver differs: a Node
 * loop instead of requestAnimationFrame, and a seeded RNG for reproducibility.
 *
 * Usage: pnpm sim [durationSeconds]
 */
import { BUILDABLE, SERVICE_X } from '../src/constants';
import { buildGrid, createShops, createSlots } from '../src/level';
import { createGame, placeFence, stepGame } from '../src/sim';
import type { Game } from '../src/types';
import { ensureChannels, openLanesUpTo, reinvest } from './bots';

const DURATION = Number(process.argv[2] ?? 600);
const SEEDS = [1, 2, 3, 4, 5];

type Strategy = {
  name: string;
  description: string;
  /** Applied once at t=0, before any passengers exist. */
  setup(game: Game): void;
  /** Optional per-second action — how a real player reinvests income mid-day. */
  act?(game: Game, t: number): void;
};

/**
 * The "potentially optimal" build: two full-height fence combs DIRECTLY at the
 * bottleneck, forcing a single-file serpentine — south gap, up the inner corridor,
 * north gap, down the dispatch corridor where passengers peel off to whichever
 * lane is freest (lane re-pick).
 */
function buildSnake(game: Game): void {
  let failed = 0;
  for (let y = BUILDABLE.y0; y <= BUILDABLE.y1 - 3; y++) {
    if (!placeFence(game, { x: SERVICE_X - 4, y })) failed++;
  }
  for (let y = BUILDABLE.y0 + 3; y <= BUILDABLE.y1; y++) {
    if (!placeFence(game, { x: SERVICE_X - 2, y })) failed++;
  }
  if (failed > 0) console.warn(`  snake build: ${failed} fence placements failed`);
}

const STRATEGIES: Strategy[] = [
  {
    name: 'idle',
    description: '1 poverty lane, no build (the do-nothing baseline — must FAIL)',
    setup: () => {},
  },
  {
    name: 'lanes3',
    description: 'up to 3 lanes, open floor — capacity without layout (the blob)',
    setup: () => {},
    act: (game) => {
      openLanesUpTo(game, 3);
    },
  },
  {
    name: 'snake3',
    description: 'single-file serpentine at the bottleneck + up to 3 lanes',
    setup: buildSnake,
    act: (game) => {
      openLanesUpTo(game, 3);
    },
  },
  {
    name: 'corridors3',
    description: 'mouth-sealed channels on every open lane + up to 3 lanes, no shops',
    setup: (game) => {
      ensureChannels(game, 12);
    },
    act: (game) => {
      openLanesUpTo(game, 3);
      if (game.money > 60) ensureChannels(game, 20);
    },
  },
  {
    name: 'allshops',
    description: 'no fences: reinvest into shops, lanes, and every upgrade',
    setup: () => {},
    act: (game) => {
      reinvest(game);
    },
  },
  {
    name: 'corrshops',
    description: 'channels on every lane + floor-first reinvest + shops',
    // (Depth stays fixed when rich: under the walkout rule, dumping surplus
    // into deeper fences instead of the floor is a trap. Depth respects the
    // patience budget: at frustStill 6.5 a base-speed lane sustains ~13 tiles
    // — the worst seat waits depth × 2.8s against ~36s — so 14 structurally
    // storms its own tail. Max useful depth scales with lane level, one more
    // reason capacity and rope are partners.)
    setup: (game) => {
      ensureChannels(game, 12);
    },
    act: (game) => {
      ensureChannels(game, 12);
      // Cash buffer per the search elites' reserve gene (~$170): a wave ending
      // in the red is bankruptcy, so competent play never spends to zero.
      if (game.money > 150) reinvest(game);
    },
  },
  {
    name: 'optimal',
    description: 'the search-elite build: depth-13 channels, floor first, lane upgrades late',
    // Ever-deeper channels when rich are a trap: under the walkout rule that
    // fence money starves lane upgrades and service collapses. The search
    // elites hold depth ~13 and convert the late surplus into throughput
    // instead.
    setup: (game) => {
      ensureChannels(game, 13);
    },
    act: (game) => {
      ensureChannels(game, 13);
      // Same reserve discipline the elite genomes carry (reserve ≈ $169).
      if (game.money > 150) reinvest(game);
    },
  },
];

type RunResult = {
  served: number;
  walkOffs: number;
  turnedAway: number;
  finalMoney: number;
  minMoney: number;
  avgSat: number;
  peakFrustration: number;
  peakInside: number;
  moneyTimeline: number[];
  /** 1 if the day ENDED (bankruptcy or walkout shutdown) before the horizon. */
  failed: number;
};

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

function runOnce(strategy: Strategy, seed: number): RunResult {
  // SIDE EFFECT: Math.random is swapped for a seeded generator for the duration of
  // the run, then restored. The engine calls Math.random directly; seeding at the
  // global is the only way to get reproducible runs without forking the engine.
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    strategy.setup(game);

    let minMoney = game.money;
    let peakFrustration = 0;
    let peakInside = 0;
    const moneyTimeline: number[] = [];

    for (let t = 0; t < DURATION; t++) {
      strategy.act?.(game, t);
      stepGame(game, 1);
      minMoney = Math.min(minMoney, game.money);
      peakInside = Math.max(peakInside, game.passengers.length);
      for (const p of game.passengers) {
        if (p.phase.kind === 'queueing') {
          peakFrustration = Math.max(peakFrustration, p.frustration);
        }
      }
      if (t % 60 === 0) moneyTimeline.push(Math.round(game.money));
    }
    moneyTimeline.push(Math.round(game.money));

    const { served, walkOffs, turnedAway, satisfactionSum } = game.stats;
    return {
      served,
      walkOffs,
      turnedAway,
      finalMoney: Math.round(game.money),
      minMoney: Math.round(minMoney),
      avgSat: served > 0 ? satisfactionSum / served : 0,
      peakFrustration: Math.round(peakFrustration),
      peakInside,
      moneyTimeline,
      failed: game.failed ? 1 : 0,
    };
  } finally {
    Math.random = realRandom;
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

console.log(`Checkpoint! balance speed-run — ${DURATION}s day, seeds [${SEEDS.join(', ')}]`);
console.log('(all economy numbers live in balance/tuning — see src/constants.ts)\n');

const summary: Record<string, Record<string, number>> = {};
for (const strategy of STRATEGIES) {
  console.log(`── ${strategy.name}: ${strategy.description}`);
  const results = SEEDS.map((seed) => runOnce(strategy, seed));
  const first = results[0];
  if (first) console.log(`  money @60s intervals (seed 1): ${first.moneyTimeline.join(' → ')}`);
  summary[strategy.name] = {
    served: mean(results.map((r) => r.served)),
    walkOffs: mean(results.map((r) => r.walkOffs)),
    turnedAway: mean(results.map((r) => r.turnedAway)),
    finalMoney: mean(results.map((r) => r.finalMoney)),
    minMoney: mean(results.map((r) => r.minMoney)),
    avgSat: mean(results.map((r) => r.avgSat)),
    peakFrust: mean(results.map((r) => r.peakFrustration)),
    peakInside: mean(results.map((r) => r.peakInside)),
    failed: mean(results.map((r) => r.failed)),
  };
}

console.log('\nMeans over seeds:');
const cols = [
  'served',
  'walkOffs',
  'turnedAway',
  'finalMoney',
  'minMoney',
  'avgSat',
  'peakFrust',
  'peakInside',
] as const;
const header = ['strategy', ...cols].map((c) => c.padEnd(11)).join(' ');
console.log(header);
for (const [name, row] of Object.entries(summary)) {
  const cells = cols.map((c) => String(Math.round((row[c] ?? 0) * 10) / 10).padEnd(11));
  console.log(`${name.padEnd(11)} ${cells.join(' ')}`);
}

console.log('\nBalance verdict:');
// The overtime deluge (waves 18+) guarantees some late losses BY DESIGN, so the
// whole-day contract is economic: skilled play ends the day net-positive with a
// contained walk-off share. (The opening contract lives in scripts/waves.ts.)
const share = (row: Record<string, number>): number =>
  (row['walkOffs'] ?? 0) / Math.max(1, (row['walkOffs'] ?? 0) + (row['served'] ?? 0));
for (const [name, row] of Object.entries(summary)) {
  const failShare = row['failed'] ?? 0;
  console.log(
    `  ${name.padEnd(11)} walk-offs ${String(Math.round((row['walkOffs'] ?? 0) * 10) / 10).padEnd(6)} ` +
      `(${(100 * share(row)).toFixed(1)}% of resolved)  bank $${Math.round(row['finalMoney'] ?? 0)}` +
      (failShare > 0 ? `  [day ended early on ${Math.round(failShare * 100)}% of seeds]` : ''),
  );
}
// A frozen post-shutdown bank is not a profitable day: failed days don't count.
const positive = Object.entries(summary).filter(
  ([, row]) => (row['finalMoney'] ?? -1) > 0 && (row['failed'] ?? 1) < 0.5,
);
// ≤3%: under greedy-crowd pathing, cutting crushes at bottlenecks tax even
// disciplined builds a point of walk-offs, so the bar is containment, not
// zero. Degenerate strategies still die outright, which is the gate that
// matters; "contained" marks skilled play, not perfection.
const contained = Object.entries(summary).filter(([, row]) => share(row) <= 0.03);
console.log(
  `  net-positive days: ${positive.length} (${positive.map(([n]) => n).join(', ') || 'none'})`,
);
console.log(
  `  contained days (≤3% walk-offs): ${contained.length} (${contained.map(([n]) => n).join(', ') || 'none'})`,
);
const pass = positive.length >= 2 && contained.length >= 1;
console.log(`  invariant (≥2 net-positive, ≥1 contained): ${pass ? 'PASS' : 'FAIL'}`);
if (!pass) process.exitCode = 1;
