import type { Perk, Rect, ShopTier, Vec } from './types';

/** Shown in the corner version tag; keep in step with package.json. */
export const GAME_VERSION = '0.1.0';

export const COLS = 39;
export const ROWS = 26;
export const TILE = 16;
export const RENDER_SCALE = 2;

/** Entrance door band spans the ENTIRE left wall; spawns sit just inside at x=1. */
export const DOOR_Y0 = 1;
export const DOOR_Y1 = ROWS - 2;

export const SPAWN_TILES: readonly Vec[] = Array.from(
  { length: DOOR_Y1 - DOOR_Y0 + 1 },
  (_, i) => ({ x: 1, y: DOOR_Y0 + i }),
);

/** First machine column; clicks at x >= this toggle checkpoints. */
export const MACHINE_X0 = COLS - 4;
/** Column of every slot's service tile; machines occupy MACHINE_X0..COLS-2 on the slot row. */
export const SERVICE_X = MACHINE_X0 - 1;

/** Fences may only be placed inside this rectangle (inclusive bounds). */
export const BUILDABLE = { x0: 3, y0: 1, x1: SERVICE_X, y1: ROWS - 2 };

export const SLOT_YS: readonly number[] = [2, 6, 10, 14, 18, 22];
export const INITIAL_OPEN_SLOTS: readonly number[] = [2]; // poverty start: one lane (y=10)

/** Every slot may be opened; capacity is limited by money, not a budget cap. */
export const CHECKPOINTS_TOTAL = 6;

/** Facilities have a base level 0 and two upgrades (levels 1 and 2). */
export const MAX_LEVEL = 2;

/**
 * EVERY economy / facility / perk number lives here as a variable so the sweep
 * harness (scripts/sweep.ts) can search the joint space. The game treats this as
 * read-only constants; only harnesses mutate it per run.
 */
export const balance = {
  // Poverty start: below the cheapest facility — wave 1 is survived bare, and
  // the only thing the opening bank can buy is fences (the wave-2 lesson).
  startingMoney: 100,
  /** Serve payout = base + bonus × satisfaction. PINNED at a flat $5: checkpoint
   * money is a fixed drip that funds the EARLY ladder only; the growing budget
   * for the expensive top half comes from shop spending. Satisfaction still pays
   * — through avoided $lossCost storms, not through the serve check. */
  payoutBase: 5,
  payoutSatBonus: 0,
  /** Charged identically for storm-offs, sealed-in vanishes, and turn-aways.
   * Loss peg κ=5: one walk-off erases five flat serves. */
  lossCost: 25,
  /** VIP bonus per wave index: each wave's first arrival is its VIP, paying
   * `this × wave` on a clean serve (wave 2 → $50 … wave 20 → $500). Scales so
   * the carrot stays relevant against late incomes; ≈10% of a good day's total
   * if every VIP is saved. A reward channel only — never a fail condition. */
  vipBonusPerWave: 25,
  /** SERVICE failure: lose more than this share of one wave's cohort and the
   * authority shuts the checkpoint down. Mall income forgives losses
   * financially (shoppers spend before they storm), so the day's real edge is
   * service quality — this is what makes throughput worth buying late. */
  maxLossShare: 0.35,
  /** ...but only when the cohort is big enough to judge (no W1 noise-deaths). */
  lossFailMin: 8,
  /** Tolerated DISORDER in a waiting passenger's 3×3 box. Flow-mates (same
   * target, distinct rank) and moving crossers don't count — only same-ring
   * competitors and standing strangers do — so the tolerance is ZERO: any
   * disorder stresses. Lines of any shape are calm; mobs are not. */
  crowdLimit: 0,
  /** Standing-frustration multiplier per disorder neighbor. Kept moderate: at
   * ×2-per-neighbor any pinch point instantly detonates — one squeeze and a
   * third of a good maze flees. Difficulty splits between the base standing
   * rate (waiting binds, even in line) and this (a pinch stings, +50%/neighbor,
   * but is survivable for the seconds it usually lasts). */
  crowdStress: 0.5,
  /** Scan-time multiplier for a prepped passenger (sole on-deck waiter). */
  prepSpeedup: 0.5,
  /** INDEPENDENT chance per built shop that an arrival adds it to their errand
   * itinerary. Multi-errand passengers are rate shaping: errands stagger lane
   * arrivals, spread people across the floor, and stack perks. Coverage peg:
   * all 6 shops built → 1−(1−q)^6 ≈ 97% of arrivals run errands (~2.7 each) —
   * the mall is a first-class buffer, not a side attraction. */
  shopVisitChance: 0.45,
  /** Extra visit chance per shop level — upgraded shops draw (slightly) more
   * foot traffic, so upgrades buy demand shaping, not just potency. */
  shopVisitLevelBonus: 0.05,
  /** Multiplier on per-visit shop revenue (tier base × this × level growth).
   * Checkpoint payouts stay PINNED at $5; under the ECONOMY INVERSION the late
   * tech-ladder rungs are priced against serve + shop income combined, so the
   * top of the tree is only fundable with a built-out mall (research bench §2). */
  shopRevenueScale: 0.9,
  /** Per-visit revenue growth per shop level — steep enough that upgrading a
   * built shop competes with opening another one (seats AND spend per visit). */
  shopRevenueLevelMult: [1, 1.6, 2.4],
  /** Multiplier on every tier's counter dwell time. Browsing passengers are a
   * PEAK-SHAVER (everyone at a counter is one not pressing the lanes), but the
   * buffer must come from SEATING (counters grow with upgrades), not parked
   * patrons — long dwells with few seats just congest the storefront. */
  shopDwellScale: 1.8,
  // Capacity prices per scripts/research.ts (peg: each buy ≈ ρ×cycle income).
  /** Fence peg: a full wave-2 channel (~35 ropes) ≈ half the wave-2 bank. */
  fenceCost: 3,
  /** Gate (retractable belt): buy once, toggle open/closed FREE — the live-mazing
   * valve. Priced at ~5 fences: hardware, not rope. */
  gateCost: 15,
  /** Storm shockwave: a walk-off panics nearby WAITING passengers (+frustration
   * within the radius). Mobs cascade; a single-file line barely notices.
   * Kept moderate, like crowdStress: a steeper avalanche chains one pinch-storm
   * into mass exodus. */
  stormShock: 6,
  stormShockRadius: 2,
  checkpointFee: 320,
  /** Each ADDITIONAL lane costs more: fee x this per lane already open.
   * Kept gentle: the bench's open-price ladder is hockey-stick shaped, and a
   * single exponential fitted to it overprices the CRUCIAL early lanes. The
   * economy inversion lives in the upgrade curve (12 of the 17 rungs). */
  laneFeeCurve: 1.4,
  /**
   * Exponential LANE upgrade pricing: upgrading to level L costs fee × curve^(L).
   * ECONOMY INVERSION (research bench §2): late rungs are priced against serve +
   * mall income, so capacity's top half is only fundable with shops built.
   * Held near the bench's derivation (6.33): at a much shallower curve (~3.5)
   * serve+VIP income alone maxes the tree and the elite meta drops the mall
   * entirely. The inversion only has teeth if the top rungs are genuinely
   * unaffordable without coffee money.
   */
  upgradeCurve: 5.0,
  /** Shop upgrades climb much more gently — they buy seating (buffer throughput)
   * and demand, and must stay attractive next to raw capacity. */
  shopUpgradeCurve: 1.4,
  /** Mean scan seconds by checkpoint level. Upgrades are TRANSFORMATIVE
   * (+47%/+46% throughput per level): at smaller per-level gains no price
   * makes upgrades worth buying — their niche is the endgame, where the floor
   * is full, the deluge keeps growing, and faster scans are the only capacity
   * left to buy. */
  laneService: [2.8, 1.9, 1.3],
  /** Multiplier on every shop tier's patience relief. Sized against frustStill:
   * waits bind, so banked patience is survival, not luxury — relief is the
   * shop category's non-substitutable niche (money converts to waves
   * logarithmically under the deluge; banked patience converts linearly). */
  reliefScale: 1.8,
  /** Multiplier on every shop tier's cost (refunds stay 50% of scaled spend).
   * Tier base costs + this scale come from each tier's FIRST position in the
   * research bench's tech ladder (kiosk after lane 3, anchor near the top). */
  shopCostScale: 3.69,
  /** Relief multiplier by shop level. */
  shopReliefLevelMult: [1, 1.5, 2],
  // Perk magnitudes by shop level (level-indexed arrays). The LEVEL deltas are
  // deliberately steep: shop upgrades' survival niche is loss prevention
  // (faster scans, calmer lines, storm saves) — income alone is too abundant
  // late to make an upgrade worth buying.
  /** Coffee: walk-speed multiplier for the rest of the day. */
  perkCaffeine: [1.35, 1.55, 1.75],
  /** Coffee also sharpens scans: caffeinated patrons clear the checkpoint quicker
   * (milder than Luggage Wrap's dedicated fastscan; the two stack). */
  perkCaffeineScan: [0.9, 0.8, 0.7],
  /** Newsstand: standing-frustration multiplier (they read in line). */
  perkReading: [0.75, 0.6, 0.45],
  /** Currency exchange: tip paid by each visitor. */
  perkCash: [4, 8, 14],
  /** Luggage wrap: scan-time multiplier (pre-packed bags). */
  perkFastscan: [0.7, 0.55, 0.4],
  /** Zen lounge: free storm-saves per visitor. */
  perkZen: [1, 2, 4],
  /** When a zen save triggers, frustration resets to this instead of storming. */
  zenReset: 60,
};

/** Level-indexed lookup with a safe clamp (arrays above are sweep-mutable). */
export function atLevel(values: readonly number[], level: number): number {
  return values[Math.min(level, values.length - 1)] ?? values[0] ?? 1;
}

/** Price of upgrading a lane FROM the given level (exponential curve). */
export function laneUpgradeCost(level: number): number {
  return Math.round(balance.checkpointFee * Math.pow(balance.upgradeCurve, level + 1));
}

export function laneInvested(level: number): number {
  let total = balance.checkpointFee;
  for (let l = 0; l < level; l++) total += laneUpgradeCost(l);
  return total;
}

export function laneRefund(level: number): number {
  return Math.round(laneInvested(level) / 2);
}

// --- Shops: fixed mid-floor slots; buildings are solid and reshape routing. ----
export type ShopTierDef = {
  label: string;
  blurb: string;
  cost: number;
  /** Patience banked by a visit (frustration may go negative, to -100). */
  relief: number;
  /** Seconds spent at the counter. */
  dwell: number;
  /** Money spent by each visitor (scaled by shopRevenueScale and level). */
  revenue: number;
};

/** Bigger tiers are better value per patience point — saving up is rewarded. */
export const SHOP_TIERS: Record<ShopTier, ShopTierDef> = {
  small: {
    label: 'Kiosk',
    blurb: 'A coffee cart in the stream. Visitors leave a little calmer.',
    cost: 140,
    relief: 30,
    dwell: 1.0,
    revenue: 4,
  },
  medium: {
    label: 'Store',
    blurb: 'A proper shop to wander. Visitors leave noticeably calmer.',
    cost: 330,
    relief: 90,
    dwell: 1.2,
    revenue: 10,
  },
  large: {
    label: 'Duty-Free Anchor',
    blurb: 'Retail therapy at scale. Visitors leave much calmer — and it bends the whole flow.',
    cost: 1000,
    relief: 175,
    dwell: 1.5,
    revenue: 22,
  },
};

export function shopCost(tier: ShopTier): number {
  return Math.round(SHOP_TIERS[tier].cost * balance.shopCostScale);
}

/** Price of upgrading a shop FROM the given level (gentle exponential curve). */
export function shopUpgradeCost(tier: ShopTier, level: number): number {
  return Math.round(shopCost(tier) * Math.pow(balance.shopUpgradeCurve, level + 1));
}

export function shopInvested(tier: ShopTier, level: number): number {
  let total = shopCost(tier);
  for (let l = 0; l < level; l++) total += shopUpgradeCost(tier, l);
  return total;
}

export function shopRefund(tier: ShopTier, level: number): number {
  return Math.round(shopInvested(tier, level) / 2);
}

/** Money a visitor spends at the counter (checkpoint payouts stay pinned). */
export function shopVisitRevenue(tier: ShopTier, level: number): number {
  return Math.round(
    SHOP_TIERS[tier].revenue *
      balance.shopRevenueScale *
      atLevel(balance.shopRevenueLevelMult, level),
  );
}

export function shopRelief(tier: ShopTier, level: number): number {
  return Math.round(
    SHOP_TIERS[tier].relief * balance.reliefScale * atLevel(balance.shopReliefLevelMult, level),
  );
}

/** Counter spots by upgrade level. Upgrades buy SEATING above all: at full
 * upgrade a store's entire perimeter is counters (only the core stays solid),
 * so a maxed shop is a high-throughput buffer, not just a stronger perk.
 * Kiosks stay at one walk-in spot — they're already half seating, and a
 * building with no solid tile can't carry its sign. */
export const COUNTERS_BY_LEVEL: Record<ShopTier, readonly number[]> = {
  small: [1, 1, 1],
  medium: [3, 6, 8],
  large: [5, 10, 16],
};

export function activeVisits(shop: { tier: ShopTier; visits: Vec[]; level: number }): Vec[] {
  return shop.visits.slice(0, atLevel(COUNTERS_BY_LEVEL[shop.tier], shop.level));
}

/** Human description of a perk at a given shop level (reads live balance values). */
export function perkBlurb(perk: Perk, level: number): string {
  switch (perk) {
    case 'caffeine':
      return (
        `Patrons walk ${Math.round((atLevel(balance.perkCaffeine, level) - 1) * 100)}% faster all day ` +
        `and clear scans ${Math.round((1 - atLevel(balance.perkCaffeineScan, level)) * 100)}% quicker.`
      );
    case 'reading':
      return `Patrons read in line: standing frustration ×${atLevel(balance.perkReading, level)}.`;
    case 'cash':
      return `Each visitor tips +$${atLevel(balance.perkCash, level)}.`;
    case 'fastscan':
      return `Pre-wrapped bags: scan time ×${atLevel(balance.perkFastscan, level)}.`;
    case 'zen':
      return `${atLevel(balance.perkZen, level)} free storm-save(s): patrons sigh and re-center instead of quitting.`;
  }
}

/**
 * Five fixed shop locations, mid-floor and spread out so every major flow line
 * passes one: solid buildings double as routing obstacles ("free fence mass").
 * Counters face the dominant (entrance-side or center) flow. Each slot is a named
 * shop with its own superpower; bigger footprints carry the stronger powers.
 */
export const SHOP_SLOTS: readonly {
  tier: ShopTier;
  name: string;
  perk: Perk;
  rect: Rect;
  visits: Vec[];
}[] = [
  // Counters sit INSIDE the footprint: those tiles stay walkable shop-floor; the
  // rest of the building is solid. Level-locked counters are solid until unlocked.
  // Kiosks are 1x2 (1 solid + 1 walk-in counter), staggered through the mid-floor
  // so every major flow line brushes one.
  {
    tier: 'small',
    name: 'Newsstand',
    perk: 'reading',
    rect: { x: 18, y: 8, w: 1, h: 2 },
    visits: [{ x: 18, y: 9 }],
  },
  {
    tier: 'small',
    name: 'Currency Exchange',
    perk: 'cash',
    rect: { x: 20, y: 15, w: 1, h: 2 },
    visits: [{ x: 20, y: 15 }],
  },
  // Stores (3x3): front row walk-in counters facing the center flow.
  // Visit lists run base counters first, then perimeter tiles in unlock order —
  // by max level the whole perimeter is seating and only the core stays solid.
  {
    tier: 'medium',
    name: 'Luggage Wrap',
    perk: 'fastscan',
    rect: { x: 13, y: 3, w: 3, h: 3 },
    visits: [
      { x: 13, y: 5 },
      { x: 14, y: 5 },
      { x: 15, y: 5 },
      { x: 13, y: 4 },
      { x: 15, y: 4 },
      { x: 13, y: 3 },
      { x: 14, y: 3 },
      { x: 15, y: 3 },
    ],
  },
  {
    tier: 'medium',
    name: 'Zen Lounge',
    perk: 'zen',
    rect: { x: 13, y: 20, w: 3, h: 3 },
    visits: [
      { x: 13, y: 20 },
      { x: 14, y: 20 },
      { x: 15, y: 20 },
      { x: 13, y: 21 },
      { x: 15, y: 21 },
      { x: 13, y: 22 },
      { x: 14, y: 22 },
      { x: 15, y: 22 },
    ],
  },
  // Anchor (5x5) just past the entrance: caffeine speed pays for the WHOLE walk,
  // so the coffee bar sits where journeys begin. Counters face EAST (downstream)
  // so customers peel off with the flow instead of doubling back at the door.
  {
    tier: 'large',
    name: 'Grand Coffee Bar',
    perk: 'caffeine',
    rect: { x: 4, y: 10, w: 5, h: 5 },
    visits: [
      { x: 8, y: 10 },
      { x: 8, y: 11 },
      { x: 8, y: 12 },
      { x: 8, y: 13 },
      { x: 8, y: 14 },
      // Upgrade counters wrap around the corners — always on the footprint EDGE,
      // never interior, so new openings read as the storefront growing. At max
      // level the full 16-tile perimeter is seating around a 3×3 solid core.
      { x: 7, y: 10 },
      { x: 7, y: 14 },
      { x: 6, y: 10 },
      { x: 6, y: 14 },
      { x: 5, y: 10 },
      { x: 5, y: 14 },
      { x: 4, y: 10 },
      { x: 4, y: 14 },
      { x: 4, y: 11 },
      { x: 4, y: 12 },
      { x: 4, y: 13 },
    ],
  },
  // Third kiosk (appended last so the anchor keeps index 4 in harness buy orders).
  {
    tier: 'small',
    name: 'Charging Station',
    perk: 'reading',
    rect: { x: 23, y: 11, w: 1, h: 2 },
    visits: [{ x: 23, y: 12 }],
  },
];

/**
 * Random mall placement band: storefronts spawn anywhere inside these margins,
 * at least `gap` clear tiles apart (spread-out guarantee). The margins are
 * load-bearing, not cosmetic: xMin keeps the door fan open, and xMax keeps
 * buildings out of the CHANNEL FAN — full-depth approach channels span
 * x ≈ 21..34 on every lane row, so any footprint past 22 plugs somebody's
 * channel and bankrupts skilled play on most seeds. SHOP_SLOTS supplies
 * tier/name/perk and footprint SIZE; positions and counter tiles are
 * generated per game by level.ts.
 */
export const MALL_PLACEMENT = { xMin: 7, xMax: 22, yMin: 2, yMax: ROWS - 3, gap: 3 };

export function serviceTile(slotY: number): Vec {
  return { x: SERVICE_X, y: slotY };
}

export function exitPath(slotY: number): Vec[] {
  return Array.from({ length: COLS - 2 - MACHINE_X0 + 1 }, (_, i) => ({
    x: MACHINE_X0 + i,
    y: slotY,
  }));
}

export const MAX_FRUSTRATION = 100;
/** One-time frustration drop when processing starts ("finally, progress!"). */
export const PROGRESS_RELIEF = 12;
/** Lane-choice penalty per passenger already assigned to a lane, in tile-distance units. */
export const QUEUE_WEIGHT = 6;
/** Seconds a storming passenger gets before vanishing (failsafe if sealed in by fences). */
export const STORM_TIMEOUT = 30;
/** Game clock starts at 6:00 AM; one real second is one game minute. */
export const CLOCK_START_MINUTES = 6 * 60;

/**
 * Simulation parameters, mutable for balance experiments (the headless harnesses
 * override these per run); the game itself treats them as read-only constants.
 */
export const tuning = {
  /** Frustration per second while standing still. High enough that waiting in
   * line visibly erodes patience: at lower rates a calm fenced queue is
   * frustration-free however long, and ALL difficulty lives in the disorder
   * multiplier (too stark: lines free, pinches lethal). The wait itself binds,
   * which is also what gives shop RELIEF a real survival niche. */
  frustStill: 6.5,
  /** Frustration per second while mid-step. EXTREME by design: a walking passenger
   * barely loses happiness at all. Queue GEOMETRY is the core mechanic — vacancies
   * ripple backward at walk speed in any layout, so shuffle cadence is similar
   * everywhere; what a good layout buys is more of the wait spent in motion, and
   * that only pays because motion is nearly free. */
  frustMoving: 0.01,
  /** Seconds after each step during which accrual stays at the walking rate. */
  moveGrace: 1.15,
  /** Tiles per second. */
  walkSpeed: 2.2,
  /** Innate per-passenger walk-speed spread: each spawns with a speed multiplier
   * drawn uniformly from [1 − spread, 1 + spread]. Slow walkers clog single-file
   * lines; fast walkers bunch up behind them — variance is texture AND difficulty. */
  walkSpeedSpread: 0.25,
  /** Base seconds between spawns (scaled by calm/ramp/wobble/jitter or rush depth). */
  spawnInterval: 1.4,
  /** Calm-period multiplier on the base interval: valleys are genuinely calm. */
  calmFactor: 1.5,
  /** Rush spawn-interval multiplier at the start of the day... */
  rushStart: 0.5,
  /** ...deepening linearly to this by RUSH_PEAK_TIME. Burst is the difficulty curve. */
  rushEnd: 0.2,
  /** Flat extra arrivals/s on every exam wave (wave 2+). Relative pressure alone
   * (rate = μ×1.4) produces negligible ABSOLUTE overflow when μ is one lane —
   * the burst is what makes early waves overflow into the maze at all. */
  rushBurst: 0.48,
  /** Overtime deluge growth: each post-ladder wave is this much stronger than
   * the last. The late-game pressure dial — how fast the day outgrows a fully
   * built checkpoint once capacity purchases are exhausted. (Both pressure
   * dials are sized so the best builds cannot coast through the whole day.) */
  overtimeGrowth: 1.1,
  // --- Directional congestion (routing fields price bodies, not just walls) ---
  /** Base surcharge for a tile holding a person (empty floor costs 1). */
  occupantCost: 1.0,
  /** ...×this when they move YOUR way (follow the line — they vacate ahead). */
  followMult: 0.5,
  /** ...×this when they move AGAINST you (contraflow squeeze — a courtesy swap
   * exists, so it's dear but bounded). Crossing traffic is ×1. */
  againstMult: 2.0,
  /** Parked bodies (mid-scan, mid-browse) price by REMAINING park time in
   * step-times, clamped to [parkedMin, parkedMax] × occupantCost — no swap
   * exists with them: near-wall while they linger, cheap when nearly done. */
  parkedMin: 3,
  parkedMax: 10,
  /** Directionless idle (wanderers): unknowable linger — mid-range default. */
  idleBlock: 6,
  /** Seconds between congestion re-pricings of the routing fields. Slow on
   * purpose: fast refreshes flip near-equal routes and crowds flap between
   * them. Layout edits (fences, gates, lanes) still reroute INSTANTLY. */
  routeRefresh: 2,
  /** Each re-pricing blends this share of the fresh occupancy snapshot into
   * the previous one (EMA). Oscillating equilibria decay instead of flipping;
   * recently-vacated tiles keep a fading ghost cost. */
  congestionBlend: 0.5,
};

// --- Staged rush schedule: 18+ rushes pinned to the capacity ladder. -----------
// Rush k arrives JUST BEFORE a perfect player can afford capacity purchase k; the
// rush's revenue completes the fund. Each rush's intensity pressure-tests the
// capacity the player can have at that stage (rate ≈ pressure × current μ), so
// capacity alone never clears a rush — the gap is bridged by mazing + shops.
// 18 stages is the MINIMUM, not a cap: once the ladder is exhausted, overtime
// waves keep arriving, each stronger and longer than the last.

/** Overtime waves are generated out to this game-time horizon (seconds). */
const SCHEDULE_HORIZON = 10800;

export type RushStage = { start: number; end: number; rate: number };

let scheduleKey = '';
let scheduleCache: RushStage[] = [];

/** SIDE EFFECT: caches the derived schedule; rebuilt whenever balance/tuning change. */
export function rushSchedule(): RushStage[] {
  const key = [
    balance.checkpointFee,
    balance.laneFeeCurve,
    balance.upgradeCurve,
    balance.payoutBase,
    balance.payoutSatBonus,
    tuning.rushEnd,
    tuning.rushBurst,
    tuning.overtimeGrowth,
    tuning.calmFactor,
    tuning.spawnInterval,
    ...balance.laneService,
  ].join('|');
  if (key === scheduleKey) return scheduleCache;
  scheduleKey = key;

  const svc = balance.laneService;
  const rateAt = (lv: number) => 1 / (svc[Math.min(lv, svc.length - 1)] ?? 3);
  // Perfect-play purchase ladder: 5 lane openings + 12 lane upgrades, cheapest first.
  const buys: { cost: number; gain: number }[] = [];
  for (let n = 2; n <= 6; n++) {
    buys.push({
      cost: Math.round(balance.checkpointFee * Math.pow(balance.laneFeeCurve, n - 2)),
      gain: rateAt(0),
    });
  }
  for (let lane = 0; lane < 6; lane++) {
    for (let l = 0; l < MAX_LEVEL; l++) {
      buys.push({ cost: laneUpgradeCost(l), gain: rateAt(l + 1) - rateAt(l) });
    }
  }
  buys.sort((a, b) => a.cost - b.cost);

  // rushEnd doubles as the pressure dial: rate ≈ (1 + 2×rushEnd) × current capacity.
  const pressure = 1 + tuning.rushEnd * 2;
  const avgPayout = (balance.payoutBase + balance.payoutSatBonus * 0.7) * 0.85;
  let mu = rateAt(0); // poverty start: one level-1 lane
  let t = 90;
  const stages: RushStage[] = [];
  // Wave 1: the trivial hello-world wave. Barely above one lane's capacity and
  // short — nothing is affordable beforehand (startingMoney < cheapest facility),
  // so it just teaches the flow. The breather after it is fence-laying time.
  stages.push({ start: t, end: t + 16, rate: mu * 1.05 });
  t += 16 + 74;
  for (const [k, buy] of buys.entries()) {
    // Wave k+2: the exam for era k. The burst term is what overflows the lanes
    // into the maze; wave 2 (k=0) is the FENCE exam — one lane, no facilities,
    // walkaways unless the overflow is stored in rope line.
    // Duration tracks the research bench's peg curve (overflow fills a fair
    // share of line patience, capped by board storage): min(80, 26 + 6k).
    const duration = Math.min(80, 26 + k * 6);
    stages.push({ start: t, end: t + duration, rate: mu * pressure + tuning.rushBurst });
    // Calm earning window sized so the NEXT purchase is just barely funded in time.
    // Income is ARRIVAL-limited during calm (the trickle, not capacity) and
    // capacity-limited during the rush itself; both must fund the next buy.
    const calmServe = Math.min(1 / (tuning.spawnInterval * tuning.calmFactor * 1.15), mu);
    const rushRevenue = mu * duration * avgPayout;
    const gap = (buy.cost - rushRevenue) / (calmServe * avgPayout);
    // Cap at 180s: late buys are deliberately not fully fundable from calm income —
    // the rush itself is the paycheck, and good play (satisfaction, tips) closes
    // the remaining gap. Keeps the whole ladder inside a ~50-minute day.
    t += duration + Math.min(180, Math.max(30, gap));
    mu += buy.gain;
  }
  // Stage 18 onward: overtime deluges against a fully built checkpoint. The
  // capacity ladder is spent — from here only geometry and shops buy survival.
  let rate = mu * pressure * 1.15;
  let duration = 60;
  while (t < SCHEDULE_HORIZON) {
    stages.push({ start: t, end: t + duration, rate });
    t += duration + Math.max(25, 60 - (stages.length - buys.length) * 3);
    rate *= tuning.overtimeGrowth;
    duration += 4;
  }
  scheduleCache = stages;
  return stages;
}

export function isRush(time: number): boolean {
  return rushSchedule().some((s) => time >= s.start && time < s.end);
}

/** 1-based index of the wave in progress at `time`, or null during calm. */
export function currentWave(time: number): number | null {
  const i = rushSchedule().findIndex((s) => time >= s.start && time < s.end);
  return i >= 0 ? i + 1 : null;
}

/** The next wave (1-based) and seconds until it arrives, or null after the last. */
export function nextWave(time: number): { index: number; inSeconds: number } | null {
  const i = rushSchedule().findIndex((s) => time < s.start);
  if (i < 0) return null;
  const stage = rushSchedule()[i];
  return stage ? { index: i + 1, inSeconds: stage.start - time } : null;
}

/**
 * Seconds until the next spawn: staged-rush rate when inside a rush window,
 * otherwise a calm trickle with opening ramp and gentle wobble.
 * `rand` is a uniform [0,1) sample supplied by the caller.
 */
export function nextSpawnInterval(time: number, rand: number): number {
  const jitter = 0.7 + rand * 0.8;
  const stage = rushSchedule().find((s) => time >= s.start && time < s.end);
  if (stage) return jitter / stage.rate;
  const ramp = 1 + 2.5 * Math.exp(-time / 180);
  const wobble = 1 + 0.25 * Math.sin(time / 19);
  return tuning.spawnInterval * tuning.calmFactor * ramp * wobble * jitter;
}
