// @vitest-environment jsdom
// Arrow labels near the node they leave (D1.7, T1.19, the user, 2026-11-14): Naiad asks
// Mermaid's layout, ELK, to put each arrow label in the row nearest the arrow's source.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import mermaid from 'mermaid';
import { Chart, type ChartEvents } from '../src/chart';
import { labelsNearSource, placeLabelsNearSource } from '../src/elk-options';

// ELK's own `layout`, before Naiad changes it on the first drawing.
const originalLayout = ELK.prototype.layout;

const LABEL_LAYER = 'elk.layered.edgeLabels.centerLabelPlacementStrategy';

describe('the options Naiad adds to each layout', () => {
  test('every label is placed in the row nearest its arrow\'s source; other options are kept', () => {
    expect(labelsNearSource({}, { layoutOptions: { 'elk.direction': 'DOWN' } }))
      .toEqual({ layoutOptions: { 'elk.direction': 'DOWN', [LABEL_LAYER]: 'TAIL_LAYER' } });
  });

  test('without options of its own, the call keeps ELK\'s defaults', () => {
    expect(labelsNearSource({}, {}, { 'elk.algorithm': 'layered' }))
      .toEqual({ layoutOptions: { 'elk.algorithm': 'layered', [LABEL_LAYER]: 'TAIL_LAYER' } });
    expect(labelsNearSource({}, undefined, undefined)).toEqual({ layoutOptions: { [LABEL_LAYER]: 'TAIL_LAYER' } });
  });

  test('an arrow Mermaid turned around before the layout has its label at ELK\'s head, its own source', () => {
    const turned = { layoutReversed: true, labels: [{ layoutOptions: { 'edgeLabels.inline': 'true' } }] };
    const plain = { labels: [{ layoutOptions: { 'edgeLabels.inline': 'true' } }] };
    const bare = { layoutReversed: true };
    const graph = { edges: [plain], children: [{ edges: [], children: [{ edges: [turned, bare] }] }] };
    labelsNearSource(graph, {});
    expect(turned.labels[0].layoutOptions).toEqual({ 'edgeLabels.inline': 'true', [LABEL_LAYER]: 'HEAD_LAYER' });
    expect(plain.labels[0].layoutOptions).toEqual({ 'edgeLabels.inline': 'true' });
    expect(bare).toEqual({ layoutReversed: true });
  });
});

describe('when Naiad changes ELK', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  test('ELK stays out of the code loaded at start: no file imports it but by a deferred import', () => {
    const dir = resolve('src');
    const sources = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.ts$/.test(f));
    for (const f of sources) expect(readFileSync(resolve(dir, f), 'utf8'), f).not.toMatch(/^import[^;]*['"]elkjs/m);
    expect(readFileSync(resolve(dir, 'elk-options.ts'), 'utf8')).toContain("import('elkjs/lib/elk.bundled.js')");
  });

  test('a chart is drawn only once the change is in place', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    let changed: boolean | null = null;
    vi.spyOn(mermaid, 'render').mockImplementation(() => {
      changed = ELK.prototype.layout !== originalLayout;
      return Promise.reject(Error('stop here'));
    });
    const events: ChartEvents = { onSelect: vi.fn(), onHighlight: vi.fn(), onConnect: vi.fn(), onMoveEnd: vi.fn(), onRename: vi.fn(), onAddNode: vi.fn(), onBlocked: vi.fn(), onWalk: vi.fn() };
    const chart = new Chart(document.createElement('div'), events);
    await expect(chart.draw('flowchart TD\n  A --> B\n', undefined as never)).rejects.toThrow('stop here');
    expect(changed).toBe(true);
    chart.destroy();
  });
});

describe('Mermaid still lays out with the ELK Naiad changes', () => {
  // If a Mermaid update stopped importing this file, or brought its own copy of ELK, the
  // labels would go back to the middle of their arrows without any other test failing.
  test('Mermaid\'s layout imports elkjs\'s bundled ELK and calls its layout', () => {
    const dir = resolve('node_modules/mermaid/dist/chunks/mermaid.core');
    const users = readdirSync(dir).filter((f) => f.endsWith('.mjs'))
      .map((f) => readFileSync(resolve(dir, f), 'utf8'))
      .filter((code) => code.includes('from "elkjs/lib/elk.bundled.js"'));
    expect(users).toHaveLength(1);
    expect(users[0]).toMatch(/await \w+\.layout\(/);
  });

  test('Mermaid and Naiad find the same copy of ELK', () => {
    const fromMermaid = createRequire(resolve('node_modules/mermaid/package.json')).resolve('elkjs/lib/elk.bundled.js');
    const fromNaiad = createRequire(resolve('package.json')).resolve('elkjs/lib/elk.bundled.js');
    expect(fromMermaid).toBe(fromNaiad);
  });

  test('Naiad lists elkjs at the version Mermaid installs', () => {
    const naiad = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    const elk = JSON.parse(readFileSync('node_modules/elkjs/package.json', 'utf8')) as { version: string };
    expect(naiad.dependencies.elkjs).toBe(elk.version);
  });

  test('on a drawn chart, a decision\'s "Yes" and "No" sit level, near the decision', async () => {
    const { configureMermaid } = await import('../src/chart');
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 50, height: 20 }) });
    configureMermaid(false);
    await placeLabelsNearSource(); // as `Chart.draw` does before each drawing
    // "Yes" goes to Pack, three rows further down than "No"'s target.
    const chart = 'flowchart TD\nq{In stock?} -->|Yes| pack[Pack]\nq -->|No| order[Order]\norder --> wait[Wait] --> check[Check] --> pack';
    const { svg } = await mermaid.render('labels1', chart);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const y = (el: Element | null) => Number(/translate\(\s*[-\d.e]+[\s,]+([-\d.e]+)/.exec(el?.getAttribute('transform') ?? '')?.[1]);
    const label = (text: string) => [...doc.querySelectorAll('g.edgeLabel')].find((g) => g.textContent?.trim() === text) ?? null;
    const node = (id: string) => doc.querySelector(`g.node[id*="flowchart-${id}-"]`);
    const [yes, no, order, wait] = [y(label('Yes')), y(label('No')), y(node('order')), y(node('wait'))];
    expect([yes, no, order, wait].every(Number.isFinite)).toBe(true);
    expect(Math.abs(yes - no)).toBeLessThan(5);
    expect(yes).toBeLessThan(order);
    expect(yes).toBeLessThan(wait);
  }, 20_000); // A drawing by Mermaid: several seconds when every test file runs at once.
});
