// @vitest-environment jsdom
// Walk (T6.4; the user, 2026-11-25 and 2026-11-26, Q229 to Q232): where a walk can start
// and go, how it keeps its place when the file changes, and what the chart shows of it:
// the places lit, the walk bar, clicks that walk, and an edge chip for a next place out of
// view.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, walkEase, type ChartEvents } from '../src/chart';
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

  test('a chart that is all loops has none, so nothing is hinted (Q243)', () => {
    expect(startNodes({ nodes: { X: node('x'), Y: node('y') }, edges: [edge('X', 'Y'), edge('Y', 'X')] })).toEqual([]);
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

  const texts = () => [...stage.querySelectorAll('.walk-bar button')].map((b) => b.textContent);
  const note = () => stage.querySelector('.walk-note')?.textContent ?? null;

  test('the walk bar: with every next place in view, Back, a note to click on the chart, and Leave', () => {
    chart.setWalk(view('B'));
    const bar = stage.querySelector<HTMLElement>('.walk-bar')!;
    expect(bar.hidden).toBe(false);
    expect(texts()).toEqual(['Back', 'Leave']);
    expect(note()).toBe('Click a next step on the chart');
    expect([...bar.querySelectorAll('button')].map((b) => b.title)).toEqual(['Back along the path taken (Left arrow)', 'Leave the walkthrough (Esc)']);
    click(bar.querySelector('.walk-back')!);
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'back' });
    expect(events.onSelect).not.toHaveBeenCalled(); // a click on the bar is not a click on the chart
  });

  const chipTexts = () => [...stage.querySelectorAll('.walk-chip')].map((c) => c.textContent);

  test('a next place out of view gets an edge chip, named in full, in the order the places lie on the chart; the bar names none (the user, 2026-11-26)', () => {
    // "No" leads far left, "Yes" far right. Shown without moving the view: after the
    // file changed, as the view then stays.
    places.A = rect(-1500, 100, 80, 40);
    places.C = rect(1500, 300, 80, 40);
    chart.setWalk(view('B'), false);
    expect(texts()).toEqual(['Back', 'Leave']);
    expect(note()).toBe('Click a next step on the chart');
    expect(chipTexts()).toEqual(['➜No → Start', '➜Yes → Done']); // not the file's order, Yes first
    expect([...stage.querySelectorAll<HTMLButtonElement>('.walk-chip')].map((b) => b.title)).toEqual(['No → Start (out of view; key 1)', 'Yes → Done (out of view; key 2)']);
    expect(chart.walkChoice(0)).toEqual({ kind: 'choose', edge: 2 }); // the key 1
    // Swapped sides, swapped order.
    places.A = rect(900, 100, 80, 40);
    places.C = rect(-300, 300, 80, 40);
    chart.setWalk(view('B'), false);
    expect(chipTexts()).toEqual(['➜Yes → Done', '➜No → Start']);
    expect(chart.walkChoice(0)).toEqual({ kind: 'choose', edge: 1 });
    // "No" back in view (the reader panned): only "Yes" keeps its chip, with its key still 1.
    places.A = rect(300, 100, 80, 40);
    chart.setWalk(view('B'), false);
    expect(chipTexts()).toEqual(['➜Yes → Done']);
    expect(stage.querySelector<HTMLButtonElement>('.walk-chip')!.title).toBe('Yes → Done (out of view; key 1)');
    Object.assign(places, { A: rect(100, 100, 80, 40), C: rect(100, 300, 80, 40) });
  });

  test('a chart drawn sideways (LR) orders the places top to bottom', () => {
    Object.assign(chart as any, { snap: { ...SNAP, direction: 'LR' } });
    places.A = rect(900, 700, 80, 40);
    places.C = rect(900, -200, 80, 40);
    chart.setWalk(view('B'), false);
    expect(chipTexts()).toEqual(['➜Yes → Done', '➜No → Start']);
    Object.assign(places, { A: rect(100, 100, 80, 40), C: rect(100, 300, 80, 40) });
  });

  test('an edge chip is centered where its arrow\'s line leaves the view', () => {
    // "Yes" runs from B down and to the right, to C far below: it leaves the view's foot
    // (y 600) at x 140 + 560 * 360 / 660, about 445, not where the line from the view's
    // middle to C would meet it (about 279).
    places.C = rect(100, 900, 80, 40);
    const line = stage.querySelector('[data-edge-line="1"]') as any;
    const from = { x: 140, y: 240 }, to = { x: 700, y: 900 };
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    line.getTotalLength = () => length;
    line.getPointAtLength = (s: number) => ({ x: from.x + (to.x - from.x) * s / length, y: from.y + (to.y - from.y) * s / length });
    chart.setWalk(view('B'), false);
    const chip = stage.querySelector<HTMLElement>('.walk-chip')!;
    expect(chip.textContent).toBe('➜Yes → Done');
    expect(Math.abs(parseFloat(chip.style.left) - 445.4)).toBeLessThan(1.5); // jsdom gives it no width
    // Its arrow points the way the line runs there: down and to the right.
    const turn = Number(/rotate\(([-\d.e]+)rad\)/.exec(chip.querySelector<HTMLElement>('.walk-chip-dir')!.style.transform)![1]);
    expect(turn).toBeCloseTo(Math.atan2(660, 560), 2);
    places.C = rect(100, 300, 80, 40);
  });

  test('edge chips and the walk bar\'s buttons show a name in full, wrapping onto more lines', () => {
    const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(';');
    for (const sel of ['.walk-choices button', '.walk-chip']) {
      expect(rule(sel), sel).not.toMatch(/white-space:\s*nowrap|text-overflow|(^|[;\s])height:\s*\d/);
      expect(rule(sel), sel).toMatch(/min-height/);
      expect(rule(sel), sel).toMatch(/(^|[;\s])height:\s*auto/); // a button's own height (30px) would cut a second line
    }
    // The walk's place wears a highlight's halo (the user, 2026-11-26).
    expect(rule('.stage.walking .canvas .node.walk-here')).toMatch(/var\(--hl\)/);
  });

  test('the highlights are hidden while a walk lasts and come back when it ends (the user, 2026-11-26)', () => {
    chart.setHighlights([{ kind: 'node', id: 'A' }, { kind: 'edge', index: 1 }]);
    expect(classes('hl')).toEqual(['A', 'edge 1', 'edge 1']);
    chart.setWalk(view('B'));
    expect(classes('hl')).toEqual([]);
    chart.setHighlights([{ kind: 'node', id: 'C' }]); // the highlights file changed meanwhile
    expect(classes('hl')).toEqual([]);
    chart.setWalk(null);
    expect(classes('hl')).toEqual(['C']);
  });

  test('picking where to start: all but the nodes no arrow points to fades, as hints; a chart all loops fades nothing; leaving clears it (Q243)', () => {
    chart.setWalk(walkView(SNAP, []), false);
    expect(stage.classList.contains('walk-picking')).toBe(true);
    expect(classes('walk-start')).toEqual(['D']);
    chart.setWalk(walkView(SNAP, [{ id: 'A', via: null }]), false); // started: the walk's own fading takes over
    expect(stage.classList.contains('walk-picking')).toBe(false);
    expect(classes('walk-start')).toEqual([]);
    chart.setWalk(walkView({ ...SNAP, edges: [edge('A', 'B'), edge('B', 'A'), edge('C', 'D'), edge('D', 'C')] }, []), false);
    expect(stage.classList.contains('walk-picking')).toBe(false);
    chart.setWalk(walkView(SNAP, []), false);
    chart.setWalk(null);
    expect(stage.classList.contains('walk-picking')).toBe(false);
    expect(classes('walk-start')).toEqual([]);
    const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.stage\.walk-picking \.canvas g\.node:not\(\.walk-start\):not\(\.hov\)/); // a faded node comes back under the pointer
  });

  test('one way on: a note to click it; an end offers Start again; picking where to start, nothing lit, no chip, no key (Q242)', () => {
    chart.setWalk(view('A'));
    expect(texts()).toEqual(['Back', 'Leave']);
    expect(note()).toBe('Click the next step on the chart');
    expect(stage.querySelector<HTMLButtonElement>('.walk-back')!.disabled).toBe(true);
    chart.setWalk(view('C'));
    expect(stage.querySelector('.walk-choices')!.textContent).toBe('The end of this pathStart again');
    chart.setWalk(null);
    chart.setWalk(walkView(SNAP, []), false); // D, the only node no arrow points to, lies off to the right
    expect(texts()).toEqual(['Back', 'Leave']);
    expect(note()).toBe('Click the node to start from');
    expect(stage.classList.contains('walking')).toBe(false); // the walk's fading waits: any node can be picked
    expect(classes('walk-on')).toEqual([]);
    expect(chipTexts()).toEqual([]);
    expect(chart.walkChoice(0)).toBeNull();
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

  test('while picking, a click on any node starts there; on an arrow or empty space, nothing (Q242)', () => {
    chart.setWalk(walkView(SNAP, []));
    click(stage.querySelector('.edge-hit[data-edge="0"]')!);
    click(stage);
    expect(events.onWalk).not.toHaveBeenCalled();
    click(stage.querySelector('[data-node="A"]')!); // an arrow points to it, yet it can start
    expect(events.onWalk).toHaveBeenLastCalledWith({ kind: 'start', id: 'A' });
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

  test('the view glides to the next place in a straight line, not along the curves of the arrow taken (the user, 2026-11-26)', () => {
    // The arrow taken loops far out to the side; the view must not follow it.
    const line = stage.querySelector('[data-edge-line="0"]') as any;
    line.getTotalLength = () => 1000;
    line.getPointAtLength = (d: number) => ({ x: 140 + Math.sin((d / 1000) * Math.PI) * 900, y: 120 + d / 10 });
    places.B = rect(100, 1400, 80, 40); // far below, so there is a way to travel
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    const v0 = { ...(chart as any).view };
    chart.setWalk(view('B'));
    const goal = (chart as any).walkGoal();
    const center = (v: { x: number; y: number; k: number }) => ({ x: (goal.ax - v.x) / v.k, y: (goal.ay - v.y) / v.k });
    const c0 = center(v0), c1 = { x: goal.cx, y: goal.cy };
    const seen: { x: number; y: number }[] = [];
    for (let now = 0; frames.length && now < 5000; now += 50) {
      frames.shift()!(now);
      seen.push(center((chart as any).view));
    }
    expect(seen.length).toBeGreaterThan(5);
    const len = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    let last = -1;
    for (const p of seen) {
      const off = Math.abs((c1.x - c0.x) * (p.y - c0.y) - (c1.y - c0.y) * (p.x - c0.x)) / len; // distance from the straight way
      expect(off).toBeLessThan(0.5);
      const along = ((p.x - c0.x) * (c1.x - c0.x) + (p.y - c0.y) * (c1.y - c0.y)) / len;
      expect(along).toBeGreaterThanOrEqual(last - 1e-6); // never back
      last = along;
    }
    expect(last).toBeCloseTo(len, 3);
    places.B = rect(100, 200, 80, 40);
  });

  test('the glide speeds up gently and slows to a stop (an ease in and out)', () => {
    expect(walkEase(0)).toBe(0);
    expect(walkEase(1)).toBe(1);
    expect(walkEase(0.5)).toBeCloseTo(0.5, 9);
    expect(walkEase(0.05)).toBeLessThan(0.001); // a soft start
    expect(1 - walkEase(0.95)).toBeLessThan(0.001); // a soft stop
    for (let t = 0; t < 1; t += 0.01) expect(walkEase(t + 0.01)).toBeGreaterThanOrEqual(walkEase(t));
  });

  test('Leave is red', () => {
    const css = readFileSync('src/style.css', 'utf8');
    expect(css).toMatch(/\.walk-bar button\.walk-leave \{[^}]*color:\s*var\(--bad\)/);
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
