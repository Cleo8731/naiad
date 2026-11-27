// A tab: one open file, kept as text (T1.16). The chart, the Syntax pane and the sidebar
// are three views of that text; every change from any of them becomes new text, which is
// drawn again and saved to the file. A change to the file on disk comes back the same way.
// The window around it (`App`, src/app.ts) holds the toolbar, the tab strip and the
// window's choices; it shows one of its tabs at a time, and the others keep theirs.

import type { Backend, MovedTab } from './backend';
import { Chart, drawForPaper, type Target } from './chart';
import { FLOWCHART_ID, getDescriptions } from './core/descriptions';
import { classNameProblem, classShapes, EditError, parseLink } from './core/edits';
import { plainText, withEndingsOf } from './core/endings';
import { itemOf, parseHighlights, resolveHighlights, toggleInFile } from './core/highlights';
import { ICONS } from './icons';
import { allRefs, FRONT_MATTER_RE, nodeLabel, parseDoc, type Doc } from './core/scan';
import { paintOf, shown, snapshot, type Snap } from './semantics';
import { NEW_GROUP, Sidebar, type ClassBorder, type ClassInfo, type Typed, type View } from './sidebar';
import { applyChecked, expectOp, type Op, type OpResult } from './verify';
import { choicesFrom, stillThere, walkView, type Step as WalkStep, type WalkAction } from './walk';

type Source = 'chart' | 'text' | 'disk' | 'history';
interface Step { text: string; disk: boolean }

/** How long the file must have been quiet after a change from outside before a save (`saveNow`). */
const SETTLE_MS = 1000;
const NODE_TEXT = '#1c2026';

/** What each of a class's borders writes (Q274): a thick one `stroke-width:2px`, a dashed one `stroke-dasharray:5 3`; null takes it out. */
function borderStyles(border: ClassBorder): Record<string, string | null> {
  return {
    'stroke-width': border === 'thick' || border === 'thickdashed' ? '2px' : null,
    'stroke-dasharray': border === 'dashed' || border === 'thickdashed' ? '5 3' : null,
  };
}

/** The border choice nearest to a class's styles: wider than 1px is thick; a dash pattern other than none or 0 is dashed. */
function borderOf(styles: string[]): ClassBorder {
  const value = (key: string) => {
    const piece = styles.filter((x) => x.slice(0, x.indexOf(':')).trim() === key).pop();
    return piece ? piece.slice(piece.indexOf(':') + 1).trim() : '';
  };
  const thick = parseFloat(value('stroke-width')) > 1;
  const dash = value('stroke-dasharray');
  const dashed = dash !== '' && dash !== 'none' && !/^0(px)?$/.test(dash);
  return thick && dashed ? 'thickdashed' : thick ? 'thick' : dashed ? 'dashed' : 'normal';
}

/**
 * One reading and drawing at a time for the whole page (T1.16): every tab's chart is
 * drawn by the page's one Mermaid, so one tab's never runs between another's steps.
 */
let drawing: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = drawing.then(job);
  drawing = run.catch(() => {});
  return run;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n');
}

/**
 * Where arrow `index` of `before` is in `now`: at the same number when its ends are the
 * same there; otherwise the arrow just like it (counted among the arrows just like it,
 * when there are as many as before); null when it cannot be told (bug hunt round 7, C55).
 */
function followEdge(before: Snap | null, now: Snap, index: number): number | null {
  const was = before?.edges[index];
  if (!was) return null;
  const here = now.edges[index];
  if (here && here.start === was.start && here.end === was.end) return index;
  const key = JSON.stringify(was);
  const alike = (s: Snap) => s.edges.flatMap((e, k) => (JSON.stringify(e) === key ? [k] : []));
  const then = alike(before!);
  const found = alike(now);
  if (found.length === then.length) return found[then.indexOf(index)];
  // One end of this arrow changed (T1.8, or Undo of it) and nothing else in the arrows:
  // the one arrow that differs from it only in that end, wherever it now is.
  if (now.edges.length !== before!.edges.length) return null;
  const others = (s: Snap, skip: number) => s.edges.flatMap((e, k) => (k === skip ? [] : [JSON.stringify(e)])).sort().join('\n');
  const rest = others(before!, index);
  const moved = now.edges.flatMap((e, k) =>
    (e.start === was.start) !== (e.end === was.end) && JSON.stringify({ ...e, start: was.start, end: was.end }) === key && others(now, k) === rest ? [k] : []);
  return moved.length === 1 ? moved[0] : null;
}

/** How a message names an item, as `snap` shows it: “Collect data”, the group “Review”, the arrow from “a” to “b”. */
function itemName(target: Target, snap: Snap | null): string {
  if (target.kind === 'node') return `“${shown(snap?.nodes[target.id]?.text ?? target.id)}”`;
  if (target.kind === 'sub') return `the group “${shown(snap?.subs[target.id]?.title || target.id)}”`;
  const e = snap?.edges[target.index];
  const end = (id: string) => shown(snap?.nodes[id]?.text ?? snap?.subs[id]?.title ?? id);
  return e ? `the arrow from “${end(e.start)}” to “${end(e.end)}”` : 'the arrow';
}

function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b || a.kind !== b.kind) return a === b;
  return a.kind === 'edge' ? a.index === (b as typeof a).index : a.id === (b as typeof a).id;
}

/** Typed text as a message quotes it: at most 120 characters. */
function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * The title in the flowchart's front matter (`title: Jobs`, quotes taken off), or '' for
 * none: the flowchart's name in the sidebar (T1.13).
 */
function frontMatterTitle(text: string): string {
  const yaml = FRONT_MATTER_RE.exec(text)?.[2] ?? '';
  const value = /^title:[^\S\n]*(.*?)\s*$/m.exec(yaml)?.[1] ?? '';
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/** A tab's own part of the page: its chart area, Syntax text area, sidebar and notices. */
export interface TabElements {
  stage: HTMLElement;
  /** The chart area's "No file open" message. */
  empty: HTMLElement;
  area: HTMLTextAreaElement;
  sidebar: HTMLElement;
  notices: HTMLElement;
}

/** What a tab uses of its window (`App`): the chart's tools, and the choices made for the whole window. */
export interface TabWindow {
  readonly backend: Backend;
  /**
   * The controls that show the shown tab's file: the saved state (unseen, for screen
   * readers), the island and the pill laid over its chart (T4.9), and what is in them.
   */
  readonly bar: {
    status: HTMLElement; dir: HTMLButtonElement; undo: HTMLButtonElement; redo: HTMLButtonElement;
    add: HTMLButtonElement; fit: HTMLButtonElement; highlight: HTMLButtonElement; clear: HTMLButtonElement;
    pill: HTMLElement; island: HTMLElement;
    /** The pill's Walk button (T6.4, Q229): shown in View mode only. */
    walk: HTMLButtonElement;
  };
  /** The direction button shows the chart's direction: TD, LR, BT or RL. */
  showDirection(dir: string): void;
  /** The Syntax pane: a notice offers to show it while it is hidden. */
  readonly pane: HTMLElement;
  /** Whether this tab is the one shown: only that one paints the chart's tools. */
  shown(): boolean;
  /** View mode (D4.3, T1.11). */
  viewing(): boolean;
  /** The About button (D1.4, T1.13). */
  about(): boolean;
  /** The window is still opening the files it starts with: a blank tab shows no message yet (Q262). */
  starting(): boolean;
  /** The Highlight switch. */
  highlighting(): boolean;
  /** Whether the notice for an edit tried in View mode shows. */
  viewNotice(): boolean;
  toast(message: string): void;
  /** An edit was tried in View mode. */
  viewBlocked(): void;
  setViewing(on: boolean): void;
  setHighlighting(on: boolean): void;
  setAbout(on: boolean): void;
  showAbout(on: boolean): void;
  showSyntax(): void;
  /** The tab is opening `path`, which could be read: the recent list and the tab's name. */
  opening(path: string): void;
  /** The tab's file is now `path`: the window's title and the record of what it shows. */
  opened(path: string): void;
}

export class Tab {
  /** The flowchart's text: the whole Mermaid file. */
  private text = '';
  /** The flowchart's text as last read from or written to disk. */
  private saved = '';
  private path: string | null = null;
  private doc: Doc = parseDoc('');
  private snap: Snap | null = null;
  private error: string | null = null;
  /** Mermaid read the text and could not draw it (`error` holds why): an Ellipse, say (T5.17). */
  private drawFailed = false;
  private selection: Target | null = null;
  /**
   * One step back (Undo) or forward (Redo): the text to put in, and whether the step
   * between it and the text shown was a change taken from disk (bug hunt C3).
   */
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private work: Promise<void> = Promise.resolve();
  private saveTimer: number | undefined;
  private textTimer: number | undefined;
  /** A change on disk displaced the person's last edit before it was saved: only Undo holds it. */
  private displaced = false;
  private stopWatch: (() => void) | null = null;
  private note = '';
  /** The highlights file's text as last read or written ('' when there is none). */
  private hlText = '';
  /** Counts this view's own changes to the highlights, so a slower read cannot undo one. */
  private hlVersion = 0;
  /** Hidden while another tab is shown (T1.16): a change is then read at once and drawn when the tab is shown. */
  private hidden = false;
  /** A drawing put off while the tab was hidden. */
  private stale = false;
  /** Closed with its ×: an open still under way stops, and watches nothing. */
  private closed = false;

  readonly chart: Chart;
  readonly sidebar: Sidebar;
  private readonly backend: Backend;
  private readonly bar: TabWindow['bar'];

  constructor(private win: TabWindow, private el: TabElements) {
    this.backend = win.backend;
    this.bar = win.bar;
    this.chart = new Chart(el.stage, {
      onSelect: (t) => this.select(t),
      onHighlight: (t) => { void this.toggleHighlight(t); },
      onConnect: (from, to) => { void this.edit({ kind: 'addEdge', from, to }); },
      onMoveEnd: (index, end, id) => { void this.moveEdgeEnd(index, end, id); },
      onAddNode: () => { void this.addNode(null); },
      onRename: (t) => { this.select(t); this.sidebar.focusTitle(); },
      onBlocked: () => win.viewBlocked(),
      onWalk: (action) => this.onWalk(action),
    });
    this.sidebar = new Sidebar(el.sidebar, {
      close: () => this.select(null),
      hideAbout: () => win.setAbout(false),
      setTitle: async (id, title) => (await this.edit({ kind: 'setTitle', id, title })) !== null,
      setDescription: (id, description) => this.writeDescription(id, description),
      setShape: (id, shape) => { void this.edit({ kind: 'setShape', id, shape }); },
      setFill: (id, s) => {
        const isNode = !!this.snap?.nodes[id];
        const changes = s ? { fill: s.fill, stroke: s.stroke, ...(isNode ? { color: NODE_TEXT } : {}) } : { fill: null, stroke: null, color: null };
        void this.edit({ kind: 'setStyle', id, changes });
      },
      setGroup: (id, group) => {
        if (group === NEW_GROUP) void this.edit({ kind: 'groupNode', id, title: 'New group' });
        else void this.edit({ kind: 'moveNode', id, target: group || null });
      },
      deleteNode: (id) => { void this.edit({ kind: 'deleteNode', id }); },
      setEdgeEnd: (index, end, id) => { void this.moveEdgeEnd(index, end, id); },
      setEdgeLabel: async (index, label) => (await this.edit({ kind: 'setEdgeLabel', index, label })) !== null,
      setEdgeStroke: (index, stroke) => { void this.edit({ kind: 'setEdgeStyle', index, stroke }); },
      setEdgeArrow: (index, arrow) => { void this.edit({ kind: 'setEdgeStyle', index, arrow }); },
      setEdgeColour: (index, s) => { void this.edit({ kind: 'setEdgeColour', index, stroke: s ? s.stroke : null }); },
      deleteEdge: (index) => { void this.edit({ kind: 'deleteEdge', index }); },
      renameGroup: async (id, title) => (await this.edit({ kind: 'renameSubgraph', id, title })) !== null,
      setGroupDirection: (id, dir) => { void this.edit({ kind: 'setSubgraphDirection', id, dir: dir || null }); },
      addNodeIn: (id) => { void this.addNode(id); },
      ungroup: (id) => { void this.edit({ kind: 'ungroup', id }); },
      openLink: (url) => this.backend.openLink(url),
      // Classes (T1.26). A class's text is dark, as a swatch's is on a node.
      setClass: (id, cls) => { void this.edit({ kind: 'setClass', id, cls }); },
      addClass: async (name, look, node) => {
        const styles: Record<string, string> = { fill: look.swatch.fill, stroke: look.swatch.stroke, color: NODE_TEXT };
        for (const [k, v] of Object.entries(borderStyles(look.border))) if (v !== null) styles[k] = v;
        return (await this.edit({ kind: 'addClass', name, styles, node, shape: look.shape })) !== null;
      },
      setClassColour: (name, s) => { void this.edit({ kind: 'setClassStyle', name, changes: { fill: s.fill, stroke: s.stroke, color: NODE_TEXT } }); },
      setClassBorder: (name, border) => { void this.edit({ kind: 'setClassStyle', name, changes: borderStyles(border) }); },
      // The class's nodes take the shape (Q271).
      setClassShape: (name, shape) => {
        const nodes = Object.entries(this.snap?.nodes ?? {}).filter(([, n]) => n.classes.includes(name)).map(([id]) => id);
        void this.edit({ kind: 'setClassShape', name, shape, nodes });
      },
      renameClass: async (name, next) => (await this.edit({ kind: 'renameClass', name, next })) !== null,
      deleteClass: (name) => { void this.edit({ kind: 'deleteClass', name }); },
      classNameProblem: (name) => classNameProblem(this.text, name),
    });
    this.bindArea();
  }

  /** The path of the tab's file, or null when it shows none. */
  get file(): string | null { return this.path; }

  /** The item selected in the chart and shown in the sidebar, or null. */
  get selected(): Target | null { return this.selection; }

  /** Whether something typed or changed is not yet on disk, for the browser's question before a page goes. */
  waiting(): boolean {
    return this.path !== null && (this.textTimer !== undefined || this.text !== this.saved || this.displaced || this.sidebar.draft() !== null || this.sidebar.typed() !== null || this.sidebar.writing() || this.describing > 0);
  }

  /** Descriptions being written after the panel left them (`writeDescription`), not yet in the text (bug hunt H6). */
  private describing = 0;

  /**
   * Before the tab closes, or Naiad does: saves what waits to be saved, then asks before
   * an edit is lost, whether it cannot be saved or a change on disk displaced it and only
   * Undo holds it (bug hunt C10). `what` names the step: "Close x.mmd". `showing` runs
   * just before Naiad asks, so the window can show this tab first (T1.16).
   */
  async leave(what: string, showing?: () => void): Promise<boolean> {
    const confirm = (message: string) => { showing?.(); return this.backend.confirm(message); };
    // Text typed into the description while it or the file was written is written too
    // (bug hunt round 4, C41), unless the person let the description go; so is a title,
    // a label or a group's title typed in the sidebar and not entered (round 6, C44).
    // Typed in the text pane while the save read or wrote the file: saved again, up to
    // five times, or asked about below, never left out (round 5, C43). Each save is
    // followed by a look at the sidebar, so what was typed there during it is written
    // too (round 6, oC53).
    let letGoDraft = false;
    let letGoBox = false;
    for (let more = 0; ;) {
      if (!letGoDraft && !(await this.writeDraft())) {
        if (!(await confirm(`The description you were writing could not be saved. ${what} and lose it?`))) return false;
        letGoDraft = true;
      }
      if (!letGoBox) {
        const lost = await this.writeTyped();
        if (lost) {
          if (!(await confirm(`The ${lost} you were typing could not be saved. ${what} and lose it?`))) return false;
          letGoBox = true;
        }
      }
      await this.flushSave();
      if (await this.sidebar.settle()) continue; // a Done pressed meanwhile: written, then saved (round 7, oC57)
      if (!letGoDraft && this.sidebar.draft()) continue;
      if (!letGoBox && this.sidebar.typed()) continue;
      if (!this.typingWaits() || more++ >= 5) break;
    }
    if (!this.path) return true;
    if (this.text !== this.saved || this.typingWaits()) {
      return confirm(`${basename(this.path)} holds a change that is not saved${this.unsavedWhy()}. ${what} and lose it?`);
    }
    if (this.displaced) return confirm(this.displacedQuestion(what));
    return true;
  }

  /**
   * Writes the description being written in the sidebar, when the person changed it, as
   * Done would (bug hunt round 3, C36), and again while more was typed as it was written
   * (round 4, C41). False when it could not be written; it then stays in its box.
   */
  async writeDraft(): Promise<boolean> {
    for (let draft = this.sidebar.draft(); draft; draft = this.sidebar.draft()) {
      if (!(await this.edit({ kind: 'setDescription', id: draft.id, description: draft.text }))) return false;
      draft.written();
    }
    return true;
  }

  /**
   * Writes what was typed into a title, label or group title box and not entered, also
   * when more is typed as it is written (bug hunt round 6, C44). Null when all is in the
   * file; otherwise what could not be written ("title"), still in its box.
   */
  async writeTyped(): Promise<string | null> {
    for (let typed = this.sidebar.typed(); typed; typed = this.sidebar.typed()) {
      if (!(await typed.write())) return typed.what;
    }
    return null;
  }

  /**
   * Writes a description the panel has left: by Done, or as the panel turns to another
   * item or none (C36). One that cannot be written (the text pane holds an error, say) is
   * not dropped unasked: while its node is in the panel it goes back into its box; once
   * the panel has turned away, Naiad asks, and unless the person lets it go, turns back
   * to it (bug hunt round 4, C40). A node deleted meanwhile takes it along (C36's case,
   * left as a known finding).
   */
  async writeDescription(id: string, text: string): Promise<void> {
    this.describing++;
    try {
      await this.writeDescriptionNow(id, text);
    } finally {
      this.describing--;
    }
  }

  private async writeDescriptionNow(id: string, text: string): Promise<void> {
    if (await this.edit({ kind: 'setDescription', id, description: text })) return;
    // The flowchart's description (T1.13) is in the sidebar while nothing is selected and
    // About is on; turning back to it turns About on.
    const whole = id === FLOWCHART_ID;
    const here = () => (whole ? this.selection === null && this.win.about() : this.selection?.kind === 'node' && this.selection.id === id);
    const there = () => whole || !!this.snap?.nodes[id];
    if (!here()) {
      const title = whole ? 'the flowchart' : `“${nodeLabel(this.doc, id)?.title ?? id}”`;
      if (!there()) return;
      if (await this.backend.confirm(`The description you were writing for ${title} could not be saved. Lose it?`)) return;
      if (!there()) return;
      if (!here()) {
        if (whole) { this.select(null); this.win.showAbout(true); }
        else this.select({ kind: 'node', id });
      }
    }
    this.sidebar.resumeDescription(id, text);
  }

  /** The question asked before an edit that only Undo holds (`displaced`) is lost. */
  private displacedQuestion(what: string): string {
    return `Your last edit to ${basename(this.path ?? '')} was not written: the file changed on disk first. Undo brings it back until you leave this flowchart. ${what} and lose it?`;
  }

  /** Why the text shown cannot be saved, for a question: ' (…)' or ''. */
  private unsavedWhy(): string {
    if (this.error) return this.drawFailed ? ' (Mermaid cannot draw the text)' : ' (Mermaid cannot read the text)';
    return '';
  }

  // ------------------------------------------------------------------ file

  async open(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await this.backend.read(path);
    } catch (e) {
      if (!this.closed) this.win.toast(`Could not open ${basename(path)}: ${errorText(e)}`);
      return;
    }
    // Only a blank tab takes a file (T1.16, Q140), so this asks nothing; it is kept in
    // case that changes.
    if (this.closed || !(await this.leave(`Open ${basename(path)}`)) || this.closed) return;
    this.stopWatch?.();
    this.path = path;
    this.win.opening(path);
    this.displaced = false;
    this.text = this.saved = plainText(raw);
    this.undoStack = [];
    this.redoStack = [];
    this.leaveWalk();
    this.selection = null;
    this.snap = null;
    this.note = '';
    this.hlText = '';
    this.hlVersion++;
    this.el.area.value = this.text;
    // The sidebar opens before the first drawing, so the chart is fitted to the room it
    // keeps: a side panel opening later only moves the chart, never fits it again.
    this.sidebar.show(this.view());
    this.chart.resetView();
    this.win.opened(path);
    const stop = await this.backend.watch(path, () => { void this.diskChanged(); });
    if (this.closed) { stop(); return; } // closed while the watch was set up
    this.stopWatch = stop;
    await this.readHighlights();
    await this.queue(() => this.refresh(true));
  }

  /** Draws the chart again, as when the system's light or dark theme changes; a hidden tab when it is shown. */
  redraw(): Promise<void> {
    return this.queue(() => this.refresh(true));
  }

  /** Another tab is shown (T1.16): this one keeps everything as it is, and draws nothing until shown again. */
  hide(): void {
    this.hidden = true;
  }

  /** The tab is shown: the chart's tools and the notices show its file, and what changed while it was hidden is drawn. */
  show(): void {
    this.hidden = false;
    if (this.stale) void this.queue(() => this.refresh(true));
    this.paint();
    void this.readHighlights();
  }

  /** What moves with this tab into another window (T6.2), after `leave` has saved it. */
  moved(): MovedTab {
    return {
      file: this.path,
      text: this.text,
      undo: [...this.undoStack],
      redo: [...this.redoStack],
      selection: this.selection,
      view: this.chart.placement(),
    };
  }

  /**
   * A blank tab takes over a tab moved from another window (T6.2): it opens the file,
   * then, if the file still holds the text the tab left, takes its Undo and Redo and its
   * selection, if the item is still there. A file changed meanwhile opens as it is now,
   * with no Undo, as any file opened. The view the person moved comes too.
   */
  async takeOver(m: MovedTab): Promise<void> {
    if (m.file === null) return;
    await this.open(m.file);
    if (this.closed || this.path !== m.file) return;
    const steps = (list: unknown): Step[] => (Array.isArray(list) ? list : [])
      .filter((s): s is Step => typeof s?.text === 'string' && typeof s?.disk === 'boolean')
      .map((s) => ({ text: s.text, disk: s.disk }));
    if (this.text === plainText(m.text)) {
      this.undoStack = steps(m.undo).slice(-300);
      this.redoStack = steps(m.redo);
      const s = m.selection;
      const snap = this.snap;
      const there = !!s && !!snap && (
        (s.kind === 'node' && s.id in snap.nodes)
        || (s.kind === 'sub' && s.id in snap.subs)
        || (s.kind === 'edge' && Number.isInteger(s.index) && s.index >= 0 && s.index < snap.edges.length));
      if (there) this.select(s);
    }
    if (m.view) this.chart.setPlacement(m.view);
    this.paint();
  }

  /** The tab is closed, after `leave`: it stops watching its file, and its chart goes. */
  close(): void {
    this.closed = true;
    this.hidden = true;
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.textTimer);
    this.stopWatch?.();
    this.stopWatch = null;
    this.chart.destroy();
  }

  // ------------------------------------------------------------------ highlights

  /** Reads the highlights file and draws what changed. Quiet when it cannot be read. */
  async readHighlights(): Promise<void> {
    const path = this.path;
    if (!path || document.hidden || this.hlBusy) return;
    const version = this.hlVersion;
    let text: string;
    try {
      text = (await this.backend.readHighlights(path)) ?? '';
    } catch {
      return;
    }
    // A change made in this view meanwhile wins over what was read before it.
    if (path !== this.path || version !== this.hlVersion || this.hlBusy || text === this.hlText) return;
    this.hlText = text;
    this.paintHighlights();
  }

  /** This view's changes to the highlights, one after another. */
  private hlWork: Promise<void> = Promise.resolve();
  private hlBusy = 0;
  private hlQueue(path: string, job: () => Promise<void>): Promise<void> {
    this.hlBusy++;
    this.hlVersion++;
    this.hlWork = this.hlWork
      // A change not started when the tab closed is dropped with it (bug hunt H5).
      .then(() => (path === this.path && !this.closed ? job() : undefined))
      .catch((e) => {
        // Show what is on disk again: the read that follows draws it.
        this.win.toast(`Could not save the highlights: ${errorText(e)}`);
        this.hlText = '';
        this.paintHighlights();
      })
      .finally(() => { this.hlBusy--; this.hlVersion++; if (!this.hlBusy) void this.readHighlights(); });
    return this.hlWork;
  }

  /** Resolves when the highlight writes under way are done, failed ones too (the window's `drop`). */
  highlightsWritten(): Promise<void> {
    return this.hlWork;
  }

  /** Highlights an item, or takes its highlight off, in the file as it is on disk now. */
  private toggleHighlight(target: Target): Promise<void> {
    const path = this.path;
    const item = this.snap ? itemOf(target, this.snap) : null;
    if (!path || !item) return Promise.resolve();
    // A highlights file that cannot be read is left as it is; the queue shows the error.
    return this.hlQueue(path, () => toggleInFile(
      () => this.backend.readHighlights(path),
      (text, read) => this.writeHighlights(path, text, read),
      item,
    ));
  }

  clearHighlights(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    return this.hlQueue(path, async () => { await this.writeHighlights(path, ''); });
  }

  /** Draws the new highlights at once, then writes them (`Backend.writeHighlights`). */
  private async writeHighlights(path: string, text: string, expected?: string): Promise<boolean> {
    this.hlText = text;
    this.paintHighlights();
    return this.backend.writeHighlights(path, text, expected);
  }

  private paintHighlights(): void {
    const items = parseHighlights(this.hlText);
    this.chart.setHighlights(this.snap ? resolveHighlights(items, this.snap) : []);
    if (!this.win.shown()) return;
    // Clear, with the count of highlights in the file (T4.9); gone during a walk, which
    // hides the highlights (the user, 2026-11-26).
    this.bar.clear.hidden = items.length === 0 || this.path === null || this.walking;
    this.bar.clear.querySelector('span')!.textContent = `Clear ${String(items.length)}`;
  }

  /** View mode (D4.3, T1.11) in the tab's own views: the chart, the sidebar and the Syntax pane. */
  showViewing(on: boolean): void {
    if (!on) this.leaveWalk(); // a walk is a way of reading: it belongs to View mode
    this.chart.setViewing(on);
    this.sidebar.setViewing(on);
    this.el.area.readOnly = on;
  }

  /**
   * Saves and reloads run one at a time, in the order asked, so that neither acts on
   * a reading of the file that the other has made old (bug hunt C8, C11).
   */
  private fileWork: Promise<void> = Promise.resolve();
  private fileQueue(job: () => Promise<void>): Promise<void> {
    this.fileWork = this.fileWork.then(job).catch((e) => { console.error(e); this.win.toast(errorText(e)); });
    return this.fileWork;
  }

  private diskChanged(): Promise<void> {
    return this.fileQueue(() => this.takeDisk());
  }

  /** Reads the file after a change on disk and shows it. Runs in the file queue. */
  private async takeDisk(): Promise<void> {
    const path = this.path;
    if (!path) return;
    await this.takeTyping(); // so that it counts as an unsaved edit below
    let raw: string;
    try {
      raw = await this.backend.read(path);
    } catch {
      if (path !== this.path) return;
      this.note = 'The file cannot be read (moved or deleted?)';
      this.paintBar();
      this.paintNotices();
      return;
    }
    // It can be read again: its notice goes.
    if (path === this.path && this.note.startsWith('The file cannot')) {
      this.note = '';
      this.paintBar();
      this.paintNotices();
    }
    // Compared and taken in as one job of the queue, so an edit is never applied over it
    // nor it over an edit half done.
    await this.queue(async () => {
      if (path !== this.path) return; // another file is shown now
      const disk = plainText(raw);
      if (disk === this.saved) return;
      this.changedOutside = Date.now();
      await this.takeTypingNow(); // typed while the file was read or this job waited (C25)
      const hadUnsaved = this.text !== this.saved;
      if (disk === this.saved) {
        // A save of ours finished while this job waited, and the disk holds it: an
        // unsaved edit made since still stands.
        if (hadUnsaved) this.scheduleSave();
        this.paint();
        return;
      }
      this.saved = disk;
      if (disk !== this.text) {
        await this.apply(disk, 'disk');
        this.note = `Reloaded from disk ${new Date().toLocaleTimeString()}`;
        if (hadUnsaved) {
          this.displaced = true;
          this.win.toast('The file changed on disk and was reloaded. Your unsaved edit was not written; Undo brings it back, in place of the change on disk.');
        }
      }
      this.paintBar();
    });
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.save(false); }, 350);
  }

  async flushSave(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    await this.save(false);
  }

  /** Writes the text to the file. A text with a syntax error is written only on Ctrl+S. */
  save(force: boolean): Promise<void> {
    return this.fileQueue(() => this.saveNow(force));
  }

  /**
   * When a change from outside was last taken in (ms). A save waits until the file has
   * been quiet that long (`SETTLE_MS`), so a program that writes the file in two steps
   * (writes and closes it, then adds the rest) finishes before Naiad writes: its whole
   * text is then taken in, never joined to a save made in between (bug hunt C19).
   */
  private changedOutside = 0;

  /** `save`, run in the file queue. */
  private async saveNow(force: boolean): Promise<void> {
    await this.takeTyping(); // and the changes queued before it
    const wait = this.changedOutside + SETTLE_MS - Date.now();
    if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
    const path = this.path;
    if (!path || this.text === this.saved) return;
    if (this.error && !force) { this.paintBar(); return; }
    const text = this.text;
    try {
      // If the file changed since it was last read, take that change in rather than overwrite it.
      const raw = await this.backend.read(path);
      if (path !== this.path) return; // another file is shown now
      if (plainText(raw) !== this.saved) { await this.takeDisk(); return; }
      // Every line keeps the line ending it has on disk now. The write is refused if the
      // file changed after it was read (bug hunt C7); that change is then taken in.
      if (!(await this.backend.write(path, withEndingsOf(raw, text), raw))) { await this.takeDisk(); return; }
      this.saved = text;
      this.note = '';
    } catch (e) {
      this.note = `Could not save: ${errorText(e)}`;
    }
    this.paintBar();
    this.paintNotices();
  }

  // ------------------------------------------------------------------ changes

  /** Runs jobs one after another, so two drawings never overlap. */
  private queue(job: () => Promise<void>): Promise<void> {
    this.work = this.work.then(job).catch((e) => { console.error(e); this.win.toast(errorText(e)); });
    return this.work;
  }

  /** The text pane's text, with its line endings made plain. */
  private typed(): string {
    return this.el.area.value.replace(/\r\n?/g, '\n');
  }

  /**
   * Takes in what was typed in the text pane and is still waiting (typing is taken in
   * 220 ms after the last key), so that a save, a reload, an edit or Undo acts on it.
   */
  private takeTyping(): Promise<void> {
    if (this.textTimer === undefined) return this.work;
    window.clearTimeout(this.textTimer);
    this.textTimer = undefined;
    return this.queue(() => this.takeTypingNow());
  }

  /**
   * Takes in, from inside a job of the queue, what the text pane holds and the text does
   * not yet: typing still waiting, or typed while this job waited its turn. A job that
   * puts in a text from elsewhere (a reload, an edit, Undo) calls it first, so what was
   * typed becomes a step of Undo and is never written over (bug hunt C25). The pane is
   * read when the job runs, not when it was queued, and read again after the typing is
   * drawn: keys pressed during that drawing are taken in too, since the job puts in its
   * own text right after (bug hunt round 3, oC1, oC2).
   */
  private async takeTypingNow(): Promise<void> {
    do {
      window.clearTimeout(this.textTimer);
      this.textTimer = undefined;
      await this.apply(this.typed(), 'text');
    } while (this.typingWaits());
  }

  /** Whether the text pane holds typing that the text does not have yet and could take in. */
  private typingWaits(): boolean {
    return this.typed() !== this.text;
  }

  /**
   * Puts in a new text. Called only from a job of the queue, so that whatever the new
   * text was made from (an edit, a reading of the file) is still the text shown.
   */
  private async apply(next: string, source: Source): Promise<void> {
    if (next === this.text) return;
    if (source !== 'disk') this.displaced = false; // the person has acted since: their own change is now the last
    if (source !== 'history') {
      this.undoStack.push({ text: this.text, disk: source === 'disk' });
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack = [];
    }
    this.text = next;
    if (source !== 'text') {
      const { scrollTop, scrollLeft } = this.el.area;
      this.el.area.value = next;
      this.el.area.scrollTop = scrollTop;
      this.el.area.scrollLeft = scrollLeft;
    }
    await this.refresh(false);
    if (source !== 'disk') this.scheduleSave();
  }

  private async refresh(force: boolean): Promise<void> {
    this.doc = parseDoc(this.text);
    const before = this.snap;
    let drawing = false;
    try {
      await oneAtATime(async () => {
        drawing = false;
        const snap = await snapshot(this.text);
        const draw = force || !before || this.error !== null || this.chartText !== this.text || this.stale;
        // A hidden tab takes the new text in now and draws it when it is shown (`show`).
        if (draw && this.hidden) {
          this.stale = true;
        } else {
          drawing = true;
          if (draw) await this.chart.draw(this.text, snap);
          drawing = false;
          this.chartText = this.text;
          this.stale = false;
        }
        this.snap = snap;
        this.error = null;
        this.drawFailed = false;
      });
    } catch (e) {
      this.error = errorText(e);
      this.drawFailed = drawing;
      if (!this.snap) this.chart.clear();
    }
    this.keepSelection(before);
    this.paint();
    this.keepWalk();
  }
  private chartText: string | null = null;

  /**
   * The walk in this tab (T6.4): its steps, the first where it started; empty while the
   * reader picks where to start; null when there is no walk. Nothing of it is written.
   */
  private walkPath: WalkStep[] | null = null;
  /** The node the reader picked to start from, where Start again goes (Q242). */
  private walkFrom: string | null = null;

  /** A node's title as the sidebar shows it, or its id. */
  titleOf(id: string): string {
    return nodeLabel(this.doc, id)?.title ?? this.snap?.nodes[id]?.text ?? id;
  }

  /** Whether this tab shows a walk. */
  get walking(): boolean { return this.walkPath !== null; }

  /**
   * Starts a walk (the pill's Walkthrough button, Q229): it waits for the reader to click
   * the node to start from, any node (the user's idea, 2026-11-26, Q242). The Highlight
   * switch goes off: a click now walks. The highlights are hidden until the walk ends.
   */
  startWalk(): void {
    if (!this.snap || !this.win.viewing()) return;
    if (this.win.highlighting()) this.win.setHighlighting(false);
    this.walkPath = [];
    this.walkFrom = null;
    this.showWalk(true);
    this.paintHighlights(); // the highlights hide for the walk, and Clear with them
  }

  /** Ends the walk; the view stays where the walk left it, and the pill comes back. */
  leaveWalk(): void {
    if (this.walkPath === null) return;
    this.walkPath = null;
    this.chart.setWalk(null);
    this.paintHighlights();
    this.select(null);
  }

  /**
   * A key pressed during a walk (Q233, the user, 2026-11-26): Left arrow goes Back; Right
   * arrow takes Next when there is one way on; 1 to 9 take the next place at that place in
   * the order they lie on the chart (`Chart.walkChoice`); while picking where to start,
   * none (Q242). Escape, which leaves, is the
   * window's (it closes an open menu first). Returns whether the key was the walk's.
   */
  walkKey(key: string): boolean {
    const path = this.walkPath;
    if (!path || !this.snap) return false;
    if (key === 'arrowleft') { this.onWalk({ kind: 'back' }); return true; }
    const view = walkView(this.snap, path);
    if (key === 'arrowright') {
      if (view.choices.length === 1) this.onWalk({ kind: 'choose', edge: view.choices[0].edge });
      return true;
    }
    if (/^[1-9]$/.test(key)) {
      const action = this.chart.walkChoice(Number(key) - 1);
      if (action) this.onWalk(action);
      return true;
    }
    return false;
  }

  private onWalk(action: WalkAction): void {
    const path = this.walkPath;
    if (!path || !this.snap) return;
    if (action.kind === 'leave') { this.leaveWalk(); return; }
    if (action.kind === 'again') {
      // Start again: back to the node picked (Q242), or to picking if it has gone.
      const from = this.walkFrom;
      this.walkPath = from !== null && from in this.snap.nodes ? [{ id: from, via: null }] : [];
      this.showWalk(true);
      return;
    }
    if (action.kind === 'start') {
      if (!(action.id in this.snap.nodes)) return;
      this.walkPath = [{ id: action.id, via: null }];
      this.walkFrom = action.id;
    }
    if (action.kind === 'back') {
      if (path.length < 2) return;
      path.pop();
      this.showWalk(true);
      return;
    }
    if (action.kind === 'choose') {
      const here = path[path.length - 1];
      const choice = here ? choicesFrom(this.snap, here.id).find((c) => c.edge === action.edge) : undefined;
      if (!choice) return;
      path.push({ id: choice.to, via: choice.edge });
    }
    this.showWalk(true);
  }

  /**
   * Shows the walk: its place selected, so the sidebar shows its title and description,
   * and the chart's walk view.
   */
  private showWalk(move: boolean): void {
    if (!this.walkPath || !this.snap) return;
    const view = walkView(this.snap, this.walkPath);
    const here = view.here;
    this.select(here === null ? null : here in this.snap.nodes ? { kind: 'node', id: here } : { kind: 'sub', id: here });
    this.chart.setWalk(view, move);
  }

  /**
   * After the file changed during a walk: the walk keeps its steps up to the last place
   * still in the chart (`stillThere`), and the view moves only when it had to step back.
   */
  private keepWalk(): void {
    if (this.walkPath === null || !this.snap) return;
    const kept = stillThere(this.snap, this.walkPath);
    const stepped = kept.length !== this.walkPath.length;
    this.walkPath = kept;
    this.showWalk(stepped);
  }

  /** The arrow an edit of its label or style is putting in, and how it reads after (`edit`). */
  private edited: { index: number; after: string } | null = null;

  /**
   * After a new text, keeps the selection on its item. An arrow whose number changed (one
   * added or taken away above it) is followed, with the panel and what is typed in it
   * (bug hunt round 7, C55, oC55). An item no longer there is let go; what was typed for
   * it in the panel cannot be written anywhere, so Naiad says so and shows the text.
   */
  private keepSelection(before: Snap | null): void {
    const s = this.selection;
    const snap = this.snap;
    if (!s || !snap) return;
    if (s.kind === 'node' && s.id in snap.nodes) return;
    if (s.kind === 'sub' && s.id in snap.subs) return;
    if (s.kind === 'edge') {
      const edited = this.edited?.index === s.index ? this.edited.after : null;
      const found = edited === null ? -1 : JSON.stringify(snap.edges[s.index]) === edited ? s.index : snap.edges.findIndex((e) => JSON.stringify(e) === edited);
      const at = edited === null ? followEdge(before, snap, s.index) : found >= 0 ? found : null;
      if (at === s.index) return;
      if (at !== null) {
        this.sidebar.renumber(s.index, at);
        this.selection = { kind: 'edge', index: at };
        return;
      }
    }
    const lost = this.sidebar.typed() ?? (() => { const d = this.sidebar.draft(); return d && { what: 'description', text: d.text }; })();
    if (lost) {
      const name = itemName(s, before);
      this.win.toast(`${name[0].toUpperCase()}${name.slice(1)} is no longer in the flowchart, so the ${lost.what} you were typing for it was not saved: “${clip(lost.text)}”`);
    }
    this.selection = null;
  }

  /** Why the last edit was refused, as its message said (`writeLeft`, and the window's `setViewing`). */
  refusal: string | null = null;

  async edit(op: Op): Promise<OpResult | null> {
    // In View mode no edit starts; one started before the switch is finished (`setViewing`).
    if (this.win.viewing()) { this.win.viewBlocked(); return null; }
    await this.takeTyping();
    let result: OpResult | null = null;
    // Checked and put in as one job, so a reload can never land between the two.
    await this.queue(async () => {
      let before: Snap | null;
      let res: OpResult;
      do {
        await this.takeTypingNow(); // typed while this job waited (C25)
        before = this.snap;
        try {
          res = await applyChecked(this.text, op);
        } catch (e) {
          this.win.toast(this.refusal = e instanceof EditError ? e.message : errorText(e));
          this.paint(); // put the controls back to what the file says
          return;
        }
        // Keys pressed while the edit was checked are taken in, and the edit is checked
        // again on the text they make, rather than written over (bug hunt round 3, oC1).
      } while (this.typingWaits());
      // Decide what stays selected before the redraw, so it is painted once.
      if (op.kind === 'deleteNode' || op.kind === 'deleteEdge' || op.kind === 'ungroup') this.selection = null;
      if (op.kind === 'addNode') this.selection = { kind: 'node', id: res.created! };
      if (op.kind === 'renameSubgraph') this.selection = { kind: 'sub', id: res.created! };
      // An arrow's label or style changed: the arrow is followed to where the edit put it
      // (`keepSelection`), and the panel stays, with what is typed in it meanwhile (bug
      // hunt round 7, C57).
      if (before && (op.kind === 'setEdgeLabel' || op.kind === 'setEdgeStyle')) {
        this.edited = { index: op.index, after: JSON.stringify(expectOp(before, op, res).edges[op.index]) };
      }
      // An arrow's end moved (T1.8): the selection stays on it, at its new number when it
      // was written out of a group (Q100), and also when an identical arrow is beside it.
      if (before && op.kind === 'setEdgeEnd' && this.selection?.kind === 'edge' && this.selection.index === op.index) {
        const at = res.edgeIndex ?? op.index;
        if (at !== op.index) {
          this.sidebar.renumber(op.index, at);
          this.selection = { kind: 'edge', index: at };
        }
        this.edited = { index: at, after: JSON.stringify(expectOp(before, op, res).edges[at]) };
      }
      try {
        await this.apply(res.text, 'chart');
      } finally {
        this.edited = null;
      }
      if (op.kind === 'addEdge' && this.snap) this.select({ kind: 'edge', index: this.snap.edges.length - 1 });
      result = res;
    });
    return result;
  }

  async moveEdgeEnd(index: number, end: 'start' | 'end', id: string): Promise<void> {
    await this.edit({ kind: 'setEdgeEnd', index, end, id });
  }

  async addNode(parent: string | null): Promise<void> {
    if (this.win.viewing()) { this.win.viewBlocked(); return; }
    const sel = this.selection;
    const into = parent ?? (sel?.kind === 'sub' ? sel.id : null);
    if (!(await this.writeDraft())) return; // the new node takes the panel (C36)
    const res = await this.edit({ kind: 'addNode', title: 'New node', parent: into });
    if (res) this.sidebar.focusTitle();
  }

  /**
   * Undo (back) or Redo, as one job of the queue. The stacks are looked up in it, after
   * the typing is taken in, since taking it in (or a reload) empties Redo. An Undo that
   * would take back a change made on disk asks first, since it saves over that change (C3).
   */
  async history(back: boolean): Promise<void> {
    if (this.win.viewing()) { this.win.viewBlocked(); return; } // Undo and Redo save, so they are edits too
    await this.takeTyping();
    await this.queue(async () => {
      await this.takeTypingNow(); // typed while this job waited (C25)
      const [from, to] = back ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
      const step = from[from.length - 1];
      if (!step) return;
      if (back && step.disk && !(await this.backend.confirm(
        `The last change to ${basename(this.path ?? '')} was made on disk, by an agent or another program. Undo takes it back and saves your earlier version over it; Redo brings it back. Undo it?`,
      ))) return;
      from.pop();
      to.push({ text: this.text, disk: step.disk });
      await this.apply(step.text, 'history');
    });
  }

  select(target: Target | null): void {
    // A description being written goes into the file as the panel turns to another item
    // or none, as Done would (bug hunt round 3, C36). A node's id stays its own, so the
    // edit is right even though it runs after the panel has changed.
    // With nothing selected, the panel is the flowchart's description while About is on.
    const draft = this.sidebar.draft();
    const next = target ? (target.kind === 'node' ? target.id : null) : this.win.about() ? FLOWCHART_ID : null;
    if (draft && draft.id !== next) void this.writeDescription(draft.id, draft.text);
    // So is a title, label or group title typed and not in the file (Q90).
    const was = this.selection;
    const typed = was && !sameTarget(was, target) ? this.sidebar.typed() : null;
    if (typed) void this.writeLeft(typed, itemName(was!, this.snap));
    this.selection = target;
    this.paint();
  }

  /**
   * Writes what was typed into a box of a panel that turns to another item or none; focus
   * leaving the box has most often begun the write, and it is waited for. One that cannot
   * be written goes with its panel, so Naiad says why, with the text, as for an item taken
   * away on disk (Q90, after bug hunt round 7).
   */
  private async writeLeft(typed: Typed, name: string): Promise<void> {
    this.refusal = null;
    if (await typed.write()) return;
    const why = this.refusal ? `${this.refusal} ` : '';
    this.win.toast(`${why}The ${typed.what} you were typing for ${name} was not saved: “${clip(typed.text)}”`);
  }

  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (this.win.viewing()) { this.win.viewBlocked(); return; }
    if (s.kind === 'node') void this.edit({ kind: 'deleteNode', id: s.id });
    else if (s.kind === 'edge') void this.edit({ kind: 'deleteEdge', index: s.index });
    else void this.edit({ kind: 'ungroup', id: s.id });
  }

  // ------------------------------------------------------------------ painting

  /** What the sidebar shows: the item selected, or else the flowchart's description while About is on. */
  private view(): View | null {
    return this.itemView() ?? this.aboutView();
  }

  /**
   * What a print can hold (T6.3, Q223): the flowchart's name and description, and each
   * node that has a description, with its title, in the order the file first names the
   * nodes. Descriptions are Markdown. Null on a blank tab.
   */
  printContents(): { name: string; about: string; nodes: { title: string; description: string }[] } | null {
    if (this.path === null) return null;
    const descriptions = getDescriptions(this.text);
    const snap = this.snap;
    const seen = new Set<string>();
    const nodes: { title: string; description: string }[] = [];
    const refs = allRefs(this.doc).sort((a, b) => a.line - b.line || a.ref.start - b.ref.start);
    for (const { ref } of refs) {
      const id = ref.id;
      if (seen.has(id) || (snap && !(id in snap.nodes))) continue;
      seen.add(id);
      const description = descriptions.get(id)?.trim();
      if (description) nodes.push({ title: nodeLabel(this.doc, id)?.title ?? snap?.nodes[id]?.text ?? id, description });
    }
    return {
      name: frontMatterTitle(this.text) || basename(this.path),
      about: descriptions.get(FLOWCHART_ID)?.trim() ?? '', nodes,
    };
  }

  /** The chart drawn for paper (T6.3) into `holder`; null when nothing can be drawn. */
  async drawForPaper(holder: HTMLElement): Promise<SVGSVGElement | null> {
    return this.snap ? drawForPaper(this.text, this.snap, holder) : null;
  }

  private aboutView(): View | null {
    if (!this.win.about() || this.path === null) return null;
    return {
      kind: 'about', file: this.path, name: frontMatterTitle(this.text) || basename(this.path),
      description: getDescriptions(this.text).get(FLOWCHART_ID) ?? '', classList: this.classList(),
    };
  }

  /**
   * The classes the file defines, `default` left out (it colours every node), each with
   * its colour, how many nodes and groups are in it (T1.26), its shape (Q267) and the
   * border choice nearest to what it writes (Q274).
   */
  private classList(): ClassInfo[] {
    const snap = this.snap;
    if (!snap) return [];
    const count = (items: { classes: string[] }[], name: string) => items.filter((x) => x.classes.includes(name)).length;
    const shapes = classShapes(this.text);
    return Object.entries(snap.classDefs).filter(([name]) => name !== 'default').map(([name, styles]) => {
      const p = paintOf(new Map([[name, { styles }]]), [name]);
      return {
        name, fill: p?.fill ?? '', stroke: p?.stroke ?? '', nodes: count(Object.values(snap.nodes), name), groups: count(Object.values(snap.subs), name),
        shape: shapes.get(name) ?? null, border: borderOf(styles),
      };
    });
  }

  /** The classes an item is in, as the Class row shows them: Mermaid's own `clickable` (a `click` line) left out unless the file defines it. */
  private classesOf(classes: string[]): string[] {
    return [...new Set(classes)].filter((c) => c !== 'clickable' || c in (this.snap?.classDefs ?? {}));
  }

  private itemView(): View | null {
    const s = this.selection;
    const snap = this.snap;
    if (!s || !snap) return null;
    const fillOf = (styles: string[]) => styles.find((x) => x.startsWith('fill:'))?.slice(5).trim() ?? '';
    if (s.kind === 'node') {
      const n = snap.nodes[s.id];
      if (!n) return null;
      const groups = Object.entries(snap.subs).map(([id, g]) => ({ id, title: shown(g.title) || id }));
      return {
        kind: 'node', id: s.id, title: nodeLabel(this.doc, s.id)?.title ?? n.text,
        description: getDescriptions(this.text).get(s.id) ?? '', shape: n.type, fill: fillOf(n.styles), classPaint: snap.paint?.[s.id] ?? null,
        classes: this.classesOf(n.classes), classList: this.classList(),
        group: Object.keys(snap.subs).find((id) => snap.subs[id].nodes.includes(s.id)) ?? '', groups,
      };
    }
    if (s.kind === 'sub') {
      const g = snap.subs[s.id];
      if (!g) return null;
      return {
        kind: 'sub', id: s.id, title: shown(g.title), dir: g.dir, fill: fillOf(g.styles), classPaint: snap.paint?.[s.id] ?? null, count: g.nodes.length,
        classes: this.classesOf(g.classes), classList: this.classList(),
      };
    }
    const e = snap.edges[s.index];
    if (!e) return null;
    const title = (id: string) => (snap.subs[id] ? shown(snap.subs[id].title) : null) ?? nodeLabel(this.doc, id)?.title ?? id;
    const locations = [...allRefs(this.doc).map(({ line, ref }) => ({ id: ref.id, line, offset: ref.start })),
      ...this.doc.subs.filter((g) => g.explicitId).map((g) => ({ id: g.id, line: g.line, offset: 0 }))]
      .sort ( (a, b) => a.line - b.line || a.offset - b.offset);
    const named = new Set(this.doc.subs.filter((g) => g.explicitId).map((g) => g.id));
    const seen = new Set<string>();
    const ids = locations.map(({ id }) => id).filter((id) => {
      if (seen.has(id) || (!(id in snap.nodes) && !named.has(id))) return false;
      seen.add(id); return true;
    });
    // The arrow's own ends are always there, so each menu shows them; a group with only a
    // title is no new end, but it may be this arrow's end now.
    for (const id of [e.start, e.end]) if (!seen.has(id)) { seen.add(id); ids.push(id); }
    const ends = ids.map((id) => ({ id, title: (snap.subs[id] ? 'Group: ' : '') + title(id) }));
    const counts = new Map<string, number>();
    for (const item of ends) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
    for (const item of ends) if (counts.get(item.title)! > 1) item.title += ` [${item.id}]`;
    const arrow = ({ arrow_point: 'arrow', arrow_open: 'none', double_arrow_point: 'both', arrow_circle: 'circle', arrow_cross: 'cross' } as const)[e.type] ?? 'arrow';
    let label = shown(e.text);
    const ref = this.doc.edges[s.index];
    if (ref) {
      try { label = parseLink(this.doc.info[ref.line].chains![ref.chain].links[ref.link].raw).label; } catch { /* keep Mermaid's text */ }
    }
    // Its own colour: the last `stroke` in its own style, which is the one drawn.
    const colour = e.style.filter((x) => x.slice(0, x.indexOf(':')).trim() === 'stroke').pop()?.split(':')[1].trim() ?? '';
    return { kind: 'edge', index: s.index, from: title(e.start), to: title(e.end), fromId: e.start, toId: e.end, ends, label, stroke: e.stroke as never, arrow, colour };
  }

  paint(): void {
    const open = this.path !== null;
    this.el.empty.hidden = open || this.win.starting();
    this.el.area.disabled = !open;
    this.chart.select(this.selection);
    this.paintHighlights();
    this.sidebar.show(this.view());
    this.paintBar();
    this.paintNotices();
  }

  /**
   * The island and the pill (T4.9), and the saved state, unseen but read by screen
   * readers: only the shown tab paints them (the file's name is in its tab, T1.16). A
   * blank tab shows neither the island nor the pill.
   */
  private paintBar(): void {
    if (!this.win.shown()) return;
    const bar = this.bar;
    const open = this.path !== null;
    let status = '';
    let state = '';
    if (open) {
      if (/^(Could not|The file cannot)/.test(this.note)) { status = this.note; state = 'bad'; }
      else if (this.text === this.saved) status = this.note || 'Saved';
      else if (this.error) {
        status = this.drawFailed ? 'Not saved: Mermaid cannot draw it (Ctrl+S saves anyway)' : 'Not saved: syntax error (Ctrl+S saves anyway)';
        state = 'bad';
      }
      else status = 'Saving…';
    }
    bar.status.textContent = status;
    bar.status.dataset.state = state;
    const shown = [bar.pill.hidden, bar.island.hidden].join();
    bar.pill.hidden = !open || this.walking; // during a walk, the walk bar is in its place
    bar.island.hidden = !open || this.win.viewing();
    bar.walk.hidden = !this.win.viewing();
    // A file's first drawing comes before this shows the tools, so it was fitted without
    // them: fit it again around them (seen 2026-11-25).
    if ([bar.pill.hidden, bar.island.hidden].join() !== shown) this.chart.toolsChanged();
    bar.undo.disabled = !this.undoStack.length;
    bar.redo.disabled = !this.redoStack.length;
    bar.add.disabled = bar.fit.disabled = bar.dir.disabled = bar.highlight.disabled = bar.walk.disabled = !open || !this.snap;
    if (bar.highlight.disabled && this.win.highlighting()) this.win.setHighlighting(false);
    if (this.snap) this.win.showDirection(this.snap.direction === 'TB' ? 'TD' : this.snap.direction);
  }

  /** Whether the syntax error's notice shows Mermaid's own message (its Details button). */
  private noticeDetails = false;

  /**
   * The notices: thin bars laid over the top of the chart (the user, 2026-11-12, Q103;
   * in the chart area since T4.9). Each is one line, its whole text on hover; Mermaid's
   * message for a syntax error opens below it. With no saved state shown (T4.9), a file
   * that could not be saved or read shows here, and a syntax error says it is not saved.
   */
  paintNotices(): void {
    const items: HTMLElement[] = [];
    const button = (label: string, run: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', run);
      return b;
    };
    const notice = (cls: string, text: string, actions: HTMLButtonElement[], detail?: string) => {
      const div = document.createElement('div');
      div.className = `notice ${cls}`;
      const line = document.createElement('div');
      line.className = 'notice-line';
      const span = document.createElement('span');
      span.className = 'notice-text';
      span.textContent = text;
      span.title = text;
      // Something wrong (T4.9): the alert's icon before the text.
      if (cls === 'bad') line.insertAdjacentHTML('afterbegin', ICONS.alert);
      line.append(span, ...actions);
      div.append(line);
      if (detail !== undefined) {
        const pre = document.createElement('pre');
        pre.textContent = detail;
        div.append(pre);
      }
      items.push(div);
    };
    const showSyntax = () => (this.win.pane.hidden ? [button('Show syntax', () => this.win.showSyntax())] : []);
    const viewing = this.win.viewing();
    if (this.win.viewNotice() && viewing) {
      notice('info', 'View mode: switch to Edit to change the chart', [button('Edit', () => this.win.setViewing(false))]);
    }
    // A blank tab (T1.16) has no text, so nothing in it to find fault with.
    const open = this.path !== null;
    if (open && /^(Could not|The file cannot)/.test(this.note)) notice('bad', this.note, []);
    if (!open) {
      this.noticeDetails = false;
    } else if (this.error) {
      const details = button(this.noticeDetails ? 'Hide details' : 'Details', () => { this.noticeDetails = !this.noticeDetails; this.paintNotices(); });
      const unsaved = this.text !== this.saved ? ' Not saved: Ctrl+S saves anyway.' : '';
      if (this.drawFailed) {
        // Mermaid read the text and stopped while drawing it (T5.17; the user, 2026-11-16,
        // Q168): say so, with Mermaid's reason, not that it cannot read it.
        const reason = this.error.split('\n')[0].replace(/\s*Please check your syntax\.?\s*$/, '').replace(/\.$/, '');
        const shown = this.chartText !== null ? 'The chart shows the last good version.' : 'No chart is shown.';
        notice('bad', `Mermaid cannot draw this flowchart: ${reason}. ${shown}${unsaved}`, [details, ...showSyntax()], this.noticeDetails ? this.error : undefined);
      } else {
        // A file that was broken when it was opened has no last good version: the chart is empty.
        const what = this.snap ? 'the chart shows the last good version' : 'the chart cannot be drawn';
        notice('bad', `Mermaid cannot read this text, so ${what}.${unsaved}`, [details, ...showSyntax()], this.noticeDetails ? this.error : undefined);
      }
    } else {
      this.noticeDetails = false;
      if (this.doc.problems.length) {
        const p = this.doc.problems[0];
        notice('warn', `Line ${String(p.line + 1)}: ${p.message} The chart can show this file but will not edit it; change it in the Syntax pane.`, showSyntax());
      }
    }
    if (open && this.doc.warnings.length) {
      const lines = this.doc.warnings.map((w) => String(w.line + 1)).join(', ');
      // Its button changes the file, so View mode leaves it out.
      notice('warn', `Line ${lines}: a bare "%%" is drawn as a node by other Mermaid tools.`, viewing ? [] : [button('Change to "%% ."', () => {
        void this.queue(async () => { await this.takeTypingNow(); await this.apply(this.text.replace(/^([ \t]*)%%[ \t]*$/gm, '$1%% .'), 'chart'); });
      })]);
    }
    this.el.notices.replaceChildren(...items);
  }

  // ------------------------------------------------------------------ input

  /** The Syntax pane's typing: taken in 220 ms after the last key; Tab puts in four spaces. */
  private bindArea(): void {
    const area = this.el.area;
    area.addEventListener('input', () => {
      window.clearTimeout(this.textTimer);
      this.textTimer = window.setTimeout(() => { this.textTimer = undefined; void this.queue(() => this.takeTypingNow()); }, 220);
    });
    area.addEventListener('keydown', (e) => {
      if (this.win.viewing()) {
        // The pane is read-only: a key that would change its text shows why it does not.
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        const typing = !mod && !e.altKey && (e.key.length === 1 || key === 'enter' || key === 'backspace' || key === 'delete');
        if (typing || (mod && ['v', 'x', 'z', 'y'].includes(key))) this.win.viewBlocked();
        return; // Tab moves on, as in any read-only box
      }
      if (e.key !== 'Tab') return;
      e.preventDefault();
      area.setRangeText('    ', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input'));
    });
  }
}
