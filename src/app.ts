// The window (its layout: the design handoff, T4.9, 2026-11-15): the rail on the left, in
// three sections (the user, 2026-11-15, answering Q158 and Q159), the tabs row, the
// recent list's pane or the Syntax pane (opening one switches the other off: the same
// answer, and the user's correction) and the sidebar
// with their grips, the Undo island and the floating pill on the shown tab's chart; the
// choices made for
// the whole window (View mode, About, the Touchpad and Mouse switch, the Highlight
// switch, the Syntax pane, Appearance, the palette, the Syntax font, the panes' widths),
// the windows laid over it (Customize, Settings), the keyboard, and closing. Each open
// file is a tab (src/tab.ts), which keeps its text, its chart, its sidebar and its
// Syntax pane's text, and saves it. One tab is shown at a time; the others keep
// everything as it was (T1.16).

import type { Backend } from './backend';
import { configureMermaid, type Target, type WheelMode } from './chart';
import { FLOWCHART_ID } from './core/descriptions';
import { ICONS } from './icons';
import {
  customizeWindow, isDark, readAppearance, readPalette, readSyntaxFont, settingsWindow,
  type Appearance, type Palette, type SyntaxFont,
} from './overlays';
import { RecentPane, samePath } from './recent';
import type { Sidebar } from './sidebar';
import { basename, errorText, Tab, type TabWindow } from './tab';

const NEW_FILE = 'flowchart TD\n    start[Start]\n';
/**
 * The mode button's tooltip. Its icon shows the mode Naiad is in (T4.9, in place of
 * Q131's "where a click goes"): the pencil in Edit mode, the open book in View mode.
 */
const VIEW_TIP = {
  editing: 'Edit mode. Click for View mode, to read the chart without changing it',
  viewing: 'View mode: the chart cannot be changed. Click for Edit mode',
};
/** The mode button's name on the rail, shown on pointing: the mode Naiad is in (Q158's answer). */
const VIEW_LABEL = { editing: 'Edit mode', viewing: 'View mode' };
/** The four directions of a chart: the file's word, its name, and its arrow's icon (T4.9). */
const DIRS = [['TD', 'Top to bottom', 'down'], ['LR', 'Left to right', 'right'], ['BT', 'Bottom to top', 'up'], ['RL', 'Right to left', 'left']] as const;
/**
 * The three panes a grip resizes (T4.9): where each width is kept, its limits and first
 * width in px, and which way a drag widens it (the sidebar's grip is on its left edge).
 */
const PANES = {
  recent: { key: 'recent-width', min: 180, max: 420, first: 232, grows: 1 },
  syntax: { key: 'textpane-width', min: 220, max: 640, first: 330, grows: 1 },
  side: { key: 'sidebar-width', min: 280, max: 560, first: 340, grows: -1 },
} as const;
type PaneName = keyof typeof PANES;
/** A grip, on the edge of a pane that faces the chart (T4.9). */
const grip = (pane: PaneName, name: string, extra = '') =>
  `<div class="grip${extra}" data-pane="${pane}" role="separator" aria-orientation="vertical" aria-label="Width of ${name}" title="Drag to resize"></div>`;
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
/**
 * The rail's two switches, Touchpad and Mouse and the mode button, as vertical sliding
 * toggles (the user, 2026-11-17): a short upright track holding both modes' icons, and a
 * knob that slides onto the one in use (`setSlide`). The track is drawn once, so the
 * knob can slide; the name beside it, shown on pointing, says the mode.
 */
const track = (first: string, second: string) =>
  `<span class="track" aria-hidden="true"><span class="knob"></span>${first}${second}</span>`;
/** Puts a sliding toggle's knob on its first (0) or second (1) mode, and names the mode. */
function setSlide(button: HTMLElement, pos: 0 | 1, label: string, tip: string): void {
  button.dataset.pos = String(pos);
  button.querySelectorAll('.track svg').forEach((svg, i) => svg.classList.toggle('on', i === pos));
  button.querySelector('.rlabel')!.textContent = label;
  button.title = tip;
}
/** A blank tab's name (Q140). */
const BLANK_NAME = 'New tab';
/** The windows laid over Naiad's, opened from the rail (T1.21, T4.8, T4.9). */
type WindowName = 'customize' | 'settings';

function remember(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage can be unavailable; the app works without it */ }
  return null;
}

function forget(key: string): void {
  try { localStorage.removeItem(key); } catch { /* as in `remember` */ }
}

/** What Remember opened files keeps (T1.23): the tabs' files in their order, and the shown tab's. */
interface Kept { files: string[]; shown: string | null }

/** The kept files, as written by `keep`; anything else is none. */
function readKept(stored: string | null): Kept {
  try {
    const v = JSON.parse(stored ?? '') as { files?: unknown; shown?: unknown };
    const files = Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === 'string') : [];
    return { files, shown: typeof v.shown === 'string' ? v.shown : null };
  } catch {
    return { files: [], shown: null };
  }
}

/** "a.mmd", "a.mmd and b.mmd", "a.mmd, b.mmd and c.mmd". */
function listed(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A tab's own parts of the window: its entry in the strip, its view, its Syntax text area. */
interface TabParts {
  item: HTMLElement;
  name: HTMLButtonElement;
  close: HTMLButtonElement;
  /** The chart area, the sidebar and the notices, hidden while another tab is shown. */
  view: HTMLElement;
  /** The chart area: the stage, the notices, the sidebar's grip, and the island and the pill while shown. */
  chartarea: HTMLElement;
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
    status: HTMLElement; toast: HTMLElement; dir: HTMLButtonElement; dirMenu: HTMLElement; undo: HTMLButtonElement;
    redo: HTMLButtonElement; add: HTMLButtonElement; textToggle: HTMLButtonElement; pane: HTMLElement; fit: HTMLButtonElement;
    highlight: HTMLButtonElement; clear: HTMLButtonElement; view: HTMLButtonElement; about: HTMLButtonElement;
    wheel: HTMLButtonElement; recentToggle: HTMLButtonElement;
    /** The Undo island and Clear beside it, and the pill (T4.9), moved to the shown tab's chart. */
    islandRow: HTMLElement; island: HTMLElement; pill: HTMLElement; pillEdit: HTMLElement;
    /** The tab strip and its +; none in `naiad serve`'s page, which shows one file. */
    strip: HTMLElement | null; plus: HTMLButtonElement; body: HTMLElement;
  };
  /** The recent list's pane (T1.15); none in `naiad serve`'s page, which shows one file only. */
  private recent: RecentPane | null = null;

  constructor(private root: HTMLElement, private backend: Backend) {}

  async init(): Promise<void> {
    // The rail (the design handoff, T4.9), in three sections (the user, 2026-11-15,
    // answering Q158 and Q159): at its top the mark, then Recent files, Syntax and About;
    // at its middle the Touchpad and Mouse switch and the mode button, each named by the
    // mode it is in; at its foot Customize and Settings. Beside it, the tabs row, the only
    // row above the chart, then the recent list's pane, the Syntax pane and the tabs' views.
    this.root.innerHTML = `
      <nav class="rail" aria-label="Naiad">
        <div class="rail-top">
          <span class="mark" aria-hidden="true"></span>
          <button data-act="recent" title="Show recent files" aria-pressed="false">${ICONS.recent}<span class="rlabel">Recent files</span></button>
          <button data-act="syntax" title="Show or hide the flowchart's Mermaid syntax" aria-pressed="false">${ICONS.syntax}<span class="rlabel">Syntax</span></button>
          <button data-act="about" title="About: show or hide the flowchart's description, shown in the sidebar when nothing is selected" aria-pressed="true">${ICONS.about}<span class="rlabel">About</span></button>
        </div>
        <div class="rail-mid">
          <button class="slide" data-act="wheel">${track(ICONS.mouse, ICONS.touchpad)}<span class="rlabel"></span></button>
          <button class="slide" data-act="view">${track(ICONS.edit, ICONS.read)}<span class="rlabel"></span></button>
        </div>
        <div class="rail-foot">
          <button data-act="customize" title="Customize: the appearance, the theme and the Syntax font">${ICONS.customize}<span class="rlabel">Customize</span></button>
          <button data-act="settings" title="Settings">${ICONS.settings}<span class="rlabel">Settings</span></button>
        </div>
      </nav>
      <div class="column">
        <header class="bar top">
          <div class="tabs" role="tablist" aria-label="Open flowcharts">
            <button class="icon" data-act="newtab" title="New tab" aria-label="New tab">${ICONS.plus}</button>
          </div>
        </header>
        <main>
          <nav class="recent" aria-label="Recent files" hidden>
            <div class="rlist"></div>
            ${grip('recent', 'Recent files')}
          </nav>
          <div class="body">
            <section class="textpane" hidden>
              <div class="pane-head">Mermaid syntax</div>
              ${grip('syntax', 'the Syntax pane')}
            </section>
          </div>
        </main>
      </div>
      <span class="status sr-only"></span>
      <div class="toast" role="status" hidden></div>`;
    // The chart's tools (T4.9), laid over the shown tab's chart (`show`): Undo and Redo in
    // an island at its top left, with Clear beside it while anything is highlighted; and
    // the floating pill at its foot: the add-node button, a plus alone (Q158's answer),
    // the direction button, Fit and Highlight. In View mode the island and the pill's
    // first part go.
    const tools = document.createElement('div');
    tools.innerHTML = `
      <div class="island-row">
        <div class="island" role="group" aria-label="Undo and Redo">
          <button class="icon" data-act="undo" title="Undo (Ctrl+Z)" aria-label="Undo">${ICONS.undo}</button>
          <button class="icon" data-act="redo" title="Redo (Ctrl+Y)" aria-label="Redo">${ICONS.redo}</button>
        </div>
        <button class="clear" data-act="clear" title="Take every highlight off" hidden>${ICONS.eraser}<span>Clear</span></button>
      </div>
      <div class="pill" role="toolbar" aria-label="The chart's tools">
        <div class="pill-edit">
          <button class="add" data-act="add" title="Add a node (or double-click empty space)" aria-label="Add a node">${ICONS.plus}</button>
          <span class="divider"></span>
          <div class="dir-wrap">
            <button class="icon" data-act="dir" aria-haspopup="menu" aria-expanded="false"></button>
            <div class="dir-menu" role="menu" aria-label="Direction of the chart" hidden>
              ${DIRS.map(([key, name, icon]) => `<button class="icon" role="menuitem" data-dir="${key}" title="${name}" aria-label="${name}">${ICONS[icon]}</button>`).join('')}
            </div>
          </div>
          <span class="divider"></span>
        </div>
        <button class="icon" data-act="fit" title="Fit the chart to the window" aria-label="Fit">${ICONS.fit}</button>
        <button class="icon" data-act="highlight" title="Highlight: click nodes, arrows and groups to mark them, for you and the agent to point at (H)" aria-label="Highlight" aria-pressed="false">${ICONS.highlight}</button>
      </div>`;
    const q = <T extends HTMLElement>(sel: string) => (this.root.querySelector<T>(sel) ?? tools.querySelector<T>(sel))!;
    this.el = {
      status: q('.status'), toast: q('.toast'), dir: q('[data-act="dir"]'), dirMenu: q('.dir-menu'), undo: q('[data-act="undo"]'),
      redo: q('[data-act="redo"]'), add: q('[data-act="add"]'), textToggle: q('[data-act="syntax"]'), pane: q('.textpane'),
      fit: q('[data-act="fit"]'), highlight: q('[data-act="highlight"]'),
      clear: q('[data-act="clear"]'), view: q('[data-act="view"]'), about: q('[data-act="about"]'),
      wheel: q('[data-act="wheel"]'), recentToggle: q('[data-act="recent"]'),
      islandRow: q('.island-row'), island: q('.island'), pill: q('.pill'), pillEdit: q('.pill-edit'),
      strip: q('.tabs'), plus: q('[data-act="newtab"]'), body: q('.body'),
    };
    this.showDirection('TD');
    setSlide(this.el.view, 0, VIEW_LABEL.editing, VIEW_TIP.editing); // Edit mode until `showViewing` says otherwise
    if (this.backend.kind === 'served') {
      // The in-browser version shows the one file it was started for: no tabs, so no
      // tabs row; no recent list, so no pane and no button for it; and no Settings, whose
      // one setting, Remember opened files, is the app's.
      this.root.querySelectorAll('header.top, nav.recent, [data-act="recent"], [data-act="settings"]').forEach((b) => b.remove());
      this.el.strip = null;
    }
    // Naiad's own title bar (T4.10; the user, 2026-11-17, Q171): the desktop window has
    // no Windows title bar, so the tabs row is the top of the window. At its right end,
    // minimize, maximize (restore while maximized) and close. A press on the row's empty
    // part, or on the rail's mark, moves the window, and a double-click maximizes it
    // (Tauri's drag script; "deep": anywhere in the row but on a button or a tab).
    const win = this.backend.windowControls;
    const top = this.root.querySelector('header.top');
    if (win && top) {
      top.setAttribute('data-tauri-drag-region', 'deep');
      this.root.querySelector('.rail .mark')!.setAttribute('data-tauri-drag-region', '');
      const box = document.createElement('div');
      box.className = 'winctl';
      box.innerHTML = `
        <button data-win="min" title="Minimize" aria-label="Minimize">${ICONS.minimize}</button>
        <button data-win="max"></button>
        <button class="winclose" data-win="close" title="Close" aria-label="Close">${ICONS.winClose}</button>`;
      const [min, max, close] = box.querySelectorAll('button');
      min.addEventListener('click', () => win.minimize());
      max.addEventListener('click', () => win.toggleMaximize());
      close.addEventListener('click', () => win.close());
      win.onMaximized((on) => {
        const name = on ? 'Restore' : 'Maximize';
        max.title = name;
        max.setAttribute('aria-label', name);
        max.innerHTML = on ? ICONS.restore : ICONS.maximize;
      });
      top.append(box);
    }
    // The panes' widths, as the person last left them (T4.9).
    for (const pane of Object.keys(PANES) as PaneName[]) {
      const kept = Number(remember(PANES[pane].key));
      this.setWidth(pane, Number.isFinite(kept) && kept > 0 ? kept : PANES[pane].first);
    }

    // Appearance (T4.8): Light, Dark, or System, which follows the computer's setting.
    this.system = window.matchMedia('(prefers-color-scheme: dark)');
    this.appearance = readAppearance(remember('appearance'));
    // The palette and the Syntax font (T4.9), as the person last chose; Naiad Default and
    // JetBrains Mono until they choose.
    this.palette = readPalette(remember('palette'));
    this.syntaxFont = readSyntaxFont(remember('syntaxfont'));
    this.applySyntaxFont();
    this.applyAppearance();
    this.system.addEventListener('change', () => this.applyAppearance());

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
    // The recent list (T1.15), wherever Open is. Whether its pane shows follows the shown
    // tab (`recentFollows`), set once the file to open at start, if any, is open.
    const nav = this.root.querySelector<HTMLElement>('nav.recent');
    if (nav) {
      this.recent = new RecentPane(nav, nav.querySelector<HTMLElement>('.rlist')!, {
        open: (path) => { void this.openRecent(path); },
        existing: (paths) => this.backend.existing(paths),
        load: () => remember('recent'),
        save: (value) => { remember('recent', value); },
      });
      // Another window opened a file: its list is this one's too.
      window.addEventListener('storage', (e) => { if (e.key === 'recent' || e.key === null) this.recent?.reload(); });
    }

    // The files of the last close (T1.23), then the file Naiad was started on, shown (Q157).
    const path = await this.backend.initialPath().catch(() => null);
    await this.reopen(path !== null);
    if (path) await this.open(path);
    this.recentFollows(this.tab);
    this.keeping = true;
    this.keep();

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
    // A blank tab (T4.9): the mark, "No file open", Open a file and New flowchart.
    const mark = '<span class="mark" role="img" aria-label="Naiad"></span>';
    const empty = this.backend.kind === 'served'
      ? `${mark}<h1>No file to show</h1><p>The file this page was opened for cannot be read. Ask the agent to show the flowchart again, or open the file in the Naiad app.</p>`
      : `${mark}<h1>No file open</h1>
         <p>Open a Mermaid flowchart file (<code>.mmd</code> or <code>.mermaid</code>) to view and edit it.</p>
         <div class="empty-acts"><button class="primary" data-act="open">${ICONS.open}Open a file</button>${this.backend.kind === 'desktop' ? `<button data-act="new">${ICONS.new}New flowchart</button>` : ''}</div>`;
    view.innerHTML = `
      <div class="chartarea">
        <section class="stage" tabindex="-1"><div class="empty" hidden><div class="empty-box">${empty}</div></div></section>
        <div class="notices"></div>
        ${grip('side', 'the sidebar', ' side')}
      </div>
      <aside class="sidebar" hidden></aside>`;
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
    this.parts.set(tab, { item, name, close, view, area, chartarea: v('.chartarea') });
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
    // The island and the pill go with the shown tab's chart (T4.9).
    this.showDirMenu(false);
    this.parts.get(tab)!.chartarea.append(this.el.islandRow, this.el.pill);
    this.paintStrip();
    this.parts.get(tab)!.item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.backend.setWindowTitle(tab.file ? `${basename(tab.file)} - Naiad` : 'Naiad');
    this.recent?.mark(tab.file);
    this.recentFollows(tab);
    tab.show();
    this.keep();
  }

  // ------------------------------------------------------------------ remember opened files

  /** Whether the tabs' files are kept for the next start: from the end of the start on (T1.23). */
  private keeping = false;
  /** While the kept files open at start: their openings leave the recent list's order as it was. */
  private reopening = false;

  /** Remember opened files (T1.23): on until the person turns it off (Q156). */
  private get remembering(): boolean { return remember('remember-files') !== 'off'; }

  /** The Settings window's switch: off forgets the kept files at once; on keeps this window's at once. */
  private setRemembering(on: boolean): void {
    remember('remember-files', on ? 'on' : 'off');
    if (on) this.keep();
    else forget('opentabs');
  }

  /**
   * Keeps the tabs' files, in their order, and the shown tab's, for the next start
   * (T1.23): at each opening, closing and showing of a tab, so they outlast a shutdown,
   * and once more as the window closes, so that of two windows the one closed last is
   * remembered. Blank tabs are not kept. `naiad serve`'s page keeps nothing.
   */
  private keep(): void {
    if (!this.keeping || this.backend.kind === 'served' || !this.remembering) return;
    const files = this.tabs.flatMap((t) => (t.file ? [t.file] : []));
    remember('opentabs', JSON.stringify({ files, shown: this.tab.file }));
  }

  /**
   * At start (T1.23, Q155): opens again the files kept at the last close, in their order,
   * and shows the one that was shown, unless a file Naiad was started on is to be shown
   * instead (`named`, Q157). Nothing opens with the switch off, or with another Naiad
   * window running: the kept files are then that window's (Q157). Files no longer there
   * are skipped, and one notice names them.
   */
  private async reopen(named: boolean): Promise<void> {
    if (this.backend.kind === 'served' || !this.remembering) return;
    const kept = readKept(remember('opentabs'));
    if (!kept.files.length || (await this.backend.otherWindow().catch(() => false))) return;
    const found = await this.backend.existing(kept.files).catch(() => kept.files.map(() => true));
    const gone = kept.files.filter((_, i) => !found[i]).map(basename);
    this.reopening = true;
    try {
      for (const [i, path] of kept.files.entries()) {
        if (!found[i]) continue;
        try {
          await this.open(await this.backend.choose(path));
        } catch (e) {
          this.toast(`Could not open ${basename(path)}: ${errorText(e)}`);
        }
      }
    } finally {
      this.reopening = false;
    }
    const shown = kept.shown === null ? undefined : this.tabs.find((t) => t.file !== null && samePath(t.file, kept.shown!));
    if (shown && !named) this.show(shown);
    if (gone.length === 1) this.toast(`${gone[0]} was not found, so it was not opened again.`);
    else if (gone.length) this.toast(`${listed(gone)} were not found, so they were not opened again.`);
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
    this.keep();
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

  /** What a tab uses of the window: the chart's tools (the island and the pill), the window's choices, the toast. */
  private tabWindow(own: () => Tab): TabWindow {
    const el = this.el;
    return {
      backend: this.backend,
      bar: {
        status: el.status, dir: el.dir, undo: el.undo, redo: el.redo, add: el.add, fit: el.fit,
        highlight: el.highlight, clear: el.clear, pill: el.pill, island: el.island,
      },
      showDirection: (dir) => this.showDirection(dir),
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
        if (!this.reopening) this.recent?.opened(path);
        if (own() === this.tab) this.recent?.mark(path);
        this.paintStrip();
      },
      opened: (path) => {
        if (own() === this.tab) this.backend.setWindowTitle(`${basename(path)} - Naiad`);
        this.backend.viewing(this.files());
        this.keep();
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
      if (!this.tabs.some((t) => !lettingGo.has(t) && t.waiting())) {
        this.keep(); // the window closed last is the one remembered (T1.23)
        return true;
      }
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
    setSlide(this.el.wheel, mode === 'mouse' ? 0 : 1, WHEEL_LABEL[mode], WHEEL_TIP[mode]);
  }

  private showViewing(on: boolean): void {
    this.viewing = on;
    for (const tab of this.tabs) tab.showViewing(on);
    // The mode button is named by the mode, so it is never "pressed" (Q158's answer).
    const mode = on ? 'viewing' : 'editing';
    setSlide(this.el.view, on ? 1 : 0, VIEW_LABEL[mode], VIEW_TIP[mode]);
    // The pill keeps Fit and Highlight, and the island goes (`Tab.paintBar`); the rail's
    // middle stays.
    this.el.pillEdit.hidden = on;
    if (on) this.showDirMenu(false);
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

  /** The direction button (T4.9): the chart's direction, and the other three in its menu. */
  private showDirection(dir: string): void {
    const [key, name, icon] = DIRS.find(([k]) => k === dir) ?? DIRS[0];
    this.el.dir.innerHTML = ICONS[icon];
    this.el.dir.title = `Direction of the chart: ${name}`;
    this.el.dir.setAttribute('aria-label', this.el.dir.title);
    for (const item of this.el.dirMenu.querySelectorAll<HTMLButtonElement>('[data-dir]')) item.hidden = item.dataset.dir === key;
  }

  /** Whether the pointer is over the direction button or its menu, which then stays open. */
  private dirHover = false;
  private dirTimer: number | undefined;

  private showDirMenu(open: boolean): void {
    window.clearTimeout(this.dirTimer);
    this.el.dirMenu.hidden = !open;
    this.el.dir.setAttribute('aria-expanded', String(open));
  }

  /** The panes' widths in px (T4.9), as the CSS variables `--recent-w`, `--syntax-w` and `--side-w` on the window. */
  private widths = {} as Record<PaneName, number>;

  private setWidth(pane: PaneName, width: number): void {
    const { min, max } = PANES[pane];
    this.widths[pane] = Math.round(Math.max(min, Math.min(max, width)));
    this.root.style.setProperty(`--${pane}-w`, `${String(this.widths[pane])}px`);
  }

  /** A drag on a pane's grip (T4.9): the pane follows the pointer, and its width is kept when it is let go. */
  private dragGrip(e: PointerEvent, grip: HTMLElement): void {
    const pane = grip.dataset.pane as PaneName;
    if (!(pane in PANES) || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = this.widths[pane];
    try { grip.setPointerCapture(e.pointerId); } catch { /* no pointer to capture */ }
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (m: PointerEvent) => this.setWidth(pane, w0 + PANES[pane].grows * (m.clientX - x0));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      grip.classList.remove('dragging');
      document.body.classList.remove('resizing');
      remember(PANES[pane].key, String(this.widths[pane]));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Appearance (T4.8): the person's choice, kept by the app between runs; System until they choose. */
  private appearance: Appearance = 'system';
  /** The computer's light or dark setting. */
  private system!: MediaQueryList;
  /** The palette (T4.9): the person's choice, kept by the app between runs; Naiad Default until they choose. */
  private palette: Palette = 'naiad-default';
  /** The Syntax pane's font (T4.9), kept the same way; JetBrains Mono until the person chooses. */
  private syntaxFont: SyntaxFont = 'jetbrains-mono';
  /** What Mermaid was last set up for: dark or light, and the palette; null before the first. */
  private look: string | null = null;
  /** The Appearance the title bar was last given; none before the first. */
  private titleBar: Appearance | null = null;

  private setAppearance(choice: Appearance): void {
    this.appearance = choice;
    remember('appearance', choice);
    this.applyAppearance();
  }

  private setPalette(choice: Palette): void {
    this.palette = choice;
    remember('palette', choice);
    this.applyAppearance();
  }

  private setSyntaxFont(choice: SyntaxFont): void {
    this.syntaxFont = choice;
    remember('syntaxfont', choice);
    this.applySyntaxFont();
  }

  /** The Syntax pane's font, through `data-syntaxfont` on the page's root (none: JetBrains Mono; `style.css`). */
  private applySyntaxFont(): void {
    const root = document.documentElement;
    if (this.syntaxFont === 'jetbrains-mono') root.removeAttribute('data-syntaxfont');
    else root.setAttribute('data-syntaxfont', this.syntaxFont);
  }

  /**
   * Draws the window, the title bar and the chart as Appearance and the palette say: the
   * page's colours through `data-theme` and `data-palette` on the page's root (none: the
   * computer's setting, and Naiad Default; `style.css`), and, when light turns to dark or
   * back or the palette changes, Mermaid set up again in the page's colours and every tab
   * drawn again (a hidden tab draws when it is shown).
   */
  private applyAppearance(): void {
    const root = document.documentElement;
    if (this.appearance === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.appearance);
    if (this.palette === 'naiad-default') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', this.palette);
    if (this.titleBar !== this.appearance) {
      this.titleBar = this.appearance;
      this.backend.setTheme(this.appearance === 'system' ? null : this.appearance);
    }
    const dark = isDark(this.appearance, this.system.matches);
    const look = `${String(dark)} ${this.palette}`;
    if (look === this.look) return;
    this.look = look;
    configureMermaid(dark);
    for (const tab of this.tabs) void tab.redraw();
  }

  /** The windows over Naiad's, each made the first time it is opened (T1.21, T4.8). */
  private windows = new Map<WindowName, HTMLDialogElement>();

  private openWindow(name: WindowName): void {
    let w = this.windows.get(name);
    if (!w) {
      w = name === 'customize'
        ? customizeWindow({
          appearance: () => this.appearance, setAppearance: (choice) => this.setAppearance(choice),
          palette: () => this.palette, setPalette: (choice) => this.setPalette(choice),
          syntaxFont: () => this.syntaxFont, setSyntaxFont: (choice) => this.setSyntaxFont(choice),
        })
        : settingsWindow({ remembering: () => this.remembering, setRemembering: (on) => this.setRemembering(on) });
      this.root.append(w);
      this.windows.set(name, w);
    }
    if (!w.open) w.showModal();
  }

  /*
   * The recent list's pane and the Syntax pane are never open together (the user,
   * 2026-11-15, Q158's answer): opening one switches the other off, as its own button
   * would, and it stays off (the user's correction the same day). Neither call below
   * opens the other pane, so they never loop.
   */
  private toggleRecent(show?: boolean): void {
    if (!this.recent) return;
    const visible = show ?? !this.recent.visible;
    this.recent.show(visible);
    this.el.recentToggle.setAttribute('aria-pressed', String(visible));
    this.el.recentToggle.title = visible ? 'Hide recent files' : 'Show recent files';
    if (visible && !this.el.pane.hidden) this.toggleText(false);
  }

  private toggleText(show?: boolean): void {
    const visible = show ?? this.el.pane.hidden !== false;
    this.el.pane.hidden = !visible;
    this.el.textToggle.setAttribute('aria-pressed', String(visible));
    remember('syntaxpane', visible ? 'shown' : 'hidden');
    // A notice's Show syntax button is there only while the pane is hidden.
    for (const tab of this.tabs) tab.paintNotices();
    if (visible && this.recent?.visible) this.toggleRecent(false);
  }

  // ------------------------------------------------------------------ input

  private bind(): void {
    this.root.addEventListener('click', (e) => {
      const target = e.target as Element;
      // The direction menu (T4.9): a direction picked changes the chart; a click anywhere
      // else but its button closes the menu.
      const picked = target.closest<HTMLElement>('.dir-menu [data-dir]')?.dataset.dir;
      if (picked) {
        this.showDirMenu(false);
        void this.tab.edit({ kind: 'setDirection', dir: picked });
        return;
      }
      if (!target.closest('.dir-wrap')) this.showDirMenu(false);
      const act = target.closest<HTMLElement>('button[data-act]')?.dataset.act;
      if (act === 'dir' && !(this.dirHover && !this.el.dirMenu.hidden)) this.showDirMenu(!!this.el.dirMenu.hidden);
      if (act === 'open') void this.pickAndOpen();
      if (act === 'new') void this.newFile();
      if (act === 'newtab') this.newTab();
      if (act === 'add') void this.addNode(null);
      if (act === 'undo') void this.tab.history(true);
      if (act === 'redo') void this.tab.history(false);
      if (act === 'fit') this.tab.chart.fit();
      if (act === 'syntax') this.toggleText();
      if (act === 'recent') this.toggleRecent();
      if (act === 'customize' || act === 'settings') this.openWindow(act);
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
    // Pointing at the direction button shows its menu; leaving both hides it, a moment
    // later, so the pointer can cross the gap between them (T4.9).
    const dirWrap = this.el.dir.parentElement!;
    dirWrap.addEventListener('mouseenter', () => {
      this.dirHover = true;
      if (!this.el.dir.disabled) this.showDirMenu(true);
    });
    dirWrap.addEventListener('mouseleave', () => {
      this.dirHover = false;
      window.clearTimeout(this.dirTimer);
      this.dirTimer = window.setTimeout(() => this.showDirMenu(false), 200);
    });

    // A drag on a pane's grip resizes the pane (T4.9).
    this.root.addEventListener('pointerdown', (e) => {
      const g = (e.target as Element).closest<HTMLElement>('.grip[data-pane]');
      if (g) this.dragGrip(e, g);
    });

    // The keys act on the shown tab only, and not while a window lies over Naiad's (T1.21).
    window.addEventListener('keydown', (e) => {
      if (this.root.querySelector('dialog[open]')) return;
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
      else if (key === 'escape') {
        if (!this.el.dirMenu.hidden) this.showDirMenu(false);
        else if (this.hlOn) this.setHighlighting(false);
        else this.select(null);
      }
      else if (key === 'h' && !mod && !e.altKey && !this.el.highlight.disabled) this.setHighlighting(!this.hlOn);
      else if ((key === 'enter' || key === 'f2') && this.selection) {
        e.preventDefault();
        if (this.viewing) this.viewBlocked(); // it puts the cursor in the title, to type a new one
        else this.sidebar.focusTitle();
      }
    });

    // The desktop window passes a touchpad pinch on to the page only with Tauri's
    // `zoomHotkeysEnabled` on (T1.24; the user, 2026-11-16), which also lets Ctrl+wheel, a
    // pinch and Ctrl with plus, minus or 0 zoom the whole window. Stop those here: the
    // chart zooms on a pinch itself (`Chart.onWheel`). A browser keeps its own zoom.
    if (this.backend.kind === 'desktop') {
      window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && ['=', '+', '-', '_', '0'].includes(e.key)) e.preventDefault();
      });
    }

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
