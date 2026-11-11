// @vitest-environment jsdom
// The sidebar on its own, in jsdom: what it keeps while the file changes under it.
import { describe, expect, it, vi } from 'vitest';
import { Sidebar, type NodeView, type SidebarActions } from '../src/sidebar';

function sidebar() {
  document.body.innerHTML = '<aside></aside>';
  const root = document.querySelector('aside')!;
  const actions = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (all, name: string) => (all[name] ??= vi.fn()),
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
