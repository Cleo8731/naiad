// @vitest-environment jsdom
// The window's icons (T4.7, Q131 and Q132; the design handoff, T4.9): Undo and Redo in
// the island, the pill's tools and the rail's buttons show Lucide's icons, each with a
// name that says what it does. The mode button shows the mode Naiad is in (T4.9, in
// place of Q131's "where a click goes"); since the user's answer to Q158 (2026-11-15) it
// is on the rail's middle with the Touchpad and Mouse switch, and the add-node button is
// a plus alone. And the icon files copied into src/icons/ are plain drawings with their
// licence beside them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/icons/flow.mmd';
const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';
const ICON_DIR = join(__dirname, '..', 'src', 'icons');

async function start() {
  const disk = new FakeDisk();
  disk.files.set(FILE, TEXT);
  return startApp(disk, FILE);
}
const button = (act: string) => document.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
const iconOf = (act: string) => button(act).querySelector('svg')?.getAttribute('data-icon') ?? null;

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the icons (T4.7, T4.9)', () => {
  it('Undo, Redo, Fit and Highlight show an icon only, and say what they do', async () => {
    await start();
    const expected: Record<string, [string, string]> = {
      undo: ['Undo', 'undo'], redo: ['Redo', 'redo'], fit: ['Fit', 'fit'], highlight: ['Highlight', 'highlight'],
    };
    for (const [act, [label, icon]] of Object.entries(expected)) {
      const b = button(act);
      expect(b.classList.contains('icon'), act).toBe(true);
      expect(b.getAttribute('aria-label'), act).toBe(label);
      expect(b.title, act).not.toBe('');
      expect(iconOf(act), act).toBe(icon);
      expect(b.querySelector('svg')!.getAttribute('aria-hidden'), act).toBe('true');
      expect(b.textContent!.trim(), act).toBe('');
    }
  });

  it('the rail\'s buttons show an icon and a word; the add-node button a plus alone, named for screen readers', async () => {
    await start();
    for (const [act, word, icon] of [['syntax', 'Syntax', 'syntax'], ['about', 'About', 'about'], ['wheel', 'Mouse mode', 'mouse'], ['view', 'Edit mode', 'edit']]) {
      expect(button(act).textContent!.trim(), act).toBe(word);
      expect(iconOf(act), act).toBe(icon);
    }
    expect(button('add').textContent!.trim()).toBe('');
    expect(button('add').getAttribute('aria-label')).toBe('Add a node');
    expect(iconOf('add')).toBe('plus');
    expect(button('add').querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('the mode button shows the mode: the pencil while editing, the book in View mode', async () => {
    await start();
    expect(iconOf('view')).toBe('edit');
    expect(button('view').title).toMatch(/^Edit mode\. Click for View mode/);
    button('view').click();
    await vi.waitFor(() => expect(button('view').textContent!.trim()).toBe('View mode'));
    expect(iconOf('view')).toBe('read');
    expect(button('view').title).toMatch(/^View mode: the chart cannot be changed\. Click for Edit mode/);
    expect(button('view').getAttribute('aria-label')).toBeNull(); // its name, on the rail, says it
    button('view').click();
    await vi.waitFor(() => expect(button('view').textContent!.trim()).toBe('Edit mode'));
    expect(iconOf('view')).toBe('edit');
  });

  it('a start in View mode, remembered from the last run, shows the book', async () => {
    localStorage.setItem('mode', 'view');
    await start();
    expect(button('view').textContent!.trim()).toBe('View mode');
    expect(iconOf('view')).toBe('read');
  });
});

describe('the icon files (Q132)', () => {
  const files = readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg'));

  it('come with Lucide\'s licence', () => {
    const licence = readFileSync(join(ICON_DIR, 'LICENSE'), 'utf8');
    expect(licence).toContain('ISC License');
    expect(licence).toContain('Lucide Icons and Contributors');
    expect(licence).toContain('Cole Bemis');
  });

  it('are plain drawings: only svg, path, line, rect and circle, no script, no event handler, no link', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const svg = readFileSync(join(ICON_DIR, f), 'utf8');
      const tags = [...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
      expect(tags.every((t) => ['svg', 'path', 'line', 'rect', 'circle'].includes(t)), `${f}: ${tags.join(',')}`).toBe(true);
      expect(/\son[a-z]+\s*=|href|<script/i.test(svg), f).toBe(false);
      expect(svg).toContain('stroke="currentColor"');
    }
  });
});
