// What a print holds (T6.3; the user, 2026-11-25, Q221 and Q223): a sheet laid in the
// page only while printing, which the print layout (`style.css`, `@media print`) shows
// alone: the flowchart's name; its description, if ticked; the chart, if ticked, drawn
// for paper into the sheet's `.print-chart` by the caller; and, if ticked, each node
// that has a description, under its title, in the file's order.
//
// A chart printed over several pages (D6.2, Q226 to Q228) is laid by `layParts`: each
// page shows one window of the drawing, under a line with the flowchart's name and
// "Part 2 of 7"; when the parts form a grid, a first page shows the whole chart with
// each part's outline and number, so the pages can be put together.

import { renameIds, sizeOf } from './export';
import type { PrintChoice } from './overlays';
import { MARGIN_MM, PX_PER_MM, pageMm, type PagePlan, type Rect } from './print-pages';
import { renderMarkdown } from './sidebar';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface PrintContents {
  name: string;
  /** The flowchart's description, as Markdown ('' for none). */
  about: string;
  nodes: { title: string; description: string }[];
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function printSheet(contents: PrintContents, choice: Pick<PrintChoice, 'chart' | 'about' | 'nodes'>): HTMLElement {
  const sheet = el('div', 'print-sheet');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.append(el('h1', '', contents.name));
  if (choice.about) {
    const about = el('div', 'print-about');
    if (contents.about) about.innerHTML = renderMarkdown(contents.about);
    else about.append(el('p', 'print-none', 'This flowchart has no description.'));
    sheet.append(about);
  }
  if (choice.chart) sheet.append(el('div', 'print-chart'));
  if (choice.nodes) {
    const nodes = el('div', 'print-nodes');
    for (const node of contents.nodes) {
      const section = el('section', '');
      const body = el('div', 'print-description');
      body.innerHTML = renderMarkdown(node.description);
      section.append(el('h3', '', node.title), body);
      nodes.append(section);
    }
    if (!contents.nodes.length) nodes.append(el('p', 'print-none', 'No node has a description.'));
    sheet.append(nodes);
  }
  return sheet;
}

/**
 * The drawing's frame and its boxes (the nodes, the arrows' labels, the groups' names),
 * in the drawing's own units, for working out where a page may be cut. The drawing must
 * be in the page, laid out.
 */
export function measureDrawing(svg: SVGSVGElement): { chart: Rect; boxes: Rect[] } {
  const chart = sizeOf(svg);
  const frame = svg.getBoundingClientRect();
  const kx = frame.width ? chart.w / frame.width : 1;
  const ky = frame.height ? chart.h / frame.height : 1;
  const boxes: Rect[] = [];
  for (const el of svg.querySelectorAll('g.node, g.edgeLabel, .cluster-label')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    boxes.push({ x: chart.x + (r.left - frame.left) * kx, y: chart.y + (r.top - frame.top) * ky, w: r.width * kx, h: r.height * ky });
  }
  return { chart, boxes };
}

/** The page's size for a print over several pages, in the print rules, so the print window's preview matches the parts (Q228). */
export function pageSizeRule(plan: PagePlan): string {
  const [w, h] = pageMm(plan.paper, plan.orientation);
  return `@media print { @page { size: ${String(w)}mm ${String(h)}mm; margin: 0; } }`;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** A copy of the drawing showing one window of it, at the plan's scale, with ids of its own. */
function window_(svg: SVGSVGElement, r: Rect, scale: number, prefix: string): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('viewBox', `${String(r.x)} ${String(r.y)} ${String(r.w)} ${String(r.h)}`);
  copy.setAttribute('width', String(r.w * scale));
  copy.setAttribute('height', String(r.h * scale));
  copy.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  renameIds(copy, prefix);
  return copy;
}

/**
 * Lays a chart printed over several pages into the sheet (D6.2): the drawing `svg`, in
 * the sheet's `.print-chart`, is replaced by one page per part. The sheet's heading and
 * the flowchart's description stay on a first page only when there is something for it
 * to hold besides the name (the description, or the map of a grid); otherwise each part's
 * line names the flowchart and the heading goes.
 */
export function layParts(sheet: HTMLElement, svg: SVGSVGElement, plan: PagePlan, name: string): void {
  const holder = sheet.querySelector<HTMLElement>('.print-chart');
  if (!holder) return;
  sheet.classList.add('print-pages');
  const grid = plan.cols > 1;
  const front = grid || !!sheet.querySelector('.print-about');
  svg.remove();
  if (grid) {
    // The map: the whole chart, each part's outline and number over it.
    const map = svg.cloneNode(true) as SVGSVGElement;
    renameIds(map, 'map-');
    const chart = sizeOf(svg);
    const [pw, ph] = pageMm(plan.paper, plan.orientation);
    const shown = Math.min(1, ((pw - 2 * MARGIN_MM) * PX_PER_MM) / chart.w); // about the map's printed scale
    const g = svgEl('g', { class: 'print-map-parts' });
    plan.parts.forEach((part, i) => {
      g.append(svgEl('rect', { x: part.x, y: part.y, width: part.w, height: part.h }));
      const label = svgEl('text', { x: part.x + part.w / 2, y: part.y + part.h / 2 });
      label.style.fontSize = `${String(16 / shown)}px`; // about 12 pt on paper
      label.textContent = String(i + 1);
      g.append(label);
    });
    map.append(g);
    map.style.maxHeight = `${String(ph - 2 * MARGIN_MM - 14)}mm`; // on the first page, under the heading
    holder.classList.add('print-map');
    holder.append(map);
  } else {
    holder.remove();
  }
  if (!front) sheet.querySelector('h1')?.remove();
  const n = plan.parts.length;
  const nodes = sheet.querySelector('.print-nodes'); // the parts go before each node's description
  plan.parts.forEach((part, i) => {
    const page = el('div', 'print-part');
    if (i === 0 && !front) page.classList.add('print-part-first');
    const head = el('div', 'print-part-head');
    const where = grid ? `, row ${String(part.row + 1)}, column ${String(part.col + 1)}` : '';
    head.append(el('span', '', name), el('span', '', `Part ${String(i + 1)} of ${String(n)}${where}`));
    page.append(head, window_(svg, part, plan.scale, `p${String(i + 1)}-`));
    sheet.insertBefore(page, nodes);
  });
}
