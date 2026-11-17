// @vitest-environment jsdom
// T4.10, Naiad's own title bar (the user, 2026-11-17, Q171: "Yes"): the desktop window
// has no Windows title bar; Naiad's top row holds the tabs and, at its right end, three
// buttons of Naiad's own (minimize, maximize or restore, close). The empty part of the
// row, and the rail's mark, move the window, and a double-click on them maximizes it
// (Tauri's `data-tauri-drag-region`). A browser has its own frame, so the dev page and
// `naiad serve`'s page get none of this.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '../src/backend';
import { FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/hunt/flow.mmd';
const TEXT = 'flowchart TD\n    a(Start) --> b(End)\n';

async function start(kind: Backend['kind']) {
  const disk = new FakeDisk();
  disk.kind = kind;
  disk.files.set(FILE, TEXT);
  await startApp(disk, FILE);
  return disk;
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('header.top .winctl button')];

afterEach(() => stopApps());

describe("Naiad's own title bar (T4.10, Q171)", () => {
  it("the desktop window has no Windows title bar, and keeps its shadow and Windows 11's rounded corners", () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const [win] = conf.app.windows;
    expect(win.decorations).toBe(false);
    expect(win.shadow).not.toBe(false); // Tauri's default, true
  });

  it('the window may minimize, maximize, close and be dragged by its own buttons and top row', () => {
    const cap = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
    for (const p of ['core:window:allow-minimize', 'core:window:allow-toggle-maximize', 'core:window:allow-close', 'core:window:allow-start-dragging']) {
      expect(cap.permissions, p).toContain(p);
    }
  });

  it('the desktop app: three buttons at the right end of the top row, after the tabs', async () => {
    await start('desktop');
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual(['Minimize', 'Maximize', 'Close']);
    const row = document.querySelector('header.top')!;
    expect(row.lastElementChild!.classList.contains('winctl')).toBe(true);
    expect(row.querySelector('.tabs')!.compareDocumentPosition(row.querySelector('.winctl')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const b of buttons()) expect(b.querySelector('svg'), b.getAttribute('aria-label')!).not.toBeNull();
  });

  it('each button does what it says', async () => {
    const disk = await start('desktop');
    for (const b of buttons()) b.click();
    expect(disk.windowActs).toEqual(['minimize', 'toggleMaximize', 'close']);
  });

  it('the maximize button becomes Restore while the window is maximized, and back', async () => {
    const disk = await start('desktop');
    const max = () => buttons()[1];
    const drawn = () => max().querySelector('svg')!.getAttribute('data-icon');
    expect(drawn()).toBe('maximize');
    disk.setMaximized(true);
    expect(max().getAttribute('aria-label')).toBe('Restore');
    expect(max().title).toBe('Restore');
    expect(drawn()).toBe('restore');
    disk.setMaximized(false);
    expect(max().getAttribute('aria-label')).toBe('Maximize');
    expect(drawn()).toBe('maximize');
  });

  it("the top row's empty part and the rail's mark move the window; its buttons and tabs stay buttons", async () => {
    await start('desktop');
    // "deep": a press anywhere in the row moves the window, except on a button or a tab
    // (Tauri's drag script skips those).
    expect(document.querySelector('header.top')!.getAttribute('data-tauri-drag-region')).toBe('deep');
    expect(document.querySelector('.rail .mark')!.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('the close button is the red one, as in Windows', async () => {
    await start('desktop');
    expect(buttons()[2].classList.contains('winclose')).toBe(true);
    const css = readFileSync('src/style.css', 'utf8');
    expect(css).toMatch(/\.winctl button\.winclose:hover\s*\{[^}]*background:\s*#c42b1c/);
  });

  it('a browser (the dev page) has its own frame: no buttons, nothing moves the window', async () => {
    await start('browser');
    expect(document.querySelector('.winctl')).toBeNull();
    expect(document.querySelector('[data-tauri-drag-region]')).toBeNull();
  });

  it("naiad serve's page: no buttons either", async () => {
    await start('served');
    expect(document.querySelector('.winctl')).toBeNull();
    expect(document.querySelector('[data-tauri-drag-region]')).toBeNull();
  });
});
