// @vitest-environment jsdom
// The sidebar on its own, in jsdom: what it keeps while the file changes under it.
import { describe, expect, it, vi } from 'vitest';
import { Sidebar, type EdgeView, type NodeView, type SidebarActions } from '../src/sidebar';

function sidebar() {
  document.body.innerHTML = '<aside></aside>';
  const root = document.querySelector('aside')!;
  // Each action written, as in the app: a box's write waits for its answer.
  const actions = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (all, name: string) => (all[name] ??= vi.fn(() => Promise.resolve(true))),
  });
  return { root, actions, side: new Sidebar(root, actions as unknown as SidebarActions) };
}

const VIEW: NodeView = {
  kind: 'node', id: 'collect', title: 'Collect data', description: 'Pull the raw exports.',
  shape: 'square', fill: '', group: 'prep', groups: [{ id: 'prep', title: 'Preparation' }, { id: 'model', title: 'Model' }],
};

describe('a description being written is kept while the file changes (bug hunt S20: C17)', () => {
  it('C17: a group renamed on disk keeps the draft, and the group list shows the new title', () => {
    const { root, actions, side } = sidebar();
    side.show(VIEW);
    root.querySelector('.desc-body')!.dispatchEvent(new MouseEvent('dblclick'));
    const area = root.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!;
    area.value = 'A draft the person is still writing.';

    side.show({ ...VIEW, groups: [{ id: 'prep', title: 'Getting ready' }, { id: 'model', title: 'Model' }] });

    const now = root.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!;
    expect(now.hidden).toBe(false);
    expect(now.value).toBe('A draft the person is still writing.');
    const group = root.querySelectorAll<HTMLSelectElement>('select')[1];
    expect([...group.options].map((o) => o.textContent)).toEqual(['None', 'Getting ready', 'Model', 'New group…']);
    expect(group.value).toBe('prep');

    root.querySelector<HTMLButtonElement>('button.primary')!.click(); // Done
    expect(actions.setDescription).toHaveBeenCalledWith('collect', 'A draft the person is still writing.');
  });

  it('a group added or removed on disk updates the list, and the node\'s group stays chosen', () => {
    const { root, side } = sidebar();
    side.show(VIEW);
    side.show({ ...VIEW, group: 'model', groups: [{ id: 'model', title: 'Model' }, { id: 'ship', title: 'Ship' }] });
    const group = root.querySelectorAll<HTMLSelectElement>('select')[1];
    expect([...group.options].map((o) => o.value)).toEqual(['', 'model', 'ship', '\u0000new']);
    expect(group.value).toBe('model');
  });

  it('another node opens a fresh panel: the draft of the first is not carried over', () => {
    const { root, side } = sidebar();
    side.show(VIEW);
    root.querySelector('.desc-body')!.dispatchEvent(new MouseEvent('dblclick'));
    root.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!.value = 'draft';
    side.show({ ...VIEW, id: 'clean', title: 'Clean', description: '' });
    expect(root.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!.hidden).toBe(true);
    expect(root.querySelector('code.id')!.textContent).toBe('clean');
  });
});

describe('a box blurred as its panel is emptied commits nothing (bug hunt round 3: C33)', () => {
  // Chromium fires blur on a focused box as it is taken out of the page; jsdom does not,
  // so the panel here does what Chromium does.
  function blurOnRemoval(root: HTMLElement) {
    const replace = root.replaceChildren.bind(root);
    root.replaceChildren = (...nodes: (Node | string)[]) => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && root.contains(focused)) focused.blur();
      replace(...nodes);
    };
  }
  const EDGE: EdgeView = { kind: 'edge', fromId: 'a', toId: 'b', ends: [], index: 1, from: 'b', to: 'c', label: '', stroke: 'normal', arrow: 'arrow' };

  function typing() {
    const s = sidebar();
    blurOnRemoval(s.root);
    s.side.show(EDGE);
    const box = s.root.querySelector<HTMLInputElement>('input.title')!;
    box.focus();
    box.value = 'TYPED LABEL';
    return { ...s, box };
  }

  it('C33: the panel closed by a change on disk (arrow 1 has other ends now): no label is written', () => {
    const { actions, side } = typing();
    side.show(null);
    expect(actions.setEdgeLabel).not.toHaveBeenCalled();
  });

  it('the panel built for another item: nothing is written to the arrow of the box', () => {
    const { actions, side } = typing();
    side.show({ ...EDGE, index: 2, from: 'c', to: 'd' });
    expect(actions.setEdgeLabel).not.toHaveBeenCalled();
  });

  it('focus leaving the box while its panel stays: the label is written to its arrow', () => {
    const { actions, box } = typing();
    box.blur();
    expect(actions.setEdgeLabel).toHaveBeenCalledWith(1, 'TYPED LABEL');
  });
});
