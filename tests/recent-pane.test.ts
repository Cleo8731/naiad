// @vitest-environment jsdom
// The recent list's pane (T1.15, stage 1 of D1.6), on the real App with the chart stood
// in for (app-harness.ts): its button at the toolbar's left end, hidden at the first
// start and then remembered; each file opened goes on top; a click opens an entry in the
// shown tab when it is blank, otherwise in a new tab, and shows a file already open
// (Q142, T1.16); × takes it off the list; a file that cannot be found stays, greyed
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
const toggle = () => q<HTMLButtonElement>('.bar [data-act="recent"]')!;
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
  test('its button is the toolbar\'s first, an icon that says what it does; the pane is hidden at the first start', async () => {
    await start();
    expect(q('.bar')!.firstElementChild).toBe(toggle());
    expect(toggle().classList.contains('icon')).toBe(true);
    expect(toggle().querySelector('svg')!.getAttribute('data-icon')).toBe('recent');
    expect(toggle().getAttribute('aria-label')).toBe('Recent files');
    expect(toggle().title).toBe('Show recent files');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(pane().hidden).toBe(true);
    // The pane comes first in the window's row, left of the Syntax pane.
    expect(q('main')!.firstElementChild).toBe(pane());
  });

  test('a click shows it, and Naiad remembers whether it is shown', async () => {
    await start();
    toggle().click();
    expect(pane().hidden).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().title).toBe('Hide recent files');
    expect(localStorage.getItem('recentpane')).toBe('shown');
    stopApps();
    await start();
    expect(pane().hidden).toBe(false);
    toggle().click();
    expect(pane().hidden).toBe(true);
    expect(localStorage.getItem('recentpane')).toBe('hidden');
  });

  test('each file opened goes on top, once; the shown tab\'s file is marked; each shows its folder and full path', async () => {
    const ui = await start();
    toggle().click();
    expect(names()).toEqual(['a.mmd']);
    await ui.app.open(B);
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

  test('a file that cannot be found stays, greyed, with Not found; a click says so and changes nothing (Q137)', async () => {
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
    q<HTMLButtonElement>('.bar [data-act="view"]')!.click();
    await vi.waitFor(() => expect(q('.bar [data-act="view"]')!.getAttribute('aria-pressed')).toBe('true'));
    expect(toggle().hidden).toBe(false);
    toggle().click();
    expect(pane().hidden).toBe(false);
  });

  test('naiad serve\'s page, which shows one file only, has neither the pane nor its button, and keeps no list', async () => {
    await start('served');
    expect(q('.bar [data-act="recent"]')).toBeNull();
    expect(q('nav.recent')).toBeNull();
    expect(localStorage.getItem('recent')).toBeNull();
  });
});
