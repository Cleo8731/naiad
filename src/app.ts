// The window: the toolbar, the tab strip, the recent list, the choices made for the whole
// window (View mode, About, the Touchpad and Mouse switch, the Highlight switch, the
// Syntax pane), the keyboard, and closing. Each open file is a tab (src/tab.ts), which
// keeps its text, its chart, its sidebar and its Syntax pane's text, and saves it. One
// tab is shown at a time; the others keep everything as it was (T1.16).

import type { Backend } from './backend';
import { configureMermaid, type Target, type WheelMode } from './chart';
import { FLOWCHART_ID } from './core/descriptions';
import { ICONS } from './icons';
import { RecentPane, samePath } from './recent';
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
 * mode it is in, and its tooltip what a click changes. Mouse at the first start (the
 * user, 2026-11-14).
 */
const WHEEL_TIP: Record<WheelMode, string> = {
  touchpad: 'Touchpad mode: two fingers move the chart, a pinch zooms. Click for Mouse mode, where the wheel zooms',
  mouse: 'Mouse mode: the wheel zooms, a drag moves the chart. Click for Touchpad mode, where two fingers move it',
};
const WHEEL_LABEL: Record<WheelMode, string> = { touchpad: 'Touchpad mode', mouse: 'Mouse mode' };
/** A blank tab's name (Q140). */
const BLANK_NAME = 'New tab';

function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage can be unavailable; the app works without it */ }
  return null;
}

/** A tab's own parts of the window: its entry in the strip, its view, its Syntax text area. */
interface TabParts {
  item: HTMLElement;
  name: HTMLButtonElement;
  close: HTMLButtonElement;
  /** The chart area, the sidebar and the notices, hidden while another tab is shown. */
  view: HTMLElement;
  area: HTMLTextAreaElement;
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

  /** The open tabs, in the strip's order (T1.16). */
  private tabs: Tab[] = [];
  /** The tab shown. */
  private tab!: Tab;
  private parts = new Map<Tab, TabParts>();
  /** The tabs whose × was clicked and that are not yet closed, so a second click asks nothing more. */
  readonly closing = new Set<Tab>();
  /** Files are opened one at a time, so two never race for one blank tab. */
  private opens: Promise<void> = Promise.resolve();
  private el!: {
    status: HTMLElement; toast: HTMLElement; dir: HTMLSelectElement; undo: HTMLButtonElement;
    redo: HTMLButtonElement; add: HTMLButtonElement; textToggle: HTMLButtonElement; pane: HTMLElement; fit: HTMLButtonElement;
    highlight: HTMLButtonElement; clear: HTMLButtonElement; view: HTMLButtonElement; about: HTMLButtonElement;
    wheel: HTMLButtonElement; recentToggle: HTMLButtonElement;
    /** The tab strip and its +; none in `naiad serve`'s page, which shows one file. */
    strip: HTMLElement | null; plus: HTMLButtonElement; body: HTMLElement;
  };
  /** The recent list's pane (T1.15); none in `naiad serve`'s page, which shows one file only. */
  private recent: RecentPane | null = null;

  constructor(private root: HTMLElement, private backend: Backend) {}

  async init(): Promise<void> {
    // The top row: the recent list's button, then the tabs. The toolbar is the row beneath
    // them, over the chart, right of the recent list's pane (the user, 2026-11-14).
    this.root.innerHTML = `
      <header class="bar top">
        <button class="icon" data-act="recent" title="Show recent files" aria-label="Recent files" aria-pressed="false">${ICONS.recent}</button>
        <div class="tabs" role="tablist" aria-label="Open flowcharts">
          <button class="icon" data-act="newtab" title="New tab" aria-label="New tab">${ICONS.plus}</button>
        </div>
      </header>
      <main>
        <nav class="recent" aria-label="Recent files" hidden></nav>
        <div class="work">
          <div class="bar tools">
            <span class="status"></span>
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
            <button class="icon" data-act="wheel" title="${WHEEL_TIP.mouse}" aria-label="${WHEEL_LABEL.mouse}">${ICONS.mouse}</button>
            <button class="icon" data-act="syntax" title="Show or hide the flowchart's Mermaid syntax" aria-label="Syntax" aria-pressed="false">${ICONS.syntax}</button>
            <button data-act="about" title="Show or hide the flowchart's description, shown in the sidebar when nothing is selected" aria-pressed="true">About</button>
            <button class="icon" data-act="view" title="${VIEW_TIP.editing}" aria-label="View mode" aria-pressed="false">${ICONS.read}</button>
          </div>
          <div class="body">
            <section class="textpane" hidden></section>
          </div>
        </div>
      </main>
      <div class="toast" role="status" hidden></div>`;
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.el = {
      status: q('.status'), toast: q('.toast'), dir: q('[data-act="dir"]'), undo: q('[data-act="undo"]'),
      redo: q('[data-act="redo"]'), add: q('[data-act="add"]'), textToggle: q('[data-act="syntax"]'), pane: q('.textpane'),
      fit: q('[data-act="fit"]'), highlight: q('[data-act="highlight"]'),
      clear: q('[data-act="clear"]'), view: q('[data-act="view"]'), about: q('[data-act="about"]'),
      wheel: q('[data-act="wheel"]'), recentToggle: q('[data-act="recent"]'),
      strip: q('.tabs'), plus: q('[data-act="newtab"]'), body: q('.body'),
    };
    if (this.backend.kind === 'served') {
      // The in-browser version shows the one file it was started for.
      // Its top row held only the tabs and the recent list's button.
      this.root.querySelectorAll('header.top, nav.recent').forEach((b) => b.remove());
      this.el.strip = null;
    }

    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    configureMermaid(dark.matches);
    dark.addEventListener('change', () => {
      configureMermaid(dark.matches);
      for (const tab of this.tabs) void tab.redraw(); // a hidden tab draws when it is shown
    });

    // A window with no file open holds one blank tab (Q140).
    const first = this.makeTab();
    this.place(first);
    this.show(first);

    this.bind();
    // The Syntax pane starts hidden, and opens at start only if the person left it open.
    if (remember('syntaxpane') === 'shown') this.toggleText(true);
    // Naiad opens in the mode it was last left in (Q114).
    if (remember('mode') === 'view') this.showViewing(true);
    // Touchpad or Mouse mode, as the person last chose; Mouse until they choose (the
    // user, 2026-11-14). The old name, "wheel", held Touchpad written at every start,
    // chosen or not, so it is not read.
    this.setWheelMode(remember('wheelmode') === 'touchpad' ? 'touchpad' : 'mouse');
    // The flowchart's description shows unless the person hid it (T1.13).
    if (remember('about') === 'hidden') this.showAbout(false);
    // A notice's details wrap to another height when the window's width changes.
    window.addEventListener('resize', () => this.tab.padUnderNotices());
    const width = Number(remember('textpane-width'));
    if (width >= 220) this.el.pane.style.width = `${width}px`;
    // The recent list (T1.15), wherever Open is. Whether its pane shows follows the shown
    // tab (`recentFollows`), set once the file to open at start, if any, is open.
    const nav = this.root.querySelector<HTMLElement>('nav.recent');
    if (nav) {
      this.recent = new RecentPane(nav, {
        open: (path) => { void this.openRecent(path); },
        existing: (paths) => this.backend.existing(paths),
        load: () => remember('recent'),
        save: (value) => { remember('recent', value); },
      });
      // Another window opened a file: its list is this one's too.
      window.addEventListener('storage', (e) => { if (e.key === 'recent' || e.key === null) this.recent?.reload(); });
    }

    const path = await this.backend.initialPath().catch(() => null);
    if (path) await this.open(path);
    this.recentFollows(this.tab);

    // The shown tab's highlights file is looked at once a second (and at once when the
    // view comes back into sight), so an agent's highlights show without Naiad watching
    // a folder that comes and goes. A hidden tab's are read when it is shown.
    window.setInterval(() => { void this.tab.readHighlights(); }, 1000);
    document.addEventListener('visibilitychange', () => { void this.tab.readHighlights(); });
    this.backend.guardClose(() => this.canClose());
  }

  // ------------------------------------------------------------------ tabs

  /** A new blank tab with its own chart area, sidebar, notices and Syntax text; not yet in the strip. */
  private makeTab(): Tab {
    const view = document.createElement('div');
    view.className = 'tabview';
    view.hidden = true;
    const empty = this.backend.kind === 'served'
      ? '<h1>No file to show</h1><p>The file this page was opened for cannot be read. Ask the agent to show the flowchart again, or open the file in the Naiad app.</p>'
      : `<h1>No file open</h1>
         <p>Open a Mermaid flowchart file (<code>.mmd</code> or <code>.mermaid</code>) to view and edit it.</p>
         <p><button class="primary" data-act="open">Open a file</button>${this.backend.kind === 'desktop' ? ' <button data-act="new">New flowchart</button>' : ''}</p>`;
    view.innerHTML = `
      <section class="stage" tabindex="-1"><div class="empty" hidden>${empty}</div></section>
      <aside class="sidebar" hidden></aside>
      <div class="notices"></div>`;
    const area = document.createElement('textarea');
    area.spellcheck = false;
    area.setAttribute('autocomplete', 'off');
    area.setAttribute('autocapitalize', 'off');
    area.setAttribute('wrap', 'off');
    area.setAttribute('aria-label', "The flowchart's Mermaid syntax");
    area.hidden = true;
    this.el.pane.append(area);
    this.el.body.append(view);

    const item = document.createElement('div');
    item.className = 'tab';
    item.setAttribute('role', 'presentation');
    const name = document.createElement('button');
    name.className = 'tname';
    name.setAttribute('role', 'tab');
    const close = document.createElement('button');
    close.className = 'tclose';
    close.title = 'Close this tab';
    close.innerHTML = ICONS.close;
    item.append(name, close);

    const v = <T extends HTMLElement>(sel: string) => view.querySelector<T>(sel)!;
    let tab!: Tab;
    tab = new Tab(this.tabWindow(() => tab), { stage: v('.stage'), empty: v('.empty'), area, sidebar: v('.sidebar'), notices: v('.notices') });
    name.addEventListener('click', () => this.show(tab));
    close.addEventListener('click', () => { void this.closeTab(tab); });
    this.parts.set(tab, { item, name, close, view, area });
    // The window's choices hold in every tab.
    tab.showViewing(this.viewing);
    tab.chart.setWheelMode(this.wheelMode);
    tab.chart.setHighlighting(this.hlOn);
    return tab;
  }

  /** Puts a tab into the strip, right after `after`, or last. */
  private place(tab: Tab, after?: Tab): void {
    const at = after ? this.tabs.indexOf(after) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    this.paintStrip();
  }

  /** Shows a tab, as it was left; the one shown before keeps everything as it is. */
  private show(tab: Tab): void {
    const was = this.tab;
    if (tab === was) return;
    this.tab = tab;
    for (const [t, p] of this.parts) {
      p.view.hidden = t !== tab;
      p.area.hidden = t !== tab;
    }
    was?.hide();
    this.paintStrip();
    this.parts.get(tab)!.item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.backend.setWindowTitle(tab.file ? `${basename(tab.file)} - Naiad` : 'Naiad');
    this.recent?.mark(tab.file);
    this.recentFollows(tab);
    tab.show();
  }

  /**
   * Whether the recent list's pane shows follows the shown tab (the user, 2026-11-14):
   * shown on a new blank tab, hidden once a flowchart opens; going from a blank tab to a
   * flowchart's, or back, does the same. Between two tabs of one kind it stays as the
   * person left it, and its button shows and hides it at any time.
   */
  private paneFor: 'blank' | 'file' | null = null;

  /** Sets the recent list's pane for the shown tab: on a change of kind, or `always` (a new blank tab, a flowchart opened). */
  private recentFollows(tab: Tab, always = false): void {
    if (!this.recent || tab !== this.tab) return;
    const kind = tab.file ? 'file' : 'blank';
    if (kind === this.paneFor && !always) return;
    this.paneFor = kind;
    this.toggleRecent(kind === 'blank');
  }

  /** The + (Q140): a blank tab after the shown one, shown. */
  private newTab(): void {
    const tab = this.makeTab();
    this.place(tab, this.tab);
    this.show(tab);
    this.recentFollows(tab, true);
  }

  /** Closing a tab with its × (Q143): at once when nothing would be lost; otherwise Naiad shows it and asks. */
  private async closeTab(tab: Tab): Promise<void> {
    if (this.closing.has(tab)) return;
    this.closing.add(tab);
    try {
      const name = tab.file ? basename(tab.file) : 'the tab';
      if (await tab.leave(`Close ${name}`, () => this.show(tab))) this.drop(tab);
    } finally {
      this.closing.delete(tab);
    }
  }

  /**
   * Takes a tab out of the window: after `leave`, or a blank tab, which has nothing to
   * lose. The tab to its right is shown, or else the one to its left; the last tab closed
   * leaves a blank one.
   */
  private drop(tab: Tab): void {
    const at = this.tabs.indexOf(tab);
    if (at < 0) return;
    this.tabs.splice(at, 1);
    const p = this.parts.get(tab)!;
    this.parts.delete(tab);
    tab.close();
    p.item.remove();
    p.view.remove();
    p.area.remove();
    const last = !this.tabs.length;
    if (last) this.place(this.makeTab());
    if (tab === this.tab) this.show(this.tabs[Math.min(at, this.tabs.length - 1)]);
    else this.paintStrip();
    if (last) this.recentFollows(this.tab, true); // a new blank tab
    // The shell deletes the highlights file of a flowchart no view shows: the closed tab's
    // file is kept in the window's list until its highlight writes are done, so none lands
    // after the delete (bug hunt H5).
    this.draining.add(tab);
    void tab.highlightsWritten().then(() => {
      this.draining.delete(tab);
      this.backend.viewing(this.files());
    });
  }

  /** Closed tabs whose highlight writes are not done yet (`drop`). */
  private readonly draining = new Set<Tab>();

  /** The files the window shows, for the shell: its tabs', in the strip's order, then any closed tab's still writing its highlights. */
  private files(): string[] {
    return [...this.tabs, ...this.draining].flatMap((t) => (t.file ? [t.file] : []));
  }

  /** The strip: each tab's name (its file's, or New tab), the shown one marked, then the +. */
  private paintStrip(): void {
    if (!this.el.strip) return;
    const lone = this.tabs.length === 1;
    const items = this.tabs.map((tab) => {
      const p = this.parts.get(tab)!;
      const file = tab.file;
      const label = file ? basename(file) : BLANK_NAME;
      const shown = tab === this.tab;
      p.name.textContent = label;
      p.name.title = file ?? '';
      p.name.setAttribute('aria-selected', String(shown));
      p.item.classList.toggle('shown', shown);
      p.close.setAttribute('aria-label', `Close ${label}`);
      // A lone blank tab has nothing to close: closing it would leave a blank tab.
      p.close.hidden = lone && !file;
      return p.item;
    });
    this.el.strip.replaceChildren(...items, this.el.plus);
  }

  /** What a tab uses of the window: the toolbar, the window's choices, the toast. */
  private tabWindow(own: () => Tab): TabWindow {
    const el = this.el;
    return {
      backend: this.backend,
      bar: { status: el.status, dir: el.dir, undo: el.undo, redo: el.redo, add: el.add, fit: el.fit, highlight: el.highlight, clear: el.clear },
      pane: el.pane,
      shown: () => own() === this.tab,
      viewing: () => this.viewing,
      about: () => this.about,
      highlighting: () => this.hlOn,
      viewNotice: () => this.viewNotice,
      toast: (message) => {
        // A message from a hidden tab names its file.
        const tab = own();
        this.toast(tab === this.tab || !tab.file ? message : `${basename(tab.file)}: ${message}`);
      },
      viewBlocked: () => this.viewBlocked(),
      setViewing: (on) => { void this.setViewing(on); },
      setHighlighting: (on) => this.setHighlighting(on),
      setAbout: (on) => this.setAbout(on),
      showAbout: (on) => this.showAbout(on),
      showSyntax: () => this.toggleText(true),
      opening: (path) => {
        this.recent?.opened(path);
        if (own() === this.tab) this.recent?.mark(path);
        this.paintStrip();
      },
      opened: (path) => {
        if (own() === this.tab) this.backend.setWindowTitle(`${basename(path)} - Naiad`);
        this.backend.viewing(this.files());
      },
    };
  }

  /**
   * Whether the window may close: saves what waits to be saved in every tab, and asks
   * about each tab that would lose text, showing it first; No keeps the window open. A
   * tab changed after it was looked at, while a later tab saved or asked (typed into,
   * say), is looked at again, unless the person already let its text go (bug hunt H3);
   * a tab still changing after five rounds keeps the window open.
   */
  private async canClose(): Promise<boolean> {
    const lettingGo = new Set<Tab>();
    for (let round = 0; round < 5; round++) {
      for (const tab of [...this.tabs]) {
        if (round > 0 && (lettingGo.has(tab) || !tab.waiting())) continue;
        let asked = false;
        if (!(await tab.leave('Close Naiad', () => { asked = true; this.show(tab); }))) return false;
        if (asked) lettingGo.add(tab);
      }
      if (!this.tabs.some((t) => !lettingGo.has(t) && t.waiting())) return true;
    }
    return false;
  }

  // The shown tab's item selected, its sidebar, and its select and add steps, as the
  // window's keys and buttons use them.
  private get selection(): Target | null { return this.tab.selected; }
  private get sidebar(): Sidebar { return this.tab.sidebar; }
  private select(target: Target | null): void { this.tab.select(target); }
  private addNode(parent: string | null): Promise<void> { return this.tab.addNode(parent); }

  // ------------------------------------------------------------------ file

  /**
   * Opens a file: in the shown tab when it is blank, otherwise in a new tab right after
   * it, so a file's tab is never replaced (Q140, Q142). A file already open shows its
   * tab, and a blank tab it was picked from closes. One file at a time.
   */
  open(path: string): Promise<void> {
    const run = this.opens.then(() => this.openNow(path));
    this.opens = run.catch(() => {});
    return run;
  }

  private async openNow(path: string): Promise<void> {
    await this.openInTab(path);
    // A flowchart opened, or its tab shown: the recent list's pane goes (the user, 2026-11-14).
    if (this.tab.file !== null && samePath(this.tab.file, path)) this.recentFollows(this.tab, true);
  }

  private async openInTab(path: string): Promise<void> {
    const from = this.tab;
    const there = this.tabs.find((t) => t.file !== null && samePath(t.file, path));
    if (there) {
      if (there === from) return;
      this.show(there);
      if (from.file === null && !this.closing.has(from)) this.drop(from);
      return;
    }
    if (from.file === null) {
      await from.open(path);
      return;
    }
    const tab = this.makeTab();
    this.place(tab, from);
    await tab.open(path);
    if (tab.file === null) { this.drop(tab); return; } // it could not be read; the toast said so
    if (this.tabs.includes(tab)) this.show(tab);
  }

  async moveEdgeEnd(index: number, end: 'start' | 'end', id: string): Promise<void> {
    await this.tab.moveEdgeEnd(index, end, id);
  }

  private setHighlighting(on: boolean): void {
    this.hlOn = on;
    for (const tab of this.tabs) tab.chart.setHighlighting(on);
    this.el.highlight.setAttribute('aria-pressed', String(on));
  }

  /**
   * The View button (Q115). Going to View, a description or a title typed in a sidebar
   * and not yet in the file is written first, in every tab, as turning to another item
   * does (C36, Q90); one that cannot be written keeps Naiad in Edit mode, with its tab
   * shown and the text still in its box. Text typed in a sidebar while a later tab's was
   * written is written too, in another round (bug hunt H4); still typing after five
   * rounds, Naiad stays in Edit mode.
   */
  private async setViewing(on: boolean): Promise<void> {
    if (on && !this.viewing) {
      for (let round = 0; ; round++) {
        for (const tab of [this.tab, ...this.tabs.filter((t) => t !== this.tab)]) {
          tab.refusal = null;
          const why = () => (tab.refusal ? `${tab.refusal} ` : '');
          if (!(await tab.writeDraft())) {
            if (this.tabs.includes(tab)) this.show(tab);
            this.toast(`${why()}The description you were writing was not saved, so Naiad stays in Edit mode.`);
            return;
          }
          const lost = await tab.writeTyped();
          if (lost) {
            if (this.tabs.includes(tab)) this.show(tab);
            this.toast(`${why()}The ${lost} you were typing was not saved, so Naiad stays in Edit mode.`);
            return;
          }
          await tab.sidebar.settle(); // a description Done is writing is in the file first
        }
        const more = this.tabs.some((t) => t.sidebar.draft() || t.sidebar.typed() || t.sidebar.writing());
        if (!more) break;
        if (round >= 4) return;
      }
    }
    this.showViewing(on);
  }

  /** Touchpad or Mouse mode (D1.5): the person's choice, kept by the app between runs; Mouse until they choose. */
  private wheelMode: WheelMode = 'mouse';

  private setWheelMode(mode: WheelMode): void {
    this.wheelMode = mode;
    for (const tab of this.tabs) tab.chart.setWheelMode(mode);
    this.el.wheel.innerHTML = ICONS[mode];
    this.el.wheel.title = WHEEL_TIP[mode];
    this.el.wheel.setAttribute('aria-label', WHEEL_LABEL[mode]);
  }

  private showViewing(on: boolean): void {
    this.viewing = on;
    for (const tab of this.tabs) tab.showViewing(on);
    this.el.view.setAttribute('aria-pressed', String(on));
    this.el.view.innerHTML = on ? ICONS.edit : ICONS.read;
    this.el.view.title = on ? VIEW_TIP.viewing : VIEW_TIP.editing;
    // The toolbar keeps the saved state, Highlight, Fit, the Touchpad and Mouse switch,
    // Syntax, About and View.
    for (const control of [this.el.add, this.el.undo, this.el.redo, this.el.dir]) control.hidden = on;
    if (!on) this.endViewNotice();
    remember('mode', on ? 'view' : 'edit');
    for (const tab of this.tabs) tab.paint();
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

  /** Open, on a blank tab only (Q140): the file dialog, then the file in that tab. */
  private async pickAndOpen(): Promise<void> {
    try {
      const path = await this.backend.pickOpen();
      if (path) await this.open(path);
    } catch (e) {
      this.toast(errorText(e));
    }
  }

  /** Opens a file from the recent list (Q142); one that cannot be read stays listed, greyed (Q137). */
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
   * when the panel turns away from it (C36), in every tab.
   */
  private setAbout(on: boolean): void {
    if (on === this.about) return;
    if (!on) {
      for (const tab of this.tabs) {
        const draft = tab.sidebar.draft();
        if (draft?.id === FLOWCHART_ID) void tab.writeDescription(draft.id, draft.text);
      }
    }
    this.showAbout(on);
  }

  private showAbout(on: boolean): void {
    this.about = on;
    this.el.about.setAttribute('aria-pressed', String(on));
    remember('about', on ? 'shown' : 'hidden');
    for (const tab of this.tabs) tab.paint();
  }

  private toggleRecent(show?: boolean): void {
    if (!this.recent) return;
    const visible = show ?? !this.recent.visible;
    this.recent.show(visible);
    this.el.recentToggle.setAttribute('aria-pressed', String(visible));
    this.el.recentToggle.title = visible ? 'Hide recent files' : 'Show recent files';
  }

  private toggleText(show?: boolean): void {
    const visible = show ?? this.el.pane.hidden;
    this.el.pane.hidden = !visible;
    this.el.textToggle.setAttribute('aria-pressed', String(visible));
    remember('syntaxpane', visible ? 'shown' : 'hidden');
    // A notice's Show syntax button is there only while the pane is hidden.
    for (const tab of this.tabs) tab.paintNotices();
  }

  // ------------------------------------------------------------------ input

  private bind(): void {
    this.root.addEventListener('click', (e) => {
      const act = (e.target as Element).closest<HTMLElement>('button[data-act]')?.dataset.act;
      if (act === 'open') void this.pickAndOpen();
      if (act === 'new') void this.newFile();
      if (act === 'newtab') this.newTab();
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
      if (act === 'wheel') {
        // Kept only when the person chooses, so the first start's mode can change later.
        const mode = this.wheelMode === 'touchpad' ? 'mouse' : 'touchpad';
        this.setWheelMode(mode);
        remember('wheelmode', mode);
      }
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

    // The keys act on the shown tab only.
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') { e.preventDefault(); void this.tab.save(true); return; }
      if (mod && key === 'o') {
        // Open fills a blank tab only; a file's tab is never replaced (Q140).
        e.preventDefault();
        if (this.backend.kind !== 'served' && this.tab.file === null) void this.pickAndOpen();
        return;
      }
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
      // A change not yet on disk, in any tab: the browser asks before the page goes. (The
      // desktop app's window asks in canClose, before the page is unloaded.)
      const waiting = this.tabs.some((t) => t.waiting());
      for (const tab of this.tabs) void tab.flushSave();
      if (waiting && this.backend.kind !== 'desktop') {
        e.preventDefault();
        e.returnValue = true;
      }
    });
  }
}
