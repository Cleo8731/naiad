// @vitest-environment jsdom
// The Touchpad and Mouse switch (D1.5, T1.14; the user, 2026-11-14): "trackpad
// "scrolling" (two fingers straight up and down) zooms. Instead, it should be pinching
// gestures", and "two finger dragging in any direction should move the screen". No event
// says which device sent it, so the person chooses: in Touchpad mode a wheel event
// without Ctrl moves the view and a pinch (a Ctrl-marked event) zooms; in Mouse mode the
// wheel zooms, as before. The chart's part runs on the real Chart. The button: wheel-button.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, type ChartEvents } from '../src/chart';

describe('what a wheel event over the chart does', () => {
  let stage: HTMLElement, chart: Chart, frames: Map<number, FrameRequestCallback>, next: number, now: number;
  const view = () => {
    const m = stage.querySelector<HTMLElement>('.canvas')!.style.transform
      .match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e-]+)\)/)!;
    return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
  };
  const wheel = (init: WheelEventInit) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 200, clientY: 150, ...init });
    stage.dispatchEvent(e);
    return e;
  };
  const start = () => { Object.assign(chart as any, { view: { x: 0, y: 0, k: 1 } }); (chart as any).apply(); };
  const run = (ms: number) => {
    for (const end = now + ms; now + 16 <= end;) {
      now += 16;
      const due = [...frames.values()];
      frames.clear();
      for (const f of due) f(now);
    }
  };

  beforeEach(() => {
    frames = new Map(); next = 0; now = 1000;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++next, f); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    stage = document.createElement('div');
    document.body.append(stage);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
    start();
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.unstubAllGlobals(); });

  test('Mouse mode is where the chart starts (the user, 2026-11-14): the wheel zooms', () => {
    wheel({ deltaY: 40 });
    run(400);
    expect(view().k).toBeLessThan(1);
  });

  test('in Touchpad mode, two fingers move the view in any direction, the way a page scrolls, and never zoom', () => {
    chart.setWheelMode('touchpad');
    wheel({ deltaX: 12, deltaY: -30 });
    wheel({ deltaX: -5, deltaY: 8 });
    run(400);
    expect(view()).toEqual({ x: -7, y: 22, k: 1 });
  });

  test('in Touchpad mode, a pinch (a Ctrl-marked event) still zooms, about the fingers', () => {
    chart.setWheelMode('touchpad');
    wheel({ deltaY: -100, ctrlKey: true });
    run(400);
    expect(view().k).toBeCloseTo(Math.exp(0.16), 4);
  });

  test("in Touchpad mode, a mouse wheel's notch moves the view; with Shift, sideways", () => {
    chart.setWheelMode('touchpad');
    wheel({ deltaY: 100 });
    expect(view()).toEqual({ x: 0, y: -100, k: 1 });
    wheel({ deltaY: 100, shiftKey: true });
    expect(view()).toEqual({ x: -100, y: -100, k: 1 });
  });

  test('in Touchpad mode, a wheel that counts in lines moves 16 px a line', () => {
    chart.setWheelMode('touchpad');
    wheel({ deltaY: 3, deltaMode: 1 });
    expect(view()).toEqual({ x: 0, y: -48, k: 1 });
  });

  test('in Mouse mode, the wheel zooms, as before the switch, and never moves the view sideways', () => {
    chart.setWheelMode('mouse');
    wheel({ deltaX: 30, deltaY: -100 });
    run(400);
    expect(view().k).toBeCloseTo(Math.exp(0.16), 4);
    chart.setWheelMode('touchpad');
    wheel({ deltaY: 10 });
    run(400);
    expect(view().k).toBeCloseTo(Math.exp(0.16), 4);
  });
});
