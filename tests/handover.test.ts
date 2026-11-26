// @vitest-environment jsdom
// T6.1: a file opened while Naiad runs (a double-click, or `naiad <file>`) is handed to
// the running window by the desktop shell (src-tauri/src/lib.rs, `hand_over`), and the
// page opens it as a tab (Q213); a file already open shows its tab, never a second copy
// (Q214). Here the shell's hand-over is stood in for by the harness's `handOver`.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const B = 'C:/proj/b.mmd';
const C = 'C:/proj/c.mmd';
const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';

let disk: FakeDisk;
async function start(path: string | null = null) {
  disk = new FakeDisk();
  for (const f of [A, B, C]) disk.files.set(f, TEXT);
  disk.startFile = path;
  return startApp(disk, null);
}
/** Waits until the window's opens have run (each open reads the file, then draws). */
async function settle() { for (let i = 0; i < 20; i++) await sleep(5); }

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('files handed over by a later start', () => {
  test('a file opens on the blank tab Naiad started with, and is shown', async () => {
    const ui = await start();
    expect(ui.tabs()).toEqual(['New tab']);
    disk.handOver([A]);
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(ui.shown()).toBe('a.mmd');
    expect(disk.title).toBe('a.mmd - Naiad');
  });

  test('beside open files, each comes as a new tab after the shown one, in order, the last shown', async () => {
    const ui = await start(A);
    disk.handOver([B, C]);
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd', 'c.mmd']);
    expect(ui.shown()).toBe('c.mmd');
  });

  test('a file already open shows its tab, with no second copy (Q214)', async () => {
    const ui = await start(A);
    await ui.app.open(B);
    expect(ui.shown()).toBe('b.mmd');
    disk.handOver(['c:/PROJ/A.mmd']);
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd']);
    expect(ui.shown()).toBe('a.mmd');
  });

  test('a file that cannot be read leaves the tabs as they were and says so', async () => {
    const ui = await start(A);
    disk.handOver(['C:/proj/gone.mmd']);
    await settle();
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(ui.shown()).toBe('a.mmd');
    expect(document.body.textContent).toContain('gone.mmd');
  });

  test('a handed-over file goes to the top of the recent list', async () => {
    await start(A);
    disk.handOver([B]);
    await settle();
    const recent = JSON.parse(localStorage.getItem('recent') ?? '[]') as string[];
    expect(recent[0]).toBe(B);
  });
});
