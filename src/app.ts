// The app: one open file, kept as text. The chart, the text pane and the sidebar are
// three views of that text; every change from any of them becomes new text, which is
// drawn again and saved to the file. A change to the file on disk comes back the same way.

import type { Backend } from './backend';
import { Chart, configureMermaid, type Target } from './chart';
import { FLOWCHART_ID, getDescriptions } from './core/descriptions';
import { EditError, parseLink } from './core/edits';
import { plainText, withEndingsOf } from './core/endings';
import { itemOf, parseHighlights, resolveHighlights, toggleInFile } from './core/highlights';
import { allRefs, FRONT_MATTER_RE, nodeLabel, parseDoc, type Doc } from './core/scan';
import { snapshot, type Snap } from './semantics';
import { NEW_GROUP, Sidebar, type Typed, type View } from './sidebar';
import { applyChecked, expectOp, type Op, type OpResult } from './verify';

type Source = 'chart' | 'text' | 'disk' | 'history';
interface Step { text: string; disk: boolean }

const NEW_FILE = 'flowchart TD\n    start[Start]\n';
/** How long the file must have been quiet after a change from outside before a save (`saveNow`). */
const SETTLE_MS = 1000;
const NODE_TEXT = '#1c2026';

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function errorText(e: unknown): string {
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
  if (target.kind === 'node') return `“${snap?.nodes[target.id]?.text ?? target.id}”`;
  if (target.kind === 'sub') return `the group “${snap?.subs[target.id]?.title || target.id}”`;
  const e = snap?.edges[target.index];
  const end = (id: string) => snap?.nodes[id]?.text ?? snap?.subs[id]?.title ?? id;
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

function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage can be unavailable; the app works without it */ }
  return null;
}

export class App {
  /** The flowchart's text: the whole Mermaid file. */
  private text = '';
  /** The flowchart's text as last read from or written to disk. */
  private saved = '';
  private path: string | null = null;
  private doc: Doc = parseDoc('');
  private snap: Snap | null = null;
  private error: string | null = null;
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
  /** The Highlight switch. */
  private hlOn = false;
  /**
   * View mode (D4.3, T1.11): reading only. No handles, no dot grid, and no way to change
   * the flowchart outside the Syntax pane, which is read-only too. Kept by the app across
   * starts, never in the file (Q114).
   */
  private viewing = false;
  /**
   * The About button (D1.4, T1.13): with nothing selected, the sidebar shows the
   * flowchart's description, so closing an item leaves the sidebar open. Kept by the app
   * across starts, as the mode is (Q114).
   */
  private about = true;

  private chart!: Chart;
  private sidebar!: Sidebar;
  private el!: {
    name: HTMLElement; status: HTMLElement; area: HTMLTextAreaElement; notices: HTMLElement; stage: HTMLElement;
    empty: HTMLElement; toast: HTMLElement; dir: HTMLSelectElement; undo: HTMLButtonElement; redo: HTMLButtonElement;
    add: HTMLButtonElement; textToggle: HTMLButtonElement; pane: HTMLElement; fit: HTMLButtonElement;
    highlight: HTMLButtonElement; clear: HTMLButtonElement; view: HTMLButtonElement; about: HTMLButtonElement;
  };

  constructor(private root: HTMLElement, private backend: Backend) {}

  async init(): Promise<void> {
    this.root.innerHTML = `
      <header class="bar">
        <button data-act="open" title="Open a file (Ctrl+O)">Open</button>
        <button data-act="new" title="Start a new flowchart file">New</button>
        <div class="file">
          <span class="name"></span>
          <span class="status"></span>
        </div>
        <div class="spacer"></div>
        <button data-act="add" title="Add a node (or double-click empty space)">+ Node</button>
        <button data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
        <button data-act="redo" title="Redo (Ctrl+Y)">Redo</button>
        <select data-act="dir" title="Direction of the chart" aria-label="Direction of the chart">
          <option value="TD">Top to bottom</option><option value="LR">Left to right</option>
          <option value="BT">Bottom to top</option><option value="RL">Right to left</option>
        </select>
        <!-- Clear stands before Highlight: the bar is aligned right, so when Clear appears,
             Highlight stays where it is and a second click on it never lands on Clear. -->
        <button data-act="clear" title="Take every highlight off" hidden>Clear</button>
        <button data-act="highlight" title="Highlight: click nodes, arrows and groups to mark them, for you and the agent to point at (H)" aria-pressed="false">Highlight</button>
        <button data-act="fit" title="Fit the chart to the window">Fit</button>
        <button data-act="syntax" title="Show or hide the flowchart's Mermaid syntax" aria-pressed="false">Syntax</button>
        <button data-act="about" title="Show or hide the flowchart's description, shown in the sidebar when nothing is selected" aria-pressed="true">About</button>
        <button data-act="view" title="View mode: read the chart without changing it (press again to edit)" aria-pressed="false">View</button>
      </header>
      <main>
        <section class="textpane" hidden>
          <textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" aria-label="The flowchart's Mermaid syntax"></textarea>
        </section>
        <section class="stage" tabindex="-1">
          <div class="empty" hidden>
            <h1>No file open</h1>
            <p>Open a Mermaid flowchart file (<code>.mmd</code> or <code>.mermaid</code>) to view and edit it.</p>
            <p><button class="primary" data-act="open">Open a file</button> <button data-act="new">New flowchart</button></p>
          </div>
        </section>
        <aside class="sidebar" hidden></aside>
        <div class="notices"></div>
      </main>
      <div class="toast" role="status" hidden></div>`;
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.el = {
      name: q('.name'), status: q('.status'), area: q('textarea'), notices: q('.notices'), stage: q('.stage'),
      empty: q('.empty'), toast: q('.toast'), dir: q('[data-act="dir"]'), undo: q('[data-act="undo"]'),
      redo: q('[data-act="redo"]'), add: q('[data-act="add"]'), textToggle: q('[data-act="syntax"]'), pane: q('.textpane'),
      fit: q('[data-act="fit"]'), highlight: q('[data-act="highlight"]'),
      clear: q('[data-act="clear"]'), view: q('[data-act="view"]'), about: q('[data-act="about"]'),
    };
    if (this.backend.kind !== 'desktop') this.root.querySelectorAll('[data-act="new"]').forEach((b) => b.remove());
    if (this.backend.kind === 'served') {
      // The in-browser version shows the one file it was started for.
      this.root.querySelectorAll('[data-act="open"]').forEach((b) => b.remove());
      this.el.empty.innerHTML = '<h1>No file to show</h1><p>The file this page was opened for cannot be read. Ask the agent to show the flowchart again, or open the file in the Naiad app.</p>';
    }

    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    configureMermaid(dark.matches);
    dark.addEventListener('change', () => { configureMermaid(dark.matches); this.queue(() => this.refresh(true)); });

    this.chart = new Chart(this.el.stage, {
      onSelect: (t) => this.select(t),
      onHighlight: (t) => { void this.toggleHighlight(t); },
      onConnect: (from, to) => { void this.edit({ kind: 'addEdge', from, to }); },
      onMoveEnd: (index, end, id) => { void this.moveEdgeEnd(index, end, id); },
      onAddNode: () => { void this.addNode(null); },
      onRename: (t) => { this.select(t); this.sidebar.focusTitle(); },
      onBlocked: () => this.viewBlocked(),
    });
    this.sidebar = new Sidebar(this.root.querySelector<HTMLElement>('.sidebar')!, {
      close: () => this.select(null),
      hideAbout: () => this.setAbout(false),
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
    });

    this.bind();
    // The Syntax pane starts hidden, and opens at start only if the person left it open.
    if (remember('syntaxpane') === 'shown') this.toggleText(true);
    // Naiad opens in the mode it was last left in (Q114).
    if (remember('mode') === 'view') this.showViewing(true);
    // The flowchart's description shows unless the person hid it (T1.13).
    if (remember('about') === 'hidden') this.showAbout(false);
    // A notice's details wrap to another height when the window's width changes.
    window.addEventListener('resize', () => this.padUnderNotices());
    const width = Number(remember('textpane-width'));
    if (width >= 220) this.el.pane.style.width = `${width}px`;

    const first = await this.backend.initialPath().catch(() => null);
    if (first) await this.open(first);
    if (!this.path) this.paint(); // nothing was opened: show the empty state

    // The highlights file is looked at once a second (and at once when the view comes
    // back into sight), so an agent's highlights show without Naiad watching a folder
    // that comes and goes.
    window.setInterval(() => { void this.readHighlights(); }, 1000);
    document.addEventListener('visibilitychange', () => { void this.readHighlights(); });
    this.backend.guardClose(() => this.canClose());
  }

  /** Whether the window may close: saves what waits to be saved, and asks before a change is lost. */
  private canClose(): Promise<boolean> {
    return this.leave('Close Naiad');
  }

  /**
   * Before another file is shown, or Naiad closes: saves what waits to be saved, then
   * asks before an edit is lost, whether it cannot be saved or a change on disk
   * displaced it and only Undo holds it (bug hunt C10). `what` names the step: "Open x".
   */
  private async leave(what: string): Promise<boolean> {
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
        if (!(await this.backend.confirm(`The description you were writing could not be saved. ${what} and lose it?`))) return false;
        letGoDraft = true;
      }
      if (!letGoBox) {
        const lost = await this.writeTyped();
        if (lost) {
          if (!(await this.backend.confirm(`The ${lost} you were typing could not be saved. ${what} and lose it?`))) return false;
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
      return this.backend.confirm(`${basename(this.path)} holds a change that is not saved${this.unsavedWhy()}. ${what} and lose it?`);
    }
    if (this.displaced) return this.backend.confirm(this.displacedQuestion(what));
    return true;
  }

  /**
   * Writes the description being written in the sidebar, when the person changed it, as
   * Done would (bug hunt round 3, C36), and again while more was typed as it was written
   * (round 4, C41). False when it could not be written; it then stays in its box.
   */
  private async writeDraft(): Promise<boolean> {
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
  private async writeTyped(): Promise<string | null> {
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
  private async writeDescription(id: string, text: string): Promise<void> {
    if (await this.edit({ kind: 'setDescription', id, description: text })) return;
    // The flowchart's description (T1.13) is in the sidebar while nothing is selected and
    // About is on; turning back to it turns About on.
    const whole = id === FLOWCHART_ID;
    const here = () => (whole ? this.selection === null && this.about : this.selection?.kind === 'node' && this.selection.id === id);
    const there = () => whole || !!this.snap?.nodes[id];
    if (!here()) {
      const title = whole ? 'the flowchart' : `“${nodeLabel(this.doc, id)?.title ?? id}”`;
      if (!there()) return;
      if (await this.backend.confirm(`The description you were writing for ${title} could not be saved. Lose it?`)) return;
      if (!there()) return;
      if (!here()) {
        if (whole) { this.select(null); this.showAbout(true); }
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
    if (this.error) return ' (Mermaid cannot read the text)';
    return '';
  }

  // ------------------------------------------------------------------ file

  async open(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await this.backend.read(path);
    } catch (e) {
      this.toast(`Could not open ${basename(path)}: ${errorText(e)}`);
      return;
    }
    if (!(await this.leave(`Open ${basename(path)}`))) return;
    this.stopWatch?.();
    this.path = path;
    this.displaced = false;
    this.text = this.saved = plainText(raw);
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.snap = null;
    this.note = '';
    this.hlText = '';
    this.hlVersion++;
    this.el.area.value = this.text;
    this.chart.resetView();
    this.backend.setWindowTitle(`${basename(path)} - Naiad`);
    this.backend.viewing(path);
    this.stopWatch = await this.backend.watch(path, () => { void this.diskChanged(); });
    await this.readHighlights();
    await this.queue(() => this.refresh(true));
  }

  // ------------------------------------------------------------------ highlights

  /** Reads the highlights file and draws what changed. Quiet when it cannot be read. */
  private async readHighlights(): Promise<void> {
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
      .then(() => (path === this.path ? job() : undefined))
      .catch((e) => {
        // Show what is on disk again: the read that follows draws it.
        this.toast(`Could not save the highlights: ${errorText(e)}`);
        this.hlText = '';
        this.paintHighlights();
      })
      .finally(() => { this.hlBusy--; this.hlVersion++; if (!this.hlBusy) void this.readHighlights(); });
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

  private clearHighlights(): Promise<void> {
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
    this.el.clear.hidden = items.length === 0 || this.path === null;
  }

  private setHighlighting(on: boolean): void {
    this.hlOn = on;
    this.chart.setHighlighting(on);
    this.el.highlight.setAttribute('aria-pressed', String(on));
  }

  /**
   * The View button (Q115). Going to View, a description or a title typed in the sidebar
   * and not yet in the file is written first, as turning to another item does (C36, Q90);
   * one that cannot be written keeps Naiad in Edit mode, with the text still in its box.
   */
  private async setViewing(on: boolean): Promise<void> {
    if (on && !this.viewing) {
      this.refusal = null;
      const why = () => (this.refusal ? `${this.refusal} ` : '');
      if (!(await this.writeDraft())) {
        this.toast(`${why()}The description you were writing was not saved, so Naiad stays in Edit mode.`);
        return;
      }
      const lost = await this.writeTyped();
      if (lost) {
        this.toast(`${why()}The ${lost} you were typing was not saved, so Naiad stays in Edit mode.`);
        return;
      }
      await this.sidebar.settle(); // a description Done is writing is in the file first
    }
    this.showViewing(on);
  }

  private showViewing(on: boolean): void {
    this.viewing = on;
    this.chart.setViewing(on);
    this.sidebar.setViewing(on);
    this.el.view.setAttribute('aria-pressed', String(on));
    // The toolbar keeps the file's name, Open, New, Highlight, Fit, Syntax and View.
    for (const control of [this.el.add, this.el.undo, this.el.redo, this.el.dir]) control.hidden = on;
    this.el.area.readOnly = on;
    if (!on) this.endViewNotice();
    remember('mode', on ? 'view' : 'edit');
    this.paint();
  }

  /** Whether the notice for an edit tried in View mode shows (`viewBlocked`). */
  private viewNotice = false;
  private viewNoticeTimer: number | undefined;

  /**
   * An edit tried in View mode (a double-click on the chart, the Delete key, typing in
   * the Syntax pane): nothing changes, and a notice says why for as long as a toast
   * shows (D4.3).
   */
  private viewBlocked(): void {
    this.viewNotice = true;
    window.clearTimeout(this.viewNoticeTimer);
    this.viewNoticeTimer = window.setTimeout(() => { this.viewNotice = false; this.paintNotices(); }, 6500);
    this.paintNotices();
  }

  private endViewNotice(): void {
    window.clearTimeout(this.viewNoticeTimer);
    this.viewNotice = false;
  }

  private async pickAndOpen(): Promise<void> {
    try {
      const path = await this.backend.pickOpen();
      if (path) await this.open(path);
    } catch (e) {
      this.toast(errorText(e));
    }
  }

  private async newFile(): Promise<void> {
    const path = await this.backend.pickSave('flowchart.mmd');
    if (!path) return;
    try {
      await this.backend.write(path, NEW_FILE);
      await this.open(path);
    } catch (e) {
      this.toast(`Could not create the file: ${errorText(e)}`);
    }
  }

  /**
   * Saves and reloads run one at a time, in the order asked, so that neither acts on
   * a reading of the file that the other has made old (bug hunt C8, C11).
   */
  private fileWork: Promise<void> = Promise.resolve();
  private fileQueue(job: () => Promise<void>): Promise<void> {
    this.fileWork = this.fileWork.then(job).catch((e) => { console.error(e); this.toast(errorText(e)); });
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
      return;
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
          this.toast('The file changed on disk and was reloaded. Your unsaved edit was not written; Undo brings it back, in place of the change on disk.');
        }
      }
      this.paintBar();
    });
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.save(false); }, 350);
  }

  private async flushSave(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    await this.save(false);
  }

  /** Writes the text to the file. A text with a syntax error is written only on Ctrl+S. */
  private save(force: boolean): Promise<void> {
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
  }

  // ------------------------------------------------------------------ changes

  /** Runs jobs one after another, so two drawings never overlap. */
  private queue(job: () => Promise<void>): Promise<void> {
    this.work = this.work.then(job).catch((e) => { console.error(e); this.toast(errorText(e)); });
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
    try {
      const snap = await snapshot(this.text);
      if (force || !before || this.error !== null || this.chartText !== this.text) await this.chart.draw(this.text, snap);
      this.chartText = this.text;
      this.snap = snap;
      this.error = null;
    } catch (e) {
      this.error = errorText(e);
      if (!this.snap) this.chart.clear();
    }
    this.keepSelection(before);
    this.paint();
  }
  private chartText: string | null = null;

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
      this.toast(`${name[0].toUpperCase()}${name.slice(1)} is no longer in the flowchart, so the ${lost.what} you were typing for it was not saved: “${clip(lost.text)}”`);
    }
    this.selection = null;
  }

  /** Why the last edit was refused, as its message said (`writeLeft`). */
  private refusal: string | null = null;

  private async edit(op: Op): Promise<OpResult | null> {
    // In View mode no edit starts; one started before the switch is finished (`setViewing`).
    if (this.viewing) { this.viewBlocked(); return null; }
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
          this.toast(this.refusal = e instanceof EditError ? e.message : errorText(e));
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

  private async addNode(parent: string | null): Promise<void> {
    if (this.viewing) { this.viewBlocked(); return; }
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
  private async history(back: boolean): Promise<void> {
    if (this.viewing) { this.viewBlocked(); return; } // Undo and Redo save, so they are edits too
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

  private select(target: Target | null): void {
    // A description being written goes into the file as the panel turns to another item
    // or none, as Done would (bug hunt round 3, C36). A node's id stays its own, so the
    // edit is right even though it runs after the panel has changed.
    // With nothing selected, the panel is the flowchart's description while About is on.
    const draft = this.sidebar.draft();
    const next = target ? (target.kind === 'node' ? target.id : null) : this.about ? FLOWCHART_ID : null;
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
    this.toast(`${why}The ${typed.what} you were typing for ${name} was not saved: “${clip(typed.text)}”`);
  }

  private deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (this.viewing) { this.viewBlocked(); return; }
    if (s.kind === 'node') void this.edit({ kind: 'deleteNode', id: s.id });
    else if (s.kind === 'edge') void this.edit({ kind: 'deleteEdge', index: s.index });
    else void this.edit({ kind: 'ungroup', id: s.id });
  }

  // ------------------------------------------------------------------ painting

  /** What the sidebar shows: the item selected, or else the flowchart's description while About is on. */
  private view(): View | null {
    return this.itemView() ?? this.aboutView();
  }

  private aboutView(): View | null {
    if (!this.about || this.path === null) return null;
    return {
      kind: 'about', file: this.path, name: frontMatterTitle(this.text) || basename(this.path),
      description: getDescriptions(this.text).get(FLOWCHART_ID) ?? '',
    };
  }

  private itemView(): View | null {
    const s = this.selection;
    const snap = this.snap;
    if (!s || !snap) return null;
    const fillOf = (styles: string[]) => styles.find((x) => x.startsWith('fill:'))?.slice(5).trim() ?? '';
    if (s.kind === 'node') {
      const n = snap.nodes[s.id];
      if (!n) return null;
      const groups = Object.entries(snap.subs).map(([id, g]) => ({ id, title: g.title || id }));
      return {
        kind: 'node', id: s.id, title: nodeLabel(this.doc, s.id)?.title ?? n.text,
        description: getDescriptions(this.text).get(s.id) ?? '', shape: n.type, fill: fillOf(n.styles),
        group: Object.keys(snap.subs).find((id) => snap.subs[id].nodes.includes(s.id)) ?? '', groups,
      };
    }
    if (s.kind === 'sub') {
      const g = snap.subs[s.id];
      if (!g) return null;
      return { kind: 'sub', id: s.id, title: g.title, dir: g.dir, fill: fillOf(g.styles), count: g.nodes.length };
    }
    const e = snap.edges[s.index];
    if (!e) return null;
    const title = (id: string) => snap.subs[id]?.title ?? nodeLabel(this.doc, id)?.title ?? id;
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
    let label = e.text;
    const ref = this.doc.edges[s.index];
    if (ref) {
      try { label = parseLink(this.doc.info[ref.line].chains![ref.chain].links[ref.link].raw).label; } catch { /* keep Mermaid's text */ }
    }
    // Its own colour: the last `stroke` in its own style, which is the one drawn.
    const colour = e.style.filter((x) => x.slice(0, x.indexOf(':')).trim() === 'stroke').pop()?.split(':')[1].trim() ?? '';
    return { kind: 'edge', index: s.index, from: title(e.start), to: title(e.end), fromId: e.start, toId: e.end, ends, label, stroke: e.stroke as never, arrow, colour };
  }

  private paint(): void {
    const open = this.path !== null;
    this.el.empty.hidden = open;
    this.el.area.disabled = !open;
    this.chart.select(this.selection);
    this.paintHighlights();
    this.sidebar.show(this.view());
    this.paintBar();
    this.paintNotices();
  }

  private paintBar(): void {
    const open = this.path !== null;
    this.el.name.textContent = this.path ? basename(this.path) : '';
    this.el.name.title = this.path ?? '';
    let status = '';
    let state = '';
    if (open) {
      if (/^(Could not|The file cannot)/.test(this.note)) { status = this.note; state = 'bad'; }
      else if (this.text === this.saved) status = this.note || 'Saved';
      else if (this.error) { status = 'Not saved: syntax error (Ctrl+S saves anyway)'; state = 'bad'; }
      else status = 'Saving…';
    }
    this.el.status.textContent = status;
    this.el.status.dataset.state = state;
    this.el.undo.disabled = !this.undoStack.length;
    this.el.redo.disabled = !this.redoStack.length;
    this.el.add.disabled = this.el.fit.disabled = this.el.dir.disabled = this.el.highlight.disabled = !open || !this.snap;
    if (this.el.highlight.disabled && this.hlOn) this.setHighlighting(false);
    if (this.snap) this.el.dir.value = this.snap.direction === 'TB' ? 'TD' : this.snap.direction;
  }

  /** Whether the syntax error's notice shows Mermaid's own message (its Details button). */
  private noticeDetails = false;

  /**
   * The notices: thin bars laid over the top of the window, under the toolbar, so they
   * show whether the Syntax pane is open or not (the user, 2026-11-12, Q103). Each is one
   * line, its whole text on hover; Mermaid's message for a syntax error opens below it.
   */
  private paintNotices(): void {
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
      line.append(span, ...actions);
      div.append(line);
      if (detail !== undefined) {
        const pre = document.createElement('pre');
        pre.textContent = detail;
        div.append(pre);
      }
      items.push(div);
    };
    const showSyntax = () => (this.el.pane.hidden ? [button('Show syntax', () => this.toggleText(true))] : []);
    if (this.viewNotice && this.viewing) {
      notice('info', 'View mode: switch to Edit to change the chart', [button('Edit', () => { void this.setViewing(false); })]);
    }
    if (this.error) {
      const details = button(this.noticeDetails ? 'Hide details' : 'Details', () => { this.noticeDetails = !this.noticeDetails; this.paintNotices(); });
      // A file that was broken when it was opened has no last good version: the chart is empty.
      const what = this.snap ? 'the chart shows the last good version' : 'the chart cannot be drawn';
      notice('bad', `Mermaid cannot read this text, so ${what}.`, [details, ...showSyntax()], this.noticeDetails ? this.error : undefined);
    } else {
      this.noticeDetails = false;
      if (this.doc.problems.length) {
        const p = this.doc.problems[0];
        notice('warn', `Line ${String(p.line + 1)}: ${p.message} The chart can show this file but will not edit it; change it in the Syntax pane.`, showSyntax());
      }
    }
    if (this.doc.warnings.length) {
      const lines = this.doc.warnings.map((w) => String(w.line + 1)).join(', ');
      // Its button changes the file, so View mode leaves it out.
      notice('warn', `Line ${lines}: a bare "%%" is drawn as a node by other Mermaid tools.`, this.viewing ? [] : [button('Change to "%% ."', () => {
        void this.queue(async () => { await this.takeTypingNow(); await this.apply(this.text.replace(/^([ \t]*)%%[ \t]*$/gm, '$1%% .'), 'chart'); });
      })]);
    }
    this.el.notices.replaceChildren(...items);
    this.padUnderNotices();
  }

  /** The bars cover the top of the Syntax pane, so its text starts below them and line 1 stays readable. */
  private padUnderNotices(): void {
    const covered = this.el.notices.childElementCount ? this.el.notices.offsetHeight + 8 : 0;
    this.el.area.style.paddingTop = covered ? `${String(12 + covered)}px` : '';
  }

  private toastTimer: number | undefined;
  private toast(message: string): void {
    this.el.toast.textContent = message;
    this.el.toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.el.toast.hidden = true; }, 6500);
  }

  /**
   * The About button and the × of the flowchart's description (T1.13). A description of
   * the flowchart being written goes into the file as its panel goes, as an item's does
   * when the panel turns away from it (C36).
   */
  private setAbout(on: boolean): void {
    if (on === this.about) return;
    const draft = this.sidebar.draft();
    if (!on && draft?.id === FLOWCHART_ID) void this.writeDescription(draft.id, draft.text);
    this.showAbout(on);
  }

  private showAbout(on: boolean): void {
    this.about = on;
    this.el.about.setAttribute('aria-pressed', String(on));
    remember('about', on ? 'shown' : 'hidden');
    this.paint();
  }

  private toggleText(show?: boolean): void {
    const visible = show ?? this.el.pane.hidden;
    this.el.pane.hidden = !visible;
    this.el.textToggle.setAttribute('aria-pressed', String(visible));
    remember('syntaxpane', visible ? 'shown' : 'hidden');
    this.paintNotices(); // a notice's Show syntax button is there only while the pane is hidden
  }

  // ------------------------------------------------------------------ input

  private bind(): void {
    this.root.addEventListener('click', (e) => {
      const act = (e.target as Element).closest<HTMLElement>('button[data-act]')?.dataset.act;
      if (act === 'open') void this.pickAndOpen();
      if (act === 'new') void this.newFile();
      if (act === 'add') void this.addNode(null);
      if (act === 'undo') void this.history(true);
      if (act === 'redo') void this.history(false);
      if (act === 'fit') this.chart.fit();
      if (act === 'syntax') this.toggleText();
      if (act === 'highlight') this.setHighlighting(!this.hlOn);
      if (act === 'clear') void this.clearHighlights();
      if (act === 'view') void this.setViewing(!this.viewing);
      if (act === 'about') this.setAbout(!this.about);
    });
    this.el.dir.addEventListener('change', () => { void this.edit({ kind: 'setDirection', dir: this.el.dir.value }); });

    this.el.area.addEventListener('input', () => {
      window.clearTimeout(this.textTimer);
      this.textTimer = window.setTimeout(() => { this.textTimer = undefined; void this.queue(() => this.takeTypingNow()); }, 220);
    });
    this.el.area.addEventListener('keydown', (e) => {
      if (this.viewing) {
        // The pane is read-only: a key that would change its text shows why it does not.
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        const typing = !mod && !e.altKey && (e.key.length === 1 || key === 'enter' || key === 'backspace' || key === 'delete');
        if (typing || (mod && ['v', 'x', 'z', 'y'].includes(key))) this.viewBlocked();
        return; // Tab moves on, as in any read-only box
      }
      if (e.key !== 'Tab') return;
      e.preventDefault();
      this.el.area.setRangeText('    ', this.el.area.selectionStart, this.el.area.selectionEnd, 'end');
      this.el.area.dispatchEvent(new Event('input'));
    });

    // Drag the text pane's right edge to resize it.
    this.el.pane.addEventListener('pointerdown', (e) => {
      const r = this.el.pane.getBoundingClientRect();
      if (e.clientX < r.right - 6) return;
      e.preventDefault();
      this.el.pane.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => { this.el.pane.style.width = `${Math.max(220, Math.min(window.innerWidth * 0.7, m.clientX - r.left))}px`; };
      const up = () => {
        this.el.pane.removeEventListener('pointermove', move);
        remember('textpane-width', String(Math.round(this.el.pane.getBoundingClientRect().width)));
      };
      this.el.pane.addEventListener('pointermove', move);
      this.el.pane.addEventListener('pointerup', up, { once: true });
    });

    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') { e.preventDefault(); void this.save(true); return; }
      if (mod && key === 'o') { e.preventDefault(); if (this.backend.kind !== 'served') void this.pickAndOpen(); return; }
      const typing = (e.target as Element).closest('input, textarea, select, [contenteditable]');
      if (typing) return;
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); void this.history(true); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); void this.history(false); }
      else if (key === 'delete' || key === 'backspace') { e.preventDefault(); this.deleteSelection(); }
      else if (key === 'escape') { if (this.hlOn) this.setHighlighting(false); else this.select(null); }
      else if (key === 'h' && !mod && !e.altKey && !this.el.highlight.disabled) this.setHighlighting(!this.hlOn);
      else if ((key === 'enter' || key === 'f2') && this.selection) {
        e.preventDefault();
        if (this.viewing) this.viewBlocked(); // it puts the cursor in the title, to type a new one
        else this.sidebar.focusTitle();
      }
    });

    window.addEventListener('beforeunload', (e) => {
      // A change not yet on disk: the browser asks before the page goes. (The desktop
      // app's window asks in canClose, before the page is unloaded.)
      const waiting = this.path !== null && (this.textTimer !== undefined || this.text !== this.saved || this.displaced || this.sidebar.draft() !== null || this.sidebar.typed() !== null || this.sidebar.writing());
      void this.flushSave();
      if (waiting && this.backend.kind !== 'desktop') {
        e.preventDefault();
        e.returnValue = true;
      }
    });
  }
}
