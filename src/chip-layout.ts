// Where a walkthrough's edge chips sit (Q232; the overlap the user found, 2026-11-26).
// Each chip wants to be centred where its arrow leaves the view, on one edge of it. Chips on
// the same edge go side by side in the order of where they want to be, each as near its
// spot as the others let it; those that don't fit start a new row (on the top and foot
// edges) or column (on the sides), further in. No two chips overlap.

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

/** Each chip's top left, in the order given. */
export function layChips(chips: ChipWish[], area: ChipArea, gap = CHIP_GAP): { x: number; y: number }[] {
  const out = chips.map(() => ({ x: 0, y: 0 }));
  const placed: { edge: Edge; x: number; y: number; w: number; h: number }[] = [];
  // The top and foot first, so a column on a side can keep clear of their corners.
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    const along = edge === 'top' || edge === 'bottom';
    const ids = chips.map((_, i) => i).filter((i) => chips[i].edge === edge)
      .sort((a, b) => (along ? chips[a].x - chips[b].x : chips[a].y - chips[b].y));
    if (!ids.length) continue;
    let lo = along ? area.left : area.top;
    let hi = along ? area.right : area.bottom;
    if (!along) {
      const wide = Math.max(...ids.map((i) => chips[i].w));
      const x0 = edge === 'left' ? area.left : area.right - wide;
      for (const p of placed) {
        if (p.x >= x0 + wide || p.x + p.w <= x0) continue;
        if (p.edge === 'top') lo = Math.max(lo, p.y + p.h + gap);
        else hi = Math.min(hi, p.y - gap);
      }
    }
    const want = (i: number) => (along ? chips[i].x - chips[i].w / 2 : chips[i].y - chips[i].h / 2);
    const size = (i: number) => (along ? chips[i].w : chips[i].h);
    const pack = (row: number[]) => packLine(row.map(want), row.map(size), lo, hi, gap);
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
        const x = along ? at[k] : edge === 'left' ? area.left + depth : area.right - w - depth;
        const y = !along ? at[k] : edge === 'top' ? area.top + depth : area.bottom - h - depth;
        out[i] = { x, y };
        placed.push({ edge, x, y, w, h });
      });
      depth += Math.max(...row.map((i) => (along ? chips[i].h : chips[i].w))) + gap;
    }
  }
  return out;
}
