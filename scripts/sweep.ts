/**
 * Brute-force balance sweep.
 *
 * Samples many balance/tuning configurations, plays each with a ladder of bot
 * strategies of decreasing quality on the REAL engine, and scores configs against
 * three objectives:
 *   1. Achievability — a 100% play (full facilities + upgrades + routing) ends the
 *      day with ~0 walk-offs; the 85% play stays close.
 *   2. Graceful degradation — outcome tracks effort: the 70% play lands at
 *      ~0.55-0.85 of optimal (baseline-adjusted), monotonic, no cliffs.
 *   3. Robustness — wasteful spending degrades but does not collapse.
 *
 * Usage:
 *   tsx scripts/sweep.ts shard <i> <nShards> <configs> <duration>   -> .sweep/shard-<i>.jsonl
 *   tsx scripts/sweep.ts aggregate                                  -> leaderboard
 *   tsx scripts/sweep.ts pilot                                      -> 4 configs inline
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { balance, laneInvested, shopInvested, tuning } from '../src/constants';
import { buildGrid, createShops, createSlots } from '../src/level';
import { createGame, placeFence, stepGame } from '../src/sim';
import type { Game } from '../src/types';
import {
  SHOP_CHEAP_ORDER,
  buildCorridors,
  buyCheapestCapacity,
  buyNextShop,
  ensureChannels,
  extendCorridors,
  openLanesUpTo,
  reinvest,
  upgradeNextShop,
} from './bots';

const SWEEP_SEED = 42;
const SEEDS = [11, 23];

type Config = {
  id: number;
  frustStill: number;
  frustMoving: number;
  moveGrace: number;
  walkSpeedSpread: number;
  calmFactor: number;
  rushEnd: number;
  lossCost: number;
  crowdStress: number;
  stormShock: number;
  prepSpeedup: number;
  shopVisitChance: number;
  shopRevenueScale: number;
  reliefScale: number;
  shopCostScale: number;
  laneServiceScale: number;
  upgradeCostScale: number;
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

function makeConfigs(count: number): Config[] {
  const rng = mulberry32(SWEEP_SEED);
  const range = (lo: number, hi: number) => lo + rng() * (hi - lo);
  return Array.from({ length: count }, (_, id) => ({
    id,
    frustStill: range(3.5, 7),
    // Walking is nearly free BY DESIGN (the maze tilt); only sample the low band.
    frustMoving: range(0, 0.05),
    moveGrace: range(0.2, 1.0),
    walkSpeedSpread: range(0, 0.4),
    calmFactor: range(1.0, 1.9),
    rushEnd: range(0.1, 0.3),
    lossCost: Math.round(range(15, 40)),
    crowdStress: range(0.3, 1.2),
    stormShock: range(4, 18),
    prepSpeedup: range(0.35, 0.7),
    shopVisitChance: range(0.2, 0.4),
    shopRevenueScale: range(0.7, 2.2),
    reliefScale: range(0.8, 2.6),
    shopCostScale: range(2.0, 4.5),
    laneServiceScale: range(0.85, 1.1),
    upgradeCostScale: range(0.7, 1.4),
  }));
}

/** SIDE EFFECT: writes the shared tuning/balance objects — the sweep's whole job. */
function applyConfig(c: Config): void {
  tuning.frustStill = c.frustStill;
  tuning.frustMoving = c.frustMoving;
  tuning.moveGrace = c.moveGrace;
  tuning.walkSpeedSpread = c.walkSpeedSpread;
  tuning.calmFactor = c.calmFactor;
  tuning.rushEnd = c.rushEnd;
  balance.lossCost = c.lossCost;
  balance.crowdStress = c.crowdStress;
  balance.stormShock = c.stormShock;
  balance.prepSpeedup = c.prepSpeedup;
  balance.shopVisitChance = c.shopVisitChance;
  balance.reliefScale = c.reliefScale;
  balance.shopCostScale = c.shopCostScale;
  balance.laneService = [2.7, 2.15, 1.7].map((v) => v * c.laneServiceScale);
  // Capacity pricing scales together: opening fee and both upgrade steps,
  // anchored at checkpointFee 320 and upgradeCurve 4.1 (the scale-1 point).
  balance.checkpointFee = Math.round(320 * c.upgradeCostScale);
  balance.upgradeCurve = 3.4 + c.upgradeCostScale * 0.7;
  balance.shopRevenueScale = c.shopRevenueScale;
  // Serve payout is PINNED (flat $5) — the budget curve is shop revenue, not serves.
}

// --- Strategy ladder -------------------------------------------------------------

/** Layout-aware reinvestment: channels on every lane, the ladder, depth when rich. */
function reinvestWithLayout(game: Game): void {
  ensureChannels(game, 12);
  reinvest(game);
  if (game.money > 300) ensureChannels(game, 24);
  if (game.money > 1200) extendCorridors(game);
}

type Tier = { name: string; act(game: Game, t: number): void };

const TIERS: Tier[] = [
  {
    name: 't100',
    act: (game, t) => {
      if (t === 0) {
        buildCorridors(game, 4);
      }
      reinvestWithLayout(game);
    },
  },
  {
    name: 't85',
    act: (game, t) => {
      if (t === 0) {
        buildCorridors(game, 3);
      }
      if (game.money > 100) ensureChannels(game, 10);
      reinvest(game);
    },
  },
  {
    name: 't70',
    act: (game, t) => {
      // poverty start: lane purchases happen via reinvest when affordable
      if (t >= 120) reinvest(game); // late starter, no layout
    },
  },
  {
    name: 't50',
    act: (game) => {
      openLanesUpTo(game, 3); // capacity-only, mid effort
    },
  },
  { name: 't30', act: () => {} },
  {
    name: 'waste',
    act: (game, t) => {
      if (t === 0) {
        // 20 fences in a useless mid-floor blob.
        for (let x = 4; x < 14; x++) {
          placeFence(game, { x, y: 8 });
          placeFence(game, { x, y: 17 });
        }
      }
      if (t >= 300) reinvest(game);
    },
  },
  // Adversaries: degenerate single-axis plays that MUST lose to mixed play.
  {
    name: 'lanesMax',
    act: (game) => {
      // Money-only: open and upgrade every lane, never a fence or shop.
      buyCheapestCapacity(game);
    },
  },
  {
    name: 'shopsOnly',
    act: (game) => {
      // Amenities without capacity: the poverty lane, all shops + shop upgrades.
      if (buyNextShop(game, SHOP_CHEAP_ORDER)) return;
      upgradeNextShop(game);
    },
  },
  {
    name: 'lvl1max',
    act: (game, t) => {
      // Breadth without depth: everything built, nothing ever upgraded.
      if (t === 0) {
        buildCorridors(game, 3);
      }
      if (buyNextShop(game, SHOP_CHEAP_ORDER)) return;
      openLanesUpTo(game, 5);
    },
  },
];

// --- Run + score -------------------------------------------------------------------

type TierResult = {
  storms: number;
  turnaways: number;
  served: number;
  noi: number;
  liquid: number;
  minMoney: number;
};

function liquidation(game: Game): number {
  let assets = 0;
  for (const t of game.grid.tiles) if (t === 'rope') assets += balance.fenceCost;

  for (const shop of game.shops) {
    if (shop.built) assets += Math.round(shopInvested(shop.tier, shop.level) / 2);
  }
  for (const slot of game.slots) {
    if (slot.state !== 'closed') assets += Math.round(laneInvested(slot.level) / 2);
  }
  return game.money + assets;
}

function runTier(tier: Tier, seed: number, duration: number): TierResult {
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    const slots = createSlots();
    const game = createGame(buildGrid(slots), slots, createShops());
    let minMoney = game.money;
    for (let t = 0; t < duration; t++) {
      tier.act(game, t);
      stepGame(game, 1);
      minMoney = Math.min(minMoney, game.money);
    }
    const { served, walkOffs, turnedAway, satisfactionSum } = game.stats;
    const avgSat = served > 0 ? satisfactionSum / served / 100 : 0;
    // Net operating income: earnings minus loss charges, capex excluded — measures
    // how well the day RAN, which is what tier proportionality should track.
    const noi =
      served * (balance.payoutBase + balance.payoutSatBonus * avgSat) -
      (walkOffs + turnedAway) * balance.lossCost;
    return {
      storms: walkOffs,
      turnaways: turnedAway,
      served,
      noi,
      liquid: liquidation(game),
      minMoney,
    };
  } finally {
    Math.random = realRandom;
  }
}

type ConfigResult = {
  config: Config;
  tiers: Record<string, TierResult>;
  penalty: number;
  norms: Record<string, number>;
};

function evaluate(config: Config, duration: number): ConfigResult {
  applyConfig(config);
  const tiers: Record<string, TierResult> = {};
  for (const tier of TIERS) {
    const runs = SEEDS.map((s) => runTier(tier, s, duration));
    tiers[tier.name] = {
      storms: avg(runs.map((r) => r.storms)),
      turnaways: avg(runs.map((r) => r.turnaways)),
      served: avg(runs.map((r) => r.served)),
      noi: avg(runs.map((r) => r.noi)),
      liquid: avg(runs.map((r) => r.liquid)),
      minMoney: avg(runs.map((r) => r.minMoney)),
    };
  }

  const base = tiers['t30']?.noi ?? 0;
  const top = (tiers['t100']?.noi ?? 0) - base;
  const norm = (name: string) => (top > 50 ? ((tiers[name]?.noi ?? 0) - base) / top : 0);
  const norms = {
    t85: norm('t85'),
    t70: norm('t70'),
    t50: norm('t50'),
    waste: norm('waste'),
    lanesMax: norm('lanesMax'),
    shopsOnly: norm('shopsOnly'),
    lvl1max: norm('lvl1max'),
  };
  const lossShare = (name: string) => {
    const t = tiers[name];
    if (!t) return 0;
    const total = t.served + t.storms + t.turnaways;
    return total > 0 ? (t.storms + t.turnaways) / total : 0;
  };

  let penalty = 0;
  // 1. Achievability: the optimal play should be (near) walk-off free.
  penalty += 40 * Math.max(0, (tiers['t100']?.storms ?? 99) - 0.5);
  penalty += 15 * Math.max(0, (tiers['t100']?.turnaways ?? 99) - 1);
  penalty += 20 * Math.max(0, (tiers['t85']?.storms ?? 99) - 1);
  // 2. Proportionality: 70% play ≈ 0.7 of optimal, 50% ≈ 0.45, monotone ladder.
  penalty += 120 * Math.abs(norms.t70 - 0.7);
  penalty += 60 * Math.abs(norms.t50 - 0.45);
  if (norms.t85 < norms.t70) penalty += 50;
  if (norms.t70 < norms.t50) penalty += 50;
  // 3. Robustness: waste hurts but is not a cliff; mid-tier never deep-bankrupts.
  penalty += 100 * Math.max(0, 0.35 - norms.waste);
  penalty += 0.2 * Math.max(0, -(tiers['t70']?.minMoney ?? 0) - 150);
  // 4. Sanity: optimal play must clearly out-run idle operationally.
  if (top <= 300) penalty += 200;
  // 5. CHALLENGE: money-only lane spam MUST fail — meaningful losses AND clearly
  //    inferior to mixed play with fences/shops. If it wins, the game is a dud.
  penalty += 200 * Math.max(0, 0.1 - lossShare('lanesMax'));
  if (norms.lanesMax >= norms.t85 - 0.15) penalty += 200;
  penalty += 100 * Math.max(0, norms.lanesMax - 0.65);
  // 6. Mono-strategies stay mid-tier; doing nothing must be miserable.
  penalty += 100 * Math.max(0, norms.shopsOnly - 0.65);
  penalty += 150 * Math.max(0, 0.25 - lossShare('t30'));
  // 7. Breadth-without-depth (everything level 1) lands upper-mid, not top.
  penalty += 60 * Math.max(0, norms.lvl1max - 0.85);

  return { config, tiers, penalty, norms };
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// --- CLI ---------------------------------------------------------------------------

const [, , mode = 'pilot', ...args] = process.argv;
mkdirSync('.sweep', { recursive: true });

if (mode === 'shard') {
  const [iStr = '0', nStr = '1', configsStr = '160', durStr = '600'] = args;
  const i = Number(iStr);
  const n = Number(nStr);
  const all = makeConfigs(Number(configsStr));
  const mine = all.filter((c) => c.id % n === i);
  const out: string[] = [];
  for (const config of mine) {
    const result = evaluate(config, Number(durStr));
    out.push(JSON.stringify(result));
    console.log(`config ${config.id}: penalty ${Math.round(result.penalty)}`);
  }
  writeFileSync(`.sweep/shard-${i}.jsonl`, out.join('\n') + '\n');
} else if (mode === 'aggregate') {
  const results: ConfigResult[] = [];
  for (const file of readdirSync('.sweep')) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of readFileSync(`.sweep/${file}`, 'utf8').split('\n')) {
      if (line.trim()) results.push(JSON.parse(line) as ConfigResult);
    }
  }
  results.sort((a, b) => a.penalty - b.penalty);
  console.log(`${results.length} configs evaluated. Top 12:\n`);
  for (const r of results.slice(0, 12)) {
    const c = r.config;
    const t = r.tiers;
    console.log(
      `#${c.id} penalty=${Math.round(r.penalty)} | still=${c.frustStill.toFixed(1)} ` +
        `mov=${c.frustMoving.toFixed(2)} grace=${c.moveGrace.toFixed(2)} spread=${c.walkSpeedSpread.toFixed(2)} calm=${c.calmFactor.toFixed(2)} ` +
        `rushEnd=${c.rushEnd.toFixed(2)} loss=${c.lossCost} crowd=${c.crowdStress.toFixed(2)} prep=${c.prepSpeedup.toFixed(2)} visit=${c.shopVisitChance.toFixed(2)} relief=${c.reliefScale.toFixed(2)} ` +
        `shopCost=${c.shopCostScale.toFixed(2)} shopRev=${c.shopRevenueScale.toFixed(2)} svc=${c.laneServiceScale.toFixed(2)} ` +
        `upg=${c.upgradeCostScale.toFixed(2)}`,
    );
    console.log(
      `    storms/turn t100=${t['t100']?.storms.toFixed(1)}/${t['t100']?.turnaways.toFixed(1)} ` +
        `t85=${t['t85']?.storms.toFixed(1)}/${t['t85']?.turnaways.toFixed(1)} ` +
        `t70=${t['t70']?.storms.toFixed(1)} lanesMax=${t['lanesMax']?.storms.toFixed(1)} | ` +
        `norms t85=${r.norms['t85']?.toFixed(2)} t70=${r.norms['t70']?.toFixed(2)} ` +
        `t50=${r.norms['t50']?.toFixed(2)} lanesMax=${r.norms['lanesMax']?.toFixed(2)} ` +
        `shopsOnly=${r.norms['shopsOnly']?.toFixed(2)} lvl1=${r.norms['lvl1max']?.toFixed(2)} ` +
        `waste=${r.norms['waste']?.toFixed(2)}`,
    );
  }
} else {
  // pilot: 4 configs inline to validate the pipeline
  for (const config of makeConfigs(4)) {
    const r = evaluate(config, 480);
    console.log(
      `pilot config ${config.id}: penalty ${Math.round(r.penalty)} ` +
        `(t100 storms ${r.tiers['t100']?.storms.toFixed(1)}, t70 norm ${r.norms['t70']?.toFixed(2)})`,
    );
  }
}
