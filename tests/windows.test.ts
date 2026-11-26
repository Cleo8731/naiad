// @vitest-environment jsdom
// T6.2, several windows in one program, on the real App with the chart stood in for
// (app-harness.ts) and the shell's window calls stood in for by `FakeWindows`: a tab
// dragged out of its window moves into the window there or a new one (the user,
// 2026-11-25), saved first, with its Undo, selection and view; a tab moved in lands where
// it was let go; every window's tabs are remembered, each under its own name, with its
// place, and come back (Q216); a file another window shows is shown there (Q214).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MovedTab, Place, Windows } from '../src/backend';
import { charts, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const B = 'C:/proj/b.mmd';
const C = 'C:/proj/c.mmd';
const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';
const PLACE: Place = [10, 20, 800, 600, false];

/** The shell's window calls (lib.rs), as one window sees them. */
class FakeWindows implements Windows {
  /** Whether another Naiad window is under the pointer when a tab is let go outside. */
  over = false;
  log: string[] = [];
  dropped: { path: string | null; tab: MovedTab }[] = [];
  opened: { kept: unknown; place: Place | null }[] = [];
  put: Place[] = [];
  forgetting: ((name: string) => void) | null = null;
  elsewhere = new Set<string>();
  closed = 0;
  at: ((x: number, y: number, name: string) => void) | null = null;
  off: (() => void) | null = null;
  dragOver(name: string) { this.log.push(`over ${name}`); }
  dragEnd() { this.log.push('end'); }
  async release() { this.log.push('release'); return this.over; }
  async dropTab(path: string | null, tab: MovedTab) { this.dropped.push({ path, tab: JSON.parse(JSON.stringify(tab)) as MovedTab }); return 'w1'; }
  onDragAt(at: (x: number, y: number, name: string) => void, off: () => void) { this.at = at; this.off = off; }
  async openWindow(kept: unknown, place: Place | null) { this.opened.push({ kept, place }); return `w${String(this.opened.length)}`; }
  async place() { return PLACE; }
  putAt(place: Place) { this.put.push(place); }
  onForget(take: (name: string) => void) { this.forgetting = take; }
  async showElsewhere(path: string) { return this.elsewhere.has(path); }
  closeNow() { this.closed++; }
}

let disk: FakeDisk;
let wins: FakeWindows;
/** Naiad's window `name` ("main": the program's first), with a, b and c on the disk, opened on `files`; `startFile`: the file Naiad was started on. */
async function start(files: string[] = [], name = 'main', startFile: string | null = null) {
  disk = new FakeDisk();
  disk.kind = 'desktop';
  for (const f of [A, B, C]) disk.files.set(f, TEXT);
  wins = new FakeWindows();
  disk.windows = wins;
  disk.windowName = name;
  disk.startFile = startFile;
  const ui = await startApp(disk, files[0] ?? null);
  for (const f of files.slice(1)) await ui.app.open(f);
  lay();
  return ui;
}
async function settle() { for (let i = 0; i < 30; i++) await sleep(5); }

const all = <T extends Element>(s: string) => [...document.querySelectorAll<T>(s)];
const tabOf = (name: string) => all<HTMLElement>('.tabs .tab').find((t) => t.querySelector('.tname')!.textContent === name)!;
const line = () => document.querySelector<HTMLElement>('.drop-line')!;
function box(el: Element, left: number, top: number, right: number, bottom: number) {
  el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;
}
/** Lays the window out as a browser would, 1,000 by 744 px: the strip, its tabs (100 px each) and the charts. */
function lay() {
  const bar = document.querySelector('.tabs')!;
  box(bar, 0, 0, 1000, 44);
  all('.tabs .tab').forEach((t, i) => box(t, i * 100, 0, (i + 1) * 100, 44));
  for (const c of all('.tabview > .chartarea')) box(c, 0, 44, 1000, 744);
}
const pointer = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
/** Presses on a tab's name and drags it out of the window, past its left edge; unless `hold`, lets go there. */
function dragOut(name: string, hold = false) {
  tabOf(name).querySelector('.tname')!.dispatchEvent(pointer('pointerdown', 20, 10));
  window.dispatchEvent(pointer('pointermove', 40, 30));
  window.dispatchEvent(pointer('pointermove', -40, 30));
  if (!hold) window.dispatchEvent(pointer('pointerup', -40, 30));
}
/** The window's App, for what only it holds (the shown tab's selection). */
const shownTab = (ui: Awaited<ReturnType<typeof start>>) => (ui.app as unknown as { tab: { selected: unknown } }).tab;

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('a tab dragged out of its window (T6.2)', () => {
  test('let go outside, it goes where it was let go, saved, with its Undo and view, and leaves this window', async () => {
    const ui = await start([A, B]);
    ui.showTab('a.mmd');
    const edited = `${TEXT}    c[C]\n`;
    ui.type(edited);
    charts.list[0].view = { x: 5, y: 6, k: 2 };
    dragOut('a.mmd');
    await settle();
    expect(disk.files.get(A)).toBe(edited); // saved before it left
    expect(wins.log).toEqual(['over a.mmd', 'release']);
    expect(wins.dropped).toHaveLength(1);
    const { path, tab } = wins.dropped[0];
    expect(path).toBe(A);
    expect(tab.text).toBe(edited);
    expect(tab.undo.map((s) => s.text)).toEqual([TEXT]);
    expect(tab.view).toEqual({ x: 5, y: 6, k: 2 });
    expect(ui.tabs()).toEqual(['b.mmd']);
    expect(wins.closed).toBe(0);
  });

  test("a window's only tab let go on no window stays; over another window it moves and its window closes", async () => {
    const ui = await start([A]);
    dragOut('a.mmd');
    await settle();
    expect(wins.dropped).toEqual([]);
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(localStorage.getItem('opentabs')).not.toBeNull();
    wins.over = true;
    dragOut('a.mmd');
    await settle();
    expect(wins.dropped.map((d) => d.path)).toEqual([A]);
    expect(wins.closed).toBe(1);
    // The window closed by moving its last tab keeps nothing: its tab lives on elsewhere.
    expect(localStorage.getItem('opentabs')).toBeNull();
  });

  test('a change that cannot be saved is asked about first, and No keeps the tab here', async () => {
    const ui = await start([A, B]);
    ui.showTab('a.mmd');
    disk.failWrites = 'the disk is full';
    ui.type(`${TEXT}    c[C]\n`);
    disk.answer = false;
    dragOut('a.mmd');
    await settle();
    expect(disk.asked.some((m) => m.includes('Move a.mmd to another window and lose it?'))).toBe(true);
    expect(wins.dropped).toEqual([]);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
  });

  test('Escape while outside ends the drag: the other window is told, and nothing moves', async () => {
    const ui = await start([A, B]);
    dragOut('a.mmd', true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    window.dispatchEvent(pointer('pointerup', -40, 30));
    await settle();
    expect(wins.log.at(-1)).toBe('end');
    expect(wins.dropped).toEqual([]);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
  });

  test('back inside before it is let go, it is an ordinary drag in this window', async () => {
    const ui = await start([A, B]);
    dragOut('a.mmd', true);
    window.dispatchEvent(pointer('pointermove', 180, 20));
    window.dispatchEvent(pointer('pointerup', 180, 20));
    await settle();
    expect(wins.log).toEqual(['over a.mmd', 'end']);
    expect(wins.dropped).toEqual([]);
    expect(ui.tabs()).toEqual(['b.mmd', 'a.mmd']);
  });
});

describe('a tab moved in from another window (T6.2)', () => {
  const moved = (over: Partial<MovedTab> = {}): MovedTab => ({
    file: C, text: TEXT, undo: [{ text: 'flowchart TD\n', disk: false }], redo: [],
    selection: { kind: 'node', id: 'b' }, view: { x: 1, y: 2, k: 1.5 }, ...over,
  });

  test('it lands where it was let go, shown, with its Undo, selection and view', async () => {
    const ui = await start([A, B]);
    disk.arrive([{ tab: moved(), at: [150, 20] }]);
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd', 'b.mmd']);
    expect(ui.shown()).toBe('c.mmd');
    expect(ui.undoEnabled()).toBe(true);
    expect(shownTab(ui).selected).toEqual({ kind: 'node', id: 'b' });
    expect(charts.list.at(-1)!.view).toEqual({ x: 1, y: 2, k: 1.5 });
  });

  test('a file changed meanwhile opens as it is now, with no Undo and nothing selected', async () => {
    const ui = await start([A]);
    disk.arrive([{ tab: moved({ text: 'flowchart TD\n    x[X]\n' }) }]);
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
    expect(ui.undoEnabled()).toBe(false);
    expect(shownTab(ui).selected).toBeNull();
  });

  test('a window made for the tab takes it in its blank tab, and opens nothing else', async () => {
    const ui = await start([], 'w1');
    disk.arrive([{ tab: moved() }]);
    await settle();
    expect(ui.tabs()).toEqual(['c.mmd']);
  });

  test("the landing line shows while another window's tab is over the strip, and goes when it leaves", async () => {
    await start([A, B]);
    wins.at!(150, 20, 'c.mmd');
    expect(line().hidden).toBe(false);
    expect(line().style.left).toBe('100px');
    wins.off!();
    expect(line().hidden).toBe(true);
  });
});

describe('every window remembered (Q216)', () => {
  test('a later window opens no start file and no kept tabs of the first; it keeps its own under its name, with its place', async () => {
    localStorage.setItem('opentabs', JSON.stringify({ files: [B], shown: B }));
    const ui = await start([], 'w2', A);
    expect(ui.tabs()).toEqual(['New tab']);
    disk.arrive([{ kept: { files: [C], shown: C } }]);
    await settle();
    expect(ui.tabs()).toEqual(['c.mmd']);
    expect(JSON.parse(localStorage.getItem('openwindow:w2')!)).toEqual({ files: [C], shown: C, place: PLACE });
    expect(JSON.parse(localStorage.getItem('opentabs')!)).toEqual({ files: [B], shown: B });
  });

  test('the first window puts itself where it was and opens its tabs, then every other window, in order, at its place', async () => {
    localStorage.setItem('opentabs', JSON.stringify({ files: [A], shown: A, place: [1, 2, 3, 4, false] }));
    localStorage.setItem('openwindow:w3', JSON.stringify({ files: [C], shown: C }));
    localStorage.setItem('openwindow:w1', JSON.stringify({ files: [B], shown: B, place: [5, 6, 7, 8, true] }));
    const ui = await start();
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(wins.put).toEqual([[1, 2, 3, 4, false]]);
    expect(wins.opened).toEqual([
      { kept: { files: [B], shown: B, place: [5, 6, 7, 8, true] }, place: [5, 6, 7, 8, true] },
      { kept: { files: [C], shown: C }, place: null },
    ]);
    // Each new window keeps its own under its new name.
    expect(localStorage.getItem('openwindow:w1')).toBeNull();
    expect(localStorage.getItem('openwindow:w3')).toBeNull();
  });

  test("with no tabs of its own, the first window takes the first other window's", async () => {
    localStorage.setItem('openwindow:w1', JSON.stringify({ files: [B], shown: B }));
    localStorage.setItem('openwindow:w2', JSON.stringify({ files: [C], shown: C }));
    const ui = await start();
    await settle();
    expect(ui.tabs()).toEqual(['b.mmd']);
    expect(wins.opened.map((o) => (o.kept as { files: string[] }).files)).toEqual([[C]]);
  });

  test('every window keeps its tabs as it closes; one the shell names as closed alone is forgotten by a window still open', async () => {
    await start([A], 'w2');
    await settle();
    expect(await disk.closeGuard!()).toBe(true);
    // Closed together with the others (the taskbar's "Close all windows"): kept.
    expect(JSON.parse(localStorage.getItem('openwindow:w2')!)).toEqual({ files: [A], shown: A, place: PLACE });
    stopApps();
    // Closed alone: a window still open hears its name and forgets it; never its own.
    localStorage.setItem('opentabs', JSON.stringify({ files: [B], shown: B }));
    await start([C], 'w3');
    await settle();
    wins.forgetting!('w2');
    wins.forgetting!('w3');
    expect(localStorage.getItem('openwindow:w2')).toBeNull();
    expect(localStorage.getItem('openwindow:w3')).not.toBeNull();
    wins.forgetting!('main');
    expect(localStorage.getItem('opentabs')).toBeNull();
  });

  test('a window asking about a change as it closes does not forget a window closed meanwhile: they closed together', async () => {
    const ui = await start([A], 'w3');
    await settle();
    ui.type('flowchart TD\n    a[A] -->\n'); // Mermaid cannot read it: closing asks
    localStorage.setItem('openwindow:w2', JSON.stringify({ files: [B], shown: B }));
    disk.onAsk = () => wins.forgetting!('w2'); // the shell's word comes while it asks
    disk.answer = true;
    expect(await disk.closeGuard!()).toBe(true);
    expect(disk.asked).toHaveLength(1);
    expect(localStorage.getItem('openwindow:w2')).not.toBeNull();
    // Once the close is over (or turned down), the word is heard again.
    wins.forgetting!('w2');
    expect(localStorage.getItem('openwindow:w2')).toBeNull();
  });

  test("turning Remember opened files off forgets every window's tabs", async () => {
    localStorage.setItem('openwindow:w4', JSON.stringify({ files: [B], shown: B }));
    const ui = await start([A]);
    await settle();
    localStorage.setItem('openwindow:w4', JSON.stringify({ files: [B], shown: B }));
    (ui.app as unknown as { setRemembering(on: boolean): void }).setRemembering(false);
    expect(localStorage.getItem('opentabs')).toBeNull();
    expect(localStorage.getItem('openwindow:w4')).toBeNull();
  });
});

describe('a file another window shows (Q214)', () => {
  test('opening it here shows it there, with no second copy', async () => {
    const ui = await start([A]);
    wins.elsewhere.add(B);
    await ui.app.open(B);
    expect(ui.tabs()).toEqual(['a.mmd']);
    await ui.app.open(C);
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
  });
});
