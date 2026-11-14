// @vitest-environment jsdom
// Telling arrows apart (the user, 2026-11-13): trace on hover, and gaps at crossings.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, roundBends, traceOf, type ChartEvents } from '../src/chart';

const snap = {
  edges: [{ start: 'A', end: 'B' }, { start: 'B', end: 'C' }, { start: 'G', end: 'C' }, { start: 'D', end: 'A' }],
  subs: { G: { nodes: ['E', 'F'] }, H: { nodes: ['D'] } },
} as unknown as Parameters<typeof traceOf>[1];

describe('what a trace lights', () => {
  test('a node: its arrows and the nodes at their other ends', () => {
    expect(traceOf({ kind: 'node', id: 'A' }, snap)).toEqual({ ids: new Set(['A', 'B', 'D']), edges: new Set([0, 3]) });
  });
  test('an arrow: it and its two ends', () => {
    expect(traceOf({ kind: 'edge', index: 1 }, snap)).toEqual({ ids: new Set(['B', 'C']), edges: new Set([1]) });
    expect(traceOf({ kind: 'edge', index: 9 }, snap)).toBeNull();
  });
  test('a group: the arrows ending at the group itself, their other ends, and its own nodes', () => {
    expect(traceOf({ kind: 'sub', id: 'G' }, snap)).toEqual({ ids: new Set(['G', 'E', 'F', 'C']), edges: new Set([2]) });
  });
  test('an item with no arrows fades nothing', () => {
    expect(traceOf({ kind: 'node', id: 'E' }, snap)).toBeNull();
    expect(traceOf({ kind: 'sub', id: 'H' }, snap)).toBeNull(); // its node's arrow is the node's, not the group's
  });
});

describe('trace on hover', () => {
  let stage: HTMLElement, chart: Chart;
  const pointer = (type: string) => {
    const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: 120, clientY: 220 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    return e;
  };
  const lit = () => [...stage.querySelectorAll<HTMLElement>('.lit')].map((e) => e.dataset.node ?? `edge ${e.dataset.edgeLine ?? e.dataset.edge}`).sort();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.assign(HTMLElement.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] });
    stage = document.createElement('div');
    document.body.append(stage);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
    stage.querySelector('.canvas')!.innerHTML = '<svg><g class="node" data-node="A"></g><g class="node" data-node="B"></g><g class="node" data-node="C"></g>'
      + '<path data-edge-line="0"></path><path class="edge-hit" data-edge="0"></path><path data-edge-line="1"></path><path class="edge-hit" data-edge="1"></path>'
      + '<g class="edgeLabel" data-edge="1"></g></svg>';
    for (const el of stage.querySelectorAll<HTMLElement>('[data-node]')) el.getBoundingClientRect = () => ({ left: 110, top: 210, right: 130, bottom: 230, width: 20, height: 20, x: 110, y: 210, toJSON() {} });
    Object.assign(chart as any, { snap: { edges: [{ start: 'A', end: 'B' }, { start: 'B', end: 'C' }], subs: {} }, explicitSubs: new Set() });
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  test('after a short rest the rest fades; leaving brings it back after the same rest', () => {
    stage.querySelector('[data-node="C"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(149);
    expect(stage.classList.contains('tracing')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(stage.classList.contains('tracing')).toBe(true);
    expect(lit()).toEqual(['B', 'C', 'edge 1', 'edge 1']); // its arrow, the arrow's label, the node at its other end
    stage.dispatchEvent(pointer('pointerover')); // empty space
    vi.advanceTimersByTime(149);
    expect(stage.classList.contains('tracing')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stage.classList.contains('tracing')).toBe(false);
    expect(lit()).toEqual([]);
  });

  test('crossing the chart without resting fades nothing', () => {
    stage.querySelector('[data-node="A"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(100);
    stage.querySelector('.edge-hit[data-edge="1"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(100);
    stage.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(1000);
    expect(stage.classList.contains('tracing')).toBe(false);
  });

  test('moving from one item to another traces the second', () => {
    stage.querySelector('[data-node="A"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(150);
    expect(lit()).toEqual(['A', 'B', 'edge 0']);
    stage.querySelector('.edge-hit[data-edge="1"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(150);
    expect(lit()).toEqual(['B', 'C', 'edge 1', 'edge 1']);
  });

  test('a drag from a handle, or clearing the chart, ends the trace at once', () => {
    stage.querySelector('[data-node="A"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(150);
    stage.querySelectorAll<HTMLButtonElement>('.connect-handle')[1].dispatchEvent(pointer('pointerdown'));
    expect(stage.classList.contains('tracing')).toBe(false);
    stage.querySelectorAll<HTMLButtonElement>('.connect-handle')[1].dispatchEvent(pointer('pointercancel'));
    stage.querySelector('[data-node="B"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(150);
    expect(stage.classList.contains('tracing')).toBe(true);
    chart.clear();
    expect(stage.classList.contains('tracing')).toBe(false);
  });

  test('the trace stays while the pointer is on the hovered item\'s connect handle', () => {
    stage.querySelector('[data-node="A"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(150);
    stage.dispatchEvent(pointer('pointerover')); // the gap between the node and its handle
    stage.querySelectorAll<HTMLButtonElement>('.connect-handle')[1].dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(1000);
    expect(lit()).toEqual(['A', 'B', 'edge 0']);
  });

  test('a node with no arrows fades nothing', () => {
    Object.assign(chart as any, { snap: { edges: [], subs: {} } });
    stage.querySelector('[data-node="A"]')!.dispatchEvent(pointer('pointerover'));
    vi.advanceTimersByTime(1000);
    expect(stage.classList.contains('tracing')).toBe(false);
    expect(stage.querySelector('[data-node="A"]')!.classList.contains('hov')).toBe(true); // still lit softly
  });
});

describe('gaps at crossings', () => {
  test('an arrow cut by gaps has each piece rounded, and the gaps stay where they are', () => {
    expect(roundBends('M0,0L95,0Q100,0 100,5L100,40M100,52L100,95Q100,100 105,100L200,100', 14))
      .toBe('M0,0L86,0Q100,0 100,14L100,40M100,52L100,86Q100,100 114,100L200,100');
    expect(roundBends('M0,0L0,40 M0,52 L0,90', 14)).toBe('M0,0L0,40 M0,52 L0,90'); // no bends: as it is
  });

  test('Mermaid cuts a gap where arrows cross, not its own default hop', async () => {
    const { default: mermaid } = await import('mermaid');
    const { configureMermaid } = await import('../src/chart');
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 50, height: 20 }) });
    // Every top node to every bottom node: no layout draws this without crossings.
    const chart = 'flowchart TD\nA --> X & Y & Z\nB --> X & Y & Z\nC --> X & Y & Z';
    const paths = async (id: string) => {
      const { svg } = await mermaid.render(id, chart);
      return [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('path[data-edge="true"]')].map((p) => p.getAttribute('d') ?? '');
    };
    configureMermaid(false);
    const cut = await paths('gaps1');
    expect(cut.filter((d) => (d.match(/M/g) ?? []).length > 1).length).toBeGreaterThan(0);
    expect(cut.some((d) => /A/.test(d))).toBe(false);
    mermaid.initialize({ elk: { lineHops: 'arc' } }); // Mermaid's own default, for comparison
    const hopped = await paths('gaps2');
    expect(hopped.some((d) => /A/.test(d))).toBe(true);
    configureMermaid(false);
  }, 20_000); // Two drawings by Mermaid: 5 to 7 s here when every test file runs at once.
});
