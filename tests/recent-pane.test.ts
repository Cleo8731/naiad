// @vitest-environment jsdom
// The recent list's pane (T1.15, stage 1 of D1.6), on the real App with the chart stood
// in for (app-harness.ts): its button at the toolbar's left end (T1.21); shown on a blank tab
// and hidden once a flowchart opens, not kept between runs (the user, 2026-11-14,
// T1.18); each file opened goes on top; a click opens an entry in the
// shown tab when it is blank, otherwise in a new tab, and shows a file already open
// (Q142, T1.16); × takes it off the list; a file that cannot be found stays, grayed
// (Q137); 50 kept, 25 shown, View more (Q136); no pane in `naiad serve`'s page. The
// list's rules alone: recent.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/docs/a.mmd';
const B = 'C:/proj/notes/b.mmd';
const C = 'D:/c.mmd';
const GONE = 'C:/gone/x.mmd';

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const toggle = () => q<HTMLButtonElement>('[data-act="recent"]')!;
const plus = () => q<HTMLButtonElement>('.tabs [data-act="newtab"]')!;
const pane = () => q<HTMLElement>('nav.recent')!;
const items = () => [...document.querySelectorAll<HTMLElement>('nav.recent li')];
const names = () => items().map((li) => li.querySelector('.rname')!.textContent);
const entry = (name: string) => items().find((li) => li.querySelector('.rname')!.textContent === name)!;
/** The shown tab's name (T1.16: the file's name is in its tab). */
const shownName = () => q<HTMLElement>('.tabs .tab.shown .tname')!.textContent;
const stored = () => JSON.parse(localStorage.getItem('recent') ?? 'null');

let disk: FakeDisk;
async function start(kind?: FakeDisk['kind']) {
  disk = new FakeDisk();
  if (kind) disk.kind = kind;
  for (const f of [A, B, C]) disk.files.set(f, 'flowchart TD\n    a[A] --> b[B]\n');
  return startApp(disk, A);
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the recent list\'s pane', () => {
  test('its button is the rail\'s first (T4.9), an icon with its name; the pane is hidden with a flowchart open', async () => {
    await start();
    expect(q('.rail button')).toBe(toggle());
    expect(toggle().querySelector('svg')!.getAttribute('data-icon')).toBe('recent');
    expect(toggle().querySelector('.rlabel')!.textContent).toBe('Recent files');
    expect(toggle().title).toBe('Show recent files');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(pane().hidden).toBe(true);
    // The pane comes first in the window's row, left of the Syntax pane.
    expect(q('main')!.firstElementChild).toBe(pane());
  });

  test('a click shows it, and another hides it', async () => {
    await start();
    toggle().click();
    expect(pane().hidden).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Hide recent files');
    toggle().click();
    expect(pane().hidden).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().title).toBe('Show recent files');
  });

  test('it is shown on a blank tab, and hidden once a flowchart opens there (the user, 2026-11-14)', async () => {
    const ui = await start();
    plus().click();
    expect(pane().hidden).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Hide recent files');
    await ui.app.open(B);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
    expect(pane().hidden).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  test('going to a blank tab shows it, and going from there to a flowchart\'s tab hides it', async () => {
    const ui = await start();
    plus().click();
    ui.showTab('a.mmd');
    expect(pane().hidden).toBe(true);
    ui.showTab('New tab');
    expect(pane().hidden).toBe(false);
  });

  test('between two flowcharts\' tabs it stays as the person left it', async () => {
    const ui = await start();
    await ui.app.open(B);
    toggle().click();
    ui.showTab('a.mmd');
    expect(pane().hidden).toBe(false);
    toggle().click();
    ui.showTab('b.mmd');
    expect(pane().hidden).toBe(true);
  });

  test('a flowchart opened from the pane hides it, from a flowchart\'s tab too', async () => {
    localStorage.setItem('recent', JSON.stringify([C]));
    const ui = await start();
    toggle().click();
    entry('c.mmd').querySelector<HTMLButtonElement>('.rentry')!.click();
    await vi.waitFor(() => expect(shownName()).toBe('c.mmd'));
    expect(pane().hidden).toBe(true);
    // A file already open: its tab is shown, and the pane goes too.
    toggle().click();
    entry('a.mmd').querySelector<HTMLButtonElement>('.rentry')!.click();
    await vi.waitFor(() => expect(shownName()).toBe('a.mmd'));
    expect(pane().hidden).toBe(true);
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
  });

  test('a file that cannot be opened leaves a blank tab with the pane shown', async () => {
    const ui = await start();
    plus().click();
    await ui.app.open(GONE);
    expect(ui.shown()).toBe('New tab');
    expect(pane().hidden).toBe(false);
  });

  test('closing the last tab leaves a blank tab, with the pane shown', async () => {
    const ui = await start();
    await ui.closeTab('a.mmd');
    expect(ui.tabs()).toEqual(['New tab']);
    expect(pane().hidden).toBe(false);
  });

  test('a start with no file shows it; whether it is shown is not kept between runs', async () => {
    await startApp(new FakeDisk(), null);
    expect(pane().hidden).toBe(false);
    toggle().click();
    expect(pane().hidden).toBe(true);
    stopApps();
    await startApp(new FakeDisk(), null);
    expect(pane().hidden).toBe(false);
    expect(localStorage.getItem('recentpane')).toBeNull();
  });

  test('a start with a file to open (a double-click on it) never shows the pane on the way', async () => {
    const d = new FakeDisk();
    d.files.set(A, 'flowchart TD\n    a[A] --> b[B]\n');
    const make = d.backend.bind(d);
    d.backend = () => ({ ...make(), initialPath: async () => A });
    // Each change to the pane's `hidden`, as whether the pane was shown just before it.
    const seen: boolean[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records) if ((r.target as Element).matches('nav.recent')) seen.push(r.oldValue === null);
    });
    watch.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden'] });
    const ui = await startApp(d, null);
    await sleep(10);
    watch.disconnect();
    expect(ui.shown()).toBe('a.mmd');
    expect(pane().hidden).toBe(true);
    expect(seen).not.toContain(true);
  });

  test('each file opened goes on top, once; the shown tab\'s file is marked; each shows its folder and full path', async () => {
    const ui = await start();
    toggle().click();
    expect(names()).toEqual(['a.mmd']);
    await ui.app.open(B);
    toggle().click(); // opening a file hid the pane
    expect(names()).toEqual(['b.mmd', 'a.mmd']);
    expect(entry('b.mmd').classList.contains('current')).toBe(true);
    // Showing a tab marks its file, and leaves the order as it is (T1.16).
    ui.showTab('a.mmd');
    expect(names()).toEqual(['b.mmd', 'a.mmd']);
    expect(entry('a.mmd').classList.contains('current')).toBe(true);
    expect(entry('b.mmd').classList.contains('current')).toBe(false);
    // Opened again, after its tab was closed: on top again.
    await ui.closeTab('a.mmd');
    await ui.app.open(A);
    toggle().click();
    expect(names()).toEqual(['a.mmd', 'b.mmd']);
    expect(stored()).toEqual([A, B]);
    expect(entry('a.mmd').querySelector('.rfolder')!.textContent).toBe('proj/docs');
    expect(entry('a.mmd').querySelector<HTMLElement>('.rentry')!.title).toBe(A);
  });

  test('a click on an entry opens that file in a new tab after the shown one, which keeps its file (Q142)', async () => {
    localStorage.setItem('recent', JSON.stringify([C]));
    const ui = await start();
    toggle().click();
    entry('c.mmd').querySelector<HTMLButtonElement>('.rentry')!.click();
    await vi.waitFor(() => expect(shownName()).toBe('c.mmd'));
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
    toggle().click();
    expect(names()).toEqual(['c.mmd', 'a.mmd']);
  });

  test('a click on an entry while the shown file holds unsaved text asks nothing, and leaves that text in its tab', async () => {
    localStorage.setItem('recent', JSON.stringify([C]));
    const ui = await start();
    toggle().click();
    ui.type('flowchart TD\n    a[');
    await sleep(300);
    entry('c.mmd').querySelector<HTMLButtonElement>('.rentry')!.click();
    await vi.waitFor(() => expect(shownName()).toBe('c.mmd'));
    expect(disk.asked).toEqual([]);
    ui.showTab('a.mmd');
    expect(ui.area().value).toBe('flowchart TD\n    a[');
  });

  test('a click on the entry of a file open in another tab shows that tab', async () => {
    const ui = await start();
    await ui.app.open(B);
    toggle().click();
    entry('a.mmd').querySelector<HTMLButtonElement>('.rentry')!.click();
    await vi.waitFor(() => expect(shownName()).toBe('a.mmd'));
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
    expect(names()).toEqual(['b.mmd', 'a.mmd']);
  });

  test('× takes an entry off the list, and leaves the file alone', async () => {
    const ui = await start();
    await ui.app.open(B);
    toggle().click();
    const x = entry('a.mmd').querySelector<HTMLButtonElement>('.rremove')!;
    expect(x.getAttribute('aria-label')).toBe('Take a.mmd off the list');
    x.click();
    expect(names()).toEqual(['b.mmd']);
    expect(stored()).toEqual([B]);
    expect(disk.files.has(A)).toBe(true);
  });

  test('a file that cannot be found stays, grayed, with Not found; a click says so and changes nothing (Q137)', async () => {
    localStorage.setItem('recent', JSON.stringify([GONE]));
    const ui = await start();
    toggle().click();
    await vi.waitFor(() => expect(entry('x.mmd').classList.contains('missing')).toBe(true));
    expect(entry('x.mmd').querySelector('.rfolder')!.textContent).toBe('Not found');
    expect(entry('a.mmd').classList.contains('missing')).toBe(false);
    entry('x.mmd').querySelector<HTMLButtonElement>('.rentry')!.click();
    await vi.waitFor(() => expect(ui.toast()).toMatch(/^Could not open x\.mmd/));
    expect(shownName()).toBe('a.mmd');
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(names()).toEqual(['a.mmd', 'x.mmd']);
    expect(entry('x.mmd').classList.contains('missing')).toBe(true);
  });

  test('keeps 50, shows 25, and View more shows the next 25 (Q136)', async () => {
    localStorage.setItem('recent', JSON.stringify(Array.from({ length: 60 }, (_, i) => `C:/many/f${i}.mmd`)));
    await start();
    expect(stored()).toHaveLength(50);
    expect(stored()[0]).toBe(A);
    toggle().click();
    expect(items()).toHaveLength(25);
    const more = q<HTMLButtonElement>('nav.recent .more')!;
    expect(more.textContent).toBe('View more');
    more.click();
    expect(items()).toHaveLength(50);
    expect(q('nav.recent .more')).toBeNull();
  });

  test('with nothing in the list, the pane says what it is for', async () => {
    await start('browser');
    toggle().click();
    entry('a.mmd').querySelector<HTMLButtonElement>('.rremove')!.click();
    expect(items()).toHaveLength(0);
    expect(pane().textContent).toContain('Files you open show here.');
  });

  test('a file opened in another window shows here too', async () => {
    await start();
    toggle().click();
    localStorage.setItem('recent', JSON.stringify([C, A]));
    window.dispatchEvent(new StorageEvent('storage', { key: 'recent' }));
    expect(names()).toEqual(['c.mmd', 'a.mmd']);
  });

  test('it stays in View mode, where opening another file changes nothing', async () => {
    await start();
    q<HTMLButtonElement>('[data-act="view"]')!.click();
    await vi.waitFor(() => expect(q('[data-act="view"]')!.textContent!.trim()).toBe('View mode'));
    expect(toggle().hidden).toBe(false);
    toggle().click();
    expect(pane().hidden).toBe(false);
  });

  test('naiad serve\'s page, which shows one file only, has neither the pane nor its button, and keeps no list', async () => {
    await start('served');
    expect(q('[data-act="recent"]')).toBeNull();
    expect(q('nav.recent')).toBeNull();
    expect(localStorage.getItem('recent')).toBeNull();
  });
});
