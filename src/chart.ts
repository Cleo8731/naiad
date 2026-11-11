// The chart view: draws the file with Mermaid's own engine, then maps the drawing back
// to the file's nodes, arrows and groups so they can be clicked, selected and connected.

import mermaid from 'mermaid';
import { forMermaid, type Snap } from './semantics';

export type Target =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; index: number }
  | { kind: 'sub'; id: string };

export interface ChartEvents {
  onSelect(target: Target | null): void;
  /** A click on an item while the Highlight switch is on. */
  onHighlight(target: Target): void;
  onConnect(from: string, to: string): void;
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
let drawCount = 0;

export class Chart {
  private canvas: HTMLDivElement;
  private overlay: SVGSVGElement;
  private handle: HTMLButtonElement;
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
    stage.append(this.canvas, this.overlay, this.handle);
    this.bind();
  }

  /** Call when another file is opened, so the next drawing is fitted to the window. */
  resetView(): void { this.fitted = false; }

  async draw(text: string, snap: Snap): Promise<void> {
    const id = `chart${++drawCount}`;
    const { svg } = await mermaid.render(id, forMermaid(text));
    this.canvas.innerHTML = svg;
    this.snap = snap;
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
    this.canvas.innerHTML = '';
    this.snap = null;
    this.handle.hidden = true;
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

  private placeHandle(): void {
    // No connecting while the Highlight switch is on: a click there highlights.
    const el = this.selected && this.selected.kind !== 'edge' && !this.highlighting ? this.elementOf(this.selected) : null;
    if (!el) { this.handle.hidden = true; return; }
    const r = el.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    this.handle.hidden = false;
    this.handle.style.left = `${r.right - s.left + 6}px`;
    this.handle.style.top = `${r.top - s.top + r.height / 2 - 11}px`;
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

  private bind(): void {
    const { stage } = this;

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.manual = true;
      const r = stage.getBoundingClientRect();
      this.zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // Drag anywhere to pan; a press that does not move is a click.
    let pan: { x: number; y: number; vx: number; vy: number; id: number } | null = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === this.handle) return;
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
      if (this.moved || e.target === this.handle) { this.moved = false; return; }
      const t = this.targetAt(e.target as Element);
      if (this.highlighting && t) { this.events.onHighlight(t); return; }
      if (e.shiftKey && t && t.kind !== 'edge' && this.selected && this.selected.kind !== 'edge') {
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

    // Connect: drag from the handle beside the selected node onto another node.
    let from: { id: string; x: number; y: number; line: SVGLineElement } | null = null;
    this.handle.addEventListener('pointerdown', (e) => {
      if (!this.selected || this.selected.kind === 'edge') return;
      e.preventDefault();
      const s = stage.getBoundingClientRect();
      const r = this.elementOf(this.selected)!.getBoundingClientRect();
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const x = r.left + r.width / 2 - s.left;
      const y = r.top + r.height / 2 - s.top;
      for (const [k, v] of [['x1', x], ['y1', y], ['x2', x], ['y2', y]] as const) line.setAttribute(k, String(v));
      this.overlay.append(line);
      from = { id: this.selected.id, x: e.clientX, y: e.clientY, line };
      this.handle.setPointerCapture(e.pointerId);
    });
    this.handle.addEventListener('pointermove', (e) => {
      if (!from) return;
      const s = stage.getBoundingClientRect();
      from.line.setAttribute('x2', String(e.clientX - s.left));
      from.line.setAttribute('y2', String(e.clientY - s.top));
      this.canvas.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
      const t = this.dropTarget(e.clientX, e.clientY);
      if (t) this.elementOf(t)?.classList.add('drop');
    });
    const endConnect = (e: PointerEvent) => {
      if (!from) return;
      const start = from;
      from = null;
      start.line.remove();
      this.canvas.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
      if (e.type !== 'pointerup' || Math.hypot(e.clientX - start.x, e.clientY - start.y) < 8) return;
      const t = this.dropTarget(e.clientX, e.clientY);
      if (t) this.events.onConnect(start.id, t.id);
    };
    this.handle.addEventListener('pointerup', endConnect);
    this.handle.addEventListener('pointercancel', endConnect);

    // When a side panel opens or closes, keep the chart centred and the selection in view.
    let width = stage.clientWidth;
    new ResizeObserver(() => {
      const next = stage.clientWidth;
      this.view.x += (next - width) / 2;
      width = next;
      this.apply();
      this.reveal();
    }).observe(stage);
  }

  private dropTarget(x: number, y: number): { kind: 'node' | 'sub'; id: string } | null {
    for (const el of document.elementsFromPoint(x, y)) {
      const t = this.targetAt(el);
      if (t && t.kind !== 'edge') return t;
    }
    return null;
  }
}
