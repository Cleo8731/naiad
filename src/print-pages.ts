// A large chart printed over several pages (D6.2; the user, 2026-11-25, Q226 to Q228).
// Works out, from the chart's size and its boxes, how a print cuts it into page-sized
// parts: at what size, on which paper and which way up, and where each cut falls. No
// drawing here; `print-sheet.ts` lays the parts out.
//
// Sizes: the chart's own units are CSS px at full size (96 px = 1 inch), where node text
// is 14 px, which is 10.5 pt on paper. A print over several pages keeps that text at 8
// pt or more (Q226); fitted on one page it is whatever the fitting gives.

export type Paper = 'A4' | 'Letter';
export type Orientation = 'portrait' | 'landscape';
/** How the chart is printed (Q226): shrunk onto one page, or at a readable size over several. */
export type ChartSize = 'fit' | 'pages';

/** A rectangle in the chart's units. */
export interface Rect { x: number; y: number; w: number; h: number }

/** One page's window on the chart. */
export interface Part extends Rect { row: number; col: number }

export interface PagePlan {
  paper: Paper;
  orientation: Orientation;
  /** Printed size over full size (1 = node text at 10.5 pt). */
  scale: number;
  /** The node text's printed size, in points. */
  textPt: number;
  cols: number;
  rows: number;
  /** In reading order: across, then down. */
  parts: Part[];
}

export const PX_PER_MM = 96 / 25.4;
/** The sheet's margin on every side (`style.css`, the print block). */
export const MARGIN_MM = 14;
/** The line at the top of each part's page: the flowchart's name and "Part 2 of 7". */
export const PART_HEAD_MM = 8;
/** What neighboring parts share when a cut must go through a box (Q226). */
export const OVERLAP_MM = 10;
/** A fitted chart's tallest size on its page (`style.css`: `.print-chart svg`). */
export const FIT_HEIGHT_MM = 245;
export const FULL_PT = 10.5;
export const MIN_PT = 8;

export const PAPER_MM: Record<Paper, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4] };

/** The paper's width and height in mm, the right way up. */
export function pageMm(paper: Paper, orientation: Orientation): [number, number] {
  const [w, h] = PAPER_MM[paper];
  return orientation === 'portrait' ? [w, h] : [h, w];
}

/**
 * The scale a chart fitted on one page is printed at (as the print layout fits it: the
 * page's width less its margins, and at most 245 mm tall; never enlarged). The paper is
 * upright, as a print without a page size is.
 */
export function fitScale(chart: Rect, paper: Paper): number {
  const [pw] = pageMm(paper, 'portrait');
  const aw = (pw - 2 * MARGIN_MM) * PX_PER_MM;
  const ah = FIT_HEIGHT_MM * PX_PER_MM;
  return Math.min(1, aw / chart.w, ah / chart.h);
}

/** The node text's printed size, in points, at a scale; to one decimal. */
export function textPt(scale: number): number {
  return Math.round(FULL_PT * scale * 10) / 10;
}

/** Q227: the size a print starts on: one page while its text stays readable. */
export function defaultSize(chart: Rect, paper: Paper): ChartSize {
  return FULL_PT * fitScale(chart, paper) >= MIN_PT - 1e-9 ? 'fit' : 'pages';
}

/**
 * Where to cut one way across the chart (down or across): windows of at most `size`,
 * from `start` to `start + length`. A cut is moved back, by up to 40% of a page, to the
 * nearest place no box crosses, a few units clear of the box after it, so each box is
 * whole on one page; where there is no such place the cut goes through, and the next
 * window starts `overlap` before it, so what was cut shows on both pages.
 */
export function cuts(start: number, length: number, size: number, overlap: number, spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const end = start + length;
  const clear = 4;
  const crosses = (c: number) => spans.some(([a, b]) => a < c && c < b);
  let pos = start;
  for (let guard = 0; guard < 10_000; guard++) {
    if (end - pos <= size + 0.5) {
      // A last strip under 3% of a page with no box in it is only the drawing's blank
      // edge: it is left out rather than printed on a page of its own (seen in D6.2's
      // check, 2026-11-25: a part 1 px tall). The window before stays its page's size.
      const blank = out.length > 0 && end - pos < size * 0.03 && !spans.some(([a, b]) => b > pos && a < end);
      if (!blank) out.push([pos, end]);
      break;
    }
    const far = pos + size;
    const near = pos + size * 0.6;
    const places = [far, ...spans.map(([a]) => a - clear)].filter((c) => c >= near && c <= far && !crosses(c));
    if (places.length) {
      const c = Math.max(...places);
      out.push([pos, c]);
      pos = c;
    } else {
      out.push([pos, far]);
      pos = far - overlap;
    }
  }
  return out;
}

/** The parts for one paper, one way up. */
export function planFor(chart: Rect, boxes: Rect[], paper: Paper, orientation: Orientation): PagePlan {
  const [pw, ph] = pageMm(paper, orientation);
  const aw = (pw - 2 * MARGIN_MM) * PX_PER_MM;
  const ah = (ph - 2 * MARGIN_MM - PART_HEAD_MM - 1) * PX_PER_MM; // 1 mm spare, so a part never spills onto a page of its own
  // Full size, shrunk to the page's width while the text stays at 8 pt or more.
  const scale = Math.max(MIN_PT / FULL_PT, Math.min(1, aw / chart.w));
  const overlap = (OVERLAP_MM * PX_PER_MM) / scale;
  const across = cuts(chart.x, chart.w, aw / scale, overlap, boxes.map((b) => [b.x, b.x + b.w]));
  const down = cuts(chart.y, chart.h, ah / scale, overlap, boxes.map((b) => [b.y, b.y + b.h]));
  const parts: Part[] = [];
  down.forEach(([y0, y1], row) => across.forEach(([x0, x1], col) => parts.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, row, col })));
  return { paper, orientation, scale, textPt: textPt(scale), cols: across.length, rows: down.length, parts };
}

/**
 * Q228: the parts on this paper, the way up that needs the fewest pages; between two
 * that need as many, the one with fewer columns (one column is read straight down, with
 * nothing to lay side by side), then upright.
 */
export function bestPlan(chart: Rect, boxes: Rect[], paper: Paper): PagePlan {
  const up = planFor(chart, boxes, paper, 'portrait');
  const side = planFor(chart, boxes, paper, 'landscape');
  if (side.parts.length !== up.parts.length) return side.parts.length < up.parts.length ? side : up;
  return side.cols < up.cols ? side : up;
}

/** Q228: the paper of a region, from its code ("US"): Letter in the Americas that use it, A4 elsewhere. */
export function paperOfRegion(region: string | undefined): Paper {
  return ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PR'].includes((region ?? '').toUpperCase()) ? 'Letter' : 'A4';
}
