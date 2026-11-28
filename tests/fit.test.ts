// @vitest-environment jsdom
// Fit keeps the chart clear of the chart's tools (seen 2026-11-25 while recording the
// README's demo): it padded 24 px at each edge and ignored Undo's island at the top and
// the pill at the foot, so a tall chart's last node sat under the pill.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, type ChartEvents } from '../src/chart';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('Fit and the chart\'s tools', () => {
  let area: HTMLElement, stage: HTMLElement, chart: Chart;
  const tool = (cls: string, r: DOMRect) => {
    const el = document.createElement('div');
    el.className = cls;
    el.getBoundingClientRect = () => r;
    area.append(el);
    return el;
  };
  /** Fits a chart of `w` x `h` px into the 1000 x 800 px stage; returns where it lands. */
  const fit = (w: number, h: number) => {
    (chart as any).size = { w, h };
    chart.fit();
    const { x, y, k } = (chart as any).view;
    return { x, y, k, bottom: y + h * k };
  };

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    area = document.createElement('div');
    stage = document.createElement('section');
    stage.getBoundingClientRect = () => rect(0, 0, 1000, 800);
    area.append(stage);
    document.body.append(area);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn(), onWalk: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); area.remove(); vi.unstubAllGlobals(); });

  test('with no tools shown, a tall chart keeps 24 px at the top and the foot', () => {
    const at = fit(400, 1000);
    expect(at.k).toBeCloseTo(0.752, 6);
    expect(at.y).toBe(24);
    expect(at.bottom).toBeCloseTo(776, 6);
  });

  test('a tall chart ends 12 px above the pill and starts 12 px below the island', () => {
    tool('island-row', rect(14, 14, 80, 40)); // reaches 54 px down
    tool('pill', rect(400, 734, 200, 48)); // starts 66 px up from the foot
    const at = fit(400, 1000);
    expect(at.y).toBe(66);
    expect(at.bottom).toBeCloseTo(734 - 12, 6);
  });

  test('a wide, short chart is centered in the room between the tools', () => {
    tool('island-row', rect(14, 14, 80, 40));
    tool('pill', rect(400, 734, 200, 48));
    const at = fit(1900, 200); // width decides: k = 952 / 1900
    expect(at.k).toBeCloseTo(952 / 1900, 6);
    expect(at.y).toBeCloseTo(66 + (656 - 200 * at.k) / 2, 6);
  });

  test('a chart fitted before the tools showed is fitted again around them; a moved view stays', () => {
    fit(400, 1000); // drawn before its tab showed the tools, as an opened file is
    tool('island-row', rect(14, 14, 80, 40));
    tool('pill', rect(400, 734, 200, 48));
    chart.toolsChanged();
    const { y, k } = (chart as any).view;
    expect(y).toBe(66);
    expect(y + 1000 * k).toBeCloseTo(722, 6);
    (chart as any).manual = true; // the user has panned or zoomed
    (chart as any).view.y = 300;
    chart.toolsChanged();
    expect((chart as any).view.y).toBe(300);
  });

  test('a hidden tool (no size) takes no room', () => {
    tool('island-row', rect(0, 0, 0, 0)); // in View mode Undo's island is hidden
    tool('pill', rect(400, 734, 200, 48));
    const at = fit(400, 1000);
    expect(at.y).toBe(24);
    expect(at.bottom).toBeCloseTo(722, 6);
  });
});

describe('A tall chart opens readable (Q253, T1.6)', () => {
  let stage: HTMLElement, chart: Chart;
  const place = (w: number, h: number, whole = false) => {
    (chart as any).size = { w, h };
    if (whole) return (chart as any).fitGoal('whole');
    chart.fit();
    return { ...(chart as any).view };
  };
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    stage = document.createElement('section');
    // The user's case: a window 1280 x 800 with the sidebar open leaves 892 x 756.
    stage.getBoundingClientRect = () => rect(0, 0, 892, 756);
    document.body.append(stage);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn(), onWalk: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.unstubAllGlobals(); });

  test("the user's chart, 1218 x 4863: its width is fitted, top first", () => {
    const v = place(1218, 4863);
    expect(v.k).toBeCloseTo(844 / 1218, 6); // text 9.7 px, not 2.1 px
    expect(v.y).toBe(24);
    expect(v.x).toBeCloseTo(24, 6);
  });

  test("the Fit button's Whole chart shows the whole chart (as far as the smallest zoom allows)", () => {
    expect(place(1218, 4863, true).k).toBe(0.15);
    const v = place(600, 2000, true);
    expect(v.k).toBeCloseTo(708 / 2000, 6);
  });

  test('a chart whose text stays at 9 px or more is fitted whole, as before', () => {
    const v = place(400, 1000); // k = 708 / 1000 = 0.708, over 9/14
    expect(v.k).toBeCloseTo(0.708, 6);
    expect(v.y).toBe(24);
  });

  test('just under the 9 px line, the width is fitted', () => {
    const h = 708 / (9 / 14) + 10; // the whole fit is a little under 9/14
    const v = place(400, h);
    expect(v.k).toBe(1.15); // 844 / 400 is over full size: capped at 1.15, as today
    expect(v.y).toBe(24);
  });

  test('a wide chart too small to read stays fitted whole: its width is what limits it', () => {
    const v = place(4000, 300);
    expect(v.k).toBeCloseTo(844 / 4000, 6);
  });
});

describe('The Fit button: two views in turn, glided to (Q255)', () => {
  let stage: HTMLElement, chart: Chart;
  let frames: FrameRequestCallback[];
  const view = () => ({ ...(chart as any).view }) as { x: number; y: number; k: number };
  /** Runs the queued animation frames at `ms` after the first, until none is left. */
  const run = (ms = 2000) => { for (let n = 0; frames.length && n < 500; n++) frames.shift()!(n === 0 ? 0 : ms); };
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.push(f); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
    stage = document.createElement('section');
    stage.getBoundingClientRect = () => rect(0, 0, 892, 756);
    document.body.append(stage);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn(), onWalk: vi.fn() };
    chart = new Chart(stage, events);
    (chart as any).size = { w: 1218, h: 4863 }; // the user's chart
    chart.fit(); // opens fitted to its width
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.unstubAllGlobals(); });

  test('clicks go: whole chart, width, whole chart', () => {
    const width = view();
    chart.fitNext();
    run();
    expect(view().k).toBe(0.15);
    chart.fitNext();
    run();
    expect(view()).toEqual(width);
    chart.fitNext();
    run();
    expect(view().k).toBe(0.15);
  });

  test('a second click during the glide goes on to the other view', () => {
    chart.fitNext(); // to the whole chart
    frames.shift()!(0);
    frames.shift()!(100); // part of the way
    chart.fitNext(); // its goal was the whole chart: now the width
    run();
    expect(view().k).toBeCloseTo(844 / 1218, 6);
  });

  test('after the view was moved, a click shows the whole chart', () => {
    (chart as any).view = { x: -300, y: -900, k: 1 };
    chart.fitNext();
    run();
    expect(view().k).toBe(0.15);
  });

  test('the view glides: the first frames are part of the way, the last is exact', () => {
    const from = view();
    chart.fitTo('whole');
    expect(view()).toEqual(from); // nothing moves before the first frame
    frames.shift()!(0);
    frames.shift()!(150);
    const mid = view().k;
    expect(mid).toBeLessThan(from.k);
    expect(mid).toBeGreaterThan(0.15);
    run();
    expect(view().k).toBe(0.15);
    expect(frames.length).toBe(0);
  });

  test('without motion when the system asks for less of it', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    chart.fitTo('whole');
    expect(view().k).toBe(0.15);
    expect(frames.length).toBe(0);
  });

  test('a pan or a wheel zoom during the glide stops it where it is', () => {
    chart.fitTo('whole');
    frames.shift()!(0);
    frames.shift()!(150);
    const at = view();
    (chart as any).stopWalkGlide(); // what a pan and a wheel zoom call
    expect(frames.length).toBe(0);
    expect(view()).toEqual(at);
    expect((chart as any).viewGoal).toBeNull();
  });
});
