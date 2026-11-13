// The sidebar: opens when a node, arrow or group is clicked. For a node it shows the
// title with the full description underneath; both can be edited there, except in View
// mode, where the panel shows them as text.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { SHAPES } from './core/scan';
import type { ArrowKind, LinkParts } from './core/edits';

export interface NodeView {
  kind: 'node'; id: string; title: string; description: string; shape: string;
  fill: string; group: string; groups: { id: string; title: string }[];
}
export interface EdgeView {
  kind: 'edge'; index: number; from: string; to: string; label: string;
  stroke: LinkParts['stroke']; arrow: ArrowKind;
  /** The arrow's own colour (`stroke` in its `linkStyle` line), as written; '' for none. */
  colour: string;
  fromId: string; toId: string; ends: { id: string; title: string }[];
}
export interface SubView { kind: 'sub'; id: string; title: string; dir: string; fill: string; count: number }
export type View = NodeView | EdgeView | SubView;

/**
 * The edits of the panel's text boxes resolve true when the change is in the file, so a
 * box written as Naiad closes knows whether it was (bug hunt round 6, C44).
 */
export interface SidebarActions {
  close(): void;
  setTitle(id: string, title: string): Promise<boolean>;
  /** Writes the description; the promise, if any, ends when the write has ended. */
  setDescription(id: string, description: string): Promise<void> | void;
  setShape(id: string, shape: string): void;
  setFill(id: string, swatch: Swatch | null): void;
  setGroup(id: string, group: string): void;
  deleteNode(id: string): void;
  setEdgeLabel(index: number, label: string): Promise<boolean>;
  setEdgeEnd(index: number, end: 'start' | 'end', id: string): void;
  setEdgeStroke(index: number, stroke: LinkParts['stroke']): void;
  setEdgeArrow(index: number, arrow: ArrowKind): void;
  setEdgeColour(index: number, swatch: Swatch | null): void;
  deleteEdge(index: number): void;
  renameGroup(id: string, title: string): Promise<boolean>;
  setGroupDirection(id: string, dir: string): void;
  addNodeIn(id: string): void;
  ungroup(id: string): void;
  openLink(url: string): void;
}

export interface Swatch { name: string; fill: string; stroke: string }

/** Fill and border pairs; text is always dark so a filled node reads in both themes. */
export const SWATCHES: Swatch[] = [
  { name: 'Blue', fill: '#d0ebff', stroke: '#1c7ed6' },
  { name: 'Green', fill: '#d3f9d8', stroke: '#2f9e44' },
  { name: 'Yellow', fill: '#fff3bf', stroke: '#f08c00' },
  { name: 'Red', fill: '#ffe3e3', stroke: '#e03131' },
  { name: 'Purple', fill: '#e5dbff', stroke: '#7048e8' },
  { name: 'Grey', fill: '#e9ecef', stroke: '#868e96' },
];
/** A description being written: its node, its text, and what the app calls once the text is in the file. */
export interface Draft { id: string; text: string; written(): void }

/**
 * A title, an arrow's label or a group's title typed in the panel and not yet entered:
 * what it is ("title", "label", "group title"), and its writing, which resolves true once
 * it is in the file (bug hunt round 6, C44).
 */
export interface Typed { what: string; text: string; write(): Promise<boolean> }

export const NEW_GROUP = '\u0000new';

const PICKABLE_SHAPES = ['square', 'round', 'stadium', 'diamond', 'hexagon', 'circle', 'cylinder', 'subroutine', 'lean_right', 'trapezoid'];

type Attrs = Record<string, string | boolean | ((e: Event) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k, v);
    else if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); }
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function option(value: string, label: string): HTMLOptionElement {
  return h('option', { value }, label);
}

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'] });
}

export class Sidebar {
  private key = '';
  /** Counts the panels built; a box acts only while the panel it is in is shown (`textBox`). */
  private built = 0;
  private editingDescription = false;
  private sync: ((v: View) => void)[] = [];
  private draftOf: (() => Draft | null) | null = null;
  private resume: ((text: string) => void) | null = null;
  private boxes: (() => Typed | null)[] = [];
  /** View mode (D4.3, T1.11): the panel shows the item as text, with nothing that changes it. */
  private viewing = false;

  constructor(private root: HTMLElement, private actions: SidebarActions) {
    root.addEventListener('click', (e) => {
      const a = (e.target as Element).closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href)) this.actions.openLink(href);
    });
  }

  /** Puts the cursor in the title box, with the text selected (used after "add node"). */
  focusTitle(): void {
    const input = this.root.querySelector<HTMLInputElement>('input.title');
    input?.focus();
    input?.select();
  }

  /**
   * The description being written in the panel, when the person changed it; null
   * otherwise. The app writes it before the panel shows another item or none, and before
   * the file is left (bug hunt round 3, C36).
   */
  draft(): Draft | null {
    return this.draftOf?.() ?? null;
  }

  /**
   * A text box of the panel the person typed in and did not enter; null when none. The
   * app writes it before the file is left (bug hunt round 6, C44): closing the window
   * takes no focus away, so the box never commits on its own.
   */
  typed(): Typed | null {
    for (const box of this.boxes) {
      const t = box();
      if (t) return t;
    }
    return null;
  }

  /** Done's writes of a description under way. */
  private writes = new Set<Promise<unknown>>();

  private track(write: Promise<unknown>): void {
    this.writes.add(write);
    const end = () => { this.writes.delete(write); };
    write.then(end, end);
  }

  /** Whether a description Done wrote is still being written. */
  writing(): boolean {
    return this.writes.size > 0;
  }

  /**
   * Waits for the descriptions Done is writing; true when there were any. The app waits
   * before the file is left, so a Done pressed as it is left is in the file first (bug
   * hunt round 7, oC57).
   */
  async settle(): Promise<boolean> {
    if (!this.writes.size) return false;
    await Promise.allSettled([...this.writes]);
    return true;
  }

  /**
   * Opens the description of node `id` for writing again with `text`, when the panel
   * shows that node: a description that could not be written goes back into its box
   * (bug hunt round 4, C40), also when Edit was pressed again while it was being written
   * (round 5, C42). What was typed into the box since then is kept instead.
   */
  resumeDescription(id: string, text: string): void {
    if (this.key === `node:${id}`) this.resume?.(text);
  }

  /**
   * The arrow the panel shows is now arrow `to` in the file's order (one was added or
   * taken away above it): the panel stays, with what is typed in it, and its edits go to
   * the arrow's new number (bug hunt round 7, C55, oC55).
   */
  renumber(from: number, to: number): void {
    if (this.key === `edge:${from}`) this.key = `edge:${to}`;
  }

  /**
   * View mode on or off: the next `show` builds the panel again, as text or with its
   * fields. The app writes what was typed in the panel before it switches to View.
   */
  setViewing(on: boolean): void {
    if (on === this.viewing) return;
    this.viewing = on;
    this.key = '';
  }

  show(view: View | null): void {
    if (!view) {
      // The panel first: a box blurred as the panel is emptied must not commit (`textBox`).
      this.built++;
      this.key = '';
      this.editingDescription = false;
      this.draftOf = this.resume = null;
      this.boxes = [];
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    // The panel is built again only for another item: a change on disk (a group renamed,
    // say) updates it in place, so a description being written is kept (bug hunt C17).
    const key = `${view.kind}:${view.kind === 'edge' ? view.index : view.id}`;
    if (key !== this.key) {
      this.built++;
      this.key = key;
      this.editingDescription = false;
      this.draftOf = this.resume = null;
      this.sync = [];
      this.boxes = [];
      this.root.hidden = false;
      this.root.replaceChildren(...this.build(view));
    }
    for (const fn of this.sync) fn(view);
  }

  private header(kindLabel: string, idText: string): HTMLElement {
    return h('div', { class: 'side-head' },
      h('span', { class: 'kind' }, kindLabel),
      h('code', { class: 'id', title: 'The id used in the file' }, idText),
      h('button', { class: 'ghost close', title: 'Close (Esc)', 'aria-label': 'Close', click: () => this.actions.close() }, '×'));
  }

  /**
   * A text box that commits on Enter or when focus leaves, and reverts on Esc. It commits
   * only a change the person made: a box left as it was never puts back a value that a
   * change on disk replaced meanwhile, and while untouched it follows the file (bug hunt
   * C26). A box being typed in keeps what is typed. It commits only while the panel still
   * shows its item: Chromium blurs a box as the panel is emptied for another item or for
   * none, and an arrow's index may by then be another arrow's (bug hunt round 3, C33).
   * What is typed and not entered is offered to the app as `typed()` (`what` names it in
   * a question), since closing the window takes no focus away (round 6, C44).
   * A box counts as written only once its edit is in the file: until then, while it is
   * checked or after it was refused, the box keeps its text and `typed()` offers it, so
   * closing writes it or asks, and the browser asks before the page goes (round 7, C56,
   * oC58, oC56, E22). A write of the same text already under way is waited for, not
   * made twice.
   */
  private textBox(cls: string, placeholder: string, what: string, read: (v: View) => string, commit: (value: string) => Promise<boolean>): HTMLInputElement {
    const built = this.built;
    let shown = '';
    let start = ''; // the value the box held before the person changed it, or last written
    let writing: { text: string; done: Promise<boolean> } | null = null;
    const write = (text: string): Promise<boolean> => {
      if (writing?.text === text) return writing.done;
      const now = {
        text,
        done: commit(text).then((ok) => {
          if (writing === now) writing = null;
          if (ok && input.value === text) start = text;
          return ok;
        }),
      };
      writing = now;
      return now.done;
    };
    const input = h('input', {
      class: cls, type: 'text', placeholder, spellcheck: 'false',
      keydown: (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter') input.blur();
        if (k === 'Escape') { input.value = start = shown; input.blur(); e.stopPropagation(); }
      },
      blur: () => {
        if (this.built !== built) return; // the panel is going: its item is gone or changed
        if (input.value !== start) void write(input.value);
        else input.value = shown;
      },
    });
    this.boxes.push(() => {
      if (this.built !== built || input.value === start) return null;
      const text = input.value;
      return { what, text, write: () => write(text) };
    });
    this.sync.push((v) => {
      shown = read(v);
      if (input.value === shown) { start = shown; return; }
      // Typed and not in the file: being typed in, being written, or refused.
      if (input.value !== start) return;
      const all = input.selectionStart === 0 && input.selectionEnd === input.value.length;
      input.value = start = shown;
      if (all && document.activeElement === input) input.select(); // as focusTitle left it
    });
    return input;
  }

  /** A list whose options can change with the file (the groups); they are put in again only when they do. */
  private select(options: (v: View) => HTMLOptionElement[], read: (v: View) => string, commit: (value: string) => void): HTMLSelectElement {
    const sel = h('select', { change: () => commit(sel.value) });
    let listed: string | null = null;
    this.sync.push((v) => {
      const value = read(v);
      const opts = options(v);
      if (!opts.some((o) => o.value === value)) opts.push(option(value, value));
      const key = JSON.stringify(opts.map((o) => [o.value, o.textContent]));
      if (key !== listed) {
        listed = key;
        sel.replaceChildren(...opts);
      }
      sel.value = value;
    });
    return sel;
  }

  /** A node or group is matched by its swatch's fill; an arrow, by its line, the swatch's border colour. */
  private swatches(read: (v: View) => string, commit: (s: Swatch | null) => void, by: 'fill' | 'stroke' = 'fill'): HTMLElement {
    const none = h('button', { class: 'swatch none', title: 'No colour', 'aria-label': 'No colour', click: () => commit(null) });
    const buttons = SWATCHES.map((s) => {
      const b = h('button', { class: 'swatch', title: s.name, 'aria-label': s.name, click: () => commit(s) });
      b.style.background = s.fill;
      b.style.borderColor = s.stroke;
      return b;
    });
    this.sync.push((v) => {
      const value = read(v).toLowerCase();
      none.classList.toggle('on', value === '');
      buttons.forEach((b, i) => b.classList.toggle('on', SWATCHES[i][by] === value));
    });
    return h('div', { class: 'swatches' }, none, ...buttons);
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    return h('label', { class: 'row' }, h('span', {}, label), control);
  }

  private build(view: View): HTMLElement[] {
    if (this.viewing) return this.buildRead(view);
    if (view.kind === 'node') return this.buildNode(view);
    if (view.kind === 'edge') return this.buildEdge(view);
    return this.buildSub(view);
  }

  private buildNode(view: NodeView): HTMLElement[] {
    const { id } = view;
    const a = this.actions;
    const title = this.textBox('title', 'Title', 'title', (v) => (v as NodeView).title, (value) => a.setTitle(id, value));

    const body = h('div', { class: 'desc-body' });
    const area = h('textarea', {
      class: 'desc-edit', placeholder: 'Describe this step. Markdown works: **bold**, lists, `code`, links.', spellcheck: 'true',
      keydown: (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) { e.preventDefault(); finish(true); }
        if (ke.key === 'Escape') { e.stopPropagation(); finish(false); }
      },
    });
    const editBtn = h('button', { class: 'ghost', click: () => begin() }, 'Edit');
    const doneBtn = h('button', { class: 'primary', title: 'Ctrl+Enter', click: () => finish(true) }, 'Done');
    const cancelBtn = h('button', { class: 'ghost', title: 'Esc', click: () => finish(false) }, 'Cancel');
    let current = '';
    let started = ''; // the description as Edit showed it, or as the file has it since, while untouched
    let pending: string | null = null; // what Done is writing, until that write has ended (C42)
    let latest: string | null = null; // what the last Done pressed wrote or is writing
    const paint = () => {
      const editing = this.editingDescription;
      body.hidden = editing;
      area.hidden = !editing;
      editBtn.hidden = editing;
      doneBtn.hidden = cancelBtn.hidden = !editing;
      if (editing) return;
      if (current.trim()) body.innerHTML = renderMarkdown(current);
      else body.replaceChildren(h('p', { class: 'empty' }, 'No description yet. Double-click here to write one.'));
    };
    const begin = () => {
      this.editingDescription = true;
      // Edit pressed again while Done's write is checked shows what Done is writing, not
      // the description it replaces (bug hunt round 5, C42).
      area.value = started = pending ?? current;
      paint();
      area.focus();
    };
    const finish = (save: boolean) => {
      this.editingDescription = false;
      // Only a change the person made is saved: Done on an untouched description never
      // puts back a text that a change on disk replaced meanwhile (bug hunt C26).
      if (save && area.value !== started) {
        const text = area.value;
        pending = latest = text;
        this.track(Promise.resolve(a.setDescription(id, text)).finally(() => { if (pending === text) pending = null; }));
      }
      paint();
    };
    body.addEventListener('dblclick', begin);
    this.draftOf = () => {
      if (!this.editingDescription || area.value === started) return null;
      const text = area.value;
      return { id, text, written: () => { if (area.value === text) started = text; } };
    };
    this.resume = (text) => {
      // A Done pressed since, with other text: that text stands, written or coming back
      // on its own, and the older one never returns over it (bug hunt round 6, oC46, C45).
      if (latest !== null && text !== latest) return;
      // Typed into since Edit was pressed again: that typing began from `text` (`begin`),
      // so it stays (C42).
      const typed = this.editingDescription && area.value !== started;
      if (!this.editingDescription) begin();
      if (!typed) area.value = text;
      started = current; // what the file holds: the box is not written yet
    };
    this.sync.push((v) => {
      current = (v as NodeView).description;
      // An untouched description being edited follows the file; one being typed in keeps what is typed.
      if (this.editingDescription && area.value === started && current !== started) area.value = started = current;
      paint();
    });

    const shape = this.select(
      () => PICKABLE_SHAPES.map((t) => option(t, SHAPES.find((s) => s.type === t)!.label)),
      (v) => (v as NodeView).shape, (value) => a.setShape(id, value));
    const group = this.select(
      (v) => [option('', 'None'), ...(v as NodeView).groups.map((g) => option(g.id, g.title)), option(NEW_GROUP, 'New group…')],
      (v) => (v as NodeView).group, (value) => a.setGroup(id, value));

    return [
      this.header('Node', id),
      title,
      h('div', { class: 'desc' },
        h('div', { class: 'desc-head' }, h('span', {}, 'Description'), editBtn, cancelBtn, doneBtn),
        body, area),
      h('div', { class: 'props' },
        this.row('Shape', shape),
        this.row('Colour', this.swatches((v) => (v as NodeView).fill, (s) => a.setFill(id, s))),
        this.row('Group', group)),
      h('div', { class: 'side-foot' },
        h('span', { class: 'hint' }, 'Drag the dot beside the node onto another node to connect them.'),
        h('button', { class: 'danger', click: () => a.deleteNode(id) }, 'Delete node')),
    ];
  }

  private buildEdge(view: EdgeView): HTMLElement[] {
    let { index } = view; // the arrow's number, followed when it changes (`renumber`)
    const a = this.actions;
    const head = this.header('Arrow', `#${index}`);
    const ends = h('div', { class: 'ends' });
    this.sync.push((v) => {
      const e = v as EdgeView;
      index = e.index;
      head.querySelector('code')!.textContent = `#${index}`;
      ends.replaceChildren(h('span', {}, e.from), h('span', { class: 'arrow' }, '→'), h('span', {}, e.to));
    });
    const choices = (v: View) => (v as EdgeView).ends.map((e) => option(e.id, e.title));
    const from = this.select(choices, (v) => (v as EdgeView).fromId, (id) => a.setEdgeEnd(index, 'start', id));
    const to = this.select(choices, (v) => (v as EdgeView).toId, (id) => a.setEdgeEnd(index, 'end', id));
    const label = this.textBox('title', 'Label (optional)', 'label', (v) => (v as EdgeView).label, (value) => a.setEdgeLabel(index, value));
    const stroke = this.select(
      () => [option('normal', 'Solid'), option('dotted', 'Dotted'), option('thick', 'Thick'), option('invisible', 'Invisible')],
      (v) => (v as EdgeView).stroke, (value) => a.setEdgeStroke(index, value as LinkParts['stroke']));
    const arrow = this.select(
      () => [option('arrow', 'Arrow'), option('none', 'No head'), option('both', 'Both ways'), option('circle', 'Circle'), option('cross', 'Cross')],
      (v) => (v as EdgeView).arrow, (value) => a.setEdgeArrow(index, value as ArrowKind));
    return [
      head,
      ends,
      label,
      h('div', { class: 'props' }, this.row('From', from), this.row('To', to), this.row('Line', stroke), this.row('Head', arrow),
        this.row('Colour', this.swatches((v) => (v as EdgeView).colour, (s) => a.setEdgeColour(index, s), 'stroke'))),
      h('div', { class: 'side-foot' }, h('button', { class: 'danger', click: () => a.deleteEdge(index) }, 'Delete arrow')),
    ];
  }

  private buildSub(view: SubView): HTMLElement[] {
    const { id } = view;
    const a = this.actions;
    const title = this.textBox('title', 'Group title', 'group title', (v) => (v as SubView).title, (value) => a.renameGroup(id, value));
    const dir = this.select(
      () => [option('', 'Same as chart'), option('TB', 'Top to bottom'), option('LR', 'Left to right'), option('BT', 'Bottom to top'), option('RL', 'Right to left')],
      (v) => (v as SubView).dir, (value) => a.setGroupDirection(id, value));
    const count = h('p', { class: 'hint' });
    this.sync.push((v) => {
      const n = (v as SubView).count;
      count.textContent = n === 1 ? '1 item inside.' : `${n} items inside.`;
    });
    return [
      this.header('Group', id),
      title,
      count,
      h('div', { class: 'props' },
        this.row('Direction', dir),
        this.row('Colour', this.swatches((v) => (v as SubView).fill, (s) => a.setFill(id, s)))),
      h('div', { class: 'side-foot' },
        h('button', { click: () => a.addNodeIn(id) }, 'Add node inside'),
        h('button', { class: 'danger', title: 'Removes the frame; the nodes stay', click: () => a.ungroup(id) }, 'Ungroup')),
    ];
  }

  /**
   * The panel in View mode: a node's title and description, an arrow's ends and label, a
   * group's title and size, as text that follows the file. No field or button changes the
   * flowchart; links in a description still open.
   */
  private buildRead(view: View): HTMLElement[] {
    const title = h('h2', { class: 'read-title' });
    if (view.kind === 'node') {
      const body = h('div', { class: 'desc-body' });
      let shown: string | null = null;
      this.sync.push((v) => {
        const n = v as NodeView;
        title.textContent = n.title || n.id;
        if (n.description === shown) return; // a selection being read stays
        shown = n.description;
        if (shown.trim()) body.innerHTML = renderMarkdown(shown);
        else body.replaceChildren(h('p', { class: 'empty' }, 'No description.'));
      });
      return [
        this.header('Node', view.id),
        title,
        h('div', { class: 'desc' }, h('div', { class: 'desc-head' }, h('span', {}, 'Description')), body),
      ];
    }
    if (view.kind === 'edge') {
      const head = this.header('Arrow', `#${view.index}`);
      const ends = h('div', { class: 'ends' });
      this.sync.push((v) => {
        const e = v as EdgeView;
        head.querySelector('code')!.textContent = `#${e.index}`;
        ends.replaceChildren(h('span', {}, e.from), h('span', { class: 'arrow' }, '→'), h('span', {}, e.to));
        title.textContent = e.label;
        title.hidden = !e.label;
      });
      return [head, ends, title];
    }
    const count = h('p', { class: 'hint' });
    this.sync.push((v) => {
      const g = v as SubView;
      title.textContent = g.title || g.id;
      count.textContent = g.count === 1 ? '1 item inside.' : `${g.count} items inside.`;
    });
    return [this.header('Group', view.id), title, count];
  }
}
