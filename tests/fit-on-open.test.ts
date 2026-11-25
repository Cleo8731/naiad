// @vitest-environment jsdom
// A file's first drawing is fitted again once its tab shows the chart's tools (seen
// 2026-11-25 while recording the README's demos): the tab drew the chart while the pill
// was still hidden from the blank tab, so the first fit left room for no pill, and a tall
// chart's last node sat under it until Fit was pressed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { charts, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

describe('the first fit of an opened file', () => {
  const FILE = 'C:/fit/flow.mmd';
  let disk: FakeDisk;
  beforeEach(() => { localStorage.clear(); charts.list.length = 0; disk = new FakeDisk(); disk.files.set(FILE, 'flowchart TD\n    a --> b\n'); });
  afterEach(() => { stopApps(); localStorage.clear(); });

  it('is made again after the pill shows', async () => {
    await startApp(disk, FILE);
    const chart = charts.list.find((c) => c.drawn.length)!;
    expect(chart.drawn).toHaveLength(1);
    // Once drawn, the chart is fitted again with the pill shown.
    expect(chart.steps.slice(chart.steps.indexOf('drawn'))).toContain('tools shown');
  });
});
