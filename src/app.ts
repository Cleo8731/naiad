// The window: the toolbar, the recent list, the choices made for the whole window (View
// mode, About, the Touchpad and Mouse switch, the Highlight switch, the Syntax pane), the
// keyboard, and closing. The open file is a tab (src/tab.ts), which keeps its text, its
// chart, its sidebar and its Syntax pane's text, and saves it.

import type { Backend } from './backend';
import { configureMermaid, type Target, type WheelMode } from './chart';
import { FLOWCHART_ID } from './core/descriptions';
import { ICONS } from './icons';
import { RecentPane } from './recent';
import type { Sidebar } from './sidebar';
import { basename, errorText, Tab, type TabWindow } from './tab';

const NEW_FILE = 'flowchart TD\n    start[Start]\n';
/**
 * The View button's tooltip. Like Obsidian's, its icon shows where a click goes (Q131):
 * the open book while editing, the pencil in View mode.
 */
const VIEW_TIP = {
  editing: 'Editing. Click for View mode, to read the chart without changing it',
  viewing: 'View mode: reading without changing. Click to edit',
};
/**
 * The Touchpad and Mouse switch (D1.5, the user's option): its icon and label show the
 * mode it is in, and its tooltip what a click changes. Touchpad at the first start.
 */
const WHEEL_TIP: Record<WheelMode, string> = {
  touchpad: 'Touchpad mode: two fingers move the chart, a pinch zooms. Click for Mouse mode, where the wheel zooms',
  mouse: 'Mouse mode: the wheel zooms, a drag moves the chart. Click for Touchpad mode, where two fingers move it',
};
const WHEEL_LABEL: Record<WheelMode, string> = { touchpad: 'Touchpad mode', mouse: 'Mouse mode' };

function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage can be unavailable; the app works without it */ }
  return null;
}

export class App {
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

  /** The open file. */
  private tab!: Tab;
  private el!: {
    name: HTMLElement; status: HTMLElement; toast: HTMLElement; dir: HTMLSelectElement; undo: HTMLButtonElement;
    redo: HTMLButtonElement; add: HTMLButtonElement; textToggle: HTMLButtonElement; pane: HTMLElement; fit: HTMLButtonElement;
    highlight: HTMLButtonElement; clear: HTMLButtonElement; view: HTMLButtonElement; about: HTMLButtonElement;
    wheel: HTMLButtonElement; recentToggle: HTMLButtonElement;
  };
  /** The recent list's pane (T1.15); none in `naiad serve`'s page, which shows one file only. */
  private recent: RecentPane | null = null;

  constructor(private root: HTMLElement, private backend: Backend) {}

  async init(): Promise<void> {
    this.root.innerHTML = `
      <header class="bar">
        <button class="icon" data-act="recent" title="Show recent files" aria-label="Recent files" aria-pressed="false">${ICONS.recent}</button>
        <button data-act="open" title="Open a file (Ctrl+O)">Open</button>
        <button data-act="new" title="Start a new flowchart file">New</button>
        <div class="file">
          <span class="name"></span>
          <span class="status"></span>
        </div>
        <div class="spacer"></div>
        <button data-act="add" title="Add a node (or double-click empty space)">+ Node</button>
        <button class="icon" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${ICONS.undo}</button>
        <button class="icon" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo">${ICONS.redo}</button>
        <select data-act="dir" title="Direction of the chart" aria-label="Direction of the chart">
          <option value="TD">Top to bottom</option><option value="LR">Left to right</option>
          <option value="BT">Bottom to top</option><option value="RL">Right to left</option>
        </select>
        <!-- Clear stands before Highlight: the bar is aligned right, so when Clear appears,
             Highlight stays where it is and a second click on it never lands on Clear. -->
        <button data-act="clear" title="Take every highlight off" hidden>Clear</button>
        <button class="icon" data-act="highlight" title="Highlight: click nodes, arrows and groups to mark them, for you and the agent to point at (H)" aria-label="Highlight" aria-pressed="false">${ICONS.highlight}</button>
        <button data-act="fit" title="Fit the chart to the window">Fit</button>
        <button class="icon" data-act="wheel" title="${WHEEL_TIP.touchpad}" aria-label="${WHEEL_LABEL.touchpad}">${ICONS.touchpad}</button>
        <button class="icon" data-act="syntax" title="Show or hide the flowchart's Mermaid syntax" aria-label="Syntax" aria-pressed="false">${ICONS.syntax}</button>
        <button data-act="about" title="Show or hide the flowchart's description, shown in the sidebar when nothing is selected" aria-pressed="true">About</button>
        <button class="icon" data-act="view" title="${VIEW_TIP.editing}" aria-label="View mode" aria-pressed="false">${ICONS.read}</button>
      </header>
      <main>
        <nav class="recent" aria-label="Recent files" hidden></nav>
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
      name: q('.name'), status: q('.status'), toast: q('.toast'), dir: q('[data-act="dir"]'), undo: q('[data-act="undo"]'),
      redo: q('[data-act="redo"]'), add: q('[data-act="add"]'), textToggle: q('[data-act="syntax"]'), pane: q('.textpane'),
      fit: q('[data-act="fit"]'), highlight: q('[data-act="highlight"]'),
      clear: q('[data-act="clear"]'), view: q('[data-act="view"]'), about: q('[data-act="about"]'),
      wheel: q('[data-act="wheel"]'), recentToggle: q('[data-act="recent"]'),
    };
    const empty = q('.empty');
    if (this.backend.kind !== 'desktop') this.root.querySelectorAll('[data-act="new"]').forEach((b) => b.remove());
    if (this.backend.kind === 'served') {
      // The in-browser version shows the one file it was started for.
      this.root.querySelectorAll('[data-act="open"], [data-act="recent"], nav.recent').forEach((b) => b.remove());
      empty.innerHTML = '<h1>No file to show</h1><p>The file this page was opened for cannot be read. Ask the agent to show the flowchart again, or open the file in the Naiad app.</p>';
    }

    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    configureMermaid(dark.matches);
    dark.addEventListener('change', () => { configureMermaid(dark.matches); void this.tab.redraw(); });

    this.tab = new Tab(this.tabWindow(), {
      stage: q('.stage'), empty, area: q('textarea'), sidebar: q('.sidebar'), notices: q('.notices'),
    });

    this.bind();
    // The Syntax pane starts hidden, and opens at start only if the person left it open.
    if (remember('syntaxpane') === 'shown') this.toggleText(true);
    // Naiad opens in the mode it was last left in (Q114).
    if (remember('mode') === 'view') this.showViewing(true);
    // Touchpad or Mouse mode, as last chosen; Touchpad at the first start (D1.5).
    this.setWheelMode(remember('wheel') === 'mouse' ? 'mouse' : 'touchpad');
    // The flowchart's description shows unless the person hid it (T1.13).
    if (remember('about') === 'hidden') this.showAbout(false);
    // A notice's details wrap to another height when the window's width changes.
    window.addEventListener('resize', () => this.tab.padUnderNotices());
    const width = Number(remember('textpane-width'));
    if (width >= 220) this.el.pane.style.width = `${width}px`;
    // The recent list (T1.15), wherever Open is: hidden at the first start, then as left.
    const nav = this.root.querySelector<HTMLElement>('nav.recent');
    if (nav) {
      this.recent = new RecentPane(nav, {
        open: (path) => { void this.openRecent(path); },
        existing: (paths) => this.backend.existing(paths),
        load: () => remember('recent'),
        save: (value) => { remember('recent', value); },
      });
      if (remember('recentpane') === 'shown') this.toggleRecent(true);
      // Another window opened a file: its list is this one's too.
      window.addEventListener('storage', (e) => { if (e.key === 'recent' || e.key === null) this.recent?.reload(); });
    }

    const first = await this.backend.initialPath().catch(() => null);
    if (first) await this.open(first);
    if (!this.tab.file) this.tab.paint(); // nothing was opened: show the empty state

    // The highlights file is looked at once a second (and at once when the view comes
    // back into sight), so an agent's highlights show without Naiad watching a folder
    // that comes and goes.
    window.setInterval(() => { void this.tab.readHighlights(); }, 1000);
    document.addEventListener('visibilitychange', () => { void this.tab.readHighlights(); });
    this.backend.guardClose(() => this.canClose());
  }

  /** What the tab uses of the window: the toolbar, the window's choices, the toast. */
  private tabWindow(): TabWindow {
    const el = this.el;
    return {
      backend: this.backend,
      bar: { name: el.name, status: el.status, dir: el.dir, undo: el.undo, redo: el.redo, add: el.add, fit: el.fit, highlight: el.highlight, clear: el.clear },
      pane: el.pane,
      viewing: () => this.viewing,
      about: () => this.about,
      highlighting: () => this.hlOn,
      viewNotice: () => this.viewNotice,
      toast: (message) => this.toast(message),
      viewBlocked: () => this.viewBlocked(),
      setViewing: (on) => { void this.setViewing(on); },
      setHighlighting: (on) => this.setHighlighting(on),
      setAbout: (on) => this.setAbout(on),
      showAbout: (on) => this.showAbout(on),
      showSyntax: () => this.toggleText(true),
      opening: (path) => { this.recent?.opened(path); },
      opened: (path) => {
        this.backend.setWindowTitle(`${basename(path)} - Naiad`);
        this.backend.viewing([path]);
      },
    };
  }

  /** Whether the window may close: saves what waits to be saved, and asks before a change is lost. */
  private canClose(): Promise<boolean> {
    return this.tab.leave('Close Naiad');
  }

  // The tab's item selected, its sidebar, and its select and add steps, as the window's
  // keys and buttons use them.
  private get selection(): Target | null { return this.tab.selected; }
  private get sidebar(): Sidebar { return this.tab.sidebar; }
  private select(target: Target | null): void { this.tab.select(target); }
  private addNode(parent: string | null): Promise<void> { return this.tab.addNode(parent); }

  // ------------------------------------------------------------------ file

  async open(path: string): Promise<void> {
    await this.tab.open(path);
  }

  async moveEdgeEnd(index: number, end: 'start' | 'end', id: string): Promise<void> {
    await this.tab.moveEdgeEnd(index, end, id);
  }

  private setHighlighting(on: boolean): void {
    this.hlOn = on;
    this.tab.chart.setHighlighting(on);
    this.el.highlight.setAttribute('aria-pressed', String(on));
  }

  /**
   * The View button (Q115). Going to View, a description or a title typed in the sidebar
   * and not yet in the file is written first, as turning to another item does (C36, Q90);
   * one that cannot be written keeps Naiad in Edit mode, with the text still in its box.
   */
  private async setViewing(on: boolean): Promise<void> {
    if (on && !this.viewing) {
      const tab = this.tab;
      tab.refusal = null;
      const why = () => (tab.refusal ? `${tab.refusal} ` : '');
      if (!(await tab.writeDraft())) {
        this.toast(`${why()}The description you were writing was not saved, so Naiad stays in Edit mode.`);
        return;
      }
      const lost = await tab.writeTyped();
      if (lost) {
        this.toast(`${why()}The ${lost} you were typing was not saved, so Naiad stays in Edit mode.`);
        return;
      }
      await this.sidebar.settle(); // a description Done is writing is in the file first
    }
    this.showViewing(on);
  }

  /** Touchpad or Mouse mode (D1.5): the person's choice, kept by the app between runs. */
  private wheelMode: WheelMode = 'touchpad';

  private setWheelMode(mode: WheelMode): void {
    this.wheelMode = mode;
    this.tab.chart.setWheelMode(mode);
    this.el.wheel.innerHTML = ICONS[mode];
    this.el.wheel.title = WHEEL_TIP[mode];
    this.el.wheel.setAttribute('aria-label', WHEEL_LABEL[mode]);
    remember('wheel', mode);
  }

  private showViewing(on: boolean): void {
    this.viewing = on;
    this.tab.showViewing(on);
    this.el.view.setAttribute('aria-pressed', String(on));
    this.el.view.innerHTML = on ? ICONS.edit : ICONS.read;
    this.el.view.title = on ? VIEW_TIP.viewing : VIEW_TIP.editing;
    // The toolbar keeps the file's name, Open, New, Highlight, Fit, the Touchpad and Mouse
    // switch, Syntax, About and View.
    for (const control of [this.el.add, this.el.undo, this.el.redo, this.el.dir]) control.hidden = on;
    if (!on) this.endViewNotice();
    remember('mode', on ? 'view' : 'edit');
    this.tab.paint();
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
    this.viewNoticeTimer = window.setTimeout(() => { this.viewNotice = false; this.tab.paintNotices(); }, 6500);
    this.tab.paintNotices();
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

  /** Opens a file from the recent list, as Open does; one that cannot be read stays listed, greyed (Q137). */
  private async openRecent(path: string): Promise<void> {
    try {
      await this.open(await this.backend.choose(path));
    } catch (e) {
      this.toast(`Could not open ${basename(path)}: ${errorText(e)}`);
    }
    this.recent?.update();
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

  // ------------------------------------------------------------------ painting

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
    if (!on && draft?.id === FLOWCHART_ID) void this.tab.writeDescription(draft.id, draft.text);
    this.showAbout(on);
  }

  private showAbout(on: boolean): void {
    this.about = on;
    this.el.about.setAttribute('aria-pressed', String(on));
    remember('about', on ? 'shown' : 'hidden');
    this.tab.paint();
  }

  private toggleRecent(show?: boolean): void {
    if (!this.recent) return;
    const visible = show ?? !this.recent.visible;
    this.recent.show(visible);
    this.el.recentToggle.setAttribute('aria-pressed', String(visible));
    this.el.recentToggle.title = visible ? 'Hide recent files' : 'Show recent files';
    remember('recentpane', visible ? 'shown' : 'hidden');
  }

  private toggleText(show?: boolean): void {
    const visible = show ?? this.el.pane.hidden;
    this.el.pane.hidden = !visible;
    this.el.textToggle.setAttribute('aria-pressed', String(visible));
    remember('syntaxpane', visible ? 'shown' : 'hidden');
    this.tab.paintNotices(); // a notice's Show syntax button is there only while the pane is hidden
  }

  // ------------------------------------------------------------------ input

  private bind(): void {
    this.root.addEventListener('click', (e) => {
      const act = (e.target as Element).closest<HTMLElement>('button[data-act]')?.dataset.act;
      if (act === 'open') void this.pickAndOpen();
      if (act === 'new') void this.newFile();
      if (act === 'add') void this.addNode(null);
      if (act === 'undo') void this.tab.history(true);
      if (act === 'redo') void this.tab.history(false);
      if (act === 'fit') this.tab.chart.fit();
      if (act === 'syntax') this.toggleText();
      if (act === 'recent') this.toggleRecent();
      if (act === 'highlight') this.setHighlighting(!this.hlOn);
      if (act === 'clear') void this.tab.clearHighlights();
      if (act === 'view') void this.setViewing(!this.viewing);
      if (act === 'about') this.setAbout(!this.about);
      if (act === 'wheel') this.setWheelMode(this.wheelMode === 'touchpad' ? 'mouse' : 'touchpad');
    });
    this.el.dir.addEventListener('change', () => { void this.tab.edit({ kind: 'setDirection', dir: this.el.dir.value }); });

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
      if (mod && key === 's') { e.preventDefault(); void this.tab.save(true); return; }
      if (mod && key === 'o') { e.preventDefault(); if (this.backend.kind !== 'served') void this.pickAndOpen(); return; }
      const typing = (e.target as Element).closest('input, textarea, select, [contenteditable]');
      if (typing) return;
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); void this.tab.history(true); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); void this.tab.history(false); }
      else if (key === 'delete' || key === 'backspace') { e.preventDefault(); this.tab.deleteSelection(); }
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
      const waiting = this.tab.waiting();
      void this.tab.flushSave();
      if (waiting && this.backend.kind !== 'desktop') {
        e.preventDefault();
        e.returnValue = true;
      }
    });
  }
}
