// Direction marks (D1.8, the user, 2026-11-14): small arrowheads along a long arrow, in
// its own color, so the middle of an arrow says which way it goes and the reader need
// not find one of its ends. Added to Mermaid's drawing after it is made, like the
// rounder bends (`chart.ts`, `index`). Drawing only: nothing is written into the file.

export type Box = { left: number; top: number; right: number; bottom: number };
/** One mark: where its middle sits, and the way the arrow goes there (a unit vector). */
export type Mark = { x: number; y: number; dx: number; dy: number };
type Point = { x: number; y: number };

/** An arrow shorter than this, in chart pixels, gets no marks: both its ends are near. */
export const MARKS_FROM = 250;
/** About how far apart the marks are along an arrow, and from its ends. */
export const MARK_EVERY = 150;
/** No mark nearer than this to either end, where the source and the arrowhead are. */
const END_CLEAR = 50;
/** No mark nearer than this to a bend or a gap, so each sits on a straight run. */
const BEND_CLEAR = 10;
/** How far a mark may move from its even place to find a straight run, at most. */
const MOVE_AT_MOST = MARK_EVERY * 0.4;
/** Half a mark's depth along the arrow and half its width across it. */
const HALF_DEPTH = 3.5;
const HALF_WIDTH = 5;
/** Room kept between a mark and an arrow label. */
const LABEL_CLEAR = HALF_DEPTH + 3;

/** A piece of the drawn arrow, `from` px along it; curves are cut into short pieces. */
type Run = { a: Point; b: Point; from: number; length: number; straight: boolean };

/**
 * The drawn pieces of an arrow's path, in order: straight runs (L) and curves (Q, C). A
 * gap where the arrow crosses another (a new M) is not drawn and adds no length. Null
 * for any other path.
 */
function runsOf(d: string): Run[] | null {
  const parts = d.match(/[A-Za-z][^A-Za-z]*/g);
  if (!parts) return null;
  const runs: Run[] = [];
  let at: Point | null = null;
  let from = 0;
  const to = (start: Point, b: Point, straight: boolean): Point => {
    const length = Math.hypot(b.x - start.x, b.y - start.y);
    if (length > 0) { runs.push({ a: start, b, from, length, straight }); from += length; }
    return b;
  };
  for (const part of parts) {
    const n = part.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (!n.every(Number.isFinite)) return null;
    if (part[0] === 'M' && n.length === 2) { at = { x: n[0], y: n[1] }; continue; }
    if (!at) return null;
    const s: Point = at;
    if (part[0] === 'L' && n.length >= 2 && n.length % 2 === 0) {
      for (let i = 0; i < n.length; i += 2) at = to(at, { x: n[i], y: n[i + 1] }, true);
    } else if (part[0] === 'Q' && n.length === 4) {
      for (let k = 1; k <= 8; k++) {
        const t = k / 8, u = 1 - t;
        at = to(at, { x: u * u * s.x + 2 * u * t * n[0] + t * t * n[2], y: u * u * s.y + 2 * u * t * n[1] + t * t * n[3] }, false);
      }
    } else if (part[0] === 'C' && n.length === 6) {
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        at = to(at, { x: w[0] * s.x + w[1] * n[0] + w[2] * n[2] + w[3] * n[4], y: w[0] * s.y + w[1] * n[1] + w[2] * n[3] + w[3] * n[5] }, false);
      }
    } else return null;
  }
  return runs;
}

/** The stretch of a straight run, in px along the arrow, that passes through `box`. */
function through(run: Run, box: Box): [number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = run.b.x - run.a.x, dy = run.b.y - run.a.y;
  // Keeps the part of the run where p * t <= q (Liang and Barsky's clipping).
  const keep = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; t0 = Math.max(t0, r); } else { if (r < t0) return false; t1 = Math.min(t1, r); }
    return true;
  };
  const ok = keep(-dx, run.a.x - (box.left - LABEL_CLEAR)) && keep(dx, box.right + LABEL_CLEAR - run.a.x)
    && keep(-dy, run.a.y - (box.top - LABEL_CLEAR)) && keep(dy, box.bottom + LABEL_CLEAR - run.a.y);
  return ok ? [run.from + t0 * run.length, run.from + t1 * run.length] : null;
}

/**
 * Where an arrow's marks sit: evenly spaced, about every `MARK_EVERY` px, on any arrow at
 * least `MARKS_FROM` px long (gaps not counted). Each sits on a straight run, clear of
 * the arrow's ends, its bends, its gaps and the labels in `avoid`; one that cannot find
 * such a place near its even place is left out.
 */
export function marksAlong(d: string, avoid: Box[] = []): Mark[] {
  const runs = runsOf(d);
  if (!runs?.length) return [];
  const total = runs[runs.length - 1].from + runs[runs.length - 1].length;
  if (total < MARKS_FROM) return [];
  const free = runs.filter((run) => run.straight).flatMap((run) => {
    let spans: [number, number][] = [[Math.max(run.from + BEND_CLEAR, END_CLEAR), Math.min(run.from + run.length - BEND_CLEAR, total - END_CLEAR)]];
    for (const box of avoid) {
      const cut = through(run, box);
      if (cut) spans = spans.flatMap(([lo, hi]): [number, number][] => [[lo, Math.min(hi, cut[0])], [Math.max(lo, cut[1]), hi]]);
    }
    return spans.filter(([lo, hi]) => hi >= lo).map(([lo, hi]) => ({ run, lo, hi }));
  });
  const count = Math.max(1, Math.round(total / MARK_EVERY) - 1);
  const marks: Mark[] = [];
  let last = -Infinity;
  for (let k = 1; k <= count; k++) {
    const want = (total * k) / (count + 1);
    let best: { run: Run; at: number } | null = null;
    for (const { run, lo, hi } of free) {
      const at = Math.min(hi, Math.max(lo, want));
      if (!best || Math.abs(at - want) < Math.abs(best.at - want)) best = { run, at };
    }
    if (!best || Math.abs(best.at - want) > MOVE_AT_MOST || best.at - last < MARK_EVERY / 2) continue;
    last = best.at;
    const { run } = best;
    const t = (best.at - run.from) / run.length;
    const dx = (run.b.x - run.a.x) / run.length, dy = (run.b.y - run.a.y) / run.length;
    marks.push({ x: run.a.x + (run.b.x - run.a.x) * t, y: run.a.y + (run.b.y - run.a.y) * t, dx, dy });
  }
  return marks;
}

/** The marks drawn as chevrons (">"), each pointing the way the arrow goes, as one path. */
export function chevrons(marks: Mark[]): string {
  const at = (x: number, y: number) => `${String(Math.round(x * 100) / 100)},${String(Math.round(y * 100) / 100)}`;
  return marks.map(({ x, y, dx, dy }) => {
    const bx = x - dx * HALF_DEPTH, by = y - dy * HALF_DEPTH;
    return `M${at(bx - dy * HALF_WIDTH, by + dx * HALF_WIDTH)}L${at(x + dx * HALF_DEPTH, y + dy * HALF_DEPTH)}L${at(bx + dy * HALF_WIDTH, by - dx * HALF_WIDTH)}`;
  }).join('');
}

/** A `translate(x, y)` attribute's two numbers; 0, 0 when there is none. */
function shift(el: Element | null): Point {
  const m = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/.exec(el?.getAttribute('transform') ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

/** The boxes of the arrow labels Mermaid drew, from their positions and sizes. */
function labelBoxes(svg: SVGSVGElement): Box[] {
  return [...svg.querySelectorAll('g.edgeLabel')].flatMap((g) => {
    const inner = g.querySelector('g.label');
    const box = inner?.querySelector('foreignObject');
    const w = Number(box?.getAttribute('width')), h = Number(box?.getAttribute('height'));
    if (!(w > 0 && h > 0)) return [];
    const a = shift(g), b = shift(inner);
    const left = a.x + b.x, top = a.y + b.y;
    return [{ left, top, right: left + w, bottom: top + h }];
  });
}

/**
 * Adds the marks to every long arrow Naiad knows (`data-edge-line`) that has one
 * direction: an end marker (an arrowhead, a circle or a cross) and no start marker. One
 * path per arrow, just after it, so the stylesheet can give it the arrow's look
 * (`path.sel + path.dir-mark`); it takes the arrow's classes, for the theme's color,
 * and the color of a `linkStyle`.
 */
export function addDirectionMarks(svg: SVGSVGElement): void {
  const labels = labelBoxes(svg);
  svg.querySelectorAll<SVGPathElement>('path[data-edge-line]').forEach((line) => {
    if (!line.getAttribute('marker-end') || line.getAttribute('marker-start')) return;
    const marks = marksAlong(line.getAttribute('d') ?? '', labels);
    if (!marks.length) return;
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mark.setAttribute('d', chevrons(marks));
    mark.setAttribute('class', `${line.getAttribute('class') ?? ''} dir-mark`.trim());
    const stroke = /(?:^|;)\s*stroke\s*:\s*([^;!]+)/.exec(line.getAttribute('style') ?? '')?.[1].trim();
    if (stroke) mark.setAttribute('style', `stroke:${stroke}`);
    line.after(mark);
  });
}
