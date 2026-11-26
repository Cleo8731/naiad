// What a print holds (T6.3; the user, 2026-11-25, Q221 and Q223): a sheet laid in the
// page only while printing, which the print layout (`style.css`, `@media print`) shows
// alone: the flowchart's name; its description, if ticked; the chart, if ticked, drawn
// for paper into the sheet's `.print-chart` by the caller; and, if ticked, each node
// that has a description, under its title, in the file's order.

import type { PrintChoice } from './overlays';
import { renderMarkdown } from './sidebar';

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

export function printSheet(contents: PrintContents, choice: PrintChoice): HTMLElement {
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
