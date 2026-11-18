// @vitest-environment jsdom
// The dot grid (T4.18): it moves with the chart and its spacing follows the zoom, in
// steps that keep the dots 12 to 44 px apart on screen (Q187); its dots stand out from
// the background at about 1.5 to 1 in every theme and mode (Q188).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';
import { Chart, type ChartEvents } from '../src/chart';
import type { Snap } from '../src/semantics';

const snap: Snap = {
  direction: 'TD',
  nodes: { A: { text: 'A', type: 'square', styles: [], classes: [] } },
  edges: [], edgeIds: [], subs: {}, accTitle: '', accDescr: '',
};

describe('the dot grid follows the chart (Q187)', () => {
  let stage: HTMLElement, chart: Chart;
  const box = (w: number, h: number) =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
  /** The view's translate and scale, from the canvas's transform. */
  const view = () => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(stage.querySelector<HTMLElement>('.canvas')!.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  };
  const grid = () => {
    const [w, h] = stage.style.backgroundSize.split(' ').map(parseFloat);
    const [x, y] = stage.style.backgroundPosition.split(' ').map(parseFloat);
    return { w, h, x, y };
  };

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(mermaid, 'render').mockImplementation(async (id: string) =>
      ({ svg: `<svg viewBox="0 0 400 200"><g class="node" id="${id}-flowchart-A-0"></g></svg>` }) as never);
    stage = document.createElement('div');
    document.body.append(stage);
    Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => 800 });
    stage.getBoundingClientRect = () => box(800, 600);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  test('the dots are 22 chart units apart and line up with the chart', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    const v = view();
    const g = grid();
    expect(g.w).toBeCloseTo(22 * v.k, 2);
    expect(g.h).toBe(g.w);
    // The grid's tiles start where the chart's origin is, wrapped into one tile.
    expect(g.x).toBeCloseTo(((v.x % g.w) + g.w) % g.w, 2);
    expect(g.y).toBeCloseTo(((v.y % g.w) + g.w) % g.w, 2);
  });

  test('panning moves the grid with the chart', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    const before = grid();
    const v = view();
    chart.setWheelMode('touchpad'); // a two-finger move pans
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaX: 7, deltaY: 5 }));
    const after = view();
    expect(after.k).toBe(v.k);
    expect(after.x).not.toBe(v.x);
    const g = grid();
    expect(g.w).toBe(before.w);
    expect(g.x).toBeCloseTo(((after.x % g.w) + g.w) % g.w, 2);
    expect(g.y).toBeCloseTo(((after.y % g.w) + g.w) % g.w, 2);
  });

  test('at every zoom the dots are 12 to 44 px apart on screen, each step a power of two of 22 chart units', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    for (const factor of [0.9, 0.8, 0.7, 0.5, 0.5, 0.5, 2, 2, 2, 2, 2, 2]) {
      chart.zoom(factor, 400, 300);
      const { k } = view();
      const { w } = grid();
      expect(w).toBeGreaterThanOrEqual(12);
      expect(w).toBeLessThanOrEqual(44);
      const steps = Math.log2(w / (22 * k));
      expect(Math.abs(steps - Math.round(steps))).toBeCloseTo(0, 2); // the size is written to 0.01 px
    }
  });
});

describe('the dots\' contrast (Q188)', () => {
  const css = readFileSync('src/style.css', 'utf8');
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [d, l] = [lum(a), lum(b)].sort((p, q) => p - q);
    return (l + 0.05) / (d + 0.05);
  };
  const blocks = [...css.matchAll(/:root\[data-palette="([\w-]+)"\][^{]*\{([^}]*)\}/g)].filter((b) => b[2].includes('--grid-dot'));
  const pair = (body: string, name: string) => {
    const m = new RegExp(`--${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`).exec(body)!;
    return [m[1], m[2]];
  };

  test('six themes, each with a background and dots in light and dark', () => {
    expect(blocks.map((b) => b[1])).toEqual(['naiad-default', 'moonpool', 'kelp', 'water-lily', 'glacier', 'coral']);
  });

  test.each(['naiad-default', 'moonpool', 'kelp', 'water-lily', 'glacier', 'coral'])('%s: the dots are about 1.5 to 1 against the background, light and dark', (name) => {
    const body = blocks.find((b) => b[1] === name)![2];
    const bg = pair(body, 'bg');
    const dot = pair(body, 'grid-dot');
    for (const i of [0, 1]) {
      expect(ratio(bg[i], dot[i])).toBeGreaterThanOrEqual(1.45);
      expect(ratio(bg[i], dot[i])).toBeLessThanOrEqual(1.6);
    }
  });
});
