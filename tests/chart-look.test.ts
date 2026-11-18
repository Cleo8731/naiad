// @vitest-environment jsdom
// The chart's group titles and arrow labels (the user's questions of 2026-11-18, answered
// "Yes to all three"):
// - Q173: a group's title is semibold and a little larger than a node's text, in a grey
//   lighter than before, so it reads as the group's title.
// - Q174: an arrow passes behind a group's title instead of through it: the title sits on
//   a small plate in the group's colour, drawn above the arrows.
// - Q175: an arrow label sits in a soft pill with no border and a small margin, a little
//   lighter than the chart, its text a little smaller and grey, so it reads as a caption
//   and not as a node.
// Q173 and Q175 are rules Mermaid applies before it measures, so the layout makes room.
import { afterEach, describe, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';
import { configureMermaid } from '../src/chart';
import { raiseGroupTitles } from '../src/group-titles';

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

/** The style rules Naiad hands Mermaid, as one line per rule. */
function themeCss(dark: boolean): string {
  const init = vi.spyOn(mermaid, 'initialize');
  configureMermaid(dark);
  return String(init.mock.lastCall?.[0].themeCSS ?? '');
}
const ruleFor = (css: string, selector: string) =>
  css.split('}').find((r) => r.split('{')[0].split(',').map((s) => s.trim()).includes(selector))?.split('{')[1] ?? '';

describe('group titles (Q173)', () => {
  test('are semibold and a little larger than a node\'s 14 px, in light and dark', () => {
    for (const dark of [false, true]) {
      const rule = ruleFor(themeCss(dark), '.cluster-label span');
      expect(rule, String(dark)).toMatch(/font-weight:\s*600/);
      expect(rule, String(dark)).toMatch(/font-size:\s*15px/);
    }
  });

  test('take a grey between the muted colour and the text\'s', () => {
    const rule = ruleFor(themeCss(true), '.cluster-label span');
    expect(rule).toMatch(/color:\s*color-mix\(in srgb, #8fb0b5 \d+%, #e3f1f2\)/);
  });
});

describe('arrow labels (Q175)', () => {
  test('sit in a pill with a small margin, a little lighter than the chart, with no border', () => {
    const rule = ruleFor(themeCss(true), '.labelBkg');
    expect(rule).toMatch(/padding:\s*2px 7px/);
    expect(rule).toMatch(/border-radius:\s*999px/);
    expect(rule).toMatch(/background-color:\s*color-mix\(in srgb, #5592a0 \d+%, #0b1c21\)/);
    expect(rule).not.toMatch(/border:/);
  });

  test('the text inside has no background of its own, and is a little smaller and grey', () => {
    const css = themeCss(false);
    expect(ruleFor(css, '.edgeLabel p')).toMatch(/background-color:\s*transparent/);
    expect(ruleFor(css, 'span.edgeLabel')).toMatch(/background-color:\s*transparent/);
    const text = ruleFor(css, '.labelBkg .edgeLabel');
    expect(text).toMatch(/font-size:\s*13px/);
    expect(text).toMatch(/color:\s*color-mix\(in srgb, #4d6a6f \d+%, #12292f\)/);
  });
});

describe('a group\'s title above the arrows (Q174)', () => {
  const NS = 'http://www.w3.org/2000/svg';
  const cluster = (sub: string, fill = '') =>
    `<g class="cluster" id="chart1-${sub}" data-sub="${sub}"><rect style="${fill}" x="10" y="12" width="300" height="120"></rect>`
    + `<g class="cluster-label" transform="translate(130, 12)"><foreignObject width="48" height="21"><div><span class="nodeLabel"><p>${sub}</p></span></div></foreignObject></g></g>`;
  const drawn = (clusters: string) => {
    document.body.innerHTML = `<svg xmlns="${NS}"><g class="root"><g class="clusters">${clusters}</g>`
      + '<g class="edges edgePaths"><path d="M150,0L150,100"></path></g><g class="edgeLabels"></g><g class="nodes"></g></g></svg>';
    return document.querySelector('svg')!;
  };

  test('each title moves to a layer just after the arrows and before the labels, where it was', () => {
    const svg = drawn(cluster('review') + cluster('train'));
    raiseGroupTitles(svg);
    const layer = svg.querySelector('g.group-titles')!;
    expect(layer.previousElementSibling?.classList.contains('edgePaths')).toBe(true);
    expect(layer.nextElementSibling?.classList.contains('edgeLabels')).toBe(true);
    expect([...layer.children].map((g) => g.textContent)).toEqual(['review', 'train']);
    expect(svg.querySelectorAll('g.clusters .cluster-label')).toHaveLength(0);
    expect(layer.querySelector('.cluster-label')!.getAttribute('transform')).toBe('translate(130, 12)');
  });

  test('a click on a title still finds its group', () => {
    const svg = drawn(cluster('review'));
    raiseGroupTitles(svg);
    const title = svg.querySelector<SVGGElement>('g.group-titles .cluster-label')!;
    expect(title.dataset.sub).toBe('review');
    // The group itself comes first, so selecting it outlines the group, not its title.
    expect(svg.querySelector('[data-sub="review"]')!.classList.contains('cluster')).toBe(true);
  });

  test('under the title, a plate covers the arrows, inside the group\'s top edge', () => {
    const svg = drawn(cluster('review'));
    raiseGroupTitles(svg);
    const plate = svg.querySelector('g.group-titles .cluster-label > rect.group-plate')!;
    expect(plate).not.toBeNull();
    expect(plate.nextElementSibling?.tagName.toLowerCase()).toBe('foreignobject');
    expect([plate.getAttribute('x'), plate.getAttribute('y'), plate.getAttribute('width'), plate.getAttribute('height')])
      .toEqual(['-5', '2', '58', '19']);
  });

  test('the plate takes the group\'s own fill when the file colours the group', () => {
    const svg = drawn(cluster('review', 'fill:#ffeecc !important'));
    raiseGroupTitles(svg);
    expect((svg.querySelector('rect.group-plate') as SVGRectElement).style.fill).toBe('rgb(255, 238, 204)'); // #ffeecc
  });

  test('a group with no title, or a drawing without the arrows\' layer, is left as it is', () => {
    const svg = drawn('<g class="cluster" data-sub="a"><rect></rect></g>');
    raiseGroupTitles(svg);
    expect(svg.querySelector('g.group-titles')).toBeNull();
    document.body.innerHTML = `<svg xmlns="${NS}"><g class="root"><g class="clusters">${cluster('b')}</g></g></svg>`;
    raiseGroupTitles(document.querySelector('svg')!);
    expect(document.querySelector('g.clusters .cluster-label')).not.toBeNull();
  });
});
