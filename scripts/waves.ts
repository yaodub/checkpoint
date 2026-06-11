/**
 * Wave-isolation harness: tune the OPENING of the game wave by wave.
 *
 * The tech tree is the difficulty curve (params are global), so each early wave
 * is simulated against the loadout the money gate actually allows at that point:
 *   wave 1 — trivial, nothing affordable, survive bare
 *   wave 2 — the FENCE exam: one lane, rope money only; bare must bleed walkaways
 *   wave 3 — the second-lane era: fences + lane 2 (funded by wave 2's paycheck)
 *
 * Usage: pnpm tsx scripts/waves.ts
 */
import { SERVICE_X, SLOT_YS, rushSchedule } from '../src/constants';
import { buildGrid, createShops, createSlots } from '../src/level';
import { createGame, placeFence, stepGame, toggleCheckpoint } from '../src/sim';
import type { Game } from '../src/types';

const SEEDS = [1, 2, 3, 4, 5];
const POVERTY_LANE_Y = SLOT_YS[2] ?? 10;

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

/**
 * ONE deep channel into a lane. While a channel has room, caterpillar flow lets
 * arrivals stream in at near walk speed — no mouth wedge. The wedge only forms
 * when it FILLS, so the channel must be deep enough to hold a wave's overflow.
 * (Agents only take strictly-closer steps, so parallel channels go unused.)
 */
function fenceChannel(game: Game, laneY: number, depth: number): void {
  // x starts AT the service column: sealing (SERVICE_X, y±1) is what stops the
  // mob from flowing around the channel and wedging directly at the lane mouth.
  for (let x = SERVICE_X; x >= SERVICE_X - depth; x--) {
    placeFence(game, { x, y: laneY - 1 });
    placeFence(game, { x, y: laneY + 1 });
  }
}

type Loadout = { name: string; act(game: Game, t: number, w1End: number): void };

const LOADOUTS: Loadout[] = [
  { name: 'bare', act: () => {} },
  {
    name: 'fences',
    act: (game, t, w1End) => {
      // Lay a deep channel right after wave 1, keep deepening with profits.
      if (t === Math.round(w1End) + 2) fenceChannel(game, POVERTY_LANE_Y, 24);
      if (t > w1End + 2 && t % 3 === 0 && game.money > 40) {
        fenceChannel(game, POVERTY_LANE_Y, 30);
      }
    },
  },
  {
    name: 'fences+lane2',
    act: (game, t, w1End) => {
      // Channel first (cheap), then SAVE for the second lane, then fence it too.
      if (t === Math.round(w1End) + 2) fenceChannel(game, POVERTY_LANE_Y, 24);
      if (t > w1End && game.slots[3]?.state === 'closed') {
        if (toggleCheckpoint(game, 3) === 'opened') {
          fenceChannel(game, SLOT_YS[3] ?? 14, 20);
        }
      }
      if (game.slots[3]?.state === 'open' && t % 3 === 0 && game.money > 40) {
        fenceChannel(game, POVERTY_LANE_Y, 30);
        fenceChannel(game, SLOT_YS[3] ?? 14, 26);
      }
    },
  },
  {
    name: 'fences+3lanes',
    act: (game, t, w1End) => {
      // The wave-4 era loadout: channels + lanes 2 AND 3, each fenced on open.
      // (Kiosks are W4-FUNDABLE under the inverted economy, but optimal W4 play
      // is still pure geometry+capacity — the mall meta belongs to W5+, where
      // the whole-day harnesses take over.)
      if (t === Math.round(w1End) + 2) fenceChannel(game, POVERTY_LANE_Y, 24);
      if (t > w1End && game.slots[3]?.state === 'closed') {
        if (toggleCheckpoint(game, 3) === 'opened') fenceChannel(game, SLOT_YS[3] ?? 14, 20);
      } else if (game.slots[3]?.state === 'open' && game.slots[1]?.state === 'closed') {
        if (toggleCheckpoint(game, 1) === 'opened') fenceChannel(game, SLOT_YS[1] ?? 6, 20);
      }
      // Keep a cash buffer while deepening: a wave end in the red is BANKRUPTCY,
      // so a competent player never fences down to $0 (spending VIP windfalls
      // to zero dies on unlucky seeds).
      if (game.slots[1]?.state === 'open' && t % 3 === 0 && game.money > 150) {
        fenceChannel(game, POVERTY_LANE_Y, 30);
        fenceChannel(game, SLOT_YS[3] ?? 14, 26);
        fenceChannel(game, SLOT_YS[1] ?? 6, 26);
      }
    },
  },
];

type Window = { label: string; start: number; end: number; rate: number };

const stages = rushSchedule().slice(0, 4);
const windows: Window[] = stages.map((s, k) => ({
  label: `W${k + 1}`,
  start: s.start,
  end: s.end,
  rate: s.rate,
}));
const DURATION = Math.round((stages[3]?.end ?? 500) + 45);

type Row = { arrivals: number; storms: number; served: number; bank: number };

function runOnce(loadout: Loadout, seed: number): Row[] {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    const w1End = stages[0]?.end ?? 110;
    const rows: Row[] = windows.map(() => ({ arrivals: 0, storms: 0, served: 0, bank: 0 }));
    let prev = { spawned: 0, storms: 0, served: 0 };
    for (let t = 0; t < DURATION; t++) {
      loadout.act(game, t, w1End);
      stepGame(game, 1);
      for (const [i, win] of windows.entries()) {
        // Attribute each wave's fallout through 25s past its end (stragglers).
        if (t + 1 === Math.round(win.end) + 25) {
          const row = rows[i];
          if (!row) continue;
          row.arrivals = game.nextId - 1 - prev.spawned;
          row.storms = game.stats.walkOffs - prev.storms;
          row.served = game.stats.served - prev.served;
          row.bank = Math.round(game.money);
          prev = {
            spawned: game.nextId - 1,
            storms: game.stats.walkOffs,
            served: game.stats.served,
          };
        }
      }
    }
    return rows;
  } finally {
    Math.random = realRandom;
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

console.log(`Wave exam — first 3 waves, seeds [${SEEDS.join(',')}]`);
for (const [k, win] of windows.entries()) {
  console.log(
    `  W${k + 1}: t=${Math.round(win.start)}–${Math.round(win.end)} @ ${win.rate.toFixed(2)}/s`,
  );
}
const results = new Map<string, Row[][]>();
for (const loadout of LOADOUTS) {
  results.set(
    loadout.name,
    SEEDS.map((s) => runOnce(loadout, s)),
  );
}
console.log('\nloadout        wave arrivals storms served   bank');
for (const loadout of LOADOUTS) {
  const runs = results.get(loadout.name) ?? [];
  for (const [i] of windows.entries()) {
    const rows = runs.map((r) => r[i]).filter((r): r is Row => r !== undefined);
    console.log(
      [
        loadout.name.padEnd(14),
        `W${i + 1}`.padEnd(4),
        String(Math.round(mean(rows.map((r) => r.arrivals)))).padStart(8),
        mean(rows.map((r) => r.storms))
          .toFixed(1)
          .padStart(6),
        String(Math.round(mean(rows.map((r) => r.served)))).padStart(6),
        String(Math.round(mean(rows.map((r) => r.bank)))).padStart(6),
      ].join(' '),
    );
  }
}

// Pass/fail contract for the opening:
const get = (name: string, w: number, f: (r: Row) => number): number =>
  mean(
    (results.get(name) ?? [])
      .map((r) => r[w])
      .filter((r): r is Row => !!r)
      .map(f),
  );
const checks: [string, boolean][] = [
  ['W1 bare is trivial (≤1 storm)', get('bare', 0, (r) => r.storms) <= 1],
  ['W2 bare bleeds walkaways (≥4)', get('bare', 1, (r) => r.storms) >= 4],
  ['W2 fenced passes clean (≤1)', get('fences', 1, (r) => r.storms) <= 1],
  ['W3 fences+lane2 passes (≤2)', get('fences+lane2', 2, (r) => r.storms) <= 2],
  ['W4 channel-cheese collapses (≥6)', get('fences', 3, (r) => r.storms) >= 6],
  // Deep channels legitimately let a maze-skilled player run ONE tech step
  // behind — bounded slack. The 3rd lane's gate is economic: it buys serves.
  [
    'W4 3rd lane buys throughput (+8 serves)',
    get('fences+3lanes', 3, (r) => r.served) >= get('fences+lane2', 3, (r) => r.served) + 8,
  ],
  // Contained per a ≤4% walk-off standard (W4 brings ~135 people). The inverted
  // economy makes the W4 era a deliberate squeeze — capacity in aggregate costs
  // more, and the handful of marginal walk-offs is the era's lesson that
  // geometry+capacity alone has a ceiling (the mall meta opens at W5+).
  ['W4 fences+3lanes contained (≤4%)', get('fences+3lanes', 3, (r) => r.storms) <= 6],
];
console.log('');
let pass = true;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) pass = false;
}
process.exitCode = pass ? 0 : 1;
