// @vitest-environment jsdom
// Two print fixes after T6.3's trial in the built program (the user, 2026-11-25):
// Q224, no header or footer from WebView2 on a printed page; Q225, a printed chart
// without its own front-matter title, which the sheet's heading already gives.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { dropTitle } from '../src/chart';

const SVG_NS = 'http://www.w3.org/2000/svg';
const css = readFileSync(resolve('src', 'style.css'), 'utf8');
const printBlock = css.slice(css.indexOf('@media print'));

describe('the print layout (Q224)', () => {
  test('the page has no margin, so WebView2 adds no header or footer', () => {
    expect(printBlock).toMatch(/@page\s*\{\s*margin:\s*0;\s*\}/);
  });

  test('the sheet carries the 14 mm margin instead, on every page', () => {
    const sheet = printBlock.match(/\.print-sheet\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(sheet).toMatch(/padding:\s*14mm/);
    expect(sheet).toMatch(/(^|[\s;])box-decoration-break:\s*clone/);
  });
});

describe('dropTitle (Q225)', () => {
  const realBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
  afterEach(() => {
    if (realBBox) Object.defineProperty(SVGElement.prototype, 'getBBox', realBBox);
    else delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
    document.body.replaceChildren();
  });

  function drawing(withTitle: boolean): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '4 -51.4 456 697.4');
    svg.setAttribute('width', '456');
    svg.setAttribute('height', '697.4');
    const g = document.createElementNS(SVG_NS, 'g');
    g.append(document.createElementNS(SVG_NS, 'rect'));
    svg.append(g);
    if (withTitle) {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('class', 'flowchartTitleText');
      t.textContent = 'Model pipeline';
      svg.append(t);
    }
    document.body.append(svg);
    return svg;
  }

  test('takes the title out and fits the frame to what is left, with 8 px of room', () => {
    // What is left once the title is gone: the chart from (12, 8), 440 by 630.
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 12, y: 8, width: 440, height: 630 }) });
    const svg = drawing(true);
    dropTitle(svg);
    expect(svg.querySelector('.flowchartTitleText')).toBeNull();
    expect(svg.getAttribute('viewBox')).toBe('4 0 456 646');
    expect(svg.getAttribute('width')).toBe('456');
    expect(svg.getAttribute('height')).toBe('646');
  });

  test('a chart without a title is left as it is', () => {
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => { throw new Error('measured'); } });
    const svg = drawing(false);
    dropTitle(svg);
    expect(svg.getAttribute('viewBox')).toBe('4 -51.4 456 697.4');
    expect(svg.getAttribute('height')).toBe('697.4');
  });
});

describe('renameIds (a print started without the print page)', () => {
  test('gives the copy\'s inner ids a prefix and points every reference at the new ones', async () => {
    const { renameIds } = await import('../src/export');
    const holder = document.createElement('div');
    holder.innerHTML = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" id="chart1">
      <style>#chart1 .node path{stroke:url(#chart1-gradient);} #chart1 .x{fill:url(#elsewhere);}</style>
      <linearGradient id="chart1-gradient"/><marker id="m1"/>
      <path marker-end="url(#m1)" marker-start="url('#m1')"/><use xlink:href="#m1"/><use href="#other"/>
    </svg>`;
    const svg = holder.querySelector('svg')!;
    renameIds(svg, 'print-');
    expect(svg.id).toBe('chart1'); // the copy keeps its own id: Mermaid's style names it
    expect([...svg.querySelectorAll('[id]')].map((e) => e.id)).toEqual(['print-chart1-gradient', 'print-m1']);
    const path = svg.querySelector('path')!;
    expect(path.getAttribute('marker-end')).toBe('url(#print-m1)');
    expect(path.getAttribute('marker-start')).toBe("url('#print-m1')");
    const [use1, use2] = svg.querySelectorAll('use');
    expect(use1.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#print-m1');
    expect(use2.getAttribute('href')).toBe('#other'); // not an id in the copy: left alone
    const css = svg.querySelector('style')!.textContent!;
    expect(css).toContain('url(#print-chart1-gradient)');
    expect(css).toContain('url(#elsewhere)');
    expect(css).toContain('#chart1 .node');
  });
});
