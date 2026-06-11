import { COLS, RENDER_SCALE, ROWS, TILE } from './constants';
import { setupHud } from './hud';
import { attachInput, createEditor } from './input';
import { buildGrid, createShops, createSlots } from './level';
import { createRenderer } from './render';
import type { ViewOptions } from './render';
import { createGame, stepGame } from './sim';

const MAX_FRAME_DT = 0.1;

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#game');
  if (!canvas) throw new Error('missing #game canvas');
  canvas.width = COLS * TILE * RENDER_SCALE;
  canvas.height = ROWS * TILE * RENDER_SCALE;

  const slots = createSlots();
  const game = createGame(buildGrid(slots), slots, createShops());
  // Dev convenience: ?cash=10000 overrides the starting bank for testing builds.
  const cash = Number(new URLSearchParams(location.search).get('cash'));
  if (Number.isFinite(cash) && cash > 0) game.money = cash;
  const editor = createEditor();
  const options: ViewOptions = {
    skin: localStorage.getItem('checkpoint-skin') === 'mermaids' ? 'mermaids' : 'people',
  };
  const renderer = createRenderer(canvas, options);
  const hud = setupHud(game, editor, options);
  attachInput(canvas, game, editor);

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, MAX_FRAME_DT);
    last = now;
    if (!game.paused) stepGame(game, dt * game.speed);
    renderer.draw(game, editor.selected);
    hud.refresh();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
