// @vitest-environment jsdom
// Nunito, for the chart and the window (the user, 2026-11-13): the file and its licence
// are bundled, the styles and Mermaid name it first, and the chart waits for it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import mermaid from 'mermaid';
import { CHART_FONT, Chart, configureMermaid, type ChartEvents } from '../src/chart';

const here = (path: string) => resolve('src', path);
const css = readFileSync(here('style.css'), 'utf8');

test('the font file is bundled with its licence', () => {
  expect(readFileSync(here('fonts/nunito-latin.woff2')).subarray(0, 4).toString('latin1')).toBe('wOF2');
  const licence = readFileSync(here('fonts/OFL.txt'), 'utf8');
  expect(licence).toContain('Copyright 2014 The Nunito Project Authors');
  expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
});

test('the styles declare the font and name it first; the Syntax pane keeps its code font', () => {
  const face = /@font-face\s*{([^}]*)}/.exec(css)?.[1] ?? '';
  expect(face).toMatch(/font-family:\s*Nunito;/);
  expect(face).toContain("url('./fonts/nunito-latin.woff2')");
  expect(/--ui:\s*([^;]*);/.exec(css)?.[1]).toMatch(/^Nunito,/);
  expect(/--mono:\s*([^;]*);/.exec(css)?.[1]).not.toContain('Nunito');
  expect(css).toContain('font: 12.5px/1.6 var(--mono)');
});

test('Mermaid draws in it, in light and dark', () => {
  expect(CHART_FONT).toMatch(/^Nunito,/);
  const init = vi.spyOn(mermaid, 'initialize');
  for (const dark of [false, true]) {
    configureMermaid(dark);
    expect(init.mock.lastCall?.[0].themeVariables?.fontFamily).toBe(CHART_FONT);
  }
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
  const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn() };
  const chart = new Chart(document.createElement('div'), events);
  const drawing = chart.draw('flowchart TD\n  A --> B\n', undefined as never);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(load).toHaveBeenCalledWith('14px Nunito');
  expect(render).not.toHaveBeenCalled();
  loaded();
  await expect(drawing).rejects.toThrow('stop here');
  expect(render).toHaveBeenCalledOnce();
});
