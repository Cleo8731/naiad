// @vitest-environment jsdom
// The toolbar's icons (T4.7, Q131 and Q132): Undo, Redo, Highlight, Syntax and the View
// button show Lucide's icons instead of words, each with a label that says what it does;
// the View button, like Obsidian's, shows where a click goes. And the icon files copied
// into src/icons/ are plain drawings with their licence beside them.
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
const button = (act: string) => document.querySelector<HTMLButtonElement>(`.bar [data-act="${act}"]`)!;
const iconOf = (act: string) => button(act).querySelector('svg')?.getAttribute('data-icon') ?? null;

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the toolbar icons (T4.7)', () => {
  it('Undo, Redo, Highlight, Syntax and View show an icon and say what they do', async () => {
    await start();
    const expected: Record<string, [string, string]> = {
      undo: ['Undo', 'undo'], redo: ['Redo', 'redo'], highlight: ['Highlight', 'highlight'],
      syntax: ['Syntax', 'syntax'], view: ['View mode', 'read'],
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

  it('the buttons the user did not name keep their words', async () => {
    await start();
    for (const [act, word] of [['add', '+ Node'], ['fit', 'Fit'], ['about', 'About'], ['open', 'Open']]) {
      expect(button(act).classList.contains('icon'), act).toBe(false);
      expect(button(act).textContent!.trim(), act).toBe(word);
    }
  });

  it('the View button shows where a click goes: the book while editing, the pencil in View mode', async () => {
    await start();
    expect(iconOf('view')).toBe('read');
    expect(button('view').title).toMatch(/^Editing\. Click for View mode/);
    button('view').click();
    await vi.waitFor(() => expect(button('view').getAttribute('aria-pressed')).toBe('true'));
    expect(iconOf('view')).toBe('edit');
    expect(button('view').title).toMatch(/^View mode: reading without changing\. Click to edit/);
    expect(button('view').getAttribute('aria-label')).toBe('View mode');
    button('view').click();
    await vi.waitFor(() => expect(button('view').getAttribute('aria-pressed')).toBe('false'));
    expect(iconOf('view')).toBe('read');
  });

  it('a start in View mode, remembered from the last run, shows the pencil', async () => {
    localStorage.setItem('mode', 'view');
    await start();
    expect(button('view').getAttribute('aria-pressed')).toBe('true');
    expect(iconOf('view')).toBe('edit');
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

  it('are plain drawings: only svg, path and rect, no script, no event handler, no link', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const svg = readFileSync(join(ICON_DIR, f), 'utf8');
      const tags = [...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
      expect(tags.every((t) => ['svg', 'path', 'rect'].includes(t)), `${f}: ${tags.join(',')}`).toBe(true);
      expect(/\son[a-z]+\s*=|href|<script/i.test(svg), f).toBe(false);
      expect(svg).toContain('stroke="currentColor"');
    }
  });
});
