// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, edgePanSpeed, panStep, pathEnds, roundBends, type ChartEvents } from '../src/chart';

const rect = { left: 100, right: 500, top: 200, bottom: 500 };
describe('edge pan speed', () => {
  test.each([
    [148, 248, 0, 0], [124, 248, 600, 0], [100, 248, 1200, 0], [0, 248, 1200, 0],
    [476, 248, -600, 0], [500, 500, -1200, -1200], [700, 100, -1200, 1200],
    [300, 476, 0, -600], [300, 350, 0, 0],
  ])('at %i,%i', (x, y, vx, vy) => {
    expect(edgePanSpeed({ x, y }, rect, 48, 1200)).toEqual({ x: vx, y: vy });
  });
  test('zero width is disabled', () => expect(edgePanSpeed({ x: 0, y: 0 }, rect, 0, 1200)).toEqual({ x: 0, y: 0 }));
  // A chart 1,000 px wide in a stage 400 px wide, with a 48 px margin.
  test.each([
    [100, -500, 100], [100, 40, 8], [100, 48, 0], [100, 90, 0], // showing its left side
    [-100, -500, -100], [-100, -640, -8], [-100, -648, 0], [-100, -700, 0], // its right side
    [0, -500, 0],
  ])('the view moves %i px at offset %i only as far as the chart goes: %i', (step, offset, moved) => {
    expect(panStep(step, offset, 1000, 400, 48)).toBe(moved);
  });
});

// jsdom has no SVG geometry: a path's first and last points are given as the browser
// would measure them.
function geometry(start: { x: number; y: number }, end: { x: number; y: number }) {
  return { getTotalLength: () => 42, getPointAtLength: (n: number) => (n === 0 ? start : n === 42 ? end : { x: NaN, y: NaN }) };
}
test('path endpoints are the points at length 0 and at the full length', () => {
  expect(pathEnds(geometry({ x: -1.5, y: 2 }, { x: 9, y: 10 }))).toEqual({ start: { x: -1.5, y: 2 }, end: { x: 9, y: 10 } });
});
test('unavailable or invalid geometry hides handles', () => {
  expect(pathEnds({ getTotalLength: () => { throw Error(); }, getPointAtLength: () => ({ x: 0, y: 0 }) })).toBeNull();
  expect(pathEnds({ getTotalLength: () => NaN, getPointAtLength: () => ({ x: 0, y: 0 }) })).toBeNull();
});

describe('drag interactions', () => {
  let stage: HTMLElement, chart: Chart, events: ChartEvents, frames: Map<number, FrameRequestCallback>, next: number;
  let target: Element | null;
  const pointer = (type: string, x: number, y: number) => {
    const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    return e;
  };
  beforeEach(() => {
    frames = new Map(); next = 0; target = null;
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++next, f); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => target ? [target] : [] });
    Object.assign(HTMLElement.prototype, { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} });
    stage = document.createElement('div'); document.body.append(stage);
    stage.getBoundingClientRect = () => ({ ...rect, width: 400, height: 300, x: 100, y: 200, toJSON() {} });
    events = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
    const canvas = stage.querySelector('.canvas')!;
    canvas.innerHTML = '<svg><g data-node="A"></g><g data-node="B"></g><g data-sub="subGraph0"></g><path data-edge-line="0" d="M10,20C20,20,30,40,50,60"></path></svg>';
    const path = canvas.querySelector('path')!;
    Object.assign(path, geometry({ x: 10, y: 20 }, { x: 50, y: 60 }), { getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 100, f: 200 }) });
    (canvas.querySelector('[data-node="A"]') as Element).getBoundingClientRect = () => ({ left: 110, top: 210, right: 130, bottom: 230, width: 20, height: 20, x: 110, y: 210, toJSON() {} });
    Object.assign(chart as any, { snap: { edges: [{ start: 'A', end: 'B' }], subs: {} }, explicitSubs: new Set(), size: { w: 2000, h: 2000 } });
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  test('handles use screen coordinates and drop only a changed end', () => {
    chart.select({ kind: 'edge', index: 0 });
    const [start, end] = Array.from(stage.querySelectorAll<HTMLButtonElement>('.end-handle'));
    expect(start.style.left).toBe('11px'); expect(end.style.top).toBe('111px');
    start.dispatchEvent(pointer('pointerdown', 120, 240));
    const line = stage.querySelector('line')!;
    expect(line.getAttribute('x1')).toBe('100');
    target = stage.querySelector('[data-node="B"]');
    start.dispatchEvent(pointer('pointermove', 160, 260));
    expect(target?.classList.contains('drop')).toBe(true);
    start.dispatchEvent(pointer('pointerup', 160, 260));
    expect(events.onMoveEnd).toHaveBeenCalledWith(0, 'start', 'B');
    expect(frames.size).toBe(0);
    end.dispatchEvent(pointer('pointerdown', 200, 320));
    end.dispatchEvent(pointer('pointerup', 160, 260));
    expect(events.onMoveEnd).toHaveBeenCalledTimes(1);
  });
  test('generated groups cannot connect, and Escape cancels the frame', () => {
    chart.select({ kind: 'sub', id: 'subGraph0' });
    expect(stage.querySelector<HTMLButtonElement>('.connect-handle')!.hidden).toBe(true);
    chart.select({ kind: 'node', id: 'A' });
    const connect = stage.querySelector<HTMLButtonElement>('.connect-handle')!;
    connect.dispatchEvent(pointer('pointerdown', 125, 220));
    target = stage.querySelector('[data-sub]');
    connect.dispatchEvent(pointer('pointerup', 160, 250));
    expect(events.onConnect).not.toHaveBeenCalled();
    const app = vi.fn();
    window.addEventListener('keydown', app);
    connect.dispatchEvent(pointer('pointerdown', 125, 220));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(frames.size).toBe(0); expect(stage.querySelector('line')).toBeNull();
    expect(app).not.toHaveBeenCalled(); // the selection stays: only the drag is cancelled
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app).toHaveBeenCalledTimes(1); // with no drag, Escape is the app's
    window.removeEventListener('keydown', app);
  });
  test('short moves do nothing, explicit groups are allowed, and clear cancels', () => {
    chart.select({ kind: 'edge', index: 0 });
    const start = stage.querySelector<HTMLButtonElement>('.end-handle')!;
    target = stage.querySelector('[data-node="B"]');
    start.dispatchEvent(pointer('pointerdown', 120, 240));
    start.dispatchEvent(pointer('pointerup', 125, 240));
    expect(events.onMoveEnd).not.toHaveBeenCalled();
    (chart as any).explicitSubs.add('subGraph0');
    target = stage.querySelector('[data-sub]');
    start.dispatchEvent(pointer('pointerdown', 120, 240));
    start.dispatchEvent(pointer('pointerup', 150, 240));
    expect(events.onMoveEnd).toHaveBeenCalledWith(0, 'start', 'subGraph0');
    start.dispatchEvent(pointer('pointerdown', 120, 240));
    chart.clear();
    expect(frames.size).toBe(0);
    expect(start.hidden).toBe(true);
  });
  test('stationary edge pointer pans, updates line, and wheel still zooms', () => {
    chart.select({ kind: 'node', id: 'A' });
    const connect = stage.querySelector<HTMLButtonElement>('.connect-handle')!;
    connect.dispatchEvent(pointer('pointerdown', 125, 220));
    connect.dispatchEvent(pointer('pointermove', 500, 350));
    const step = (time: number) => { const [id, f] = [...frames.entries()][0]; frames.delete(id); f(time); };
    step(100); step(300); // 200 ms between frames counts as 50 ms: 1,200 px/s moves it 60 px
    const line = stage.querySelector('line')!;
    expect(line.getAttribute('x1')).toBe('-40');
    expect(line.getAttribute('x2')).toBe('400');
    // A notch glides to its zoom over a few frames (T1.12): run every frame asked for.
    const canvas = stage.querySelector<HTMLElement>('.canvas')!;
    const scale = () => Number(canvas.style.transform.match(/scale\(([\d.e-]+)\)/)![1]);
    const all = (time: number) => { const due = [...frames.values()]; frames.clear(); due.forEach((f) => f(time)); };
    let k = scale();
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 350, deltaY: -100 }));
    all(316);
    expect(scale()).toBeGreaterThan(k);
    k = scale();
    const afterZoom = line.getAttribute('x1');
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 550, clientY: 350, deltaY: -100 }));
    all(332);
    expect(scale()).toBeGreaterThan(k);
    expect(line.getAttribute('x1')).not.toBe(afterZoom);
    for (let t = 348; t < 1000; t += 16) all(t); // the glide ends
    connect.dispatchEvent(pointer('pointercancel', 500, 350));
    expect(frames.size).toBe(0);
    // With no drag, the wheel outside the chart is not the chart's.
    const view = canvas.style.transform;
    const outside = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 550, clientY: 350, deltaY: -100 });
    document.body.dispatchEvent(outside);
    expect(canvas.style.transform).toBe(view);
    expect(outside.defaultPrevented).toBe(false);
  });
  // Hover (the user, 2026-11-13): the item under the pointer shows its handles, lit softly.
  test('the item under the pointer shows its handles; they stay a moment after it leaves', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = stage.querySelector('[data-node="A"]')!;
    const connects = stage.querySelectorAll<HTMLButtonElement>('.connect-handle');
    a.dispatchEvent(pointer('pointerover', 120, 220));
    expect(connects[0].hidden).toBe(true); // nothing is selected
    expect(connects[1].hidden).toBe(false);
    expect(connects[1].style.left).toBe('36px');
    expect(a.classList.contains('hov')).toBe(true);
    stage.dispatchEvent(pointer('pointerover', 300, 400)); // empty space: the light goes at once
    expect(a.classList.contains('hov')).toBe(false);
    expect(connects[1].hidden).toBe(false);
    connects[1].dispatchEvent(pointer('pointerover', 140, 220)); // the handle, reached in time
    vi.advanceTimersByTime(1000);
    expect(connects[1].hidden).toBe(false);
    expect(a.classList.contains('hov')).toBe(true);
    target = stage.querySelector('[data-node="B"]');
    connects[1].dispatchEvent(pointer('pointerdown', 140, 220));
    connects[1].dispatchEvent(pointer('pointerup', 170, 260));
    expect(events.onConnect).toHaveBeenCalledWith('A', 'B');
    stage.dispatchEvent(pointer('pointerover', 300, 400));
    vi.advanceTimersByTime(399);
    expect(connects[1].hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(connects[1].hidden).toBe(true);
    chart.setHighlighting(true); // while highlighting, the item is lit but shows no handles
    a.dispatchEvent(pointer('pointerover', 120, 220));
    expect(a.classList.contains('hov')).toBe(true);
    expect(connects[1].hidden).toBe(true);
    vi.useRealTimers();
  });
  test('a node in a group: the pointer crosses the group to the node\'s handle (the user, 2026-11-13)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = stage.querySelector('[data-node="A"]')!;
    const group = stage.querySelector('[data-sub="subGraph0"]')!;
    const connects = stage.querySelectorAll<HTMLButtonElement>('.connect-handle');
    a.dispatchEvent(pointer('pointerover', 120, 220));
    group.dispatchEvent(pointer('pointerover', 133, 220)); // the gap is the group's ground
    expect(a.classList.contains('hov')).toBe(false);
    expect(group.classList.contains('hov')).toBe(false);
    expect(connects[1].style.left).toBe('36px'); // still the node's handle
    connects[1].dispatchEvent(pointer('pointerover', 140, 220)); // reached in time
    vi.advanceTimersByTime(1000);
    expect(connects[1].hidden).toBe(false);
    expect(a.classList.contains('hov')).toBe(true);
    target = stage.querySelector('[data-node="B"]');
    connects[1].dispatchEvent(pointer('pointerdown', 140, 220));
    connects[1].dispatchEvent(pointer('pointerup', 170, 260));
    expect(events.onConnect).toHaveBeenCalledWith('A', 'B');
    a.dispatchEvent(pointer('pointerover', 120, 220));
    group.dispatchEvent(pointer('pointerover', 133, 220)); // staying on the group: it takes over
    vi.advanceTimersByTime(399);
    expect(group.classList.contains('hov')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(group.classList.contains('hov')).toBe(true);
    stage.dispatchEvent(pointer('pointerover', 300, 400));
    group.dispatchEvent(pointer('pointerover', 133, 220)); // from nothing hovered, a group is lit at once
    vi.advanceTimersByTime(400);
    a.dispatchEvent(pointer('pointerover', 120, 220));
    stage.dispatchEvent(pointer('pointerover', 300, 400));
    vi.advanceTimersByTime(400);
    group.dispatchEvent(pointer('pointerover', 133, 220));
    expect(group.classList.contains('hov')).toBe(true);
    vi.useRealTimers();
  });
  test('the selected arrow keeps its end handles; an arrow under the pointer is dragged without a click', () => {
    chart.select({ kind: 'edge', index: 0 });
    const ends = stage.querySelectorAll<HTMLButtonElement>('.end-handle'); // the selection's two, then the pointer's
    stage.querySelector('[data-node="A"]')!.dispatchEvent(pointer('pointerover', 120, 220));
    expect([...ends].map((b) => b.hidden)).toEqual([false, false, true, true]);
    expect(stage.querySelectorAll<HTMLButtonElement>('.connect-handle')[1].hidden).toBe(false);
    chart.select(null);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('data-edge', '0');
    stage.querySelector('svg')!.append(hit);
    hit.dispatchEvent(pointer('pointerover', 150, 260));
    expect([...ends].map((b) => b.hidden)).toEqual([true, true, false, false]);
    expect(ends[2].style.left).toBe('11px');
    expect(stage.querySelector('[data-edge-line="0"]')!.classList.contains('hov')).toBe(true);
    target = stage.querySelector('[data-node="B"]');
    ends[2].dispatchEvent(pointer('pointerdown', 120, 240));
    ends[2].dispatchEvent(pointer('pointerup', 160, 260));
    expect(events.onSelect).toHaveBeenCalledWith({ kind: 'edge', index: 0 });
    expect(events.onMoveEnd).toHaveBeenCalledWith(0, 'start', 'B');
    const order = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(order(events.onSelect)).toBeLessThan(order(events.onMoveEnd)); // selected first (Q100)
  });
  // View mode (D4.3, T1.11): reading only.
  test('View mode: no handles, no dot grid, a drag ended, and the chart\'s edits blocked', () => {
    const connects = stage.querySelectorAll<HTMLButtonElement>('.connect-handle');
    const ends = stage.querySelectorAll<HTMLButtonElement>('.end-handle');
    const a = stage.querySelector('[data-node="A"]')!;
    const b = stage.querySelector('[data-node="B"]')!;
    chart.select({ kind: 'node', id: 'A' });
    connects[0].dispatchEvent(pointer('pointerdown', 125, 220)); // a drag under way
    expect(stage.querySelector('line')).not.toBeNull();
    chart.setViewing(true);
    expect(stage.querySelector('line')).toBeNull();
    expect(frames.size).toBe(0);
    expect(stage.classList.contains('viewing')).toBe(true); // `.stage.viewing` takes the dot grid off
    expect(connects[0].hidden).toBe(true);
    a.dispatchEvent(pointer('pointerover', 120, 220)); // lit under the pointer, but no handles
    expect(a.classList.contains('hov')).toBe(true);
    expect(connects[1].hidden).toBe(true);
    chart.select({ kind: 'edge', index: 0 });
    expect([...ends].map((e) => e.hidden)).toEqual([true, true, true, true]);

    chart.select({ kind: 'node', id: 'A' });
    connects[0].dispatchEvent(pointer('pointerdown', 125, 220)); // a hidden handle starts nothing
    expect(stage.querySelector('line')).toBeNull();
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); // would connect A to B
    expect(events.onConnect).not.toHaveBeenCalled();
    expect(events.onBlocked).toHaveBeenCalledTimes(1);
    a.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); // would rename A
    stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); // would add a node
    expect(events.onRename).not.toHaveBeenCalled();
    expect(events.onAddNode).not.toHaveBeenCalled();
    expect(events.onBlocked).toHaveBeenCalledTimes(3);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true })); // a plain click still selects
    expect(events.onSelect).toHaveBeenLastCalledWith({ kind: 'node', id: 'B' });
    chart.setHighlighting(true); // and Highlight still highlights
    a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(events.onHighlight).toHaveBeenCalledWith({ kind: 'node', id: 'A' });
    chart.setHighlighting(false);

    chart.setViewing(false);
    expect(stage.classList.contains('viewing')).toBe(false);
    chart.select({ kind: 'node', id: 'A' });
    expect(connects[0].hidden).toBe(false);
    a.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(events.onRename).toHaveBeenCalledWith({ kind: 'node', id: 'A' });
  });
});

describe('rounder bends (the user, 2026-11-13)', () => {
  test('each bend gets the radius asked for', () => {
    expect(roundBends('M0,0L95,0Q100,0 100,5L100,95Q100,100 105,100L200,100', 14))
      .toBe('M0,0L86,0Q100,0 100,14L100,86Q100,100 114,100L200,100');
  });
  test('a bend takes no more than half of either run beside it', () => {
    expect(roundBends('M0,0L5,0Q10,0 10,5L10,15Q10,20 15,20L40,20', 14))
      .toBe('M0,0L5,0Q10,0 10,5L10,10Q10,20 20,20L40,20');
  });
  test.each([
    ['a smooth curve', 'M10,20C20,20,30,40,50,60'],
    ['a straight arrow', 'M0,0L10,10'],
    ['relative commands', 'M0,0l95,0q5,0 5,5l0,90'],
    ['no path', ''],
  ])('%s is left as it is', (_, d) => expect(roundBends(d, 14)).toBe(d));
});

// Mermaid writes an arrow's path with absolute commands only (M, L, C), each ending at a
// point: its first two numbers are where it starts, its last two where it ends.
function drawnEnds(d: string) {
  expect(d).toMatch(/^M[-+0-9.,eE\sLCQST]*$/);
  const n = d.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)!.map(Number);
  return { start: { x: n[0], y: n[1] }, end: { x: n[n.length - 2], y: n[n.length - 1] } };
}

// Render actual Mermaid paths in all four rank directions, with synthetic text measurements.
test.each([
  ['TD', 'y', 1], ['BT', 'y', -1], ['LR', 'x', 1], ['RL', 'x', -1],
] as const)('Mermaid %s keeps source first and destination last', async (direction, axis, sign) => {
  const { default: mermaid } = await import('mermaid');
  const { configureMermaid } = await import('../src/chart');
  configureMermaid(false);
  Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 50, height: 20 }) });
  const { svg } = await mermaid.render(`direction${direction}`, `flowchart ${direction}\nA --> B`);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const d = doc.querySelector('path[data-edge="true"]')?.getAttribute('d');
  expect(d).toBeTruthy();
  const points = drawnEnds(d!);
  expect((points.end[axis] - points.start[axis]) * sign).toBeGreaterThan(0);
}, 20_000); // Mermaid's drawing takes 5 to 7 s here when every test file runs at once.
