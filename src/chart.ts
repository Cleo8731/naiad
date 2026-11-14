// The chart view: draws the file with Mermaid's own engine, then maps the drawing back
// to the file's nodes, arrows and groups so they can be clicked, selected and connected.

import mermaid from 'mermaid';
import { forMermaid, type Snap } from './semantics';
import { parseDoc } from './core/scan';

export type Target =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; index: number }
  | { kind: 'sub'; id: string };

export interface ChartEvents {
  onSelect(target: Target | null): void;
  /** A click on an item while the Highlight switch is on. */
  onHighlight(target: Target): void;
  onConnect(from: string, to: string): void;
  onMoveEnd(index: number, end: 'start' | 'end', id: string): void;
  onAddNode(): void;
  onRename(target: Target): void;
  /** An edit tried on the chart in View mode (a double-click, a Shift-click that would connect). */
  onBlocked(): void;
}

/** Rounder corners (the user, 2026-11-13): a rounded node's corners and an arrow's bends, in px. */
const ROUNDED_NODE_RADIUS = 14;
const BEND_RADIUS = 14;

/** Nunito (the user, 2026-11-13), bundled in `src/fonts/` and declared in `style.css`. */
export const CHART_FONT = 'Nunito, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';

/**
 * Mermaid sizes each box by measuring its label as it draws, so the font must have
 * loaded first, or the boxes fit the fallback font. Once loaded, this returns at once.
 */
async function fontLoaded(): Promise<void> {
  if (!('fonts' in document)) return; // jsdom
  try { await document.fonts.load('14px Nunito'); } catch { /* drawn in the fallback font */ }
}

export function configureMermaid(dark: boolean): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    look: 'classic',
    // `radius` rounds the corners of a rounded node, `id(Title)`; a square node's corners
    // and a group's are rounded less, in `style.css`, so the two shapes stay apart.
    themeVariables: dark
      ? {
        darkMode: true, radius: ROUNDED_NODE_RADIUS, fontFamily: CHART_FONT, fontSize: '14px', background: '#16181c',
        primaryColor: '#262a31', primaryTextColor: '#e8eaed', primaryBorderColor: '#5b6472',
        lineColor: '#8a93a1', textColor: '#e8eaed', clusterBkg: '#1c1f25', clusterBorder: '#3a414c',
        edgeLabelBackground: '#16181c', titleColor: '#aeb6c2',
      }
      : {
        radius: ROUNDED_NODE_RADIUS, fontFamily: CHART_FONT, fontSize: '14px', background: '#f6f7f9',
        primaryColor: '#ffffff', primaryTextColor: '#1c2026', primaryBorderColor: '#9aa3b0',
        lineColor: '#6b7482', textColor: '#1c2026', clusterBkg: '#eef0f4', clusterBorder: '#c9ced6',
        edgeLabelBackground: '#f6f7f9', titleColor: '#4a5362',
      },
    flowchart: { useMaxWidth: false, htmlLabels: true, padding: 14, nodeSpacing: 44, rankSpacing: 52 },
    // Gaps at crossings (the user, 2026-11-13): where two arrows cross, Mermaid's layout
    // (ELK, its default) cuts a short gap in one, as on road maps, instead of its own
    // default, a small hop. Drawing only; a file's own `elk` settings still win.
    elk: { lineHops: 'gap' },
  });
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
/** How much one wheel event changes the zoom, per unit of its deltaY: a mouse wheel's
 * notch is 100, so a plain notch zooms e^0.16, 17.4%. A Ctrl-marked event is a pinch
 * (or Ctrl held), which a browser that takes the pinch itself sends as many small
 * events; 0.01 makes the chart follow the fingers. */
const WHEEL_ZOOM = 0.0016;
const PINCH_ZOOM = 0.01;
/** The most one Ctrl-marked event may zoom: one plain notch. Codex's browser pane sends
 * each pinch step as a whole notch (deltaY 100), which without this zoomed 2.7 times;
 * a smooth pinch's events stay under it (T1.12, 2026-11-13). */
const MOST_PINCH_STEP = 100 * WHEEL_ZOOM;
/** A wheel event that zooms more than GLIDE_FROM (as the natural log of its factor, 0.05
 * is 5%) glides there over a few frames instead of jumping in one: each frame covers
 * part of what is left, so after GLIDE_TIME ms 63% is done and after 3 × GLIDE_TIME 95%.
 * A notch (17.4%) is 95% done after 150 ms and done after about 220 ms; no frame moves
 * more than half a notch, even with three notches in 80 ms. A smooth pinch's small
 * events zoom at once, so the chart follows the fingers (T1.12: the user found a notch's
 * one-frame jump choppy). */
const GLIDE_FROM = 0.05;
const GLIDE_TIME = 50;
/** The border strip (T1.8): its width in px, and the view's top speed in px a second. */
const BORDER_STRIP = 48;
const BORDER_SPEED = 1200;
let drawCount = 0;

type Point = { x: number; y: number };
type End = 'start' | 'end';

/** Velocity of the view in stage pixels per second, towards the chart under the pointer. */
export function edgePanSpeed(point: Point, rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, strip: number, topSpeed: number): Point {
  if (strip <= 0) return { x: 0, y: 0 };
  const axis = (p: number, low: number, high: number) =>
    topSpeed * (Math.max(0, Math.min(1, (low + strip - p) / strip)) - Math.max(0, Math.min(1, (p - high + strip) / strip)));
  return { x: axis(point.x, rect.left, rect.right), y: axis(point.y, rect.top, rect.bottom) };
}

/**
 * How far the border strip moves the view along one axis this frame: `step` as asked,
 * but only until the chart's edge on the side being shown is `pad` inside the stage, so
 * the view never runs on into empty space. `offset` is where the chart starts in the
 * stage, `extent` its drawn size, `room` the stage's size.
 */
export function panStep(step: number, offset: number, extent: number, room: number, pad: number): number {
  if (step > 0) return Math.min(step, Math.max(0, pad - offset));
  if (step < 0) return Math.max(step, Math.min(0, room - pad - (offset + extent)));
  return 0;
}

/** SVG geometry interprets all path commands and returns the actual endpoints of the drawn path. */
export function pathEnds(path: { getTotalLength(): number; getPointAtLength(distance: number): Point }): { start: Point; end: Point } | null {
  try {
    const length = path.getTotalLength();
    const start = path.getPointAtLength(0);
    const end = path.getPointAtLength(length);
    if (![length, start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
    return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
  } catch { return null; }
}

/**
 * Redraws the bends of an arrow drawn with Mermaid's "rounded" curve (straight runs, each
 * bend a quadratic curve 5 px across, its control point the corner) with a larger
 * radius, never more than half of either run beside the bend. The ends stay where they
 * are, so the arrowheads do too. An arrow cut by gaps at crossings is several pieces,
 * each starting with M; each is rounded on its own, so the gaps stay where they are. Any
 * other path is returned as it is.
 */
export function roundBends(d: string, radius: number): string {
  const pieces = d.match(/M[^M]*/g);
  if (pieces && pieces.length > 1 && pieces.join('') === d) return pieces.map((piece) => roundBends(piece, radius)).join('');
  const parts = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!parts) return d;
  const corners: Point[] = [];
  let first: Point | null = null;
  let last: Point | null = null;
  for (const part of parts) {
    const n = part.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (!n.every(Number.isFinite)) return d;
    if (part[0] === 'M' && n.length === 2 && !first) first = last = { x: n[0], y: n[1] };
    else if (part[0] === 'L' && n.length === 2 && first) last = { x: n[0], y: n[1] };
    else if (part[0] === 'Q' && n.length === 4 && first) { corners.push({ x: n[0], y: n[1] }); last = { x: n[2], y: n[3] }; }
    else return d;
  }
  if (!first || !last || !corners.length) return d;
  const at = (p: Point) => `${String(Math.round(p.x * 1000) / 1000)},${String(Math.round(p.y * 1000) / 1000)}`;
  const points = [first, ...corners, last];
  let out = `M${at(first)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const into = Math.hypot(b.x - a.x, b.y - a.y);
    const away = Math.hypot(c.x - b.x, c.y - b.y);
    if (!into || !away) { out += `L${at(b)}`; continue; }
    const r = Math.min(radius, into / 2, away / 2);
    const from = { x: b.x + ((a.x - b.x) * r) / into, y: b.y + ((a.y - b.y) * r) / into };
    const to = { x: b.x + ((c.x - b.x) * r) / away, y: b.y + ((c.y - b.y) * r) / away };
    out += `L${at(from)}Q${at(b)} ${at(to)}`;
  }
  return `${out}L${at(last)}`;
}

/** A connect handle and two end handles, shown for one item at a time: its owner. */
type Handles = { connect: HTMLButtonElement; ends: Record<End, HTMLButtonElement>; owner: Target | null };

type Drag = {
  pointerId: number; set: Handles; button: HTMLButtonElement; origin: Point; pointer: Point; fixed: Point;
  line: SVGLineElement; kind: 'connect' | 'end'; id: string; index?: number; end?: End;
};

/** How long an item's handles stay after the pointer leaves it, so the pointer can reach them, in ms. */
const HOVER_GRACE = 400;

const sameTarget = (a: Target | null, b: Target | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Trace on hover (the user, 2026-11-13): how long the pointer rests before the rest fades, in ms. */
const TRACE_REST = 150;

/**
 * Trace on hover: what stays lit while the pointer rests on an item, the rest fading. A
 * node: its arrows and the nodes at their other ends. An arrow: it and its two ends. A
 * group: the arrows that end at the group itself, their other ends, and its own nodes.
 * Null when there is nothing to trace (no arrows), so a lone item fades nothing.
 */
export function traceOf(t: Target, snap: Pick<Snap, 'edges' | 'subs'>): { ids: Set<string>; edges: Set<number> } | null {
  if (t.kind === 'edge') {
    const e = snap.edges[t.index];
    return e ? { ids: new Set([e.start, e.end]), edges: new Set([t.index]) } : null;
  }
  const ids = new Set([t.id, ...(t.kind === 'sub' ? snap.subs[t.id]?.nodes ?? [] : [])]);
  const edges = new Set<number>();
  snap.edges.forEach((e, i) => {
    if (e.start !== t.id && e.end !== t.id) return;
    edges.add(i);
    ids.add(e.start);
    ids.add(e.end);
  });
  return edges.size ? { ids, edges } : null;
}

export class Chart {
  private canvas: HTMLDivElement;
  private overlay: SVGSVGElement;
  /**
   * Two sets of handles: one for the selected item, one for the item under the pointer
   * (the user, 2026-11-13), so a drag can start without a click first, and the selected
   * arrow keeps its end handles while the pointer crosses a node on its way to them.
   */
  private sets: { sel: Handles; hover: Handles };
  /** The item under the pointer: its handles show, and it is lit softly (`.hov`). */
  private hovered: Target | null = null;
  private lit: Target | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** The group the pointer is on while the grace runs out (`leaveSoon`). */
  private leavingTo: Target | null = null;
  /** Trace on hover: the item traced, and the rest before the trace follows the pointer. */
  private traced: Target | null = null;
  private traceTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitSubs = new Set<string>();
  private drag: Drag | null = null;
  private frame: number | null = null;
  private frameTime: number | null = null;
  /** A wheel zoom gliding to its goal: the zoom `k` it is going to, about the point
   * (x, y) in the chart's area, and its frame (`wheelZoom`). */
  private glide: { k: number; x: number; y: number; time: number | null; frame: number } | null = null;
  private observer: ResizeObserver | null = null;
  // Escape during a drag cancels only the drag: the app's own Escape (letting go of the
  // selection) is not reached.
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.drag) { e.preventDefault(); e.stopPropagation(); this.cancelDrag(); }
  };
  // With the pointer past the chart's border during a drag, the wheel still zooms the
  // chart. Listened to only while a drag is under way, so scrolling elsewhere in the
  // window never waits on it.
  private onOutsideWheel = (e: WheelEvent) => {
    if (this.drag && e.target instanceof Node && !this.stage.contains(e.target)) this.wheelZoom(e);
  };
  private view = { x: 0, y: 0, k: 1 };
  private size = { w: 0, h: 0 };
  private selected: Target | null = null;
  private highlighted: Target[] = [];
  /** While the Highlight switch is on, a click highlights instead of selecting. */
  private highlighting = false;
  /** View mode (D4.3, T1.11): no handles, no dot grid, and the chart's edits turned off. */
  private viewing = false;
  private snap: Snap | null = null;
  private fitted = false;
  /** True once the user has panned or zoomed; until then each redraw is fitted again. */
  private manual = false;
  private moved = false;

  constructor(private stage: HTMLElement, private events: ChartEvents) {
    this.canvas = document.createElement('div');
    this.canvas.className = 'canvas';
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('class', 'overlay');
    const handles = (): Handles => {
      const connect = document.createElement('button');
      connect.className = 'connect-handle';
      connect.title = 'Drag to another node to connect';
      connect.setAttribute('aria-label', 'Connect to another node');
      connect.hidden = true;
      const ends = Object.fromEntries((['start', 'end'] as const).map((end) => {
        const button = document.createElement('button');
        button.className = 'end-handle';
        button.title = `Move the arrow's ${end}`;
        button.setAttribute('aria-label', button.title);
        button.hidden = true;
        return [end, button];
      })) as Record<End, HTMLButtonElement>;
      return { connect, ends, owner: null };
    };
    this.sets = { sel: handles(), hover: handles() };
    stage.append(this.canvas, this.overlay, ...this.buttons());
    this.bind();
  }

  private buttons(set?: Handles): HTMLButtonElement[] {
    return (set ? [set] : [this.sets.sel, this.sets.hover]).flatMap((s) => [s.connect, s.ends.start, s.ends.end]);
  }

  /** Call when another file is opened, so the next drawing is fitted to the window. */
  resetView(): void { this.fitted = false; }

  async draw(text: string, snap: Snap): Promise<void> {
    this.cancelDrag();
    const id = `chart${++drawCount}`;
    await fontLoaded();
    const { svg } = await mermaid.render(id, forMermaid(text));
    this.cancelDrag();
    this.canvas.innerHTML = svg;
    this.snap = snap;
    this.explicitSubs = new Set(parseDoc(text.replace(/\r\n?/g, '\n')).subs.filter((sub) => sub.explicitId).map((sub) => sub.id));
    const el = this.canvas.querySelector('svg');
    if (!el) return;
    const box = el.viewBox.baseVal;
    this.size = { w: box.width, h: box.height };
    el.setAttribute('width', String(box.width));
    el.setAttribute('height', String(box.height));
    el.style.maxWidth = 'none';
    this.index(el, id, snap);
    if (!this.fitted || !this.manual) { this.fit(); this.fitted = true; }
    this.paintSelection();
    this.paintHighlights();
    this.paintTrace();
  }

  clear(): void {
    this.cancelDrag();
    this.canvas.innerHTML = '';
    this.snap = null;
    this.stopLeaving();
    this.trace(null);
    this.hovered = this.lit = null;
    for (const button of this.buttons()) button.hidden = true;
  }

  /** Release observers and active drag work when the chart is discarded. */
  destroy(): void {
    this.clear();
    this.stopGlide();
    this.observer?.disconnect();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('wheel', this.onOutsideWheel);
  }

  private index(svg: SVGSVGElement, id: string, snap: Snap): void {
    const nodePrefix = `${id}-flowchart-`;
    svg.querySelectorAll<SVGGElement>('g.node').forEach((g) => {
      if (!g.id.startsWith(nodePrefix)) return;
      const nodeId = g.id.slice(nodePrefix.length).replace(/-\d+$/, '');
      if (nodeId in snap.nodes) g.dataset.node = nodeId;
    });
    svg.querySelectorAll<SVGGElement>('g.cluster').forEach((g) => {
      const subId = g.id.startsWith(`${id}-`) ? g.id.slice(id.length + 1) : g.id;
      if (subId in snap.subs) g.dataset.sub = subId;
    });
    svg.querySelectorAll<SVGPathElement>('path[data-edge="true"]').forEach((p) => {
      const d = p.getAttribute('d');
      if (d) p.setAttribute('d', roundBends(d, BEND_RADIUS));
      const i = snap.edgeIds.indexOf(p.dataset.id ?? '');
      if (i < 0) return;
      p.dataset.edgeLine = String(i);
      // Arrows are thin; a wide invisible copy on top makes them easy to click.
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', p.getAttribute('d') ?? '');
      hit.setAttribute('class', 'edge-hit');
      hit.dataset.edge = String(i);
      p.after(hit);
    });
    svg.querySelectorAll<SVGGElement>('g.edgeLabel').forEach((g) => {
      const i = snap.edgeIds.indexOf(g.querySelector<SVGGElement>('[data-id]')?.dataset.id ?? '');
      if (i >= 0) g.dataset.edge = String(i);
    });
  }

  private targetAt(el: Element | null): Target | null {
    const hit = el?.closest<HTMLElement>('[data-node],[data-edge],[data-sub]');
    if (!hit || !this.canvas.contains(hit)) return null;
    if (hit.dataset.node !== undefined) return { kind: 'node', id: hit.dataset.node };
    if (hit.dataset.edge !== undefined) return { kind: 'edge', index: Number(hit.dataset.edge) };
    return { kind: 'sub', id: hit.dataset.sub! };
  }

  private elementOf(t: Target): Element | null {
    if (t.kind === 'node') return this.canvas.querySelector(`[data-node="${CSS.escape(t.id)}"]`);
    if (t.kind === 'sub') return this.canvas.querySelector(`[data-sub="${CSS.escape(t.id)}"]`);
    return this.canvas.querySelector(`[data-edge-line="${t.index}"]`);
  }

  select(target: Target | null): void {
    // The app paints (and so selects again) for reasons of its own, such as a save; only
    // a different item ends a drag.
    if (!sameTarget(target, this.selected)) this.cancelDrag();
    this.selected = target;
    this.paintSelection();
  }

  private paintSelection(): void {
    this.canvas.querySelectorAll('.sel').forEach((e) => e.classList.remove('sel'));
    const el = this.selected ? this.elementOf(this.selected) : null;
    el?.classList.add('sel');
    this.light(this.lit);
    this.placeHandles();
  }

  /** Lights the item under the pointer softly, as a lighter kind of selection. */
  private light(t: Target | null): void {
    this.lit = t;
    this.canvas.querySelectorAll('.hov').forEach((e) => e.classList.remove('hov'));
    if (t) this.elementOf(t)?.classList.add('hov');
  }

  /** Trace on hover follows the pointer after a short rest, so crossing the chart does not flicker. */
  private traceSoon(t: Target | null): void {
    if (this.traceTimer !== null) clearTimeout(this.traceTimer);
    this.traceTimer = null;
    if (sameTarget(t, this.traced)) return;
    this.traceTimer = setTimeout(() => this.trace(t), TRACE_REST);
  }

  private trace(t: Target | null): void {
    if (this.traceTimer !== null) clearTimeout(this.traceTimer);
    this.traceTimer = null;
    if (sameTarget(t, this.traced)) return;
    this.traced = t;
    this.paintTrace();
  }

  private paintTrace(): void {
    this.canvas.querySelectorAll('.lit').forEach((e) => e.classList.remove('lit'));
    const lit = this.traced && this.snap ? traceOf(this.traced, this.snap) : null;
    this.stage.classList.toggle('tracing', !!lit);
    if (lit) {
      for (const id of lit.ids) {
        this.canvas.querySelector(`[data-node="${CSS.escape(id)}"]`)?.classList.add('lit');
        this.canvas.querySelector(`[data-sub="${CSS.escape(id)}"]`)?.classList.add('lit');
      }
      for (const i of lit.edges) {
        this.canvas.querySelector(`[data-edge-line="${i}"]`)?.classList.add('lit');
        this.canvas.querySelector(`g.edgeLabel[data-edge="${i}"]`)?.classList.add('lit');
      }
    }
  }

  private hover(t: Target): void {
    this.stopLeaving();
    this.light(t);
    this.traceSoon(t);
    if (sameTarget(t, this.hovered)) return;
    this.hovered = t;
    this.placeHandles();
  }

  /**
   * The pointer left the item for empty space, or for a group (`next`): the light goes at
   * once, the handles after the grace, and then the group, if the pointer is still on it,
   * is hovered. Into a group the trace stays with the item until then.
   */
  private leaveSoon(next: Target | null): void {
    this.light(null);
    this.leavingTo = next;
    if (!next) this.traceSoon(null);
    if (this.hoverTimer !== null || !this.hovered) return;
    this.hoverTimer = setTimeout(() => {
      const to = this.leavingTo;
      this.hoverTimer = null;
      this.leavingTo = null;
      this.hovered = null;
      if (to) this.hover(to);
      else this.placeHandles();
    }, HOVER_GRACE);
  }

  private stopLeaving(): void {
    if (this.hoverTimer !== null) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.leavingTo = null;
  }

  setHighlighting(on: boolean): void {
    if (on) this.cancelDrag();
    this.highlighting = on;
    this.stage.classList.toggle('highlighting', on);
    this.placeHandles();
  }

  /** View mode: a drag under way ends, the handles go, and so does the dot grid (`.stage.viewing`). */
  setViewing(on: boolean): void {
    if (on) this.cancelDrag();
    this.viewing = on;
    this.stage.classList.toggle('viewing', on);
    this.placeHandles();
  }

  /** Draws the highlights (D2.4): the items named in the highlights file. */
  setHighlights(targets: Target[]): void {
    this.highlighted = targets;
    this.paintHighlights();
  }

  private paintHighlights(): void {
    this.canvas.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
    for (const t of this.highlighted) {
      this.elementOf(t)?.classList.add('hl');
      if (t.kind === 'edge') this.canvas.querySelector(`g.edgeLabel[data-edge="${t.index}"]`)?.classList.add('hl');
    }
  }

  private allowed(t: { kind: 'node' | 'sub'; id: string }): boolean {
    return t.kind === 'node' || this.explicitSubs.has(t.id);
  }

  private pathPoints(t: Target | null): { start: Point; end: Point } | null {
    if (t?.kind !== 'edge') return null;
    const path = this.elementOf(t) as SVGPathElement | null;
    const points = path?.getAttribute('d') ? pathEnds(path) : null;
    const matrix = points ? path?.getScreenCTM() : null;
    if (!points || !matrix) return null;
    const convert = (p: Point): Point => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f });
    return { start: convert(points.start), end: convert(points.end) };
  }

  private placeHandles(): void {
    const s = this.stage.getBoundingClientRect();
    const owners = { sel: this.selected, hover: sameTarget(this.hovered, this.selected) ? null : this.hovered };
    for (const key of ['sel', 'hover'] as const) {
      const set = this.sets[key];
      if (this.drag?.set !== set) set.owner = owners[key]; // the set being dragged keeps its item
      const owner = this.highlighting || this.viewing ? null : set.owner;
      const el = owner && owner.kind !== 'edge' && this.allowed(owner) ? this.elementOf(owner) : null;
      set.connect.hidden = !el;
      if (el) {
        const r = el.getBoundingClientRect();
        set.connect.style.left = `${r.right - s.left + 6}px`;
        set.connect.style.top = `${r.top - s.top + r.height / 2 - 11}px`;
      }
      const points = this.pathPoints(owner);
      for (const end of ['start', 'end'] as const) {
        const button = set.ends[end];
        button.hidden = !points;
        if (points) {
          button.style.left = `${points[end].x - s.left - 9}px`;
          button.style.top = `${points[end].y - s.top - 9}px`;
        }
      }
    }
  }

  private refreshDrag(): void {
    const d = this.drag;
    if (!d) return;
    const s = this.stage.getBoundingClientRect();
    const { x, y, k } = this.view;
    d.line.setAttribute('x1', String(d.fixed.x * k + x));
    d.line.setAttribute('y1', String(d.fixed.y * k + y));
    d.line.setAttribute('x2', String(d.pointer.x - s.left));
    d.line.setAttribute('y2', String(d.pointer.y - s.top));
    this.canvas.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
    const target = this.dropTarget(d.pointer.x, d.pointer.y);
    if (target) this.elementOf(target)?.classList.add('drop');
  }

  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.frameTime = null;
    document.removeEventListener('wheel', this.onOutsideWheel);
    if (d) {
      d.line.remove();
      if (d.button.hasPointerCapture(d.pointerId)) d.button.releasePointerCapture(d.pointerId);
    }
    this.canvas.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
  }

  private beginDrag(e: PointerEvent, set: Handles, button: HTMLButtonElement, fixedClient: Point, kind: Drag['kind'], id: string, index?: number, end?: End): void {
    if (e.button !== 0 || this.drag || this.viewing) return;
    e.preventDefault();
    e.stopPropagation();
    this.trace(null);
    const s = this.stage.getBoundingClientRect();
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this.overlay.append(line);
    this.drag = { pointerId: e.pointerId, set, button, origin: { x: e.clientX, y: e.clientY }, pointer: { x: e.clientX, y: e.clientY },
      fixed: { x: (fixedClient.x - s.left - this.view.x) / this.view.k, y: (fixedClient.y - s.top - this.view.y) / this.view.k }, line, kind, id, index, end };
    button.setPointerCapture(e.pointerId);
    document.addEventListener('wheel', this.onOutsideWheel, { passive: false });
    this.refreshDrag();
    // The border strip (T1.8): each frame, with the pointer in a strip 48 px wide along
    // the chart's border or past it, the view moves that way, up to 1,200 px a second,
    // until the chart's edge on that side is in view (`panStep`). `apply` puts the dashed
    // line and the marked target right; a pointer move or the wheel does the same on its
    // own.
    const tick = (time: number) => {
      const d = this.drag;
      if (!d) return;
      if (this.frameTime !== null) {
        const s = this.stage.getBoundingClientRect();
        const speed = edgePanSpeed(d.pointer, s, BORDER_STRIP, BORDER_SPEED);
        const dt = Math.min(0.05, (time - this.frameTime) / 1000); // no leap after a stalled frame
        const { x, y, k } = this.view;
        const dx = panStep(speed.x * dt, x, this.size.w * k, s.width, BORDER_STRIP);
        const dy = panStep(speed.y * dt, y, this.size.h * k, s.height, BORDER_STRIP);
        if (dx || dy) {
          this.view.x += dx;
          this.view.y += dy;
          this.manual = true;
          this.apply();
        }
      }
      this.frameTime = time;
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Pans just enough to bring the selected item fully into view. */
  private reveal(): void {
    const el = this.selected ? this.elementOf(this.selected) : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    const m = 24;
    const right = s.right - m - 32; // leave room for the connect handle
    if (r.width < right - s.left - m) this.view.x += r.left < s.left + m ? s.left + m - r.left : r.right > right ? right - r.right : 0;
    if (r.height < s.height - 2 * m) this.view.y += r.top < s.top + m ? s.top + m - r.top : r.bottom > s.bottom - m ? s.bottom - m - r.bottom : 0;
    this.apply();
  }

  private apply(): void {
    const { x, y, k } = this.view;
    this.canvas.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.placeHandles();
    this.refreshDrag();
  }

  fit(): void {
    this.stopGlide();
    const r = this.stage.getBoundingClientRect();
    if (!this.size.w || !r.width) return;
    const pad = 48;
    const k = Math.min(1.15, (r.width - pad) / this.size.w, (r.height - pad) / this.size.h);
    this.view.k = Math.max(MIN_ZOOM, k);
    this.view.x = (r.width - this.size.w * this.view.k) / 2;
    this.view.y = Math.max(pad / 2, (r.height - this.size.h * this.view.k) / 2);
    this.manual = false;
    this.apply();
  }

  zoom(factor: number, cx?: number, cy?: number): void {
    const r = this.stage.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.k * factor));
    this.view.x = px - ((px - this.view.x) * k) / this.view.k;
    this.view.y = py - ((py - this.view.y) * k) / this.view.k;
    this.view.k = k;
    this.apply();
  }

  private wheelZoom(e: WheelEvent): void {
    e.preventDefault();
    this.manual = true;
    const r = this.stage.getBoundingClientRect();
    const step = e.ctrlKey
      ? Math.max(-MOST_PINCH_STEP, Math.min(MOST_PINCH_STEP, -e.deltaY * PINCH_ZOOM))
      : -e.deltaY * WHEEL_ZOOM;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (!this.glide && Math.abs(step) < GLIDE_FROM) { this.zoom(Math.exp(step), x, y); return; }
    // The glide's goal moves by the step; a notch during a glide adds to where it is going.
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (this.glide?.k ?? this.view.k) * Math.exp(step)));
    if (this.glide) { Object.assign(this.glide, { k, x, y }); return; }
    const glide = { k, x, y, time: null as number | null, frame: 0 };
    const tick = (time: number) => {
      if (this.glide !== glide) return;
      const dt = glide.time === null ? 16 : Math.min(50, time - glide.time); // no leap after a stalled frame
      glide.time = time;
      const left = Math.log(glide.k / this.view.k);
      const done = Math.abs(left) < 0.002;
      this.zoom(Math.exp(done ? left : left * (1 - Math.exp(-dt / GLIDE_TIME))), glide.x, glide.y);
      if (done) this.glide = null;
      else glide.frame = requestAnimationFrame(tick);
    };
    this.glide = glide;
    glide.frame = requestAnimationFrame(tick);
  }

  /** Stops a wheel zoom's glide where it is. */
  private stopGlide(): void {
    if (this.glide) cancelAnimationFrame(this.glide.frame);
    this.glide = null;
  }

  private bind(): void {
    const { stage } = this;

    stage.addEventListener('wheel', (e) => this.wheelZoom(e), { passive: false });

    // Drag anywhere to pan; a press that does not move is a click.
    let pan: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    const isHandle = (t: EventTarget | null) => this.buttons().includes(t as HTMLButtonElement);
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isHandle(e.target)) return;
      pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, id: e.pointerId };
      this.moved = false;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!this.moved && Math.hypot(dx, dy) < 4) return;
      if (!this.moved) { this.moved = true; this.manual = true; stage.setPointerCapture(pan.id); stage.classList.add('panning'); this.trace(null); }
      this.view.x = pan.vx + dx;
      this.view.y = pan.vy + dy;
      this.apply();
    });
    const endPan = () => { pan = null; stage.classList.remove('panning'); };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);

    stage.addEventListener('click', (e) => {
      // A link written with Mermaid's `click` must not navigate the app away.
      if ((e.target as Element).closest('a')) e.preventDefault();
      if (this.moved || isHandle(e.target)) { this.moved = false; return; }
      const t = this.targetAt(e.target as Element);
      if (this.highlighting && t) { this.events.onHighlight(t); return; }
      if (e.shiftKey && t && t.kind !== 'edge' && this.allowed(t) && this.selected && this.selected.kind !== 'edge' && this.allowed(this.selected)) {
        if (this.viewing) this.events.onBlocked();
        else this.events.onConnect(this.selected.id, t.id);
        return;
      }
      this.events.onSelect(t);
    });
    stage.addEventListener('dblclick', (e) => {
      if (this.highlighting) return; // two quick clicks there are two highlight clicks
      if (this.viewing) { this.events.onBlocked(); return; } // a new node or a rename
      const t = this.targetAt(e.target as Element);
      if (t) this.events.onRename(t);
      else if (this.snap) this.events.onAddNode();
    });

    // The item under the pointer shows its handles and is lit softly (the user, 2026-11-13).
    // Over a handle, the item keeps them; over empty space, they stay for HOVER_GRACE, so
    // the pointer can cross the gap to the connect handle. Not for touch, not mid-drag.
    stage.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch' || this.drag || stage.classList.contains('panning')) return;
      if (isHandle(e.target)) {
        this.stopLeaving();
        const owner = this.buttons(this.sets.hover).includes(e.target as HTMLButtonElement) ? this.sets.hover.owner : null;
        this.light(owner);
        this.traceSoon(owner ?? this.traced); // the trace stays with the item whose handle this is
        return;
      }
      // A group is the ground the items in it stand on: coming from another item, the pointer
      // takes it only after the grace, as with empty space, so it can cross the group to that
      // item's handles (the user, 2026-11-13, who could not reach a grouped node's handle).
      const t = this.targetAt(e.target as Element);
      if (t?.kind === 'sub' && this.hovered && !sameTarget(t, this.hovered)) this.leaveSoon(t);
      else if (t) this.hover(t);
      else this.leaveSoon(null);
    });
    stage.addEventListener('pointerleave', () => { if (!this.drag) this.leaveSoon(null); });

    // Both kinds of handle, in both sets, use pointer capture, the same preview, and the
    // same edge scrolling.
    for (const set of [this.sets.sel, this.sets.hover]) {
      set.connect.addEventListener('pointerdown', (e) => {
        const owner = set.owner;
        if (!owner || owner.kind === 'edge' || !this.allowed(owner)) return;
        const r = this.elementOf(owner)?.getBoundingClientRect();
        if (r) this.beginDrag(e, set, set.connect, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, 'connect', owner.id);
      });
      for (const end of ['start', 'end'] as const) {
        const button = set.ends[end];
        button.addEventListener('pointerdown', (e) => {
          const owner = set.owner;
          const points = this.pathPoints(owner);
          if (owner?.kind !== 'edge' || !points) return;
          const edge = this.snap?.edges[owner.index];
          if (edge) this.beginDrag(e, set, button, points[end === 'start' ? 'end' : 'start'], 'end', edge[end], owner.index, end);
        });
      }
    }
    for (const button of this.buttons()) {
      button.addEventListener('pointermove', (e) => {
        if (!this.drag || this.drag.pointerId !== e.pointerId) return;
        this.drag.pointer = { x: e.clientX, y: e.clientY };
        this.refreshDrag();
      });
      const finish = (e: PointerEvent) => {
        const d = this.drag;
        if (!d || d.pointerId !== e.pointerId) return;
        const target = e.type === 'pointerup' && Math.hypot(e.clientX - d.origin.x, e.clientY - d.origin.y) >= 8
          ? this.dropTarget(e.clientX, e.clientY) : null;
        this.cancelDrag();
        if (!target) return;
        if (d.kind === 'connect') this.events.onConnect(d.id, target.id);
        else if (target.id !== d.id && d.index !== undefined && d.end) {
          // An arrow not selected is selected first, so the app keeps it selected when it is
          // written out of a group and renumbered (Q100), as for a selected one.
          const edge: Target = { kind: 'edge', index: d.index };
          if (!sameTarget(edge, this.selected)) this.events.onSelect(edge);
          this.events.onMoveEnd(d.index, d.end, target.id);
        }
      };
      button.addEventListener('pointerup', finish);
      button.addEventListener('pointercancel', finish);
      button.addEventListener('lostpointercapture', () => { if (this.drag?.button === button) this.cancelDrag(); });
    }
    document.addEventListener('keydown', this.onKeyDown);

    // When a side panel opens or closes, keep the chart centred and the selection in view.
    let width = stage.clientWidth;
    this.observer = new ResizeObserver(() => {
      const next = stage.clientWidth;
      this.view.x += (next - width) / 2;
      width = next;
      this.apply();
      this.reveal();
    });
    this.observer.observe(stage);
  }

  private dropTarget(x: number, y: number): { kind: 'node' | 'sub'; id: string } | null {
    for (const el of document.elementsFromPoint(x, y)) {
      const t = this.targetAt(el);
      if (t && t.kind !== 'edge' && this.allowed(t)) return t;
    }
    return null;
  }
}
