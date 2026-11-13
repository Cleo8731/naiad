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
}

export function configureMermaid(dark: boolean): void {
  const font = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    look: 'classic',
    themeVariables: dark
      ? {
        darkMode: true, fontFamily: font, fontSize: '14px', background: '#16181c',
        primaryColor: '#262a31', primaryTextColor: '#e8eaed', primaryBorderColor: '#5b6472',
        lineColor: '#8a93a1', textColor: '#e8eaed', clusterBkg: '#1c1f25', clusterBorder: '#3a414c',
        edgeLabelBackground: '#16181c', titleColor: '#aeb6c2',
      }
      : {
        fontFamily: font, fontSize: '14px', background: '#f6f7f9',
        primaryColor: '#ffffff', primaryTextColor: '#1c2026', primaryBorderColor: '#9aa3b0',
        lineColor: '#6b7482', textColor: '#1c2026', clusterBkg: '#eef0f4', clusterBorder: '#c9ced6',
        edgeLabelBackground: '#f6f7f9', titleColor: '#4a5362',
      },
    flowchart: { useMaxWidth: false, htmlLabels: true, padding: 14, nodeSpacing: 44, rankSpacing: 52 },
  });
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
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

type Drag = {
  pointerId: number; button: HTMLButtonElement; origin: Point; pointer: Point; fixed: Point;
  line: SVGLineElement; kind: 'connect' | 'end'; id: string; index?: number; end?: End;
};

export class Chart {
  private canvas: HTMLDivElement;
  private overlay: SVGSVGElement;
  private handle: HTMLButtonElement;
  private endHandles: Record<End, HTMLButtonElement>;
  private explicitSubs = new Set<string>();
  private drag: Drag | null = null;
  private frame: number | null = null;
  private frameTime: number | null = null;
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
    this.handle = document.createElement('button');
    this.handle.className = 'connect-handle';
    this.handle.title = 'Drag to another node to connect';
    this.handle.setAttribute('aria-label', 'Connect to another node');
    this.handle.hidden = true;
    this.endHandles = Object.fromEntries((['start', 'end'] as const).map((end) => {
      const button = document.createElement('button');
      button.className = 'end-handle';
      button.title = `Move the arrow's ${end}`;
      button.setAttribute('aria-label', button.title);
      button.hidden = true;
      return [end, button];
    })) as Record<End, HTMLButtonElement>;
    stage.append(this.canvas, this.overlay, this.handle, this.endHandles.start, this.endHandles.end);
    this.bind();
  }

  /** Call when another file is opened, so the next drawing is fitted to the window. */
  resetView(): void { this.fitted = false; }

  async draw(text: string, snap: Snap): Promise<void> {
    this.cancelDrag();
    const id = `chart${++drawCount}`;
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
  }

  clear(): void {
    this.cancelDrag();
    this.canvas.innerHTML = '';
    this.snap = null;
    this.handle.hidden = true;
    this.endHandles.start.hidden = this.endHandles.end.hidden = true;
  }

  /** Release observers and active drag work when the chart is discarded. */
  destroy(): void {
    this.clear();
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
    if (JSON.stringify(target) !== JSON.stringify(this.selected)) this.cancelDrag();
    this.selected = target;
    this.paintSelection();
  }

  private paintSelection(): void {
    this.canvas.querySelectorAll('.sel').forEach((e) => e.classList.remove('sel'));
    const el = this.selected ? this.elementOf(this.selected) : null;
    el?.classList.add('sel');
    this.placeHandle();
  }

  setHighlighting(on: boolean): void {
    if (on) this.cancelDrag();
    this.highlighting = on;
    this.stage.classList.toggle('highlighting', on);
    this.placeHandle();
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

  private pathPoints(): { start: Point; end: Point } | null {
    if (this.selected?.kind !== 'edge') return null;
    const path = this.elementOf(this.selected) as SVGPathElement | null;
    const points = path?.getAttribute('d') ? pathEnds(path) : null;
    const matrix = path?.getScreenCTM();
    if (!points || !matrix) return null;
    const convert = (p: Point): Point => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f });
    return { start: convert(points.start), end: convert(points.end) };
  }

  private placeHandle(): void {
    const selected = this.selected;
    const el = selected && selected.kind !== 'edge' && !this.highlighting && this.allowed(selected) ? this.elementOf(selected) : null;
    this.handle.hidden = !el;
    const s = this.stage.getBoundingClientRect();
    if (el) {
      const r = el.getBoundingClientRect();
      this.handle.style.left = `${r.right - s.left + 6}px`;
      this.handle.style.top = `${r.top - s.top + r.height / 2 - 11}px`;
    }
    const points = !this.highlighting ? this.pathPoints() : null;
    for (const end of ['start', 'end'] as const) {
      const button = this.endHandles[end];
      button.hidden = !points;
      if (points) {
        button.style.left = `${points[end].x - s.left - 9}px`;
        button.style.top = `${points[end].y - s.top - 9}px`;
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

  private beginDrag(e: PointerEvent, button: HTMLButtonElement, fixedClient: Point, kind: Drag['kind'], id: string, index?: number, end?: End): void {
    if (e.button !== 0 || this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    const s = this.stage.getBoundingClientRect();
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    this.overlay.append(line);
    this.drag = { pointerId: e.pointerId, button, origin: { x: e.clientX, y: e.clientY }, pointer: { x: e.clientX, y: e.clientY },
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
    this.placeHandle();
    this.refreshDrag();
  }

  fit(): void {
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
    this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
  }

  private bind(): void {
    const { stage } = this;

    stage.addEventListener('wheel', (e) => this.wheelZoom(e), { passive: false });

    // Drag anywhere to pan; a press that does not move is a click.
    let pan: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target === this.handle || e.target === this.endHandles.start || e.target === this.endHandles.end)) return;
      pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, id: e.pointerId };
      this.moved = false;
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (!this.moved && Math.hypot(dx, dy) < 4) return;
      if (!this.moved) { this.moved = true; this.manual = true; stage.setPointerCapture(pan.id); stage.classList.add('panning'); }
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
      if (this.moved || (e.target === this.handle || e.target === this.endHandles.start || e.target === this.endHandles.end)) { this.moved = false; return; }
      const t = this.targetAt(e.target as Element);
      if (this.highlighting && t) { this.events.onHighlight(t); return; }
      if (e.shiftKey && t && t.kind !== 'edge' && this.allowed(t) && this.selected && this.selected.kind !== 'edge' && this.allowed(this.selected)) {
        this.events.onConnect(this.selected.id, t.id);
        return;
      }
      this.events.onSelect(t);
    });
    stage.addEventListener('dblclick', (e) => {
      if (this.highlighting) return; // two quick clicks there are two highlight clicks
      const t = this.targetAt(e.target as Element);
      if (t) this.events.onRename(t);
      else if (this.snap) this.events.onAddNode();
    });

    // Both kinds of handle use pointer capture, the same preview, and the same edge scrolling.
    this.handle.addEventListener('pointerdown', (e) => {
      const selected = this.selected;
      if (!selected || selected.kind === 'edge' || !this.allowed(selected)) return;
      const r = this.elementOf(selected)?.getBoundingClientRect();
      if (r) this.beginDrag(e, this.handle, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, 'connect', selected.id);
    });
    for (const end of ['start', 'end'] as const) {
      const button = this.endHandles[end];
      button.addEventListener('pointerdown', (e) => {
        const selected = this.selected;
        const points = this.pathPoints();
        if (selected?.kind !== 'edge' || !points) return;
        const edge = this.snap?.edges[selected.index];
        if (edge) this.beginDrag(e, button, points[end === 'start' ? 'end' : 'start'], 'end', edge[end], selected.index, end);
      });
    }
    for (const button of [this.handle, this.endHandles.start, this.endHandles.end]) {
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
        else if (target.id !== d.id && d.index !== undefined && d.end) this.events.onMoveEnd(d.index, d.end, target.id);
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
