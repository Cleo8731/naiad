// @vitest-environment jsdom
// "No file open" while Naiad starts on a file (Q262, the user, 2026-11-26: the desktop
// app showed it for about a second before the file's chart).
import { afterEach, expect, test, vi } from 'vitest';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

afterEach(() => stopApps());

const A = 'C:/charts/a.mmd';
const message = () => document.querySelector<HTMLElement>('.tabview:not([hidden]) .empty')!;

test('a start on a file never shows "No file open" on the way', async () => {
  const d = new FakeDisk();
  d.files.set(A, 'flowchart TD\n    a[A] --> b[B]\n');
  const make = d.backend.bind(d);
  // The file is named a moment after the window is built, as a slow start would.
  d.backend = () => ({ ...make(), initialPath: async () => { await sleep(20); return A; } });
  const shown: boolean[] = [];
  const watch = new MutationObserver((records) => {
    for (const r of records) if ((r.target as Element).matches('.empty')) shown.push(!(r.target as HTMLElement).hidden);
  });
  watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const ui = await startApp(d, null);
  await sleep(10);
  watch.disconnect();
  expect(ui.shown()).toBe('a.mmd');
  expect(shown).not.toContain(true);
  expect(message().hidden).toBe(true);
});

test('a start with no file shows "No file open" once the window has started', async () => {
  await startApp(new FakeDisk(), null);
  expect(message().hidden).toBe(false);
  expect(message().textContent).toContain('No file open');
});
