/**
 * Random-walk strategy search + balance auto-audit.
 *
 * INNER LOOP — strategy discovery: a population of policy GENOMES plays whole
 * headless days through the REAL engine (same stepGame the browser runs). A
 * genome is a randomized recipe — spend weights per action category, channel
 * depth, lane cap, shop order, and reactive gate thresholds (gates are a valve,
 * so they're encoded as close-at/reopen-at rules, not build-order items). Each
 * pass keeps the fittest genomes and explores mutants of them: a random-walk
 * local search homing in on winning strategies under the current constants.
 *
 * OUTER LOOP — balance audit (every AUDIT_EVERY passes): ablation tests (best
 * genome minus one category) measure how NECESSARY each action category is;
 * solo tests (one category alone) measure whether any is SUFFICIENT. The goal
 * state is "every category matters, none dominates". Bounded nudges to the
 * non-pinned constants push toward it; every tweak is logged. PINNED and never
 * touched: payoutBase ($5 flat serve), lossCost (−25 walkaway), startingMoney.
 *
 * Nothing here writes to src/ — the final report proposes a constants diff.
 *
 * Usage: pnpm tsx scripts/search.ts [passes=100] [population=120] [--resume]
 *
 * --resume continues from .private/search-out/state.json (accumulated balance tweaks +
 * elite pool), appending to the logs — the intended workflow is CHUNKS: run
 * 10-15 passes, read the audit trail, adjust the engine or levers, resume.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  BUILDABLE,
  CHECKPOINTS_TOTAL,
  MAX_LEVEL,
  SERVICE_X,
  balance,
  laneUpgradeCost,
  shopCost,
  shopUpgradeCost,
  tuning,
} from '../src/constants';
import { buildGrid, createShops, createSlots } from '../src/level';
import {
  createGame,
  laneOpenCost,
  placeFence,
  placeGate,
  stepGame,
  toggleCheckpoint,
  toggleGate,
  toggleShop,
  upgradeCheckpoint,
  upgradeShop,
} from '../src/sim';
import type { Game, TileKind, Vec } from '../src/types';
import { LANE_OPEN_ORDER } from './bots';

const ARGS = process.argv.slice(2).filter((a) => a !== '--resume');
const RESUME = process.argv.includes('--resume');
const PASSES = Number(ARGS[0] ?? 100);
const POP = Number(ARGS[1] ?? 120);
const ELITES = Math.max(4, Math.round(POP / 10));
const FRESH = Math.max(4, Math.round(POP / 6));
const SEEDS = [1, 2, 3];
const AUDIT_SEEDS = [1, 2, 3, 4, 5];
const VALID_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
// Days must run TO FAILURE: the overtime deluge (waves 18+, starting ~3400s)
// is what eventually bankrupts every build — a horizon that ends mid-ladder
// censors fitness at the cap and makes late-game pressure levers unmeasurable.
const T_MAX = 5400;
const T_VALID = 6000;
const AUDIT_EVERY = 5;
const MASTER_SEED = 1337;
const OUT_DIR = path.join('.private', 'search-out');

// --- Genomes -------------------------------------------------------------------

const CATEGORIES = ['lane', 'laneUp', 'shop', 'shopUp', 'fence', 'gate'] as const;
type Category = (typeof CATEGORIES)[number];
type Tally = Record<Category, number>;

const zeroTally = (): Tally => ({ lane: 0, laneUp: 0, shop: 0, shopUp: 0, fence: 0, gate: 0 });

type Genome = {
  /** Relative spend weights per action category; 0 disables the category. */
  weights: Tally;
  /** Target number of open lanes (1..6). */
  laneMax: number;
  /** Target channel-wall depth left of the service column; 0 = no fencing. */
  channelDepth: number;
  /** Keep-back bank: never spend below this. */
  reserve: number;
  /** SEQUENCING genES — flat weights can't express "upgrades last", which is
   * exactly where upgrades live under the inverted economy. */
  /** Lane upgrades unlock once this many lanes are open. */
  upgradeGate: number;
  /** Shop upgrades unlock once this many shops are built. */
  shopUpGate: number;
  /** Shop purchase order (permutation of slot indices). */
  shopOrder: number[];
  /** Reactive valve: shut a lane's mouth gate when its queue reaches this... */
  gateClose: number;
  /** ...and reopen once it has drained to this. */
  gateReopen: number;
};

/** Deepest channel that still leaves a walkable column inside BUILDABLE. */
const MAX_DEPTH = SERVICE_X - BUILDABLE.x0 - 2;

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

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clampInt = (v: number, lo: number, hi: number): number => Math.round(clamp(v, lo, hi));
const mean = (xs: number[]): number =>
  xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function shuffled(xs: number[], rng: () => number): number[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function randomGenome(rng: () => number, shopCount: number): Genome {
  const gateClose = 4 + Math.floor(rng() * 24);
  return {
    weights: {
      lane: rng(),
      laneUp: rng(),
      shop: rng(),
      shopUp: rng(),
      fence: rng(),
      gate: rng() < 0.5 ? 0 : rng(),
    },
    laneMax: 1 + Math.floor(rng() * CHECKPOINTS_TOTAL),
    channelDepth: Math.floor(rng() * (MAX_DEPTH + 1)),
    reserve: Math.floor(rng() * 200),
    upgradeGate: 1 + Math.floor(rng() * CHECKPOINTS_TOTAL),
    shopUpGate: Math.floor(rng() * 7),
    shopOrder: shuffled(
      Array.from({ length: shopCount }, (_, i) => i),
      rng,
    ),
    gateClose,
    gateReopen: Math.floor(rng() * gateClose),
  };
}

const cloneGenome = (g: Genome): Genome => ({
  ...g,
  weights: { ...g.weights },
  shopOrder: g.shopOrder.slice(),
});

/** Random-walk step: perturb 1-3 genome fields locally. */
function mutate(g: Genome, rng: () => number): Genome {
  const m = cloneGenome(g);
  const edits = 1 + Math.floor(rng() * 3);
  for (let k = 0; k < edits; k++) {
    const pick = Math.floor(rng() * 8);
    const cat = CATEGORIES[Math.floor(rng() * CATEGORIES.length)] ?? 'fence';
    switch (pick) {
      case 0:
        m.weights[cat] = clamp(m.weights[cat] + (rng() - 0.5) * 0.5, 0, 1);
        break;
      case 1:
        m.laneMax = clampInt(m.laneMax + (rng() < 0.5 ? -1 : 1), 1, CHECKPOINTS_TOTAL);
        break;
      case 2:
        m.channelDepth = clampInt(m.channelDepth + (rng() - 0.5) * 10, 0, MAX_DEPTH);
        break;
      case 3:
        if (rng() < 0.5) m.reserve = clampInt(m.reserve + (rng() - 0.5) * 80, 0, 250);
        else if (rng() < 0.5)
          m.upgradeGate = clampInt(m.upgradeGate + (rng() < 0.5 ? -1 : 1), 1, 6);
        else m.shopUpGate = clampInt(m.shopUpGate + (rng() < 0.5 ? -1 : 1), 0, 6);
        break;
      case 4: {
        const i = Math.floor(rng() * m.shopOrder.length);
        const j = Math.floor(rng() * m.shopOrder.length);
        const a = m.shopOrder[i];
        const b = m.shopOrder[j];
        if (a !== undefined && b !== undefined) {
          m.shopOrder[i] = b;
          m.shopOrder[j] = a;
        }
        break;
      }
      case 5:
        m.gateClose = clampInt(m.gateClose + (rng() - 0.5) * 10, 3, 40);
        break;
      case 6:
        m.gateReopen = clampInt(m.gateReopen + (rng() - 0.5) * 8, 0, m.gateClose - 1);
        break;
      case 7:
        // On/off jump: categories can be discovered or abandoned outright.
        m.weights[cat] = m.weights[cat] > 0 && rng() < 0.5 ? 0 : 0.2 + rng() * 0.8;
        break;
    }
  }
  m.gateReopen = clampInt(Math.min(m.gateReopen, m.gateClose - 1), 0, 40);
  return m;
}

// --- Policy executor -------------------------------------------------------------

const tileKindAt = (game: Game, x: number, y: number): TileKind =>
  game.grid.tiles[y * game.grid.cols + x] ?? 'wall';

const pendingAt = (game: Game, x: number, y: number): boolean =>
  game.pending.some((b) => b.tile.x === x && b.tile.y === y);

/**
 * Next missing channel-wall tiles (mouth-sealed: walls run TO the service
 * column). Fencing over a future shop footprint is fine: construction clears
 * its lot (full refund) and the building itself becomes wall mass.
 */
function missingWallTiles(game: Game, depth: number, limit: number): Vec[] {
  const out: Vec[] = [];
  const xMin = Math.max(BUILDABLE.x0 + 1, SERVICE_X - depth);
  for (const slot of game.slots) {
    if (slot.state !== 'open') continue;
    for (let x = SERVICE_X; x >= xMin; x--) {
      for (const y of [slot.y - 1, slot.y + 1]) {
        if (y < BUILDABLE.y0 || y > BUILDABLE.y1) continue;
        if (tileKindAt(game, x, y) !== 'floor' || pendingAt(game, x, y)) continue;
        out.push({ x, y });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * One policy tick: free reactive gate valves first, then at most one weighted
 * purchase from the affordable-action menu (fences buy a small batch).
 */
function actPolicy(game: Game, g: Genome, spend: Tally, gates: Map<number, Vec>): void {
  for (const [idx, tile] of gates) {
    const slot = game.slots[idx];
    if (!slot || slot.state !== 'open') continue;
    const q = game.laneAssigned[idx] ?? 0;
    const kind = tileKindAt(game, tile.x, tile.y);
    const shutting = game.pending.some(
      (b) => b.kind === 'gateShut' && b.tile.x === tile.x && b.tile.y === tile.y,
    );
    if (kind === 'gateOpen' && !shutting && q >= g.gateClose) toggleGate(game, tile);
    else if ((kind === 'gateClosed' || shutting) && q <= g.gateReopen) toggleGate(game, tile);
  }

  const budget = game.money - g.reserve;
  if (budget <= 0) return;
  const acts: { cat: Category; w: number; exec: () => number }[] = [];

  const openCount = game.slots.filter((s) => s.state !== 'closed').length;
  if (g.weights.lane > 0 && openCount < g.laneMax) {
    const cost = laneOpenCost(game);
    if (cost <= budget) {
      acts.push({
        cat: 'lane',
        w: g.weights.lane,
        exec: () => {
          for (const i of LANE_OPEN_ORDER) {
            if (game.slots[i]?.state === 'closed' && toggleCheckpoint(game, i) === 'opened') {
              return cost;
            }
          }
          return 0;
        },
      });
    }
  }

  if (g.weights.laneUp > 0 && openCount >= Math.min(g.upgradeGate, g.laneMax)) {
    let best = -1;
    let bestCost = Infinity;
    for (const [i, s] of game.slots.entries()) {
      if (s.state !== 'open' || s.level >= MAX_LEVEL) continue;
      const c = laneUpgradeCost(s.level);
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    }
    if (best >= 0 && bestCost <= budget) {
      const idx = best;
      const c = bestCost;
      acts.push({
        cat: 'laneUp',
        w: g.weights.laneUp,
        exec: () => (upgradeCheckpoint(game, idx) ? c : 0),
      });
    }
  }

  if (g.weights.shop > 0) {
    for (const i of g.shopOrder) {
      const shop = game.shops[i];
      if (!shop || shop.built) continue;
      const c = shopCost(shop.tier);
      if (c <= budget) {
        acts.push({
          cat: 'shop',
          w: g.weights.shop,
          exec: () => (toggleShop(game, i) === 'built' ? c : 0),
        });
      }
      break; // only the next shop in the genome's order is on the menu
    }
  }

  const builtShops = game.shops.filter((s) => s.built).length;
  if (g.weights.shopUp > 0 && builtShops >= Math.min(g.shopUpGate, game.shops.length)) {
    for (const i of g.shopOrder) {
      const shop = game.shops[i];
      if (!shop?.built || shop.level >= MAX_LEVEL) continue;
      const c = shopUpgradeCost(shop.tier, shop.level);
      if (c <= budget) {
        acts.push({
          cat: 'shopUp',
          w: g.weights.shopUp,
          exec: () => (upgradeShop(game, i) ? c : 0),
        });
      }
      break;
    }
  }

  if (g.weights.fence > 0 && g.channelDepth > 0 && balance.fenceCost <= budget) {
    const tiles = missingWallTiles(game, g.channelDepth, 6);
    if (tiles.length > 0) {
      acts.push({
        cat: 'fence',
        w: g.weights.fence,
        exec: () => {
          let spent = 0;
          for (const t of tiles) {
            if (game.money - g.reserve < balance.fenceCost) break;
            if (placeFence(game, t)) spent += balance.fenceCost;
          }
          return spent;
        },
      });
    }
  }

  if (g.weights.gate > 0 && g.channelDepth > 0 && balance.gateCost <= budget) {
    const mouthX = Math.max(BUILDABLE.x0 + 1, SERVICE_X - g.channelDepth);
    for (const [i, slot] of game.slots.entries()) {
      if (slot.state !== 'open' || gates.has(i)) continue;
      if (tileKindAt(game, mouthX, slot.y) !== 'floor') continue;
      // A mouth gate only valves anything once its flanks are sealed.
      if (tileKindAt(game, mouthX, slot.y - 1) === 'floor') continue;
      if (tileKindAt(game, mouthX, slot.y + 1) === 'floor') continue;
      const tile = { x: mouthX, y: slot.y };
      const idx = i;
      acts.push({
        cat: 'gate',
        w: g.weights.gate,
        exec: () => {
          if (!placeGate(game, tile)) return 0;
          gates.set(idx, tile);
          return balance.gateCost;
        },
      });
      break;
    }
  }

  const total = acts.reduce((a, b) => a + b.w, 0);
  if (total <= 0) return;
  let r = Math.random() * total;
  for (const a of acts) {
    r -= a.w;
    if (r <= 0) {
      spend[a.cat] += a.exec();
      return;
    }
  }
}

// --- Headless evaluation ----------------------------------------------------------

type RunResult = {
  waves: number;
  bank: number;
  served: number;
  lost: number;
  servedShare: number;
  failed: boolean;
  spend: Tally;
};

function runPolicy(g: Genome, seed: number, maxT: number): RunResult {
  // SIDE EFFECT: Math.random swapped for a seeded generator (engine + policy
  // sampling both draw from it), restored after — same trick as simulate.ts.
  const realRandom = Math.random;
  Math.random = mulberry32(seed * 7919 + 1);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    const spend = zeroTally();
    const gates = new Map<number, Vec>();
    let waves = 0;
    let lastReport = 0;
    for (let t = 0; t < maxT && !game.failed; t++) {
      actPolicy(game, g, spend, gates);
      stepGame(game, 1);
      const r = game.waveReport;
      if (r && r.index > lastReport) {
        lastReport = r.index;
        if (!game.failed) waves = r.index;
      }
    }
    const { served, walkOffs, turnedAway } = game.stats;
    const lost = walkOffs + turnedAway;
    return {
      waves,
      bank: Math.round(game.money),
      served,
      lost,
      servedShare: served / Math.max(1, served + lost),
      failed: game.failed,
      spend,
    };
  } finally {
    Math.random = realRandom;
  }
}

/** Waves survived dominate; bank then served share break ties. */
const fitnessOf = (r: RunResult): number =>
  r.waves * 5000 + clamp(r.bank, -2000, 20000) * 0.1 + r.servedShare * 100;

type Scored = {
  g: Genome;
  fit: number;
  waves: number;
  bank: number;
  servedShare: number;
  /** Fraction of runs that actually went bankrupt (vs coasting to the cap). */
  failedShare: number;
  spend: Tally;
};

function evalGenome(g: Genome, seeds: readonly number[], maxT: number): Scored {
  const runs = seeds.map((s) => runPolicy(g, s, maxT));
  const spend = zeroTally();
  for (const r of runs) for (const c of CATEGORIES) spend[c] += r.spend[c] / runs.length;
  return {
    g,
    fit: mean(runs.map(fitnessOf)),
    waves: mean(runs.map((r) => r.waves)),
    bank: mean(runs.map((r) => r.bank)),
    servedShare: mean(runs.map((r) => r.servedShare)),
    failedShare: mean(runs.map((r) => (r.failed ? 1 : 0))),
    spend,
  };
}

// --- Balance levers (the audit's tweakable dials, with hard bounds) ---------------

const LEVERS = {
  checkpointFee: { lo: 240, hi: 420, int: true },
  laneFeeCurve: { lo: 1.25, hi: 1.6, int: false },
  upgradeCurve: { lo: 3.2, hi: 5.2, int: false },
  shopUpgradeCurve: { lo: 1.4, hi: 2.4, int: false },
  shopRevenueScale: { lo: 0.6, hi: 1.2, int: false },
  shopVisitChance: { lo: 0.35, hi: 0.55, int: false },
  shopVisitLevelBonus: { lo: 0.02, hi: 0.08, int: false },
  shopCostScale: { lo: 2.8, hi: 4.6, int: false },
  shopDwellScale: { lo: 1.2, hi: 2.5, int: false },
  crowdStress: { lo: 0.7, hi: 1.5, int: false },
  stormShock: { lo: 6, hi: 16, int: true },
  prepSpeedup: { lo: 0.4, hi: 0.65, int: false },
  gateCost: { lo: 6, hi: 28, int: true },
  fenceCost: { lo: 2, hi: 5, int: true },
  reliefScale: { lo: 1.1, hi: 1.8, int: false },
  rushBurst: { lo: 0.4, hi: 0.6, int: false },
  overtimeGrowth: { lo: 1.05, hi: 1.15, int: false },
} as const;
type Lever = keyof typeof LEVERS;

const BASE_BALANCE = { ...balance };
const BASE_TUNING = { ...tuning };
type Config = Partial<Record<Lever, number>>;

const isTuningLever = (k: Lever): k is 'rushBurst' | 'overtimeGrowth' =>
  k === 'rushBurst' || k === 'overtimeGrowth';

function leverValue(config: Config, k: Lever): number {
  const c = config[k];
  if (c !== undefined) return c;
  return isTuningLever(k) ? BASE_TUNING[k] : (BASE_BALANCE[k] as number);
}

/** Reset constants to baseline, then overlay the audit's accumulated tweaks. */
function applyConfig(config: Config): void {
  Object.assign(balance, BASE_BALANCE);
  Object.assign(tuning, BASE_TUNING);
  for (const k of Object.keys(LEVERS) as Lever[]) {
    const v = config[k];
    if (v === undefined) continue;
    if (isTuningLever(k)) tuning[k] = v;
    else (balance as Record<string, unknown>)[k] = v;
  }
}

function nudge(config: Config, k: Lever, factor: number, log: string[]): boolean {
  const cur = leverValue(config, k);
  const spec = LEVERS[k];
  let next = clamp(cur * factor, spec.lo, spec.hi);
  next = spec.int ? Math.round(next) : Math.round(next * 1000) / 1000;
  if (next === cur) {
    log.push(`${k} at bound (${cur}), skipped ×${factor}`);
    return false;
  }
  config[k] = next;
  log.push(`${k}: ${cur} → ${next}`);
  return true;
}

// --- Parallel evaluation: fork this script per population chunk ------------------

const execFileAsync = promisify(execFile);
const TSX_BIN = path.join('node_modules', '.bin', 'tsx');
const JOBS = Math.max(1, Math.min(10, os.cpus().length - 2));

type WorkerTask = { config: Config; genomes: Genome[]; seeds: number[]; tmax: number };
type ScoredLite = Omit<Scored, 'g'>;

// Worker mode: evaluate one chunk and exit BEFORE the main loop below truncates
// any logs. Function declarations hoist, so everything needed is in scope.
if (process.argv[2] === '--worker') {
  const taskPath = process.argv[3] ?? '';
  const outPath = process.argv[4] ?? '';
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as WorkerTask;
  applyConfig(task.config);
  const results: ScoredLite[] = task.genomes.map((g) => {
    const scored: Partial<Scored> = evalGenome(g, task.seeds, task.tmax);
    delete scored.g; // genomes echo back positionally; keep payloads lean
    return scored as ScoredLite;
  });
  fs.writeFileSync(outPath, JSON.stringify(results));
  process.exit(0);
}

/** Evaluate genomes across JOBS forked workers (results stay in input order). */
async function evalMany(
  genomes: readonly Genome[],
  seeds: readonly number[],
  tmax: number,
  config: Config,
): Promise<Scored[]> {
  if (JOBS <= 1 || genomes.length < JOBS) {
    applyConfig(config);
    return genomes.map((g) => evalGenome(g, seeds, tmax));
  }
  const chunkSize = Math.ceil(genomes.length / JOBS);
  const chunks: Genome[][] = [];
  for (let i = 0; i < genomes.length; i += chunkSize) {
    chunks.push(genomes.slice(i, i + chunkSize));
  }
  const outs = await Promise.all(
    chunks.map(async (chunk, ci) => {
      const taskPath = path.join(OUT_DIR, `task-${ci}.json`);
      const outPath = path.join(OUT_DIR, `out-${ci}.json`);
      fs.writeFileSync(
        taskPath,
        JSON.stringify({ config, genomes: chunk, seeds: [...seeds], tmax }),
      );
      await execFileAsync(TSX_BIN, ['scripts/search.ts', '--worker', taskPath, outPath]);
      return JSON.parse(fs.readFileSync(outPath, 'utf8')) as ScoredLite[];
    }),
  );
  return outs.flat().map((r, i) => {
    const g = genomes[i];
    if (!g) throw new Error('worker result count mismatch');
    return { ...r, g };
  });
}

/** Make category C more attractive (it proved superfluous). */
const BUFF: Record<Category, readonly [Lever, number]> = {
  lane: ['checkpointFee', 0.92],
  laneUp: ['upgradeCurve', 0.93],
  shop: ['shopRevenueScale', 1.12],
  shopUp: ['shopUpgradeCurve', 0.93],
  fence: ['crowdStress', 1.08],
  gate: ['gateCost', 0.88],
};
/** Rein category C in (alone it carried the day). */
const NERF: Record<Category, readonly [Lever, number]> = {
  lane: ['checkpointFee', 1.08],
  laneUp: ['upgradeCurve', 1.06],
  shop: ['shopRevenueScale', 0.9],
  shopUp: ['shopUpgradeCurve', 1.08],
  fence: ['rushBurst', 1.06],
  gate: ['gateCost', 1.15],
};
/** Categories the audit measures but never tweaks constants for (design call:
 * gates are a niche valve, not a pillar — misused they seal lanes, and that's
 * on the player, not the price). */
const NO_TWEAK = new Set<Category>(['gate']);

// --- Audit: necessity (ablation) + sufficiency (solo) -> bounded tweaks -----------

function ablate(g: Genome, cat: Category): Genome {
  const m = cloneGenome(g);
  m.weights[cat] = 0;
  if (cat === 'lane') m.laneMax = 1;
  if (cat === 'fence') {
    m.channelDepth = 0;
    m.weights.gate = 0; // mouth gates presuppose channel walls
  }
  return m;
}

function solo(g: Genome, cat: Category): Genome {
  const m = cloneGenome(g);
  for (const c of CATEGORIES) m.weights[c] = c === cat ? Math.max(0.5, g.weights[c]) : 0;
  if (cat !== 'lane') m.laneMax = 1;
  if (cat === 'gate') m.weights.fence = Math.max(0.5, g.weights.fence); // walls first
  if (cat !== 'fence' && cat !== 'gate') m.channelDepth = 0;
  return m;
}

/**
 * Force an unused category ON (with its prereqs) to probe potential value.
 * Ablating a gene the best genome doesn't carry is free BY CONSTRUCTION, so
 * unused categories are probed by grafting instead: if the graft helps, the
 * category is fine and evolution just hasn't rediscovered it (seed it back
 * into the population); only if the graft ALSO fails is the balance to blame.
 */
function graft(g: Genome, cat: Category): Genome {
  const m = cloneGenome(g);
  m.weights[cat] = Math.max(0.6, m.weights[cat]);
  if (cat === 'shopUp') m.weights.shop = Math.max(0.4, m.weights.shop);
  if (cat === 'gate' && m.channelDepth === 0) m.channelDepth = 12;
  if ((cat === 'lane' || cat === 'laneUp') && m.laneMax < 4) m.laneMax = 4;
  // Probe upgrades at their best-case TIMING (endgame top-ups), not scattershot
  // — mid-game dollars buy ~20 waves in lanes/fences/shops, so an early-gated
  // graft measures displacement, not the category's value.
  if (cat === 'laneUp') m.upgradeGate = m.laneMax;
  if (cat === 'shopUp') m.shopUpGate = Math.max(5, m.shopUpGate);
  return m;
}

type Audit = {
  pass: number;
  baseWaves: number;
  baseBank: number;
  /** Waves LOST when the category is removed (necessity; higher = more needed). */
  ablation: Tally;
  /** Waves reached by the category alone (sufficiency; near-base = dominant). */
  solo: Tally;
  /** Waves GAINED by grafting an unused category onto the best genome (0 = used). */
  graft: Tally;
  tweaks: string[];
};

async function runAudit(
  pass: number,
  best: Scored,
  config: Config,
): Promise<{ audit: Audit; inject: Genome[] }> {
  const used = (c: Category): boolean => best.spend[c] > 0;
  const unused = CATEGORIES.filter((c) => !used(c));
  const grafts = unused.map((c) => graft(best.g, c));
  const batch: Genome[] = [best.g];
  for (const c of CATEGORIES) batch.push(ablate(best.g, c));
  for (const c of CATEGORIES) batch.push(solo(best.g, c));
  batch.push(...grafts);
  const evals = await evalMany(batch, AUDIT_SEEDS, T_MAX, config);
  const base = evals[0];
  if (!base) throw new Error('audit evaluation came back empty');
  const ablation = zeroTally();
  const soloWaves = zeroTally();
  const graftGain = zeroTally();
  for (const [i, c] of CATEGORIES.entries()) {
    ablation[c] = base.waves - (evals[1 + i]?.waves ?? 0);
    soloWaves[c] = evals[1 + CATEGORIES.length + i]?.waves ?? 0;
  }
  for (const [i, c] of unused.entries()) {
    graftGain[c] = (evals[1 + 2 * CATEGORIES.length + i]?.waves ?? 0) - base.waves;
  }
  const tweaks: string[] = [];
  const inject: Genome[] = [];

  // Per-category necessity. USED categories are judged by ablation (buff each
  // one that removes for free — separate levers, so buffs don't fight). UNUSED
  // categories are judged by graft: if forcing the gene on helps, evolution
  // just hasn't rediscovered it — seed it back, leave the constants alone; if
  // even the graft is worthless, the balance is to blame.
  if (base.waves >= 3) {
    for (const c of CATEGORIES) {
      if (NO_TWEAK.has(c)) continue;
      if (used(c)) {
        if (ablation[c] >= 0.5) continue;
        const [lever, factor] = BUFF[c];
        tweaks.push(`buff ${c} (ablation cost ${ablation[c].toFixed(1)} waves)`);
        nudge(config, lever, factor, tweaks);
      } else if (graftGain[c] > 0.5) {
        const grafted = grafts[unused.indexOf(c)];
        if (grafted) inject.push(grafted);
        tweaks.push(`graft ${c} +${graftGain[c].toFixed(1)} waves — seeding population, no tweak`);
      } else {
        const [lever, factor] = BUFF[c];
        tweaks.push(`buff ${c} (unused; graft ${graftGain[c].toFixed(1)} waves)`);
        nudge(config, lever, factor, tweaks);
      }
    }
  }

  // Nerf a category that is sufficient alone.
  let dominant: Category = 'lane';
  for (const c of CATEGORIES) {
    if (!NO_TWEAK.has(c) && soloWaves[c] > soloWaves[dominant]) dominant = c;
  }
  if (base.waves >= 3 && soloWaves[dominant] >= base.waves - 0.5) {
    const [lever, factor] = NERF[dominant];
    tweaks.push(
      `nerf ${dominant} (solo ${soloWaves[dominant].toFixed(1)} vs base ${base.waves.toFixed(1)})`,
    );
    nudge(config, lever, factor, tweaks);
  }

  // Global difficulty governor. The day must END in failure for survival depth
  // to mean anything: a best strategy that coasts to the horizon cap censors
  // fitness, and the marginal value of every non-capacity category collapses
  // to zero (nothing left to survive). Squeeze via wave pressure, not prices —
  // the schedule re-pegs prices automatically. Fat banks get the same squeeze:
  // surplus means income outruns every sink.
  if (pass >= 10 && base.waves < 5) {
    tweaks.push(`too hard (best ${base.waves.toFixed(1)} waves)`);
    nudge(config, 'crowdStress', 0.93, tweaks);
  } else if (base.failedShare < 0.5) {
    // (A fat bank at death is NOT "too easy": under the walkout rule, dying
    // rich is a misallocation the searcher should fix, not the waves.)
    tweaks.push(`too easy (${Math.round((1 - base.failedShare) * 100)}% of days coast to cap)`);
    nudge(config, 'rushBurst', 1.06, tweaks);
    nudge(config, 'overtimeGrowth', 1.03, tweaks);
  }

  return {
    audit: {
      pass,
      baseWaves: base.waves,
      baseBank: base.bank,
      ablation,
      solo: soloWaves,
      graft: graftGain,
      tweaks,
    },
    inject,
  };
}

// --- Reporting helpers -------------------------------------------------------------

function mixOf(spend: Tally): string {
  const total = CATEGORIES.reduce((a, c) => a + spend[c], 0);
  if (total <= 0) return 'no spend';
  return CATEGORIES.map((c) => `${c} ${Math.round((100 * spend[c]) / total)}%`).join(' ');
}

/**
 * Behavioral fingerprint for elite dedup: mutants that differ only in dormant
 * fields (gate thresholds with no gates, shop order with no shops) or cosmetic
 * jitter are the SAME strategy and shouldn't crowd the elite pool.
 */
function signature(g: Genome): string {
  const mask = CATEGORIES.map((c) => (g.weights[c] > 0 ? 1 : 0)).join('');
  const gates = g.weights.gate > 0 && g.channelDepth > 0;
  return [
    mask,
    g.laneMax,
    Math.round(g.channelDepth / 4),
    Math.round(g.reserve / 50),
    gates ? `${Math.round(g.gateClose / 5)}/${Math.round(g.gateReopen / 5)}` : '-',
    g.weights.shop > 0 ? g.shopOrder.slice(0, 2).join('') : '-',
    g.weights.laneUp > 0 ? g.upgradeGate : '-',
    g.weights.shopUp > 0 ? g.shopUpGate : '-',
  ].join('|');
}

function describeGenome(s: Scored): string {
  const g = s.g;
  const gates = g.weights.gate > 0 && g.channelDepth > 0;
  return (
    `${g.laneMax} lane(s), channels depth ${g.channelDepth}` +
    (gates ? ` + mouth gates (shut@${g.gateClose} reopen@${g.gateReopen})` : ', no gates') +
    `, reserve $${g.reserve}, shop order [${g.shopOrder.join(',')}] | ` +
    `spend: ${mixOf(s.spend)} | ${s.waves.toFixed(1)} waves, bank $${Math.round(s.bank)}, ` +
    `served ${(100 * s.servedShare).toFixed(1)}%`
  );
}

// --- Main loop -----------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });
const passLog = path.join(OUT_DIR, 'passes.jsonl');
const auditLog = path.join(OUT_DIR, 'audits.jsonl');
const statePath = path.join(OUT_DIR, 'state.json');

/** Saved elites may predate newer genome fields — they load as optionals. */
type SavedGenome = Omit<Genome, 'upgradeGate' | 'shopUpGate'> &
  Partial<Pick<Genome, 'upgradeGate' | 'shopUpGate'>>;
type SavedState = { pass: number; config: Config; elites: SavedGenome[] };
let startPass = 0;
const config: Config = {};
let seedElites: Genome[] = [];
if (RESUME && fs.existsSync(statePath)) {
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')) as SavedState;
  startPass = saved.pass;
  Object.assign(config, saved.config);
  // Default-fill genome fields added since the state was written.
  seedElites = saved.elites.map((g) => ({
    ...g,
    upgradeGate: g.upgradeGate ?? 1,
    shopUpGate: g.shopUpGate ?? 0,
  }));
} else {
  fs.writeFileSync(passLog, '');
  fs.writeFileSync(auditLog, '');
}

const rng = mulberry32(MASTER_SEED + startPass);
const shopCount = createShops().length;
const audits: Audit[] = [];

let population: Genome[];
if (seedElites.length > 0) {
  population = seedElites.map(cloneGenome);
  while (population.length < POP - FRESH) {
    const parent = seedElites[population.length % seedElites.length];
    if (!parent) break;
    population.push(mutate(parent, rng));
  }
  while (population.length < POP) population.push(randomGenome(rng, shopCount));
} else {
  population = Array.from({ length: POP }, () => randomGenome(rng, shopCount));
}

console.log(
  `Checkpoint! strategy search — passes ${startPass + 1}..${startPass + PASSES} × ${POP} genomes ` +
    `× ${SEEDS.length} seeds (${PASSES * POP * SEEDS.length} games, ${T_MAX}s cap), ` +
    `audits every ${AUDIT_EVERY} passes` +
    (RESUME ? ` [resumed: ${seedElites.length} elites, ${Object.keys(config).length} tweaks]` : ''),
);

const t0 = Date.now();
let elites: Scored[] = [];

for (let pass = startPass + 1; pass <= startPass + PASSES; pass++) {
  const scored = await evalMany(population, SEEDS, T_MAX, config);
  scored.sort((a, b) => b.fit - a.fit);

  // Distinct elites (mutation can clone winners; keep the pool diverse).
  elites = [];
  const seen = new Set<string>();
  for (const s of scored) {
    const key = signature(s.g);
    if (seen.has(key)) continue;
    seen.add(key);
    elites.push(s);
    if (elites.length >= ELITES) break;
  }

  const best = elites[0];
  if (!best) break;
  const eliteSpend = zeroTally();
  for (const e of elites) for (const c of CATEGORIES) eliteSpend[c] += e.spend[c] / elites.length;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(
    `pass ${String(pass).padStart(3)}/${startPass + PASSES} [${mins}m]  best ${best.waves.toFixed(1)} waves ` +
      `fit ${Math.round(best.fit)} bank $${Math.round(best.bank)} | elite mix ${mixOf(eliteSpend)}`,
  );
  fs.appendFileSync(
    passLog,
    `${JSON.stringify({
      pass,
      bestFit: Math.round(best.fit),
      bestWaves: best.waves,
      bestBank: Math.round(best.bank),
      eliteMix: eliteSpend,
      config,
      bestGenome: best.g,
    })}\n`,
  );

  let injected: Genome[] = [];
  if (pass % AUDIT_EVERY === 0 && pass < startPass + PASSES) {
    const { audit, inject } = await runAudit(pass, best, config);
    audits.push(audit);
    injected = inject;
    fs.appendFileSync(auditLog, `${JSON.stringify(audit)}\n`);
    if (audit.tweaks.length > 0) console.log(`  audit: ${audit.tweaks.join('; ')}`);
  }

  // Next generation: elites survive, audit grafts get a foothold, mutants
  // random-walk around the elites, fresh randoms keep off-axis strategies
  // discoverable.
  if (pass < startPass + PASSES) {
    const next: Genome[] = elites.map((e) => e.g);
    next.push(...injected);
    let i = 0;
    while (next.length < POP - FRESH) {
      const parent = elites[i % elites.length];
      if (!parent) break;
      next.push(mutate(parent.g, rng));
      i++;
    }
    while (next.length < POP) next.push(randomGenome(rng, shopCount));
    population = next.slice(0, POP);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'state.json'),
    JSON.stringify({ pass, config, elites: elites.map((e) => e.g) }, null, 2),
  );
}

// --- Final validation: fresh seeds, longer day, top distinct strategies -------------

console.log('\nValidating finalists on fresh seeds…');
const finalists = await evalMany(
  elites.slice(0, 6).map((e) => e.g),
  VALID_SEEDS,
  T_VALID,
  config,
);
finalists.sort((a, b) => b.fit - a.fit);

const report = {
  passes: PASSES,
  population: POP,
  totalGames: PASSES * POP * SEEDS.length,
  config,
  configDiff: (Object.keys(config) as Lever[]).map((k) => ({
    lever: k,
    base: isTuningLever(k) ? BASE_TUNING[k] : (BASE_BALANCE[k] as number),
    tuned: config[k],
  })),
  audits,
  finalists: finalists.map((f) => ({
    genome: f.g,
    waves: f.waves,
    bank: Math.round(f.bank),
    servedShare: f.servedShare,
    spend: f.spend,
    description: describeGenome(f),
  })),
};
fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n=== Final constants diff (base → tuned) ===');
if (report.configDiff.length === 0) console.log('  (no changes — base balance held up)');
for (const d of report.configDiff) console.log(`  ${d.lever}: ${d.base} → ${d.tuned}`);
console.log('\n=== Winning strategies (validated on 10 fresh seeds) ===');
for (const [i, f] of report.finalists.entries()) {
  console.log(`  #${i + 1} ${f.description}`);
}
console.log(`\nReport: ${path.join(OUT_DIR, 'report.json')}`);
