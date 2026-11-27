// The sidebar: opens when a node, arrow or group is clicked. For a node it shows the
// title with the full description underneath; both can be edited there, except in View
// mode, where the panel shows them as text. With nothing selected and About on, it shows
// the flowchart's description (T1.13), so closing an item leaves the sidebar open.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { SHAPES } from './core/scan';
import { FLOWCHART_ID } from './core/descriptions';
import type { ArrowKind, LinkParts } from './core/edits';
import { ICONS } from './icons';
import type { ClassPaint } from './semantics';

export interface NodeView {
  kind: 'node'; id: string; title: string; description: string; shape: string;
  fill: string; group: string; groups: { id: string; title: string }[];
  /** The colour the node's classes give it, shown in the Colour row's first swatch; null for none. */
  classPaint?: ClassPaint | null;
  /** The classes the node is in, and those the file defines, for the Class row (T1.26). */
  classes?: string[]; classList?: ClassInfo[];
}
export interface EdgeView {
  kind: 'edge'; index: number; from: string; to: string; label: string;
  stroke: LinkParts['stroke']; arrow: ArrowKind;
  /** The arrow's own colour (`stroke` in its `linkStyle` line), as written; '' for none. */
  colour: string;
  fromId: string; toId: string; ends: { id: string; title: string }[];
}
export interface SubView {
  kind: 'sub'; id: string; title: string; dir: string; fill: string; count: number;
  /** As a node's. */
  classPaint?: ClassPaint | null;
  classes?: string[]; classList?: ClassInfo[];
}
/**
 * The flowchart's description, under any item (T1.13): `file` is the file's path, so
 * another file gets a panel of its own; `name` is the front matter's title, else the
 * file's name.
 */
export interface AboutView { kind: 'about'; file: string; name: string; description: string; classList?: ClassInfo[] }
/**
 * A class the file defines (`classDef`; T1.26): its name, its colour, how many nodes and
 * groups are in it, its shape (Q267; null for any shape) and its border (Q274).
 */
export interface ClassInfo { name: string; fill: string; stroke: string; nodes: number; groups: number; shape: string | null; border: ClassBorder }
/**
 * A class's border (Q274): as the window writes it, or the nearest of these to what the
 * file writes. Thick is `stroke-width:2px`, dashed `stroke-dasharray:5 3`.
 */
export type ClassBorder = 'normal' | 'thick' | 'dashed' | 'thickdashed';
export const CLASS_BORDERS: { value: ClassBorder; label: string }[] = [
  { value: 'normal', label: 'Normal' }, { value: 'thick', label: 'Thick' },
  { value: 'dashed', label: 'Dashed' }, { value: 'thickdashed', label: 'Thick dashed' },
];
/** How a new class looks (Q267, Q274): its colour, its border, and its shape, or null for any shape. */
export interface ClassLook { swatch: Swatch; border: ClassBorder; shape: string | null }
export type View = NodeView | EdgeView | SubView | AboutView;

/**
 * The edits of the panel's text boxes resolve true when the change is in the file, so a
 * box written as Naiad closes knows whether it was (bug hunt round 6, C44).
 */
export interface SidebarActions {
  close(): void;
  /** The × of the flowchart's description: turns About off. */
  hideAbout(): void;
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
  /** Puts a node or group in one class, or (null) in none (T1.26). */
  setClass(id: string, cls: string | null): void;
  /** Makes a class that looks as `look` says, with `node` in it when given; true once it is in the file. */
  addClass(name: string, look: ClassLook, node: string | null): Promise<boolean>;
  setClassColour(name: string, swatch: Swatch): void;
  setClassBorder(name: string, border: ClassBorder): void;
  /** Sets a class's shape, or (null) any shape; the class's nodes take it (Q271). */
  setClassShape(name: string, shape: string | null): void;
  /** Renames a class everywhere the file names it (Q276); true once it is in the file. */
  renameClass(name: string, next: string): Promise<boolean>;
  /** Deletes a class; its nodes stay, without its colour. */
  deleteClass(name: string): void;
  /** Why a new class cannot be called `name`, or null when it can. */
  classNameProblem(name: string): string | null;
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
/**
 * A description being written: its node's id (`FLOWCHART_ID` for the flowchart's), its
 * text, and what the app calls once the text is in the file.
 */
export interface Draft { id: string; text: string; written(): void }

/**
 * A title, an arrow's label or a group's title typed in the panel and not yet entered:
 * what it is ("title", "label", "group title"), and its writing, which resolves true once
 * it is in the file (bug hunt round 6, C44).
 */
export interface Typed { what: string; text: string; write(): Promise<boolean> }

export const NEW_GROUP = '\u0000new';
const NEW_CLASS = '\u0000new-class';

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

/** One of the window's icons (`icons.ts`), as an element: a list's arrow, Delete's bin (T4.9). */
function iconEl(name: keyof typeof ICONS): Element {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  return t.content.firstElementChild!;
}

function option(value: string, label: string): HTMLOptionElement {
  return h('option', { value }, label);
}

/** A list with fixed options, set by its owner (a class's menu, the New class form). */
function pickList(options: [string, string][], commit: (value: string) => void = () => {}): HTMLSelectElement {
  const sel = h('select', { change: () => commit(sel.value) }, ...options.map(([v, l]) => option(v, l)));
  return sel;
}

const shapeLabel = (type: string) => SHAPES.find((s) => s.type === type)?.label ?? type;
/** A class's Shape list: Any shape first (Q275), then the shapes a node's Shape row offers. */
const classShapeOptions = (): [string, string][] => [['', 'Any shape'], ...PICKABLE_SHAPES.map((t): [string, string] => [t, shapeLabel(t)])];

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
/** Each shape's outline in a 24 by 18 box, for a class's picture (Q275); '' is any shape. */
const PICTURE: Record<string, [string, Record<string, string>][]> = {
  '': [['rect', { x: '2', y: '3', width: '20', height: '12', rx: '3' }]],
  square: [['rect', { x: '2', y: '3', width: '20', height: '12' }]],
  round: [['rect', { x: '2', y: '3', width: '20', height: '12', rx: '3' }]],
  stadium: [['rect', { x: '2', y: '3', width: '20', height: '12', rx: '6' }]],
  subroutine: [['rect', { x: '2', y: '3', width: '20', height: '12' }], ['path', { d: 'M5 3v12M19 3v12' }]],
  cylinder: [['path', { d: 'M4 5a8 2.5 0 0 1 16 0v8a8 2.5 0 0 1-16 0z' }], ['path', { d: 'M4 5a8 2.5 0 0 0 16 0' }]],
  circle: [['circle', { cx: '12', cy: '9', r: '7' }]],
  doublecircle: [['circle', { cx: '12', cy: '9', r: '7.5' }], ['circle', { cx: '12', cy: '9', r: '5' }]],
  lean_right: [['polygon', { points: '6,3 22,3 18,15 2,15' }]],
  lean_left: [['polygon', { points: '2,3 18,3 22,15 6,15' }]],
  trapezoid: [['polygon', { points: '6,3 18,3 22,15 2,15' }]],
  inv_trapezoid: [['polygon', { points: '2,3 22,3 18,15 6,15' }]],
  hexagon: [['polygon', { points: '6,3 18,3 22,9 18,15 6,15 2,9' }]],
  diamond: [['polygon', { points: '12,1 22,9 12,17 2,9' }]],
  odd: [['polygon', { points: '2,3 22,3 22,15 2,15 7,9' }]],
};
/** Draws a class's picture into `holder`: its shape in its colour and border (Q275). */
function drawPicture(holder: HTMLElement, c: ClassInfo): void {
  const thick = c.border === 'thick' || c.border === 'thickdashed';
  const dashed = c.border === 'dashed' || c.border === 'thickdashed';
  const paint: Record<string, string> = {
    fill: c.fill || 'none', stroke: c.stroke || 'currentColor', 'stroke-width': thick ? '2.4' : '1.3', 'stroke-linejoin': 'round',
  };
  if (dashed) paint['stroke-dasharray'] = '3 2';
  const box = svg('svg', { viewBox: '0 0 24 18', width: '24', height: '18' });
  for (const [tag, attrs] of PICTURE[c.shape ?? ''] ?? PICTURE['']) box.append(svg(tag, { ...attrs, ...paint }));
  holder.dataset.shape = c.shape ?? '';
  holder.dataset.border = c.border;
  holder.replaceChildren(box);
}

/** One class's line in the About panel's Classes, kept while the file changes (Q275). */
interface ClassItem { el: HTMLElement; update(c: ClassInfo): void; closeMenu(): void }

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
    const input = this.root.querySelector<HTMLTextAreaElement>('textarea.title');
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
    if (id === FLOWCHART_ID ? this.key.startsWith('about:') : this.key === `node:${id}`) this.resume?.(text);
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
    const key = `${view.kind}:${view.kind === 'edge' ? view.index : view.kind === 'about' ? view.file : view.id}`;
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
      h('code', { class: 'id', title: `The id used in the file: ${idText}` }, idText),
      h('button', { class: 'ghost close', title: 'Close (Esc)', 'aria-label': 'Close', click: () => this.actions.close() }, '×'));
  }

  /** The head of the flowchart's description: its × turns About off. */
  private aboutHeader(): HTMLElement {
    return h('div', { class: 'side-head' },
      h('span', { class: 'kind' }, 'About this flowchart'),
      h('button', {
        class: 'ghost close', title: "Hide the flowchart's description (About)", 'aria-label': "Hide the flowchart's description",
        click: () => this.actions.hideAbout(),
      }, '×'));
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
  /**
   * A title, an arrow's label or a group's title: a text area one line high that grows
   * as its text wraps (CSS `field-sizing: content`), so a long title shows whole while
   * it is edited (the user, 2026-11-17). It is still one line in the file: Enter enters
   * it, and a line break typed or pasted becomes a space.
   */
  private textBox(cls: string, placeholder: string, what: string, read: (v: View) => string, commit: (value: string) => Promise<boolean>): HTMLTextAreaElement {
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
    const input = h('textarea', {
      class: cls, rows: '1', placeholder, spellcheck: 'false',
      keydown: (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter') { e.preventDefault(); input.blur(); }
        if (k === 'Escape') { input.value = start = shown; input.blur(); e.stopPropagation(); }
      },
      input: () => {
        if (!/[\r\n]/.test(input.value)) return;
        const at = input.selectionStart;
        input.value = input.value.replace(/\r\n|[\r\n]/g, ' ');
        input.setSelectionRange(at, at);
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
      // A long title is cut off in the box: pointing at it shows the whole (the user, 2026-11-26).
      sel.title = sel.selectedOptions[0]?.textContent ?? '';
    });
    return sel;
  }

  /**
   * A node or group is matched by its swatch's fill; an arrow, by its line, the swatch's
   * border colour. The first swatch takes the item's own colour off: it is **No colour**,
   * or, when the item's classes colour it (`paint`), that colour, named by the class
   * (T1.6, Q259).
   */
  private swatches(read: (v: View) => string, commit: (s: Swatch | null) => void, by: 'fill' | 'stroke' = 'fill',
    paint: (v: View) => ClassPaint | null | undefined = () => null): HTMLElement {
    const none = h('button', { class: 'swatch none', title: 'No colour', 'aria-label': 'No colour', click: () => commit(null) });
    const buttons = SWATCHES.map((s) => {
      const b = h('button', { class: 'swatch', title: s.name, 'aria-label': s.name, click: () => commit(s) });
      b.style.background = s.fill;
      b.style.borderColor = s.stroke;
      b.style.color = s.stroke;
      return b;
    });
    this.sync.push((v) => {
      const value = read(v).toLowerCase();
      const p = paint(v);
      const name = p ? `${p.name}, from its class` : 'No colour';
      none.title = name;
      none.setAttribute('aria-label', name);
      none.classList.toggle('from-class', !!p);
      none.style.background = p ? p.fill || 'transparent' : '';
      none.style.borderColor = p?.stroke ?? '';
      none.style.color = p?.stroke ?? '';
      none.classList.toggle('on', value === '');
      buttons.forEach((b, i) => b.classList.toggle('on', SWATCHES[i][by] === value));
    });
    return h('div', { class: 'swatches' }, none, ...buttons);
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    // A list shows its own arrow (T4.9), drawn over the end of the box.
    if (control instanceof HTMLSelectElement) {
      return h('label', { class: 'row' }, h('span', { class: 'row-label' }, label), h('span', { class: 'select-wrap' }, control, iconEl('chevron')));
    }
    // Swatches sit in a div: a label passes a click on its text to its first button.
    return h('div', { class: 'row' }, h('span', { class: 'row-label' }, label), control);
  }

  private build(view: View): HTMLElement[] {
    if (this.viewing) return this.buildRead(view);
    if (view.kind === 'node') return this.buildNode(view);
    if (view.kind === 'edge') return this.buildEdge(view);
    if (view.kind === 'about') return this.buildAbout();
    return this.buildSub(view);
  }

  /** The flowchart's name, read only (it is the front matter's title or the file's name). */
  private aboutName(): HTMLElement {
    const name = h('h2', { class: 'read-title' });
    this.sync.push((v) => { name.textContent = (v as AboutView).name; });
    return name;
  }

  private buildAbout(): HTMLElement[] {
    return [
      this.aboutHeader(),
      this.aboutName(),
      this.description(FLOWCHART_ID, (v) => (v as AboutView).description,
        'Describe the whole flowchart: what it shows and how to read it. Markdown works: **bold**, lists, `code`, links.'),
      this.classesSection(),
    ];
  }

  /**
   * The form that makes a class (T1.26): a name, a colour, a border (Q274) and a shape
   * (Q267, Any shape first), then Create and Cancel. Create writes the class, with
   * `create`; a name that cannot be used says why.
   */
  private newClassForm(create: (name: string, look: ClassLook) => Promise<boolean>, closed: () => void): { el: HTMLElement; open(): void; isOpen(): boolean } {
    let picked = SWATCHES[0];
    const name = h('input', {
      class: 'new-class-name', type: 'text', placeholder: 'Name, such as review', spellcheck: 'false', 'aria-label': "The new class's name",
      keydown: (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter') { e.preventDefault(); void done(); }
        if (k === 'Escape') { e.stopPropagation(); close(); }
      },
      input: () => { problem.textContent = ''; },
    });
    const buttons = SWATCHES.map((s) => {
      const b = h('button', { class: 'swatch', title: s.name, 'aria-label': s.name, click: () => { picked = s; mark(); } });
      b.style.background = s.fill;
      b.style.borderColor = s.stroke;
      b.style.color = s.stroke;
      return b;
    });
    const mark = () => buttons.forEach((b, i) => b.classList.toggle('on', SWATCHES[i] === picked));
    const border = pickList(CLASS_BORDERS.map((b): [string, string] => [b.value, b.label]));
    const shape = pickList(classShapeOptions());
    const problem = h('p', { class: 'hint problem', role: 'alert' });
    const el = h('div', { class: 'new-class', hidden: true },
      h('span', { class: 'new-class-head' }, 'New class'),
      name,
      this.row('Colour', h('div', { class: 'swatches' }, ...buttons)),
      this.row('Border', border),
      this.row('Shape', shape),
      problem,
      h('div', { class: 'new-class-buttons' },
        h('button', { class: 'primary', click: () => { void done(); } }, 'Create'),
        h('button', { class: 'ghost', click: () => close() }, 'Cancel')));
    const close = () => { el.hidden = true; closed(); };
    const done = async () => {
      const text = name.value.trim();
      const why = this.actions.classNameProblem(text);
      if (why) { problem.textContent = why; name.focus(); return; }
      if (await create(text, { swatch: picked, border: border.value as ClassBorder, shape: shape.value || null })) close();
    };
    return {
      el,
      open: () => {
        name.value = '';
        problem.textContent = '';
        picked = SWATCHES[0];
        border.value = 'normal';
        shape.value = '';
        mark();
        el.hidden = false;
        name.focus();
      },
      isOpen: () => !el.hidden,
    };
  }

  /** How many nodes and groups a class holds, in words. */
  private static count(c: ClassInfo): string {
    const part = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    if (!c.nodes && !c.groups) return 'Not used';
    return [c.nodes ? part(c.nodes, 'node') : '', c.groups ? part(c.groups, 'group') : ''].filter(Boolean).join(', ');
  }

  /**
   * The About panel's Classes (T1.26, Q275): one line per class, with its picture, its
   * name and how many nodes use it; a three-dot button on the line opens its menu. Under
   * the list, set apart from it, New class. Each line is kept while the file changes, so
   * an open menu or a name being typed stays.
   */
  private classesSection(): HTMLElement {
    const a = this.actions;
    const list = h('div', { class: 'class-list' });
    const empty = h('p', { class: 'hint' }, 'No classes yet. A class gives every node in it the same colour, border and shape, and names the kind of step they are.');
    const add = h('button', { class: 'add-class', click: () => { add.hidden = true; form.open(); } }, iconEl('plus'), 'New class');
    const form = this.newClassForm((name, look) => a.addClass(name, look, null), () => { add.hidden = false; });
    const items = new Map<string, ClassItem>();
    let open: ClassItem | null = null; // the line whose menu is open: one at a time
    const opened = (it: ClassItem) => {
      if (open && open !== it) open.closeMenu();
      open = it;
    };
    this.sync.push((v) => {
      const classes = (v as AboutView).classList ?? [];
      empty.hidden = classes.length > 0;
      const names = new Set(classes.map((c) => c.name));
      for (const [name, it] of items) if (!names.has(name)) { it.closeMenu(); items.delete(name); }
      const els = classes.map((c) => {
        let it = items.get(c.name);
        if (!it) items.set(c.name, it = this.classItem(c.name, opened));
        it.update(c);
        return it.el;
      });
      // Put in again only when the order changed: moving a line takes the focus off it.
      if (els.length !== list.children.length || els.some((e, i) => list.children[i] !== e)) list.replaceChildren(...els);
    });
    return h('div', { class: 'classes' }, h('div', { class: 'desc-head' }, h('span', {}, 'Classes')), empty, list,
      h('div', { class: 'class-new' }, form.el, add));
  }

  /**
   * One class's line (Q275, Q276): it is highlighted when pointed at, and shows its
   * three-dot button, whose menu holds Colour, Border, Shape, Rename and Delete class.
   * Double-clicking the name, or Rename, renames it in place: Enter keeps the new name,
   * Escape or leaving the box keeps the old one.
   */
  private classItem(name: string, opened: (it: ClassItem) => void): ClassItem {
    const a = this.actions;
    const pic = h('span', { class: 'class-pic', 'aria-hidden': 'true' });
    const label = h('span', { class: 'class-name', title: 'Double-click to rename', dblclick: () => rename() }, name);
    const count = h('span', { class: 'class-count' });
    const more = h('button', {
      class: 'ghost class-more', title: `Change the class "${name}"`, 'aria-label': `Change the class ${name}`, 'aria-expanded': 'false',
      click: () => { if (menu.hidden) openMenu(); else closeMenu(); },
    }, iconEl('more'));
    const problem = h('p', { class: 'hint problem', role: 'alert' });
    const swatches = SWATCHES.map((s) => {
      const b = h('button', { class: 'swatch', title: s.name, 'aria-label': `${s.name} for the class ${name}`, click: () => a.setClassColour(name, s) });
      b.style.background = s.fill;
      b.style.borderColor = s.stroke;
      b.style.color = s.stroke;
      return b;
    });
    // A colour the file gives that is none of the six shows first, marked, so the menu
    // always shows which colour the class has (the user, 2026-11-26).
    const own = h('button', { class: 'swatch on own', hidden: true, tabindex: '-1' });
    const border = pickList(CLASS_BORDERS.map((b): [string, string] => [b.value, b.label]), (v) => a.setClassBorder(name, v as ClassBorder));
    const shape = pickList(classShapeOptions(), (v) => a.setClassShape(name, v || null));
    const menu = h('div', {
      class: 'class-menu', hidden: true,
      keydown: (e) => {
        if ((e as KeyboardEvent).key !== 'Escape') return;
        e.stopPropagation();
        closeMenu();
        more.focus();
      },
    },
      this.row('Colour', h('div', { class: 'swatches' }, own, ...swatches)),
      this.row('Border', border),
      this.row('Shape', shape),
      h('div', { class: 'class-menu-acts' },
        h('button', { class: 'ghost', click: () => { closeMenu(); rename(); } }, iconEl('rename'), 'Rename'),
        h('button', {
          class: 'ghost danger', title: 'Its nodes stay, without its colour; Undo brings it back',
          click: () => { closeMenu(); a.deleteClass(name); },
        }, iconEl('trash'), 'Delete class')));
    const el = h('div', { class: 'class-item' }, h('div', { class: 'class-line' }, pic, label, count, more), problem, menu);

    // A press outside the line and its menu closes the menu.
    const outside = (e: Event) => { if (!el.isConnected || !el.contains(e.target as Node)) closeMenu(); };
    const openMenu = () => {
      opened(item);
      menu.hidden = false;
      // The last lines' menus open below what the panel shows: scroll them into sight.
      menu.scrollIntoView?.({ block: 'nearest' });
      el.classList.add('menu-open');
      more.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
    };
    const closeMenu = () => {
      document.removeEventListener('pointerdown', outside, true);
      if (menu.hidden) return;
      menu.hidden = true;
      el.classList.remove('menu-open');
      more.setAttribute('aria-expanded', 'false');
    };

    let renaming = false;
    const rename = () => {
      if (renaming) return;
      renaming = true;
      const input = h('input', {
        class: 'class-rename', type: 'text', spellcheck: 'false', 'aria-label': `A new name for the class ${name}`,
        keydown: (e) => {
          const k = (e as KeyboardEvent).key;
          if (k === 'Enter') { e.preventDefault(); void keep(); }
          if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
        },
        input: () => { problem.textContent = ''; },
        blur: () => { if (renaming) end(); },
      });
      const end = () => {
        renaming = false;
        problem.textContent = '';
        if (input.isConnected) input.replaceWith(label);
      };
      const keep = async () => {
        const next = input.value.trim();
        if (next === name) { end(); return; }
        const why = a.classNameProblem(next);
        if (why) { problem.textContent = why; return; }
        if (await a.renameClass(name, next)) end();
      };
      input.value = name;
      label.replaceWith(input);
      input.focus();
      input.select();
    };

    const item: ClassItem = {
      el,
      closeMenu,
      update: (c) => {
        drawPicture(pic, c);
        const fill = c.fill.toLowerCase();
        const at = SWATCHES.findIndex((s) => s.fill === fill);
        const colour = at >= 0 ? SWATCHES[at].name : fill ? `its own, ${fill}` : 'none';
        pic.title = `Colour: ${colour}\nShape: ${c.shape ? shapeLabel(c.shape) : 'Any shape'}\nBorder: ${CLASS_BORDERS.find((b) => b.value === c.border)!.label}`;
        count.textContent = Sidebar.count(c);
        swatches.forEach((b, i) => b.classList.toggle('on', i === at));
        own.hidden = at >= 0 || !fill;
        own.title = `Its own colour, ${fill}`;
        own.setAttribute('aria-label', `Its own colour, ${fill}, for the class ${name}`);
        own.style.background = fill;
        own.style.borderColor = c.stroke;
        own.style.color = c.stroke;
        border.value = c.border;
        // A shape the file gives that the list does not offer is shown, as a list shows any value.
        if (c.shape && ![...shape.options].some((o) => o.value === c.shape)) shape.append(option(c.shape, shapeLabel(c.shape)));
        shape.value = c.shape ?? '';
      },
    };
    return item;
  }

  /**
   * The Class row of a node or group (T1.26): None, the file's classes and New class….
   * Shown while the file defines a class, or while one is being made here.
   */
  private classRow(id: string, read: (v: View) => NodeView | SubView): HTMLElement[] {
    const a = this.actions;
    let current = '';
    let defined = false;
    const form = this.newClassForm((name, look) => a.addClass(name, look, id), () => { sel.value = current; show(); });
    const sel = this.select(
      (v) => [option('', 'None'), ...(read(v).classList ?? []).map((c) => option(c.name, c.name)), option(NEW_CLASS, 'New class…')],
      (v) => (read(v).classes ?? []).join(', '),
      (value) => {
        if (value === NEW_CLASS) { form.open(); show(); return; }
        a.setClass(id, value || null);
      });
    const row = this.row('Class', sel);
    const show = () => { row.hidden = !defined && !form.isOpen(); };
    this.sync.push((v) => {
      current = (read(v).classes ?? []).join(', ');
      defined = (read(v).classList ?? []).length > 0;
      if (form.isOpen()) sel.value = NEW_CLASS;
      show();
    });
    return [row, form.el];
  }

  /**
   * A description shown as Markdown with Edit, written in a box with Done and Cancel: a
   * node's, or the flowchart's (`id` is `FLOWCHART_ID`). What is typed and not yet written
   * is the panel's `draft()`.
   */
  private description(id: string, read: (v: View) => string, placeholder: string): HTMLElement {
    const a = this.actions;
    const body = h('div', { class: 'desc-body' });
    const area = h('textarea', {
      class: 'desc-edit', placeholder, spellcheck: 'true',
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
      el.classList.toggle('editing', editing);
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
      current = read(v);
      // An untouched description being edited follows the file; one being typed in keeps what is typed.
      if (this.editingDescription && area.value === started && current !== started) area.value = started = current;
      paint();
    });
    // While it is edited, its head (Done, Cancel) stays at the panel's top as the panel
    // scrolls, and its box grows with the text: one scroll bar, the panel's (Q278).
    const el = h('div', { class: 'desc' },
      h('div', { class: 'desc-head' }, h('span', {}, 'Description'), editBtn, cancelBtn, doneBtn),
      body, area);
    return el;
  }

  private buildNode(view: NodeView): HTMLElement[] {
    const { id } = view;
    const a = this.actions;
    const title = this.textBox('title', 'Title', 'title', (v) => (v as NodeView).title, (value) => a.setTitle(id, value));
    const shape = this.select(
      () => PICKABLE_SHAPES.map((t) => option(t, SHAPES.find((s) => s.type === t)!.label)),
      (v) => (v as NodeView).shape, (value) => a.setShape(id, value));
    const group = this.select(
      (v) => [option('', 'None'), ...(v as NodeView).groups.map((g) => option(g.id, g.title)), option(NEW_GROUP, 'New group…')],
      (v) => (v as NodeView).group, (value) => a.setGroup(id, value));

    // Class and Group first, as what kind of step it is and where it sits; then Shape and
    // Colour, which a class can set (Q272); then the description, last, so a long one
    // moves no row (Q277).
    return [
      this.header('Node', id),
      title,
      h('div', { class: 'props' },
        ...this.classRow(id, (v) => v as NodeView),
        this.row('Group', group)),
      h('div', { class: 'props' },
        this.row('Shape', shape),
        this.row('Colour', this.swatches((v) => (v as NodeView).fill, (s) => a.setFill(id, s), 'fill', (v) => (v as NodeView).classPaint))),
      this.description(id, (v) => (v as NodeView).description, 'Describe this step. Markdown works: **bold**, lists, `code`, links.'),
      h('div', { class: 'side-foot' },
        h('span', { class: 'hint' }, 'Drag the dot beside the node onto another node to connect them.'),
        h('button', { class: 'danger', click: () => a.deleteNode(id) }, iconEl('trash'), 'Delete node')),
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
      h('div', { class: 'side-foot' }, h('button', { class: 'danger', click: () => a.deleteEdge(index) }, iconEl('trash'), 'Delete arrow')),
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
    // Class right under the title (Q272).
    return [
      this.header('Group', id),
      title,
      h('div', { class: 'props' }, ...this.classRow(id, (v) => v as SubView)),
      count,
      h('div', { class: 'props' },
        this.row('Direction', dir),
        this.row('Colour', this.swatches((v) => (v as SubView).fill, (s) => a.setFill(id, s), 'fill', (v) => (v as SubView).classPaint))),
      h('div', { class: 'side-foot' },
        h('button', { click: () => a.addNodeIn(id) }, 'Add node inside'),
        h('button', { class: 'danger', title: 'Removes the frame; the nodes stay', click: () => a.ungroup(id) }, 'Ungroup')),
    ];
  }

  /**
   * The panel in View mode: a node's title and description, an arrow's ends and label, a
   * group's title and size, the flowchart's name and description, as text that follows
   * the file. No field or button changes the flowchart; links in a description still open.
   */
  private buildRead(view: View): HTMLElement[] {
    const title = h('h2', { class: 'read-title' });
    // A node's description, or the flowchart's, as text.
    const described = (read: (v: View) => string): HTMLElement => {
      const body = h('div', { class: 'desc-body' });
      let shown: string | null = null;
      this.sync.push((v) => {
        const text = read(v);
        if (text === shown) return; // a selection being read stays
        shown = text;
        if (shown.trim()) body.innerHTML = renderMarkdown(shown);
        else body.replaceChildren(h('p', { class: 'empty' }, 'No description.'));
      });
      return h('div', { class: 'desc' }, h('div', { class: 'desc-head' }, h('span', {}, 'Description')), body);
    };
    if (view.kind === 'about') return [this.aboutHeader(), this.aboutName(), described((v) => (v as AboutView).description)];
    if (view.kind === 'node') {
      this.sync.push((v) => {
        const n = v as NodeView;
        title.textContent = n.title || n.id;
      });
      return [this.header('Node', view.id), title, described((v) => (v as NodeView).description)];
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
