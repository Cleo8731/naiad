// @vitest-environment jsdom
// The dot grid (T4.18): it stays fixed to the window, 22 px apart, while panning and
// zooming move the chart (Q187, changed back by the user, 2026-11-18); its dots stand
// out from the background at about 1.5 to 1 in every theme and mode (Q188).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';
import { Chart, type ChartEvents } from '../src/chart';
import type { Snap } from '../src/semantics';

const snap: Snap = {
  direction: 'TD',
  nodes: { A: { text: 'A', type: 'square', styles: [], classes: [] } },
  edges: [], edgeIds: [], subs: {}, accTitle: '', accDescr: '',
};

describe('the dot grid stays fixed to the window (Q187, changed back)', () => {
  let stage: HTMLElement, chart: Chart;
  const box = (w: number, h: number) =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.spyOn(mermaid, 'render').mockImplementation(async (id: string) =>
      ({ svg: `<svg viewBox="0 0 400 200"><g class="node" id="${id}-flowchart-A-0"></g></svg>` }) as never);
    stage = document.createElement('div');
    document.body.append(stage);
    Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => 800 });
    stage.getBoundingClientRect = () => box(800, 600);
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn() };
    chart = new Chart(stage, events);
  });
  afterEach(() => { chart.destroy(); stage.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  test('panning and zooming leave the grid\'s spacing and place as the style sheet sets them', async () => {
    await chart.draw('flowchart TD\n  A\n', snap);
    chart.setWheelMode('touchpad'); // a two-finger move pans
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaX: 7, deltaY: 5 }));
    chart.zoom(0.5, 400, 300);
    chart.zoom(3, 400, 300);
    expect(stage.style.backgroundSize).toBe('');
    expect(stage.style.backgroundPosition).toBe('');
  });

  test('the style sheet puts the dots 22 px apart', () => {
    const stageRule = /\n\.stage \{([^}]*)\}/.exec(readFileSync('src/style.css', 'utf8'))![1];
    expect(stageRule).toContain('background-size: 22px 22px;');
  });
});

describe('the dots\' contrast (Q188)', () => {
  const css = readFileSync('src/style.css', 'utf8');
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [d, l] = [lum(a), lum(b)].sort((p, q) => p - q);
    return (l + 0.05) / (d + 0.05);
  };
  const blocks = [...css.matchAll(/:root\[data-palette="([\w-]+)"\][^{]*\{([^}]*)\}/g)].filter((b) => b[2].includes('--grid-dot'));
  const pair = (body: string, name: string) => {
    const m = new RegExp(`--${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`).exec(body)!;
    return [m[1], m[2]];
  };

  test('six themes, each with a background and dots in light and dark', () => {
    expect(blocks.map((b) => b[1])).toEqual(['naiad-default', 'moonpool', 'kelp', 'water-lily', 'glacier', 'coral']);
  });

  test.each(['naiad-default', 'moonpool', 'kelp', 'water-lily', 'glacier', 'coral'])('%s: the dots are about 1.5 to 1 against the background, light and dark', (name) => {
    const body = blocks.find((b) => b[1] === name)![2];
    const bg = pair(body, 'bg');
    const dot = pair(body, 'grid-dot');
    for (const i of [0, 1]) {
      expect(ratio(bg[i], dot[i])).toBeGreaterThanOrEqual(1.45);
      expect(ratio(bg[i], dot[i])).toBeLessThanOrEqual(1.6);
    }
  });
});
