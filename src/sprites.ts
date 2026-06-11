import { TILE } from './constants';

const SHIRTS = [
  '#e0564f',
  '#4f7be0',
  '#52b788',
  '#e9c46a',
  '#9b5de5',
  '#f4845f',
  '#48bfe3',
  '#ef476f',
  '#80b918',
  '#577590',
];
const SKINS = ['#f5d0a9', '#d9a066', '#8d5524'];
const HAIRS = ['#2d2d2d', '#5b3a1a', '#c9a227', '#6c757d'];
const PANTS = '#3a4a5a';
const SHOES = '#22223b';
// Mermaid palette: iridescent tails and flowing hair.
const TAILS = ['#2a9d8f', '#48bfe3', '#9b5de5', '#06d6a0', '#ef476f', '#577590'];
const MERMAID_HAIRS = ['#e63946', '#c9a227', '#9b5de5', '#2d6a4f', '#2d2d2d'];

/** Visual reskin only — the sim never knows what the sprites look like. */
export type Skin = 'people' | 'mermaids';

type WalkFrame = 'stand' | 'strideA' | 'strideB';

export type PersonFrames = {
  stand: HTMLCanvasElement;
  strideA: HTMLCanvasElement;
  strideB: HTMLCanvasElement;
};

export type SpriteSet = {
  variants: PersonFrames[];
};

export function cycle<T>(arr: readonly T[], i: number): T {
  const v = arr[((i % arr.length) + arr.length) % arr.length];
  if (v === undefined) throw new Error('cycle() requires a non-empty array');
  return v;
}

export function createSprites(skinKind: Skin = 'people'): SpriteSet {
  const variants: PersonFrames[] = [];
  for (let i = 0; i < 12; i++) {
    const skin = cycle(SKINS, i * 7 + 1);
    if (skinKind === 'mermaids') {
      const tail = cycle(TAILS, i);
      const top = cycle(SHIRTS, i * 3 + 1);
      const hair = cycle(MERMAID_HAIRS, i * 5 + 2);
      variants.push({
        stand: drawMermaid('stand', top, skin, hair, tail),
        strideA: drawMermaid('strideA', top, skin, hair, tail),
        strideB: drawMermaid('strideB', top, skin, hair, tail),
      });
    } else {
      const shirt = cycle(SHIRTS, i);
      const hair = cycle(HAIRS, i * 5 + 2);
      variants.push({
        stand: drawPerson('stand', shirt, skin, hair),
        strideA: drawPerson('strideA', shirt, skin, hair),
        strideB: drawPerson('strideB', shirt, skin, hair),
      });
    }
  }
  return { variants };
}

function drawPerson(
  frame: WalkFrame,
  shirt: string,
  skin: string,
  hair: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const px = (c: string, x: number, y: number, w = 1, h = 1) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };

  px(hair, 5, 1, 6, 2);
  px(skin, 5, 3, 6, 3);
  px('#22223b', 6, 4, 1, 1);
  px('#22223b', 9, 4, 1, 1);

  px(shirt, 4, 6, 8, 5);

  // Arms swing opposite to the leading leg; hands are the skin pixel at the tip.
  const leftArmY = frame === 'strideA' ? 5 : frame === 'strideB' ? 7 : 6;
  const rightArmY = frame === 'strideB' ? 5 : frame === 'strideA' ? 7 : 6;
  px(shirt, 3, leftArmY, 1, 4);
  px(skin, 3, leftArmY + 4, 1, 1);
  px(shirt, 12, rightArmY, 1, 4);
  px(skin, 12, rightArmY + 4, 1, 1);

  switch (frame) {
    case 'stand':
      px(PANTS, 5, 11, 2, 3);
      px(PANTS, 9, 11, 2, 3);
      px(SHOES, 5, 14, 2, 1);
      px(SHOES, 9, 14, 2, 1);
      break;
    case 'strideA':
      // Left leg planted forward, right leg trailing (lifted, shorter).
      px(PANTS, 4, 11, 2, 3);
      px(SHOES, 4, 14, 2, 1);
      px(PANTS, 10, 11, 2, 2);
      px(SHOES, 10, 13, 2, 1);
      break;
    case 'strideB':
      px(PANTS, 4, 11, 2, 2);
      px(SHOES, 4, 13, 2, 1);
      px(PANTS, 10, 11, 2, 3);
      px(SHOES, 10, 14, 2, 1);
      break;
  }
  return canvas;
}

/** Mermaid traveler: flowing hair, scale top, and a tail that sways the walk. */
function drawMermaid(
  frame: WalkFrame,
  top: string,
  skin: string,
  hair: string,
  tail: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const px = (c: string, x: number, y: number, w = 1, h = 1) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const dark = (c: string): string => {
    // Cheap shade: halve each channel of #rrggbb.
    const n = parseInt(c.slice(1), 16);
    const half = (v: number) => Math.floor(v / 2);
    const r = half((n >> 16) & 255);
    const g = half((n >> 8) & 255);
    const b = half(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  };

  // Long hair frames the face and flows down the sides.
  px(hair, 5, 1, 6, 2);
  px(hair, 4, 2, 1, 6);
  px(hair, 11, 2, 1, 6);
  px(skin, 5, 3, 6, 3);
  px('#22223b', 6, 4, 1, 1);
  px('#22223b', 9, 4, 1, 1);

  // Seashell top, bare midriff, arms swinging like the walkers'.
  px(top, 5, 6, 6, 2);
  px(skin, 5, 8, 6, 1);
  const leftArmY = frame === 'strideA' ? 5 : frame === 'strideB' ? 7 : 6;
  const rightArmY = frame === 'strideB' ? 5 : frame === 'strideA' ? 7 : 6;
  px(skin, 3, leftArmY, 1, 4);
  px(skin, 12, rightArmY, 1, 4);

  // The tail: hips taper into a swaying tail; the fluke flips with the stride.
  const sway = frame === 'strideA' ? -1 : frame === 'strideB' ? 1 : 0;
  px(tail, 5, 9, 6, 2); // hips
  px(dark(tail), 6 + sway, 11, 4, 1);
  px(tail, 6 + sway, 12, 3, 1);
  px(dark(tail), 7 + sway * 2, 13, 2, 1);
  // Fluke fans out at the bottom.
  px(tail, 5 + sway * 2, 14, 6, 1);
  px(dark(tail), 4 + sway * 2, 15, 3, 1);
  px(dark(tail), 9 + sway * 2, 15, 3, 1);
  // A glint of scales.
  px('#e6f9ff', 6, 10, 1, 1);
  px('#e6f9ff', 9 + sway, 12, 1, 1);
  return canvas;
}
