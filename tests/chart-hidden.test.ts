// @vitest-environment jsdom
// A tab's chart is hidden while another tab is shown, and shown again as it was left
// (T1.16, tabs). A hidden chart's area has no width, so it cannot be fitted then.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';
import { Chart, type ChartEvents } from '../src/chart';
import type { Snap } from '../src/semantics';

const snap: Snap = {
  direction: 'TD',
  nodes: { A: { text: 'A', type: 'square', styles: [], classes: [] } },
  edges: [], edgeIds: [], subs: {}, accTitle: '', accDescr: '',
};

describe('a chart hidden and shown again (T1.16, tabs)', () => {
  let stage: HTMLElement, chart: Chart, width: number, resized: () => void;
  const transform = () => stage.querySelector<HTMLElement>('.canvas')!.style.transform;
  /** The chart's area takes a new width, 0 while it is hidden, as the browser reports it. */
  const resize = (next: number) => { width = next; resized(); };
  const box = (left: number, top: number, w: number, h: number) =>
    ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;

  beforeEach(() => {
    width = 800;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized = () => callback([], this as never); }
      observe() {} disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(mermaid, 'render').mockImplementation(async (id: string) =>
      ({ svg: `<svg viewBox="0 0 400 200"><g class="node" id="${id}-flowchart-A-0"></g></svg>` }) as never);
    stage = document.createElement('div');
    document.body.append(stage);
    Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => width });
    stage.getBoundingClientRect = () => box(0, 0, width, width ? 600 : 0);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  test('a chart drawn while hidden is fitted once it is shown', async () => {
    resize(0);
    await chart.draw('flowchart TD\n  A\n', snap);
    resize(800);
    const shown = transform();
    chart.fit();
    expect(shown).toBe(transform());
    expect(shown).toBe('translate(170px, 185px) scale(1.15)');
  });

  test('a chart redrawn while hidden, before anyone moved its view, is fitted once shown', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    resize(0);
    vi.mocked(mermaid.render).mockImplementation(async (id: string) =>
      ({ svg: `<svg viewBox="0 0 800 200"><g class="node" id="${id}-flowchart-A-0"></g></svg>` }) as never);
    await chart.draw('flowchart TD\n  A\n', snap);
    resize(800);
    const shown = transform();
    chart.fit();
    expect(shown).toBe(transform());
  });

  test('hiding and showing a chart leaves its view as it was, even with a selection partly off screen', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    const node = stage.querySelector('[data-node="A"]')!;
    node.getBoundingClientRect = () => (width ? box(780, 100, 100, 40) : box(0, 0, 0, 0));
    chart.select({ kind: 'node', id: 'A' });
    const left = transform();
    resize(0);
    resize(800);
    expect(transform()).toBe(left);
  });

  test('a width change while shown still keeps the chart centred', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    resize(600);
    expect(transform()).toBe('translate(70px, 185px) scale(1.15)');
    resize(0);
    resize(1000); // the window was made wider while another tab was shown
    expect(transform()).toBe('translate(270px, 185px) scale(1.15)');
  });

  test('a fit made after a width change, before the browser reports it, is not shifted again (T1.17)', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    width = 320; // the window was split: the chart's half is narrower, not yet reported
    chart.fit();
    const fitted = transform();
    resized();
    expect(transform()).toBe(fitted);
    expect(fitted).toBe('translate(24px, 232px) scale(0.68)');
  });
});
