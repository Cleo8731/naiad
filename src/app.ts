// The app: one open file, kept as text. The chart, the text pane and the sidebar are
// three views of that text; every change from any of them becomes new text, which is
// drawn again and saved to the file. A change to the file on disk comes back the same way.

import type { Backend } from './backend';
import { Chart, configureMermaid, type Target } from './chart';
import { getDescriptions } from './core/descriptions';
import { EditError, parseLink } from './core/edits';
import { plainText, withEndingsOf } from './core/endings';
import { itemOf, parseHighlights, resolveHighlights, toggleInFile } from './core/highlights';
import { findAgain, findBlocks, isMarkdownPath, putBlock, type Block } from './core/markdown';
import { nodeLabel, parseDoc, type Doc } from './core/scan';
import { snapshot, type Snap } from './semantics';
import { NEW_GROUP, Sidebar, type View } from './sidebar';
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
  return found.length === then.length ? found[then.indexOf(index)] : null;
}

function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage can be unavailable; the app works without it */ }
  return null;
}

/** A Markdown file: the whole file as last read or written, and the Mermaid block shown. */
interface MarkdownFile {
  file: string;
  blocks: Block[];
  /** Index into `blocks` (all Mermaid blocks, flowchart or not). */
  index: number;
  /** Set when the block could not be found again after the file changed on disk. */
  gone: boolean;
}

export class App {
  /** The flowchart's text: the whole `.mmd` file, or the block shown from a Markdown file. */
  private text = '';
  /** The flowchart's text as last read from or written to disk. */
  private saved = '';
  private md: MarkdownFile | null = null;
  private blockError: string | null = null;
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

  private chart!: Chart;
  private sidebar!: Sidebar;
  private el!: {
    name: HTMLElement; status: HTMLElement; area: HTMLTextAreaElement; notices: HTMLElement; stage: HTMLElement;
    empty: HTMLElement; toast: HTMLElement; dir: HTMLSelectElement; undo: HTMLButtonElement; redo: HTMLButtonElement;
    add: HTMLButtonElement; textToggle: HTMLButtonElement; pane: HTMLElement; fit: HTMLButtonElement;
    block: HTMLSelectElement; highlight: HTMLButtonElement; clear: HTMLButtonElement;
  };

  constructor(private root: HTMLElement, private backend: Backend) {}

  async init(): Promise<void> {
    this.root.innerHTML = `
      <header class="bar">
        <button data-act="open" title="Open a file (Ctrl+O)">Open</button>
        <button data-act="new" title="Start a new flowchart file">New</button>
        <div class="file">
          <span class="name"></span>
          <select data-act="block" title="Which flowchart of this file to show" aria-label="Which flowchart of this file to show" hidden></select>
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
        <button data-act="highlight" title="Highlight: click nodes, arrows and groups to mark them, for you and the agent to point at (H)" aria-pressed="false">Highlight</button>
        <button data-act="clear" title="Take every highlight off" hidden>Clear</button>
        <button data-act="fit" title="Fit the chart to the window">Fit</button>
        <button data-act="text" title="Show or hide the flowchart's text" aria-pressed="true">Text</button>
      </header>
      <main>
        <section class="textpane">
          <textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" aria-label="The flowchart's text"></textarea>
          <div class="notices"></div>
        </section>
        <section class="stage" tabindex="-1">
          <div class="empty" hidden>
            <h1>No file open</h1>
            <p>Open a Mermaid flowchart file (<code>.mmd</code>), or a Markdown file (<code>.md</code>) with a flowchart in it, to view and edit it.</p>
            <p><button class="primary" data-act="open">Open a file</button> <button data-act="new">New flowchart</button></p>
          </div>
        </section>
        <aside class="sidebar" hidden></aside>
      </main>
      <div class="toast" role="status" hidden></div>`;
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.el = {
      name: q('.name'), status: q('.status'), area: q('textarea'), notices: q('.notices'), stage: q('.stage'),
      empty: q('.empty'), toast: q('.toast'), dir: q('[data-act="dir"]'), undo: q('[data-act="undo"]'),
      redo: q('[data-act="redo"]'), add: q('[data-act="add"]'), textToggle: q('[data-act="text"]'), pane: q('.textpane'),
      fit: q('[data-act="fit"]'), block: q('[data-act="block"]'), highlight: q('[data-act="highlight"]'),
      clear: q('[data-act="clear"]'),
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
      onAddNode: () => { void this.addNode(null); },
      onRename: (t) => { this.select(t); this.sidebar.focusTitle(); },
    });
    this.sidebar = new Sidebar(this.root.querySelector<HTMLElement>('.sidebar')!, {
      close: () => this.select(null),
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
      setEdgeLabel: async (index, label) => (await this.edit({ kind: 'setEdgeLabel', index, label })) !== null,
      setEdgeStroke: (index, stroke) => { void this.edit({ kind: 'setEdgeStyle', index, stroke }); },
      setEdgeArrow: (index, arrow) => { void this.edit({ kind: 'setEdgeStyle', index, arrow }); },
      deleteEdge: (index) => { void this.edit({ kind: 'deleteEdge', index }); },
      renameGroup: async (id, title) => (await this.edit({ kind: 'renameSubgraph', id, title })) !== null,
      setGroupDirection: (id, dir) => { void this.edit({ kind: 'setSubgraphDirection', id, dir: dir || null }); },
      addNodeIn: (id) => { void this.addNode(id); },
      ungroup: (id) => { void this.edit({ kind: 'ungroup', id }); },
      openLink: (url) => this.backend.openLink(url),
    });

    this.bind();
    if (remember('textpane') === 'hidden') this.toggleText(false);
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
    const here = () => this.selection?.kind === 'node' && this.selection.id === id;
    if (!here()) {
      const title = nodeLabel(this.doc, id)?.title ?? id;
      if (!this.snap?.nodes[id]) return;
      if (await this.backend.confirm(`The description you were writing for “${title}” could not be saved. Lose it?`)) return;
      if (!this.snap?.nodes[id]) return;
      if (!here()) this.select({ kind: 'node', id });
    }
    this.sidebar.resumeDescription(id, text);
  }

  /** The question asked before an edit that only Undo holds (`displaced`) is lost. */
  private displacedQuestion(what: string): string {
    return `Your last edit to ${basename(this.path ?? '')} was not written: the file changed on disk first. Undo brings it back until you leave this flowchart. ${what} and lose it?`;
  }

  /** Why the text shown cannot be saved, for a question: ' (…)' or ''. */
  private unsavedWhy(): string {
    if (this.blockError) return ' (the text would end the Mermaid block early)';
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
    let index = -1;
    if (isMarkdownPath(path)) {
      // Looked at before anything is changed, so a file with no flowchart leaves the open one as it is.
      index = findBlocks(plainText(raw)).findIndex((b) => b.flowchart);
      if (index < 0) {
        this.toast(`${basename(path)} holds no Mermaid flowchart block.`);
        return;
      }
    }
    if (!(await this.leave(`Open ${basename(path)}`))) return;
    this.stopWatch?.();
    this.path = path;
    this.displaced = false;
    const body = plainText(raw);
    this.md = index < 0 ? null : { file: body, blocks: findBlocks(body), index, gone: false };
    this.text = this.saved = this.md ? this.md.blocks[index].text : body;
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
      let disk = plainText(raw);
      // Our own save, or nothing really changed. While the block shown is gone, `md.file`
      // is the file from before it went: the file coming back as it was is a change (C5).
      if (disk === (this.md ? this.md.file : this.saved) && !this.md?.gone) return;
      this.changedOutside = Date.now();
      if (this.md) {
        if (this.md.gone) this.note = '';
        const blocks = findBlocks(disk);
        const index = findAgain(this.md.file, this.md.blocks, disk, blocks, this.md.index);
        if (index < 0) {
          this.md = { ...this.md, gone: true };
          this.note = 'The flowchart block shown cannot be found after the change on disk: open the file again';
          this.paint();
          return;
        }
        this.md = { file: disk, blocks, index, gone: false };
        disk = blocks[index].text;
      }
      await this.takeTypingNow(); // typed while the file was read or this job waited (C25)
      const hadUnsaved = this.text !== this.saved;
      if (disk === this.saved) {
        // Only the Markdown around the flowchart changed: an unsaved edit still stands.
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

  /** Why the flowchart can be shown but not changed, or null. */
  private locked(): string | null {
    if (!this.md) return null;
    if (this.md.gone) return 'its block is no longer in the file.';
    return this.md.blocks[this.md.index]?.locked ?? null;
  }

  private async pickBlock(index: number): Promise<void> {
    if (!(await this.writeDraft())) { this.paintBar(); return; }
    await this.flushSave();
    await this.work;
    const block = this.md?.blocks[index];
    if (!this.md || !block || index === this.md.index) { this.paintBar(); return; }
    if (this.text !== this.saved) {
      this.toast('This flowchart holds a change that is not saved (a syntax error?). Fix it or undo it before showing another one.');
      this.paintBar();
      return;
    }
    if (this.displaced && !(await this.backend.confirm(this.displacedQuestion('Show another flowchart')))) {
      this.paintBar();
      return;
    }
    // Looked up again: the file may have changed on disk while the question was open.
    const now = this.md?.blocks[index];
    if (!this.md || !now?.flowchart || this.text !== this.saved) { this.paintBar(); return; }
    this.md = { ...this.md, index }; // a new object: a save under way sees the change (saveNow)
    this.text = this.saved = now.text;
    this.displaced = false;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.snap = null;
    this.el.area.value = this.text;
    this.chart.resetView();
    await this.queue(() => this.refresh(true));
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
    const md = this.md;
    if (!path || this.text === this.saved || this.locked()) return;
    if ((this.error || this.blockError) && !force) { this.paintBar(); return; }
    const text = this.text;
    try {
      // If the file changed since it was last read, take that change in rather than overwrite it.
      const raw = await this.backend.read(path);
      if (path !== this.path || md !== this.md) return; // another file or flowchart is shown now
      if (plainText(raw) !== (md ? md.file : this.saved)) { await this.takeDisk(); return; }
      // In a Markdown file only the block's own lines are replaced; putBlock reads the result back.
      const out = md ? putBlock(md.file, md.index, text) : text;
      // Every line keeps the line ending it has on disk now. The write is refused if the
      // file changed after it was read (bug hunt C7); that change is then taken in.
      if (!(await this.backend.write(path, withEndingsOf(raw, out), raw))) { await this.takeDisk(); return; }
      if (md) this.md = { ...md, file: out, blocks: findBlocks(out) };
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
    let typed = this.typed();
    if (this.md && typed !== '' && !typed.endsWith('\n')) typed += '\n'; // as `apply` puts it in
    return typed !== this.text && !this.locked();
  }

  /**
   * Puts in a new text. Called only from a job of the queue, so that whatever the new
   * text was made from (an edit, a reading of the file) is still the text shown.
   */
  private async apply(next: string, source: Source): Promise<void> {
    // Inside a Markdown block the last line always ends with a newline (the closing fence follows).
    if (this.md && next !== '' && !next.endsWith('\n')) next += '\n';
    if (next === this.text) return;
    if (source !== 'disk' && this.locked()) return;
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
    this.blockError = null;
    if (this.md && !this.locked()) {
      try { putBlock(this.md.file, this.md.index, this.text); } catch (e) { this.blockError = errorText(e); }
    }
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

  /**
   * After a new text, keeps the selection on its item. An arrow whose number changed (one
   * added or taken away above it) is followed, with the panel and what is typed in it
   * (bug hunt round 7, C55, oC55). An item no longer there is let go; what was typed for
   * it in the panel cannot be written anywhere, so Naiad says so and shows the text.
   */
  /** The arrow an edit of its label or style is putting in, and how it reads after (`edit`). */
  private edited: { index: number; after: string } | null = null;

  private keepSelection(before: Snap | null): void {
    const s = this.selection;
    const snap = this.snap;
    if (!s || !snap) return;
    let name: string;
    if (s.kind === 'node') {
      if (s.id in snap.nodes) return;
      name = `“${before?.nodes[s.id]?.text ?? s.id}”`;
    } else if (s.kind === 'sub') {
      if (s.id in snap.subs) return;
      name = `The group “${before?.subs[s.id]?.title || s.id}”`;
    } else {
      const edited = this.edited?.index === s.index ? this.edited.after : null;
      const found = edited === null ? -1 : snap.edges.findIndex((e) => JSON.stringify(e) === edited);
      const at = edited === null ? followEdge(before, snap, s.index) : found >= 0 ? found : null;
      if (at === s.index) return;
      if (at !== null) {
        this.sidebar.renumber(s.index, at);
        this.selection = { kind: 'edge', index: at };
        return;
      }
      const e = before?.edges[s.index];
      const end = (id: string) => before?.nodes[id]?.text ?? before?.subs[id]?.title ?? id;
      name = e ? `The arrow from “${end(e.start)}” to “${end(e.end)}”` : 'The arrow';
    }
    const lost = this.sidebar.typed() ?? (() => { const d = this.sidebar.draft(); return d && { what: 'description', text: d.text }; })();
    if (lost) {
      const text = lost.text.length > 120 ? `${lost.text.slice(0, 120)}…` : lost.text;
      this.toast(`${name} is no longer in the flowchart, so the ${lost.what} you were typing for it was not saved: “${text}”`);
    }
    this.selection = null;
  }

  private async edit(op: Op): Promise<OpResult | null> {
    await this.takeTyping();
    let result: OpResult | null = null;
    // Checked and put in as one job, so a reload can never land between the two.
    await this.queue(async () => {
      let before: Snap | null;
      let res: OpResult;
      do {
        await this.takeTypingNow(); // typed while this job waited (C25)
        before = this.snap;
        const why = this.locked();
        if (why) {
          this.toast(`This flowchart can be shown but not changed here: ${why}`);
          this.paint();
          return;
        }
        try {
          res = await applyChecked(this.text, op);
        } catch (e) {
          this.toast(e instanceof EditError ? e.message : errorText(e));
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

  private async addNode(parent: string | null): Promise<void> {
    const sel = this.selection;
    const into = parent ?? (sel?.kind === 'sub' ? sel.id : null);
    if (!(await this.writeDraft())) return; // the new node takes the panel (C36)
    const res = await this.edit({ kind: 'addNode', title: 'New node', parent: into });
    if (res) this.sidebar.focusTitle();
  }

  /**
   * Undo (back) or Redo, as one job of the queue. The stacks are looked up in it, after
   * the typing is taken in, since taking it in (or a reload) empties Redo. While the
   * flowchart is locked both stacks stay as they are (bug hunt C9). An Undo that would
   * take back a change made on disk asks first, since it saves over that change (C3).
   */
  private async history(back: boolean): Promise<void> {
    await this.takeTyping();
    await this.queue(async () => {
      await this.takeTypingNow(); // typed while this job waited (C25)
      const [from, to] = back ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
      const step = from[from.length - 1];
      if (!step) return;
      const why = this.locked();
      if (why) {
        this.toast(`This flowchart can be shown but not changed here: ${why}`);
        return;
      }
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
    const draft = this.sidebar.draft();
    if (draft && !(target?.kind === 'node' && target.id === draft.id)) {
      void this.writeDescription(draft.id, draft.text);
    }
    this.selection = target;
    this.paint();
  }

  private deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'node') void this.edit({ kind: 'deleteNode', id: s.id });
    else if (s.kind === 'edge') void this.edit({ kind: 'deleteEdge', index: s.index });
    else void this.edit({ kind: 'ungroup', id: s.id });
  }

  // ------------------------------------------------------------------ painting

  private view(): View | null {
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
    const title = (id: string) => nodeLabel(this.doc, id)?.title ?? snap.subs[id]?.title ?? id;
    const arrow = ({ arrow_point: 'arrow', arrow_open: 'none', double_arrow_point: 'both', arrow_circle: 'circle', arrow_cross: 'cross' } as const)[e.type] ?? 'arrow';
    let label = e.text;
    const ref = this.doc.edges[s.index];
    if (ref) {
      try { label = parseLink(this.doc.info[ref.line].chains![ref.chain].links[ref.link].raw).label; } catch { /* keep Mermaid's text */ }
    }
    return { kind: 'edge', index: s.index, from: title(e.start), to: title(e.end), label, stroke: e.stroke as never, arrow };
  }

  private paint(): void {
    const open = this.path !== null;
    this.el.empty.hidden = open;
    this.el.area.disabled = !open;
    this.el.area.readOnly = this.locked() !== null;
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
    this.paintBlocks();
    let status = '';
    let state = '';
    if (open) {
      if (/^(Could not|The file cannot|The flowchart block)/.test(this.note)) { status = this.note; state = 'bad'; }
      else if (this.text === this.saved) status = this.note || 'Saved';
      else if (this.blockError) { status = 'Not saved: the text would end the Mermaid block early'; state = 'bad'; }
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

  /** The list of flowcharts, shown only for a Markdown file that holds more than one. */
  private blocksShown = '';
  private paintBlocks(): void {
    const md = this.md;
    const list = md ? md.blocks.flatMap((b, i) => (b.flowchart || i === md.index ? [{ b, i }] : [])) : [];
    const shown = list.length > 1 ? list.map(({ b, i }) => `${i}\t${b.heading}\t${b.open}`).join('\n') : '';
    if (shown !== this.blocksShown) {
      this.blocksShown = shown;
      this.el.block.replaceChildren(...(shown ? list : []).map(({ b, i }) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${b.heading || 'Flowchart'} (line ${b.open + 1})`;
        return o;
      }));
    }
    this.el.block.hidden = !shown;
    if (md && shown) this.el.block.value = String(md.index);
  }

  /** A line of the flowchart's text, named for a notice; in a Markdown file, with its line in the file. */
  private lineName(line: number): string {
    const block = this.md?.blocks[this.md.index];
    return block && !this.md!.gone ? `${line + 1} (line ${block.open + line + 2} of the file)` : String(line + 1);
  }

  private paintNotices(): void {
    const items: HTMLElement[] = [];
    const notice = (cls: string, text: string, action?: { label: string; run: () => void }) => {
      const div = document.createElement('div');
      div.className = `notice ${cls}`;
      div.append(text);
      if (action) {
        const b = document.createElement('button');
        b.textContent = action.label;
        b.addEventListener('click', action.run);
        div.append(' ', b);
      }
      items.push(div);
    };
    const why = this.locked();
    if (why) notice('warn', `This flowchart can be shown but not changed here: ${why} Change it in the Markdown file.`);
    if (this.blockError) notice('bad', `${this.blockError} It is not saved.`);
    if (this.error) notice('bad', `Mermaid cannot read this text, so the chart shows the last good version.\n${this.error}`);
    else if (this.doc.problems.length) {
      const p = this.doc.problems[0];
      notice('warn', `Line ${this.lineName(p.line)}: ${p.message} The chart can show this file but will not edit it; change it here.`);
    }
    if (this.doc.warnings.length && !why) {
      const lines = this.doc.warnings.map((w) => this.lineName(w.line)).join(', ');
      notice('warn', `Line ${lines}: a bare "%%" is drawn as a node by other Mermaid tools.`, {
        label: 'Change to "%% ."',
        run: () => { void this.queue(async () => { await this.takeTypingNow(); await this.apply(this.text.replace(/^([ \t]*)%%[ \t]*$/gm, '$1%% .'), 'chart'); }); },
      });
    }
    this.el.notices.replaceChildren(...items);
  }

  private toastTimer: number | undefined;
  private toast(message: string): void {
    this.el.toast.textContent = message;
    this.el.toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.el.toast.hidden = true; }, 6500);
  }

  private toggleText(show?: boolean): void {
    const visible = show ?? this.el.pane.hidden;
    this.el.pane.hidden = !visible;
    this.el.textToggle.setAttribute('aria-pressed', String(visible));
    remember('textpane', visible ? 'shown' : 'hidden');
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
      if (act === 'text') this.toggleText();
      if (act === 'highlight') this.setHighlighting(!this.hlOn);
      if (act === 'clear') void this.clearHighlights();
    });
    this.el.dir.addEventListener('change', () => { void this.edit({ kind: 'setDirection', dir: this.el.dir.value }); });
    this.el.block.addEventListener('change', () => { void this.pickBlock(Number(this.el.block.value)); });

    this.el.area.addEventListener('input', () => {
      window.clearTimeout(this.textTimer);
      this.textTimer = window.setTimeout(() => { this.textTimer = undefined; void this.queue(() => this.takeTypingNow()); }, 220);
    });
    this.el.area.addEventListener('keydown', (e) => {
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
      else if ((key === 'enter' || key === 'f2') && this.selection) { e.preventDefault(); this.sidebar.focusTitle(); }
    });

    window.addEventListener('beforeunload', (e) => {
      // A change not yet on disk: the browser asks before the page goes. (The desktop
      // app's window asks in canClose, before the page is unloaded.)
      const waiting = this.path !== null && (this.textTimer !== undefined || this.text !== this.saved || this.displaced || this.sidebar.draft() !== null || this.sidebar.typed() !== null);
      void this.flushSave();
      if (waiting && this.backend.kind !== 'desktop') {
        e.preventDefault();
        e.returnValue = true;
      }
    });
  }
}
