import {
  CHECKPOINTS_TOTAL,
  CLOCK_START_MINUTES,
  GAME_VERSION,
  MAX_FRUSTRATION,
  MAX_LEVEL,
  SHOP_TIERS,
  atLevel,
  balance,
  currentWave,
  nextWave,
  laneRefund,
  laneUpgradeCost,
  perkBlurb,
  shopCost,
  shopRefund,
  shopUpgradeCost,
} from './constants';
import {
  checkpointsInUse,
  laneCutOff,
  laneOpenCost,
  toggleCheckpoint,
  toggleShop,
  upgradeCheckpoint,
  upgradeShop,
} from './sim';
import type { Editor, Tool } from './input';
import type { ViewOptions } from './render';
import type { Game } from './types';

export type Hud = {
  refresh(): void;
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

export function setupHud(game: Game, editor: Editor, options: ViewOptions): Hud {
  const clock = el('clock');
  const money = el('money');
  const served = el('stat-served');
  const satisfaction = el('stat-satisfaction');
  const walkOffs = el('stat-walkoffs');
  const turnedAway = el('stat-turned');
  const inside = el('stat-inside');
  const state = el('stat-state');
  const warning = el('warning');
  const selectButton = el<HTMLButtonElement>('tool-select');
  const fenceButton = el<HTMLButtonElement>('tool-fence');
  const gateButton = el<HTMLButtonElement>('tool-gate');
  const checkpointCount = el('count-checkpoints');

  // Tool-shaped cursors over the canvas: a rope post for fence, a belt for gate.
  const cursorSvg = (svg: string): string =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' width='20' height='20'>${svg}</svg>`)}") 10 10, crosshair`;
  const TOOL_CURSORS: Record<Tool, string> = {
    select: 'pointer',
    fence: cursorSvg(
      `<g fill='#caa84a' stroke='#000' stroke-width='0.6'><rect x='2' y='3' width='2' height='11'/><rect x='7' y='3' width='2' height='11'/><rect x='12' y='3' width='2' height='11'/><rect x='2' y='6' width='12' height='1.6'/></g>`,
    ),
    gate: cursorSvg(
      `<g fill='#4f7be0' stroke='#000' stroke-width='0.6'><rect x='1.5' y='2' width='3' height='12'/><rect x='11.5' y='2' width='3' height='12'/><rect x='4.5' y='6.5' width='7' height='3'/></g>`,
    ),
  };
  const canvas = document.querySelector<HTMLCanvasElement>('#game');

  const selectTool = (tool: Tool) => {
    editor.tool = tool;
    // Entering a build mode drops the facility selection (build ≠ operate).
    if (tool !== 'select') editor.selected = null;
    selectButton.classList.toggle('selected', tool === 'select');
    fenceButton.classList.toggle('selected', tool === 'fence');
    gateButton.classList.toggle('selected', tool === 'gate');
    if (canvas) canvas.style.cursor = TOOL_CURSORS[tool];
  };
  selectButton.addEventListener('click', () => selectTool('select'));
  fenceButton.addEventListener('click', () => selectTool('fence'));
  gateButton.addEventListener('click', () => selectTool('gate'));
  selectTool(editor.tool);

  // Speed controls mirror the 1/2/3 keys and the spacebar.
  const pauseButton = el<HTMLButtonElement>('speed-pause');
  const speedButtons: [HTMLElement, number][] = [
    [el('speed-1'), 1],
    [el('speed-2'), 2],
    [el('speed-5'), 5],
  ];
  const refreshSpeedButtons = () => {
    pauseButton.classList.toggle('selected', game.paused);
    for (const [node, value] of speedButtons) {
      node.classList.toggle('selected', !game.paused && game.speed === value);
    }
  };
  const setSpeed = (value: number): void => {
    game.paused = false;
    game.speed = value;
  };
  pauseButton.addEventListener('click', () => {
    game.paused = !game.paused;
  });
  for (const [node, value] of speedButtons) {
    node.addEventListener('click', () => setSpeed(value));
  }

  // ONE keyboard chokepoint for every shortcut. Modifier combos pass through
  // untouched — Cmd+S must save the page, not switch to the Select tool.
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 's':
      case 'S':
      case 'Escape':
        selectTool('select');
        break;
      case 'f':
      case 'F':
        selectTool('fence');
        break;
      case 'g':
      case 'G':
        selectTool('gate');
        break;
      case ' ':
        e.preventDefault();
        game.paused = !game.paused;
        break;
      case '1':
        setSpeed(1);
        break;
      case '2':
        setSpeed(2);
        break;
      case '3':
        setSpeed(5);
        break;
    }
  });

  // Tool buttons + help text show live balance prices.
  el('fence-price').textContent = `$${balance.fenceCost}`;
  el('gate-price').textContent = `$${balance.gateCost}`;
  el('version').textContent = `v${GAME_VERSION}`;

  // Cosmetic reskin toggle (persisted): travelers or mermaids.
  const mermaidToggle = el<HTMLInputElement>('skin-mermaids');
  mermaidToggle.checked = options.skin === 'mermaids';
  mermaidToggle.addEventListener('change', () => {
    options.skin = mermaidToggle.checked ? 'mermaids' : 'people';
    localStorage.setItem('checkpoint-skin', options.skin);
  });

  el('help').innerHTML =
    `<b>S</b>elect: click checkpoints &amp; shops for actions; click a gate to swing ` +
    `it open/closed FREE — cut a flowing line mid-wave, reopen after.<br />` +
    `<b>F</b>ence: click/drag places, click a fence sells it (full refund).<br />` +
    `<b>G</b>ate: click places, click a gate sells it. Right-click erases anywhere. ` +
    `Placements under people materialize when the square clears.<br />` +
    `Space: pause · 1 / 2 / 3: speed · Esc: back to select<br /><br />` +
    `Serves pay a flat $${balance.payoutBase}; every walk-off or turn-away costs ` +
    `$${balance.lossCost}, and shoppers spend at the counter. Keep people ` +
    `<b>walking</b> — and shopping.`;

  const selection = el('selection');
  selection.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const action = target.dataset['action'];
    const sel = editor.selected;
    if (!action || !sel) return;
    if (sel.kind === 'shop') {
      if (action === 'toggle') toggleShop(game, sel.index);
      else if (action === 'upgrade') upgradeShop(game, sel.index);
    } else {
      if (action === 'toggle') toggleCheckpoint(game, sel.index);
      else if (action === 'upgrade') upgradeCheckpoint(game, sel.index);
    }
  });

  let lastSelectionHtml = '';
  let lastToastHtml = '';
  const renderSelection = (): void => {
    const html = selectionHtml(game, editor);
    if (html !== lastSelectionHtml) {
      selection.innerHTML = html;
      lastSelectionHtml = html;
    }
  };

  const waveStatus = el('wave-status');
  const waveToast = el('wave-toast');
  waveToast.addEventListener('click', (e) => {
    if (e.target instanceof HTMLButtonElement && e.target.dataset['action'] === 'restart') {
      location.reload();
    }
  });

  return {
    refresh(): void {
      clock.textContent = formatClock(game.time);
      // Stage chip: pulsing badge during a wave, countdown during calm. A fixed
      // overlay spot on the canvas — it never touches the sidebar layout.
      const wave = currentWave(game.time);
      const upcoming = wave === null ? nextWave(game.time) : null;
      if (game.failed) {
        waveStatus.className = 'hidden';
      } else if (wave !== null) {
        waveStatus.textContent = `WAVE ${wave}`;
        waveStatus.className = 'wave';
      } else if (upcoming) {
        waveStatus.textContent = `wave ${upcoming.index} in ${Math.floor(upcoming.inSeconds / 60)}:${String(Math.floor(upcoming.inSeconds % 60)).padStart(2, '0')}`;
        waveStatus.className = 'calm';
      } else {
        waveStatus.className = 'hidden';
      }
      // Bankruptcy ends the day; otherwise a report-card toast after each wave.
      const report = game.waveReport;
      let toastClass = 'toast hidden';
      let toastHtml = '';
      if (game.failed) {
        const title =
          game.failReason === 'walkout'
            ? 'SHUT DOWN — too many passengers stormed out'
            : `BANKRUPT${report ? ` — wave ${report.index}` : ''}`;
        toastClass = 'toast rough modal';
        toastHtml =
          `<b>${title}</b> · the day is over.<br>` +
          `${game.stats.served} served · ${game.stats.walkOffs + game.stats.turnedAway} lost · ` +
          `bank $${Math.round(game.money)}<br>` +
          `<button data-action="restart">Start a new day</button>`;
      } else if (report && game.time - report.endedAt < 14) {
        const tone = report.lost === 0 ? 'clean' : report.lost <= 3 ? 'ok' : 'rough';
        toastClass = `toast ${tone}`;
        toastHtml =
          `<b>Wave ${report.index} ${report.lost === 0 ? 'cleared!' : 'survived'}</b> · ` +
          `${report.served} served · ${report.lost} lost · ` +
          `${report.money >= 0 ? '+' : '−'}$${Math.abs(report.money)} ` +
          `(bank $${Math.round(game.money)})`;
      }
      if (toastHtml !== lastToastHtml) {
        waveToast.className = toastClass;
        waveToast.innerHTML = toastHtml;
        lastToastHtml = toastHtml;
      }
      money.textContent = `$${Math.round(game.money)}`;
      money.classList.toggle('broke', game.money < 0);
      served.textContent = String(game.stats.served);
      satisfaction.textContent =
        game.stats.served === 0
          ? '—'
          : `${Math.round(game.stats.satisfactionSum / game.stats.served / (MAX_FRUSTRATION / 100))}%`;
      walkOffs.textContent = String(game.stats.walkOffs);
      turnedAway.textContent = String(game.stats.turnedAway);
      inside.textContent = String(game.passengers.length);
      state.textContent = game.paused ? 'PAUSED' : `${game.speed}×`;
      checkpointCount.textContent = `${checkpointsInUse(game)}/${CHECKPOINTS_TOTAL}`;
      warning.textContent = laneCutOff(game) ? '⚠ A lane is cut off from the entrance!' : '';
      refreshSpeedButtons();
      renderSelection();
    },
  };
}

const button = (action: string, label: string, enabled: boolean): string =>
  `<button data-action="${action}" ${enabled ? '' : 'disabled'}>${label}</button>`;

function selectionHtml(game: Game, editor: Editor): string {
  const sel = editor.selected;
  if (!sel) return '<span class="hint">Click a checkpoint or shop to select it.</span>';

  if (sel.kind === 'shop') {
    const shop = game.shops[sel.index];
    if (!shop) return '';
    const tier = SHOP_TIERS[shop.tier];
    const head = `<b>${shop.name}</b> (${shop.rect.w}×${shop.rect.h}${shop.built ? `, Lv${shop.level + 1}` : ''})`;
    const perk = `<div class="hint">${perkBlurb(shop.perk, shop.level)}</div>`;
    if (!shop.built) {
      // Construction clears the lot (fences inside are sold at full refund).
      return `${head}${perk}<div class="actions">${button('toggle', `Build $${shopCost(shop.tier)}`, game.money >= shopCost(shop.tier))}</div>`;
    }
    const upgrade =
      shop.level < MAX_LEVEL
        ? button(
            'upgrade',
            `Upgrade $${shopUpgradeCost(shop.tier, shop.level)}`,
            game.money >= shopUpgradeCost(shop.tier, shop.level),
          )
        : button('upgrade', 'Max level', false);
    return (
      `${head}${perk}<div class="hint">+${tier.relief} base patience · ${tier.dwell}s browse</div>` +
      `<div class="actions">${upgrade}${button('toggle', `Sell $${shopRefund(shop.tier, shop.level)}`, true)}</div>`
    );
  }

  const slot = game.slots[sel.index];
  if (!slot) return '';
  const head = `<b>Checkpoint ${sel.index + 1}</b>${slot.state === 'open' ? ` (Lv${slot.level + 1})` : ''}`;
  if (slot.state === 'closed') {
    const atCap = checkpointsInUse(game) >= CHECKPOINTS_TOTAL;
    const label = atCap
      ? `Budget full (${CHECKPOINTS_TOTAL} checkpoints max)`
      : `Open $${laneOpenCost(game)}`;
    return (
      `${head}<div class="hint">Scans ~${atLevel(balance.laneService, 0)}s per passenger. ` +
      `Up to ${CHECKPOINTS_TOTAL} checkpoints may be open at once.</div>` +
      `<div class="actions">${button('toggle', label, !atCap && game.money >= laneOpenCost(game))}</div>`
    );
  }
  if (slot.state === 'draining') {
    return `${head}<div class="hint">Draining — closes when empty, refunds $${laneRefund(slot.level)}.</div><div class="actions">${button('toggle', 'Reopen (free)', true)}</div>`;
  }
  const upgrade =
    slot.level < MAX_LEVEL
      ? button(
          'upgrade',
          `Upgrade $${laneUpgradeCost(slot.level)}`,
          game.money >= laneUpgradeCost(slot.level),
        )
      : button('upgrade', 'Max level', false);
  return (
    `${head}<div class="hint">Scans ~${atLevel(balance.laneService, slot.level)}s per passenger.</div>` +
    `<div class="actions">${upgrade}${button('toggle', `Drain & close (+$${laneRefund(slot.level)})`, true)}</div>`
  );
}

function formatClock(time: number): string {
  const minutes = CLOCK_START_MINUTES + Math.floor(time);
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
