// Runs the real App (src/app.ts) in jsdom against an in-memory disk whose timing the
// test controls. Only the drawing is left out: a test file using this mocks
// src/chart.ts (see `chartMock`). Mermaid's parser, the edits, the sidebar and the
// saving are the real code. From the bug hunt's area C (saving, and changes from outside).
import mermaid from 'mermaid';
import type { Arrival, Backend } from '../src/backend';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long the stand-in chart takes to draw, in ms (a big chart takes a while). */
export const chartTiming = { drawDelay: 0 };

/** The events the app gave the last stand-in chart (a click on an item, say). */
export const chartEvents: { last: import('../src/chart').ChartEvents | null } = { last: null };

/**
 * Whether the app last set Mermaid up to draw dark (`configureMermaid`), or null before
 * any; and how many times it set Mermaid up (once more for each palette chosen, T4.9).
 */
export const chartTheme: { dark: boolean | null; calls: number } = { dark: null, calls: 0 };

/** The wheel mode the app last gave the chart (`setWheelMode`), or null before any. */
export const chartWheel: { mode: import('../src/chart').WheelMode | null } = { mode: null };

/**
 * Every stand-in chart made, in order (one per tab, T1.16), each with the texts it drew
 * and, for each drawing, whether its tab's sidebar was showing as it started; and how
 * many drew at the same moment, at most (one Mermaid for the page).
 */
export const charts: {
  list: { drawn: string[]; sidebarShown: boolean[]; steps: string[]; destroyed: boolean; view: { x: number; y: number; k: number } | null }[]; drawing: number; most: number;
} = { list: [], drawing: 0, most: 0 };

/** A small drawing, as a stand-in chart's picture and a print's (T6.3); `title` gives it a front-matter title, as Mermaid draws one. */
const SVG_NS = 'http://www.w3.org/2000/svg';
function smallDrawing(fill: string, title = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 80');
  svg.setAttribute('width', '120');
  svg.setAttribute('height', '80');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', '50');
  rect.setAttribute('height', '30');
  rect.setAttribute('fill', fill);
  svg.append(rect);
  if (title) {
    // An arrowhead, as Mermaid draws one: a marker by id, and a line that names it.
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.id = 'chart1_flowchart-v2-pointEnd';
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('marker-end', 'url(#chart1_flowchart-v2-pointEnd)');
    svg.append(marker, line);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'flowchartTitleText');
    text.textContent = title;
    svg.append(text);
  }
  return svg;
}

/** The texts drawn for paper (`drawForPaper`, T6.3), in order. */
export const paperDrawn: string[] = [];
/** The size of the drawing for paper, in px (D6.2): small, unless a test makes it large. */
export const paperSize = { w: 120, h: 80 };

/** What a test file passes to `vi.mock('../src/chart', ...)`. */
export const chartMock = () => ({
  configureMermaid: (dark: boolean) => { chartTheme.dark = dark; chartTheme.calls++; },
  /** Takes the title out, as the real one does (Q225); the frame's refit is the real one's own test. */
  dropTitle: (svg: SVGSVGElement) => { for (const t of svg.querySelectorAll('.flowchartTitleText')) t.remove(); },
  drawForPaper: async (text: string, _snap: unknown, holder: HTMLElement) => {
    paperDrawn.push(text);
    const svg = smallDrawing('#ffffff');
    svg.setAttribute('viewBox', `0 0 ${String(paperSize.w)} ${String(paperSize.h)}`);
    svg.setAttribute('width', String(paperSize.w));
    svg.setAttribute('height', String(paperSize.h));
    svg.classList.add('paper');
    // An arrowhead by id, as Mermaid draws one, so a print's copies can be told apart (D6.2).
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.id = 'paper1_flowchart-v2-pointEnd';
    svg.append(marker);
    holder.replaceChildren(svg);
    return svg;
  },
  Chart: class {
    drawn: string[] = [];
    sidebarShown: boolean[] = [];
    destroyed = false;
    constructor(private stage: HTMLElement, events: import('../src/chart').ChartEvents) { chartEvents.last = events; charts.list.push(this); }
    resetView() {} clear() {} select() {} setHighlights() {} setHighlighting() {} setViewing() {} fit() {}
    /** Each walk the tab showed (T6.4), a copy, or null when it ended; and whether the view was to move. */
    walks: (import('../src/walk').WalkView | null)[] = [];
    walkMoves: boolean[] = [];
    setWalk(view: import('../src/walk').WalkView | null, move = true) { this.walks.push(view ? JSON.parse(JSON.stringify(view)) : null); this.walkMoves.push(move); }
    /** The view as the person moved it (T6.2): null while fitted. */
    view: { x: number; y: number; k: number } | null = null;
    placement() { return this.view; }
    /** The chart as drawn (T6.3): none before its first drawing. */
    picture() { return this.drawn.length ? { svg: smallDrawing('#12303a', 'Making tea'), background: 'rgb(11, 28, 33)' } : null; }
    setPlacement(view: { x: number; y: number; k: number }) { this.view = view; }
    /** In order, each drawing finished ("drawn") and each time the app said the chart's
     * tools were shown or hidden, with whether the pill showed then ("tools shown", "tools hidden"). */
    steps: string[] = [];
    toolsChanged() { this.steps.push(document.querySelector<HTMLElement>('.pill')?.hidden === false ? 'tools shown' : 'tools hidden'); }
    destroy() { this.destroyed = true; }
    setWheelMode(mode: import('../src/chart').WheelMode) { chartWheel.mode = mode; }
    async draw(text: string) {
      const sidebar = this.stage.closest('.tabview')?.querySelector<HTMLElement>('.sidebar');
      this.sidebarShown.push(!!sidebar && !sidebar.hidden);
      charts.most = Math.max(charts.most, ++charts.drawing);
      try {
        if (chartTiming.drawDelay) await sleep(chartTiming.drawDelay);
        // As Mermaid 12.3: it reads an Ellipse, `id(-Title-)`, and cannot draw it (T5.17).
        if (/[\w)\]}]\(-[^\n]*-\)/.test(text)) throw new Error('No such shape: ellipse. Please check your syntax.');
        this.drawn.push(text);
        this.steps.push('drawn');
      } finally {
        charts.drawing--;
      }
    }
  },
});

/** A stand-in for the disk and for lib.rs, serve.rs and dev/bridge.ts. */
export class FakeDisk {
  files = new Map<string, string>();
  watchers = new Map<string, Set<() => void>>();
  /** Called after a read has taken its copy of the file, before the read resolves. */
  afterRead: ((path: string, text: string) => Promise<void> | void) | null = null;
  /** How long the watcher waits, like the 60 and 80 ms of the bridge and the desktop. */
  watchDelay = 70;
  writes: { path: string; text: string }[] = [];
  /** Each picture Export saved (T6.3): the name offered, its kind and its bytes as text. */
  exports: { suggested: string; kind: 'svg' | 'png'; text: string }[] = [];
  /** Whether the person cancels Export's save dialog. */
  cancelExport = false;
  /** Each write of a flowchart fails with this message (a full disk, say); none: writes succeed. */
  failWrites: string | null = null;
  /** What the person answers when Naiad asks (`Backend.confirm`); every question asked. */
  answer = false;
  asked: string[] = [];
  /** The handler the app gave for closing the window (`Backend.guardClose`). */
  closeGuard: (() => Promise<boolean>) | null = null;
  /** Each flowchart's highlights file, by the flowchart's path (none: no file). */
  highlights = new Map<string, string>();
  /** Called after a read of the highlights has taken its copy, before it resolves. */
  afterHighlightsRead: ((path: string) => void) | null = null;
  /** Which way Naiad runs: 'browser' is the dev page; 'served' is `naiad serve`'s page. */
  kind: Backend['kind'] = 'browser';
  /** The file the Open dialog gives (none: the person cancels it), and how often it was shown. */
  picked: string | null = null;
  picks = 0;
  /** The window's files, as last recorded (`Backend.viewing`), and its title. */
  viewed: string[] = [];
  title = '';
  /** The title bar's theme, as last set (`Backend.setTheme`; null: the computer's), or undefined before any. */
  theme: 'light' | 'dark' | null | undefined = undefined;
  /** Called as Naiad asks, before the answer (to see what the window shows then). */
  onAsk: ((message: string) => void) | null = null;
  /** The file Naiad is started on (a double-click on it; none: started from the Start menu). */
  startFile: string | null = null;
  /** Whether another Naiad window is running as this one starts (`Backend.otherWindow`). */
  otherWindow = false;
  /** Gives the window what arrives for it (`Backend.onArrivals`: a file, a moved tab, kept tabs; T6.1, T6.2). */
  arrive: (items: Arrival[]) => void = () => { throw new Error('the window is not listening for arrivals'); };
  /** Hands files to the window as a later start of Naiad would (T6.1). */
  handOver(paths: string[]): void { this.arrive(paths.map((file) => ({ file }))); }
  /** The window's name (`Backend.windowName`): "main" for the program's first window. */
  windowName = 'main';
  /** The paper of the computer's region (`Backend.paper`, D6.2, Q228). */
  regionPaper: 'A4' | 'Letter' = 'A4';
  /** The program's other windows, for a desktop test of T6.2 (`Backend.windows`); null: a browser's one page. */
  windows: Backend['windows'] = null;
  /** What Naiad's own title bar asked of the window, in order (`Backend.windowControls`, T4.10). */
  windowActs: string[] = [];
  private maximized: ((max: boolean) => void) | null = null;
  /** The window is maximized or restored (by Windows, or by its own button). */
  setMaximized(max: boolean): void { this.maximized?.(max); }

  backend(): Backend {
    return {
      kind: this.kind,
      cliJob: async () => null,
      cliDone: async () => {},
      initialPath: async () => this.startFile,
      paper: async () => this.regionPaper,
      otherWindow: async () => this.otherWindow,
      windowName: this.windowName,
      onArrivals: (take) => { this.arrive = take; },
      windows: this.windows,
      read: async (path) => {
        if (!this.files.has(path)) throw new Error('not found');
        const text = this.files.get(path)!;
        await this.afterRead?.(path, text);
        return text;
      },
      write: async (path, text, expected) => {
        // As the backends do: refused when the file no longer holds what was read.
        if (expected !== undefined && this.files.get(path) !== expected) return false;
        if (this.failWrites !== null) throw new Error(this.failWrites);
        this.writes.push({ path, text });
        this.put(path, text);
        return true;
      },
      watch: async (path, onChange) => {
        const set = this.watchers.get(path) ?? new Set();
        set.add(onChange);
        this.watchers.set(path, set);
        return () => set.delete(onChange);
      },
      readHighlights: async (path) => {
        const text = this.highlights.get(path) ?? null;
        this.afterHighlightsRead?.(path);
        return text;
      },
      writeHighlights: async (path, text, expected) => {
        // As the backends do: refused when the file no longer holds what was read (none: '').
        if (expected !== undefined && (this.highlights.get(path) ?? '') !== expected) return false;
        if (text.trim() === '') this.highlights.delete(path);
        else this.highlights.set(path, text);
        return true;
      },
      viewing: (paths) => { this.viewed = [...paths]; },
      pickOpen: async () => { this.picks++; return this.picked; },
      choose: async (path) => path,
      existing: async (paths) => paths.map((p) => this.files.has(p)),
      pickSave: async () => null,
      saveExport: async (suggested, kind, bytes) => {
        if (this.cancelExport) return null;
        this.exports.push({ suggested, kind, text: new TextDecoder().decode(bytes) });
        return suggested.split('/').pop()!;
      },
      openLink: () => {},
      setWindowTitle: (title) => { this.title = title; },
      setTheme: (theme) => { this.theme = theme; },
      confirm: async (message) => { this.asked.push(message); this.onAsk?.(message); return this.answer; },
      guardClose: (canClose) => { this.closeGuard = canClose; },
      windowControls: this.kind !== 'desktop' ? null : {
        minimize: () => { this.windowActs.push('minimize'); },
        toggleMaximize: () => { this.windowActs.push('toggleMaximize'); },
        close: () => { this.windowActs.push('close'); },
        onMaximized: (on) => { this.maximized = on; on(false); },
      },
    };
  }

  /** Changes the file and tells the watchers after `watchDelay` ms (Naiad's own writes too). */
  put(path: string, text: string): void {
    this.files.set(path, text);
    const set = this.watchers.get(path);
    if (set) setTimeout(() => set.forEach((f) => f()), this.watchDelay);
  }
  /** Another program (an agent, an editor) writes the file. */
  outside(path: string, text: string): void { this.put(path, text); }
}

/** The window-level listeners of the apps started so far, taken off by `stopApps`. */
const listeners: [string, EventListenerOrEventListenerObject][] = [];

/** Takes off the window's listeners of every app started, so the next test's keys reach only its own. */
export function stopApps(): void {
  for (const [type, fn] of listeners.splice(0)) window.removeEventListener(type, fn);
}

/** Builds the page the way main.ts does, with the fake disk, and opens `path` (none: the window as it starts with no file). */
export async function startApp(disk: FakeDisk, path: string | null) {
  // jsdom lacks this.
  (window as unknown as { matchMedia: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  mermaid.initialize({ startOnLoad: false });
  document.body.innerHTML = '<div id="app"></div>';
  charts.list = [];
  charts.most = 0;
  const { App } = await import('../src/app');
  const app = new App(document.getElementById('app')!, disk.backend());
  const add = window.addEventListener;
  window.addEventListener = function (this: Window, type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
    listeners.push([type, fn]);
    add.call(this, type, fn, opts);
  } as typeof window.addEventListener;
  try {
    await app.init();
  } finally {
    window.addEventListener = add;
  }
  if (path !== null) await app.open(path);
  const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
  const tabs = () => [...document.querySelectorAll<HTMLElement>('.tabs .tab')];
  const tabNamed = (name: string) => tabs().find((t) => t.querySelector('.tname')!.textContent === name);
  return {
    app,
    /** The shown tab's text pane (T1.16: each tab has its own, the others hidden). */
    area: () => q<HTMLTextAreaElement>('.textpane textarea:not([hidden])'),
    /** The tabs' names, in the strip's order (T1.16). */
    tabs: () => tabs().map((t) => t.querySelector('.tname')!.textContent),
    /** The shown tab's name. */
    shown: () => q<HTMLElement>('.tabs .tab.shown .tname')?.textContent ?? null,
    /** A click on a tab's name, which shows it. */
    showTab(name: string) { tabNamed(name)!.querySelector<HTMLButtonElement>('.tname')!.click(); },
    /** A click on a tab's ×, then waits until the closing has asked and finished. */
    async closeTab(name: string) {
      tabNamed(name)!.querySelector<HTMLButtonElement>('.tclose')!.click();
      const closing = (app as unknown as { closing: Set<unknown> }).closing;
      while (closing.size) await sleep(5);
    },
    status: () => q<HTMLElement>('.status').textContent ?? '',
    toast: () => (q<HTMLElement>('.toast').hidden ? '' : q<HTMLElement>('.toast').textContent ?? ''),
    /** Typing in the text pane: the textarea's own input event. */
    type(text: string) { const a = this.area(); a.value = text; a.dispatchEvent(new Event('input')); },
    /** A chart edit: a direction picked in the direction button's menu (T4.9). */
    direction(dir: string) { q<HTMLElement>('[data-act="dir"]').click(); q<HTMLElement>(`[data-dir="${dir}"]`).click(); },
    undo() { q<HTMLButtonElement>('[data-act="undo"]').click(); },
    redo() { q<HTMLButtonElement>('[data-act="redo"]').click(); },
    undoEnabled: () => !q<HTMLButtonElement>('[data-act="undo"]').disabled,
    /** Ctrl+S, pressed outside the text pane. */
    ctrlS() { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })); },
    /** Waits until the text pane satisfies `pred` (the app has taken a change in). */
    async until(pred: (text: string) => boolean, max = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < max) { if (pred(this.area().value)) return true; await sleep(5); }
      return false;
    },
  };
}
