// Where a walkthrough's edge chips sit (Q232; the overlap the user found, 2026-11-26).
// Each chip wants to be centred where its arrow leaves the view, on one edge of it. Chips on
// the same edge go side by side in the order of where they want to be, each as near its
// spot as the others let it; those that don't fit start a new row, further in (on the top
// and foot edges). A chip on a side goes, in the order of the spots, to the free place
// nearest its spot in the outermost column with room, clear of every chip placed before
// it, the other side's too: in a narrow view the two sides' columns cross (bug hunt T6.5,
// oW1). No two chips overlap while there is room for them.

export type Edge = 'top' | 'bottom' | 'left' | 'right';
/** A chip: its edge, the point it wants to be centred on, and its measured size. */
export interface ChipWish { edge: Edge; x: number; y: number; w: number; h: number }
/** The room the chips are kept inside, in px from the stage's top left. */
export interface ChipArea { left: number; top: number; right: number; bottom: number }
/** Space between two chips, in px. */
export const CHIP_GAP = 6;

/**
 * Starts along one line for chips in the order of their wanted starts: each as near its
 * wish as it can be, in that order, none overlapping, all within lo to hi. Null if they
 * don't fit; a single chip always fits, kept as far inside as it can be.
 */
export function packLine(want: number[], size: number[], lo: number, hi: number, gap = CHIP_GAP): number[] | null {
  const n = want.length;
  if (n === 1) return [Math.max(lo, Math.min(want[0], hi - size[0]))];
  if (size.reduce((a, b) => a + b, 0) + gap * (n - 1) > hi - lo) return null;
  const at: number[] = [];
  for (let k = 0; k < n; k++) {
    const own = Math.min(Math.max(want[k], lo), hi - size[k]);
    at.push(k ? Math.max(own, at[k - 1] + size[k - 1] + gap) : own);
  }
  for (let k = n - 1; k >= 0; k--) at[k] = Math.min(at[k], k === n - 1 ? hi - size[k] : at[k + 1] - gap - size[k]);
  return at;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * The top of a box `h` tall in the column `x` to `x + w`, nearest `want`, within lo to hi
 * and at least `gap` from every box in `boxes` that shares any of the column; null if none.
 */
function freeY(x: number, w: number, h: number, want: number, boxes: Box[], lo: number, hi: number, gap: number): number | null {
  const near = boxes.filter((b) => b.x < x + w && x < b.x + b.w);
  const clear = (y: number) => y >= lo && y + h <= hi && near.every((b) => y + h + gap <= b.y || b.y + b.h + gap <= y);
  const tries = [Math.max(lo, Math.min(want, hi - h)), ...near.flatMap((b) => [b.y - gap - h, b.y + b.h + gap])];
  const fits = tries.filter(clear).sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  return fits.length ? fits[0] : null;
}

/** Each chip's top left, in the order given. */
export function layChips(chips: ChipWish[], area: ChipArea, gap = CHIP_GAP): { x: number; y: number }[] {
  const out = chips.map(() => ({ x: 0, y: 0 }));
  const placed: (Box & { edge: Edge })[] = [];
  // The top and foot first, so the chips on the sides can keep clear of their corners.
  for (const edge of ['top', 'bottom'] as const) {
    const ids = chips.map((_, i) => i).filter((i) => chips[i].edge === edge).sort((a, b) => chips[a].x - chips[b].x);
    const pack = (row: number[]) => packLine(row.map((i) => chips[i].x - chips[i].w / 2), row.map((i) => chips[i].w), area.left, area.right, gap);
    const rows: number[][] = [];
    for (const i of ids) {
      const row = rows.find((r) => pack([...r, i]) !== null);
      if (row) row.push(i);
      else rows.push([i]);
    }
    let depth = 0;
    for (const row of rows) {
      const at = pack(row)!;
      row.forEach((i, k) => {
        const { w, h } = chips[i];
        const y = edge === 'top' ? area.top + depth : area.bottom - h - depth;
        out[i] = { x: at[k], y };
        placed.push({ edge, x: at[k], y, w, h });
      });
      depth += Math.max(...row.map((i) => chips[i].h)) + gap;
    }
  }
  for (const edge of ['left', 'right'] as const) {
    const ids = chips.map((_, i) => i).filter((i) => chips[i].edge === edge).sort((a, b) => chips[a].y - chips[b].y);
    for (const i of ids) {
      const { w, h } = chips[i];
      const xAt = (inset: number) => (edge === 'left' ? area.left + inset : area.right - w - inset);
      // The columns: at the edge, or just past a chip already on this side.
      const insets = [0, ...placed.filter((p) => p.edge === edge).map((p) => (edge === 'left' ? p.x + p.w - area.left : area.right - p.x) + gap)]
        .sort((a, b) => a - b).filter((d) => xAt(d) >= area.left && xAt(d) + w <= area.right);
      let spot = { x: xAt(0), y: Math.max(area.top, Math.min(chips[i].y - h / 2, area.bottom - h)) };
      for (const inset of insets) {
        const y = freeY(xAt(inset), w, h, chips[i].y - h / 2, placed, area.top, area.bottom, gap);
        if (y !== null) { spot = { x: xAt(inset), y }; break; }
      }
      out[i] = spot;
      placed.push({ edge, ...spot, w, h });
    }
  }
  return out;
}
