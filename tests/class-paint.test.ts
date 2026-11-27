// @vitest-environment jsdom
// A class's colour in the sidebar's Colour row (T1.6, shortfall 3, Q259, the user,
// 2026-11-26): a node or group coloured by its classes showed "No colour".
import { beforeAll, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { canon, snapshot } from '../src/semantics';
import { Sidebar, SWATCHES, type NodeView, type SidebarActions, type SubView } from '../src/sidebar';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const paint = async (text: string) => (await snapshot(text)).paint ?? {};

describe('the colour a node or group gets from its classes, read as Mermaid draws it', () => {
  it('a node in a class gets that class\'s fill and border, named by the class', async () => {
    const p = await paint('flowchart TD\n  A --> B\n  classDef process fill:#e7f0ff,stroke:#4a6fa5\n  class A process\n');
    expect(p.A).toEqual({ name: 'process', fill: '#e7f0ff', stroke: '#4a6fa5' });
    expect(p.B).toBeUndefined();
  });

  it('the class written after a node (`A:::process`) counts the same', async () => {
    const p = await paint('flowchart TD\n  A:::process --> B\n  classDef process fill:#e7f0ff\n');
    expect(p.A).toEqual({ name: 'process', fill: '#e7f0ff', stroke: '' });
  });

  it('of two classes the later one wins, property by property', async () => {
    const p = await paint('flowchart TD\n  A\n  classDef one fill:#111111,stroke:#222222\n  classDef two fill:#333333\n  class A one\n  class A two\n');
    expect(p.A).toEqual({ name: 'two', fill: '#333333', stroke: '#222222' });
  });

  it('`classDef default` colours every node, under a node\'s own class, but not a group', async () => {
    const p = await paint('flowchart TD\n  subgraph G [Group]\n    A\n    B\n  end\n  classDef default fill:#eeeeee\n  classDef hot fill:#ffcccc\n  class B hot\n');
    expect(p.A).toEqual({ name: 'default', fill: '#eeeeee', stroke: '' });
    expect(p.B).toEqual({ name: 'hot', fill: '#ffcccc', stroke: '' });
    expect(p.G).toBeUndefined();
  });

  it('a group in a class gets its colour', async () => {
    const p = await paint('flowchart TD\n  subgraph G [Group]\n    A\n  end\n  classDef zone fill:#f0f0ff,stroke:#8888cc\n  class G zone\n');
    expect(p.G).toEqual({ name: 'zone', fill: '#f0f0ff', stroke: '#8888cc' });
    expect(p.A).toBeUndefined();
  });

  it('a class that sets neither fill nor border gives no colour', async () => {
    const p = await paint('flowchart TD\n  A\n  classDef bold font-weight:bold\n  class A bold\n');
    expect(p.A).toBeUndefined();
  });

  it('the checks compare a chart without it: a class colour changes nothing they see', async () => {
    const plain = await snapshot('flowchart TD\n  A --> B\n');
    const coloured = await snapshot('flowchart TD\n  A --> B\n');
    coloured.paint = { A: { name: 'process', fill: '#e7f0ff', stroke: '' } };
    expect(canon(coloured)).toBe(canon(plain));
  });
});

function sidebar() {
  document.body.innerHTML = '<aside></aside>';
  const root = document.querySelector('aside')!;
  const actions = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (all, name: string) => (all[name] ??= vi.fn(() => Promise.resolve(true))),
  });
  return { root, actions, side: new Sidebar(root, actions as unknown as SidebarActions) };
}

const NODE: NodeView = {
  kind: 'node', id: 'check', title: 'Check the saved PDF', description: '', shape: 'square', fill: '',
  group: '', groups: [], classPaint: { name: 'process', fill: '#e7f0ff', stroke: '#4a6fa5' },
};

describe('the Colour row shows the class\'s colour as the first swatch (Q259)', () => {
  // The panel's own Colour row, not the New class form's (Q272 put the form above it).
  const colourRow = (root: HTMLElement) => [...root.querySelectorAll('.props > .row')].find((r) => r.textContent?.startsWith('Colour'))!;
  const on = (root: HTMLElement) => [...colourRow(root).querySelectorAll<HTMLButtonElement>('.swatch.on')].map((b) => b.title);

  it('a node coloured by its class: the class\'s swatch is marked, in its colours, named by the class', () => {
    const { root, side } = sidebar();
    side.show(NODE);
    expect(on(root)).toEqual(['process, from its class']);
    const first = colourRow(root).querySelector<HTMLButtonElement>('.swatch')!;
    expect(first.getAttribute('aria-label')).toBe('process, from its class');
    expect(first.classList.contains('from-class')).toBe(true);
    expect(first.style.background).toMatch(/rgb\(231, 240, 255\)|#e7f0ff/);
    expect(first.style.borderColor).toMatch(/rgb\(74, 111, 165\)|#4a6fa5/);
  });

  it('a node with its own colour on top of its class: its own swatch is marked, and the class\'s takes it off', () => {
    const { root, actions, side } = sidebar();
    side.show({ ...NODE, fill: SWATCHES[1].fill });
    expect(on(root)).toEqual(['Green']);
    colourRow(root).querySelector<HTMLButtonElement>('[title="process, from its class"]')!.click();
    expect(actions.setFill).toHaveBeenLastCalledWith('check', null);
  });

  it('a node with no class colour keeps No colour, and the class\'s look goes when the class does', () => {
    const { root, side } = sidebar();
    side.show(NODE);
    side.show({ ...NODE, classPaint: null });
    expect(on(root)).toEqual(['No colour']);
    const first = colourRow(root).querySelector<HTMLButtonElement>('.swatch')!;
    expect(first.classList.contains('from-class')).toBe(false);
    expect(first.style.background).toBe('');
    expect(first.style.borderColor).toBe('');
  });

  it('a group coloured by its class shows it the same way', () => {
    const { root, side } = sidebar();
    const group: SubView = { kind: 'sub', id: 'G', title: 'Group', dir: '', fill: '', count: 2, classPaint: { name: 'zone', fill: '#f0f0ff', stroke: '' } };
    side.show(group);
    expect(on(root)).toEqual(['zone, from its class']);
  });
});
