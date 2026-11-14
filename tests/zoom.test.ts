// @vitest-environment jsdom
// Zoom steps (T1.12, the user's report of 2026-11-13): a touchpad pinch in Codex's browser
// pane reached the page as Ctrl-marked wheel events of a whole notch each (deltaY 100),
// and each zoomed 2.7 times, too far to reach the zoom wanted.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, type ChartEvents } from '../src/chart';

describe('how far one wheel event zooms', () => {
  let stage: HTMLElement, chart: Chart;
  const zoom = () => Number(stage.querySelector<HTMLElement>('.canvas')!.style.transform.match(/scale\(([\d.e-]+)\)/)![1]);
  const wheel = (deltaY: number, ctrlKey = false) => {
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true, clientX: 200, clientY: 150 }));
    return zoom();
  };
  const start = (k: number) => { Object.assign(chart as any, { view: { x: 0, y: 0, k } }); };

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    stage = document.createElement('div');
    document.body.append(stage);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.unstubAllGlobals(); });

  test('a plain wheel notch zooms 17.4%, in and out', () => {
    start(1);
    expect(wheel(-100)).toBeCloseTo(Math.exp(0.16), 4);
    expect(wheel(100)).toBeCloseTo(1, 4);
  });

  test('a Ctrl-marked event of a whole notch zooms no further than a plain notch', () => {
    start(1);
    expect(wheel(-100, true)).toBeCloseTo(Math.exp(0.16), 4);
    start(1);
    expect(wheel(100, true)).toBeCloseTo(Math.exp(-0.16), 4);
  });

  test("a smooth pinch's small Ctrl-marked events still follow the fingers", () => {
    start(1);
    expect(wheel(-4, true)).toBeCloseTo(Math.exp(0.04), 4);
    expect(wheel(-12, true)).toBeCloseTo(Math.exp(0.16), 4);
  });

  test("the user's pinch recorded in Codex's pane moves one notch per event, not 2.7 times", () => {
    // The recorder's events (testing/zoom-trial, 2026-11-13): eight steps of 100, from 0.15.
    start(0.15);
    const steps = [-100, -100, -100, 100, 100, 100, -100, -100];
    let before = 0.15;
    for (const dy of steps) {
      const after = wheel(dy, true);
      expect(Math.abs(Math.log(after / before))).toBeCloseTo(0.16, 4);
      before = after;
    }
    expect(before).toBeCloseTo(0.15 * Math.exp(0.32), 4);
  });
});
