// @vitest-environment jsdom
// Zoom steps (T1.12, the user's reports of 2026-11-13): a touchpad pinch in Codex's browser
// pane reached the page as Ctrl-marked wheel events of a whole notch each (deltaY 100).
// First each zoomed 2.7 times, too far to reach the zoom wanted; then, capped at one
// plain notch (17.4%), each still jumped in one frame, which the user found choppy. A
// notch now glides to its step over a few frames.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Chart, type ChartEvents } from '../src/chart';

describe('how far, and how smoothly, one wheel event zooms', () => {
  let stage: HTMLElement, chart: Chart, frames: Map<number, FrameRequestCallback>, next: number, now: number;
  const zoom = () => Number(stage.querySelector<HTMLElement>('.canvas')!.style.transform.match(/scale\(([\d.e-]+)\)/)![1]);
  const wheel = (deltaY: number, ctrlKey = false) => {
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true, clientX: 200, clientY: 150 }));
    return zoom();
  };
  const start = (k: number) => { Object.assign(chart as any, { view: { x: 0, y: 0, k } }); (chart as any).apply(); };
  /** Runs the animation frames due in the next `ms`, one every 16 ms, as a 60 Hz screen
   * draws; returns the zoom after each frame that ran. */
  const run = (ms: number) => {
    const seen: number[] = [];
    for (const end = now + ms; now + 16 <= end;) {
      now += 16;
      const due = [...frames.entries()];
      frames.clear();
      for (const [, f] of due) f(now);
      if (due.length) seen.push(zoom());
    }
    return seen;
  };
  /** The biggest change of zoom from one frame to the next, as a share (0.05 = 5%). */
  const biggestStep = (ks: number[]) => Math.max(...ks.slice(1).map((k, i) => Math.abs(Math.log(k / ks[i])))) ;

  beforeEach(() => {
    frames = new Map(); next = 0; now = 1000;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { frames.set(++next, f); return next; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    stage = document.createElement('div');
    document.body.append(stage);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.unstubAllGlobals(); });

  test('a plain wheel notch glides to 17.4% over several frames, in and out', () => {
    start(1);
    expect(wheel(-100)).toBe(1); // nothing moves before the next frame
    const ks = [1, ...run(400)];
    expect(ks.length).toBeGreaterThanOrEqual(6);
    expect(biggestStep(ks)).toBeLessThan(0.06);
    expect(ks[ks.length - 1]).toBeCloseTo(Math.exp(0.16), 4);
    expect(frames.size).toBe(0); // the glide ends: no frame left asked for
    wheel(100);
    run(400);
    expect(zoom()).toBeCloseTo(1, 4);
  });

  test('a Ctrl-marked event of a whole notch zooms no further than a plain notch', () => {
    start(1);
    wheel(-100, true);
    run(400);
    expect(zoom()).toBeCloseTo(Math.exp(0.16), 4);
    start(1);
    wheel(100, true);
    run(400);
    expect(zoom()).toBeCloseTo(Math.exp(-0.16), 4);
  });

  test("a smooth pinch's small Ctrl-marked events follow the fingers at once", () => {
    start(1);
    expect(wheel(-4, true)).toBeCloseTo(Math.exp(0.04), 4);
    expect(wheel(-3, true)).toBeCloseTo(Math.exp(0.07), 4);
    expect(frames.size).toBe(0);
  });

  test('a notch that comes during a glide adds to where it is going', () => {
    start(1);
    wheel(-100);
    run(48);
    wheel(-100);
    run(500);
    expect(zoom()).toBeCloseTo(Math.exp(0.32), 4);
  });

  test('fitting the chart stops a glide', () => {
    start(1);
    wheel(-100);
    chart.fit(); // with no size yet it changes nothing, but the glide must stop
    expect(frames.size).toBe(0);
  });

  test("the user's first pinch recorded in Codex's pane moves one notch per event, not 2.7 times", () => {
    // The zoom recorder's events (testing/zoom-trial, 2026-11-13): eight steps of 100, from 0.15.
    start(0.15);
    const steps = [-100, -100, -100, 100, 100, 100, -100, -100];
    let before = 0.15;
    for (const dy of steps) {
      wheel(dy, true);
      run(400);
      expect(Math.abs(Math.log(zoom() / before))).toBeCloseTo(0.16, 4);
      before = zoom();
    }
    expect(before).toBeCloseTo(0.15 * Math.exp(0.32), 4);
  });

  test("the user's second pinch recorded in Codex's pane glides: no frame moves half a notch", () => {
    // Forwarded 2026-11-13: 13 notches in, then 9 out, Ctrl-marked, at these times (ms).
    const times = [4811, 4922, 6174, 6294, 7025, 7171, 7388, 7485, 7566, 7732, 7848, 7945, 8009,
      8868, 8895, 8947, 9132, 9217, 9281, 9397, 9488, 9556];
    start(0.15);
    now = 4800;
    const ks = [0.15];
    times.forEach((t, i) => {
      ks.push(...run(t - now));
      ks.push(wheel(i < 13 ? -100 : 100, true)); // a change made in the event shows at the next frame
    });
    ks.push(...run(500));
    // Three notches came within 80 ms (at 8868, 8895 and 8947), so frames move faster
    // there; a notch is 0.16, and before the glide it moved in one frame.
    expect(biggestStep(ks)).toBeLessThan(0.08);
    expect(ks[ks.length - 1]).toBeCloseTo(0.15 * Math.exp(0.16 * 4), 4);
  });
});
