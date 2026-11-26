// @vitest-environment jsdom
// Direction marks (D1.8, the user, 2026-11-14): small arrowheads along a long arrow, so
// its middle says which way it goes. Where they sit along straight, bent and gapped
// arrows; which arrows get them; and that they follow the arrow's look.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { addDirectionMarks, chevrons, marksAlong, MARK_EVERY, MARKS_FROM, type Mark } from '../src/direction-marks';

const round = (marks: Mark[]) => marks.map((m) => ({ x: Math.round(m.x), y: Math.round(m.y), dx: m.dx, dy: m.dy }));

describe('where the marks sit', () => {
  test('a short arrow gets none', () => {
    expect(marksAlong('M0,0L0,100')).toEqual([]);
    expect(marksAlong(`M0,0L0,${MARKS_FROM - 1}`)).toEqual([]);
  });

  test('a long straight arrow gets them about every 150 px, none near its ends, pointing the way it goes', () => {
    expect(round(marksAlong('M0,0L0,600'))).toEqual([150, 300, 450].map((y) => ({ x: 0, y, dx: 0, dy: 1 })));
    expect(round(marksAlong('M0,600L0,0'))).toEqual([450, 300, 150].map((y) => ({ x: 0, y, dx: 0, dy: -1 })));
    expect(round(marksAlong('M600,10L0,10'))).toEqual([450, 300, 150].map((x) => ({ x, y: 10, dx: -1, dy: 0 })));
  });

  test('the shortest arrow that gets marks has one, in its middle', () => {
    expect(round(marksAlong(`M0,0L${MARKS_FROM},0`))).toEqual([{ x: MARKS_FROM / 2, y: 0, dx: 1, dy: 0 }]);
  });

  test('on any length the marks and the ends are 0.8 to 1.25 spacings apart', () => {
    for (let n = MARKS_FROM; n < 3000; n += 37) {
      const ys = marksAlong(`M0,0L0,${n}`).map((m) => m.y);
      const gaps = [ys[0], ...ys.slice(1).map((y, i) => y - ys[i]), n - ys[ys.length - 1]];
      expect(Math.min(...gaps), `length ${n}`).toBeGreaterThanOrEqual(0.8 * MARK_EVERY);
      expect(Math.max(...gaps), `length ${n}`).toBeLessThanOrEqual(1.25 * MARK_EVERY);
    }
  });

  test('a bent arrow: marks sit on its straight runs, off the bend, each pointing along its run', () => {
    // Down 286 px, a rounded bend 14 px across, then right 300 px.
    const marks = marksAlong('M0,0L0,286Q0,300 14,300L314,300');
    expect(marks).toHaveLength(3);
    const down = marks.filter((m) => m.x === 0 && m.dx === 0 && m.dy === 1);
    const right = marks.filter((m) => m.y === 300 && m.dx === 1 && m.dy === 0);
    expect(down.length + right.length).toBe(3);
    expect(down.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    for (const m of down) expect(m.y).toBeLessThanOrEqual(286 - 10);
    for (const m of right) expect(m.x).toBeGreaterThanOrEqual(14 + 10);
  });

  test('an arrow cut by a gap where it crosses another: no mark in the gap or at its edges', () => {
    // 295 px, a 12 px gap, then 293 px: the middle mark would fall at the gap.
    const marks = marksAlong('M0,0L0,295M0,307L0,600');
    expect(marks).toHaveLength(3);
    for (const m of marks) expect(m.y <= 295 - 10 || m.y >= 307 + 10, `y ${m.y}`).toBe(true);
    expect(marks.every((m) => m.dy === 1)).toBe(true);
  });

  test('a gap does not count as length: two short pieces get none', () => {
    expect(marksAlong('M0,0L0,120M0,400L0,520')).toEqual([]);
  });

  test('a mark never sits under an arrow label', () => {
    const label = { left: -30, top: 140, right: 30, bottom: 160 };
    const marks = marksAlong('M0,0L0,600', [label]);
    expect(marks).toHaveLength(3);
    for (const m of marks) expect(m.y < label.top - 4 || m.y > label.bottom + 4, `y ${m.y}`).toBe(true);
    // A label covering most of the arrow leaves fewer marks, not marks piled together.
    const few = marksAlong('M0,0L0,600', [{ left: -30, top: 60, right: 30, bottom: 540 }]);
    expect(few.length).toBeLessThan(3);
    for (let i = 1; i < few.length; i++) expect(few[i].y - few[i - 1].y).toBeGreaterThanOrEqual(MARK_EVERY / 2);
  });

  test('a path Naiad cannot read gets none', () => {
    expect(marksAlong('')).toEqual([]);
    expect(marksAlong('M0,0A10,10 0 0 1 300,300L600,600')).toEqual([]);
    expect(marksAlong('L0,600')).toEqual([]);
  });

  test('a curved arrow gets marks only on its straight runs', () => {
    expect(marksAlong('M0,0C0,300 600,300 600,600')).toEqual([]);
  });
});

test('each mark is drawn as a chevron pointing the way the arrow goes', () => {
  expect(chevrons([{ x: 0, y: 150, dx: 0, dy: 1 }])).toBe('M-5,146.5L0,153.5L5,146.5');
  expect(chevrons([{ x: 100, y: 10, dx: -1, dy: 0 }, { x: 0, y: 0, dx: 0, dy: -1 }]))
    .toBe('M103.5,5L96.5,10L103.5,15M5,3.5L0,-3.5L-5,3.5');
});

describe('on a drawn chart', () => {
  afterEach(() => { document.body.innerHTML = ''; });
  const drawn = (paths: string, labels = '') => {
    document.body.innerHTML = `<div class="stage"><div class="canvas"><svg xmlns="http://www.w3.org/2000/svg">`
      + `<g class="edgePaths">${paths}</g><g class="edgeLabels">${labels}</g></svg></div></div>`;
    return document.querySelector('svg')!;
  };
  const arrow = (i: number, d: string, extra = 'marker-end="url(#c_flowchart-v2-pointEnd)"') =>
    `<path data-edge="true" data-edge-line="${i}" class="edge-thickness-normal edge-pattern-dotted flowchart-link" style="stroke:#e11;stroke-width:3px;" ${extra} d="${d}"></path>`
    + `<path class="edge-hit" data-edge="${i}" d="${d}"></path>`;

  test('a long arrow with a head gets one mark path, just after it and under its click copy, in its colour', () => {
    const svg = drawn(arrow(0, 'M0,0L0,600'));
    addDirectionMarks(svg);
    const line = svg.querySelector('[data-edge-line="0"]')!;
    const mark = line.nextElementSibling!;
    expect(mark.getAttribute('class')).toBe('edge-thickness-normal edge-pattern-dotted flowchart-link dir-mark');
    expect(mark.getAttribute('style')).toBe('stroke:#e11');
    expect(mark.getAttribute('d')).toBe(chevrons(marksAlong('M0,0L0,600')));
    expect(mark.nextElementSibling?.classList.contains('edge-hit')).toBe(true);
    // Clicks, selection and trace find only the arrow itself.
    expect(mark.hasAttribute('data-edge')).toBe(false);
    expect(mark.hasAttribute('data-edge-line')).toBe(false);
    expect(svg.querySelectorAll('.dir-mark')).toHaveLength(1);
  });

  test('an arrow in the theme colour keeps it: nothing is set on the mark', () => {
    const svg = drawn(arrow(0, 'M0,0L0,600').replace('stroke:#e11;stroke-width:3px;', ';'));
    addDirectionMarks(svg);
    expect(svg.querySelector('.dir-mark')!.hasAttribute('style')).toBe(false);
  });

  test('only an arrow with one direction gets marks: none without a head, with a head at each end, or short', () => {
    const svg = drawn(arrow(0, 'M0,0L0,600', '') + arrow(1, 'M50,0L50,600', 'marker-start="url(#s)" marker-end="url(#e)"')
      + arrow(2, 'M100,0L100,100') + arrow(3, 'M150,0L150,600', 'marker-end="url(#c_flowchart-v2-circleEnd)"'));
    addDirectionMarks(svg);
    expect([...svg.querySelectorAll('.dir-mark')].map((m) => m.previousElementSibling?.getAttribute('data-edge-line'))).toEqual(['3']);
  });

  test('marks keep clear of the arrow labels drawn on the chart', () => {
    const label = '<g class="edgeLabel" transform="translate(0, 150)"><g class="label" data-id="L_a_b_0" transform="translate(-20, -10)">'
      + '<foreignObject width="40" height="20"></foreignObject></g></g>';
    const svg = drawn(arrow(0, 'M0,0L0,600'), label);
    addDirectionMarks(svg);
    expect(svg.querySelector('.dir-mark')!.getAttribute('d')).toBe(chevrons(marksAlong('M0,0L0,600', [{ left: -20, top: 140, right: 20, bottom: 160 }])));
    expect(svg.querySelector('.dir-mark')!.getAttribute('d')).not.toBe(chevrons(marksAlong('M0,0L0,600')));
  });

  describe('marks follow the arrow\'s look', () => {
    // The stylesheet's rules whose declarations hold `wanted`, as selector lists.
    const css = readFileSync(resolve('src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
    const split = (list: string) => {
      const out: string[] = []; let depth = 0; let cur = '';
      for (const ch of list) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      return [...out, cur.trim()];
    };
    const styled = (el: Element, wanted: string) => rules.some((r) => r.body.includes(wanted)
      && split(r.sel).some((s) => { try { return el.matches(s); } catch { return false; } }));
    const setup = () => {
      const svg = drawn(arrow(0, 'M0,0L0,600'));
      addDirectionMarks(svg);
      return { stage: document.querySelector('.stage')!, line: svg.querySelector('[data-edge-line="0"]')!, mark: svg.querySelector('.dir-mark')! };
    };

    test('they take no clicks and are never dotted or dashed', () => {
      const { mark } = setup();
      expect(styled(mark, 'pointer-events: none')).toBe(true);
      expect(styled(mark, 'stroke-dasharray: none !important')).toBe(true);
    });
    test('they fade with the arrow while another item is traced', () => {
      const { stage, line, mark } = setup();
      expect(styled(mark, 'opacity: 0.22')).toBe(false);
      stage.classList.add('tracing');
      expect(styled(mark, 'opacity: 0.22')).toBe(true);
      line.classList.add('lit');
      expect(styled(mark, 'opacity: 0.22')).toBe(false);
    });
    test('they take the selection\'s colour, the full accent, a little thicker, under the pointer (Q244), and a highlight\'s halo', () => {
      const { line, mark } = setup();
      // The selection's colour is `--select`: the accent, except in Glacier (T4.9).
      for (const [cls, wanted] of [['sel', 'stroke: var(--select) !important'], ['hov', 'stroke-width: 2.5px !important'], ['hl', 'drop-shadow']]) {
        expect(styled(mark, wanted), cls).toBe(false);
        line.classList.add(cls);
        expect(styled(mark, wanted), cls).toBe(true);
        line.classList.remove(cls);
      }
    });
  });
});
