// @vitest-environment jsdom
// The sidebar on its own, in jsdom: what it keeps while the file changes under it.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar, SWATCHES, type EdgeView, type NodeView, type SidebarActions } from '../src/sidebar';

function sidebar() {
  document.body.innerHTML = '<aside></aside>';
  const root = document.querySelector('aside')!;
  // Each action written, as in the app: a box's write waits for its answer.
  const actions = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (all, name: string) => (all[name] ??= vi.fn(() => Promise.resolve(true))),
  });
  return { root, actions, side: new Sidebar(root, actions as unknown as SidebarActions) };
}

/** The Group row's list (the Class row and its New class form come before it, Q272). */
const groupBox = (root: HTMLElement) => [...root.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent === 'Group')!.querySelector<HTMLSelectElement>('select')!;

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
    const group = groupBox(root);
    expect([...group.options].map((o) => o.textContent)).toEqual(['None', 'Getting ready', 'Model', 'New group…']);
    expect(group.value).toBe('prep');

    now.blur(); // a click outside the box
    expect(actions.setDescription).toHaveBeenCalledWith('collect', 'A draft the person is still writing.');
  });

  it('a group added or removed on disk updates the list, and the node\'s group stays chosen', () => {
    const { root, side } = sidebar();
    side.show(VIEW);
    side.show({ ...VIEW, group: 'model', groups: [{ id: 'model', title: 'Model' }, { id: 'ship', title: 'Ship' }] });
    const group = groupBox(root);
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
  const EDGE: EdgeView = { kind: 'edge', fromId: 'a', toId: 'b', ends: [], index: 1, from: 'b', to: 'c', label: '', stroke: 'normal', arrow: 'arrow', colour: '' };

  function typing() {
    const s = sidebar();
    blurOnRemoval(s.root);
    s.side.show(EDGE);
    const box = s.root.querySelector<HTMLTextAreaElement>('textarea.title')!;
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

describe('an arrow\'s Colour row (the user, 2026-11-13, Q109)', () => {
  const ARROW: EdgeView = { kind: 'edge', fromId: 'a', toId: 'b', ends: [], index: 3, from: 'A', to: 'B', label: '', stroke: 'normal', arrow: 'arrow', colour: '#e03131' };
  it('shows the swatch whose border is the arrow\'s colour, and writes the one clicked', () => {
    const { root, actions, side } = sidebar();
    side.show(ARROW);
    const row = [...root.querySelectorAll('.row')].find((r) => r.textContent?.startsWith('Colour'))!;
    const on = () => [...row.querySelectorAll<HTMLButtonElement>('.swatch.on')].map((b) => b.title);
    expect(on()).toEqual(['Red']);
    side.show({ ...ARROW, colour: '' });
    expect(on()).toEqual(['No colour']);
    side.show({ ...ARROW, colour: '#123456' }); // typed in the Syntax pane: no swatch is it
    expect(on()).toEqual([]);
    row.querySelector<HTMLButtonElement>('[title="Blue"]')!.click();
    expect(actions.setEdgeColour).toHaveBeenLastCalledWith(3, SWATCHES[0]);
    row.querySelector<HTMLButtonElement>('[title="No colour"]')!.click();
    expect(actions.setEdgeColour).toHaveBeenLastCalledWith(3, null);
  });
});

describe('a long title wraps while it is edited (the user, 2026-11-17)', () => {
  // The user: "even in edit mode, titles (above descriptions, in the description panel)
  // should wrap". A one-line text field cannot wrap, so the title box is a text area
  // one line high that grows with its text (CSS `field-sizing: content`). A title is
  // still one line in the file: Enter enters it, and a line break typed or pasted
  // becomes a space.
  const SUB = { kind: 'sub' as const, id: 'prep', title: 'Preparation', dir: '', fill: '', count: 2 };
  const EDGE: EdgeView = { kind: 'edge', fromId: 'a', toId: 'b', ends: [], index: 1, from: 'b', to: 'c', label: 'Yes', stroke: 'normal', arrow: 'arrow', colour: '' };

  it("a node's title, an arrow's label and a group's title are each a box that wraps", () => {
    const { root, side } = sidebar();
    for (const [view, value] of [[VIEW, 'Collect data'], [EDGE, 'Yes'], [SUB, 'Preparation']] as const) {
      side.show(view);
      const box = root.querySelector<HTMLTextAreaElement>('.title')!;
      expect(box.tagName, view.kind).toBe('TEXTAREA');
      expect(box.rows).toBe(1);
      expect(box.value).toBe(value);
    }
    const css = readFileSync('src/style.css', 'utf8');
    const rule = css.match(/\.sidebar textarea\.title\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/field-sizing:\s*content/);
    expect(rule).toMatch(/resize:\s*none/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('Enter enters the title and adds no line break', () => {
    const { root, actions, side } = sidebar();
    side.show(VIEW);
    const box = root.querySelector<HTMLTextAreaElement>('.title')!;
    box.focus();
    box.value = 'Collect every raw export';
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    box.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(box);
    expect(actions.setTitle).toHaveBeenCalledWith('collect', 'Collect every raw export');
  });

  it('a line break typed or pasted into the box becomes a space', () => {
    const { root, actions, side } = sidebar();
    side.show(VIEW);
    const box = root.querySelector<HTMLTextAreaElement>('.title')!;
    box.focus();
    box.value = 'Collect\r\nevery\nraw export';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(box.value).toBe('Collect every raw export');
    box.blur();
    expect(actions.setTitle).toHaveBeenCalledWith('collect', 'Collect every raw export');
  });
});

describe("the Shape and Group boxes take the row's width (seen 2026-11-25)", () => {
  // The label's rule, 64 px wide, once matched every span in a row, and the box's own
  // wrapper is a span: the boxes showed "Ro" for Rounded and "Nc" for None.
  it('no rule that sets a width of 64 px matches a box or its wrapper', () => {
    const { root, side } = sidebar();
    side.show(VIEW);
    const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const narrow = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /(^|;)\s*width:\s*64px/.test(body))
      .flatMap(([, selectors]) => selectors.split(',').map((s) => s.trim()));
    expect(narrow.length).toBeGreaterThan(0);
    const boxes = [...root.querySelectorAll('.row .select-wrap, .row select')];
    // Class (T1.26), the New class form's Border and Shape, Group, and Shape, each a
    // wrapper and its list.
    expect(boxes.length).toBe(10);
    for (const box of boxes) for (const s of narrow) expect(box.matches(s), s).toBe(false);
    expect(root.querySelector('.row > .row-label')!.textContent).toBe('Class');
  });
});

describe('the panel\'s height (the user, 2026-11-26)', () => {
  it('no part shrinks to fit the panel, so a long description pushes the rows under it down and the panel scrolls', () => {
    const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\n\.sidebar > \* \{ flex-shrink: 0; \}/);
    expect(css).toMatch(/\n\.sidebar \{[^}]*overflow-y: auto/);
    // A part that may shrink below its text (min-height: 0) drew that text over the rows under it.
    const rules = [...css.matchAll(/\n([^{}\n]*)\{([^}]*)\}/g)].filter((m) => /(^|[\s,])\.(desc|props|classes|side-foot)\b/.test(m[1]));
    for (const m of rules) expect(m[2], m[1]).not.toMatch(/min-height: 0/);
  });
});

describe('long text in the panel (the user, 2026-11-26)', () => {
  it('a list cut off in its box shows its whole choice when pointed at, and the id pill its whole id', () => {
    const { root, side } = sidebar();
    const long = 'Preparation of every raw export before the model is trained';
    side.show({ ...VIEW, id: 'collect_customer_feedback_for_review', groups: [{ id: 'prep', title: long }, { id: 'model', title: 'Model' }] });
    expect(groupBox(root).title).toBe(long);
    expect(root.querySelector<HTMLElement>('.side-head .id')!.title).toBe('The id used in the file: collect_customer_feedback_for_review');
    side.show({ ...VIEW, group: '' });
    expect(groupBox(root).title).toBe('None');
  });

  it('one long word wraps in the arrow\'s ends, a class\'s problem line and the toast; a wide table scrolls itself', () => {
    const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => { const at = css.indexOf(`\n${sel} {`); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)); };
    for (const sel of ['.ends > *', '.class-item > .problem', '.new-class .problem', '.toast']) expect(rule(sel), sel).toContain('overflow-wrap: anywhere');
    expect(rule('.toast')).toContain('overflow-y: auto');
    expect(rule('.desc-body table')).toContain('overflow-x: auto');
  });
});
