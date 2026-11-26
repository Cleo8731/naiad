// Where a walkthrough's edge chips sit (Q232), and the overlap the user found on
// 2026-11-26: three chips on the top edge, the third laid over the second.
import { describe, expect, test } from 'vitest';
import { CHIP_GAP, layChips, packLine, type ChipArea, type ChipWish } from '../src/chip-layout';

const area: ChipArea = { left: 12, top: 12, right: 935, bottom: 1000 };
type Box = { x: number; y: number; w: number; h: number };
const boxes = (chips: ChipWish[], at = layChips(chips, area)): Box[] => chips.map((c, i) => ({ ...at[i], w: c.w, h: c.h }));
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const clashes = (bs: Box[]) => bs.flatMap((a, i) => bs.slice(i + 1).filter((b) => overlap(a, b)).map(() => i));
const inside = (b: Box) => b.x >= area.left && b.x + b.w <= area.right && b.y >= area.top && b.y + b.h <= area.bottom;

describe('chips along one edge', () => {
  test('the user\'s case: three wide chips on the top edge no longer overlap; the one that does not fit starts a second row', () => {
    // As in the user's picture: "Eligible → …", "Cannot prepare …", "Outside scope …", each about 375 px wide.
    const chips: ChipWish[] = [
      { edge: 'top', x: 252, y: 12, w: 375, h: 44 },
      { edge: 'top', x: 650, y: 12, w: 375, h: 44 },
      { edge: 'top', x: 715, y: 12, w: 375, h: 44 },
    ];
    const bs = boxes(chips);
    expect(clashes(bs)).toEqual([]);
    expect(bs.every(inside)).toBe(true);
    expect(bs.map((b) => b.y)).toEqual([12, 12, 12 + 44 + CHIP_GAP]);
  });

  test('a lone chip sits centred on its spot, kept inside', () => {
    expect(layChips([{ edge: 'top', x: 400, y: 12, w: 200, h: 34 }], area)).toEqual([{ x: 300, y: 12 }]);
    expect(layChips([{ edge: 'top', x: 930, y: 12, w: 200, h: 34 }], area)).toEqual([{ x: 735, y: 12 }]);
    expect(layChips([{ edge: 'bottom', x: 400, y: 1000, w: 200, h: 34 }], area)).toEqual([{ x: 300, y: 966 }]);
    expect(layChips([{ edge: 'right', x: 935, y: 500, w: 200, h: 40 }], area)).toEqual([{ x: 735, y: 480 }]);
  });

  test('two chips wanting the same spot sit side by side, about it, in the order of their spots', () => {
    const at = layChips([{ edge: 'top', x: 501, y: 12, w: 100, h: 34 }, { edge: 'top', x: 500, y: 12, w: 100, h: 34 }], area);
    expect(at[1].x + 100 + CHIP_GAP).toBe(at[0].x);
    expect(at[1].x).toBe(450); // the one further left keeps its spot; the other moves aside
  });

  test('near the right edge, a chip moves the ones before it left rather than overlap', () => {
    const at = packLine([700, 760], [200, 200], 12, 935);
    expect(at).toEqual([935 - 200 - CHIP_GAP - 200, 735]);
  });

  test('chips that cannot fit on one line are refused, so they start a new row', () => {
    expect(packLine([0, 0, 0], [400, 400, 400], 0, 1000)).toBeNull();
    expect(packLine([0, 0], [400, 400], 0, 1000)).not.toBeNull();
  });

  test('chips on a side stack down it, clear of each other', () => {
    const chips: ChipWish[] = [{ edge: 'left', x: 12, y: 300, w: 250, h: 44 }, { edge: 'left', x: 12, y: 310, w: 250, h: 44 }];
    const bs = boxes(chips);
    expect(clashes(bs)).toEqual([]);
    expect(bs.every((b) => b.x === 12)).toBe(true);
  });

  test('a chip on a side keeps clear of a chip on the top edge at that corner', () => {
    const chips: ChipWish[] = [{ edge: 'top', x: 900, y: 12, w: 300, h: 44 }, { edge: 'right', x: 935, y: 20, w: 300, h: 44 }];
    const bs = boxes(chips);
    expect(clashes(bs)).toEqual([]);
    expect(bs[1].y).toBe(12 + 44 + CHIP_GAP);
  });
});

test('many random sets of chips: none overlap, and all stay inside', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const edges = ['top', 'bottom', 'left', 'right'] as const;
  for (let run = 0; run < 500; run++) {
    const chips: ChipWish[] = [];
    for (const edge of edges) {
      const n = Math.floor(rand() * (edge === 'top' || edge === 'bottom' ? 5 : 4));
      for (let k = 0; k < n; k++) {
        const w = 100 + rand() * 280, h = 30 + rand() * 20;
        const x = edge === 'left' ? 12 : edge === 'right' ? 935 : 12 + rand() * 923;
        const y = edge === 'top' ? 12 : edge === 'bottom' ? 1000 : 12 + rand() * 988;
        chips.push({ edge, x, y, w, h });
      }
    }
    const bs = boxes(chips);
    expect(clashes(bs), `run ${run}`).toEqual([]);
    expect(bs.every(inside), `run ${run}`).toBe(true);
  }
});

// oW1 (bug hunt T6.5): in a view narrower than a left chip and a right chip side by side,
// the two sides' columns cross; a side chip was dodging the other side's chips as if they
// sat on the foot edge, and was laid over them.
const narrowBoxes = (chips: ChipWish[], a: ChipArea, at = layChips(chips, a)): Box[] => chips.map((c, i) => ({ ...at[i], w: c.w, h: c.h }));
const insideOf = (a: ChipArea) => (b: Box) => b.x >= a.left && b.x + b.w <= a.right && b.y >= a.top && b.y + b.h <= a.bottom;

describe('oW1: edge chips in a narrow view', () => {
  test('one chip on each side of a 240 px split view does not overlap the other', () => {
    // Each chip fits on its own side; only the two columns cross. A view 600 px tall has
    // room to stack them apart.
    const area: ChipArea = { left: 0, top: 0, right: 240, bottom: 600 };
    const chips: ChipWish[] = [
      { edge: 'left', x: 0, y: 0, w: 130, h: 40 },
      { edge: 'right', x: 240, y: 0, w: 130, h: 40 },
    ];
    const bs = narrowBoxes(chips, area);
    expect(clashes(bs), JSON.stringify(bs)).toEqual([]);
    expect(bs.every(insideOf(area)), JSON.stringify(bs)).toBe(true);
  });

  test('many chips on both sides of a narrow view still keep apart and inside', () => {
    const area: ChipArea = { left: 6, top: 6, right: 246, bottom: 606 };
    const chips: ChipWish[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ edge: 'left' as const, x: 6, y: 40 + i * 60, w: 130, h: 40 })),
      ...Array.from({ length: 4 }, (_, i) => ({ edge: 'right' as const, x: 246, y: 40 + i * 60, w: 130, h: 40 })),
    ];
    const bs = narrowBoxes(chips, area);
    expect(clashes(bs), JSON.stringify(bs)).toEqual([]);
    expect(bs.every(insideOf(area)), JSON.stringify(bs)).toBe(true);
  });

  test('fuzz: narrow areas and long chips — never an overlap between chips that fit', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const edges = ['top', 'bottom', 'left', 'right'] as const;
    const out: string[] = [];
    for (let run = 0; run < 500; run++) {
      // A split view (240 to 700 px across, at least 400 tall) with chips that each fit
      // across it, and few enough that stacking them apart is always possible.
      const width = 240 + Math.floor(rand() * 460);
      const height = 400 + Math.floor(rand() * 600);
      const area: ChipArea = { left: 6, top: 6, right: 6 + width, bottom: 6 + height };
      const chips: ChipWish[] = [];
      for (const edge of edges) {
        const n = Math.floor(rand() * 4); // at most 3 on any one edge
        for (let k = 0; k < n; k++) {
          const w = 40 + rand() * (Math.min(400, width) - 40), h = 26 + rand() * 24;
          const x = edge === 'left' ? area.left : edge === 'right' ? area.right : area.left + rand() * width;
          const y = edge === 'top' ? area.top : edge === 'bottom' ? area.bottom : area.top + rand() * height;
          chips.push({ edge, x, y, w, h });
        }
      }
      const bs = narrowBoxes(chips, area);
      const cl = clashes(bs);
      // Chips that each fit inside the area must never overlap each other, whatever
      // the arrangement: the area is tall or wide enough to stack any of these sets.
      if (cl.length) out.push(`run ${run}: ${cl.length} overlapping, e.g. ${JSON.stringify(bs.filter((_, i) => cl.includes(i)).slice(0, 2))} in ${JSON.stringify(area)}`);
    }
    expect(out.slice(0, 3), `${out.length} runs`).toEqual([]);
  });
});
