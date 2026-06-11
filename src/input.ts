import {
  MACHINE_X0,
  MAX_LEVEL,
  SHOP_TIERS,
  atLevel,
  balance,
  laneRefund,
  laneUpgradeCost,
  perkBlurb,
  shopCost,
  shopRefund,
  shopRelief,
  shopUpgradeCost,
} from './constants';
import { tileIndex } from './flowfield';
import { eraseAt, laneOpenCost, placeFence, placeGate, toggleGate } from './sim';
import type { Game, Passenger, ShopSlot, Vec } from './types';

/**
 * Explicit tool modes: SELECT operates the floor (toggle gates, select
 * facilities), FENCE and GATE build (and left-click their own kind to sell).
 * Right-click erases fences/gates in any mode. FENCE is pre-selected on load —
 * a new day starts by laying geometry, not by operating an empty floor.
 */
export type Tool = 'select' | 'fence' | 'gate';

export type Selection = { kind: 'shop'; index: number } | { kind: 'checkpoint'; index: number };

export type Editor = { tool: Tool; selected: Selection | null };

export function createEditor(): Editor {
  return { tool: 'fence', selected: null };
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'placeFence' }
  | { kind: 'placeGate' }
  | { kind: 'erase' };

const inShopRect = (shop: ShopSlot, t: Vec): boolean =>
  t.x >= shop.rect.x &&
  t.x < shop.rect.x + shop.rect.w &&
  t.y >= shop.rect.y &&
  t.y < shop.rect.y + shop.rect.h;

function shopIndexAt(game: Game, t: Vec): number {
  return game.shops.findIndex((s) => inShopRect(s, t));
}

function checkpointSlotAt(game: Game, t: Vec): number {
  if (t.x < MACHINE_X0) return -1;
  return game.slots.findIndex((s) => Math.abs(s.y - t.y) <= 1);
}

function shopTooltip(shop: ShopSlot): string {
  const tier = SHOP_TIERS[shop.tier];
  const level = shop.built ? `Lv${shop.level + 1}` : '';
  const upgrade =
    shop.built && shop.level < MAX_LEVEL
      ? `Upgrade for $${shopUpgradeCost(shop.tier, shop.level)}.`
      : shop.built
        ? 'Fully upgraded.'
        : '';
  const status = shop.built
    ? `Built ${level} — sell for $${shopRefund(shop.tier, shop.level)}. ${upgrade} Click to select.`
    : `Build for $${shopCost(shop.tier)}. Select it with the Select tool (S).`;
  return (
    `<b>${shop.name}</b> (${shop.rect.w}×${shop.rect.h})<br>${tier.blurb}<br>` +
    `Each arrival stops by with ${Math.round((balance.shopVisitChance + shop.level * balance.shopVisitLevelBonus) * 100)}% chance (errands stack; upgrades draw more visitors), browses ${tier.dwell}s, ` +
    `and banks +${shopRelief(shop.tier, shop.level)} patience. Shopping time never frustrates.<br>` +
    `Superpower: ${perkBlurb(shop.perk, shop.level)}<br><i>${status}</i>`
  );
}

/** Where is this person trying to get to right now? */
function passengerTooltip(game: Game, p: Passenger): string {
  const destination = ((): string => {
    switch (p.phase.kind) {
      case 'processing':
        return 'being scanned';
      case 'shopping':
        return `browsing ${p.shopTarget !== null ? (game.shops[p.shopTarget]?.name ?? 'a shop') : 'a shop'}`;
      case 'exiting':
        return 'cleared — heading out';
      case 'storming':
        return 'storming out!';
      case 'queueing': {
        if (p.shopTarget !== null) {
          const name = game.shops[p.shopTarget]?.name ?? 'a shop';
          const more = p.shopPlan.length;
          return `errand: ${name}${more > 0 ? ` (+${more} more)` : ''}, then security`;
        }
        if (p.wanderDir) return 'no way through — pacing';
        return `queueing for checkpoint ${p.lane + 1}`;
      }
    }
  })();
  const vip =
    p.vip && p.waveBorn !== null
      ? `<b>★ VIP</b> — serve for a $${balance.vipBonusPerWave * p.waveBorn} bonus<br>`
      : '';
  return `${vip}<b>Passenger</b> · ${destination}<br><i>frustration ${Math.max(0, Math.round(p.frustration))}/100</i>`;
}

function checkpointTooltip(game: Game, slotIndex: number): string {
  const slot = game.slots[slotIndex];
  if (!slot) return '';
  const service = atLevel(balance.laneService, slot.level);
  const upgrade =
    slot.state === 'open' && slot.level < MAX_LEVEL
      ? ` Upgrade (faster scans): $${laneUpgradeCost(slot.level)}.`
      : slot.state === 'open'
        ? ' Fully upgraded.'
        : '';
  const status =
    slot.state === 'open'
      ? `Open Lv${slot.level + 1}.${upgrade}`
      : slot.state === 'draining'
        ? 'Draining.'
        : `Closed — open for $${laneOpenCost(game)}.`;
  return (
    `<b>Checkpoint ${slotIndex + 1}</b><br>Scans one passenger at a time (~${service}s each).<br>` +
    `Open: $${laneOpenCost(game)} · Close: $${laneRefund(slot.level)} back when drained.<br><i>${status} Click to select.</i>`
  );
}

export function attachInput(canvas: HTMLCanvasElement, game: Game, editor: Editor): void {
  let drag: DragMode = { kind: 'none' };
  const tooltip = document.querySelector<HTMLDivElement>('#tooltip');

  const tileFromEvent = (e: MouseEvent): Vec | null => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * game.grid.cols);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * game.grid.rows);
    if (x < 0 || y < 0 || x >= game.grid.cols || y >= game.grid.rows) return null;
    return { x, y };
  };

  const refreshTooltip = (e: MouseEvent, tile: Vec | null): void => {
    if (!tooltip) return;
    let html = '';
    if (tile) {
      const pid = game.occupancy.get(tileIndex(game.grid, tile));
      const passenger = pid !== undefined ? game.passengers.find((p) => p.id === pid) : undefined;
      const shopIndex = shopIndexAt(game, tile);
      const slotIndex = checkpointSlotAt(game, tile);
      if (passenger) {
        html = passengerTooltip(game, passenger);
      } else if (shopIndex >= 0) {
        const shop = game.shops[shopIndex];
        if (shop) html = shopTooltip(shop);
      } else if (slotIndex >= 0) {
        html = checkpointTooltip(game, slotIndex);
      }
    }
    tooltip.classList.toggle('hidden', html === '');
    if (html !== '') {
      tooltip.innerHTML = html;
      // Clamp to the viewport so tooltips near the right/bottom edges stay readable.
      const margin = 14;
      const width = 254; // max-width 240 + padding
      tooltip.style.left = `${Math.min(e.clientX + margin, window.innerWidth - width)}px`;
      tooltip.style.top = `${Math.min(e.clientY + margin, window.innerHeight - tooltip.offsetHeight - margin)}px`;
    }
  };

  canvas.addEventListener('mousedown', (e) => {
    const tile = tileFromEvent(e);
    if (!tile) return;

    // Right-click: universal eraser (fences, gates, pending builds), any mode.
    if (e.button === 2) {
      eraseAt(game, tile);
      drag = { kind: 'erase' };
      return;
    }
    if (e.button !== 0) return;
    const kind = game.grid.tiles[tileIndex(game.grid, tile)];

    if (editor.tool === 'select') {
      // SELECT operates: toggle gate valves, select facilities, click-away clears.
      if (kind === 'gateOpen' || kind === 'gateClosed') {
        toggleGate(game, tile);
        return;
      }
      const shopIndex = shopIndexAt(game, tile);
      if (shopIndex >= 0) {
        editor.selected = { kind: 'shop', index: shopIndex };
        return;
      }
      const slotIndex = checkpointSlotAt(game, tile);
      if (slotIndex >= 0) {
        editor.selected = { kind: 'checkpoint', index: slotIndex };
        return;
      }
      editor.selected = null;
      return;
    }

    // Build modes edit the floor only; clicking your own kind sells it.
    if (tile.x >= MACHINE_X0) return;
    if (editor.tool === 'gate') {
      if (kind === 'gateOpen' || kind === 'gateClosed') {
        eraseAt(game, tile); // sell the gate (full refund)
      } else if (placeGate(game, tile)) {
        drag = { kind: 'placeGate' };
      }
      return;
    }
    if (kind === 'rope') {
      eraseAt(game, tile);
      drag = { kind: 'erase' };
    } else {
      placeFence(game, tile);
      drag = { kind: 'placeFence' };
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const tile = tileFromEvent(e);
    refreshTooltip(e, tile);
    if (drag.kind === 'none' || !tile) return;
    if (drag.kind === 'placeFence') placeFence(game, tile);
    else if (drag.kind === 'placeGate') placeGate(game, tile);
    else eraseAt(game, tile);
  });

  const endDrag = () => {
    drag = { kind: 'none' };
  };
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', (e) => {
    endDrag();
    refreshTooltip(e, null);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
