// @vitest-environment jsdom
// A node under the pointer grows and lifts (Q240; the user, 2026-11-26: "Grow and lift is
// best"), and class colours no longer block the window's marks (T6.5's finding): in the
// window the shapes' inline class colours lose `!important`; a saved picture gets it back.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readyToLift, relockColours, unlockColours, unready } from '../src/class-colours';

const SVG_NS = 'http://www.w3.org/2000/svg';
afterEach(() => { document.body.innerHTML = ''; });

/** A drawing with one class-coloured node, as Mermaid writes it: a box, and a label whose text has its own colour. */
function drawing(): { svg: SVGSVGElement; g: SVGGElement; box: SVGRectElement; text: HTMLElement } {
  document.body.innerHTML = `<svg xmlns="${SVG_NS}" id="chart1"><g class="node process" transform="translate(120.5, 40)">`
    + `<rect class="basic label-container" style="fill:#e7f0ff !important;stroke:#385b8c !important;stroke-width:2px !important"></rect>`
    + `<g class="label" style="color:#142942 !important"><foreignObject><div><span class="nodeLabel" style="color:#142942 !important">Ask</span></div></foreignObject></g>`
    + `</g></svg>`;
  const svg = document.querySelector('svg')!;
  return { svg, g: svg.querySelector('g.node')!, box: svg.querySelector('rect')!, text: svg.querySelector('span')! };
}

describe('class colours in the window', () => {
  test('a shape keeps its colours without !important, and notes which it had', () => {
    const { svg, box } = drawing();
    unlockColours(svg);
    for (const p of ['fill', 'stroke', 'stroke-width']) expect(box.style.getPropertyPriority(p), p).toBe('');
    expect(box.style.getPropertyValue('stroke-width')).toBe('2px');
    expect(box.getAttribute('data-was-important')).toBe('fill stroke stroke-width');
  });

  test('a label\'s text keeps its own colour as Mermaid wrote it', () => {
    const { svg, text } = drawing();
    unlockColours(svg);
    expect(text.style.getPropertyPriority('color')).toBe('important');
    expect(svg.querySelector('g.label')!.hasAttribute('data-was-important')).toBe(false);
  });

  test('a class\'s rule loses !important on the shapes\' colours, so a node\'s own colour beats its class (1.0.2, the user: "Picking another swatch doesn\'t even change its color")', () => {
    const { svg } = drawing();
    const style = document.createElementNS(SVG_NS, 'style');
    // As Mermaid writes a classDef, on one line: the shapes' rule and the text's.
    style.textContent = '#chart1 .node rect{fill:#ECECFF;}#chart1 .process>*{fill:#e7f0ff!important;stroke:#385b8c!important;color:#142942!important;stroke-width:2px !important;}'
      + '#chart1 .process span{fill:#e7f0ff!important;color:#142942!important;}#chart1 .sel>*{stroke:red!important;}';
    svg.prepend(style);
    unlockColours(svg);
    expect(style.textContent).toBe('#chart1 .node rect{fill:#ECECFF;}#chart1 .process>*{fill:#e7f0ff;stroke:#385b8c;color:#142942!important;stroke-width:2px;}'
      + '#chart1 .process span{fill:#e7f0ff!important;color:#142942!important;}#chart1 .sel>*{stroke:red;}');
  });

  test('a saved picture gets !important back, and no trace of the window', () => {
    const { svg } = drawing();
    unlockColours(svg);
    const copy = svg.cloneNode(true) as SVGSVGElement;
    relockColours(copy);
    const box = copy.querySelector('rect')!;
    for (const p of ['fill', 'stroke', 'stroke-width']) expect(box.style.getPropertyPriority(p), p).toBe('important');
    expect(copy.querySelector('[data-was-important]')).toBeNull();
    expect(svg.querySelector('rect')!.style.getPropertyPriority('fill')).toBe(''); // the window's own stays unlocked
  });
});

describe('a node made ready to grow and lift', () => {
  test('grows about its centre, the translate Mermaid draws it round', () => {
    const { g } = drawing();
    readyToLift(g);
    expect(g.style.transformOrigin).toBe('120.5px 40px');
  });

  test('a part of its shape with a fill keeps it as --own-fill; one with none keeps nothing', () => {
    const { g, box } = drawing();
    const border = document.createElementNS(SVG_NS, 'path');
    border.setAttribute('class', 'label-container');
    border.setAttribute('style', 'fill:none;stroke:#385b8c');
    g.append(border);
    readyToLift(g);
    expect(box.style.getPropertyValue('--own-fill')).not.toBe('');
    expect(border.style.getPropertyValue('--own-fill')).toBe('');
  });

  test('a saved picture leaves the grow\'s centre and the kept fill out', () => {
    const { svg, g } = drawing();
    readyToLift(g);
    unready(svg);
    expect(g.style.transformOrigin).toBe('');
    expect(svg.querySelector('rect')!.style.getPropertyValue('--own-fill')).toBe('');
  });
});

describe('the stylesheet', () => {
  const css = readFileSync(resolve('src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    const at = css.indexOf(selector);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };

  test('a node under the pointer is 5% bigger, with a shadow and a lighter fill of its own', () => {
    expect(rule('.canvas g.node.hov {')).toMatch(/scale:\s*1\.05/);
    expect(rule('.canvas:not(#_) .node.hov > :is(rect')).toMatch(/drop-shadow\(0 2px 2px[^;]*drop-shadow\(0 6px 10px/);
    expect(rule('.canvas:not(#_) .node.hov:not(.sel) [style*="--own-fill"]')).toMatch(/color-mix\(in srgb, var\(--own-fill\) 86%, white\) !important/);
  });

  test('a node under the pointer keeps its own border: no accent border', () => {
    expect(css).not.toMatch(/\.node\.hov[^{]*\{[^}]*stroke:/);
  });

  test('the selection, the hover and a drop on nodes and groups outweigh the chart\'s class rules', () => {
    for (const s of ['.node.sel .label-container', '.cluster.sel > rect', '.node.hov .label-container', '.cluster.hov > rect', '.drop .label-container']) {
      expect(css, s).toContain(`.canvas:not(#_) ${s}`);
      expect(css, s).not.toMatch(new RegExp(`(^|[,\\n])\\s*\\.canvas ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  });

  test('the grow is not animated when the computer asks for less motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.canvas :is\(g\.node, g\.edgeLabel\) \{ transition: opacity 120ms ease; \} \}/);
  });
});
