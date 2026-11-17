// Runs the real App (src/app.ts) in jsdom against an in-memory disk whose timing the
// test controls. Only the drawing is left out: a test file using this mocks
// src/chart.ts (see `chartMock`). Mermaid's parser, the edits, the sidebar and the
// saving are the real code. From the bug hunt's area C (saving, and changes from outside).
import mermaid from 'mermaid';
import type { Backend } from '../src/backend';

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
  list: { drawn: string[]; sidebarShown: boolean[]; destroyed: boolean }[]; drawing: number; most: number;
} = { list: [], drawing: 0, most: 0 };

/** What a test file passes to `vi.mock('../src/chart', ...)`. */
export const chartMock = () => ({
  configureMermaid: (dark: boolean) => { chartTheme.dark = dark; chartTheme.calls++; },
  Chart: class {
    drawn: string[] = [];
    sidebarShown: boolean[] = [];
    destroyed = false;
    constructor(private stage: HTMLElement, events: import('../src/chart').ChartEvents) { chartEvents.last = events; charts.list.push(this); }
    resetView() {} clear() {} select() {} setHighlights() {} setHighlighting() {} setViewing() {} fit() {}
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
      otherWindow: async () => this.otherWindow,
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
