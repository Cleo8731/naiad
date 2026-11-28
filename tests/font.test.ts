// @vitest-environment jsdom
// Lexend, for the chart and the window (the design handoff, T4.9, 2026-11-15; Nunito
// before it): the styles and Mermaid name it first, and the chart waits for it. The
// chart takes the palette's colors from the page. The files and their license:
// window-frame.test.ts, "the look".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';
import { CHART_FONT, Chart, configureMermaid, type ChartEvents } from '../src/chart';

const css = readFileSync(resolve('src', 'style.css'), 'utf8');

test('the styles name Lexend first for the window, and a code font for the Syntax pane', () => {
  expect(/--font-ui:\s*([^;]*);/.exec(css)?.[1]).toMatch(/^'Lexend',/);
  expect(/--font-mono:\s*([^;]*);/.exec(css)?.[1]).toMatch(/^'JetBrains Mono',/);
  expect(css).toMatch(/font:\s*12\.5px\/1\.7 var\(--mono\)/);
});

test('Mermaid draws in it, in light and dark', () => {
  expect(CHART_FONT).toMatch(/^Lexend,/);
  const init = vi.spyOn(mermaid, 'initialize');
  for (const dark of [false, true]) {
    configureMermaid(dark);
    expect(init.mock.lastCall?.[0].themeVariables?.fontFamily).toBe(CHART_FONT);
  }
});

test('Mermaid takes the palette\'s colors from the page, and Naiad Default\'s without them', () => {
  const init = vi.spyOn(mermaid, 'initialize');
  const vars = () => init.mock.lastCall?.[0].themeVariables as Record<string, unknown>;
  configureMermaid(false);
  expect(vars()).toMatchObject({ primaryColor: '#ffffff', primaryBorderColor: '#95c2c8', lineColor: '#66979f', clusterBkg: '#e3efee' });
  expect(vars().darkMode).toBeUndefined();
  configureMermaid(true);
  expect(vars()).toMatchObject({ darkMode: true, primaryColor: '#12303a', lineColor: '#5592a0', background: '#0b1c21' });
  const root = document.documentElement.style;
  root.setProperty('--node', 'rgb(10, 20, 30)');
  root.setProperty('--edge', 'rgb(40, 50, 60)');
  try {
    configureMermaid(false);
    expect(vars()).toMatchObject({ primaryColor: 'rgb(10, 20, 30)', lineColor: 'rgb(40, 50, 60)', primaryBorderColor: '#95c2c8' });
  } finally {
    root.removeProperty('--node');
    root.removeProperty('--edge');
  }
  expect(document.body.querySelector('span[hidden]')).toBeNull(); // the probe is taken away
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
});

test('the chart is drawn only once the font has loaded, so labels are measured in it', async () => {
  let loaded!: () => void;
  const load = vi.fn(() => new Promise<void>((done) => { loaded = done; }));
  Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const render = vi.spyOn(mermaid, 'render').mockRejectedValue(Error('stop here'));
  const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn(), onWalk: vi.fn() };
  const chart = new Chart(document.createElement('div'), events);
  const drawing = chart.draw('flowchart TD\n  A --> B\n', undefined as never);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(load).toHaveBeenCalledWith('14px Lexend');
  expect(render).not.toHaveBeenCalled();
  loaded();
  await expect(drawing).rejects.toThrow('stop here');
  expect(render).toHaveBeenCalledOnce();
});
