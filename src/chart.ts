// The chart view: draws the file with Mermaid's own engine, then maps the drawing back
// to the file's nodes, arrows and groups so they can be clicked, selected and connected.

import mermaid from 'mermaid';
import { forMermaid, type Snap } from './semantics';
import { parseDoc } from './core/scan';
import { placeLabelsNearSource } from './elk-options';
import { addDirectionMarks } from './direction-marks';
import { raiseGroupTitles } from './group-titles';
import { markLabelsInGroups } from './label-pills';
import { readyToLift, relockColours, unlockColours, unready } from './class-colours';
import type { Choice, WalkAction, WalkView } from './walk';

export type Target =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; index: number }
  | { kind: 'sub'; id: string };

/** The user's Touchpad and Mouse switch (D1.5): what a wheel event without Ctrl does. */
export type WheelMode = 'touchpad' | 'mouse';

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
  /** During a walk (T6.4): a choice clicked on the chart, an edge chip or the walk bar. */
  onWalk(action: WalkAction): void;
}

/**
 * Walk's view (T6.4, Q232): it zooms out to fit the node and the nodes it leads to only
 * while node text (14 px at full size) stays at least 11 px on screen; a next node still
 * out of view gets an edge chip.
 */
const WALK_READABLE = 11 / 14;
/** Room kept clear around what a walk's view fits, and between an edge chip and the chart's edge, in px. */
const WALK_PAD = 48;
const CHIP_INSET = 12;

/**
 * How far along a walk's glide is, from 0 to 1, at a time from 0 to 1: it speeds up
 * gently, then slows down to a stop (cubic ease in and out), so the move is never jerky
 * (the user, 2026-11-26).
 */
export function walkEase(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

/** A rounded node's corners (the user, 2026-11-16, Q164: 16 px, far from a square node's 4 px)
 * and an arrow's bends (the user, 2026-11-13), in px. */
const ROUNDED_NODE_RADIUS = 16;
const BEND_RADIUS = 14;

/** Lexend (the design handoff, T4.9, 2026-11-15), bundled in `src/fonts/` and declared in `style.css`. */
export const CHART_FONT = 'Lexend, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';

/**
 * Mermaid sizes each box by measuring its label as it draws, so the font must have
 * loaded first, or the boxes fit the fallback font. Once loaded, this returns at once.
 */
async function fontLoaded(): Promise<void> {
  if (!('fonts' in document)) return; // jsdom
  try { await document.fonts.load('14px Lexend'); } catch { /* drawn in the fallback font */ }
}

/**
 * The chart's colours: the palette's (`style.css`, T4.9), read from the page so that each
 * colour has one home. Each is read through a hidden element whose text colour is the
 * palette's colour, since the page gives a colour written `light-dark()` as rgb() only
 * there. A page without the styles (the tests) gets Naiad Default's.
 */
const CHART_COLOURS = {
  bg: ['#eef5f4', '#0b1c21'], node: ['#ffffff', '#12303a'], 'node-border': ['#95c2c8', '#34727f'],
  edge: ['#66979f', '#5592a0'], text: ['#12292f', '#e3f1f2'], muted: ['#4d6a6f', '#8fb0b5'],
  group: ['#e3efee', '#0e262c'], 'group-border': ['#bad6d8', '#22474f'],
} as const;

type Colours = Record<keyof typeof CHART_COLOURS, string>;

/**
 * A print's colours (T6.3, Q222): dark lines and text on white, the groups a light grey,
 * whatever the theme on screen, so a print reads on paper and spends little ink.
 */
const PAPER: Colours = {
  bg: '#ffffff', node: '#ffffff', 'node-border': '#4a4a4a', edge: '#333333', text: '#111111',
  muted: '#555555', group: '#f2f2f2', 'group-border': '#9a9a9a',
};

function pageColours(dark: boolean): Colours {
  const probe = document.createElement('span');
  probe.hidden = true;
  document.body.append(probe);
  const out = {} as Colours;
  for (const [name, both] of Object.entries(CHART_COLOURS) as [keyof typeof CHART_COLOURS, readonly [string, string]][]) {
    probe.style.color = '';
    probe.style.color = `var(--${name}, rgb(1, 2, 3))`;
    const value = getComputedStyle(probe).color;
    out[name] = /^rgba?\(/.test(value) && value !== 'rgb(1, 2, 3)' ? value : both[dark ? 1 : 0];
  }
  probe.remove();
  return out;
}

/** The grey of a group's title and an arrow label's text: between the muted colour and the text's. */
const softText = (c: Record<'muted' | 'text', string>) => `color-mix(in srgb, ${c.muted} 55%, ${c.text})`;

/**
 * Sets Mermaid up to draw in the palette's colours, light or dark (Appearance, T4.8; the
 * palette, T4.9). Called again when either changes, before every tab is drawn again.
 */
export function configureMermaid(dark: boolean): void {
  lastConfig = mermaidConfig(pageColours(dark), dark);
  mermaid.initialize(lastConfig);
}

/** The set-up `configureMermaid` last gave, which a print's drawing puts back when done. */
let lastConfig: Parameters<typeof mermaid.initialize>[0] | null = null;

/**
 * Mermaid's drawings, one at a time: `mermaid.render` waits its turn, but a new set-up
 * (`initialize`) takes effect at once, so a print's colours would reach a tab's drawing
 * waiting meanwhile. Each drawing runs inside this, and a print's sets and restores its
 * colours inside its own turn (T6.3).
 */
let drawing: Promise<unknown> = Promise.resolve();
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = drawing.then(job, job);
  drawing = run.catch(() => {});
  return run;
}

function mermaidConfig(c: Colours, dark: boolean): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    look: 'classic',
    // `radius` rounds the corners of a rounded node, `id(Title)`; a square node's corners
    // and a group's are rounded less, in `style.css`, so the two shapes stay apart.
    themeVariables: {
      ...(dark ? { darkMode: true } : {}),
      radius: ROUNDED_NODE_RADIUS, fontFamily: CHART_FONT, fontSize: '14px', background: c.bg,
      primaryColor: c.node, primaryTextColor: c.text, primaryBorderColor: c['node-border'],
      lineColor: c.edge, textColor: c.text, clusterBkg: c.group, clusterBorder: c['group-border'],
      edgeLabelBackground: c.bg, titleColor: c.muted,
    },
    // Group titles (Q173) and arrow labels (Q175), the user, 2026-11-18: a title is
    // semibold and a little larger than a node's text, in a grey lighter than the muted
    // colour; an arrow label sits in a soft pill with no border and a small margin, its
    // text a little smaller and grey, so it reads as a caption and not as a node. Mermaid applies these before it measures, so the layout
    // makes room for them.
    themeCSS: [
      `.cluster-label span, .cluster-label p { font-weight: 600; font-size: 15px; color: ${softText(c)}; }`,
      // The pill's colour (Q176, the user, 2026-11-18): the group colour outside every
      // group, the chart's background inside one (`label-pills.ts` marks which).
      `.labelBkg { background-color: ${c.group}; padding: 2px 7px; border-radius: 999px; }`,
      `g.edgeLabel.in-group .labelBkg { background-color: ${c.bg}; }`,
      '.edgeLabel p, span.edgeLabel { background-color: transparent; }',
      `.labelBkg .edgeLabel { font-size: 13px; color: ${softText(c)}; }`,
    ].join('\n'),
    flowchart: { useMaxWidth: false, htmlLabels: true, padding: 14, nodeSpacing: 44, rankSpacing: 52 },
    // Gaps at crossings (the user, 2026-11-13): where two arrows cross, Mermaid's layout
    // (ELK, its default) cuts a short gap in one, as on road maps, instead of its own
    // default, a small hop. Drawing only; a file's own `elk` settings still win.
    elk: { lineHops: 'gap' },
  };
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
/** The stage's width as the resize watcher reads it (whole pixels, without borders). */
const stageWidth = (el: HTMLElement): number => el.clientWidth;

/** Trace on hover (the user, 2026-11-13): how long the pointer rests before the rest fades, in ms. */
const TRACE_REST = 150;
/** How much a node under the pointer grows (Q240): `.canvas g.node.hov { scale }` in `style.css`. */
const GROW = 1.05;

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
  // With the pointer past the chart's border during a drag, the wheel still moves or zooms
  // the chart. Listened to only while a drag is under way, so scrolling elsewhere in the
  // window never waits on it.
  private onOutsideWheel = (e: WheelEvent) => {
    if (this.drag && e.target instanceof Node && !this.stage.contains(e.target)) this.onWheel(e);
  };
  /** What a wheel event without Ctrl does (D1.5, the user's switch): in Touchpad mode it
   * moves the view, in Mouse mode it zooms. A Ctrl-marked event (a pinch, or Ctrl held
   * with the wheel) zooms in both. Nothing is guessed from the event itself. Mouse mode
   * until the person chooses (the user, 2026-11-14). */
  private wheelMode: WheelMode = 'mouse';
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
  /** A fit asked for while the chart had no width (hidden while another tab is shown,
   * T1.16), so it is fitted as soon as it is shown. */
  private fitWaiting = false;
  /** The stage's width the view was last placed for: the resize watcher keeps the centre
   * from it, and a fit sets it, so a fit made before the watcher runs isn't shifted. */
  private placedWidth = 0;
  /** True once the user has panned or zoomed; until then each redraw is fitted again. */
  private manual = false;
  private moved = false;
  /** The walk shown (T6.4), or null. */
  private walk: WalkView | null = null;
  /** The walk bar at the chart's foot, and the edge chips (`placeChips`). */
  private walkBar: HTMLDivElement;
  private walkChips: HTMLDivElement;
  /** The view travelling to the walk's next place: its frame (`walkCamera`). */
  private walkFrame: number | null = null;
  /** The drawing's own frame's corner (its viewBox's x and y), to place a point of an arrow's line. */
  private origin = { x: 0, y: 0 };

  constructor(private stage: HTMLElement, private events: ChartEvents) {
    this.canvas = document.createElement('div');
    this.canvas.className = 'canvas';
    this.walkBar = document.createElement('div');
    this.walkBar.className = 'walk-bar';
    this.walkBar.setAttribute('role', 'toolbar');
    this.walkBar.setAttribute('aria-label', 'Walkthrough');
    this.walkBar.hidden = true;
    this.walkChips = document.createElement('div');
    this.walkChips.className = 'walk-chips';
    for (const holder of [this.walkBar, this.walkChips]) {
      holder.addEventListener('click', (e) => {
        const b = (e.target as Element).closest<HTMLButtonElement>('button[data-walk]');
        if (!b || b.disabled) return;
        const kind = b.dataset.walk!;
        if (kind === 'choose') this.events.onWalk({ kind, edge: Number(b.dataset.value) });
        else if (kind === 'start') this.events.onWalk({ kind, id: b.dataset.value! });
        else if (kind === 'back' || kind === 'again' || kind === 'leave') this.events.onWalk({ kind });
      });
    }
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
    stage.append(this.canvas, this.overlay, ...this.buttons(), this.walkChips, this.walkBar);
    this.bind();
  }

  private buttons(set?: Handles): HTMLButtonElement[] {
    return (set ? [set] : [this.sets.sel, this.sets.hover]).flatMap((s) => [s.connect, s.ends.start, s.ends.end]);
  }

  /** Call when another file is opened, so the next drawing is fitted to the window. */
  resetView(): void { this.fitted = false; }

  /** The view as the person panned and zoomed it, or null while it is fitted (a tab moved to another window takes it along, T6.2). */
  placement(): { x: number; y: number; k: number } | null {
    return this.manual ? { ...this.view } : null;
  }

  /** Puts the view where `placement` said, after the drawing; it then stays, as a pan or zoom would. */
  setPlacement(view: { x: number; y: number; k: number }): void {
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    if (!ok(view.x) || !ok(view.y) || !ok(view.k) || view.k <= 0) return;
    this.stopGlide();
    this.view = { x: view.x, y: view.y, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k)) };
    this.fitted = true;
    this.manual = true;
    this.fitWaiting = false;
    this.placedWidth = stageWidth(this.stage);
    this.apply();
  }

  /** Call when the chart's tools (Undo's island, the pill) over this chart have been
   * shown or hidden: a view still fitted is fitted again around them; one the user
   * panned or zoomed stays. (Seen 2026-11-25: a file's first drawing came before its
   * tab showed the tools, so the first fit put a tall chart's last node under the pill.) */
  toolsChanged(): void { if (!this.manual) this.fit(); }

  async draw(text: string, snap: Snap): Promise<void> {
    this.cancelDrag();
    const id = `chart${++drawCount}`;
    await Promise.all([fontLoaded(), placeLabelsNearSource()]);
    const { svg } = await exclusive(() => mermaid.render(id, forMermaid(text)));
    this.cancelDrag();
    this.canvas.innerHTML = svg;
    this.snap = snap;
    this.explicitSubs = new Set(parseDoc(text.replace(/\r\n?/g, '\n')).subs.filter((sub) => sub.explicitId).map((sub) => sub.id));
    const el = this.canvas.querySelector('svg');
    if (!el) return;
    const box = el.viewBox.baseVal;
    this.size = { w: box.width, h: box.height };
    this.origin = { x: box.x, y: box.y };
    el.setAttribute('width', String(box.width));
    el.setAttribute('height', String(box.height));
    el.style.maxWidth = 'none';
    finish(el, id, snap, true);
    unlockColours(el);
    if (!this.fitted || !this.manual) { this.fit(); this.fitted = true; }
    this.paintSelection();
    this.paintHighlights();
    this.paintTrace();
    this.paintWalk();
    this.placeChips();
  }

  /**
   * Shows a walk (T6.4), or none: the places it can go lit and the rest faded, the path
   * taken marked, the walk bar, and the edge chips. With `move`, the view travels to the
   * walk's place (`walkCamera`); without, it stays (a redraw after the file changed).
   */
  setWalk(view: WalkView | null, move = true): void {
    this.walk = view;
    // While the reader picks where to start (Q242), all but the nodes no arrow points to
    // fades, as hints (Q243; the user, 2026-11-26); any node can still be clicked. A chart
    // that is all loops has no such node, and then nothing fades.
    this.stage.classList.toggle('walking', !!view?.here);
    this.stage.classList.toggle('walk-picking', !!view && !view.here && view.starts.length > 0);
    if (view) this.trace(null);
    this.paintWalk();
    this.paintHighlights(); // hidden for the walk, back when it ends (the user, 2026-11-26)
    this.renderWalkBar();
    if (!view) { this.stopWalkGlide(); this.walkChips.replaceChildren(); return; }
    if (move) this.walkCamera();
    else this.placeChips();
  }

  /**
   * The walk's next places in the order they lie on the chart (the user, 2026-11-26): left
   * to right, or top to bottom in a chart drawn sideways (LR, RL). Each arrow is placed
   * where it leaves the walk's place, which is where the eye meets it; then by its middle;
   * then by the file's order. A place to start, or an arrow not drawn, by its place.
   */
  private walkOrder(): Choice[] {
    const w = this.walk;
    const next = this.walkNext();
    if (!w || next.length < 2) return next;
    const sideways = /^(LR|RL)$/.test(this.snap?.direction ?? '');
    const r = this.stage.getBoundingClientRect();
    const keyed = next.map((c, i) => {
      let near: { x: number; y: number } | null = null;
      let mid: { x: number; y: number } | null = null;
      const line = c.edge >= 0 ? this.canvas.querySelector<SVGPathElement>(`[data-edge-line="${String(c.edge)}"]`) : null;
      try {
        const length = line?.getTotalLength() ?? 0;
        if (line && length > 0) {
          const forward = this.snap?.edges[c.edge]?.start === w.here;
          const d = Math.min(40, length / 3);
          const p = line.getPointAtLength(forward ? d : length - d);
          const m = line.getPointAtLength(length / 2);
          near = { x: p.x - this.origin.x, y: p.y - this.origin.y };
          mid = { x: m.x - this.origin.x, y: m.y - this.origin.y };
        }
      } catch { near = null; }
      if (!near) {
        const b = this.chartRect(c.to, r);
        near = mid = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
      }
      const along = (p: { x: number; y: number } | null) => (p ? (sideways ? p.y : p.x) : Infinity);
      const across = (p: { x: number; y: number } | null) => (p ? (sideways ? p.x : p.y) : Infinity);
      return { c, i, a: Math.round(along(near)), m: along(mid), b: across(near) };
    });
    keyed.sort((p, q) => p.a - q.a || p.m - q.m || p.b - q.b || p.i - q.i);
    return keyed.map((k) => k.c);
  }

  /**
   * What the key 1 to 9 takes during a walk (Q233): the walk's `n`th next place (from 0)
   * in the order they lie on the chart, whether in view or not; null when there is none.
   */
  walkChoice(n: number): WalkAction | null {
    const w = this.walk;
    const c = w ? this.walkOrder()[n] : undefined;
    if (!w || !c) return null;
    return w.here ? { kind: 'choose', edge: c.edge } : { kind: 'start', id: c.to };
  }

  /** The drawn node or group with this id. */
  private walkItem(id: string): Element | null {
    return this.canvas.querySelector(`[data-node="${CSS.escape(id)}"]`) ?? this.canvas.querySelector(`[data-sub="${CSS.escape(id)}"]`);
  }

  /**
   * The places the walk can go next: the arrows' ends. While the reader picks where to
   * start, none: any node can be picked (Q242), so none is lit, chipped or keyed.
   */
  private walkNext(): Choice[] {
    const w = this.walk;
    return w?.here ? w.choices : [];
  }

  private paintWalk(): void {
    for (const c of ['walk-on', 'walk-here', 'walk-path', 'walk-start']) this.canvas.querySelectorAll(`.${c}`).forEach((e) => e.classList.remove(c));
    const w = this.walk;
    if (!w) return;
    for (const s of w.starts) this.walkItem(s.to)?.classList.add('walk-start');
    const edge = (i: number, c: string) => {
      this.canvas.querySelector(`[data-edge-line="${i}"]`)?.classList.add(c);
      this.canvas.querySelector(`g.edgeLabel[data-edge="${i}"]`)?.classList.add(c);
    };
    for (const id of w.path) this.walkItem(id)?.classList.add('walk-path');
    for (const i of w.pathEdges) edge(i, 'walk-path');
    if (w.here) this.walkItem(w.here)?.classList.add('walk-on', 'walk-here');
    for (const c of this.walkNext()) {
      this.walkItem(c.to)?.classList.add('walk-on');
      if (c.edge >= 0) edge(c.edge, 'walk-on');
    }
  }

  /** How far the chart's tools reach down from its top, and the walk bar up from its foot, in px. */
  private walkBands(r: DOMRect): { top: number; foot: number } {
    const top = this.toolBands(r).top;
    const bar = this.walkBar.hidden ? null : this.walkBar.getBoundingClientRect();
    return { top, foot: bar?.height ? r.bottom - bar.top : 0 };
  }

  /** An item's place in the chart's own units (as drawn, before the view's zoom), or null. */
  private chartRect(id: string, r: DOMRect): { x: number; y: number; w: number; h: number } | null {
    const b = this.walkItem(id)?.getBoundingClientRect();
    if (!b) return null;
    const { x, y, k } = this.view;
    return { x: (b.left - r.left - x) / k, y: (b.top - r.top - y) / k, w: b.width / k, h: b.height / k };
  }

  /**
   * Where the walk's view goes (Q230, Q232): the walk's place and as many of the places
   * it leads to as fit, nearest first, while node text stays readable; at most a little
   * over full size. Returns the zoom and the chart's point to put at `anchor`, the middle
   * of the chart's area between its tools and the walk bar.
   */
  private walkGoal(): { k: number; cx: number; cy: number; ax: number; ay: number } | null {
    const w = this.walk;
    const r = this.stage.getBoundingClientRect();
    if (!w || !r.width || !r.height) return null;
    const next = this.walkNext();
    const focusId = w.here ?? next[0]?.to;
    let u = focusId ? this.chartRect(focusId, r) : null;
    if (!u) return null;
    const bands = this.walkBands(r);
    const top = Math.max(WALK_PAD, bands.top ? bands.top + 12 : 0);
    const foot = Math.max(WALK_PAD, bands.foot ? bands.foot + 12 : 0);
    const aw = Math.max(1, r.width - 2 * WALK_PAD);
    const ah = Math.max(1, r.height - top - foot);
    const kOf = (b: { w: number; h: number }) => Math.min(1.15, aw / Math.max(1, b.w), ah / Math.max(1, b.h));
    const join = (a: typeof u, b: NonNullable<typeof u>) => {
      const x = Math.min(a!.x, b.x), y = Math.min(a!.y, b.y);
      return { x, y, w: Math.max(a!.x + a!.w, b.x + b.w) - x, h: Math.max(a!.y + a!.h, b.y + b.h) - y };
    };
    const mid = (b: NonNullable<typeof u>) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const c0 = mid(u);
    const others = next.filter((c) => c.to !== focusId)
      .map((c) => this.chartRect(c.to, r))
      .filter((b): b is NonNullable<typeof u> => !!b)
      .sort((a, b) => Math.hypot(mid(a).x - c0.x, mid(a).y - c0.y) - Math.hypot(mid(b).x - c0.x, mid(b).y - c0.y));
    for (const b of others) {
      const joined = join(u, b);
      if (kOf(joined) >= WALK_READABLE) u = joined;
    }
    const k = Math.max(MIN_ZOOM, kOf(u));
    const c = mid(u);
    return { k, cx: c.x, cy: c.y, ax: r.width / 2, ay: top + ah / 2 };
  }

  /**
   * Moves the view to the walk's place (`walkGoal`) in a straight line, easing in and
   * out, zooming out on the way when the way is long (Q232). It no longer follows the
   * arrow's curves, which made a bumpy ride (the user, 2026-11-26). Without motion when
   * the person's system asks for less of it.
   */
  private walkCamera(): void {
    this.stopWalkGlide();
    this.stopGlide();
    const goal = this.walkGoal();
    if (!goal) { this.placeChips(); return; }
    this.manual = true;
    this.fitted = true;
    const { ax, ay } = goal;
    const from = { ...this.view };
    const c0 = { x: (ax - from.x) / from.k, y: (ay - from.y) / from.k };
    const c1 = { x: goal.cx, y: goal.cy };
    const distance = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    const end = () => {
      this.walkFrame = null;
      this.view = { x: ax - goal.k * c1.x, y: ay - goal.k * c1.y, k: goal.k };
      this.apply();
    };
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const onScreen = distance * Math.min(from.k, goal.k);
    if (still || (onScreen < 2 && Math.abs(Math.log(goal.k / from.k)) < 0.01)) { end(); return; }
    const r = this.stage.getBoundingClientRect();
    const time = Math.min(1400, 480 + onScreen * 0.35);
    // On a long way, the zoom dips so most of it is in view at the halfway point.
    const kMid = Math.max(MIN_ZOOM, Math.min(from.k, goal.k, (0.8 * Math.min(r.width, r.height)) / Math.max(1, distance)));
    const l0 = Math.log(from.k), l1 = Math.log(goal.k);
    const dip = Math.min(0, Math.log(kMid) - (l0 + l1) / 2);
    let started: number | null = null;
    const tick = (now: number) => {
      started ??= now;
      const t = Math.min(1, (now - started) / time);
      if (t >= 1) { end(); return; }
      const e = walkEase(t);
      const k = Math.exp(l0 + (l1 - l0) * e + 4 * e * (1 - e) * dip);
      const c = { x: c0.x + (c1.x - c0.x) * e, y: c0.y + (c1.y - c0.y) * e };
      this.view = { x: ax - k * c.x, y: ay - k * c.y, k };
      this.apply();
      this.walkFrame = requestAnimationFrame(tick);
    };
    this.walkChips.replaceChildren();
    this.walkFrame = requestAnimationFrame(tick);
  }

  /**
   * A click on the chart during a walk: a place to go next, or the arrow (or its label)
   * that leads there, takes that choice; while picking, any node starts there (Q242).
   * Anything else does nothing, so a stray click never ends or moves the walk.
   */
  private walkClick(t: Target | null): void {
    const w = this.walk;
    if (!w || !t) return;
    if (!w.here) {
      if (t.kind === 'node') this.events.onWalk({ kind: 'start', id: t.id });
      return;
    }
    const c = t.kind === 'edge' ? w.choices.find((x) => x.edge === t.index) : w.choices.find((x) => x.to === t.id);
    if (c) this.events.onWalk({ kind: 'choose', edge: c.edge });
  }

  /** Stops the walk's view where it is (the person panned or zoomed). */
  private stopWalkGlide(): void {
    if (this.walkFrame === null) return;
    cancelAnimationFrame(this.walkFrame);
    this.walkFrame = null;
    this.placeChips();
  }

  /**
   * Where a next place's arrow first leaves the view on its way out of the walk's place,
   * in the stage's px, with the line's heading there (in radians); null when the arrow is
   * not drawn, the walk's place is itself out of view, or the line never leaves the view.
   */
  private lineExit(c: Choice, box: { left: number; top: number; right: number; bottom: number }): { x: number; y: number; a: number } | null {
    const w = this.walk;
    if (!w?.here || c.edge < 0) return null;
    const line = this.canvas.querySelector<SVGPathElement>(`[data-edge-line="${String(c.edge)}"]`);
    let length = 0;
    try { length = line?.getTotalLength() ?? 0; } catch { length = 0; }
    if (!line || !(length > 0)) return null;
    const forward = this.snap?.edges[c.edge]?.start === w.here;
    const { x: vx, y: vy, k } = this.view;
    const at = (s: number) => {
      const p = line.getPointAtLength(forward ? s : length - s);
      return { x: vx + k * (p.x - this.origin.x), y: vy + k * (p.y - this.origin.y) };
    };
    const inside = (p: { x: number; y: number }) => p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
    let prev = at(0);
    if (!inside(prev)) return null;
    const step = Math.max(2 / k, length / 240);
    for (let s = step; s - step < length; s += step) {
      const p = at(Math.min(s, length));
      if (inside(p)) { prev = p; continue; }
      let lo = s - step, hi = Math.min(s, length);
      for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (inside(at(m))) lo = m; else hi = m; }
      const e = at(lo);
      return { x: e.x, y: e.y, a: Math.atan2(p.y - prev.y, p.x - prev.x) };
    }
    return null;
  }

  /**
   * The edge chips (Q232, the user, 2026-11-26): each place the walk can go next that is
   * not wholly in view gets a chip at the chart's edge, centred where its arrow's line
   * leaves the view, naming the arrow's label and the place in full ("Yes → Build the
   * index"). A click takes that choice. They are the only way to an out-of-view place
   * besides its key: the walk bar names none (the user, 2026-11-26).
   */
  private placeChips(): void {
    const next = this.walkNext();
    if (!this.walk || this.walkFrame !== null || !next.length) { this.walkChips.replaceChildren(); return; }
    const r = this.stage.getBoundingClientRect();
    if (!r.width) return;
    const inView = (b: DOMRect, top: number, bottom: number) => {
      const x0 = b.left - r.left, y0 = b.top - r.top;
      return x0 >= 0 && x0 + b.width <= r.width && y0 >= top && y0 + b.height <= bottom;
    };
    const bands = this.walkBands(r);
    const top = bands.top + CHIP_INSET;
    const bottom = r.height - bands.foot - CHIP_INSET;
    const left = CHIP_INSET;
    const right = r.width - CHIP_INSET;
    const cx = r.width / 2;
    const cy = (top + bottom) / 2;
    const seen = { left: 0, top: bands.top, right: r.width, bottom: r.height - bands.foot };
    const placed: DOMRect[] = [];
    this.walkChips.replaceChildren();
    const order = this.walkOrder();
    order.forEach((c, i) => {
      const b = this.walkItem(c.to)?.getBoundingClientRect();
      if (!b || !this.walk) return;
      if (inView(b, top - CHIP_INSET, bottom + CHIP_INSET)) return;
      // Where the arrow's line leaves the view, or else where the line from the view's
      // middle to the place meets the edge.
      const exit = this.lineExit(c, seen);
      const dx = b.left - r.left + b.width / 2 - cx;
      const dy = b.top - r.top + b.height / 2 - cy;
      const s = Math.min(dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity, dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity);
      const at = exit ?? { x: cx + dx * s, y: cy + dy * s, a: Math.atan2(dy, dx) };
      const chip = document.createElement('button');
      chip.className = 'walk-chip';
      chip.dataset.walk = this.walk.here ? 'choose' : 'start';
      chip.dataset.value = this.walk.here ? String(c.edge) : c.to;
      const dir = document.createElement('span');
      dir.className = 'walk-chip-dir';
      dir.setAttribute('aria-hidden', 'true');
      dir.textContent = '➜';
      dir.style.transform = `rotate(${String(at.a)}rad)`;
      const text = document.createElement('span');
      const name = c.label ? `${c.label} → ${c.title}` : c.title;
      text.textContent = name;
      chip.append(dir, text);
      // The tooltip names the key (Q233): the keys count every next place in chart order.
      const one = this.walk.here && order.length === 1;
      chip.title = `${name} (out of view; ${one ? 'Right arrow' : i < 9 ? `key ${String(i + 1)}` : 'click'})`;
      this.walkChips.append(chip);
      // Its size is fixed once measured, so a place near the right edge cannot narrow it.
      const w = chip.offsetWidth, h = chip.offsetHeight;
      chip.style.width = `${String(w)}px`;
      // Centred on that point, kept inside, and moved along the edge clear of a chip
      // placed before it.
      let px = Math.min(Math.max(at.x - w / 2, left), right - w);
      let py = Math.min(Math.max(at.y - h / 2, top), bottom - h);
      const alongX = Math.min(at.y - top, bottom - at.y) <= Math.min(at.x - left, right - at.x); // on the top or foot edge: move sideways
      for (let j = 0; j < placed.length * 2 + 1; j++) {
        const hit = placed.find((p) => px < p.right + 6 && px + w > p.left - 6 && py < p.bottom + 6 && py + h > p.top - 6);
        if (!hit) break;
        if (alongX) px = Math.min(hit.right + 6, right - w);
        else py = Math.min(hit.bottom + 6, bottom - h);
      }
      chip.style.left = `${String(px)}px`;
      chip.style.top = `${String(py)}px`;
      placed.push(new DOMRect(px, py, w, h));
    });
  }

  /** The walk bar: Back, a note on what to click, and Leave; at an end, Start again. */
  private renderWalkBar(): void {
    const w = this.walk;
    this.walkBar.hidden = !w;
    this.walkBar.replaceChildren();
    if (!w) return;
    const button = (walk: string, text: string, value?: string, tip?: string) => {
      const b = document.createElement('button');
      b.dataset.walk = walk;
      if (value !== undefined) b.dataset.value = value;
      b.textContent = text;
      if (tip) b.title = tip;
      return b;
    };
    const note = (text: string) => { const s = document.createElement('span'); s.className = 'walk-note'; s.textContent = text; return s; };
    const back = button('back', 'Back', undefined, 'Back along the path taken (Left arrow)');
    back.classList.add('walk-back');
    back.disabled = !w.canBack;
    const choices = document.createElement('div');
    choices.className = 'walk-choices';
    if (w.here && !w.choices.length) {
      choices.append(note('The end of this path'), button('again', 'Start again'));
    } else {
      // The next places are clicked on the chart, or, out of view, on their edge chips;
      // the bar names none of them (the user, 2026-11-26).
      choices.append(note(!w.here ? 'Click the node to start from' : w.choices.length === 1 ? 'Click the next step on the chart' : 'Click a next step on the chart'));
    }
    const leave = button('leave', 'Leave', undefined, 'Leave the walkthrough (Esc)');
    leave.classList.add('walk-leave');
    this.walkBar.append(back, choices, leave);
  }

  /**
   * A copy of the whole chart as drawn now, for Export (T6.3): in the theme on screen,
   * without what only the window shows (the selection, highlights, the item under the
   * pointer, a trace, the arrows' clickable copies); and the chart's background colour.
   * Null while nothing is drawn.
   */
  picture(): { svg: SVGSVGElement; background: string } | null {
    const el = this.canvas.querySelector('svg');
    if (!el) return null;
    const svg = el.cloneNode(true) as SVGSVGElement;
    clean(svg);
    relockColours(svg);
    unready(svg);
    return { svg, background: getComputedStyle(this.stage).backgroundColor || CHART_COLOURS.bg[0] };
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

  /**
   * Lights the item under the pointer: a node grows and lifts (Q240); a group or an arrow
   * gets a softer kind of the selection's outline (`style.css`).
   */
  private light(t: Target | null): void {
    this.lit = t;
    this.canvas.querySelectorAll('.hov').forEach((e) => e.classList.remove('hov'));
    const el = t ? this.elementOf(t) : null;
    if (!el) return;
    if (t?.kind === 'node') readyToLift(el as SVGGElement);
    el.classList.add('hov');
  }

  /** Trace on hover follows the pointer after a short rest, so crossing the chart does not flicker. */
  private traceSoon(t: Target | null): void {
    if (this.walk) t = null; // a walk lights its own way (T6.4)
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

  /** Touchpad or Mouse mode (D1.5): what a wheel event without Ctrl does (`onWheel`). */
  setWheelMode(mode: WheelMode): void {
    this.wheelMode = mode;
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
    if (this.walk) return; // a walk hides the highlights while it lasts; the file keeps them (the user, 2026-11-26)
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
        // Beside the node's size once its grow under the pointer (Q240) ends, not as it is
        // now, part way: the grow is about the node's centre.
        const now = Number.parseFloat(getComputedStyle(el).scale) || 1;
        const end = el.classList.contains('hov') && owner?.kind === 'node' ? GROW : 1;
        set.connect.style.left = `${r.left + (r.width / 2) * (1 + end / now) - s.left + 6}px`;
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
    this.placeChips();
  }

  fit(): void {
    this.stopGlide();
    const r = this.stage.getBoundingClientRect();
    this.fitWaiting = !!this.size.w && !r.width;
    if (!this.size.w || !r.width) return;
    // 24 px clear at each side; at the top and the foot, 12 px clear of the chart's tools
    // laid over the chart (Undo's island, the pill), so no node is fitted under them
    // (seen 2026-11-25: a tall chart's last node sat under the pill).
    const pad = 24;
    const tools = this.toolBands(r);
    const top = Math.max(pad, tools.top ? tools.top + 12 : 0);
    const foot = Math.max(pad, tools.foot ? tools.foot + 12 : 0);
    const band = Math.max(1, r.height - top - foot);
    const k = Math.min(1.15, (r.width - 2 * pad) / this.size.w, band / this.size.h);
    this.view.k = Math.max(MIN_ZOOM, k);
    this.view.x = (r.width - this.size.w * this.view.k) / 2;
    this.view.y = top + Math.max(0, (band - this.size.h * this.view.k) / 2);
    this.placedWidth = stageWidth(this.stage);
    this.manual = false;
    this.apply();
  }

  /** How far down from the chart's top, and up from its foot, the chart's tools reach
   * (`.island-row` and `.pill`, laid over the chart beside the stage), in px; 0 where
   * none is shown. A tool counts at the top or the foot by which half its middle is in. */
  private toolBands(r: DOMRect): { top: number; foot: number } {
    let top = 0, foot = 0;
    for (const el of this.stage.parentElement?.querySelectorAll<HTMLElement>(':scope > .island-row, :scope > .pill') ?? []) {
      const t = el.getBoundingClientRect();
      if (!t.width || !t.height || t.bottom <= r.top || t.top >= r.bottom) continue;
      if ((t.top + t.bottom) / 2 < r.top + r.height / 2) top = Math.max(top, t.bottom - r.top);
      else foot = Math.max(foot, r.bottom - t.top);
    }
    return { top, foot };
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

  /** A wheel event over the chart: in Touchpad mode, one without Ctrl (two fingers, or a
   * mouse wheel) moves the view the way a page scrolls on the same computer; Shift with
   * an up-and-down wheel moves it sideways. Otherwise it zooms (`wheelZoom`). */
  private onWheel(e: WheelEvent): void {
    this.stopWalkGlide();
    if (this.wheelMode === 'mouse' || e.ctrlKey) { this.wheelZoom(e); return; }
    e.preventDefault();
    // Pixels per unit: a line is about 16 px; a page is the chart's area.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.stage.getBoundingClientRect().height : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    if (!dx && !dy) return;
    this.manual = true;
    this.view.x -= dx;
    this.view.y -= dy;
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

    stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Drag anywhere to pan; a press that does not move is a click.
    let pan: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    const isHandle = (t: EventTarget | null) => this.buttons().includes(t as HTMLButtonElement);
    // The walk bar and the edge chips are buttons over the chart, not the chart (T6.4).
    const onWalkTools = (t: EventTarget | null) => t instanceof Node && (this.walkBar.contains(t) || this.walkChips.contains(t));
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isHandle(e.target) || onWalkTools(e.target)) return;
      pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, id: e.pointerId };
      this.moved = false;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!this.moved && Math.hypot(dx, dy) < 4) return;
      if (!this.moved) { this.stopWalkGlide(); this.moved = true; this.manual = true; stage.setPointerCapture(pan.id); stage.classList.add('panning'); this.trace(null); }
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
      if (onWalkTools(e.target)) return;
      const t = this.targetAt(e.target as Element);
      if (this.walk) { this.walkClick(t); return; }
      if (this.highlighting && t) { this.events.onHighlight(t); return; }
      if (e.shiftKey && t && t.kind !== 'edge' && this.allowed(t) && this.selected && this.selected.kind !== 'edge' && this.allowed(this.selected)) {
        if (this.viewing) this.events.onBlocked();
        else this.events.onConnect(this.selected.id, t.id);
        return;
      }
      this.events.onSelect(t);
    });
    stage.addEventListener('dblclick', (e) => {
      if (this.highlighting || this.walk) return; // two quick clicks there are two highlight clicks, or two steps of a walk
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
    // A hidden chart (another tab shown, T1.16) has no width: its view stays as it was
    // left, and on showing it moves only to keep the centre if the width changed meanwhile.
    this.placedWidth = stageWidth(stage);
    let shown = this.placedWidth > 0;
    this.observer = new ResizeObserver(() => {
      const next = stageWidth(stage);
      const width = this.placedWidth;
      const showing = !shown;
      shown = next > 0;
      if (!next) return;
      if (this.fitWaiting) { this.fit(); return; }
      this.placedWidth = next;
      if (showing && (next === width || !width)) return;
      this.view.x += (next - width) / 2;
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

/**
 * Maps Mermaid's drawing to the file's nodes, groups and arrows, rounds the arrows'
 * bends, and adds Naiad's own finishing: direction marks, group titles above the arrows
 * and the label pills' colours. `hits` adds each arrow's wide clickable copy, which a
 * printed or saved picture leaves out. The order matters: a direction mark directly
 * follows its arrow (`path.sel + path.dir-mark` in `style.css`).
 */
function finish(svg: SVGSVGElement, id: string, snap: Snap, hits: boolean): void {
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
    if (!hits) return;
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
  addDirectionMarks(svg);
  raiseGroupTitles(svg);
  markLabelsInGroups(svg);
}

/** The classes that show only in the window (`style.css`): under the pointer, selected, highlighted, lit by a trace, a drop. */
const WINDOW_ONLY = ['hov', 'sel', 'hl', 'lit', 'drop'];

/** Takes off a drawing what only the window shows, and Naiad's own marks on it (`finish`). */
function clean(svg: SVGSVGElement): void {
  for (const hit of svg.querySelectorAll('.edge-hit')) hit.remove();
  for (const el of svg.querySelectorAll('[class]')) el.classList.remove(...WINDOW_ONLY);
  for (const el of svg.querySelectorAll('[data-node], [data-sub], [data-edge-line], g[data-edge]')) {
    for (const name of ['data-node', 'data-sub', 'data-edge-line']) el.removeAttribute(name);
    if (el.tagName.toLowerCase() === 'g') el.removeAttribute('data-edge');
  }
  svg.style.removeProperty('max-width');
}

/**
 * The chart drawn for paper (T6.3, Q222): dark lines on white, finished as on screen,
 * into `holder`, which must be in the page so the finishing can measure. Mermaid gets
 * the print's colours for this one drawing and the screen's back after it. Null when
 * Mermaid cannot draw the text.
 */
export function drawForPaper(text: string, snap: Snap, holder: HTMLElement): Promise<SVGSVGElement | null> {
  return exclusive(async () => {
    const id = `paper${++drawCount}`;
    await Promise.all([fontLoaded(), placeLabelsNearSource()]);
    mermaid.initialize(mermaidConfig(PAPER, false));
    try {
      const { svg } = await mermaid.render(id, forMermaid(text));
      holder.innerHTML = svg;
    } finally {
      if (lastConfig) mermaid.initialize(lastConfig);
    }
    const el = holder.querySelector('svg');
    if (!el) return null;
    const box = el.viewBox.baseVal;
    el.setAttribute('width', String(box.width));
    el.setAttribute('height', String(box.height));
    finish(el, id, snap, false);
    clean(el);
    dropTitle(el);
    return el;
  });
}

/**
 * Takes the chart's own front-matter title out of a drawing that is in the page, and
 * fits the drawing's frame to what is left, with Mermaid's own 8 px of room around it.
 * A print uses it: the sheet's heading already names the flowchart (Q225, the user,
 * 2026-11-25). A saved SVG or PNG keeps its title.
 */
export function dropTitle(svg: SVGSVGElement): void {
  const titles = svg.querySelectorAll('.flowchartTitleText');
  if (!titles.length) return;
  for (const t of titles) t.remove();
  const b = svg.getBBox();
  if (!b.width || !b.height) return;
  const pad = 8;
  const w = b.width + 2 * pad, h = b.height + 2 * pad;
  svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
}
