// @vitest-environment jsdom
// Highlighting in the real App (src/app.ts), on the fake disk of app-harness.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartEvents, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FLOW = 'flowchart TD\n    a --> b\n';

describe('two views switch highlights from the same read (bug hunt round 4, E16)', () => {
  afterEach(() => stopApps());

  it('another view switches an item on between this view\'s read and its write: both stay', async () => {
    const disk = new FakeDisk();
    disk.files.set('flow.mmd', FLOW);
    disk.highlights.set('flow.mmd', '# agent\n');
    await startApp(disk, 'flow.mmd');
    disk.afterHighlightsRead = (path) => {
      disk.afterHighlightsRead = null;
      disk.highlights.set(path, '# agent\na\n');
    };
    chartEvents.last!.onHighlight({ kind: 'node', id: 'b' });
    await vi.waitFor(() => expect(disk.highlights.get('flow.mmd')).toBe('# agent\na\nb\n'));
  });

  it('the file kept changing: nothing is written over it and the person is told', async () => {
    const disk = new FakeDisk();
    disk.files.set('flow.mmd', FLOW);
    const view = await startApp(disk, 'flow.mmd');
    let n = 0;
    disk.afterHighlightsRead = (path) => { disk.highlights.set(path, `# agent ${++n}\n`); };
    chartEvents.last!.onHighlight({ kind: 'node', id: 'b' });
    await vi.waitFor(() => expect(view.toast()).toMatch(/kept changing/));
    disk.afterHighlightsRead = null;
    expect(disk.highlights.get('flow.mmd')).toBe(`# agent ${n}\n`);
  });
});
