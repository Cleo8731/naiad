// @vitest-environment jsdom
// An arrow under the pointer (Q244; the user, 2026-11-26: "Yes, softer glow"): its line,
// direction mark and arrowheads take the full accent with a faint glow, and its label
// grows 5% and lifts, as a node does. The arrowheads are shared markers, so the hovered
// line points at an accent copy of each; a saved picture keeps none of it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { lightArrow, unlightArrows, unreadyArrows } from '../src/arrow-hover';

const SVG_NS = 'http://www.w3.org/2000/svg';
afterEach(() => { document.body.innerHTML = ''; });

/** Two arrows sharing one arrowhead marker, as Mermaid draws them; the first has a label. */
function drawing() {
  document.body.innerHTML = `<svg xmlns="${SVG_NS}" id="chart1">`
    + `<marker id="chart1_flowchart-v2-pointEnd"><path d="M0,0L10,5L0,10z" style="fill:#333"></path></marker>`
    + `<path data-edge-line="0" marker-end="url(#chart1_flowchart-v2-pointEnd)"></path>`
    + `<path data-edge-line="1" marker-end="url(#chart1_flowchart-v2-pointEnd)" marker-start="url(#chart1_flowchart-v2-pointEnd)"></path>`
    + `<g class="edgeLabel" data-edge="0" transform="translate(80.25, 140)"><foreignObject><div class="labelBkg" style="background-color: rgb(30, 40, 50)">yes</div></foreignObject></g>`
    + `</svg>`;
  const svg = document.querySelector('svg')!;
  const [one, two] = svg.querySelectorAll('path[data-edge-line]');
  return { svg, one, two, label: svg.querySelector<SVGGElement>('g.edgeLabel')! };
}
const END = 'url(#chart1_flowchart-v2-pointEnd)';
const HOV = 'url(#chart1_flowchart-v2-pointEnd-hov)';

describe('lighting an arrow', () => {
  test('its arrowhead points at an accent copy of the marker, made once and next to it', () => {
    const { svg, one, two } = drawing();
    lightArrow(svg, one, null);
    expect(one.getAttribute('marker-end')).toBe(HOV);
    expect(two.getAttribute('marker-end')).toBe(END); // the other arrow keeps the shared one
    const copies = svg.querySelectorAll('marker.hov-marker');
    expect(copies).toHaveLength(1);
    expect(copies[0].id).toBe('chart1_flowchart-v2-pointEnd-hov');
    expect(copies[0].previousElementSibling?.id).toBe('chart1_flowchart-v2-pointEnd');
    unlightArrows(svg);
    lightArrow(svg, two, null); // both ends of an arrow drawn both ways
    expect(two.getAttribute('marker-start')).toBe(HOV);
    expect(two.getAttribute('marker-end')).toBe(HOV);
    expect(svg.querySelectorAll('marker.hov-marker')).toHaveLength(1);
  });

  test('putting it back restores the original markers and leaves no note', () => {
    const { svg, one, two } = drawing();
    lightArrow(svg, two, null);
    unlightArrows(svg);
    expect(two.getAttribute('marker-start')).toBe(END);
    expect(two.getAttribute('marker-end')).toBe(END);
    expect(svg.querySelector('[data-hov-marker-end], [data-hov-marker-start]')).toBeNull();
    expect(one.getAttribute('marker-end')).toBe(END);
  });

  test('lit twice, it still goes back to the original, not to the copy', () => {
    const { svg, one } = drawing();
    lightArrow(svg, one, null);
    lightArrow(svg, one, null);
    unlightArrows(svg);
    expect(one.getAttribute('marker-end')).toBe(END);
  });

  test('a line with no marker, or one whose marker is missing, is left alone', () => {
    const { svg, one } = drawing();
    one.removeAttribute('marker-end');
    lightArrow(svg, one, null);
    expect(one.hasAttribute('marker-end')).toBe(false);
    one.setAttribute('marker-end', 'url(#gone)');
    lightArrow(svg, one, null);
    expect(one.getAttribute('marker-end')).toBe('url(#gone)');
    expect(svg.querySelector('.hov-marker')).toBeNull();
  });

  test('its label grows about its own centre and keeps its pill\'s colour as --own-fill', () => {
    const { svg, one, label } = drawing();
    lightArrow(svg, one, label);
    expect(label.style.transformOrigin).toBe('80.25px 140px');
    expect(label.querySelector<HTMLElement>('.labelBkg')!.style.getPropertyValue('--own-fill')).toBe('rgb(30, 40, 50)');
  });

  test('a saved picture keeps no copy, no swapped marker and no grow centre', () => {
    const { svg, one, label } = drawing();
    lightArrow(svg, one, label);
    unreadyArrows(svg);
    expect(svg.querySelector('.hov-marker')).toBeNull();
    expect(one.getAttribute('marker-end')).toBe(END);
    expect(label.hasAttribute('style')).toBe(false);
    const pill = label.querySelector<HTMLElement>('.labelBkg')!;
    expect(pill.style.getPropertyValue('--own-fill')).toBe('');
    expect(pill.getAttribute('style')).toBe('background-color: rgb(30, 40, 50);'); // its own colour stays
  });
});

describe('the stylesheet', () => {
  const css = readFileSync(resolve('src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    const at = css.indexOf(selector);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };

  test('the line and its direction mark take the full accent, not a see-through one', () => {
    expect(rule('.canvas path.hov {')).toMatch(/stroke: var\(--select\) !important; stroke-width: 2\.5px !important/);
    expect(rule('.canvas path.hov + path.dir-mark {')).toMatch(/stroke: var\(--select\) !important/);
    expect(css).not.toMatch(/path\.hov[^{]*\{[^}]*var\(--select\) 55%, transparent\) !important/);
  });

  test('one faint glow, left off a highlighted arrow so its halo shows', () => {
    expect(rule('.canvas path.hov:not(.hl) {')).toMatch(/^\s*filter: drop-shadow\(0 0 1\.5px [^;]*\);\s*$/);
  });

  test('the arrowhead copies are in the accent', () => {
    expect(rule('.canvas:not(#_) .hov-marker * {')).toMatch(/fill: var\(--select\) !important; stroke: var\(--select\) !important/);
  });

  test('the label grows 5%, as a node does, with the node\'s shadow and an accent-tinted pill', () => {
    expect(rule('.canvas g.edgeLabel.hov {')).toMatch(/scale: 1\.05;/);
    expect(rule('.canvas g.edgeLabel.hov {')).toContain(rule('.canvas:not(#_) .node.hov > :is(rect').trim().replace(/^filter: /, '').replace(/;$/, ''));
    expect(rule('.canvas:not(#_) g.edgeLabel.hov .labelBkg[style*="--own-fill"] {')).toMatch(/color-mix\(in srgb, var\(--select\) 22%, var\(--own-fill\)\) !important/);
  });

  test('the selection\'s rules come after the hover\'s, so a selected arrow keeps its own look', () => {
    expect(css.indexOf('.canvas path.sel {')).toBeGreaterThan(css.indexOf('.canvas path.hov {'));
  });
});
