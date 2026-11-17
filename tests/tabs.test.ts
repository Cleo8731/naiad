// @vitest-environment jsdom
// Tabs (T1.16, stage 2 of D1.6): several flowcharts in one window, on the real App with
// the chart stood in for (app-harness.ts). The strip, the + and the blank tab (Q140);
// opening into a new tab and showing a file already open (Q140, Q142); closing a tab
// (Q143) and the window; what each tab keeps and what the window keeps; a hidden tab's
// file changed on disk; one drawing at a time for the page.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { charts, chartTiming, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const B = 'C:/proj/b.mmd';
const C = 'C:/proj/c.mmd';
const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';
const BROKEN = TEXT + '    c[[[ unfinished\n';
const lose = (name: string, what: string) => `${name} holds a change that is not saved (Mermaid cannot read the text). ${what} and lose it?`;

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const strip = () => q<HTMLElement>('.tabs')!;
const plus = () => q<HTMLButtonElement>('.tabs [data-act="newtab"]')!;
const tabOf = (name: string) => [...document.querySelectorAll<HTMLElement>('.tabs .tab')].find((t) => t.querySelector('.tname')!.textContent === name)!;
/** The shown tab's own part of the window: its chart area, its sidebar and its notices. */
const shownView = () => q<HTMLElement>('.tabview:not([hidden])')!;
/** Every tab's Syntax text, shown or not, in the order the tabs were made. */
const paneTexts = () => [...document.querySelectorAll<HTMLTextAreaElement>('.textpane textarea')].map((t) => t.value);
const clear = () => q<HTMLButtonElement>('[data-act="clear"]')!;
const key = (k: string, ctrl = true) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: ctrl, bubbles: true, cancelable: true }));

let disk: FakeDisk;
async function start(kind?: FakeDisk['kind'], setup?: (d: FakeDisk) => void) {
  disk = new FakeDisk();
  if (kind) disk.kind = kind;
  for (const f of [A, B, C]) disk.files.set(f, TEXT);
  setup?.(disk);
  return startApp(disk, A);
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); chartTiming.drawDelay = 0; });

describe('the tab strip', () => {
  test('shows one tab named after the file, with its path as the tooltip, and ends with a + that says what it does', async () => {
    const ui = await start();
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(ui.shown()).toBe('a.mmd');
    expect(tabOf('a.mmd').querySelector<HTMLElement>('.tname')!.title).toBe(A);
    expect(tabOf('a.mmd').querySelector('.tclose')!.getAttribute('aria-label')).toBe('Close a.mmd');
    expect(strip().lastElementChild).toBe(plus());
    expect(plus().getAttribute('aria-label')).toBe('New tab');
    expect(plus().querySelector('svg')!.getAttribute('data-icon')).toBe('plus');
    // The tabs row, beside the rail, holds the tab strip alone (T1.18, T1.21, T4.9).
    const top = strip().parentElement!;
    expect(top).toBe(q('.column')!.firstElementChild);
    expect(top.children).toHaveLength(1);
  });

  test('the chart\'s tools lie over the shown tab\'s chart, under the tabs row (T4.9)', async () => {
    await start();
    const area = shownView().querySelector('.chartarea')!;
    expect(area.contains(q('[data-act="add"]'))).toBe(true);
    // The mode button and the Touchpad and Mouse switch are on the rail (Q158's answer).
    expect(q('.rail-mid')!.contains(q('[data-act="view"]'))).toBe(true);
    expect(q('.rail-mid')!.contains(q('[data-act="wheel"]'))).toBe(true);
    expect(area.contains(q('[data-act="undo"]'))).toBe(true);
    // Under the tabs row: the recent list's pane, the Syntax pane, the chart and the sidebar.
    expect(strip().parentElement!.nextElementSibling).toBe(q('main'));
    expect(q('main')!.contains(q('nav.recent'))).toBe(true);
    expect(q('.body')!.contains(q('.textpane'))).toBe(true);
    expect(q('.body')!.contains(q('.stage'))).toBe(true);
  });

  test('the chart\'s tools keep the shown tab\'s saved state, unseen, and neither the file\'s name nor Open and New (Q140)', async () => {
    const ui = await start('desktop');
    const tools = '.island-row, .pill';
    expect(q(`:is(${tools}) .name`)).toBeNull();
    expect(q(`:is(${tools}) [data-act="open"]`)).toBeNull();
    expect(q(`:is(${tools}) [data-act="new"]`)).toBeNull();
    expect(ui.status()).toBe('Saved');
    expect(disk.title).toBe('a.mmd - Naiad');
  });

  test('the + opens a blank tab after the shown one, named New tab, showing Open a file and New flowchart (Q140)', async () => {
    const ui = await start('desktop');
    await ui.app.open(B);
    ui.showTab('a.mmd');
    plus().click();
    expect(ui.tabs()).toEqual(['a.mmd', 'New tab', 'b.mmd']);
    expect(ui.shown()).toBe('New tab');
    const empty = shownView().querySelector<HTMLElement>('.empty')!;
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('h1')!.textContent).toBe('No file open');
    expect(empty.querySelector('[data-act="open"]')!.textContent!.trim()).toBe('Open a file');
    expect(empty.querySelector('[data-act="new"]')!.textContent!.trim()).toBe('New flowchart');
    expect(ui.status()).toBe('');
    expect(ui.undoEnabled()).toBe(false);
    expect(disk.title).toBe('Naiad');
  });

  test('a blank tab shows no notice, with the Syntax pane hidden or shown: it has no text to find fault with', async () => {
    const ui = await start();
    plus().click();
    expect(ui.shown()).toBe('New tab');
    const notices = () => shownView().querySelector('.notices')!.children.length;
    expect(notices()).toBe(0);
    q<HTMLButtonElement>('[data-act="syntax"]')!.click();
    expect(notices()).toBe(0);
  });

  test('Open on a blank tab fills that tab with the file', async () => {
    const ui = await start();
    plus().click();
    disk.picked = B;
    shownView().querySelector<HTMLButtonElement>('.empty [data-act="open"]')!.click();
    await vi.waitFor(() => expect(ui.shown()).toBe('b.mmd'));
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
    expect(ui.area().value).toBe(TEXT);
    expect(disk.title).toBe('b.mmd - Naiad');
    expect(disk.viewed).toEqual([A, B]);
  });

  test('a tab holding a file is never replaced: Ctrl+O does nothing on it, and opens the file dialog on a blank tab (Q140)', async () => {
    const ui = await start();
    disk.picked = B;
    key('o');
    await sleep(20);
    expect(disk.picks).toBe(0);
    expect(ui.tabs()).toEqual(['a.mmd']);
    plus().click();
    key('o');
    await vi.waitFor(() => expect(ui.shown()).toBe('b.mmd'));
    expect(disk.picks).toBe(1);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
  });

  test('opening a file already open shows its tab, and the blank tab it was picked from closes', async () => {
    const ui = await start();
    await ui.app.open(B);
    plus().click();
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd', 'New tab']);
    disk.picked = A;
    shownView().querySelector<HTMLButtonElement>('.empty [data-act="open"]')!.click();
    await vi.waitFor(() => expect(ui.shown()).toBe('a.mmd'));
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
  });

  test('a file opened while a file\'s tab is shown opens in a new tab right after it', async () => {
    const ui = await start();
    await ui.app.open(B);
    ui.showTab('a.mmd');
    await ui.app.open(C);
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd', 'b.mmd']);
    expect(ui.shown()).toBe('c.mmd');
    expect(disk.viewed).toEqual([A, C, B]);
  });

  test('a file that cannot be read adds no tab', async () => {
    const ui = await start();
    await ui.app.open('C:/proj/missing.mmd');
    expect(ui.toast()).toMatch(/^Could not open missing\.mmd/);
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(ui.shown()).toBe('a.mmd');
  });

  test('the recent list marks the shown tab\'s file, and nothing for a blank tab', async () => {
    const ui = await start();
    await ui.app.open(B);
    q<HTMLButtonElement>('[data-act="recent"]')!.click();
    expect(q('nav.recent li.current .rname')!.textContent).toBe('b.mmd');
    ui.showTab('a.mmd');
    expect(q('nav.recent li.current .rname')!.textContent).toBe('a.mmd');
    plus().click();
    expect(q('nav.recent li.current')).toBeNull();
  });

  test('naiad serve\'s page shows its one file with no strip', async () => {
    const ui = await start('served');
    expect(q('.tabs')).toBeNull();
    // No tabs row: the rail, then the chart with its tools (T4.9).
    expect(q('header.top')).toBeNull();
    expect(q('.rail')!.contains(q('[data-act="syntax"]'))).toBe(true);
    expect(shownView().querySelector('.chartarea')!.contains(q('[data-act="add"]'))).toBe(true);
    expect(q('.rail')!.contains(q('[data-act="view"]'))).toBe(true);
    expect(ui.area().value).toBe(TEXT);
    expect(ui.status()).toBe('Saved');
  });
});

describe('closing a tab (Q143)', () => {
  test('× closes a tab at once when nothing would be lost, shows the tab to its right, and stops watching its file', async () => {
    const ui = await start();
    await ui.app.open(B);
    await ui.app.open(C);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd', 'c.mmd']);
    ui.showTab('b.mmd');
    await ui.closeTab('b.mmd');
    expect(disk.asked).toEqual([]);
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
    expect(ui.shown()).toBe('c.mmd');
    expect(disk.watchers.get(B)!.size).toBe(0);
    expect(disk.viewed).toEqual([A, C]);
    expect(charts.list[1].destroyed).toBe(true);
    expect(document.querySelectorAll('.tabview')).toHaveLength(2);
    expect(paneTexts()).toHaveLength(2);
  });

  test('the last tab on the right, closed, shows the one to its left; a hidden tab closed leaves the shown one shown', async () => {
    const ui = await start();
    await ui.app.open(B);
    await ui.app.open(C);
    await ui.closeTab('c.mmd');
    expect(ui.shown()).toBe('b.mmd');
    await ui.closeTab('a.mmd');
    expect(ui.tabs()).toEqual(['b.mmd']);
    expect(ui.shown()).toBe('b.mmd');
  });

  test('× on a hidden tab that would lose text shows that tab first, then asks; No keeps it, Yes closes it', async () => {
    const ui = await start();
    ui.type(BROKEN);
    await sleep(400);
    await ui.app.open(B);
    expect(ui.shown()).toBe('b.mmd');
    const seen: (string | null)[] = [];
    disk.onAsk = () => seen.push(ui.shown());
    disk.answer = false;
    await ui.closeTab('a.mmd');
    expect(disk.asked).toEqual([lose('a.mmd', 'Close a.mmd')]);
    expect(seen).toEqual(['a.mmd']);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
    expect(ui.area().value).toBe(BROKEN);
    disk.answer = true;
    await ui.closeTab('a.mmd');
    expect(ui.tabs()).toEqual(['b.mmd']);
    expect(disk.files.get(A)).toBe(TEXT);
  });

  test('a second click on × while Naiad asks does not ask again', async () => {
    const ui = await start();
    ui.type(BROKEN);
    await sleep(400);
    disk.answer = false;
    const x = tabOf('a.mmd').querySelector<HTMLButtonElement>('.tclose')!;
    x.click();
    x.click();
    const closing = (ui.app as unknown as { closing: Set<unknown> }).closing;
    await vi.waitFor(() => expect(closing.size).toBe(0));
    expect(disk.asked).toHaveLength(1);
    expect(ui.tabs()).toEqual(['a.mmd']);
  });

  test('closing the last tab leaves one blank tab, which has no ×', async () => {
    const ui = await start();
    await ui.closeTab('a.mmd');
    expect(ui.tabs()).toEqual(['New tab']);
    expect(shownView().querySelector<HTMLElement>('.empty')!.hidden).toBe(false);
    expect(tabOf('New tab').querySelector<HTMLElement>('.tclose')!.hidden).toBe(true);
    expect(disk.watchers.get(A)!.size).toBe(0);
    expect(disk.viewed).toEqual([]);
    expect(disk.title).toBe('Naiad');
    expect(ui.status()).toBe('');
  });

  test('a blank tab beside a file\'s tab closes with its ×', async () => {
    const ui = await start();
    plus().click();
    expect(tabOf('New tab').querySelector<HTMLElement>('.tclose')!.hidden).toBe(false);
    await ui.closeTab('New tab');
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(ui.shown()).toBe('a.mmd');
  });
});

describe('what each tab keeps, and what the window keeps', () => {
  test('Undo acts on the shown tab only, and each tab keeps its own history', async () => {
    const ui = await start();
    ui.direction('LR');
    await vi.waitFor(() => expect(disk.files.get(A)).toMatch(/^flowchart LR/));
    await ui.app.open(B);
    expect(ui.undoEnabled()).toBe(false);
    key('z');
    await sleep(50);
    expect(disk.files.get(A)).toMatch(/^flowchart LR/);
    expect(ui.area().value).toBe(TEXT);
    ui.showTab('a.mmd');
    expect(ui.undoEnabled()).toBe(true);
    ui.undo();
    expect(await ui.until((t) => t.startsWith('flowchart TD'))).toBe(true);
    await vi.waitFor(() => expect(disk.files.get(A)).toBe(TEXT));
  });

  test('each tab keeps its selection and its sidebar as it was left', async () => {
    const ui = await start();
    (ui.app as unknown as { select(t: unknown): void }).select({ kind: 'node', id: 'a' });
    expect(shownView().querySelector<HTMLTextAreaElement>('.sidebar textarea.title')!.value).toBe('A');
    await ui.app.open(B);
    expect(shownView().querySelector('.sidebar textarea.title')).toBeNull();
    ui.showTab('a.mmd');
    expect(shownView().querySelector<HTMLTextAreaElement>('.sidebar textarea.title')!.value).toBe('A');
  });

  test('View mode and the Highlight switch are the window\'s, so they hold in every tab', async () => {
    const ui = await start();
    await ui.app.open(B);
    q<HTMLButtonElement>('[data-act="highlight"]')!.click();
    q<HTMLButtonElement>('[data-act="view"]')!.click();
    await vi.waitFor(() => expect(q('[data-act="view"]')!.textContent!.trim()).toBe('View mode'));
    ui.showTab('a.mmd');
    expect(ui.area().readOnly).toBe(true);
    expect(q('[data-act="highlight"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  test('the toolbar\'s Clear follows the shown tab\'s highlights', async () => {
    const ui = await start(undefined, (d) => d.highlights.set(A, 'a\n'));
    await vi.waitFor(() => expect(clear().hidden).toBe(false));
    await ui.app.open(B);
    expect(clear().hidden).toBe(true);
    ui.showTab('a.mmd');
    await vi.waitFor(() => expect(clear().hidden).toBe(false));
  });

  test('a hidden tab\'s file changed on disk is reloaded at once, and drawn when it is shown', async () => {
    const ui = await start();
    await ui.app.open(B);
    const changed = 'flowchart LR\n    x[X]\n';
    disk.outside(A, changed);
    await vi.waitFor(() => expect(paneTexts()[0]).toBe(changed));
    await sleep(20);
    expect(charts.list[0].drawn).not.toContain(changed);
    expect(ui.status()).toBe('Saved'); // the shown tab's state, not the hidden one's
    expect(ui.toast()).toBe('');
    ui.showTab('a.mmd');
    await vi.waitFor(() => expect(charts.list[0].drawn.at(-1)).toBe(changed));
    expect(ui.status()).toMatch(/^Reloaded from disk/);
  });

  test('two tabs never draw at the same moment: one Mermaid for the page', async () => {
    chartTiming.drawDelay = 200;
    const ui = await start();
    ui.direction('LR'); // the shown tab draws again
    await ui.app.open(B); // the new tab draws as it opens
    await ui.until((t) => t === TEXT);
    ui.showTab('a.mmd');
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
    await vi.waitFor(() => expect(charts.list[0].drawn.at(-1)).toMatch(/^flowchart LR/));
    expect(charts.list[1].drawn).toEqual([TEXT]);
    expect(charts.most).toBe(1);
  });

  test('a file opened in a blank tab is drawn with its sidebar already open, so the chart is fitted to the room it keeps', async () => {
    await start(); // a.mmd, given at start, fills the first blank tab
    expect(charts.list[0].sidebarShown).toEqual([true]);
    plus().click();
    disk.picked = B;
    shownView().querySelector<HTMLButtonElement>('.empty [data-act="open"]')!.click();
    await vi.waitFor(() => expect(charts.list[1].drawn).toEqual([TEXT]));
    expect(charts.list[1].sidebarShown).toEqual([true]);
  });
});

describe('closing the window', () => {
  async function twoUnsaved() {
    const ui = await start();
    ui.type(BROKEN);
    await sleep(400);
    await ui.app.open(B);
    ui.type(BROKEN);
    await sleep(400);
    await ui.app.open(C);
    return ui;
  }

  test('asks about each tab that would lose text, showing that tab first', async () => {
    const ui = await twoUnsaved();
    const seen: (string | null)[] = [];
    disk.onAsk = () => seen.push(ui.shown());
    disk.answer = true;
    expect(await disk.closeGuard!()).toBe(true);
    expect(disk.asked).toEqual([lose('a.mmd', 'Close Naiad'), lose('b.mmd', 'Close Naiad')]);
    expect(seen).toEqual(['a.mmd', 'b.mmd']);
  });

  test('No keeps the window open, on the tab asked about, and asks no more', async () => {
    const ui = await twoUnsaved();
    disk.answer = false;
    expect(await disk.closeGuard!()).toBe(false);
    expect(disk.asked).toEqual([lose('a.mmd', 'Close Naiad')]);
    expect(ui.shown()).toBe('a.mmd');
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd', 'c.mmd']);
  });

  test('the browser asks before the page goes when any tab holds text not yet saved', async () => {
    const ui = await start();
    ui.type(BROKEN);
    await sleep(400);
    await ui.app.open(B);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
