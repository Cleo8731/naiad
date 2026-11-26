// @vitest-environment jsdom
// Walk (T6.4; the user, 2026-11-25 and 2026-11-26, Q229 to Q232): where a walk can start
// and go, how it keeps its place when the file changes, and what the chart shows of it:
// the places lit, the walk bar, clicks that walk, and an edge chip for a next place out of
// view.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, type ChartEvents } from '../src/chart';
import { choicesFrom, startNodes, stillThere, walkView, type WalkView } from '../src/walk';

type S = Parameters<typeof walkView>[0];
const edge = (start: string, end: string, text = '', more: Partial<S['edges'][number]> = {}) =>
  ({ start, end, text, type: 'arrow_point', stroke: 'normal', ...more }) as S['edges'][number];
const node = (text: string) => ({ text }) as S['nodes'][string];

/** A run with a choice and a loop: A → B → (Yes) C, (No) A; C ends; D sits alone. */
const SNAP: S = {
  nodes: { A: node('Start'), B: node('Ready?'), C: node('Done'), D: node('Note') },
  subs: {},
  edges: [edge('A', 'B'), edge('B', 'C', 'Yes'), edge('B', 'A', 'No'), edge('D', 'C', '', { stroke: 'invisible' })],
};

describe('where a walk starts and where it can go', () => {
  test('it starts at the nodes no arrow points to; an invisible link is no step', () => {
    // A is pointed to by B's "No"; D only by nothing walkable.
    expect(startNodes(SNAP)).toEqual(['D']);
    expect(startNodes({ ...SNAP, edges: SNAP.edges.slice(0, 2) })).toEqual(['A', 'D']);
  });

  test('a chart that is all loops starts at its first node', () => {
    expect(startNodes({ nodes: { X: node('x'), Y: node('y') }, edges: [edge('X', 'Y'), edge('Y', 'X')] })).toEqual(['X']);
  });

  test('the choices from a node: each arrow leaving it, with its label and where it leads', () => {
    expect(choicesFrom(SNAP, 'B')).toEqual([
      { edge: 1, to: 'C', label: 'Yes', title: 'Done' },
      { edge: 2, to: 'A', label: 'No', title: 'Start' },
    ]);
    expect(choicesFrom(SNAP, 'C')).toEqual([]); // an end
    expect(choicesFrom(SNAP, 'D')).toEqual([]); // its only link is invisible
  });

  test('an arrow that points both ways can be walked from either end', () => {
    const both: S = { ...SNAP, edges: [edge('A', 'B', '', { type: 'double_arrow_point' })] };
    expect(choicesFrom(both, 'B').map((c) => c.to)).toEqual(['A']);
    expect(startNodes(both)).toEqual(['C', 'D']);
  });

  test('what the chart is given: the place, the choices, the path behind and the arrows taken', () => {
    const path = [{ id: 'A', via: null }, { id: 'B', via: 0 }, { id: 'A', via: 2 }];
    expect(walkView(SNAP, path)).toMatchObject({ here: 'A', path: ['A', 'B'], pathEdges: [0, 2], via: 2, canBack: true });
    expect(walkView(SNAP, path.slice(0, 1))).toMatchObject({ here: 'A', canBack: false, choices: [{ edge: 0, to: 'B' }] });
    // Picking where to start.
    expect(walkView(SNAP, [])).toMatchObject({ here: null, starts: [{ to: 'D', title: 'Note' }], choices: [] });
  });
});

describe('a walk after the file changed', () => {
  const path = [{ id: 'A', via: null }, { id: 'B', via: 0 }, { id: 'C', via: 1 }];

  test('with its place gone, it steps back to the last place still there', () => {
    const { C: _gone, ...nodes } = SNAP.nodes;
    expect(stillThere({ ...SNAP, nodes, edges: SNAP.edges.slice(0, 1) }, path)).toEqual(path.slice(0, 2));
  });

  test('arrows are found again by their ends when their numbers shift', () => {
    // A new arrow first in the file: "Yes" is now arrow 2.
    const moved = { ...SNAP, edges: [edge('D', 'A'), ...SNAP.edges] };
    expect(stillThere(moved, path)).toEqual([{ id: 'A', via: null }, { id: 'B', via: 1 }, { id: 'C', via: 2 }]);
  });

  test('a step whose arrow went keeps its place without one', () => {
    const cut = { ...SNAP, edges: [SNAP.edges[0]] };
    expect(stillThere(cut, path)).toEqual([{ id: 'A', via: null }, { id: 'B', via: 0 }, { id: 'C', via: null }]);
  });
});

describe('the chart during a walk', () => {
  let stage: HTMLElement, chart: Chart, events: ChartEvents;
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} }) as DOMRect;
  /** Where each node is on screen; the stage is 800 by 600 at (0, 0). */
  const places: Record<string, DOMRect> = { A: rect(100, 100, 80, 40), B: rect(100, 200, 80, 40), C: rect(100, 300, 80, 40), D: rect(1500, 300, 80, 40) };
  const view = (here: string): WalkView => walkView(SNAP, here === 'B' ? [{ id: 'A', via: null }, { id: 'B', via: 0 }] : [{ id: here, via: null }]);
  const classes = (c: string) => [...stage.querySelectorAll<HTMLElement>(`.${c}`)].map((e) => e.dataset.node ?? `edge ${e.dataset.edgeLine ?? e.dataset.edge}`).sort();
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    stage = document.createElement('div');
    document.body.append(stage);
    stage.getBoundingClientRect = () => rect(0, 0, 800, 600);
    events = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn(), onWalk: vi.fn() };
    chart = new Chart(stage, events);
    stage.querySelector('.canvas')!.innerHTML = '<svg>'
      + ['A', 'B', 'C', 'D'].map((id) => `<g class="node" data-node="${id}"></g>`).join('')
      + '<path data-edge-line="0"></path><path class="edge-hit" data-edge="0"></path>'
      + '<path data-edge-line="1"></path><path class="edge-hit" data-edge="1"></path><g class="edgeLabel" data-edge="1"></g>'
      + '<path data-edge-line="2"></path><path class="edge-hit" data-edge="2"></path></svg>';
    for (const el of stage.querySelectorAll<HTMLElement>('[data-node]')) el.getBoundingClientRect = () => places[el.dataset.node!];
    Object.assign(chart as any, { snap: SNAP, explicitSubs: new Set() });
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.unstubAllGlobals(); });

  test('the place and where it can go are lit, the path taken marked, the rest left to fade', () => {
    chart.setWalk(view('B'));
    expect(stage.classList.contains('walking')).toBe(true);
    expect(classes('walk-here')).toEqual(['B']);
    expect(classes('walk-on')).toEqual(['A', 'B', 'C', 'edge 1', 'edge 1', 'edge 2']);
    expect(classes('walk-path')).toEqual(['A', 'edge 0']);
    chart.setWalk(null);
    expect(stage.classList.contains('walking')).toBe(false);
    expect(classes('walk-on')).toEqual([]);
  });

  test('the walk bar: Back, a button for each choice named by its label and place, and Leave', () => {
    chart.setWalk(view('B'));
    const bar = stage.querySelector<HTMLElement>('.walk-bar')!;
    expect(bar.hidden).toBe(false);
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Back', 'Yes → Done', 'No → Start', 'Leave']);
    // A long name is cut short to fit: the tooltip holds it whole.
    expect(bar.querySelectorAll('button')[1].title).toBe('Yes → Done');
    click(bar.querySelectorAll('button')[1]);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'choose', edge: 1 });
    click(bar.querySelector('.walk-back')!);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'back' });
    expect(events.onSelect).not.toHaveBeenCalled(); // a click on the bar is not a click on the chart
  });

  test('one way on is Next; an end offers Start again; picking offers each place to start', () => {
    chart.setWalk(view('A'));
    const texts = () => [...stage.querySelectorAll('.walk-bar button')].map((b) => b.textContent);
    expect(texts()).toEqual(['Back', 'Next', 'Leave']);
    expect(stage.querySelector<HTMLButtonElement>('.walk-back')!.disabled).toBe(true);
    chart.setWalk(view('C'));
    expect(stage.querySelector('.walk-choices')!.textContent).toBe('The end of this pathStart again');
    chart.setWalk(walkView(SNAP, []));
    expect(texts()).toEqual(['Back', 'Note', 'Leave']);
  });

  test('a click on a place to go, or on its arrow or label, takes that choice; anything else does nothing', () => {
    chart.setWalk(view('B'));
    click(stage.querySelector('[data-node="C"]')!);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'choose', edge: 1 });
    click(stage.querySelector('.edge-hit[data-edge="2"]')!);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'choose', edge: 2 });
    click(stage.querySelector('g.edgeLabel[data-edge="1"]')!);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'choose', edge: 1 });
    vi.mocked(events.onWalk).mockClear();
    click(stage.querySelector('[data-node="D"]')!); // not a choice
    click(stage.querySelector('.edge-hit[data-edge="0"]')!); // the arrow behind
    click(stage); // empty space
    expect(events.onWalk).not.toHaveBeenCalled();
    expect(events.onSelect).not.toHaveBeenCalled();
  });

  test('while picking, a click on a place to start starts there', () => {
    chart.setWalk(walkView(SNAP, []));
    click(stage.querySelector('[data-node="A"]')!);
    expect(events.onWalk).not.toHaveBeenCalled(); // not a place to start
    click(stage.querySelector('[data-node="D"]')!);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'start', id: 'D' });
  });

  test('a next place out of view gets an edge chip on its side, named by the arrow\'s label and the place; a click takes it', () => {
    const far = walkView({ ...SNAP, edges: [edge('A', 'B', 'Near'), edge('A', 'D', 'Far')] }, [{ id: 'A', via: null }]);
    chart.setWalk(far);
    // While the view glides there (a frame never comes here), no chips: they would slide.
    expect(stage.querySelectorAll('.walk-chip')).toHaveLength(0);
    chart.setWalk(null);
    // Asking for less motion, the view lands at once and the chips come with it.
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    chart.setWalk(far);
    const chips = [...stage.querySelectorAll<HTMLButtonElement>('.walk-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['➜Far → Note']); // B is in view: no chip
    expect(chips[0].dataset).toMatchObject({ walk: 'choose', value: '1' });
    click(chips[0]);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'choose', edge: 1 });
    // D lies to the right: the chip's arrow points right, a little down.
    const turn = Number(/rotate\(([-\d.e]+)rad\)/.exec(chips[0].querySelector<HTMLElement>('.walk-chip-dir')!.style.transform)![1]);
    expect(Math.abs(turn)).toBeLessThan(Math.PI / 4);
    chart.setWalk(null);
    expect(stage.querySelectorAll('.walk-chip')).toHaveLength(0);
  });

  test('trace on hover does not run during a walk, which lights its own way', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chart.setWalk(view('B'));
      const e = new MouseEvent('pointerover', { bubbles: true });
      stage.querySelector('[data-node="D"]')!.dispatchEvent(e);
      vi.advanceTimersByTime(500);
      expect(stage.classList.contains('tracing')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
