export type Vec = { x: number; y: number };

export type TileKind =
  | 'floor'
  | 'wall'
  | 'rope'
  /** Retractable-belt gate, player-toggled: open = walkable, closed = barrier. */
  | 'gateOpen'
  | 'gateClosed'
  | 'door'
  | 'scanner'
  | 'exit'
  | 'shop';

export type Grid = {
  cols: number;
  rows: number;
  tiles: TileKind[];
};

export type ShopTier = 'small' | 'medium' | 'large';

/** Per-shop superpower applied to visitors (on top of the patience boost). */
export type Perk = 'caffeine' | 'reading' | 'cash' | 'fastscan' | 'zen';

export type Rect = { x: number; y: number; w: number; h: number };

/** A fixed shop location; the building footprint is solid when built. */
export type ShopSlot = {
  tier: ShopTier;
  name: string;
  perk: Perk;
  rect: Rect;
  /** Counter tiles; the first COUNTERS_BY_LEVEL[tier][level] are active. */
  visits: Vec[];
  built: boolean;
  /** Upgrade level 0..MAX_LEVEL; boosts relief, perk magnitude, and counters. */
  level: number;
};

/**
 * Checkpoint lifecycle: closed → (pay fee) open → (click) draining → (auto, refund)
 * closed. Draining lanes accept no new passengers but finish who they have.
 */
export type SlotState = 'closed' | 'open' | 'draining';

/** A candidate checkpoint row; service tile at (SERVICE_X, y), machines to the right. */
export type LaneSlot = {
  y: number;
  state: SlotState;
  /** Upgrade level 0..MAX_LEVEL; higher levels scan faster. */
  level: number;
};

/** One weighted distance field per active slot (null when inactive), plus one
 * to the entrance. Real-valued: edges price DIRECTIONAL CONGESTION (follow
 * cheap, contraflow dear, parked bodies by remaining park time). */
export type Fields = {
  lanes: (Float64Array | null)[];
  shops: (Float64Array | null)[];
  entrance: Float64Array;
  /** Tile indices of all active shop counters — patron-only tiles, walls to
   * every field except their own shop's (no cutting through storefronts). */
  counters: Set<number>;
};

export type Step = { kind: 'idle' } | { kind: 'stepping'; from: Vec; to: Vec; progress: number };

export type Phase =
  | { kind: 'queueing' }
  | { kind: 'processing'; remaining: number; total: number }
  | { kind: 'shopping'; remaining: number; total: number }
  | { kind: 'exiting'; path: Vec[]; index: number }
  | { kind: 'storming'; timeout: number };

export type Passenger = {
  id: number;
  tile: Vec;
  step: Step;
  phase: Phase;
  /** Index into Game.slots. */
  lane: number;
  frustration: number;
  spriteIndex: number;
  /** Distance walked in tiles, accumulated across steps; drives the walk-cycle frame. */
  walkPhase: number;
  /** Seconds of walking-rate accrual left after the last completed step. */
  moveGrace: number;
  /** Tile this passenger most recently stepped FROM — never immediately
   * re-entered while alternatives exist (kills congestion-flip flapping). */
  prevTile: Vec | null;
  /** Seconds until this passenger reconsiders its lane choice. */
  laneCheck: number;
  /** Shop slot this passenger is currently heading to, if any. */
  shopTarget: number | null;
  /** Seconds camped motionless beside a full counter; triggers a graceful,
   * penalty-free errand give-up (camping crowds the storefront for others). */
  shopWait: number;
  /** Remaining planned errands (independent per-shop rolls at spawn). */
  shopPlan: number[];
  /** Visitor buffs from shop perks. */
  speedMult: number;
  stillMult: number;
  serviceMult: number;
  /** Remaining free storm-saves (Zen Lounge). */
  zenSaves: number;
  /** Seconds spent wanting to move but blocked; triggers courtesy swaps. */
  blockedTime: number;
  /** Prepped on-deck (sole waiter behind a scan): next scan takes half time. */
  prepped: boolean;
  /** Wave (1-based) this passenger arrived during, null for calm arrivals. */
  waveBorn: number | null;
  /** Sealed-in pacing: current random-walk direction (null = pathing normally). */
  wanderDir: Vec | null;
  /** Linear steps left before the pacer picks a new direction (2-6 per leg). */
  wanderSteps: number;
  /** Personal space violated this tick (3x3 crowd) — drawn as an anger tick. */
  crowded: boolean;
  /** Each wave's FIRST arrival is its VIP: serving them pays a wave-scaled
   * bonus (forfeited if lost — a carrot, never a fail condition). */
  vip: boolean;
};

export type Stats = {
  served: number;
  walkOffs: number;
  turnedAway: number;
  satisfactionSum: number;
};

/** Report card for the most recently finished wave (shown as a HUD toast). */
export type WaveReport = {
  /** 1-based wave number. */
  index: number;
  served: number;
  lost: number;
  /** Net money since the wave began (serves + shop spend − losses − builds). */
  money: number;
  /** Game time when the report finalized (drives toast fade-out). */
  endedAt: number;
};

/** Outcome tally for everyone who ARRIVED during one wave (cohort accounting). */
export type WaveCohort = {
  arrivals: number;
  served: number;
  lost: number;
  bankAtStart: number;
};

/** Floating "+$12"/"−$30" indicator; published by the sim, drawn by the renderer. */
export type MoneyPop = {
  amount: number;
  /** Tile coordinates (float) where the pop spawned. */
  x: number;
  y: number;
  /** Seconds since spawn; the sim ages and culls these. */
  age: number;
};

/** An action waiting for its tile to clear: a paid rope, or a gate swinging shut.
 * (Open gates are walkable, so PLACING a gate never waits — only shutting does.) */
export type PendingBuild = { tile: Vec; kind: 'rope' | 'gateShut' };

export type Game = {
  time: number;
  speed: number;
  paused: boolean;
  money: number;
  spawnTimer: number;
  nextId: number;
  passengers: Passenger[];
  /** tileIndex -> passenger id. Written only via occupy/vacate in sim.ts. */
  occupancy: Map<number, number>;
  grid: Grid;
  slots: LaneSlot[];
  shops: ShopSlot[];
  fields: Fields;
  stats: Stats;
  laneAssigned: number[];
  pops: MoneyPop[];
  pending: PendingBuild[];
  /** Wave currently in progress (1-based), or null during calm. */
  waveActive: number | null;
  /** Per-wave arrival cohorts still waiting to fully resolve into a report. */
  waveCohorts: Map<number, WaveCohort>;
  /** Most recently finished wave's report card. */
  waveReport: WaveReport | null;
  /** Failure ends the day and freezes the sim: bankruptcy (a wave ends in the
   * red) or walkout (too large a share of one wave's cohort stormed off). */
  failed: boolean;
  failReason: 'bankrupt' | 'walkout' | null;
};
