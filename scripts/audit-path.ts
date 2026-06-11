/**
 * Pathfinding stress audit: hunts the two artifact classes players actually
 * see — FLAPPING (rapid loops over 2-3 tiles with no progress) and STRANDING
 * (standing frozen while a free, strictly-closer step exists) — plus lane
 * ping-ponging, across scenarios that cover the algorithm's hard cases:
 *
 *   open-floor         3 bare lanes, greedy crowds, no guidance
 *   mazed-newlane      deep channel; new checkpoint + fence gap mid-wave
 *   chicane            serpentine walls — every journey is all bends
 *   gate-churn         corridor gates toggling forever (reroute whiplash)
 *   corridor-reversal  a line sealed mid-corridor must caterpillar BACK out
 *   shops-traffic      full mall, errand cross-traffic everywhere
 *
 * A frozen flag is a hard bug by construction: the sim takes any free
 * strictly-closer step the substep it sees one, so 3s of refusing one means
 * something structural (e.g. one-step memory with no unlock) is wedged.
 *
 * Usage: pnpm tsx scripts/audit-path.ts
 */
import { SERVICE_X, SLOT_YS } from '../src/constants';
import { UNREACHABLE, fieldAt, tileIndex } from '../src/flowfield';
import { buildGrid, createShops, createSlots } from '../src/level';
import {
  createGame,
  eraseAt,
  isOccupied,
  placeFence,
  placeGate,
  stepGame,
  toggleCheckpoint,
  toggleGate,
  toggleShop,
} from '../src/sim';
import type { Game, Passenger, Vec } from '../src/types';

const SEEDS = [1, 2, 3, 4, 5];
const STEP = 0.1;
const POVERTY_Y = SLOT_YS[2] ?? 10;

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

const NEIGHBORS: readonly Vec[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function targetField(game: Game, p: Passenger): Float64Array | null {
  const f = p.shopTarget !== null ? game.fields.shops[p.shopTarget] : game.fields.lanes[p.lane];
  return f ?? null;
}

/** A free (unoccupied, non-pending) strictly-closer neighbor exists right now. */
function freeCloserStep(game: Game, p: Passenger): boolean {
  const field = targetField(game, p);
  if (!field) return false;
  const here = fieldAt(field, tileIndex(game.grid, p.tile));
  if (here === UNREACHABLE) return false;
  for (const n of NEIGHBORS) {
    const to = { x: p.tile.x + n.x, y: p.tile.y + n.y };
    if (to.x < 0 || to.y < 0 || to.x >= game.grid.cols || to.y >= game.grid.rows) continue;
    const d = fieldAt(field, tileIndex(game.grid, to));
    if (d === UNREACHABLE || d >= here) continue;
    if (isOccupied(game, to)) continue;
    if (game.pending.some((b) => b.tile.x === to.x && b.tile.y === to.y)) continue;
    return true;
  }
  return false;
}

function wallV(game: Game, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) placeFence(game, { x, y });
}

function corridor(game: Game, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) {
    placeFence(game, { x, y: y - 1 });
    placeFence(game, { x, y: y + 1 });
  }
}

/** Gates place CLOSED by default; flip them open right after buying. */
function openGateAt(game: Game, tile: Vec): void {
  placeGate(game, tile);
  toggleGate(game, tile);
}

type Scenario = {
  name: string;
  duration: number;
  setup?: (game: Game) => void;
  act?: (game: Game, t: number) => void;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'open-floor',
    duration: 300,
    setup: (g) => {
      g.money = 5000;
      toggleCheckpoint(g, 1);
      toggleCheckpoint(g, 3);
    },
  },
  {
    name: 'mazed-newlane',
    duration: 300,
    setup: (g) => {
      g.money = 5000;
    },
    act: (g, t) => {
      if (t === 60) corridor(g, POVERTY_Y, SERVICE_X - 16, SERVICE_X);
      if (t === 180) toggleCheckpoint(g, 3);
      // Open a gap in the channel wall facing the new lane (slot 3 is below).
      if (t === 190) eraseAt(g, { x: SERVICE_X - 8, y: POVERTY_Y + 1 });
    },
  },
  {
    name: 'chicane',
    duration: 300,
    setup: (g) => {
      g.money = 50000;
      wallV(g, 14, 1, 18); // pass south
      wallV(g, 20, 7, 24); // pass north
      wallV(g, 26, 1, 18); // pass south
    },
  },
  {
    name: 'gate-churn',
    duration: 240,
    setup: (g) => {
      g.money = 50000;
      corridor(g, POVERTY_Y, 10, 26);
      for (const gx of [12, 18, 24]) openGateAt(g, { x: gx, y: POVERTY_Y });
    },
    act: (g, t) => {
      if (t > 0 && t % 16 === 0) {
        const gx = [12, 18, 24][(t / 16) % 3] ?? 12;
        toggleGate(g, { x: gx, y: POVERTY_Y });
      }
    },
  },
  {
    name: 'corridor-reversal',
    duration: 100,
    setup: (g) => {
      g.money = 50000;
      corridor(g, POVERTY_Y, 8, 28);
      openGateAt(g, { x: 20, y: POVERTY_Y });
    },
    // Seal the corridor mid-stream: everyone west of the gate must walk BACK
    // out the mouth and around — their first required step is the tile they
    // just came from (the one-step memory's worst case).
    act: (g, t) => {
      if (t === 35) toggleGate(g, { x: 20, y: POVERTY_Y });
    },
  },
  {
    // A wall thrown ACROSS the live stream every 20s, alternating which side
    // stays open — every flip drops pending fences onto occupied tiles and
    // inverts the cheapest detour. Reroutes must compute and nobody freezes.
    name: 'fence-churn',
    duration: 300,
    setup: (g) => {
      g.money = 50000;
    },
    act: (g, t) => {
      if (t < 40 || t % 20 !== 0) return;
      const phase = (t / 20) % 2;
      for (let y = 1; y <= 24; y++) eraseAt(g, { x: 16, y });
      if (phase === 0)
        wallV(g, 16, 1, 16); // south passage open
      else wallV(g, 16, 9, 24); // north passage open
    },
  },
  {
    // Box a streaming crowd in mid-floor (lane goes UNREACHABLE → wander),
    // hold them 30s, then cut the box open: everyone must snap back to
    // purposeful pathing and walk out, no freezes.
    name: 'seal-release',
    duration: 240,
    setup: (g) => {
      g.money = 50000;
    },
    act: (g, t) => {
      if (t === 60) {
        for (let x = 12; x <= 20; x++) {
          placeFence(g, { x, y: 7 });
          placeFence(g, { x, y: 13 });
        }
        for (let y = 8; y <= 12; y++) {
          placeFence(g, { x: 12, y });
          placeFence(g, { x: 20, y });
        }
      }
      if (t === 90) {
        eraseAt(g, { x: 20, y: 10 });
        eraseAt(g, { x: 20, y: 11 });
      }
    },
  },
  {
    name: 'shops-traffic',
    duration: 300,
    setup: (g) => {
      g.money = 100000;
      for (let i = 0; i < g.shops.length; i++) toggleShop(g, i);
      toggleCheckpoint(g, 3);
    },
  },
];

type Move = { t: number; key: string };
type Track = {
  lastKey: string;
  lastLane: number;
  lastChangeT: number;
  moves: Move[];
  switches: number[];
  frozenFor: number;
};

type RunResult = {
  flap: number;
  frozen: number;
  laneOsc: number;
  served: number;
  storms: number;
  maxIdle: number;
  details: string[];
};

function runScenario(sc: Scenario, seed: number): RunResult {
  const realRandom = Math.random;
  Math.random = mulberry32(seed * 1013 + 31);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    sc.setup?.(game);
    const tracks = new Map<number, Track>();
    const flap = new Set<number>();
    const frozen = new Set<number>();
    const laneOsc = new Set<number>();
    const details: string[] = [];
    const note = (msg: string): void => {
      if (details.length < 5) details.push(msg);
    };

    const ticks = Math.round(sc.duration / STEP);
    for (let k = 0; k < ticks; k++) {
      const t = k * STEP;
      if (k % Math.round(1 / STEP) === 0) sc.act?.(game, Math.round(t));
      stepGame(game, STEP);

      for (const p of game.passengers) {
        if (p.phase.kind !== 'queueing') {
          tracks.delete(p.id);
          continue;
        }
        const key = `${p.tile.x},${p.tile.y}`;
        let tr = tracks.get(p.id);
        if (!tr) {
          tr = {
            lastKey: key,
            lastLane: p.lane,
            lastChangeT: t,
            moves: [],
            switches: [],
            frozenFor: 0,
          };
          tracks.set(p.id, tr);
        }
        // --- tile-change history (flap detector) ---
        if (key !== tr.lastKey) {
          tr.moves.push({ t, key });
          if (tr.moves.length > 12) tr.moves.shift();
          tr.lastKey = key;
          tr.lastChangeT = t;
          tr.frozenFor = 0;
          if (p.wanderDir === null) {
            const recent6 = tr.moves.filter((m) => t - m.t <= 4);
            const recent9 = tr.moves.filter((m) => t - m.t <= 6);
            const uniq = (ms: Move[]): number => new Set(ms.map((m) => m.key)).size;
            const isFlap =
              (recent6.length >= 6 && uniq(recent6) <= 2) ||
              (recent9.length >= 9 && uniq(recent9) <= 3);
            if (isFlap && !flap.has(p.id)) {
              flap.add(p.id);
              note(`flap   seed ${seed} t=${t.toFixed(1)} id=${p.id} at ${key}`);
            }
          }
        }
        // --- frozen-with-free-exit detector ---
        if (
          p.step.kind === 'idle' &&
          p.wanderDir === null &&
          key === tr.lastKey &&
          freeCloserStep(game, p)
        ) {
          tr.frozenFor += STEP;
          if (tr.frozenFor >= 3 && !frozen.has(p.id)) {
            frozen.add(p.id);
            note(`frozen seed ${seed} t=${t.toFixed(1)} id=${p.id} at ${key}`);
          }
        } else if (p.step.kind !== 'idle' || !freeCloserStep(game, p)) {
          tr.frozenFor = 0;
        }
        // --- lane ping-pong detector ---
        if (p.lane !== tr.lastLane) {
          tr.lastLane = p.lane;
          tr.switches.push(t);
          tr.switches = tr.switches.filter((s) => t - s <= 20);
          if (tr.switches.length >= 4 && !laneOsc.has(p.id)) {
            laneOsc.add(p.id);
            note(`laneosc seed ${seed} t=${t.toFixed(1)} id=${p.id} at ${key}`);
          }
        }
      }
    }

    let maxIdle = 0;
    for (const p of game.passengers) {
      if (p.phase.kind !== 'queueing') continue;
      const tr = tracks.get(p.id);
      if (tr) maxIdle = Math.max(maxIdle, sc.duration - tr.lastChangeT);
    }
    return {
      flap: flap.size,
      frozen: frozen.size,
      laneOsc: laneOsc.size,
      served: game.stats.served,
      storms: game.stats.walkOffs,
      maxIdle: Math.round(maxIdle),
      details,
    };
  } finally {
    Math.random = realRandom;
  }
}

console.log(`Pathfinding stress audit — seeds [${SEEDS.join(',')}], dt=${STEP}s\n`);
console.log('scenario           flap frozen laneosc served storms maxIdle');
let pass = true;
const allDetails: string[] = [];
for (const sc of SCENARIOS) {
  const runs = SEEDS.map((s) => runScenario(sc, s));
  const sum = (f: (r: RunResult) => number): number => runs.reduce((a, r) => a + f(r), 0);
  const flapN = sum((r) => r.flap);
  const frozenN = sum((r) => r.frozen);
  if (flapN > 0 || frozenN > 0) pass = false;
  console.log(
    [
      sc.name.padEnd(18),
      String(flapN).padStart(4),
      String(frozenN).padStart(6),
      String(sum((r) => r.laneOsc)).padStart(7),
      String(sum((r) => r.served)).padStart(6),
      String(sum((r) => r.storms)).padStart(6),
      `${Math.max(...runs.map((r) => r.maxIdle))}s`.padStart(7),
    ].join(' '),
  );
  for (const r of runs) for (const d of r.details) allDetails.push(`  [${sc.name}] ${d}`);
}
if (allDetails.length > 0) {
  console.log('\nFirst flagged events:');
  for (const d of allDetails.slice(0, 20)) console.log(d);
}
console.log(`\n${pass ? 'PASS' : 'FAIL'}: flap=0 and frozen=0 required across all scenarios`);
process.exitCode = pass ? 0 : 1;
