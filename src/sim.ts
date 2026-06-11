import {
  BUILDABLE,
  CHECKPOINTS_TOTAL,
  MAX_FRUSTRATION,
  MAX_LEVEL,
  PROGRESS_RELIEF,
  QUEUE_WEIGHT,
  SHOP_TIERS,
  SPAWN_TILES,
  STORM_TIMEOUT,
  activeVisits,
  atLevel,
  balance,
  exitPath,
  laneRefund,
  currentWave,
  nextSpawnInterval,
  laneUpgradeCost,
  serviceTile,
  shopCost,
  shopRefund,
  shopRelief,
  shopUpgradeCost,
  shopVisitRevenue,
  tuning,
} from './constants';
import { applyShopTiles, applySlotTiles } from './level';
import { UNREACHABLE, computeFields, fieldAt, tileIndex } from './flowfield';
import type { Congestion } from './flowfield';
import type { Game, Grid, LaneSlot, Passenger, ShopSlot, Vec } from './types';

const STEP_NEIGHBORS: readonly Vec[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function createGame(grid: Grid, slots: LaneSlot[], shops: ShopSlot[]): Game {
  return {
    time: 0,
    speed: 1,
    paused: false,
    money: balance.startingMoney,
    spawnTimer: 1,
    nextId: 1,
    passengers: [],
    occupancy: new Map(),
    grid,
    slots,
    shops,
    fields: computeFields(grid, slots, shops),
    stats: { served: 0, walkOffs: 0, turnedAway: 0, satisfactionSum: 0 },
    laneAssigned: slots.map(() => 0),
    pops: [],
    pending: [],
    waveActive: null,
    waveCohorts: new Map(),
    waveReport: null,
    failed: false,
    failReason: null,
  };
}

/** Credit an outcome to the wave the passenger arrived in (calm-born: no wave). */
function creditWave(game: Game, waveBorn: number | null, outcome: 'served' | 'lost'): void {
  if (waveBorn === null) return;
  const cohort = game.waveCohorts.get(waveBorn);
  if (cohort) cohort[outcome]++;
}

/**
 * Wave bookkeeping, cohort-style: a wave's report counts everyone who ARRIVED
 * during it, however long their outcome takes to land (the drain after the bell
 * is part of the wave). A report finalizes when its cohort fully resolves, or
 * at the next wave's start, whichever comes first.
 */
function trackWaves(game: Game): void {
  const wave = currentWave(game.time);
  if (wave !== game.waveActive) {
    if (wave !== null && !game.waveCohorts.has(wave)) {
      game.waveCohorts.set(wave, { arrivals: 0, served: 0, lost: 0, bankAtStart: game.money });
    }
    // Fail condition 1: ending a wave in the red is bankruptcy — day over.
    if (game.waveActive !== null && game.money < 0) {
      game.failed = true;
      game.failReason = 'bankrupt';
    }
    game.waveActive = wave;
  }
  for (const [index, cohort] of game.waveCohorts) {
    if (index === game.waveActive) continue;
    const nextStarted = game.waveActive !== null && game.waveActive > index;
    if (cohort.served + cohort.lost >= cohort.arrivals || nextStarted) {
      game.waveReport = {
        index,
        served: cohort.served,
        lost: cohort.lost,
        money: Math.round(game.money - cohort.bankAtStart),
        endedAt: game.time,
      };
      game.waveCohorts.delete(index);
      // The drain is part of the wave: a bank still in the red when the wave's
      // cohort settles is bankruptcy too, not a "survived" card.
      if (game.money < 0) {
        game.failed = true;
        game.failReason = 'bankrupt';
      }
      // Fail condition 2: SERVICE failure. Mall income can keep a hemorrhaging
      // checkpoint solvent (shoppers spend before they storm), so money alone
      // can't punish chronic walk-offs — but the authority can. Lose too much
      // of one wave's cohort and the airport shuts the checkpoint down.
      if (
        cohort.lost >= balance.lossFailMin &&
        cohort.lost > balance.maxLossShare * cohort.arrivals
      ) {
        game.failed = true;
        game.failReason = 'walkout';
      }
    }
  }
}

function pendingAt(game: Game, tile: Vec): number {
  return game.pending.findIndex((b) => b.tile.x === tile.x && b.tile.y === tile.y);
}

/** Materialize paid-for builds whose tile has cleared (runs every update). */
function settlePendingBuilds(game: Game): void {
  if (game.pending.length === 0) return;
  const ready: number[] = [];
  for (const [idx, b] of game.pending.entries()) {
    const i = tileIndex(game.grid, b.tile);
    const expected = b.kind === 'gateShut' ? 'gateOpen' : 'floor';
    if (game.grid.tiles[i] !== expected) {
      ready.push(idx); // tile became something else; drop (rope builds get refunds)
      if (b.kind === 'rope') game.money += balance.fenceCost;
      continue;
    }
    if (isOccupied(game, b.tile)) continue;
    game.grid.tiles[i] = b.kind === 'rope' ? 'rope' : 'gateClosed';
    ready.push(idx);
  }
  if (ready.length > 0) {
    game.pending = game.pending.filter((_, idx) => !ready.includes(idx));
    refreshRouting(game);
  }
}

const POP_LIFETIME = 1.4;

/** Earn or lose money with a floating indicator at the given tile. */
function transact(game: Game, amount: number, at: Vec): void {
  game.money += amount;
  game.pops.push({ amount, x: at.x, y: at.y, age: 0 });
}

/** Conservation law: every lost passenger (storm, sealed-in, turn-away) costs the same. */
function chargeLoss(game: Game, at: Vec): void {
  transact(game, -balance.lossCost, at);
}

// --- Occupancy chokepoint: the only writers of game.occupancy. ---------------

function occupy(game: Game, tile: Vec, id: number): void {
  game.occupancy.set(tileIndex(game.grid, tile), id);
}

function vacate(game: Game, tile: Vec): void {
  game.occupancy.delete(tileIndex(game.grid, tile));
}

export function isOccupied(game: Game, tile: Vec): boolean {
  return game.occupancy.has(tileIndex(game.grid, tile));
}

/** Free every tile a passenger holds (current tile, plus reservation mid-step). */
function releaseTiles(game: Game, p: Passenger): void {
  vacate(game, p.tile);
  if (p.step.kind === 'stepping') {
    vacate(game, p.step.from);
    vacate(game, p.step.to);
  }
}

// --- Player resources ----------------------------------------------------------

/** Slots counting toward the checkpoint budget (a draining lane still owns its slot). */
export function checkpointsInUse(game: Game): number {
  return game.slots.filter((s) => s.state !== 'closed').length;
}

/**
 * Capacity is the escape hatch: each ADDITIONAL lane costs more than the last
 * (fee × curve^(lanes already open − 1)).
 */
export function laneOpenCost(game: Game): number {
  const open = Math.max(1, checkpointsInUse(game));
  return Math.round(balance.checkpointFee * Math.pow(balance.laneFeeCurve, open - 1));
}

function openCheckpoints(game: Game): number {
  return game.slots.filter((s) => s.state === 'open').length;
}

// --- Layout editing -------------------------------------------------------------

function inBuildable(tile: Vec): boolean {
  return (
    tile.x >= BUILDABLE.x0 &&
    tile.x <= BUILDABLE.x1 &&
    tile.y >= BUILDABLE.y0 &&
    tile.y <= BUILDABLE.y1
  );
}

function isActiveServiceTile(game: Game, tile: Vec): boolean {
  return game.slots.some(
    (s) => s.state !== 'closed' && tile.x === serviceTile(s.y).x && tile.y === s.y,
  );
}

/**
 * Per-tile occupant grain for directional congestion pricing. Movers stamp
 * their travel direction on both reserved tiles; parked bodies (mid-scan,
 * mid-browse) stamp their EXACT remaining park time (it's in their phase);
 * idle queuers stamp their intent (own field's downhill direction) so a
 * healthy line reads as cheap-to-follow; intentless idlers price mid-range.
 */
function buildCongestion(game: Game): Congestion {
  const n = game.grid.cols * game.grid.rows;
  const pen = new Float64Array(n);
  const gx = new Int8Array(n);
  const gy = new Int8Array(n);
  const stepTime = 1 / tuning.walkSpeed;
  const stamp = (t: Vec, dx: number, dy: number, cost: number): void => {
    const i = tileIndex(game.grid, t);
    pen[i] = cost;
    gx[i] = dx;
    gy[i] = dy;
  };
  for (const p of game.passengers) {
    if (p.step.kind === 'stepping') {
      const dx = Math.sign(p.step.to.x - p.step.from.x);
      const dy = Math.sign(p.step.to.y - p.step.from.y);
      stamp(p.step.from, dx, dy, tuning.occupantCost);
      stamp(p.step.to, dx, dy, tuning.occupantCost);
      continue;
    }
    if (p.phase.kind === 'processing' || p.phase.kind === 'shopping') {
      const park = Math.min(
        tuning.parkedMax,
        Math.max(tuning.parkedMin, p.phase.remaining / stepTime),
      );
      stamp(p.tile, 0, 0, tuning.occupantCost * park);
      continue;
    }
    // Idle: intent = own field's downhill neighbor, if any.
    const field = targetField(game, p);
    let dx = 0;
    let dy = 0;
    if (field) {
      const here = fieldAt(field, tileIndex(game.grid, p.tile));
      let bd = here;
      for (const nb of STEP_NEIGHBORS) {
        const c = { x: p.tile.x + nb.x, y: p.tile.y + nb.y };
        if (!inBounds(game.grid, c)) continue;
        const d = fieldAt(field, tileIndex(game.grid, c));
        if (d !== UNREACHABLE && d < bd) {
          bd = d;
          dx = nb.x;
          dy = nb.y;
        }
      }
    }
    if (dx !== 0 || dy !== 0) stamp(p.tile, dx, dy, tuning.occupantCost);
    else stamp(p.tile, 0, 0, tuning.occupantCost * tuning.idleBlock);
  }
  // EMA-blend with the previous snapshot: oscillating route equilibria decay
  // geometrically instead of flipping (and ghost costs linger where someone
  // just stood, damping the next flap before it starts).
  const prev = prevCongestion.get(game);
  if (prev && prev.length === pen.length) {
    const a = tuning.congestionBlend;
    for (let i = 0; i < pen.length; i++) {
      pen[i] = a * (pen[i] ?? 0) + (1 - a) * (prev[i] ?? 0);
    }
  }
  prevCongestion.set(game, Float64Array.from(pen));
  return { pen, gx, gy };
}

/** Previous congestion magnitudes per game, for the EMA blend above. */
const prevCongestion = new WeakMap<Game, Float64Array>();

/** Recompute routing after any layout change, then fix up stranded passengers. */
function refreshRouting(game: Game): void {
  game.fields = computeFields(game.grid, game.slots, game.shops, buildCongestion(game));
  reassignStrandedPassengers(game);
}

export function placeFence(game: Game, tile: Vec): boolean {
  if (!inBuildable(tile) || isActiveServiceTile(game, tile)) return false;
  const i = tileIndex(game.grid, tile);
  if (pendingAt(game, tile) >= 0) return false;
  const kind = game.grid.tiles[i];
  // Swap-in-place: building a fence over a gate sells the gate first.
  const refund = kind === 'gateOpen' || kind === 'gateClosed' ? balance.gateCost : 0;
  if (kind !== 'floor' && refund === 0) return false;
  if (game.money + refund < balance.fenceCost) return false;
  game.money += refund - balance.fenceCost;
  if (refund > 0) game.grid.tiles[i] = 'floor'; // the gate is sold either way
  if (isOccupied(game, tile)) {
    // Paid and queued: the fence materializes once the square clears (an open
    // gate may have someone standing on it — never wall them in).
    game.pending.push({ tile: { ...tile }, kind: 'rope' });
    if (refund > 0) refreshRouting(game);
    return true;
  }
  game.grid.tiles[i] = 'rope';
  refreshRouting(game);
  return true;
}

/**
 * Place a gate (retractable belt), CLOSED by default — a freshly bought gate is
 * a barrier, like the fence it resembles; opening it is the deliberate act.
 * Placing under a passenger lands the gate OPEN with a pending shut (the belt
 * drops into the first gap in the stream, same as toggling an occupied gate).
 */
export function placeGate(game: Game, tile: Vec): boolean {
  if (!inBuildable(tile) || isActiveServiceTile(game, tile)) return false;
  const i = tileIndex(game.grid, tile);
  if (pendingAt(game, tile) >= 0) return false;
  const kind = game.grid.tiles[i];
  // Swap-in-place: building a gate over a fence sells the fence first.
  const refund = kind === 'rope' ? balance.fenceCost : 0;
  if (kind !== 'floor' && refund === 0) return false;
  if (game.money + refund < balance.gateCost) return false;
  game.money += refund - balance.gateCost;
  if (isOccupied(game, tile)) {
    game.grid.tiles[i] = 'gateOpen';
    game.pending.push({ tile: { ...tile }, kind: 'gateShut' });
  } else {
    game.grid.tiles[i] = 'gateClosed';
  }
  refreshRouting(game);
  return true;
}

export type GateToggleResult = 'opened' | 'closing' | 'closed' | 'rejected';

/**
 * Toggle a gate, free — the live-mazing valve. Closing an occupied gate goes
 * PENDING: the tile becomes unclaimable, the occupant walks off, the belt drops
 * into the first gap in the stream. Opening also cancels a pending shut.
 */
export function toggleGate(game: Game, tile: Vec): GateToggleResult {
  const i = tileIndex(game.grid, tile);
  const kind = game.grid.tiles[i];
  if (kind === 'gateClosed') {
    game.grid.tiles[i] = 'gateOpen';
    refreshRouting(game);
    return 'opened';
  }
  if (kind !== 'gateOpen') return 'rejected';
  const pending = pendingAt(game, tile);
  if (pending >= 0) {
    game.pending.splice(pending, 1); // un-shut: the belt was still waiting
    return 'opened';
  }
  if (isOccupied(game, tile)) {
    game.pending.push({ tile: { ...tile }, kind: 'gateShut' });
    return 'closing';
  }
  game.grid.tiles[i] = 'gateClosed';
  refreshRouting(game);
  return 'closed';
}

/** Erase a fence or gate (or a pending one); full cash refund. */
export function eraseAt(game: Game, tile: Vec): boolean {
  const pending = pendingAt(game, tile);
  if (pending >= 0) {
    const kind = game.pending[pending]?.kind;
    game.pending.splice(pending, 1);
    if (kind === 'gateShut') return true; // gate stays (open); just cancel the shut
    game.money += balance.fenceCost;
    return true;
  }
  const i = tileIndex(game.grid, tile);
  if (game.grid.tiles[i] === 'rope') {
    game.grid.tiles[i] = 'floor';
    game.money += balance.fenceCost;
    refreshRouting(game);
    return true;
  }
  if (game.grid.tiles[i] === 'gateOpen' || game.grid.tiles[i] === 'gateClosed') {
    game.grid.tiles[i] = 'floor';
    game.money += balance.gateCost;
    refreshRouting(game);
    return true;
  }
  return false;
}

export type ToggleResult = 'opened' | 'draining' | 'reopened' | 'rejected';

/**
 * Click cycle on a checkpoint slot: closed → (pay fee) open → (click) draining →
 * (click, free) open. Draining lanes close themselves once empty (see update()).
 */
export function toggleCheckpoint(game: Game, slotIndex: number): ToggleResult {
  const slot = game.slots[slotIndex];
  if (!slot) return 'rejected';

  switch (slot.state) {
    case 'open': {
      if (openCheckpoints(game) <= 1) return 'rejected';
      slot.state = 'draining';
      // Field drops to null, so queued passengers reassign immediately.
      refreshRouting(game);
      return 'draining';
    }
    case 'draining':
      slot.state = 'open';
      refreshRouting(game);
      return 'reopened';
    case 'closed': {
      if (checkpointsInUse(game) >= CHECKPOINTS_TOTAL) return 'rejected';
      const fee = laneOpenCost(game);
      if (game.money < fee) return 'rejected';
      // Reclaim any fence/gate sitting on the service tile (cash refunds).
      const si = tileIndex(game.grid, serviceTile(slot.y));
      if (game.grid.tiles[si] === 'rope') {
        game.grid.tiles[si] = 'floor';
        game.money += balance.fenceCost;
      } else if (game.grid.tiles[si] === 'gateOpen' || game.grid.tiles[si] === 'gateClosed') {
        game.grid.tiles[si] = 'floor';
        game.money += balance.gateCost;
      }
      game.money -= fee;
      slot.state = 'open';
      applySlotTiles(game.grid, slot);
      refreshRouting(game);
      return 'opened';
    }
  }
}

/** Close any draining lane that has finished its last passenger; pay the refund. */
function settleDrainingSlots(game: Game): void {
  for (const [i, slot] of game.slots.entries()) {
    if (slot.state !== 'draining') continue;
    const busy = game.passengers.some(
      (p) => p.lane === i && (p.phase.kind === 'processing' || p.phase.kind === 'exiting'),
    );
    if (busy) continue;
    slot.state = 'closed';
    game.money += laneRefund(slot.level);
    slot.level = 0;
    applySlotTiles(game.grid, slot);
    refreshRouting(game);
  }
}

/** Pay for the next checkpoint level; open lanes only. */
export function upgradeCheckpoint(game: Game, slotIndex: number): boolean {
  const slot = game.slots[slotIndex];
  if (!slot || slot.state !== 'open' || slot.level >= MAX_LEVEL) return false;
  const cost = laneUpgradeCost(slot.level);
  if (game.money < cost) return false;
  game.money -= cost;
  slot.level++;
  return true;
}

/** Pay for the next shop level: more relief, stronger perk, +1 counter. */
export function upgradeShop(game: Game, shopIndex: number): boolean {
  const shop = game.shops[shopIndex];
  if (!shop || !shop.built || shop.level >= MAX_LEVEL) return false;
  const cost = shopUpgradeCost(shop.tier, shop.level);
  if (game.money < cost) return false;
  game.money -= cost;
  shop.level++;
  // The new counter opens a footprint tile and changes the shop flow field.
  applyShopTiles(game.grid, shop);
  refreshRouting(game);
  return true;
}

export type ShopToggleResult = 'built' | 'sold' | 'rejected';

/** Build or sell the shop at a fixed slot. Selling pays 50% back, like checkpoints. */
export function toggleShop(game: Game, shopIndex: number): ShopToggleResult {
  const shop = game.shops[shopIndex];
  if (!shop) return 'rejected';
  if (shop.built) {
    shop.built = false;
    game.money += shopRefund(shop.tier, shop.level);
    shop.level = 0;
    applyShopTiles(game.grid, shop);
    // Anyone mid-visit or en route loses the trip (no relief); plans drop the slot.
    for (const p of game.passengers) {
      p.shopPlan = p.shopPlan.filter((i) => i !== shopIndex);
      if (p.shopTarget === shopIndex) {
        if (p.phase.kind === 'shopping') p.phase = { kind: 'queueing' };
        advanceShopPlan(game, p);
      }
    }
    refreshRouting(game);
    return 'sold';
  }

  // Construction clears the lot: fences, gates, and pending builds inside the
  // footprint are SOLD (full refund) as part of the purchase — there is no
  // "blocked, clear it first" state. The building then lands inside any
  // channel wall it overlapped and serves as wall mass itself. The refund
  // counts toward affordability (it arrives in the same transaction).
  let lotRefund = 0;
  for (let dx = 0; dx < shop.rect.w; dx++) {
    for (let dy = 0; dy < shop.rect.h; dy++) {
      const t = { x: shop.rect.x + dx, y: shop.rect.y + dy };
      if (isOccupied(game, t)) return 'rejected';
      const kind = game.grid.tiles[tileIndex(game.grid, t)];
      if (kind === 'rope') lotRefund += balance.fenceCost;
      else if (kind === 'gateOpen' || kind === 'gateClosed') lotRefund += balance.gateCost;
      else if (game.pending[pendingAt(game, t)]?.kind === 'rope') lotRefund += balance.fenceCost;
    }
  }
  if (game.money + lotRefund < shopCost(shop.tier)) return 'rejected';
  for (let dx = 0; dx < shop.rect.w; dx++) {
    for (let dy = 0; dy < shop.rect.h; dy++) {
      // Twice-erasable tiles exist (a pending gate-shut over an open gate).
      while (eraseAt(game, { x: shop.rect.x + dx, y: shop.rect.y + dy })) {
        /* cleared */
      }
    }
  }
  game.money -= shopCost(shop.tier);
  shop.built = true;
  applyShopTiles(game.grid, shop);
  refreshRouting(game);
  return 'built';
}

/** After a layout change, move passengers whose lane became unreachable or inactive. */
function reassignStrandedPassengers(game: Game): void {
  for (const p of game.passengers) {
    if (p.phase.kind !== 'queueing') continue;
    const here = tileIndex(game.grid, p.tile);
    if (p.shopTarget !== null) {
      const shopField = game.fields.shops[p.shopTarget];
      if (!shopField || fieldAt(shopField, here) === UNREACHABLE) advanceShopPlan(game, p);
    }
    const field = game.fields.lanes[p.lane];
    if (field && fieldAt(field, here) !== UNREACHABLE) continue;
    const next = pickLane(game, p.tile);
    if (next === p.lane) continue;
    game.laneAssigned[p.lane] = (game.laneAssigned[p.lane] ?? 1) - 1;
    game.laneAssigned[next] = (game.laneAssigned[next] ?? 0) + 1;
    p.lane = next;
    p.prepped = false;
  }
}

// --- Per-frame update ----------------------------------------------------------

export const MAX_SUBSTEP = 1 / 30;

/**
 * Advance the sim by `seconds`, sub-stepped to MAX_SUBSTEP. The ONLY integration
 * entry point — the browser loop and the headless harness both call this, so the
 * two can never drift apart in timestep behavior.
 */
export function stepGame(game: Game, seconds: number): void {
  if (game.failed) return; // bankrupt: the day is over, the floor freezes
  let remaining = seconds;
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_SUBSTEP);
    update(game, step);
    remaining -= step;
  }
}

/** Congestion is occupancy-derived, so fields refresh on a clock too (1 Hz),
 * not only on layout edits. WeakMap: harnesses run many Games per process. */
const routeClock = new WeakMap<Game, number>();

function update(game: Game, dt: number): void {
  game.time += dt;
  passengerIndex.set(game, new Map(game.passengers.map((q) => [q.id, q])));
  const clock = (routeClock.get(game) ?? 0) + dt;
  if (clock >= tuning.routeRefresh) {
    routeClock.set(game, 0);
    refreshRouting(game);
  } else {
    routeClock.set(game, clock);
  }
  trackWaves(game);
  updateSpawning(game, dt);
  updatePrep(game);

  const removedIds = new Set<number>();
  for (const p of game.passengers) updatePassenger(game, p, dt, removedIds);
  if (removedIds.size > 0) {
    game.passengers = game.passengers.filter((p) => !removedIds.has(p.id));
  }
  settleDrainingSlots(game);
  settlePendingBuilds(game);

  for (const pop of game.pops) pop.age += dt;
  if (game.pops.some((pop) => pop.age > POP_LIFETIME)) {
    game.pops = game.pops.filter((pop) => pop.age <= POP_LIFETIME);
  }
}

function updateSpawning(game: Game, dt: number): void {
  game.spawnTimer -= dt;
  if (game.spawnTimer > 0) return;
  const free = SPAWN_TILES.filter((t) => !isOccupied(game, t));
  const tile = free[Math.floor(Math.random() * free.length)];
  if (!tile) {
    // Lobby is jammed: this arrival walks off to another terminal. Charging it like
    // a storm-off closes the "fence the entrance to throttle arrivals" loophole.
    game.stats.turnedAway++;
    creditWave(game, game.waveActive, 'lost'); // an arrival of the current wave
    chargeLoss(game, {
      x: 1,
      y: Math.round((SPAWN_TILES.length - 1) / 2) + (SPAWN_TILES[0]?.y ?? 4),
    });
    game.spawnTimer = nextSpawnInterval(game.time, Math.random());
    return;
  }
  const lane = pickLane(game, tile);
  const p: Passenger = {
    id: game.nextId++,
    tile: { ...tile },
    step: { kind: 'idle' },
    phase: { kind: 'queueing' },
    lane,
    frustration: 0,
    spriteIndex: game.nextId,
    walkPhase: 0,
    moveGrace: tuning.moveGrace,
    prevTile: null,
    laneCheck: LANE_RECHECK + (game.nextId % 10) * 0.1,
    shopTarget: null,
    shopWait: 0,
    shopPlan: rollShopPlan(game, tile),
    speedMult: 1 - tuning.walkSpeedSpread + Math.random() * 2 * tuning.walkSpeedSpread,
    stillMult: 1,
    serviceMult: 1,
    zenSaves: 0,
    blockedTime: 0,
    prepped: false,
    crowded: false,
    waveBorn: game.waveActive,
    wanderDir: null,
    wanderSteps: 0,
    vip: false,
  };
  if (game.waveActive !== null) {
    const cohort = game.waveCohorts.get(game.waveActive);
    if (cohort) {
      cohort.arrivals++;
      // The FIRST arrival of every wave is its VIP: serve them for a bonus that
      // scales with the wave (forfeited if they storm off — a carrot, not a
      // fail condition). Leading the wave makes them visible and shepherdable.
      if (cohort.arrivals === 1) p.vip = true;
    }
  }
  advanceShopPlan(game, p); // first errand becomes the active target
  occupy(game, p.tile, p.id);
  game.passengers.push(p);
  game.laneAssigned[lane] = (game.laneAssigned[lane] ?? 0) + 1;
  game.spawnTimer = nextSpawnInterval(game.time, Math.random());
}

/** How many passengers are currently headed to (or being served at) a shop. */
function shopBound(game: Game, shopIndex: number): number {
  let count = 0;
  for (const p of game.passengers) if (p.shopTarget === shopIndex) count++;
  return count;
}

/** A shop reads as "too busy, never mind" when its queue is ~3x its counters. */
const SHOP_BUSY_FACTOR = 3;
/** Camped beside a full counter this long without moving → drop the errand.
 * Just over one dwell cycle, so the next-in-line shopper doesn't bail moments
 * before a seat frees, but a real knot dissolves before it crowds the floor. */
const SHOP_GIVE_UP_AFTER = 4;

/**
 * INDEPENDENT roll per built shop: a passenger may plan several errands, or none.
 * Multi-errand itineraries are rate shaping — errands stagger lane arrivals,
 * spread the crowd across the floor, and stack perks — at the price of time.
 * Slammed or unreachable shops are skipped (a visit happens at most once: a shop
 * leaves the plan the moment it becomes the active target).
 */
function rollShopPlan(game: Game, tile: Vec): number[] {
  const plan: number[] = [];
  for (const [i, shop] of game.shops.entries()) {
    if (!shop.built) continue;
    const field = game.fields.shops[i];
    if (!field || fieldAt(field, tileIndex(game.grid, tile)) === UNREACHABLE) continue;
    if (shopBound(game, i) >= activeVisits(shop).length * SHOP_BUSY_FACTOR) continue;
    const chance = balance.shopVisitChance + shop.level * balance.shopVisitLevelBonus;
    if (Math.random() < chance) plan.push(i);
  }
  return plan;
}

/**
 * Pick the next errand: the NEAREST remaining planned shop that is still built,
 * reachable, and not slammed. Shops that fail those checks are dropped for good
 * ("too busy, never mind" — shop queues must never bottleneck the hall).
 */
function advanceShopPlan(game: Game, p: Passenger): void {
  let best: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const keep: number[] = [];
  for (const i of p.shopPlan) {
    const shop = game.shops[i];
    const field = game.fields.shops[i];
    if (!shop?.built || !field) continue;
    const d = fieldAt(field, tileIndex(game.grid, p.tile));
    if (d === UNREACHABLE) continue;
    if (shopBound(game, i) >= activeVisits(shop).length * SHOP_BUSY_FACTOR) continue;
    keep.push(i);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  p.shopPlan = keep.filter((i) => i !== best);
  p.shopTarget = best;
}

/** Re-pick cadence in seconds, and the cost edge required to actually switch. */
const LANE_RECHECK = 1;
const LANE_SWITCH_HYSTERESIS = 8;
/** You can only judge which lane is freest from near the front of the hall. */
const DISPATCH_SIGHT = 8;

function laneCost(game: Game, lane: number, tile: Vec): number {
  const field = game.fields.lanes[lane];
  if (!field) return Number.POSITIVE_INFINITY;
  const d = fieldAt(field, tileIndex(game.grid, tile));
  if (d === UNREACHABLE) return Number.POSITIVE_INFINITY;
  return d + (game.laneAssigned[lane] ?? 0) * QUEUE_WEIGHT;
}

function pickLane(game: Game, tile: Vec): number {
  let best = game.slots.findIndex((s) => s.state === 'open');
  if (best < 0) best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let i = 0; i < game.slots.length; i++) {
    const cost = laneCost(game, i, tile);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

/**
 * Bank-queue dispatch: passengers near the front periodically reconsider their
 * lane so the head of a queue peels off to whichever checkpoint is freest. The
 * sight limit keeps the back of the hall dumb (you can't judge lane states from
 * 20 tiles away — that information asymmetry is why guidance layouts matter), and
 * hysteresis keeps mid-queue passengers from ping-ponging between equal lanes.
 */
function reconsiderLane(game: Game, p: Passenger): void {
  const field = game.fields.lanes[p.lane];
  // Sight is GEOMETRIC (Manhattan tiles), not congested path cost — congestion
  // prices walking, not eyesight. You act on a lane you can see: near your own
  // front, or near the candidate itself (e.g. a fresh gap opened beside you).
  const sees = (lane: number): boolean => {
    const slot = game.slots[lane];
    if (!slot) return false;
    const s = serviceTile(slot.y);
    return Math.abs(s.x - p.tile.x) + Math.abs(s.y - p.tile.y) <= DISPATCH_SIGHT;
  };
  // Your own lane's cost counts only the people AHEAD of you — those behind
  // don't delay you. (Candidate lanes keep their total count: joining means
  // joining the BACK.) Without this, a 10-deep line charges its own members
  // +6×10 while a fresh checkpoint charges 0, and half the line defects the
  // moment one opens (line collapse).
  if (!field) return;
  const myD = fieldAt(field, tileIndex(game.grid, p.tile));
  let ahead = 0;
  for (const q of game.passengers) {
    if (q.id === p.id || q.lane !== p.lane) continue;
    if (q.phase.kind !== 'queueing' && q.phase.kind !== 'processing') continue;
    const qd = q.phase.kind === 'processing' ? 0 : fieldAt(field, tileIndex(game.grid, q.tile));
    if (qd !== UNREACHABLE && qd < myD) ahead++;
  }
  const current = myD + QUEUE_WEIGHT * ahead;
  const best = pickLane(game, p.tile);
  if (best === p.lane) return;
  if (!sees(p.lane) && !sees(best)) return;
  if (laneCost(game, best, p.tile) + LANE_SWITCH_HYSTERESIS >= current) return;
  // Friction check: laneCost prices the new path as empty-floor walking, but
  // deep in a line the only way out is BACKWARD THROUGH BODIES — a path whose
  // true cost is enormous, not low. A switch is only real if a free,
  // strictly-closer first step toward the new lane exists right now: the tail
  // of a queue may peel off, the boxed-in middle stays put, and an open-floor
  // blob defects as a peeling wave from its edge instead of all at once.
  const candidateField = game.fields.lanes[best];
  if (!candidateField || !chooseStep(game, p, candidateField, false)) return;
  game.laneAssigned[p.lane] = (game.laneAssigned[p.lane] ?? 1) - 1;
  game.laneAssigned[best] = (game.laneAssigned[best] ?? 0) + 1;
  p.lane = best;
  p.prepped = false; // re-packing on the move: a reroute throws the prep away
}

function updatePassenger(game: Game, p: Passenger, dt: number, removedIds: Set<number>): void {
  switch (p.phase.kind) {
    case 'queueing':
      updateQueueing(game, p, dt);
      break;
    case 'processing':
      updateProcessing(game, p, dt);
      break;
    case 'shopping':
      updateShopping(game, p, dt);
      break;
    case 'exiting':
      updateExiting(p, dt, removedIds);
      break;
    case 'storming':
      updateStorming(game, p, dt, removedIds);
      break;
  }
}

const MOORE_NEIGHBORS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Per-substep id→passenger index for crowd checks (rebuilt each update). */
const passengerIndex = new WeakMap<Game, Map<number, Passenger>>();

/**
 * DISORDER count: bodies in the 3×3 box that are NOT part of this passenger's
 * ordered flow. Flow-mates — same target, DISTINCT rank on the shared field —
 * net out entirely, so a single-file line is calm at any bend tightness; so do
 * mid-step crossers (transient background). What counts: same-ring competitors
 * racing you for the next tile, and standing strangers camped in your space.
 * Tolerance is zero (balance.crowdLimit): rope buys unambiguous ORDERING, not
 * raw space — that is the fence's entire value.
 */
function crowdCount(game: Game, p: Passenger): number {
  const byId = passengerIndex.get(game);
  const myField = targetField(game, p);
  const myD = myField ? fieldAt(myField, tileIndex(game.grid, p.tile)) : UNREACHABLE;
  const ids = new Set<number>();
  let stress = 0;
  for (const [dx, dy] of MOORE_NEIGHBORS) {
    const at = { x: p.tile.x + dx, y: p.tile.y + dy };
    if (!inBounds(game.grid, at)) continue;
    const id = game.occupancy.get(tileIndex(game.grid, at));
    if (id === undefined || id === p.id || ids.has(id)) continue;
    ids.add(id);
    const q = byId?.get(id);
    if (!q) continue;
    if (q.step.kind === 'stepping') continue; // moving crosser: gone in half a second
    const sameTarget =
      q.phase.kind === 'processing'
        ? p.shopTarget === null && q.lane === p.lane
        : q.phase.kind === 'queueing' &&
          q.shopTarget === p.shopTarget &&
          (p.shopTarget !== null || q.lane === p.lane);
    if (sameTarget && myField && myD !== UNREACHABLE) {
      const qd = q.phase.kind === 'processing' ? 0 : fieldAt(myField, tileIndex(game.grid, q.tile));
      if (qd !== UNREACHABLE && Math.abs(qd - myD) >= 0.75) continue; // flow-mate
    }
    stress++;
  }
  return stress;
}

/**
 * Anxious pacing for the sealed-in: walk 2-6 tiles in one direction, then pick
 * a new one (no per-tile dithering). Purely so trapped sprites read as alive —
 * pacing accrues at the STANDING rate, so walling people in is never a calm
 * warehouse; they still boil over and storm.
 */
/**
 * Standing somewhere outside the routing field (e.g. a shop counter after the
 * errand, with the lane field walled off there): step off toward the nearest
 * in-field neighbor. Returns false if no reachable neighbor exists.
 */
function escapeStep(game: Game, p: Passenger, field: Float64Array): boolean {
  let best: Vec | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const n of STEP_NEIGHBORS) {
    const to = { x: p.tile.x + n.x, y: p.tile.y + n.y };
    if (!inBounds(game.grid, to)) continue;
    const d = fieldAt(field, tileIndex(game.grid, to));
    if (d === UNREACHABLE || d >= bestD) continue;
    if (isOccupied(game, to) || pendingAt(game, to) >= 0) continue;
    best = to;
    bestD = d;
  }
  if (!best) return false;
  occupy(game, best, p.id);
  p.step = { kind: 'stepping', from: p.tile, to: best, progress: 0 };
  p.blockedTime = 0;
  return true;
}

function wanderStep(game: Game, p: Passenger): void {
  const open = (d: Vec): boolean => {
    const to = { x: p.tile.x + d.x, y: p.tile.y + d.y };
    if (!inBounds(game.grid, to)) return false;
    const i = tileIndex(game.grid, to);
    const kind = game.grid.tiles[i];
    if (kind !== 'floor' && kind !== 'gateOpen') return false;
    if (game.fields.counters.has(i)) return false; // patron-only tiles
    return !isOccupied(game, to) && pendingAt(game, to) < 0;
  };
  if (!p.wanderDir || p.wanderSteps <= 0 || !open(p.wanderDir)) {
    const options = STEP_NEIGHBORS.filter(open);
    p.wanderDir = options[Math.floor(Math.random() * options.length)] ?? null;
    p.wanderSteps = 2 + Math.floor(Math.random() * 5);
    if (!p.wanderDir) return; // completely boxed in: stand
  }
  const to = { x: p.tile.x + p.wanderDir.x, y: p.tile.y + p.wanderDir.y };
  occupy(game, to, p.id);
  p.step = { kind: 'stepping', from: p.tile, to, progress: 0 };
  p.wanderSteps--;
  p.blockedTime = 0;
}

function updateQueueing(game: Game, p: Passenger, dt: number): void {
  advanceStep(game, p, dt);
  if (p.step.kind === 'stepping') p.shopWait = 0; // any movement resets the camp timer

  p.laneCheck -= dt;
  if (p.laneCheck <= 0) {
    p.laneCheck = LANE_RECHECK;
    if (p.shopTarget === null) {
      reconsiderLane(game, p);
    } else {
      // Shops never bottleneck: if the queue outgrew the counters, shrug and move
      // on to the next errand (or the lane).
      const shop = game.shops[p.shopTarget];
      if (shop && shopBound(game, p.shopTarget) > activeVisits(shop).length + 1) {
        advanceShopPlan(game, p);
      }
    }
  }

  if (p.step.kind === 'idle') {
    const shop = p.shopTarget !== null ? game.shops[p.shopTarget] : undefined;
    if (shop?.built && activeVisits(shop).some((v) => v.x === p.tile.x && v.y === p.tile.y)) {
      const dwell = SHOP_TIERS[shop.tier].dwell * balance.shopDwellScale;
      p.phase = { kind: 'shopping', remaining: dwell, total: dwell };
      return;
    }
    const slot = game.slots[p.lane];
    if (
      p.shopTarget === null &&
      slot?.state === 'open' &&
      p.tile.x === serviceTile(slot.y).x &&
      p.tile.y === slot.y
    ) {
      const total = sampleServiceTime(slot.level, p);
      p.phase = { kind: 'processing', remaining: total, total };
      p.frustration = Math.max(0, p.frustration - PROGRESS_RELIEF);
      return;
    }
    // Graceful "never mind": camped motionless beside a full counter, a shopper
    // drops the errand and gets on with their day. Nearly penalty-free for the
    // shopper (errand time accrues at the calm rate) — the give-up exists for
    // everyone ELSE: a knot of idle bodies crowds the storefront.
    if (p.shopTarget !== null) {
      // Geometric "beside the storefront" test: seat-aware fields price a taken
      // counter by its patron's remaining time, so field distance doesn't
      // count tiles — adjacency does.
      const shop = game.shops[p.shopTarget];
      const camped =
        !!shop?.built &&
        activeVisits(shop).some(
          (v) =>
            !(v.x === p.tile.x && v.y === p.tile.y) &&
            Math.abs(v.x - p.tile.x) + Math.abs(v.y - p.tile.y) <= 2,
        );
      if (camped) {
        p.shopWait += dt;
        if (p.shopWait > SHOP_GIVE_UP_AFTER) {
          advanceShopPlan(game, p);
          p.shopWait = 0;
        }
      } else {
        p.shopWait = 0;
      }
    }
    const field =
      p.shopTarget !== null ? game.fields.shops[p.shopTarget] : game.fields.lanes[p.lane];
    const reachable = !!field && fieldAt(field, tileIndex(game.grid, p.tile)) !== UNREACHABLE;
    if (field && reachable) {
      p.wanderDir = null; // a path exists: back to purposeful walking
      const targetShop = p.shopTarget !== null ? game.shops[p.shopTarget] : undefined;
      const slot = game.slots[p.lane];
      const goal = targetShop
        ? {
            x: targetShop.rect.x + Math.floor(targetShop.rect.w / 2),
            y: targetShop.rect.y + Math.floor(targetShop.rect.h / 2),
          }
        : slot
          ? serviceTile(slot.y)
          : null;
      const to = chooseStep(game, p, field, false, goal);
      if (to) {
        occupy(game, to, p.id);
        p.step = { kind: 'stepping', from: p.tile, to, progress: 0 };
        p.blockedTime = 0;
      } else if (wantsToMove(game, p, field)) {
        p.blockedTime += dt;
        // The anti-flap memory yields to genuine dead ends: blocked this long,
        // the back-step returns to the menu (a sealed corridor must caterpillar
        // back out, not freeze on its own one-step memory).
        if (p.blockedTime > CUT_AFTER_BLOCKED) p.prevTile = null;
        if (p.blockedTime > SWAP_AFTER_BLOCKED && trySwap(game, p, field)) {
          p.blockedTime = 0;
        } else if (p.blockedTime > CUT_AFTER_BLOCKED) {
          const cut = sideStep(game, p, field);
          if (cut) {
            occupy(game, cut, p.id);
            p.step = { kind: 'stepping', from: p.tile, to: cut, progress: 0 };
            p.blockedTime = 0;
          }
        }
      } else {
        p.blockedTime = 0;
      }
    } else if (!(field && p.step.kind === 'idle' && escapeStep(game, p, field))) {
      // Sealed in (no path to the target): pace anxiously — pick a direction,
      // walk a few tiles, turn. Pacing reads alive but earns no walking calm.
      // (escapeStep handles the off-field-but-adjacent case, e.g. counters.)
      wanderStep(game, p);
    }
  }

  // Each completed step buys moveGrace seconds at the walking rate.
  // A shop errand is "occupied time": passengers en route to (or queued at) a shop
  // they chose to visit accrue at the walking rate the whole way.
  const moving = p.step.kind === 'stepping';
  if (!moving || p.wanderDir) p.moveGrace = Math.max(0, p.moveGrace - dt);
  // Wander-pacing is NEVER calm: anxious laps around a sealed pen are standing
  // time (and leftover grace burns off while pacing, not during it).
  // Calm requires motion AND personal space. Braided pathing lets a greedy
  // crowd keep inching forward (everyone cutting into whatever gap opens), and
  // motion alone must not launder that crush into a polite queue: inching
  // forward in a crowd is still misery. A fenced single-file line caps the 3×3
  // box at 2 neighbors (the walls occupy the rest), so rope is what converts
  // motion into actual calm — that asymmetry is the fence's entire value.
  const crowd = Math.max(0, crowdCount(game, p) - balance.crowdLimit);
  const calm = crowd === 0 && !p.wanderDir && (moving || p.moveGrace > 0 || p.shopTarget !== null);
  p.crowded = crowd > 0;
  const standingRate = tuning.frustStill * p.stillMult * (1 + balance.crowdStress * crowd);
  p.frustration += (calm ? tuning.frustMoving : standingRate) * dt;
  if (p.frustration >= MAX_FRUSTRATION) {
    if (p.zenSaves > 0) {
      // Zen Lounge save: a deep breath instead of a walk-off.
      p.zenSaves--;
      p.frustration = balance.zenReset;
      return;
    }
    p.frustration = MAX_FRUSTRATION;
    // Stormers shove through the crowd: they hold no reservations from here on,
    // so they can always leave and never plug the queue.
    releaseTiles(game, p);
    p.phase = { kind: 'storming', timeout: STORM_TIMEOUT };
    game.laneAssigned[p.lane] = (game.laneAssigned[p.lane] ?? 1) - 1;
    game.stats.walkOffs++;
    creditWave(game, p.waveBorn, 'lost');
    chargeLoss(game, p.tile);
    applyStormShock(game, p);
  }
}

/**
 * Storm shockwave: "if SHE's giving up, this line is hopeless." Every waiting
 * passenger near a walk-off takes a frustration hit. A mob packs ~12 people in
 * the blast radius and cascades; a single-file line exposes only a few — one
 * more systemic reason the same backlog is survivable as line, lethal as crowd.
 */
function applyStormShock(game: Game, stormer: Passenger): void {
  const r = balance.stormShockRadius;
  for (const q of game.passengers) {
    if (q.id === stormer.id || q.phase.kind !== 'queueing') continue;
    if (Math.abs(q.tile.x - stormer.tile.x) > r || Math.abs(q.tile.y - stormer.tile.y) > r) {
      continue;
    }
    // Capped just below storming: a shock ALONE never triggers a walk-off; it
    // shortens the fuse so sustained crowding finishes the job (no chain crash
    // from a single event, but mobs under pressure unravel fast).
    q.frustration = Math.min(MAX_FRUSTRATION - 1, q.frustration + balance.stormShock);
  }
}

function sampleServiceTime(laneLevel: number, p: Passenger): number {
  const prep = p.prepped ? balance.prepSpeedup : 1;
  return (
    atLevel(balance.laneService, laneLevel) * (0.6 + Math.random() * 0.8) * p.serviceMult * prep
  );
}

/**
 * On-deck prep: while a scan is running, a SOLE queueing waiter in the 3x3 box
 * around the service tile uses the wait — shoes off, laptop out — and their own
 * scan will take prepSpeedup of the time. Two or more crowding the mouth and
 * nobody preps; a lane reroute throws the prep away (re-packing on the move).
 */
function updatePrep(game: Game): void {
  for (const slot of game.slots) {
    if (slot.state !== 'open') continue;
    const svc = serviceTile(slot.y);
    const occupant = game.passengers.find(
      (q) => q.phase.kind === 'processing' && q.tile.x === svc.x && q.tile.y === svc.y,
    );
    if (!occupant) continue;
    const waiters: Passenger[] = [];
    for (const q of game.passengers) {
      if (q.phase.kind !== 'queueing' || q.shopTarget !== null) continue;
      if (Math.abs(q.tile.x - svc.x) > 1 || Math.abs(q.tile.y - svc.y) > 1) continue;
      waiters.push(q);
    }
    const solo = waiters.length === 1 ? waiters[0] : undefined;
    if (solo && solo.step.kind === 'idle') solo.prepped = true;
  }
}

function updateProcessing(game: Game, p: Passenger, dt: number): void {
  if (p.phase.kind !== 'processing') return;
  p.phase.remaining -= dt;
  if (p.phase.remaining > 0) return;

  const slot = game.slots[p.lane];
  const satisfaction = Math.min(
    1,
    Math.max(0, (MAX_FRUSTRATION - p.frustration) / MAX_FRUSTRATION),
  );
  game.stats.served++;
  creditWave(game, p.waveBorn, 'served');
  game.stats.satisfactionSum += satisfaction * MAX_FRUSTRATION;
  transact(game, Math.round(balance.payoutBase + balance.payoutSatBonus * satisfaction), p.tile);
  // VIP bonus: a separate transaction so the golden serve pops on its own.
  if (p.vip && p.waveBorn !== null) {
    transact(game, balance.vipBonusPerWave * p.waveBorn, p.tile);
  }
  game.laneAssigned[p.lane] = (game.laneAssigned[p.lane] ?? 1) - 1;
  vacate(game, p.tile);
  p.phase = { kind: 'exiting', path: slot ? exitPath(slot.y) : [], index: 0 };
  p.step = { kind: 'idle' };
}

/** Browse, then bank patience: frustration may go negative (capped at -100). */
function updateShopping(game: Game, p: Passenger, dt: number): void {
  if (p.phase.kind !== 'shopping') return;
  p.phase.remaining -= dt;
  if (p.phase.remaining > 0) return;
  const shop = p.shopTarget !== null ? game.shops[p.shopTarget] : undefined;
  if (shop) {
    p.frustration = Math.max(-MAX_FRUSTRATION, p.frustration - shopRelief(shop.tier, shop.level));
    // Visitors SPEND: shop revenue is the budget curve for the late tech tree
    // (checkpoint payouts stay pinned). Cash-perk tips stack on top.
    transact(game, shopVisitRevenue(shop.tier, shop.level), p.tile);
    applyPerk(game, p, shop);
  }
  advanceShopPlan(game, p); // next errand, or off to the lane
  p.phase = { kind: 'queueing' };
}

/** Shop superpowers, scaled by the shop's level. */
function applyPerk(game: Game, p: Passenger, shop: ShopSlot): void {
  switch (shop.perk) {
    case 'caffeine':
      // Multiplies the innate speed rolled at spawn (a one-time boost: shop
      // visits happen at most once per passenger, ever). Caffeine sharpens the
      // scan too — alert patrons have their bins ready.
      p.speedMult *= atLevel(balance.perkCaffeine, shop.level);
      p.serviceMult *= atLevel(balance.perkCaffeineScan, shop.level);
      break;
    case 'reading':
      p.stillMult = atLevel(balance.perkReading, shop.level);
      break;
    case 'cash':
      transact(game, atLevel(balance.perkCash, shop.level), p.tile);
      break;
    case 'fastscan':
      p.serviceMult = atLevel(balance.perkFastscan, shop.level);
      break;
    case 'zen':
      p.zenSaves = atLevel(balance.perkZen, shop.level);
      break;
  }
}

/** Cosmetic walk through the scanner to the exit; holds no tile reservations. */
function updateExiting(p: Passenger, dt: number, removedIds: Set<number>): void {
  if (p.phase.kind !== 'exiting') return;
  if (p.step.kind === 'stepping') {
    if (advanceCosmeticStep(p, dt)) p.phase.index++;
    return;
  }
  const next = p.phase.path[p.phase.index];
  if (!next) {
    removedIds.add(p.id);
    return;
  }
  p.step = { kind: 'stepping', from: p.tile, to: { ...next }, progress: 0 };
}

function updateStorming(game: Game, p: Passenger, dt: number, removedIds: Set<number>): void {
  advanceCosmeticStep(p, dt);

  if (p.step.kind === 'idle') {
    const atDoor = p.tile.x === 1 && SPAWN_TILES.some((s) => s.y === p.tile.y);
    if (atDoor) {
      removedIds.add(p.id);
      return;
    }
    let to = chooseStep(game, p, game.fields.entrance, true, { x: 1, y: p.tile.y });
    if (!to && fieldAt(game.fields.entrance, tileIndex(game.grid, p.tile)) === UNREACHABLE) {
      // Storming from an off-field tile (a shop counter): shove onto any
      // adjacent in-field tile, then the entrance field takes over.
      for (const n of STEP_NEIGHBORS) {
        const c = { x: p.tile.x + n.x, y: p.tile.y + n.y };
        if (!inBounds(game.grid, c)) continue;
        if (fieldAt(game.fields.entrance, tileIndex(game.grid, c)) !== UNREACHABLE) {
          to = c;
          break;
        }
      }
    }
    if (to) p.step = { kind: 'stepping', from: p.tile, to, progress: 0 };
  }

  if (p.phase.kind !== 'storming') return;
  p.phase.timeout -= dt;
  if (p.phase.timeout <= 0) {
    // Failsafe: sealed in by fences with no way out — vanish rather than linger forever.
    removedIds.add(p.id);
  }
}

/** Progress an in-flight reserving step; on completion the origin tile is freed. */
function advanceStep(game: Game, p: Passenger, dt: number): void {
  if (p.step.kind !== 'stepping') return;
  p.step.progress += tuning.walkSpeed * p.speedMult * dt;
  p.walkPhase += tuning.walkSpeed * p.speedMult * dt;
  if (p.step.progress >= 1) {
    // Early claimers may already own the origin tile; only vacate if still ours.
    if (game.occupancy.get(tileIndex(game.grid, p.step.from)) === p.id) {
      vacate(game, p.step.from);
    }
    p.prevTile = { ...p.step.from };
    p.tile = p.step.to;
    p.step = { kind: 'idle' };
    // Aimless pacing earns no grace: motion is medicine only when it's progress.
    if (!p.wanderDir) p.moveGrace = tuning.moveGrace;
  }
}

/** Progress a non-reserving step (exiting/storming). Returns true when it completes. */
function advanceCosmeticStep(p: Passenger, dt: number): boolean {
  if (p.step.kind !== 'stepping') return false;
  p.step.progress += tuning.walkSpeed * p.speedMult * dt;
  p.walkPhase += tuning.walkSpeed * p.speedMult * dt;
  if (p.step.progress >= 1) {
    p.tile = p.step.to;
    p.step = { kind: 'idle' };
    return true;
  }
  return false;
}

/** Seconds of step progress after which a departing passenger's origin unlocks. */
const EARLY_RELEASE_PROGRESS = 0.4;

/** How many idle passengers adjacent to `tile` want to step onto it. */
function claimantCount(game: Game, tile: Vec): number {
  let count = 0;
  for (const n of STEP_NEIGHBORS) {
    const at = { x: tile.x + n.x, y: tile.y + n.y };
    if (!inBounds(game.grid, at)) continue;
    const id = game.occupancy.get(tileIndex(game.grid, at));
    if (id === undefined) continue;
    const q = game.passengers.find((c) => c.id === id);
    if (!q || q.phase.kind !== 'queueing' || q.step.kind !== 'idle') continue;
    const f = targetField(game, q);
    if (!f) continue;
    const dHere = fieldAt(f, tileIndex(game.grid, q.tile));
    const dThere = fieldAt(f, tileIndex(game.grid, tile));
    if (dHere !== UNREACHABLE && dThere !== UNREACHABLE && dThere < dHere) count++;
  }
  return count;
}

/**
 * Caterpillar rule: a tile being vacated unlocks at 40% of the leaver's step —
 * but ONLY when exactly one claimant wants it. Two or more claimants (a mob
 * front) deadlock until the tile is fully empty. Orderly single-file geometry
 * is therefore mechanically faster than crowding.
 */
function earlyClaimable(game: Game, to: Vec): boolean {
  const id = game.occupancy.get(tileIndex(game.grid, to));
  if (id === undefined) return false;
  const occupant = game.passengers.find((c) => c.id === id);
  if (!occupant || occupant.step.kind !== 'stepping') return false;
  const s = occupant.step;
  if (s.from.x !== to.x || s.from.y !== to.y) return false;
  if (s.progress < EARLY_RELEASE_PROGRESS) return false;
  return claimantCount(game, to) === 1;
}

/**
 * Pick the next tile toward the field's target, or null to stand still: an
 * unoccupied (or early-claimable) neighbor strictly closer to the target.
 * Reserving steps keep both origin and destination occupied for the step's
 * duration, so passengers never overlap or head-on swap. `shoving` is for
 * stormers, who ignore occupancy on the way out.
 */
/**
 * Deterministic per-passenger, per-tile tiebreak in [0,1). BFS distances are
 * integers, so adding this can NEVER override a strictly-closer step — it only
 * re-orders ties among equal-length routes. Hashing (id, tile) instead of
 * rolling per tick keeps each passenger's choice at a junction STABLE (no
 * dithering), while different passengers braid across all equal-cost paths
 * instead of convoying down one — fewer same-path swarms and mutual blocks.
 * No Math.random involved: seeded runs stay reproducible.
 */
function pathJitter(id: number, tileIdx: number): number {
  let h = (id * 374761393 + tileIdx * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function chooseStep(
  game: Game,
  p: Passenger,
  field: Float64Array,
  shoving: boolean,
  goal: Vec | null = null,
): Vec | null {
  const grid = game.grid;
  const hereIndex = tileIndex(grid, p.tile);
  const here = fieldAt(field, hereIndex);
  if (here === UNREACHABLE) return null;
  let minD = here;
  const ties: Vec[] = [];
  for (const n of STEP_NEIGHBORS) {
    const to = { x: p.tile.x + n.x, y: p.tile.y + n.y };
    if (!inBounds(grid, to)) continue;
    const toIndex = tileIndex(grid, to);
    const d = fieldAt(field, toIndex);
    if (d === UNREACHABLE || d >= here) continue; // strictly-closer steps only
    // Anti-flap: never immediately re-enter the tile just vacated — congestion
    // refreshes flip near-equal routes each second, and without this one-step
    // memory a passenger at a fork walks left-right forever. (Cleared after
    // ~1s blocked, so genuine dead-end reversals stay possible.)
    if (!shoving && p.prevTile && to.x === p.prevTile.x && to.y === p.prevTile.y) continue;
    // A paid-for fence is waiting to drop here: nobody new may claim the tile, so
    // the gate falls into the FIRST gap in the stream (live mazing cuts flow now,
    // not when the stream happens to dry up).
    if (!shoving && pendingAt(game, to) >= 0) continue;
    if (!shoving && isOccupied(game, to) && !earlyClaimable(game, to)) continue;
    if (d < minD) {
      minD = d;
      ties.length = 0;
    }
    if (d === minD) ties.push(to);
  }
  const first = ties[0];
  if (!first || ties.length === 1) return first ?? null;
  // Tie-break between equally-short steps. With a goal in hand, the step axis
  // is sampled ∝ remaining travel on that axis: someone 10 right and 3 up of
  // the scanner goes right ~77% of the time, so crowds fan along their natural
  // diagonals and converge ON the bottleneck. Each sample commits a whole tile
  // step, so there is no dithering. Goal-less fields fall back to the stable
  // per-(passenger, tile) hash.
  if (goal) {
    const weightOf = (to: Vec): number =>
      to.x !== p.tile.x ? Math.abs(goal.x - p.tile.x) : Math.abs(goal.y - p.tile.y);
    const total = ties.reduce((s, t) => s + weightOf(t), 0);
    if (total > 0) {
      let r = Math.random() * total;
      for (const t of ties) {
        r -= weightOf(t);
        if (r <= 0) return t;
      }
    }
  }
  let best = first;
  let bestScore = Infinity;
  for (const t of ties) {
    const score = pathJitter(p.id, tileIndex(grid, t));
    if (score < bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

function inBounds(grid: Grid, t: Vec): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < grid.cols && t.y < grid.rows;
}

/** Blocked this long → try to CUT around the crowd (equal-distance sidestep). */
const CUT_AFTER_BLOCKED = 1;

/**
 * Greedy queue-cutting: a blocked passenger slides to an EQUAL-distance free
 * tile (never backward) to find another way in. On open floor this packs the
 * arc around a bottleneck — a jostling crush, not a polite line — and with
 * calm requiring personal space, the crush pays for it. Inside a fenced
 * channel every lateral tile is wall, so rope physically removes the option:
 * guard rails are what turn a greedy crowd into a queue.
 */
function sideStep(game: Game, p: Passenger, field: Float64Array): Vec | null {
  const here = fieldAt(field, tileIndex(game.grid, p.tile));
  if (here === UNREACHABLE) return null;
  let best: Vec | null = null;
  let bestScore = Infinity;
  for (const n of STEP_NEIGHBORS) {
    const to = { x: p.tile.x + n.x, y: p.tile.y + n.y };
    if (!inBounds(game.grid, to)) continue;
    const toIndex = tileIndex(game.grid, to);
    const d = fieldAt(field, toIndex);
    // "Sideways" within half a tile: weighted fields rarely tie exactly.
    if (d === UNREACHABLE || Math.abs(d - here) > 0.5) continue;
    if (pendingAt(game, to) >= 0 || isOccupied(game, to)) continue;
    const score = pathJitter(p.id, toIndex);
    if (score < bestScore) {
      best = to;
      bestScore = score;
    }
  }
  return best;
}

/** True when a strictly-closer neighbor exists but every one of them is occupied. */
function wantsToMove(game: Game, p: Passenger, field: Float64Array): boolean {
  const here = fieldAt(field, tileIndex(game.grid, p.tile));
  if (here === UNREACHABLE) return false;
  for (const n of STEP_NEIGHBORS) {
    const to = { x: p.tile.x + n.x, y: p.tile.y + n.y };
    if (!inBounds(game.grid, to)) continue;
    const d = fieldAt(field, tileIndex(game.grid, to));
    if (d !== UNREACHABLE && d < here) return true;
  }
  return false;
}

const SWAP_AFTER_BLOCKED = 2;

/** The passenger's current routing field (shop errand or assigned lane). */
function targetField(game: Game, p: Passenger): Float64Array | null {
  const field = p.shopTarget !== null ? game.fields.shops[p.shopTarget] : game.fields.lanes[p.lane];
  return field ?? null;
}

/**
 * Courtesy swap: two facing idle passengers who each want the other's tile squeeze
 * past each other. This is what dissolves mutual-block pockets (e.g. a finished
 * shopper boxed onto the counter by inbound visitors) that strictly-closer stepping
 * alone can never resolve.
 */
function trySwap(game: Game, p: Passenger, field: Float64Array): boolean {
  // Never swap across a pending build: the occupant must walk OFF the tile so the
  // fence can drop; a swap would hand the tile to the next person in the stream.
  if (pendingAt(game, p.tile) >= 0) return false;
  const myHere = fieldAt(field, tileIndex(game.grid, p.tile));
  for (const n of STEP_NEIGHBORS) {
    const at = { x: p.tile.x + n.x, y: p.tile.y + n.y };
    if (!inBounds(game.grid, at)) continue;
    if (pendingAt(game, at) >= 0) continue;
    const myThere = fieldAt(field, tileIndex(game.grid, at));
    if (myThere === UNREACHABLE || myThere >= myHere) continue;
    const otherId = game.occupancy.get(tileIndex(game.grid, at));
    if (otherId === undefined) continue;
    const other = game.passengers.find((q) => q.id === otherId);
    if (!other || other.phase.kind !== 'queueing' || other.step.kind !== 'idle') continue;
    const otherField = targetField(game, other);
    if (!otherField) continue;
    const oHere = fieldAt(otherField, tileIndex(game.grid, other.tile));
    const oThere = fieldAt(otherField, tileIndex(game.grid, p.tile));
    if (oHere === UNREACHABLE || oThere === UNREACHABLE || oThere >= oHere) continue;
    // Swap places instantly; occupancy entries exchange owners.
    const mine = { ...p.tile };
    p.tile = { ...other.tile };
    other.tile = mine;
    occupy(game, p.tile, p.id);
    occupy(game, other.tile, other.id);
    p.moveGrace = tuning.moveGrace;
    other.moveGrace = tuning.moveGrace;
    other.blockedTime = 0;
    return true;
  }
  return false;
}

/** True when any open lane is unreachable from every spawn tile (walled off). */
export function laneCutOff(game: Game): boolean {
  return game.slots.some((slot, i) => {
    if (slot.state !== 'open') return false;
    const field = game.fields.lanes[i];
    if (!field) return false;
    return SPAWN_TILES.every((s) => fieldAt(field, tileIndex(game.grid, s)) === UNREACHABLE);
  });
}
