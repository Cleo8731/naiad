// @vitest-environment jsdom
// Remember opened files (T1.23, the user, 2026-11-14), the Settings window's first
// setting, on the real App with the chart stood in for (app-harness.ts): the switch, on
// until it is turned off (Q156); a start opens again the files open in the tabs at the
// last close, in their order, the shown one shown (Q155); a start on a named file adds
// it, shown, unless another Naiad window is running, which opens only that file (Q157);
// files gone are skipped and named; the recent list is not reordered; `naiad serve`'s
// page keeps nothing.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const B = 'C:/proj/b.mmd';
const C = 'C:/proj/c.mmd';
const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const button = (act: string) => q<HTMLButtonElement>(`[data-act="${act}"]`)!;
const settings = () => q<HTMLDialogElement>('dialog.overlay-window[data-window="settings"]');
const theSwitch = () => settings()!.querySelector<HTMLInputElement>('input.switch')!;

let disk: FakeDisk;
/** A fresh disk holding a, b and c, with Naiad started on `path` (none: from the Start menu). */
async function first(kind: FakeDisk['kind'] = 'desktop', path: string | null = null) {
  disk = new FakeDisk();
  disk.kind = kind;
  for (const f of [A, B, C]) disk.files.set(f, TEXT);
  disk.startFile = path;
  return startApp(disk, null);
}
/** Naiad closes (its window asks `canClose`, which says yes), then starts again on the same disk. */
async function closeAndStart(path: string | null = null, other = false) {
  expect(await disk.closeGuard!()).toBe(true);
  return startAgain(path, other);
}
/** Naiad starts again without its window having closed (Windows shut down, say). */
async function startAgain(path: string | null = null, other = false) {
  stopApps();
  disk.startFile = path;
  disk.otherWindow = other;
  return startApp(disk, null);
}
/** Shows the recent list's pane and opens the Settings window. */
function openSettings() {
  if (q<HTMLElement>('nav.recent')!.hidden) button('recent').click();
  button('settings').click();
  return settings()!;
}
function turn(on: boolean) {
  const s = theSwitch();
  s.checked = on;
  s.dispatchEvent(new Event('change'));
}

beforeAll(() => {
  // jsdom has no modal dialogs: these stand in for the browser's.
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  proto.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the switch in the Settings window', () => {
  test('Settings holds Remember opened files, an on-off switch, on until it is turned off (Q156)', async () => {
    await first();
    const w = openSettings();
    const s = theSwitch();
    expect(s.type).toBe('checkbox');
    expect(s.getAttribute('role')).toBe('switch');
    expect(s.checked).toBe(true);
    expect(s.labels![0].textContent).toBe('Remember opened files');
    expect(w.querySelector('.ow-note')!.textContent).toBe('When Naiad starts, it opens again the files that were open when it last closed.');
    expect(w.textContent).not.toContain('Nothing to set yet.');
  });

  test('turned off, it stays off at the next start', async () => {
    await first();
    openSettings();
    turn(false);
    await closeAndStart();
    openSettings();
    expect(theSwitch().checked).toBe(false);
  });

  test('the dev page has it too; naiad serve\'s page has no Settings and keeps nothing', async () => {
    await first('browser');
    openSettings();
    expect(theSwitch().checked).toBe(true);
    stopApps();
    localStorage.clear();
    disk = new FakeDisk();
    disk.kind = 'served';
    disk.files.set(A, TEXT);
    await startApp(disk, A);
    expect(q('[data-act="settings"]')).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k !== 'recent' && localStorage.getItem(k)?.includes('a.mmd'))).toEqual([]);
  });
});

describe('a start opens the files of the last close (Q155)', () => {
  test('in their order, with the tab that was shown shown', async () => {
    const ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    await ui.app.open(C);
    ui.showTab('b.mmd');
    const again = await closeAndStart();
    expect(again.tabs()).toEqual(['a.mmd', 'b.mmd', 'c.mmd']);
    expect(again.shown()).toBe('b.mmd');
    expect(disk.title).toBe('b.mmd - Naiad');
    // The recent list's pane goes, as it does when a flowchart opens.
    expect(q<HTMLElement>('nav.recent')!.hidden).toBe(true);
  });

  test('a blank tab is not kept, and one left alone gives the start of before', async () => {
    let ui = await first();
    await ui.app.open(A);
    button('newtab').click();
    ui = await closeAndStart();
    expect(ui.tabs()).toEqual(['a.mmd']);
    await ui.closeTab('a.mmd');
    expect(ui.tabs()).toEqual(['New tab']);
    ui = await closeAndStart();
    expect(ui.tabs()).toEqual(['New tab']);
    expect(q<HTMLElement>('nav.recent')!.hidden).toBe(false);
  });

  test('each opening, closing and showing of a tab is kept at once, without the window closing', async () => {
    let ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    await ui.app.open(C);
    await ui.closeTab('b.mmd');
    ui.showTab('a.mmd');
    ui = await startAgain();
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
    expect(ui.shown()).toBe('a.mmd');
  });

  test('a file no longer there is skipped, and one notice names it', async () => {
    let ui = await first();
    for (const f of [A, B, C]) await ui.app.open(f);
    disk.files.delete(B);
    ui = await closeAndStart();
    expect(ui.tabs()).toEqual(['a.mmd', 'c.mmd']);
    expect(ui.shown()).toBe('c.mmd');
    expect(ui.toast()).toBe('b.mmd was not found, so it was not opened again.');
  });

  test('every file gone: the start of before, one blank tab and the recent list\'s pane', async () => {
    let ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    disk.files.delete(A);
    disk.files.delete(B);
    ui = await closeAndStart();
    expect(ui.tabs()).toEqual(['New tab']);
    expect(ui.toast()).toBe('a.mmd and b.mmd were not found, so they were not opened again.');
    expect(q<HTMLElement>('nav.recent')!.hidden).toBe(false);
  });

  test('opening them again does not reorder the recent list', async () => {
    const ui = await first();
    for (const f of [A, B, C]) await ui.app.open(f);
    await ui.closeTab('c.mmd');
    // The list is c, b, a; opening a then b again would make it b, a, c.
    const before = localStorage.getItem('recent');
    expect(before!.indexOf('c.mmd')).toBeLessThan(before!.indexOf('a.mmd'));
    await closeAndStart();
    await sleep(10);
    expect(localStorage.getItem('recent')).toBe(before);
  });

  test('the window closed last is the one remembered: closing writes its files once more', async () => {
    const ui = await first();
    await ui.app.open(A);
    // Another window, opened on c.mmd, wrote its files after this window's last change.
    localStorage.setItem('opentabs', JSON.stringify({ files: [C], shown: C }));
    const again = await closeAndStart();
    expect(again.tabs()).toEqual(['a.mmd']);
  });
});

describe('turning the switch off and on', () => {
  test('off: the kept files are forgotten at once, and the next start opens none', async () => {
    let ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    openSettings();
    turn(false);
    await ui.app.open(C);
    ui = await closeAndStart();
    expect(ui.tabs()).toEqual(['New tab']);
  });

  test('on again: this window\'s files are kept at once', async () => {
    let ui = await first();
    openSettings();
    turn(false);
    await ui.app.open(A);
    await ui.app.open(B);
    turn(true);
    ui = await startAgain();
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
  });
});

describe('a start on a named file (Q157)', () => {
  test('no other window: the kept files, then the named file, shown', async () => {
    let ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    ui.showTab('a.mmd');
    ui = await closeAndStart(C);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd', 'c.mmd']);
    expect(ui.shown()).toBe('c.mmd');
  });

  test('a named file among the kept ones opens once, and is shown', async () => {
    let ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    ui = await closeAndStart(A);
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
    expect(ui.shown()).toBe('a.mmd');
  });

  test('another Naiad window running: only the named file opens', async () => {
    let ui = await first();
    await ui.app.open(A);
    await ui.app.open(B);
    ui = await startAgain(C, true);
    expect(ui.tabs()).toEqual(['c.mmd']);
  });

  test('another Naiad window running and no file named: one blank tab, as the kept files are that window\'s', async () => {
    let ui = await first();
    await ui.app.open(A);
    ui = await startAgain(null, true);
    expect(ui.tabs()).toEqual(['New tab']);
  });

  test('with the switch off: only the named file', async () => {
    let ui = await first();
    await ui.app.open(A);
    openSettings();
    turn(false);
    ui = await closeAndStart(B);
    expect(ui.tabs()).toEqual(['b.mmd']);
  });
});
