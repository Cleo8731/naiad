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
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
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

  test('a wide, short chart is centred in the room between the tools', () => {
    tool('island-row', rect(14, 14, 80, 40));
    tool('pill', rect(400, 734, 200, 48));
    const at = fit(1900, 200); // width decides: k = 952 / 1900
    expect(at.k).toBeCloseTo(952 / 1900, 6);
    expect(at.y).toBeCloseTo(66 + (656 - 200 * at.k) / 2, 6);
  });

  test('a hidden tool (no size) takes no room', () => {
    tool('island-row', rect(0, 0, 0, 0)); // in View mode Undo's island is hidden
    tool('pill', rect(400, 734, 200, 48));
    const at = fit(400, 1000);
    expect(at.y).toBe(24);
    expect(at.bottom).toBeCloseTo(722, 6);
  });
});
