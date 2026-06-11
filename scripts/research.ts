/**
 * Balance algebra research bench — NOT part of the game runtime.
 *
 * Workflow:   algebra (this script) → constants.ts literals → simulation validates
 *
 * The script reads the LIVE values in src/constants.ts, runs the peg equations,
 * and prints each derived quantity next to its current value with the equation
 * that produced it, ending in a paste-ready recommendation block. Simulation
 * (waves.ts / simulate.ts / sweep.ts) then VALIDATES the chosen numbers — it is
 * not used to discover them.
 *
 * Usage: pnpm tsx scripts/research.ts
 */
import {
  MAX_FRUSTRATION,
  SHOP_TIERS,
  balance,
  laneUpgradeCost,
  rushSchedule,
  shopCost,
  tuning,
} from '../src/constants';

// --- The pegs (researcher-owned heuristics; the knobs of the whole economy) ---
const PEGS = {
  /** γ — the worst seat in a fenced line spends this share of its patience. */
  waveFill: 0.75,
  /** Cap on a line's walking share (merges and dispatch keep some standing). */
  walkShareCap: 0.75,
  /** ρ — share of the income earned in a wave cycle that prices the next buy.
   * ECONOMY INVERSION: cycle income includes the per-arrival MALL SPEND from
   * shops built so far in the ladder, so early rungs stay serve-affordable
   * while the top of the tree is priced against coffee money the player only
   * has if the mall exists. The remainder is fences early, loss slack late. */
  affordShare: 0.65,
  /** Realized share of rolled errands (busy-skip, unreachable, drop-outs). */
  shopHaircut: 0.7,
  /** κ — one walk-off erases this many flat serves. */
  lossServes: 5,
  /** Mob interiors average this many 3×3 neighbors (for the lethality check). */
  mobNeighbors: 4,
  /** Ramp discount on the opening cycle's calm arrivals (slow 6 AM start). */
  openingRamp: 0.65,
  /** A full wave-2 channel should cost about this share of the wave-2 bank. */
  fenceChannelShare: 0.5,
  /** Board storage: max overflow the floor can hold single-file (≈ 6 lanes ×
   * 20-tile channels). Waves never derive bigger than the maze can store. */
  channelStorage: 120,
};

/**
 * The tech tree as one merged, design-ordered ladder: wave k+1's paycheck funds
 * purchase k. Shops enter after lane 3 — their POSITION is what makes them
 * late-game, and the algebra prices them accordingly.
 */
type TechItem = 'open' | 'upg' | 'small' | 'medium' | 'large';
const TECH_LADDER: readonly TechItem[] = [
  'open',
  'open',
  'small',
  'open',
  'upg',
  'small',
  'upg',
  'medium',
  'open',
  'upg',
  'small',
  'upg',
  'medium',
  'open',
  'upg',
  'large',
  'upg',
  'upg',
  'upg',
  'upg',
  'upg',
  'upg',
  'upg',
];

// --- Fundamentals read from the live constants ----------------------------------
const p = balance.payoutBase; // flat serve payout: the money unit
const F = MAX_FRUSTRATION;
const rs = tuning.frustStill;
const stepTime = 1 / tuning.walkSpeed + tuning.moveGrace;
const pressure = 1 + tuning.rushEnd * 2;
const burst = tuning.rushBurst;
const svc = balance.laneService;
const rateAt = (lv: number): number => 1 / (svc[Math.min(lv, svc.length - 1)] ?? 3);
const calmRate = 1 / (tuning.spawnInterval * tuning.calmFactor * 1.15);

const lineWalkShare = (perLaneMu: number): number =>
  Math.min(PEGS.walkShareCap, stepTime * perLaneMu);
const lineBudget = (perLaneMu: number): number => F / (rs * (1 - lineWalkShare(perLaneMu)));

// --- §1 Patience algebra ---------------------------------------------------------
const mu0 = rateAt(0);
const bLine0 = lineBudget(mu0);
const mobMult = 1 + balance.crowdStress * (PEGS.mobNeighbors - balance.crowdLimit);
const bMob = F / (rs * mobMult);

console.log('═══ §1 Patience algebra ═══');
console.log(
  `  line walking share w(μ0)   = min(cap, (1/v+g)·μ0) = ${lineWalkShare(mu0).toFixed(2)}`,
);
console.log(`  line budget  B_line(μ0)    = F/(r_s·(1−w))        = ${bLine0.toFixed(0)} s`);
console.log(
  `  mob budget   B_mob         = F/(r_s·m), m=${mobMult.toFixed(1)}     = ${bMob.toFixed(1)} s`,
);
console.log(`  separation   B_line/B_mob  = ${(bLine0 / bMob).toFixed(1)}×  (want ≥ 5×)`);
const sepOk = bLine0 / bMob >= 5;
console.log(
  `  lethality:   γ·B_line ≥ 2·B_mob → ${(PEGS.waveFill * bLine0).toFixed(0)} ≥ ${(2 * bMob).toFixed(0)}  ${PEGS.waveFill * bLine0 >= 2 * bMob ? 'OK' : 'VIOLATED'}`,
);

// --- §1b Routing-physics consistency (directional congestion constants) ----------
// The congestion layer prices ROUTING, not patience — these checks keep its
// constants mutually coherent: (a) empty floor must stay cheaper than an orderly
// line (greedy clustering, no free queues), (b) contraflow dear but bounded,
// (c) cost ordering monotone in how long the obstacle will linger, (d) parked
// pricing consistent with real scan times, (e) temporal stability (a walker
// covers several tiles per re-price; oscillating equilibria decay, not flip).
const cFollow = 1 + tuning.occupantCost * tuning.followMult;
const cCross = 1 + tuning.occupantCost;
const cAgainst = 1 + tuning.occupantCost * tuning.againstMult;
const cIdle = 1 + tuning.occupantCost * tuning.idleBlock;
const cParkMin = 1 + tuning.occupantCost * tuning.parkedMin;
const cParkMax = 1 + tuning.occupantCost * tuning.parkedMax;
const scanSteps = (svc[0] ?? 3) * tuning.walkSpeed; // mean L1 scan, in step-times
const stepsPerRefresh = tuning.walkSpeed * tuning.routeRefresh;
const flapHalfLife =
  (tuning.routeRefresh * Math.log(2)) / Math.log(1 / (1 - tuning.congestionBlend));
const ordered = cFollow < cCross && cCross < cAgainst && cAgainst < cParkMin && cParkMin < cIdle;
console.log('\n═══ §1b Routing physics (congestion constants) ═══');
console.log(
  `  edge costs follow/cross/against = ${cFollow.toFixed(1)}/${cCross.toFixed(1)}/${cAgainst.toFixed(1)} · parked ${cParkMin.toFixed(0)}–${cParkMax.toFixed(0)} · idle ${cIdle.toFixed(0)}`,
);
console.log(
  `  linger-monotone ordering        follow<cross<against<parked≤idle  ${ordered ? 'OK' : 'VIOLATED'}`,
);
console.log(
  `  clustering: detours < ${cFollow.toFixed(2)}× beat queueing (empty < line ⇔ followMult > 0: ${tuning.followMult > 0 ? 'OK' : 'VIOLATED'})`,
);
console.log(
  `  backward-through-a-line ≈ ${cAgainst.toFixed(1)}×/member — near-wall, structurally (line-collapse guard)`,
);
console.log(
  `  parked clamp vs mean L1 scan    ${scanSteps.toFixed(1)} step-times ∈ [${tuning.parkedMin}, ${tuning.parkedMax}]  ${scanSteps >= tuning.parkedMin && scanSteps <= tuning.parkedMax ? 'OK' : 'CHECK'}`,
);
console.log(
  `  stability: ${stepsPerRefresh.toFixed(1)} tiles walked per re-price (≥2 ${stepsPerRefresh >= 2 ? 'OK' : 'VIOLATED'}) · flap half-life ${flapHalfLife.toFixed(1)} s`,
);

// --- §2 Wave table + derived price ladder (fixed-point on the runtime gap rule) --
type WaveRow = {
  k: number;
  item: TechItem;
  lanes: number;
  mu: number;
  overflow: number;
  duration: number;
  rate: number;
  gapBefore: number;
  price: number;
};

function buildLadder(): WaveRow[] {
  // The runtime sizes gaps from income vs next cost; cost here derives from
  // arrivals which depend on gaps — iterate to a fixed point (converges fast).
  let gaps: number[] = TECH_LADDER.map(() => 110);
  let rows: WaveRow[] = [];
  for (let iter = 0; iter < 4; iter++) {
    rows = [];
    const lanes: number[] = [0];
    let prevEnd = 106; // wave 1 (trivial) ends here; cycle 1 income starts at 0
    let first = true;
    // Per-arrival mall spend from shops built SO FAR in the ladder (the
    // inversion term: late rungs are priced against serve + mall income).
    let mallSpend = 0;
    for (const [k, item] of TECH_LADDER.entries()) {
      const m = lanes.reduce((s, lv) => s + rateAt(lv), 0);
      const perLane = m / lanes.length;
      const overflow = Math.min(PEGS.channelStorage, PEGS.waveFill * lineBudget(perLane) * m);
      const rate = m * pressure + burst;
      const duration = overflow / (rate - m);
      const gapBefore = gaps[k] ?? 110;
      const calmDur = first ? prevEnd + gapBefore : gapBefore;
      const arrivals = calmRate * (first ? PEGS.openingRamp : 1) * calmDur + rate * duration;
      const price = Math.round(PEGS.affordShare * (p + mallSpend) * arrivals);
      rows.push({
        k,
        item,
        lanes: lanes.length,
        mu: m,
        overflow,
        duration,
        rate,
        gapBefore,
        price,
      });
      if (item === 'open') lanes.push(0);
      else if (item === 'upg') {
        const i = lanes.indexOf(Math.min(...lanes));
        lanes[i] = (lanes[i] ?? 0) + 1;
      } else {
        mallSpend +=
          balance.shopVisitChance *
          PEGS.shopHaircut *
          SHOP_TIERS[item].revenue *
          balance.shopRevenueScale;
      }
      prevEnd += gapBefore + duration;
      first = false;
    }
    // Recompute gaps the way the RUNTIME does: gap = (cost − rushRevenue)/calmEarn.
    gaps = rows.map((r) => {
      const rushRevenue = r.mu * r.duration * p * 0.85;
      const calmServe = Math.min(calmRate, r.mu);
      const gap = (r.price - rushRevenue) / (calmServe * p * 0.85);
      return Math.min(180, Math.max(30, gap));
    });
  }
  return rows;
}

const ladder = buildLadder();
console.log('\n═══ §2 Wave table (peg-derived) vs current schedule ═══');
console.log('  wave item    lanes   μ     N(overflow) D(derived) D(current) price');
const current = rushSchedule();
for (const r of ladder) {
  const cur = current[r.k + 1]; // +1: schedule slot 0 is the trivial wave 1
  console.log(
    `  W${String(r.k + 2).padEnd(3)} ${r.item.padEnd(7)} ${String(r.lanes).padStart(2)}   ${r.mu.toFixed(2).padStart(5)} ` +
      `${r.overflow.toFixed(0).padStart(8)}    ${r.duration.toFixed(0).padStart(6)} s   ${cur ? (cur.end - cur.start).toFixed(0).padStart(6) + ' s' : '      —'} $${r.price}`,
  );
}

// --- §3 Fit the runtime's price knobs to the derived ladder ----------------------
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const opens = ladder.filter((r) => r.item === 'open').map((r) => r.price);
const upgs = ladder.filter((r) => r.item === 'upg').map((r) => r.price);
const upg0 = mean(upgs.slice(0, 6));
const upg1 = mean(upgs.slice(6));
// Tier price = the tier's FIRST ladder position (the runtime charges flat per
// tier; first-entry pricing keeps tiers monotonic and spread).
const firstPrice = (item: TechItem): number => ladder.find((r) => r.item === item)?.price ?? 0;
const kiosk = firstPrice('small');
const store = firstPrice('medium');
const anchor = firstPrice('large');

const openRatios = opens.slice(1).map((c, i) => c / (opens[i] ?? c));
const feeCurve = Math.pow(
  openRatios.reduce((a, b) => a * b, 1),
  1 / Math.max(1, openRatios.length),
);
const fee = opens[0] ?? 300;
// Runtime form: laneUpgradeCost(l) = fee × upgradeCurve^(l+1)
const upCurve0 = upg0 / fee;
const upCurve1 = Math.sqrt(upg1 / fee);
const upCurve = (upCurve0 + upCurve1) / 2;

// Wave durations: fit runtime's linear form D = a + b·k.
const n = ladder.length;
const sumK = ladder.reduce((s, r) => s + r.k, 0);
const sumD = ladder.reduce((s, r) => s + r.duration, 0);
const sumKK = ladder.reduce((s, r) => s + r.k * r.k, 0);
const sumKD = ladder.reduce((s, r) => s + r.k * r.duration, 0);
const durB = (n * sumKD - sumK * sumD) / (n * sumKK - sumK * sumK);
const durA = (sumD - durB * sumK) / n;

// Shop tiers: recommend shopCostScale from the anchor, then per-tier base costs.
const recShopScale = anchor / 1000;
const recKioskBase = Math.round(kiosk / recShopScale / 5) * 5;
const recStoreBase = Math.round(store / recShopScale / 10) * 10;

// Economy closure under the INVERSION. Rung prices derive from ρ × (serve +
// mall) income, so the tree is only fully fundable WITH the mall built: the
// gap between the tree and ρ×serve-only income is, by construction, the share
// shops must finance. shopRevenueScale is a researcher INPUT peg (it sets
// the mallSpend term above), validated here rather than derived.
const totalTree = ladder.reduce((s, r) => s + r.price, 0);
const dayEnd = ladder.reduce((s, r) => s + r.gapBefore + r.duration, 196);
const dayArrivals =
  ladder.reduce((s, r) => s + r.rate * r.duration, 0) +
  calmRate * (dayEnd - ladder.reduce((s, r) => s + r.duration, 0)) * 0.9;
const serveIncome = p * dayArrivals;
const serveAfford = PEGS.affordShare * serveIncome;
const inversionGap = totalTree - serveAfford;
// Projected mall revenue at CURRENT scale, shops existing over ~the back half.
const visitRate = balance.shopVisitChance * 6 * PEGS.shopHaircut; // errands/arrival, all built
const avgRev = ((3 * 4 + 2 * 10 + 22) / 6) * balance.shopRevenueScale;
const projShopRev = visitRate * avgRev * dayArrivals * 0.5;

// Fence + loss + start pegs.
const w2 = ladder[0];
const w2Bank = balance.startingMoney + PEGS.affordShare * p * calmRate * PEGS.openingRamp * 180;
const channelCost = (2 * ((w2?.overflow ?? 12) + 6) + 2) * balance.fenceCost;
const recFence = (PEGS.fenceChannelShare * w2Bank) / (2 * ((w2?.overflow ?? 12) + 6) + 2);
const recLoss = PEGS.lossServes * p;

console.log('\n═══ §3 Fits & checks (derived → current) ═══');
const line = (label: string, derived: string, cur: string | number): void =>
  console.log(`  ${label.padEnd(34)} ${derived.padStart(8)}   (current: ${cur})`);
line('checkpointFee = C(first open)', `$${Math.round(fee)}`, `$${balance.checkpointFee}`);
line('laneFeeCurve (geo-mean ratio)', feeCurve.toFixed(2), balance.laneFeeCurve);
line('upgradeCurve (fit both levels)', upCurve.toFixed(2), balance.upgradeCurve);
line(
  'lane upgrade L1→2 / L2→3',
  `$${Math.round(upg0)}/$${Math.round(upg1)}`,
  `$${laneUpgradeCost(0)}/$${laneUpgradeCost(1)}`,
);
line('shopCostScale (from anchor)', recShopScale.toFixed(2), balance.shopCostScale);
line(
  'kiosk/store base cost',
  `${recKioskBase}/${recStoreBase}`,
  `${SHOP_TIERS.small.cost}/${SHOP_TIERS.medium.cost}`,
);
line(
  'shop prices (k/s/a)',
  `$${Math.round(kiosk)}/$${Math.round(store)}/$${Math.round(anchor)}`,
  `$${shopCost('small')}/$${shopCost('medium')}/$${shopCost('large')}`,
);
line('wave duration ≈ a + b·k', `${durA.toFixed(0)}+${durB.toFixed(1)}k`, '26+1.5k');
line('lossCost = κ·p', `$${recLoss}`, `$${balance.lossCost}`);
line('fenceCost (channel ≈ ½·W2 bank)', `$${recFence.toFixed(1)}`, `$${balance.fenceCost}`);
line('W2 channel cost vs W2 bank', `$${Math.round(channelCost)} / $${Math.round(w2Bank)}`, '—');
console.log(
  `  INVERSION: tree $${Math.round(totalTree)} vs ρ·serve-only $${Math.round(serveAfford)} ` +
    `→ mall must finance $${Math.round(inversionGap)} (${Math.round((100 * inversionGap) / totalTree)}% of tree)`,
);
console.log(
  `  projected mall revenue at current scale ≈ $${Math.round(projShopRev)} ` +
    `(${projShopRev >= inversionGap ? 'covers the gap' : 'SHORT — raise scale/visits'})`,
);
console.log(
  `  ladder day ≈ ${Math.round(dayEnd / 60)} min · separation check ${sepOk ? 'OK' : 'VIOLATED'}`,
);

// --- §3b The overtime dial: how many WAVES the mall is worth ---------------------
// Against a deluge growing ×overtimeGrowth per wave, money converts to survival
// LOGARITHMICALLY: capacity bought with mall income extends the day by
// ln(μ_full / μ_serve) / ln(growth) waves, where μ_serve is the capacity a
// serve-only (mall-less) economy can afford. This dial — not shop pricing —
// sets the mall's ablation value: at growth g the inversion's behavioral teeth
// are exactly mallWaves(g), and no revenue multiplier can exceed that cap
// (shop levers at their bounds move shop ablation ≤ 0.6 waves while growth
// 1.1 caps the mall at ~1.8). Pegged so the mall is worth ≥ 3 waves.
const MALL_WAVES_TARGET = 3;
{
  // Replay the ladder: capacity after each rung, and the rungs a serve-only
  // bank can reach (capacity items only — a mall-less build skips shop rungs).
  const lanesArr: number[] = [0];
  const muAfter: number[] = [];
  for (const item of TECH_LADDER) {
    if (item === 'open') lanesArr.push(0);
    else if (item === 'upg') {
      const i = lanesArr.indexOf(Math.min(...lanesArr));
      lanesArr[i] = (lanesArr[i] ?? 0) + 1;
    }
    muAfter.push(lanesArr.reduce((s, lv) => s + rateAt(lv), 0));
  }
  const muFull = muAfter[muAfter.length - 1] ?? mu0;
  let cum = 0;
  let muServe = mu0;
  for (const [k, item] of TECH_LADDER.entries()) {
    if (item !== 'open' && item !== 'upg') continue;
    cum += ladder[k]?.price ?? 0;
    if (cum > serveAfford) break;
    muServe = muAfter[k] ?? muServe;
  }
  const ratio = muFull / muServe;
  const mallWaves = Math.log(ratio) / Math.log(tuning.overtimeGrowth);
  const recGrowth = Math.exp(Math.log(ratio) / MALL_WAVES_TARGET);
  console.log('\n═══ §3b Overtime dial (the mall-value equation) ═══');
  console.log(
    `  μ_serve-only / μ_full          = ${muServe.toFixed(2)} / ${muFull.toFixed(2)} pax/s (ratio ${ratio.toFixed(2)})`,
  );
  console.log(
    `  mall worth at current growth   = ln(ratio)/ln(${tuning.overtimeGrowth}) = ${mallWaves.toFixed(1)} waves (target ≥ ${MALL_WAVES_TARGET})`,
  );
  console.log(
    `  overtimeGrowth for ${MALL_WAVES_TARGET} waves     = ratio^(1/${MALL_WAVES_TARGET}) = ${recGrowth.toFixed(3)}  ${mallWaves >= MALL_WAVES_TARGET ? 'OK' : '→ RECOMMEND lowering'}`,
  );
}

console.log('\n═══ §4 Paste-ready recommendations (constants.ts) ═══');
console.log(`  checkpointFee: ${Math.round(fee / 10) * 10},`);
console.log(`  laneFeeCurve: ${feeCurve.toFixed(2)},`);
console.log(`  upgradeCurve: ${upCurve.toFixed(2)},`);
console.log(
  `  shopCostScale: ${recShopScale.toFixed(2)},  // with SHOP_TIERS costs ${recKioskBase}/${recStoreBase}/1000`,
);
console.log(`  lossCost: ${recLoss},`);
console.log(`  // rushSchedule duration: ${durA.toFixed(0)} + k×${durB.toFixed(1)}`);
