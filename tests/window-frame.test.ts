// @vitest-environment jsdom
// The toolbar's two ends, the pane's foot and the windows it opens (T1.21 and T4.8, the
// user, 2026-11-14), on the real App with the chart stood in for (app-harness.ts): the
// Recent files button at the toolbar's left end and the recent list's pane under the
// toolbar; Customize and Settings at the pane's foot, apart from the list, which scrolls
// alone; the caret button at the toolbar's right end, which hides the top row and turns
// upside down; the Customize window's Appearance (Light, Dark, System); none of these in
// `naiad serve`'s page.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { charts, chartTheme, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const tools = () => q<HTMLElement>('.bar.tools')!;
const top = () => q<HTMLElement>('header.top');
const button = (act: string) => q<HTMLButtonElement>(`[data-act="${act}"]`)!;
const overlay = (name: string) => q<HTMLDialogElement>(`dialog.overlay-window[data-window="${name}"]`);
const isOpen = (d: HTMLDialogElement | null) => !!d?.hasAttribute('open');
const radio = (value: string) => q<HTMLInputElement>(`dialog[data-window="customize"] input[name="appearance"][value="${value}"]`)!;
const theme = () => document.documentElement.getAttribute('data-theme');
const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

/** The stylesheet's rules, as selector and declarations. */
const css = readFileSync(resolve('src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
const rule = (sel: string) => rules.find((r) => r.sel.split(',').map((s) => s.trim()).includes(sel))?.body ?? null;

let disk: FakeDisk;
async function start(kind?: FakeDisk['kind'], path: string | null = A) {
  disk = new FakeDisk();
  if (kind) disk.kind = kind;
  disk.files.set(A, 'flowchart TD\n    a[A] --> b[B]\n');
  return startApp(disk, path);
}
/** Starts the window again, as after closing Naiad and opening it (what the app keeps stays). */
async function restart() {
  stopApps();
  return start();
}
/** Shows the recent list's pane and opens one of the windows at its foot. */
function openWindow(act: 'customize' | 'settings') {
  if (q<HTMLElement>('nav.recent')!.hidden) button('recent').click();
  button(act).click();
  return overlay(act)!;
}

const realMatchMedia = window.matchMedia;
/** The computer's own light or dark setting, as `matchMedia` reports it. */
function systemDark(dark: boolean) {
  window.matchMedia = (() => ({ matches: dark, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

beforeAll(() => {
  // jsdom has no modal dialogs: these stand in for the browser's.
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  proto.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
beforeEach(() => { localStorage.clear(); chartTheme.dark = null; });
afterEach(() => {
  stopApps();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  window.matchMedia = realMatchMedia;
});

describe('the toolbar\'s left end and the recent list\'s pane (T1.21)', () => {
  test('the Recent files button is the toolbar\'s first, and the top row holds the tab strip only', async () => {
    await start();
    expect(tools().firstElementChild).toBe(button('recent'));
    expect(button('recent').querySelector('svg')!.getAttribute('data-icon')).toBe('recent');
    expect([...top()!.children].map((c) => c.className)).toEqual(['tabs']);
  });

  test('the window\'s rows: the top row, the toolbar across the whole width, then the pane beside the Syntax pane, the chart and the sidebar', async () => {
    await start();
    const rows = [...q('#app')!.children].filter((c) => !c.matches('.toast, dialog'));
    expect(rows).toEqual([top(), tools(), q('main')]);
    expect([...q('main')!.children]).toEqual([q('nav.recent'), q('.body')]);
  });
});

describe('the pane\'s foot (T1.21)', () => {
  test('Customize and Settings, each with its icon, under the list and apart from it', async () => {
    await start(undefined, null);
    const foot = q<HTMLElement>('nav.recent .pane-foot')!;
    expect(foot.parentElement).toBe(q('nav.recent'));
    expect(foot.previousElementSibling).toBe(q('nav.recent .rlist'));
    const buttons = [...foot.querySelectorAll('button')];
    expect(buttons.map((b) => [b.dataset.act, b.textContent!.trim(), b.querySelector('svg')!.getAttribute('data-icon')]))
      .toEqual([['customize', 'Customize', 'customize'], ['settings', 'Settings', 'settings']]);
    expect(q('nav.recent .rlist h2')!.textContent).toBe('Recent files');
  });

  test('only the list scrolls; the foot stays; its buttons have no outline', () => {
    expect(rule('.recent .rlist')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.recent')).not.toMatch(/overflow/);
    expect(rule('.recent .pane-foot')).toMatch(/flex:\s*none/);
    expect(rule('.recent .pane-foot button')).toMatch(/border:\s*0/);
  });

  test('a long list keeps its entries in the scrolling part', async () => {
    localStorage.setItem('recent', JSON.stringify(Array.from({ length: 40 }, (_, i) => `C:/proj/f${i}.mmd`)));
    await start(undefined, null);
    expect(document.querySelectorAll('nav.recent .rlist li')).toHaveLength(25);
    expect(q('nav.recent .pane-foot li')).toBeNull();
  });
});

describe('the caret button (T1.21)', () => {
  test('the toolbar\'s last button hides the top row and shows it again, turning upside down', async () => {
    await start();
    const caret = button('tabrow');
    expect(tools().lastElementChild).toBe(caret);
    expect(caret.querySelector('svg')!.getAttribute('data-icon')).toBe('caret');
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.title).toMatch(/^Hide the tabs/);
    caret.click();
    expect(top()!.hidden).toBe(true);
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(caret.title).toMatch(/^Show the tabs/);
    caret.click();
    expect(top()!.hidden).toBe(false);
    expect(caret.getAttribute('aria-expanded')).toBe('true');
  });

  test('upside down while the top row is hidden, turning at once when animations are off', () => {
    expect(rule('.bar button.caret[aria-expanded="false"] svg')).toMatch(/rotate\(180deg\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.bar button\.caret svg\s*\{\s*transition:\s*none/);
  });

  test('a top row left hidden stays hidden at the next start', async () => {
    await start();
    button('tabrow').click();
    await restart();
    expect(top()!.hidden).toBe(true);
    expect(button('tabrow').getAttribute('aria-expanded')).toBe('false');
  });
});

test('naiad serve\'s page, which shows one file, has no top row, so no caret button, and no pane, so no foot', async () => {
  await start('served');
  for (const sel of ['header.top', '[data-act="recent"]', '[data-act="tabrow"]', '.pane-foot', '[data-act="customize"]', '[data-act="settings"]']) {
    expect(q(sel), sel).toBeNull();
  }
});

describe('the Customize window (T4.8)', () => {
  test('opens over the window from the pane\'s foot, with Appearance on System until the person picks another', async () => {
    await start();
    const w = openWindow('customize');
    expect(isOpen(w)).toBe(true);
    expect(w.querySelector('h2')!.textContent).toBe('Customize');
    expect([...w.querySelectorAll<HTMLInputElement>('input[name="appearance"]')].map((r) => [r.value, r.parentElement!.textContent]))
      .toEqual([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]);
    expect(radio('system').checked).toBe(true);
    expect(theme()).toBeNull();
    expect(chartTheme.dark).toBe(false);
  });

  test('Dark: the window, the chart and the title bar turn dark at once, and stay so at the next start', async () => {
    await start();
    await vi.waitFor(() => expect(charts.list[0].drawn).toHaveLength(1));
    openWindow('customize');
    radio('dark').click();
    expect(theme()).toBe('dark');
    expect(chartTheme.dark).toBe(true);
    expect(disk.theme).toBe('dark');
    await vi.waitFor(() => expect(charts.list[0].drawn).toHaveLength(2)); // drawn again in dark
    await restart();
    expect(theme()).toBe('dark');
    expect(chartTheme.dark).toBe(true);
    expect(disk.theme).toBe('dark');
    expect(radio('dark') ?? null).toBeNull(); // the window is made only when opened
    openWindow('customize');
    expect(radio('dark').checked).toBe(true);
  });

  test('Light is light on a dark computer; System follows the computer again', async () => {
    systemDark(true);
    await start();
    expect(chartTheme.dark).toBe(true);
    openWindow('customize');
    radio('light').click();
    expect(theme()).toBe('light');
    expect(chartTheme.dark).toBe(false);
    expect(disk.theme).toBe('light');
    radio('system').click();
    expect(theme()).toBeNull();
    expect(chartTheme.dark).toBe(true);
    expect(disk.theme).toBeNull();
    expect(localStorage.getItem('appearance')).toBe('system');
  });
});

describe('the windows over Naiad\'s (T1.21, T4.8)', () => {
  test('Settings says there is nothing to set yet (Q149)', async () => {
    await start();
    const w = openWindow('settings');
    expect(isOpen(w)).toBe(true);
    expect(w.querySelector('h2')!.textContent).toBe('Settings');
    expect(w.querySelector('.ow-note')!.textContent).toBe('Nothing to set yet.');
  });

  test('a window closes with its ×, or a click outside it, and not with a click inside it', async () => {
    await start();
    let w = openWindow('settings');
    w.querySelector<HTMLButtonElement>('.ow-close')!.click();
    expect(isOpen(w)).toBe(false);
    w = openWindow('customize');
    w.querySelector<HTMLElement>('.ow-box')!.click();
    expect(isOpen(w)).toBe(true);
    w.click(); // the dimmed area around the box is the dialog itself
    expect(isOpen(w)).toBe(false);
  });

  test('while one is open, the window\'s keys do nothing to the chart behind it', async () => {
    await start();
    const highlight = () => button('highlight').getAttribute('aria-pressed');
    const w = openWindow('customize');
    key('h');
    expect(highlight()).toBe('false');
    w.querySelector<HTMLButtonElement>('.ow-close')!.click();
    key('h');
    expect(highlight()).toBe('true');
  });
});
