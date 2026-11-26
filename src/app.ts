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

import type { Arrival, Backend, ExportKind, MovedTab, Place } from './backend';
import { configureMermaid, dropTitle, type Target, type WheelMode } from './chart';
import { FLOWCHART_ID } from './core/descriptions';
import { drawingRules, pngFile, renameIds, sizeOf, styleElement, svgFile } from './export';
import { ICONS } from './icons';
import {
  customizeWindow, isDark, printWindow, readAppearance, readPalette, readSyntaxFont, settingsWindow,
  type Appearance, type Palette, type PrintChoice, type SyntaxFont,
} from './overlays';
import { layParts, measureDrawing, pageSizeRule, printSheet } from './print-sheet';
import { planFor, type Paper } from './print-pages';
import { RecentPane, samePath } from './recent';
import type { Sidebar } from './sidebar';
import { SyntaxBox } from './syntax-box';
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
 * knob can slide. On pointing (T4.13, the user's answer to Q172, 2026-11-17) the track
 * widens into two lines, each icon with its mode's name, and the knob stretches over the
 * line in use to the track's end, even on the shorter name (the user, 2026-11-18); the
 * other name stays grey. The names are
 * drawn by the style sheet from `data-name`, so the button's own name, `.rlabel`, heard
 * and not seen, stays the mode in use.
 */
const track = (first: string, firstName: string, second: string, secondName: string) =>
  `<span class="track" aria-hidden="true"><span class="knob"></span>` +
  `<span class="opt" data-name="${firstName}">${first}</span><span class="opt" data-name="${secondName}">${second}</span></span>`;
/** Puts a sliding toggle's knob on its first (0) or second (1) mode, and names the mode. */
function setSlide(button: HTMLElement, pos: 0 | 1, label: string, tip: string): void {
  button.dataset.pos = String(pos);
  button.querySelectorAll('.track .opt').forEach((opt, i) => {
    opt.classList.toggle('on', i === pos);
    opt.querySelector('svg')?.classList.toggle('on', i === pos);
  });
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

/** Which way split view lies (T1.17): side by side, or one above the other. */
type Axis = 'row' | 'col';

/**
 * What Remember opened files keeps of a window (T1.23): the tabs' files in their order,
 * and the shown tab's; while split (T1.17), also the second group's files, each group's
 * shown file, the axis and the divider's place; and the window's place (Q216). The first
 * window's is kept under "opentabs", each later window's under "openwindow:<its name>".
 */
interface Kept {
  files: string[];
  shown: string | null;
  split?: { second: string[]; shown: [string | null, string | null]; axis: Axis; at: number };
  place?: Place;
}

/** The start of the keys that keep the later windows' tabs (Q216). */
const WINDOW_KEY = 'openwindow:';
/** Where window `name`'s tabs are kept (Q216): the first window's under "opentabs", a later one's under its own name. */
function keptKeyOf(name: string): string { return name === 'main' ? 'opentabs' : `${WINDOW_KEY}${name}`; }

/** The kept files, as written by `keep`; anything else is none. */
function readKept(stored: string | null): Kept {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : []);
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  try {
    const v = JSON.parse(stored ?? '') as { files?: unknown; shown?: unknown; split?: Record<string, unknown>; place?: unknown };
    const kept: Kept = { files: strings(v.files), shown: text(v.shown) };
    const p = v.place;
    if (Array.isArray(p) && p.length === 5 && p.slice(0, 4).every((n) => Number.isInteger(n)) && typeof p[4] === 'boolean') {
      kept.place = p as Place;
    }
    const s = v.split;
    if (s && typeof s === 'object' && (s.axis === 'row' || s.axis === 'col')) {
      const shown = Array.isArray(s.shown) ? s.shown : [];
      const at = typeof s.at === 'number' && s.at > 0 && s.at < 1 ? s.at : 0.5;
      kept.split = { second: strings(s.second), shown: [text(shown[0]), text(shown[1])], axis: s.axis, at };
    }
    return kept;
  } catch {
    return { files: [], shown: null };
  }
}

/** The later windows' kept tabs (Q216), in the order the windows were made. */
function keptWindows(): { key: string; kept: Kept }[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(WINDOW_KEY)) keys.push(key);
    }
  } catch { /* as in `remember` */ }
  const number = (key: string) => Number(key.slice(WINDOW_KEY.length).replace(/^w/, '')) || 0;
  return keys.sort((a, b) => number(a) - number(b)).map((key) => ({ key, kept: readKept(remember(key)) }));
}

/** A group's strip (T1.25, T1.17): its box, the tabs' list, the list of every tab and its button, the +, and the × that closes the split. */
interface Strip {
  box: HTMLElement;
  list: HTMLElement;
  more: HTMLButtonElement;
  menu: HTMLElement;
  unsplit: HTMLButtonElement;
}

/**
 * A tab group (T1.17; the user, 2026-11-18, Q185): one half's tabs, in their strip's
 * order, and the one it shows. Unsplit, the window has one. `naiad serve`'s page has no
 * strip.
 */
interface Group {
  tabs: Tab[];
  shown: Tab;
  bar: Strip | null;
}

/** Where a dragged tab would land (T1.17, Q180): in a strip, at a place among its tabs; on an edge of the unsplit chart; or on a half. */
type Landing =
  | { kind: 'strip'; group: Group; index: number; line: number; bar: DOMRect }
  | { kind: 'edge'; side: 'left' | 'right' | 'top' | 'bottom'; zone: Box }
  | { kind: 'half'; group: Group; zone: Box };
interface Box { left: number; top: number; width: number; height: number }

const px = (n: number) => `${String(Math.round(n))}px`;
const inside = (r: DOMRect, x: number, y: number) => r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

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
  /** The Syntax pane's box around the text area: its colours and line numbers. */
  code: SyntaxBox;
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

  /** The tab groups (T1.17): one, or two while split, the first the left or top half. */
  private groups: Group[] = [];
  /** Split view's axis, and the first half's share of the two halves (the divider's place, Q182). */
  private axis: Axis = 'row';
  private at = 0.5;
  /** The open tabs, in the strips' order (T1.16): the first group's, then the second's. */
  private get tabs(): Tab[] { return this.groups.flatMap((g) => g.tabs); }
  /** The shown tab: the active half's, while split (T1.17). */
  private tab!: Tab;
  /** The tabs whose views show (one, or one per half), and the shown tab, as `render` last left them. */
  private seen = new Set<Tab>();
  private lastShown: Tab | null = null;
  /** Right after a tab was dragged: the click that ends the press doesn't show it. */
  private noClick = false;
  /** Split view's divider, and what a dragged tab shows: its copy, the lit half, the line in a strip. */
  private divider!: HTMLElement;
  private drag!: { ghost: HTMLElement; zone: HTMLElement; line: HTMLElement };
  private parts = new Map<Tab, TabParts>();
  /** The tabs whose × was clicked and that are not yet closed, so a second click asks nothing more. */
  readonly closing = new Set<Tab>();
  /** Files are opened one at a time, so two never race for one blank tab. */
  private opens: Promise<void> = Promise.resolve();
  private el!: {
    status: HTMLElement; toast: HTMLElement; dir: HTMLButtonElement; dirMenu: HTMLElement; fitMenu: HTMLElement; undo: HTMLButtonElement;
    redo: HTMLButtonElement; add: HTMLButtonElement; textToggle: HTMLButtonElement; pane: HTMLElement; fit: HTMLButtonElement;
    highlight: HTMLButtonElement; walk: HTMLButtonElement; exportButton: HTMLButtonElement; exportMenu: HTMLElement; clear: HTMLButtonElement; view: HTMLButtonElement; about: HTMLButtonElement;
    wheel: HTMLButtonElement; recentToggle: HTMLButtonElement;
    /** The Undo island and Clear beside it, and the pill (T4.9), moved to the shown tab's chart. */
    islandRow: HTMLElement; island: HTMLElement; pill: HTMLElement; pillEdit: HTMLElement;
    /** The tabs row; none in `naiad serve`'s page, which shows one file. */
    top: HTMLElement | null; body: HTMLElement;
  };
  /** The recent list's pane (T1.15); none in `naiad serve`'s page, which shows one file only. */
  private recent: RecentPane | null = null;

  constructor(private root: HTMLElement, private backend: Backend) {}

  async init(): Promise<void> {
    // The rail (the design handoff, T4.9), in three sections (the user, 2026-11-15,
    // answering Q158 and Q159): at its top the mark, then Recent files, Syntax and About;
    // at its middle the Touchpad and Mouse switch and the mode button, each named by the
    // mode it is in, then Export and Print (T6.3; the user, 2026-11-25, after trying
    // 0.3.16); at its foot Customize and Settings. Beside it, the tabs row, the only
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
          <button class="slide" data-act="wheel">${track(ICONS.mouse, WHEEL_LABEL.mouse, ICONS.touchpad, WHEEL_LABEL.touchpad)}<span class="rlabel"></span></button>
          <button class="slide" data-act="view">${track(ICONS.edit, VIEW_LABEL.editing, ICONS.read, VIEW_LABEL.viewing)}<span class="rlabel"></span></button>
          <div class="export-wrap">
            <button data-act="export" title="Export: save the chart as a picture, an SVG or a PNG" aria-haspopup="menu" aria-expanded="false">${ICONS.export}<span class="rlabel">Export</span></button>
            <div class="export-menu" role="menu" aria-label="Export" hidden>
              <button role="menuitem" data-export="svg">Save as SVG…</button><button role="menuitem" data-export="png">Save as PNG…</button>
            </div>
          </div>
          <button data-act="print" title="Print the chart, its descriptions or both (Ctrl+P)">${ICONS.print}<span class="rlabel">Print</span></button>
        </div>
        <div class="rail-foot">
          <button data-act="customize" title="Customize: the appearance, the theme and the Syntax font">${ICONS.customize}<span class="rlabel">Customize</span></button>
          <button data-act="settings" title="Settings">${ICONS.settings}<span class="rlabel">Settings</span></button>
        </div>
      </nav>
      <div class="column">
        <header class="bar top"></header>
        <main>
          <nav class="recent" aria-label="Recent files" hidden>
            <div class="rlist"></div>
            ${grip('recent', 'Recent files')}
          </nav>
          <div class="body">
            <section class="textpane" hidden>
              <div class="pane-head"><span>Mermaid syntax</span><button class="icon" data-act="syntax-full" title="Fill the window with the syntax" aria-label="Fill the window" aria-pressed="false">${ICONS.expand}</button></div>
              ${grip('syntax', 'the Syntax pane')}
            </section>
            <div class="split-divider" role="separator" aria-orientation="vertical" aria-label="Divider between the two halves" title="Drag to resize; double-click for half and half"></div>
          </div>
        </main>
      </div>
      <span class="status sr-only"></span>
      <div class="toast" role="status" hidden></div>
      <div class="tab-ghost" aria-hidden="true" hidden></div>
      <div class="drop-zone" aria-hidden="true" hidden></div>
      <div class="drop-line" aria-hidden="true" hidden></div>`;
    // The chart's tools (T4.9), laid over the shown tab's chart (`show`): Undo and Redo in
    // an island at its top left, with Clear beside it while anything is highlighted; and
    // the floating pill at its foot: the add-node button, a plus alone (Q158's answer),
    // the direction button, Fit (with its menu, Q255) and Highlight. In View mode the island and the pill's
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
        <div class="fit-wrap">
          <button class="icon" data-act="fit" title="Fit: the whole chart, then its width, in turn" aria-label="Fit" aria-haspopup="menu" aria-expanded="false">${ICONS.fit}</button>
          <div class="fit-menu" role="menu" aria-label="Fit" hidden>
            <button role="menuitem" data-fit="whole">Whole chart</button>
            <button role="menuitem" data-fit="width">Width</button>
          </div>
        </div>
        <button class="icon" data-act="highlight" title="Highlight: click nodes, arrows and groups to mark them, for you and the agent to point at (H)" aria-label="Highlight" aria-pressed="false">${ICONS.highlight}</button>
        <button class="icon" data-act="walk" title="Walkthrough: follow one run through the flowchart, node by node, from a node you click, choosing an arrow at each step; for presenting it, or reading it alone" aria-label="Walkthrough" hidden>${ICONS.walk}</button>
      </div>`;
    const q = <T extends HTMLElement>(sel: string) => (this.root.querySelector<T>(sel) ?? tools.querySelector<T>(sel))!;
    this.el = {
      status: q('.status'), toast: q('.toast'), dir: q('[data-act="dir"]'), dirMenu: q('.dir-menu'), fitMenu: q('.fit-menu'), undo: q('[data-act="undo"]'),
      redo: q('[data-act="redo"]'), add: q('[data-act="add"]'), textToggle: q('[data-act="syntax"]'), pane: q('.textpane'),
      fit: q('[data-act="fit"]'), highlight: q('[data-act="highlight"]'), walk: q('[data-act="walk"]'),
      exportButton: q('[data-act="export"]'), exportMenu: q('.export-menu'),
      clear: q('[data-act="clear"]'), view: q('[data-act="view"]'), about: q('[data-act="about"]'),
      wheel: q('[data-act="wheel"]'), recentToggle: q('[data-act="recent"]'),
      islandRow: q('.island-row'), island: q('.island'), pill: q('.pill'), pillEdit: q('.pill-edit'),
      top: q('header.top'), body: q('.body'),
    };
    this.divider = q('.split-divider');
    this.drag = { ghost: q('.tab-ghost'), zone: q('.drop-zone'), line: q('.drop-line') };
    this.showDirection('TD');
    setSlide(this.el.view, 0, VIEW_LABEL.editing, VIEW_TIP.editing); // Edit mode until `showViewing` says otherwise
    if (this.backend.kind === 'served') {
      // The in-browser version shows the one file it was started for: no tabs, so no
      // tabs row; no recent list, so no pane and no button for it; and no Settings, whose
      // one setting, Remember opened files, is the app's.
      this.root.querySelectorAll('header.top, nav.recent, [data-act="recent"], [data-act="settings"]').forEach((b) => b.remove());
      this.el.top = null;
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

    // A window with no file open holds one blank tab (Q140), in its one tab group.
    const first = this.makeTab();
    this.groups = [{ tabs: [first], shown: first, bar: this.makeStrip() }];
    this.tab = first;
    this.render();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.fitHeader()).observe(this.el.body);

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

    // The files of the last close (T1.23), then the file Naiad was started on, shown
    // (Q157). Only the program's first window does this; a later one (T6.2) is given its
    // tabs as arrivals.
    const firstWindow = this.backend.windowName === 'main';
    const path = firstWindow ? await this.backend.initialPath().catch(() => null) : null;
    const others = firstWindow ? await this.reopen(path !== null) : [];
    if (path) await this.open(path);
    this.recentFollows(this.tab);
    this.keeping = true;
    void this.keep();
    // What comes to this window (T6.1, T6.2): a file opened while Naiad runs comes here as
    // a tab (Q213), and one already open shows its tab (Q214); a tab moved in from another
    // window; the tabs this window had at the last close (Q216).
    this.backend.onArrivals((items) => { for (const item of items) this.arrive(item); });
    // A tab from another window dragged over this one: where it would land shows.
    this.backend.windows?.onDragAt(
      (x, y, name) => this.paintLanding(this.arrivalLanding(x, y).show, name),
      () => this.paintLanding(null, ''),
    );
    // A window closed on its own while this one stayed open: its tabs are forgotten
    // (Q216). Windows closed together, as the taskbar's "Close all windows" does, are
    // all remembered: the shell says this only once no other window closed meanwhile.
    // A window that is itself closing (asking about a change, say) was closed with it.
    this.backend.windows?.onForget((name) => {
      if (name !== this.backend.windowName && !this.windowClosing) forget(keptKeyOf(name));
    });
    // The other windows open at the last close come back, each with its tabs (Q216).
    void this.reopenWindows(others);

    // The shown tab's highlights file is looked at once a second (and at once when the
    // view comes back into sight), so an agent's highlights show without Naiad watching
    // a folder that comes and goes. A hidden tab's are read when it is shown.
    const readShown = () => { for (const g of this.groups) void g.shown.readHighlights(); };
    window.setInterval(readShown, 1000);
    document.addEventListener('visibilitychange', readShown);
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
    area.setAttribute('aria-label', "The flowchart's Mermaid syntax");
    const code = new SyntaxBox(area);
    code.hidden = true;
    this.el.pane.append(code.el);
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
    name.addEventListener('click', () => { if (!this.noClick) this.show(tab); });
    name.addEventListener('pointerdown', (e) => this.dragTab(e, tab));
    close.addEventListener('click', () => { void this.closeTab(tab); });
    this.parts.set(tab, { item, name, close, view, area, code, chartarea: v('.chartarea') });
    // The window's choices hold in every tab.
    tab.showViewing(this.viewing);
    tab.chart.setWheelMode(this.wheelMode);
    tab.chart.setHighlighting(this.hlOn);
    return tab;
  }

  /** A tab's group. */
  private groupOf(tab: Tab): Group | undefined {
    return this.groups.find((g) => g.tabs.includes(tab));
  }

  /** Puts a tab into the shown tab's group, right after `after`, or last. */
  private place(tab: Tab, after?: Tab): void {
    const g = (after && this.groupOf(after)) || this.groupOf(this.tab) || this.groups[0];
    const at = after && g.tabs.includes(after) ? g.tabs.indexOf(after) + 1 : g.tabs.length;
    g.tabs.splice(at, 0, tab);
    this.paintStrip();
  }

  /** Shows a tab in its group's half, as it was left, and makes that half the active one; the tab it hides keeps everything as it is. */
  private show(tab: Tab): void {
    if (tab === this.tab) return;
    const g = this.groupOf(tab);
    if (!g) return;
    g.shown = tab;
    this.tab = tab;
    this.render();
  }

  /**
   * Lays the window out for its groups and the shown tab (T1.16, T1.17): each group's
   * shown tab's view shows, in its half while split; the shown tab's Syntax text, the
   * island and the pill (T4.9), the window's title and the recent list's mark follow the
   * shown tab. A tab whose view goes is hidden; one whose view comes is shown.
   */
  private render(): void {
    const tab = this.tab;
    const split = this.groups.length > 1;
    const seen = new Set(this.groups.map((g) => g.shown));
    for (const [t, p] of this.parts) {
      p.view.hidden = !seen.has(t);
      p.code.hidden = t !== tab;
      p.view.classList.toggle('half-a', split && t === this.groups[0].shown);
      p.view.classList.toggle('half-b', split && t === this.groups[1].shown);
      p.view.classList.toggle('active', split && t === tab);
    }
    const body = this.el.body;
    body.classList.toggle('split', split);
    body.classList.toggle('split-row', split && this.axis === 'row');
    body.classList.toggle('split-col', split && this.axis === 'col');
    this.divider.setAttribute('aria-orientation', this.axis === 'row' ? 'vertical' : 'horizontal');
    this.setShare(this.at);
    for (const t of this.seen) if (!seen.has(t)) t.hide();
    this.showDirMenu(false);
    this.parts.get(tab)!.chartarea.append(this.el.islandRow, this.el.pill);
    this.placeStrips();
    this.paintStrip();
    for (const g of this.groups) this.parts.get(g.shown)!.item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    // The lists have scrolled now; their scroll events can come a frame later, or not at
    // all while the window is hidden.
    this.fitStrip();
    this.backend.setWindowTitle(tab.file ? `${basename(tab.file)} - Naiad` : 'Naiad');
    this.recent?.mark(tab.file);
    this.recentFollows(tab);
    const before = this.seen;
    const was = this.lastShown;
    this.seen = seen;
    this.lastShown = tab;
    for (const t of seen) if (t !== tab && !before.has(t)) t.show();
    if (tab !== was || !before.has(tab)) tab.show();
    void this.keep();
    this.fitHeader();
  }

  // ------------------------------------------------------------------ remember opened files

  /** Whether the tabs' files are kept for the next start: from the end of the start on (T1.23). */
  private keeping = false;
  /** While the kept files open at start: their openings leave the recent list's order as it was. */
  private reopening = false;

  /** Remember opened files (T1.23): on until the person turns it off (Q156). */
  private get remembering(): boolean { return remember('remember-files') !== 'off'; }

  /** The Settings window's switch: off forgets every window's kept files at once; on keeps this window's at once. */
  private setRemembering(on: boolean): void {
    remember('remember-files', on ? 'on' : 'off');
    if (on) { void this.keep(); return; }
    forget('opentabs');
    for (const { key } of keptWindows()) forget(key);
  }

  /** Where this window's tabs are kept (Q216): the first window's under "opentabs", a later one's under its own name. */
  private get keptKey(): string { return keptKeyOf(this.backend.windowName); }

  /**
   * This window closes because its last tab moved to another window (T6.2): its tabs are
   * not kept, since they live on there. Keeping stops, so no later write brings them back.
   */
  private forgetMine(): void {
    this.keeping = false;
    forget(this.keptKey);
  }

  /**
   * Keeps the tabs' files, in their order, and the shown tab's, for the next start
   * (T1.23), with the window's place (Q216): at each opening, closing and showing of a
   * tab, so they outlast a shutdown, and once more as the last window closes. Each window
   * keeps its own (`keptKey`). Blank tabs are not kept. `naiad serve`'s page keeps nothing.
   */
  private async keep(): Promise<void> {
    if (!this.keeping || this.backend.kind === 'served' || !this.remembering) return;
    const filesOf = (tabs: Tab[]) => tabs.flatMap((t) => (t.file ? [t.file] : []));
    const kept: Kept = { files: filesOf(this.tabs), shown: this.tab.file };
    const [a, b] = this.groups;
    if (b) kept.split = { second: filesOf(b.tabs), shown: [a.shown.file, b.shown.file], axis: this.axis, at: this.at };
    const place = this.backend.windows ? await this.backend.windows.place() : null;
    if (place) kept.place = place;
    // The window may have stopped keeping while its place was asked for (`forgetMine`).
    if (this.keeping && this.remembering) remember(this.keptKey, JSON.stringify(kept));
  }

  /**
   * At start, in the program's first window (T1.23, Q155, Q216): puts the window where it
   * was and opens again the files it kept at the last close (`restore`). With none of its
   * own, it takes the first of the other windows' (the first window was closed before
   * them). Returns the other windows' kept tabs, opened once the start is done
   * (`reopenWindows`). Nothing opens with the switch off, or with another Naiad program
   * running: the kept files are then that program's (Q157).
   */
  private async reopen(named: boolean): Promise<{ key: string; kept: Kept }[]> {
    if (this.backend.kind === 'served' || !this.remembering) return [];
    if (await this.backend.otherWindow().catch(() => false)) return [];
    let kept = readKept(remember('opentabs'));
    const others = this.backend.windows ? keptWindows() : [];
    if (!kept.files.length && others.length) {
      kept = others[0].kept;
      forget(others.shift()!.key);
    }
    if (kept.place) this.backend.windows?.putAt(kept.place);
    await this.restore(kept, named);
    return others;
  }

  /** The other windows open at the last close come back (Q216), each in a window of its own, at its place; their old keys go, as each new window keeps its own. */
  private async reopenWindows(others: { key: string; kept: Kept }[]): Promise<void> {
    const win = this.backend.windows;
    if (!win) return;
    for (const { key, kept } of others) {
      forget(key);
      if (!kept.files.length) continue;
      await win.openWindow(kept, kept.place ?? null).catch((e) => this.toast(`A window could not be opened again: ${errorText(e)}`));
    }
  }

  /**
   * Opens again the files a window kept (T1.23), in their order, and shows the one that
   * was shown, unless a file Naiad was started on is to be shown instead (`named`, Q157).
   * Files no longer there are skipped, and one notice names them.
   */
  private async restore(kept: Kept, named: boolean): Promise<void> {
    if (!kept.files.length) return;
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
    // The split (T1.17): the second group's files that opened go back into a group of
    // their own, unless none did, or every tab would.
    const split = kept.split;
    const second = split ? this.tabs.filter((t) => t.file !== null && split.second.some((f) => samePath(f, t.file!))) : [];
    if (split && second.length && second.length < this.tabs.length) {
      const first = this.groups[0];
      first.tabs = first.tabs.filter((t) => !second.includes(t));
      const pick = (tabs: Tab[], file: string | null) => tabs.find((t) => file !== null && t.file !== null && samePath(t.file, file)) ?? tabs[0];
      first.shown = pick(first.tabs, split.shown[0]);
      this.groups.push({ tabs: second, shown: pick(second, split.shown[1]), bar: this.makeStrip() });
      this.axis = split.axis;
      this.at = split.at;
      this.tab = first.shown;
      this.render();
      // A chart drawn before the split was as wide as the window: each half fits its own.
      for (const g of this.groups) g.shown.chart.fit();
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

  /** The + (Q140): a blank tab after its group's shown one, shown. */
  private newTab(group = this.groupOf(this.tab)!): void {
    const tab = this.makeTab();
    this.place(tab, group.shown);
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
   * lose. Its group shows the tab to its right, or else the one to its left. A group left
   * with no tab closes the split (T1.17, Q184); the window's last tab closed leaves a
   * blank one.
   */
  private drop(tab: Tab): void {
    const g = this.groupOf(tab);
    if (!g) return;
    const at = g.tabs.indexOf(tab);
    g.tabs.splice(at, 1);
    const p = this.parts.get(tab)!;
    this.parts.delete(tab);
    tab.close();
    p.item.remove();
    p.view.remove();
    p.code.remove();
    this.seen.delete(tab);
    const last = !this.tabs.length;
    if (last) {
      const blank = this.makeTab();
      g.tabs.push(blank);
      g.shown = blank;
    } else if (!g.tabs.length) {
      this.removeGroup(g);
    } else if (g.shown === tab) {
      g.shown = g.tabs[Math.min(at, g.tabs.length - 1)];
    }
    if (tab === this.tab) this.tab = (this.groups.includes(g) ? g : this.groups[0]).shown;
    this.render();
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

  /** The files the window shows, for the shell: its tabs', in the strips' order, then any closed tab's still writing its highlights. */
  private files(): string[] {
    return [...this.tabs, ...this.draining].flatMap((t) => (t.file ? [t.file] : []));
  }

  // ------------------------------------------------------------------ the strips

  /** A group's strip (T1.16, T1.25, T1.17): the tabs' list, the button that lists every tab, the + and the × that closes the split. None in `naiad serve`'s page. */
  private makeStrip(): Strip | null {
    if (!this.el.top) return null;
    const box = document.createElement('div');
    box.className = 'tabs';
    box.innerHTML = `
      <div class="tablist" role="tablist" aria-label="Open flowcharts"></div>
      <div class="more-wrap">
        <button class="more" data-act="alltabs" aria-haspopup="menu" aria-expanded="false" hidden>${ICONS.chevron}<span></span></button>
        <div class="tabs-menu" role="menu" aria-label="Every open tab" hidden></div>
      </div>
      <button class="icon" data-act="newtab" title="New tab" aria-label="New tab">${ICONS.plus}</button>
      <button class="icon" data-act="unsplit" title="Close the split: move these tabs to the other side" aria-label="Close the split: move these tabs to the other side" hidden>${ICONS.close}</button>`;
    const q = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
    const strip: Strip = { box, list: q('.tablist'), more: q('[data-act="alltabs"]'), menu: q('.tabs-menu'), unsplit: q('[data-act="unsplit"]') };
    // The list of every tab (T1.25) can lie in the tabs row, the window's title bar
    // (T4.10); a press on its edge doesn't move the window.
    if (this.backend.windowControls) strip.menu.setAttribute('data-tauri-drag-region', 'false');
    this.watchStrip(strip);
    return strip;
  }

  /** The group whose strip holds an element. */
  private groupAt(el: Element): Group | undefined {
    const box = el.closest('.tabs');
    return this.groups.find((g) => g.bar?.box === box);
  }

  /**
   * Puts each strip in its place (T1.17, Q185): the first group's in the tabs row; the
   * second's after it, side by side, or above the lower half, one above the other. Each
   * strip's × shows while split, and each list names its side.
   */
  private placeStrips(): void {
    const top = this.el.top;
    const [a, b] = this.groups.map((g) => g.bar);
    if (!top || !a) return;
    if (top.firstElementChild !== a.box) top.prepend(a.box);
    if (b) {
      if (this.axis === 'row' && a.box.nextElementSibling !== b.box) a.box.after(b.box);
      if (this.axis === 'col' && b.box.parentElement !== this.el.body) this.el.body.append(b.box);
    }
    const sides = this.axis === 'row' ? ['left side', 'right side'] : ['top half', 'bottom half'];
    this.groups.forEach((g, i) => {
      g.bar!.unsplit.hidden = !b;
      g.bar!.list.setAttribute('aria-label', b ? `Open flowcharts, ${sides[i]}` : 'Open flowcharts');
    });
  }

  /**
   * Side by side (T1.17), the first strip is as wide as the panes before the charts and
   * the left half, so each strip sits over its own half.
   */
  private fitHeader(): void {
    const [a, b] = this.groups;
    if (!a?.bar) return;
    a.bar.box.style.flex = '';
    if (!b || this.axis !== 'row') return;
    const right = this.parts.get(a.shown)!.chartarea.getBoundingClientRect().right;
    const width = right - a.bar.box.getBoundingClientRect().left;
    if (width > 0) a.bar.box.style.flex = `0 0 ${String(Math.round(width))}px`;
  }

  /** The strips: each tab's name (its file's, or New tab), each group's shown one marked. */
  private paintStrip(): void {
    for (const [t, p] of this.parts) p.view.dataset.file = t.file ? basename(t.file) : '';
    const split = this.groups.length > 1;
    for (const g of this.groups) {
      if (!g.bar) continue;
      const lone = !split && g.tabs.length === 1;
      const items = g.tabs.map((tab) => {
        const p = this.parts.get(tab)!;
        const file = tab.file;
        const label = file ? basename(file) : BLANK_NAME;
        const shown = tab === g.shown;
        if (p.name.dataset.label !== label) {
          // The name, and its bold twin's text, which keeps the tab's width (Q189).
          const text = document.createElement('span');
          text.className = 'tlabel';
          text.textContent = label;
          p.name.replaceChildren(text);
          p.name.dataset.label = label;
        }
        p.name.title = file ?? '';
        p.name.setAttribute('aria-selected', String(shown));
        p.item.classList.toggle('shown', shown);
        p.close.setAttribute('aria-label', `Close ${label}`);
        // A lone blank tab has nothing to close: closing it would leave a blank tab.
        p.close.hidden = lone && !file;
        return p.item;
      });
      g.bar.list.replaceChildren(...items);
      this.fitStrip(g);
      if (!g.bar.menu.hidden) this.fillTabsMenu(g);
    }
  }

  /**
   * Many tabs (T1.25; the user, 2026-11-18, Q177): tabs shrink to 72 px (the CSS); past
   * that the list scrolls sideways, with no scroll bar. The wheel, which turns up and
   * down, scrolls it, while tabs are out of sight; a touchpad's sideways swipe is the
   * browser's own.
   */
  private watchStrip(strip: Strip): void {
    const list = strip.list;
    const fit = () => { const g = this.groups.find((x) => x.bar === strip); if (g) this.fitStrip(g); };
    list.addEventListener('wheel', (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? list.clientWidth : 1);
      fit();
    }, { passive: false });
    list.addEventListener('scroll', fit);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(list);
  }

  /**
   * Which tabs of a group (every group's, with none named) are out of sight, wholly or in
   * part (T1.25): a fade on each edge that cuts one (Q177), and the button that lists
   * every tab, with how many are out of sight (Q178); with every tab in sight, neither.
   */
  private fitStrip(group?: Group): void {
    for (const g of group ? [group] : this.groups) {
      if (!g.bar) continue;
      const { list, more } = g.bar;
      const box = list.getBoundingClientRect();
      let before = 0;
      let after = 0;
      for (const tab of g.tabs) {
        const r = this.parts.get(tab)!.item.getBoundingClientRect();
        if (r.width === 0) continue; // not laid out
        if (r.left < box.left - 0.5) before++;
        else if (r.right > box.right + 0.5) after++;
      }
      list.classList.toggle('fade-start', before > 0);
      list.classList.toggle('fade-end', after > 0);
      const n = before + after;
      more.hidden = n === 0;
      more.querySelector('span')!.textContent = String(n);
      const label = `${String(n)} more tab${n === 1 ? '' : 's'}: list every tab`;
      more.setAttribute('aria-label', label);
      more.title = label;
      if (n === 0) this.showTabsMenu(g, false);
    }
  }

  /** A group's list of every tab (Q178): each tab's name, its path on pointing, the shown one marked. */
  private fillTabsMenu(g: Group): void {
    g.bar?.menu.replaceChildren(...g.tabs.map((tab, i) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.dataset.tab = String(i);
      b.textContent = tab.file ? basename(tab.file) : BLANK_NAME;
      b.title = tab.file ?? '';
      if (tab === g.shown) b.setAttribute('aria-current', 'true');
      return b;
    }));
  }

  private showTabsMenu(g: Group, open: boolean): void {
    if (!g.bar) return;
    if (open) this.fillTabsMenu(g);
    g.bar.menu.hidden = !open;
    g.bar.more.setAttribute('aria-expanded', String(open));
  }

  /** Whether any group's list of every tab is open. */
  private get tabsMenuOpen(): boolean {
    return this.groups.some((g) => g.bar && !g.bar.menu.hidden);
  }

  private closeTabsMenus(): void {
    for (const g of this.groups) this.showTabsMenu(g, false);
  }

  // ------------------------------------------------------------------ split view

  /** Takes a group out of the window, its strip with it (its tabs are elsewhere already). */
  private removeGroup(g: Group): void {
    this.groups = this.groups.filter((x) => x !== g);
    g.bar?.box.remove();
  }

  /**
   * A group's × (T1.17, Q184): closes the split, moving the group's tabs after the other
   * group's, so no tab closes; the other group's shown tab is shown.
   */
  private closeSplit(g: Group): void {
    const other = this.groups.find((x) => x !== g);
    if (!other) return;
    other.tabs.push(...g.tabs);
    this.removeGroup(g);
    this.tab = other.shown;
    this.render();
  }

  /** Moves a tab to a place among a group's tabs (`index`, counted without it); into another group, it is shown there. */
  private moveTab(tab: Tab, to: Group, index: number): void {
    const from = this.groupOf(tab)!;
    const at = from.tabs.indexOf(tab);
    from.tabs.splice(at, 1);
    to.tabs.splice(Math.min(index, to.tabs.length), 0, tab);
    if (to !== from) {
      to.shown = tab;
      this.tab = tab;
      if (!from.tabs.length) this.removeGroup(from);
      else if (from.shown === tab) from.shown = from.tabs[Math.min(at, from.tabs.length - 1)];
    }
    this.render();
  }

  /** Splits the window (T1.17, Q180): the tab alone in a new group on that side, the rest in the other; the new half is the active one. */
  private splitWith(tab: Tab, side: 'left' | 'right' | 'top' | 'bottom'): void {
    const from = this.groups[0];
    const at = from.tabs.indexOf(tab);
    if (this.groups.length > 1 || at < 0 || from.tabs.length < 2) return;
    from.tabs.splice(at, 1);
    if (from.shown === tab) from.shown = from.tabs[Math.min(at, from.tabs.length - 1)];
    const g: Group = { tabs: [tab], shown: tab, bar: this.makeStrip() };
    this.groups = side === 'left' || side === 'top' ? [g, from] : [from, g];
    this.axis = side === 'left' || side === 'right' ? 'row' : 'col';
    this.at = 0.5;
    this.tab = tab;
    this.render();
  }

  /** The divider's place (Q182): the first half's share, each half at least 240 px of `size` (less than 480 px: half and half). */
  private setShare(share: number, size = 0): void {
    const least = size > 0 ? 240 / size : 0;
    this.at = size > 0 && size < 480 ? 0.5 : Math.min(1 - least, Math.max(least, share));
    const a = Number(this.at.toFixed(3));
    this.el.body.style.setProperty('--fa', `${String(a)}fr`);
    this.el.body.style.setProperty('--fb', `${String(Number((1 - a).toFixed(3)))}fr`);
  }

  /** A drag on the divider (Q182): the halves follow the pointer; the place is kept when it is let go. */
  private dragDivider(e: PointerEvent): void {
    const [a, b] = this.groups;
    if (!b || e.button !== 0) return;
    e.preventDefault();
    const row = this.axis === 'row';
    const ra = this.parts.get(a.shown)!.chartarea.getBoundingClientRect();
    const rb = this.parts.get(b.shown)!.chartarea.getBoundingClientRect();
    const from = row ? ra.left : ra.top;
    const size = (row ? rb.right : rb.bottom) - from;
    try { this.divider.setPointerCapture(e.pointerId); } catch { /* no pointer to capture */ }
    this.divider.classList.add('dragging');
    document.body.classList.add(row ? 'resizing' : 'resizing-rows');
    const move = (m: PointerEvent) => {
      if (size <= 0) return;
      this.setShare(((row ? m.clientX : m.clientY) - from) / size, size);
      this.fitHeader();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.divider.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-rows');
      void this.keep();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * A press on a tab (T1.17, Q180): a move of more than 6 px starts a drag, with pointer
   * events (Tauri's file dropping takes the browser's drag and drop on Windows). A copy of
   * the tab follows the pointer, and where it would land shows (`landing`); letting go
   * moves it there. Escape cancels. The click that ends the press doesn't show the tab.
   */
  private dragTab(e: PointerEvent, tab: Tab): void {
    if (e.button !== 0 || !this.groups[0].bar) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { ghost } = this.drag;
    const item = this.parts.get(tab)!.item;
    const name = tab.file ? basename(tab.file) : BLANK_NAME;
    // Outside the window (T6.2): the window under the pointer is told, at most every 30
    // ms, and once more for the last move.
    const win = this.backend.windows;
    let out = false;
    let told = 0;
    let telling: number | undefined;
    const tell = () => { window.clearTimeout(telling); telling = undefined; told = Date.now(); win?.dragOver(name); };
    let on = false;
    let land: Landing | null = null;
    const move = (m: PointerEvent) => {
      if (!on) {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) <= 6) return;
        on = true;
        ghost.textContent = name;
        ghost.hidden = false;
        item.classList.add('dragging');
        document.body.classList.add('dragging-tab');
        this.closeTabsMenus();
      }
      if (win && (m.clientX < 0 || m.clientY < 0 || m.clientX >= window.innerWidth || m.clientY >= window.innerHeight)) {
        if (!out) {
          out = true;
          ghost.hidden = true;
          land = null;
          this.paintLanding(null, name);
        }
        if (Date.now() - told >= 30) tell();
        else telling ??= window.setTimeout(tell, 30);
        return;
      }
      if (out) {
        out = false;
        window.clearTimeout(telling);
        telling = undefined;
        ghost.hidden = false;
        win?.dragEnd();
      }
      ghost.style.left = `${String(m.clientX + 12)}px`;
      ghost.style.top = `${String(m.clientY + 8)}px`;
      land = this.landing(tab, m.clientX, m.clientY);
      this.paintLanding(land, name);
    };
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      window.clearTimeout(telling);
      if (!on) return;
      ghost.hidden = true;
      this.paintLanding(null, name);
      item.classList.remove('dragging');
      document.body.classList.remove('dragging-tab');
      this.noClick = true;
      window.setTimeout(() => { this.noClick = false; }, 0);
      if (out) {
        // Let go outside the window: into the window there, or a new one (T6.2).
        if (drop) void this.sendTab(tab);
        else win?.dragEnd();
        return;
      }
      if (drop && land) this.land(tab, land);
    };
    const up = () => end(true);
    const key = (k: KeyboardEvent) => {
      if (k.key !== 'Escape' || !on) return;
      k.stopImmediatePropagation();
      end(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
  }

  /** Shows where a dragged tab named `name` would land: a line in a strip, or the half it would open in; nothing for null. */
  private paintLanding(land: Landing | null, name: string): void {
    const { zone, line } = this.drag;
    const box = land && land.kind !== 'strip' ? land.zone : null;
    zone.hidden = !box;
    if (box) {
      const label = document.createElement('span');
      label.textContent = `${name} opens here`;
      zone.replaceChildren(label);
      Object.assign(zone.style, { left: px(box.left), top: px(box.top), width: px(box.width), height: px(box.height) });
    }
    line.hidden = land?.kind !== 'strip';
    if (land?.kind === 'strip') {
      Object.assign(line.style, { left: px(land.line), top: px(land.bar.top + 6), height: px(Math.max(0, land.bar.height - 12)) });
    }
  }

  /**
   * Where a tab from another window let go at (x, y) goes (T6.2): at that place in a
   * strip; else after the shown tab of the half it is over, or of the active half. It
   * never splits the window. `show`: what to show while it is dragged there.
   */
  private arrivalLanding(x: number, y: number): { group: Group; index: number; show: Landing | null } {
    const land = this.landing(null, x, y);
    if (land?.kind === 'strip') return { group: land.group, index: land.index, show: land };
    const group = land?.kind === 'half' ? land.group : this.groupOf(this.tab)!;
    const r = this.parts.get(group.shown)!.chartarea.getBoundingClientRect();
    const zone = inside(r, x, y) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
    return { group, index: group.tabs.indexOf(group.shown) + 1, show: zone && { kind: 'half', group, zone } };
  }

  /**
   * A tab let go outside its window (T6.2; the user, 2026-11-25): saved first, as when it
   * closes, it moves into the Naiad window there, or else into a new window of its own.
   * A window's only tab moves only into another window; let go anywhere else it stays.
   * The window it leaves closes once its last tab has gone.
   */
  private async sendTab(tab: Tab): Promise<void> {
    const win = this.backend.windows;
    if (!win || this.closing.has(tab)) return;
    const over = await win.release().catch(() => false);
    if (this.tabs.length === 1 && !over) return;
    const name = tab.file ? basename(tab.file) : BLANK_NAME;
    this.closing.add(tab);
    try {
      if (!(await tab.leave(`Move ${name} to another window`, () => this.show(tab))) || !this.tabs.includes(tab)) return;
      await win.dropTab(tab.file, tab.moved());
    } catch (e) {
      this.toast(`Could not move ${name}: ${errorText(e)}`);
      return;
    } finally {
      this.closing.delete(tab);
    }
    if (this.tabs.length === 1 && over) {
      await tab.highlightsWritten();
      this.forgetMine();
      win.closeNow();
      return;
    }
    this.drop(tab);
  }

  /** What comes to this window (`Backend.onArrivals`), taken one at a time, in order. */
  private arriving: Promise<void> = Promise.resolve();
  private arrive(item: Arrival): void {
    const run = this.arriving.then(async () => {
      if ('file' in item) {
        await this.open(item.file).catch((e) => this.toast(`Could not open ${basename(item.file)}: ${errorText(e)}`));
        this.recent?.update();
      } else if ('tab' in item) {
        await this.inOrder(() => this.takeTab(item.tab, item.at));
      } else if ('kept' in item) {
        await this.restore(readKept(JSON.stringify(item.kept)), false);
        this.recentFollows(this.tab);
      }
    });
    this.arriving = run.catch(() => {});
  }

  /**
   * A tab moved in from another window (T6.2): a new tab where it was let go, or the
   * window's only tab when that is blank (a window made for it), shown, then given the
   * tab's file, Undo and Redo, selection and view (`Tab.takeOver`). Moving leaves the
   * recent list's order alone.
   */
  private async takeTab(m: MovedTab, at?: [number, number]): Promise<void> {
    this.paintLanding(null, '');
    const there = m.file === null ? undefined : this.tabs.find((t) => t.file !== null && samePath(t.file, m.file!));
    if (there) { this.show(there); return; }
    const blank = this.tabs.length === 1 && this.tab.file === null ? this.tab : null;
    if (blank && m.file === null) return;
    let tab = blank;
    if (!tab) {
      tab = this.makeTab();
      const spot = at ? this.arrivalLanding(at[0], at[1]) : { group: this.groupOf(this.tab)!, index: Infinity };
      if (!at) spot.index = spot.group.tabs.indexOf(spot.group.shown) + 1;
      spot.group.tabs.splice(Math.min(spot.index, spot.group.tabs.length), 0, tab);
    }
    this.show(tab);
    this.paintStrip();
    this.recentFollows(tab, true);
    if (m.file === null) return;
    this.reopening = true;
    try {
      await tab.takeOver(m);
    } finally {
      this.reopening = false;
    }
    if (tab.file === null && !blank) { this.drop(tab); return; } // it could not be read; the toast said so
    this.recentFollows(tab, true);
  }

  /** Where a tab dragged to (x, y) would land, if anywhere (Q180, Q185); `tab` is null for one from another window. */
  private landing(tab: Tab | null, x: number, y: number): Landing | null {
    for (const g of this.groups) {
      const bar = g.bar?.box.getBoundingClientRect();
      if (!bar || !inside(bar, x, y)) continue;
      const others = g.tabs.filter((t) => t !== tab).map((t) => this.parts.get(t)!.item.getBoundingClientRect());
      const index = others.filter((r) => r.left + r.width / 2 < x).length;
      // Over its own place the tab would not move: no line, and letting go does nothing.
      if (g.tabs[index] === tab) return null;
      const line = index < others.length ? others[index].left : others.length ? others[others.length - 1].right : bar.left + 4;
      return { kind: 'strip', group: g, index, line, bar };
    }
    if (this.groups.length === 1) {
      // A group's only tab can't split it: the other half would have no tab.
      if (this.groups[0].tabs.length < 2) return null;
      const r = this.parts.get(this.tab)!.chartarea.getBoundingClientRect();
      if (!inside(r, x, y)) return null;
      const near = [
        ['left', (x - r.left) / r.width], ['right', (r.right - x) / r.width],
        ['top', (y - r.top) / r.height], ['bottom', (r.bottom - y) / r.height],
      ] as const;
      const side = near.reduce((m, s) => (s[1] < m[1] ? s : m))[0];
      const w = r.width / 2;
      const h = r.height / 2;
      const zone = side === 'left' ? { left: r.left, top: r.top, width: w, height: r.height }
        : side === 'right' ? { left: r.left + w, top: r.top, width: w, height: r.height }
          : side === 'top' ? { left: r.left, top: r.top, width: r.width, height: h }
            : { left: r.left, top: r.top + h, width: r.width, height: h };
      return { kind: 'edge', side, zone };
    }
    for (const g of this.groups) {
      const r = this.parts.get(g.shown)!.chartarea.getBoundingClientRect();
      if (inside(r, x, y)) return { kind: 'half', group: g, zone: { left: r.left, top: r.top, width: r.width, height: r.height } };
    }
    return null;
  }

  /** A dragged tab let go where it would land. */
  private land(tab: Tab, at: Landing): void {
    if (at.kind === 'strip') this.moveTab(tab, at.group, at.index);
    else if (at.kind === 'edge') this.splitWith(tab, at.side);
    else if (at.group.tabs.includes(tab)) this.show(tab);
    else this.moveTab(tab, at.group, at.group.tabs.indexOf(at.group.shown) + 1);
  }

  /** What a tab uses of the window: the chart's tools (the island and the pill), the window's choices, the toast. */
  private tabWindow(own: () => Tab): TabWindow {
    const el = this.el;
    return {
      backend: this.backend,
      bar: {
        status: el.status, dir: el.dir, undo: el.undo, redo: el.redo, add: el.add, fit: el.fit,
        highlight: el.highlight, clear: el.clear, pill: el.pill, island: el.island, walk: el.walk,
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
        void this.keep();
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
    this.windowClosing = true;
    try {
      return await this.closeTabs();
    } finally {
      this.windowClosing = false;
    }
  }

  /** While the window closes (`canClose`): another window closed meanwhile was closed with it (Q216). */
  private windowClosing = false;

  /** `canClose`'s work: each tab let go, saved or asked about. */
  private async closeTabs(): Promise<boolean> {
    const lettingGo = new Set<Tab>();
    for (let round = 0; round < 5; round++) {
      for (const tab of [...this.tabs]) {
        if (round > 0 && (lettingGo.has(tab) || !tab.waiting())) continue;
        let asked = false;
        if (!(await tab.leave('Close Naiad', () => { asked = true; this.show(tab); }))) return false;
        if (asked) lettingGo.add(tab);
      }
      if (!this.tabs.some((t) => !lettingGo.has(t) && t.waiting())) {
        // Every window keeps its tabs as it closes; one closed while others stay open is
        // forgotten by the shell's word a moment later (`onForget`), so windows closed
        // together are all remembered (T1.23, Q216).
        await this.keep();
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
    return this.inOrder(() => this.openNow(path));
  }

  /** Runs `job` after the opens before it: one file opening, or one tab moving in, at a time. */
  private inOrder(job: () => Promise<void>): Promise<void> {
    const run = this.opens.then(job);
    this.opens = run.catch(() => {});
    return run;
  }

  private async openNow(path: string): Promise<void> {
    // A file another window shows: that window shows its tab and comes to the front,
    // never a second copy (Q214, T6.2).
    const here = this.tabs.some((t) => t.file !== null && samePath(t.file, path));
    if (!here && (await this.backend.windows?.showElsewhere(path))) return;
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

  /** Whether the pointer is over the Fit button or its menu (Q255), which then stays open. */
  private fitTimer: number | undefined;

  private showFitMenu(open: boolean): void {
    window.clearTimeout(this.fitTimer);
    this.el.fitMenu.hidden = !open;
    this.el.fit.setAttribute('aria-expanded', String(open));
  }

  private showExportMenu(open: boolean): void {
    this.el.exportMenu.hidden = !open;
    this.el.exportButton.setAttribute('aria-expanded', String(open));
  }

  /**
   * Save as SVG and Save as PNG (T6.3; Q220, Q222): the whole chart, alone, in the theme
   * on screen, offered under the flowchart's own name, next to it. Nothing is written to
   * the flowchart.
   */
  private async saveExport(kind: ExportKind): Promise<void> {
    const tab = this.tab;
    const picture = tab.chart.picture();
    if (!tab.file || !picture) { this.toast('There is no chart to save yet.'); return; }
    try {
      const text = await svgFile(picture.svg, picture.background);
      const { w, h } = sizeOf(picture.svg);
      const bytes = kind === 'svg' ? new TextEncoder().encode(text) : await pngFile(text, w, h);
      const name = await this.backend.saveExport(tab.file.replace(/\.(mmd|mermaid)$/i, '') + `.${kind}`, kind, bytes);
      if (name) this.toast(`Saved ${name}.`);
    } catch (e) {
      this.toast(`Could not save the picture: ${errorText(e)}`);
    }
  }

  /** The print page (T6.3, Q221, Q223), made the first time it opens; it starts from the chart alone each time. */
  private printPage: ReturnType<typeof printWindow> | null = null;

  private openPrint(): void {
    if (!this.tab.file) { this.toast('There is no flowchart to print yet.'); return; } // a blank tab
    if (!this.printPage) {
      this.printPage = printWindow((choice) => void this.print(choice));
      this.root.append(this.printPage);
    }
    this.printPage.reset();
    this.printPage.showModal();
    void this.measureForPrint();
  }

  /** Counts each print page's opening, so a measure that comes back late is not given to a later one. */
  private printOpenings = 0;
  /** The region's paper, asked once (Q228). */
  private regionPaper: Promise<Paper> | null = null;

  /**
   * Draws the chart for paper out of sight, measures it and tells the print page, which
   * then shows what each size gives (D6.2). The drawing is thrown away: Print preview
   * draws again, so a change to the file meanwhile is printed.
   */
  private async measureForPrint(): Promise<void> {
    const page = this.printPage;
    if (!page) return;
    const opening = ++this.printOpenings;
    const stage = document.createElement('div');
    stage.className = 'print-stage';
    stage.setAttribute('aria-hidden', 'true');
    document.body.append(stage);
    try {
      this.regionPaper ??= this.backend.paper().catch((): Paper => 'A4');
      const svg = await this.tab.drawForPaper(stage);
      if (!svg) throw new Error('nothing to draw');
      const paper = await this.regionPaper;
      if (opening === this.printOpenings) page.measured({ ...measureDrawing(svg), paper });
    } catch {
      if (opening === this.printOpenings) page.measured('failed');
    } finally {
      stage.remove();
    }
  }

  /** Lays the sheet in the page with what is ticked, draws the chart for paper into it, then opens the print window. */
  private async print(choice: PrintChoice): Promise<void> {
    const tab = this.tab;
    const contents = tab.printContents();
    if (!contents) return;
    for (const old of document.querySelectorAll('.print-sheet, #print-page-size')) old.remove();
    const sheet = printSheet(contents, choice);
    document.body.append(sheet);
    const holder = sheet.querySelector<HTMLElement>('.print-chart');
    if (holder) {
      try {
        const svg = await tab.drawForPaper(holder);
        if (!svg) throw new Error('the flowchart has nothing to draw yet');
        if (svg.id) svg.prepend(styleElement(drawingRules(`#${CSS.escape(svg.id)}`)));
        if (choice.size === 'pages') {
          // Over several pages (D6.2): the parts worked out again from this drawing, on
          // the paper chosen, and the page's size set to that paper while printing.
          const { chart, boxes } = measureDrawing(svg);
          const plan = planFor(chart, boxes, choice.paper, choice.orientation);
          layParts(sheet, svg, plan, contents.name);
          const size = document.createElement('style');
          size.id = 'print-page-size';
          size.textContent = pageSizeRule(plan);
          document.head.append(size);
        }
      } catch (e) {
        sheet.remove();
        this.toast(`Could not draw the chart for printing: ${errorText(e)}`);
        return;
      }
    }
    window.print();
  }

  /** A print started without the print page: the chart as drawn now, alone. */
  private quickSheet(): void {
    const contents = this.tab.printContents();
    const picture = this.tab.chart.picture();
    if (!contents || !picture) return;
    const sheet = printSheet(contents, { chart: true, about: false, nodes: false });
    // The copy keeps the chart's id, which its own style names; Naiad's rules come with it.
    if (picture.svg.id) picture.svg.prepend(styleElement(drawingRules(`#${CSS.escape(picture.svg.id)}`)));
    // Its arrowheads and the like get ids of their own, or they point at the hidden chart's.
    renameIds(picture.svg, 'print-');
    sheet.querySelector('.print-chart')!.append(picture.svg);
    document.body.append(sheet);
    dropTitle(picture.svg); // the sheet's heading names the flowchart (Q225)
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
    if (!visible) this.fillWithText(false);
    this.el.textToggle.setAttribute('aria-pressed', String(visible));
    remember('syntaxpane', visible ? 'shown' : 'hidden');
    // A notice's Show syntax button is there only while the pane is hidden.
    for (const tab of this.tabs) tab.paintNotices();
    if (visible && this.recent?.visible) this.toggleRecent(false);
  }

  /** The Syntax pane fills the window's body, over the chart and the sidebar, or goes
   * back to its own width (the user, 2026-11-25): the button at the pane's top right. */
  private fillWithText(on: boolean): void {
    this.el.pane.classList.toggle('full', on);
    const button = this.el.pane.querySelector<HTMLButtonElement>('[data-act="syntax-full"]')!;
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Show the chart again' : 'Fill the window with the syntax';
    button.setAttribute('aria-label', on ? 'Show the chart again' : 'Fill the window');
    button.innerHTML = on ? ICONS.shrink : ICONS.expand;
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
      // The Fit menu (Q255): a view picked is glided to.
      const fitKind = target.closest<HTMLElement>('.fit-menu [data-fit]')?.dataset.fit;
      if (fitKind === 'whole' || fitKind === 'width') { this.tab.chart.fitTo(fitKind); return; }
      if (!target.closest('.fit-wrap')) this.showFitMenu(false);
      // The Export menu (T6.3): an item picked saves; a click anywhere else but its button
      // closes it.
      const exported = target.closest<HTMLElement>('.export-menu [data-export]')?.dataset.export;
      if (exported) {
        this.showExportMenu(false);
        void this.saveExport(exported as ExportKind);
        return;
      }
      if (!target.closest('.export-wrap')) this.showExportMenu(false);
      const listed = target.closest<HTMLElement>('.tabs-menu [data-tab]')?.dataset.tab;
      const group = this.groupAt(target);
      if (listed !== undefined) {
        const tab = group?.tabs[Number(listed)];
        this.closeTabsMenus();
        if (tab) this.show(tab);
        return;
      }
      const wrap = target.closest('.more-wrap');
      for (const g of this.groups) if (!wrap || g !== group) this.showTabsMenu(g, false);
      const act = target.closest<HTMLElement>('button[data-act]')?.dataset.act;
      if (act === 'dir' && !(this.dirHover && !this.el.dirMenu.hidden)) this.showDirMenu(!!this.el.dirMenu.hidden);
      if (act === 'open') void this.pickAndOpen();
      if (act === 'new') void this.newFile();
      if (act === 'newtab') this.newTab(group);
      if (act === 'alltabs' && group?.bar) this.showTabsMenu(group, !!group.bar.menu.hidden);
      if (act === 'unsplit' && group) this.closeSplit(group);
      if (act === 'add') void this.addNode(null);
      if (act === 'undo') void this.tab.history(true);
      if (act === 'redo') void this.tab.history(false);
      if (act === 'fit') this.tab.chart.fitNext(); // the whole chart, then its width, in turn (Q255)
      if (act === 'export') this.showExportMenu(!!this.el.exportMenu.hidden);
      if (act === 'print') this.openPrint();
      if (act === 'syntax') this.toggleText();
      if (act === 'syntax-full') this.fillWithText(!this.el.pane.classList.contains('full'));
      if (act === 'recent') this.toggleRecent();
      if (act === 'customize' || act === 'settings') this.openWindow(act);
      if (act === 'highlight') this.setHighlighting(!this.hlOn);
      if (act === 'walk') this.tab.startWalk(); // it waits for the node to start from (Q242)
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

    // Pointing at Fit shows its two views, Whole chart and Width (Q255), as the direction
    // button shows its ways; leaving both hides them, a moment later.
    const fitWrap = this.el.fit.parentElement!;
    fitWrap.addEventListener('mouseenter', () => this.showFitMenu(true));
    fitWrap.addEventListener('mouseleave', () => {
      window.clearTimeout(this.fitTimer);
      this.fitTimer = window.setTimeout(() => this.showFitMenu(false), 200);
    });

    // A print started some other way than the print page (a browser's own menu) gets
    // the chart as drawn; after any print the sheet goes (T6.3).
    window.addEventListener('beforeprint', () => { if (!document.querySelector('.print-sheet')) this.quickSheet(); });
    window.addEventListener('afterprint', () => { for (const sheet of document.querySelectorAll('.print-sheet, #print-page-size')) sheet.remove(); });

    // A drag on a pane's grip resizes the pane (T4.9).
    this.root.addEventListener('pointerdown', (e) => {
      const g = (e.target as Element).closest<HTMLElement>('.grip[data-pane]');
      if (g) this.dragGrip(e, g);
      if ((e.target as Element).closest('.split-divider')) this.dragDivider(e);
    });
    this.divider.addEventListener('dblclick', () => { this.setShare(0.5); this.fitHeader(); void this.keep(); });
    // While split, a press anywhere in a half makes it the active half (Q181); the press
    // still does what it does there.
    this.el.body.addEventListener('pointerdown', (e) => {
      if (this.groups.length < 2) return;
      const view = (e.target as Element).closest('.tabview');
      const g = this.groups.find((x) => this.parts.get(x.shown)?.view === view);
      if (g && g.shown !== this.tab) this.show(g.shown);
    }, true);

    // The keys act on the shown tab only, and not while a window lies over Naiad's (T1.21).
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Ctrl+P, WebView2's and a browser's own key for printing, opens Naiad's print page
      // first (T6.3), so a print holds the chart on paper and not the window as it is.
      if (mod && key === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!this.root.querySelector('dialog[open]')) this.openPrint();
        return;
      }
      if (this.root.querySelector('dialog[open]')) return;
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
        if (this.tabsMenuOpen) this.closeTabsMenus();
        else if (!this.el.dirMenu.hidden) this.showDirMenu(false);
        else if (!this.el.fitMenu.hidden) this.showFitMenu(false);
        else if (!this.el.exportMenu.hidden) this.showExportMenu(false);
        else if (this.tab.walking) this.tab.leaveWalk(); // Q233
        else if (this.hlOn) this.setHighlighting(false);
        else this.select(null);
      }
      // The walk's keys (Q233): the arrow keys and 1 to 9; Highlight waits until the walk ends, as its button does.
      else if (this.tab.walking && !mod && !e.altKey && this.tab.walkKey(key)) e.preventDefault();
      else if (key === 'h' && !mod && !e.altKey && !this.el.highlight.disabled && !this.tab.walking) this.setHighlighting(!this.hlOn);
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
