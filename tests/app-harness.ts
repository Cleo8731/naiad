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

/** What a test file passes to `vi.mock('../src/chart', ...)`. */
export const chartMock = () => ({
  configureMermaid: () => {},
  Chart: class {
    constructor(_stage: unknown, events: import('../src/chart').ChartEvents) { chartEvents.last = events; }
    resetView() {} clear() {} select() {} setHighlights() {} setHighlighting() {} fit() {}
    async draw() { if (chartTiming.drawDelay) await sleep(chartTiming.drawDelay); }
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
  /** What the person answers when Naiad asks (`Backend.confirm`); every question asked. */
  answer = false;
  asked: string[] = [];
  /** The handler the app gave for closing the window (`Backend.guardClose`). */
  closeGuard: (() => Promise<boolean>) | null = null;
  /** Each flowchart's highlights file, by the flowchart's path (none: no file). */
  highlights = new Map<string, string>();
  /** Called after a read of the highlights has taken its copy, before it resolves. */
  afterHighlightsRead: ((path: string) => void) | null = null;

  backend(): Backend {
    return {
      kind: 'browser',
      cliJob: async () => null,
      cliDone: async () => {},
      initialPath: async () => null,
      read: async (path) => {
        if (!this.files.has(path)) throw new Error('not found');
        const text = this.files.get(path)!;
        await this.afterRead?.(path, text);
        return text;
      },
      write: async (path, text, expected) => {
        // As the backends do: refused when the file no longer holds what was read.
        if (expected !== undefined && this.files.get(path) !== expected) return false;
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
      viewing: () => {},
      pickOpen: async () => null,
      pickSave: async () => null,
      openLink: () => {},
      setWindowTitle: () => {},
      confirm: async (message) => { this.asked.push(message); return this.answer; },
      guardClose: (canClose) => { this.closeGuard = canClose; },
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

/** Builds the page the way main.ts does, with the fake disk, and opens `path`. */
export async function startApp(disk: FakeDisk, path: string) {
  // jsdom lacks this.
  (window as unknown as { matchMedia: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  mermaid.initialize({ startOnLoad: false });
  document.body.innerHTML = '<div id="app"></div>';
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
  await app.open(path);
  const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
  return {
    app,
    area: () => q<HTMLTextAreaElement>('textarea'),
    status: () => q<HTMLElement>('.status').textContent ?? '',
    toast: () => (q<HTMLElement>('.toast').hidden ? '' : q<HTMLElement>('.toast').textContent ?? ''),
    /** Typing in the text pane: the textarea's own input event. */
    type(text: string) { const a = this.area(); a.value = text; a.dispatchEvent(new Event('input')); },
    /** A chart edit: the direction list in the toolbar. */
    direction(dir: string) { const s = q<HTMLSelectElement>('[data-act="dir"]'); s.value = dir; s.dispatchEvent(new Event('change')); },
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
