// @vitest-environment jsdom
// The window's frame after the design handoff (T4.9, the user, 2026-11-15), on the real
// App with the chart stood in for (app-harness.ts): the left rail in three sections (the
// mark, Recent files, Syntax and About; the Touchpad and Mouse switch and the mode
// button; Customize and Settings: the user's answer to Q158 and Q159, 2026-11-15); the
// tabs row alone above the chart; the Undo island and the floating pill on the shown
// tab's chart; the three panes and their grips, the recent list's pane and the Syntax
// pane never open together; no saved state shown, and failures as notices; the
// Customize window's Appearance, Theme and Syntax font; and `naiad serve`'s page.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { charts, chartTheme, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const top = () => q<HTMLElement>('header.top');
const rail = () => q<HTMLElement>('nav.rail')!;
const button = (act: string) => q<HTMLButtonElement>(`[data-act="${act}"]`)!;
/** A button's icon; a sliding toggle's (the user, 2026-11-17), the one its knob is on. */
const iconOf = (act: string) => (button(act).querySelector('.track svg.on') ?? button(act).querySelector('svg'))?.getAttribute('data-icon') ?? null;
const overlay = (name: string) => q<HTMLDialogElement>(`dialog.overlay-window[data-window="${name}"]`);
const isOpen = (d: HTMLDialogElement | null) => !!d?.hasAttribute('open');
const radio = (name: string, value: string) => q<HTMLInputElement>(`dialog[data-window="customize"] input[name="${name}"][value="${value}"]`)!;
const card = (palette: string) => q<HTMLButtonElement>(`dialog[data-window="customize"] button[data-palette="${palette}"]`)!;
const rootAttr = (name: string) => document.documentElement.getAttribute(name);
const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const shownArea = () => q<HTMLElement>('.tabview:not([hidden]) .chartarea')!;
const visible = (el: Element | null) => !!el && !el.closest('[hidden]');

/** The stylesheet's rules, as selector and declarations. */
const css = readFileSync(resolve('src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel.trim(), body }));
const rule = (sel: string) => rules.find((r) => r.sel.split(',').map((s) => s.trim()).includes(sel))?.body ?? null;

let disk: FakeDisk;
async function start(kind?: FakeDisk['kind'], path: string | null = A, text = 'flowchart TD\n    a[A] --> b[B]\n') {
  disk = new FakeDisk();
  if (kind) disk.kind = kind;
  disk.files.set(A, text);
  return startApp(disk, path);
}
/** Starts the window again, as after closing Naiad and opening it (what the app keeps stays). */
async function restart() {
  stopApps();
  return start();
}
function openWindow(act: 'customize' | 'settings') {
  button(act).click();
  return overlay(act)!;
}
/** A drag on a pane's grip, by `dx` pixels to the right. */
function drag(grip: HTMLElement, dx: number) {
  grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 500, button: 0 }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 + dx }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 500 + dx }));
}
const width = (name: string) => q<HTMLElement>('#app')!.style.getPropertyValue(`--${name}-w`);

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
beforeEach(() => { localStorage.clear(); chartTheme.dark = null; chartTheme.calls = 0; });
afterEach(() => {
  stopApps();
  localStorage.clear();
  for (const a of ['data-theme', 'data-palette', 'data-syntaxfont']) document.documentElement.removeAttribute(a);
  window.matchMedia = realMatchMedia;
});

describe('the window\'s frame (T4.9)', () => {
  test('the rail on the left, then the tabs row over the panes and the chart; no toolbar', async () => {
    await start();
    // The saved state stays in the page for screen readers, unseen (`.sr-only`).
    const parts = [...q('#app')!.children].filter((c) => !c.matches('.toast, dialog, .sr-only, .tab-ghost, .drop-zone, .drop-line'));
    expect(parts).toEqual([rail(), q('.column')]);
    expect([...q('.column')!.children]).toEqual([top(), q('main')]);
    expect([...q('main')!.children]).toEqual([q('nav.recent'), q('.body')]);
    expect([...top()!.children].map((c) => c.className)).toEqual(['tabs']);
    for (const gone of ['.bar.tools', '[data-act="tabrow"]', '.pane-foot']) expect(q(gone), gone).toBeNull();
    expect(q('.status')!.matches('.sr-only')).toBe(true);
  });

  test('the rail in three sections: the mark, Recent files, Syntax and About; Touchpad or Mouse and the mode; Customize and Settings', async () => {
    await start();
    expect([...rail().children].map((c) => c.className)).toEqual(['rail-top', 'rail-mid', 'rail-foot']);
    const mark = q('.rail-top')!.firstElementChild!;
    expect(mark.matches('.mark')).toBe(true);
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    const section = (sel: string) => [...q(sel)!.querySelectorAll('button')]
      .map((b) => [b.dataset.act, b.querySelector('.rlabel')!.textContent, (b.querySelector('.track svg.on') ?? b.querySelector('svg'))!.getAttribute('data-icon')]);
    expect(section('.rail-top')).toEqual([['recent', 'Recent files', 'recent'], ['syntax', 'Syntax', 'syntax'], ['about', 'About', 'about']]);
    expect(section('.rail-mid')).toEqual([['wheel', 'Mouse mode', 'mouse'], ['view', 'Edit mode', 'edit']]);
    expect(section('.rail-foot')).toEqual([['customize', 'Customize', 'customize'], ['settings', 'Settings', 'settings']]);
    for (const b of rail().querySelectorAll('button')) expect(b.getAttribute('aria-label'), b.dataset.act).toBeNull(); // its name says it
    // Neither the switch nor the mode button is left in the pill.
    for (const act of ['wheel', 'view']) expect(q(`.pill [data-act="${act}"]`), act).toBeNull();
  });

  test('the rail\'s middle sits at its middle: the top and the foot take equal shares of the height', () => {
    expect(rule('.rail')).toMatch(/display:\s*grid/);
    expect(rule('.rail')).toMatch(/grid-template-rows:\s*1fr auto 1fr/);
    expect(rules.find((r) => r.sel === '.rail-foot')?.body).toMatch(/justify-content:\s*flex-end/);
  });

  test('a rail button\'s name shows under the pointer only, over the content; the rail itself stays 48 px', () => {
    expect(rule('.rail')).toMatch(/width:\s*48px/);
    expect(rule('.rail button')).toMatch(/max-width:\s*34px/);
    expect(rule('.rail button:hover')).toMatch(/max-width:\s*180px/);
    expect(rule('.rail button')).toMatch(/overflow:\s*hidden/);
  });

  test('Recent files, Syntax and About are switches, pressed while their pane shows', async () => {
    await start();
    expect(button('syntax').getAttribute('aria-pressed')).toBe('false');
    button('syntax').click();
    expect(button('syntax').getAttribute('aria-pressed')).toBe('true');
    expect(q<HTMLElement>('.textpane')!.hidden).toBe(false);
    expect(button('recent').getAttribute('aria-pressed')).toBe('false');
    button('recent').click();
    expect(button('recent').getAttribute('aria-pressed')).toBe('true');
    expect(button('syntax').getAttribute('aria-pressed')).toBe('false'); // one pane or the other
    expect(button('about').getAttribute('aria-pressed')).toBe('true');
  });

  test('the Touchpad and Mouse switch and the mode button show the mode they are in, by icon and name, never pressed', async () => {
    await start();
    expect(button('view').getAttribute('aria-pressed')).toBeNull();
    button('view').click();
    await vi.waitFor(() => expect(button('view').textContent!.trim()).toBe('View mode'));
    expect(button('view').getAttribute('aria-pressed')).toBeNull();
    expect(button('wheel').getAttribute('aria-pressed')).toBeNull();
    button('wheel').click();
    expect(button('wheel').textContent!.trim()).toBe('Touchpad mode');
    expect(iconOf('wheel')).toBe('touchpad');
  });

  test('the Syntax pane has its head, "Mermaid syntax"', async () => {
    await start();
    expect(q('.textpane > .pane-head')!.textContent).toBe('Mermaid syntax');
  });
});

describe('the three panes and their grips (T4.9)', () => {
  test('each pane has a grip on the edge facing the chart', async () => {
    await start();
    for (const sel of ['nav.recent > .grip', '.textpane > .grip', '.tabview .chartarea > .grip.side']) {
      const grip = q<HTMLElement>(sel);
      expect(grip, sel).not.toBeNull();
      expect(grip!.getAttribute('role'), sel).toBe('separator');
      expect(grip!.getAttribute('aria-orientation'), sel).toBe('vertical');
    }
    expect(rule('.grip')).toMatch(/cursor:\s*col-resize/);
    expect(rule('.grip')).toMatch(/width:\s*11px/);
  });

  test('the widths start at 232, 330 and 340 px and stay within their limits', async () => {
    await start();
    expect([width('recent'), width('syntax'), width('side')]).toEqual(['232px', '330px', '340px']);
    drag(q<HTMLElement>('nav.recent > .grip')!, 60);
    expect(width('recent')).toBe('292px');
    drag(q<HTMLElement>('nav.recent > .grip')!, 900);
    expect(width('recent')).toBe('420px');
    drag(q<HTMLElement>('.textpane > .grip')!, -500);
    expect(width('syntax')).toBe('220px');
    // The sidebar's grip is on its left edge: a drag to the left widens it.
    drag(shownArea().querySelector<HTMLElement>('.grip.side')!, -100);
    expect(width('side')).toBe('440px');
    drag(shownArea().querySelector<HTMLElement>('.grip.side')!, 500);
    expect(width('side')).toBe('280px');
  });

  test('each width is kept for the next start', async () => {
    await start();
    drag(q<HTMLElement>('.textpane > .grip')!, 70);
    drag(shownArea().querySelector<HTMLElement>('.grip.side')!, -40);
    await restart();
    expect([width('recent'), width('syntax'), width('side')]).toEqual(['232px', '400px', '380px']);
  });

  test('a width kept by an older Naiad, or out of its limits, is not used as it is', async () => {
    localStorage.setItem('textpane-width', '500');
    localStorage.setItem('recent-width', '9000');
    localStorage.setItem('sidebar-width', 'wide');
    await start();
    expect([width('recent'), width('syntax'), width('side')]).toEqual(['420px', '500px', '340px']);
  });
});

describe('the recent list\'s pane or the Syntax pane, never both (the user, 2026-11-15, Q158\'s answer; the Syntax pane switches off, the user\'s correction)', () => {
  const syntaxPane = () => q<HTMLElement>('.textpane')!;
  const recentPane = () => q<HTMLElement>('nav.recent')!;
  const pressed = (act: string) => button(act).getAttribute('aria-pressed') === 'true';

  test('opening the recent list\'s pane switches the Syntax pane off; it stays off when the list closes', async () => {
    await start();
    button('syntax').click();
    button('recent').click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([false, true]);
    expect([pressed('recent'), pressed('syntax')]).toEqual([true, false]);
    button('recent').click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([true, true]);
    expect([pressed('recent'), pressed('syntax')]).toEqual([false, false]);
  });

  test('Syntax, clicked while the recent list\'s pane is open, closes that pane and shows the Syntax pane', async () => {
    await start();
    button('recent').click();
    button('syntax').click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([true, false]);
    expect([pressed('recent'), pressed('syntax')]).toEqual([false, true]);
    button('syntax').click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([true, true]);
  });

  test('with the Syntax pane closed, the recent list\'s pane opens and closes alone', async () => {
    await start();
    button('recent').click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([false, true]);
    button('recent').click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([true, true]);
  });

  test('a blank tab opens the recent list\'s pane, which switches the Syntax pane off; it stays off on a flowchart\'s tab', async () => {
    const ui = await start();
    button('syntax').click();
    q<HTMLButtonElement>('[data-act="newtab"]')!.click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([false, true]);
    ui.showTab('a.mmd');
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([true, true]);
    expect(pressed('syntax')).toBe(false);
  });

  test('the Syntax pane, switched off by the recent list\'s pane, is closed at the next start', async () => {
    await start();
    button('syntax').click();
    button('recent').click();
    await restart();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([true, true]);
  });

  test('the Syntax pane, open at the start, is switched off by the blank tab\'s recent list\'s pane', async () => {
    await start();
    button('syntax').click();
    await restart();
    expect(syntaxPane().hidden).toBe(false);
    q<HTMLButtonElement>('[data-act="newtab"]')!.click();
    expect([recentPane().hidden, syntaxPane().hidden]).toEqual([false, true]);
  });
});

describe('the Undo island and the floating pill (T4.9)', () => {
  test('Undo and Redo in an island at the shown chart\'s top left', async () => {
    await start();
    const island = shownArea().querySelector<HTMLElement>('.island')!;
    expect([...island.querySelectorAll('button')].map((b) => b.dataset.act)).toEqual(['undo', 'redo']);
    expect(visible(island)).toBe(true);
    expect(button('clear').parentElement).toBe(island.parentElement); // Clear sits beside the island
  });

  test('the pill: the add-node button, the direction, Fit and Highlight', async () => {
    await start();
    const pill = shownArea().querySelector<HTMLElement>('.pill')!;
    const items = [...pill.querySelectorAll<HTMLElement>(':scope > *, .pill-edit > *')].filter((e) => !e.matches('.pill-edit, .dir-menu'));
    expect(items.map((e) => (e.matches('.divider') ? '|' : (e.dataset.act ?? e.querySelector<HTMLElement>('[data-act]')?.dataset.act)))).toEqual(['add', '|', 'dir', '|', 'fit', 'highlight']);
    // The add-node button is a plus alone (the user, 2026-11-15, Q158's answer).
    expect(button('add').textContent!.trim()).toBe('');
    expect(button('add').getAttribute('aria-label')).toBe('Add a node');
    expect(button('add').title).toBe('Add a node (or double-click empty space)');
    expect(iconOf('add')).toBe('plus');
    expect(rule('.add')).toMatch(/border-radius:\s*50%/);
    expect(iconOf('fit')).toBe('fit');
    expect(button('fit').getAttribute('aria-label')).toBe('Fit');
  });

  test('the island and the pill move with the shown tab, and neither shows on a blank tab', async () => {
    const ui = await start();
    q<HTMLButtonElement>('[data-act="newtab"]')!.click();
    expect(ui.shown()).toBe('New tab');
    expect(visible(q('.pill'))).toBe(false);
    expect(visible(q('.island'))).toBe(false);
    ui.showTab('a.mmd');
    expect(shownArea().querySelector('.pill')).not.toBeNull();
    expect(visible(q('.pill'))).toBe(true);
  });

  test('the direction button shows the chart\'s direction; its menu holds the other three', async () => {
    const ui = await start();
    const dir = button('dir');
    expect(dir.title).toBe('Direction of the chart: Top to bottom');
    expect(iconOf('dir')).toBe('down');
    expect(dir.getAttribute('aria-haspopup')).toBe('menu');
    const menu = q<HTMLElement>('.dir-menu')!;
    expect(menu.hidden).toBe(true);
    dir.click();
    expect(menu.hidden).toBe(false);
    expect(dir.getAttribute('aria-expanded')).toBe('true');
    const shown = () => [...menu.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.hidden).map((b) => b.title);
    expect(shown()).toEqual(['Left to right', 'Bottom to top', 'Right to left']);
    q<HTMLButtonElement>('.dir-menu [data-dir="LR"]')!.click();
    await vi.waitFor(() => expect(disk.files.get(A)).toBe('flowchart LR\n    a[A] --> b[B]\n'));
    expect(menu.hidden).toBe(true);
    await vi.waitFor(() => expect(iconOf('dir')).toBe('right'));
    expect(button('dir').title).toBe('Direction of the chart: Left to right');
    expect(shown()).toEqual(['Top to bottom', 'Bottom to top', 'Right to left']);
    expect(ui.undoEnabled()).toBe(true);
  });

  test('pointing at the direction button shows its menu; leaving it hides it', async () => {
    await start();
    const wrap = button('dir').parentElement!;
    wrap.dispatchEvent(new MouseEvent('mouseenter'));
    expect(q<HTMLElement>('.dir-menu')!.hidden).toBe(false);
    wrap.dispatchEvent(new MouseEvent('mouseleave'));
    await sleep(400);
    expect(q<HTMLElement>('.dir-menu')!.hidden).toBe(true);
  });

  test('the mode button shows the mode Naiad is in: the pencil in Edit mode, the book in View mode', async () => {
    await start();
    const view = button('view');
    expect(iconOf('view')).toBe('edit');
    expect(view.textContent!.trim()).toBe('Edit mode');
    expect(view.title).toBe('Edit mode. Click for View mode, to read the chart without changing it');
    view.click();
    await vi.waitFor(() => expect(view.textContent!.trim()).toBe('View mode'));
    expect(iconOf('view')).toBe('read');
    expect(view.title).toBe('View mode: the chart cannot be changed. Click for Edit mode');
  });

  test('View mode: the pill keeps Fit and Highlight; the island goes; the rail\'s middle stays', async () => {
    localStorage.setItem('mode', 'view');
    await start();
    const pill = shownArea().querySelector<HTMLElement>('.pill')!;
    const left = [...pill.querySelectorAll<HTMLElement>('button[data-act]')].filter(visible).map((b) => b.dataset.act);
    expect(left).toEqual(['fit', 'highlight']);
    expect(visible(shownArea().querySelector('.island'))).toBe(false);
    expect([visible(button('wheel')), visible(button('view'))]).toEqual([true, true]);
  });

  test('Clear shows the count of highlights, beside the island', async () => {
    await start();
    disk.highlights.set(A, 'a\nb\n');
    await vi.waitFor(() => expect(button('clear').hidden).toBe(false), { timeout: 3000 });
    expect(button('clear').textContent!.trim()).toBe('Clear 2');
    expect(iconOf('clear')).toBe('eraser');
  });
});

describe('the saved state and the notices (T4.9)', () => {
  test('a save that fails shows a red notice until a save succeeds', async () => {
    const ui = await start();
    disk.failWrites = 'disk full';
    ui.direction('LR');
    await vi.waitFor(() => expect(q('.notice.bad .notice-text')?.textContent).toBe('Could not save: disk full'), { timeout: 3000 });
    disk.failWrites = null;
    ui.ctrlS();
    await vi.waitFor(() => expect(q('.notice.bad')).toBeNull(), { timeout: 3000 });
    expect(disk.files.get(A)).toBe('flowchart LR\n    a[A] --> b[B]\n');
  });

  test('a file that cannot be read shows a red notice, gone when it can be read again', async () => {
    await start();
    const text = disk.files.get(A)!;
    disk.files.delete(A);
    disk.outside(A, text); // tells the watchers; the read below fails
    disk.files.delete(A);
    await vi.waitFor(() => expect(q('.notice.bad .notice-text')?.textContent).toBe('The file cannot be read (moved or deleted?)'), { timeout: 3000 });
    disk.outside(A, text);
    await vi.waitFor(() => expect(q('.notice.bad')).toBeNull(), { timeout: 3000 });
  });

  test('a syntax error\'s notice says the file is not saved, and how to save it anyway', async () => {
    const ui = await start();
    ui.type('flowchart TD\n    a[A] -->\n');
    await vi.waitFor(() => expect(q('.notice.bad .notice-text')?.textContent)
      .toBe('Mermaid cannot read this text, so the chart shows the last good version. Not saved: Ctrl+S saves anyway.'), { timeout: 3000 });
  });

  test('the notices sit at the top of the shown chart', async () => {
    await start();
    expect(q('.tabview:not([hidden]) .chartarea > .notices')).not.toBeNull();
  });
});

describe('the blank tab (T4.9)', () => {
  test('the mark, "No file open", Open a file and New flowchart, each with its icon', async () => {
    disk = new FakeDisk();
    disk.kind = 'desktop';
    await startApp(disk, null);
    const empty = q<HTMLElement>('.tabview:not([hidden]) .empty')!;
    expect(empty.querySelector('.mark')!.getAttribute('role')).toBe('img');
    expect(empty.querySelector('.mark')!.getAttribute('aria-label')).toBe('Naiad');
    expect(empty.querySelector('h1')!.textContent).toBe('No file open');
    expect([...empty.querySelectorAll('button')].map((b) => [b.dataset.act, b.textContent!.trim(), b.querySelector('svg')!.getAttribute('data-icon')]))
      .toEqual([['open', 'Open a file', 'open'], ['new', 'New flowchart', 'new']]);
  });
});

test('naiad serve\'s page, which shows one file: the rail without Recent files and Settings, and no tabs row', async () => {
  await start('served');
  expect(visible(rail())).toBe(true);
  expect([...rail().querySelectorAll('button')].map((b) => b.dataset.act)).toEqual(['syntax', 'about', 'wheel', 'view', 'customize']);
  for (const sel of ['header.top', 'nav.recent']) expect(q(sel), sel).toBeNull();
});

describe('the Customize window (T4.8, T4.9)', () => {
  test('opens from the rail, over a dimmed window, with Appearance on System until the person picks another', async () => {
    await start();
    const w = openWindow('customize');
    expect(isOpen(w)).toBe(true);
    expect(w.querySelector('h2')!.textContent).toBe('Customize');
    expect([...w.querySelectorAll<HTMLInputElement>('input[name="appearance"]')].map((r) => [r.value, r.parentElement!.textContent]))
      .toEqual([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]);
    expect(radio('appearance', 'system').checked).toBe(true);
    expect(rootAttr('data-theme')).toBeNull();
    expect(chartTheme.dark).toBe(false);
    expect(rule('dialog.overlay-window::backdrop')).toMatch(/var\(--scrim\)/);
  });

  test('Dark: the window, the chart and the title bar turn dark at once, and stay so at the next start', async () => {
    await start();
    await vi.waitFor(() => expect(charts.list[0].drawn).toHaveLength(1));
    openWindow('customize');
    radio('appearance', 'dark').click();
    expect(rootAttr('data-theme')).toBe('dark');
    expect(chartTheme.dark).toBe(true);
    expect(disk.theme).toBe('dark');
    await vi.waitFor(() => expect(charts.list[0].drawn).toHaveLength(2)); // drawn again in dark
    await restart();
    expect(rootAttr('data-theme')).toBe('dark');
    expect(chartTheme.dark).toBe(true);
    expect(disk.theme).toBe('dark');
    expect(q('dialog[data-window="customize"]')).toBeNull(); // the window is made only when opened
    openWindow('customize');
    expect(radio('appearance', 'dark').checked).toBe(true);
  });

  test('Light is light on a dark computer; System follows the computer again', async () => {
    systemDark(true);
    await start();
    expect(chartTheme.dark).toBe(true);
    openWindow('customize');
    radio('appearance', 'light').click();
    expect(rootAttr('data-theme')).toBe('light');
    expect(chartTheme.dark).toBe(false);
    expect(disk.theme).toBe('light');
    radio('appearance', 'system').click();
    expect(rootAttr('data-theme')).toBeNull();
    expect(chartTheme.dark).toBe(true);
    expect(disk.theme).toBeNull();
    expect(localStorage.getItem('appearance')).toBe('system');
  });

  test('Theme: six cards, Naiad Default chosen until the person picks another', async () => {
    await start();
    const w = openWindow('customize');
    const cards = [...w.querySelectorAll<HTMLButtonElement>('button[data-palette]')];
    expect(cards.map((c) => [c.dataset.palette, c.textContent!.trim()])).toEqual([
      ['naiad-default', 'Naiad Default'], ['moonpool', 'Moonpool'], ['kelp', 'Kelp'],
      ['water-lily', 'Water Lily'], ['glacier', 'Glacier'], ['coral', 'Coral'],
    ]);
    expect(cards.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
    expect(rootAttr('data-palette')).toBeNull();
  });

  test('a theme picked: the window and the chart take its colours at once, and keep them at the next start', async () => {
    await start();
    await vi.waitFor(() => expect(charts.list[0].drawn).toHaveLength(1));
    const before = chartTheme.calls;
    openWindow('customize');
    card('kelp').click();
    expect(rootAttr('data-palette')).toBe('kelp');
    expect(card('kelp').getAttribute('aria-pressed')).toBe('true');
    expect(card('naiad-default').getAttribute('aria-pressed')).toBe('false');
    expect(chartTheme.calls).toBe(before + 1); // Mermaid set up again, with the palette's colours
    await vi.waitFor(() => expect(charts.list[0].drawn).toHaveLength(2));
    expect(localStorage.getItem('palette')).toBe('kelp');
    await restart();
    expect(rootAttr('data-palette')).toBe('kelp');
    openWindow('customize');
    card('naiad-default').click();
    expect(rootAttr('data-palette')).toBeNull();
    expect(localStorage.getItem('palette')).toBe('naiad-default');
  });

  test('a palette kept that Naiad does not know is Naiad Default', async () => {
    localStorage.setItem('palette', 'neon');
    await start();
    expect(rootAttr('data-palette')).toBeNull();
  });

  test('Syntax font: JetBrains Mono until the person picks DM Mono or Recursive Casual; kept between runs', async () => {
    await start();
    const w = openWindow('customize');
    expect([...w.querySelectorAll<HTMLInputElement>('input[name="syntaxfont"]')].map((r) => [r.value, r.closest('label')!.querySelector('.font-name')!.textContent]))
      .toEqual([['jetbrains-mono', 'JetBrains Mono'], ['dm-mono', 'DM Mono'], ['recursive', 'Recursive Casual']]);
    expect(radio('syntaxfont', 'jetbrains-mono').checked).toBe(true);
    expect(rootAttr('data-syntaxfont')).toBeNull();
    radio('syntaxfont', 'recursive').click();
    expect(rootAttr('data-syntaxfont')).toBe('recursive');
    await restart();
    expect(rootAttr('data-syntaxfont')).toBe('recursive');
    openWindow('customize');
    radio('syntaxfont', 'jetbrains-mono').click();
    expect(rootAttr('data-syntaxfont')).toBeNull();
  });
});

describe('the windows over Naiad\'s (T1.21, T4.8)', () => {
  test('Settings opens with its title and its first setting, Remember opened files (T1.23; its own tests: remember-files.test.ts)', async () => {
    await start();
    const w = openWindow('settings');
    expect(isOpen(w)).toBe(true);
    expect(w.querySelector('h2')!.textContent).toBe('Settings');
    expect(w.querySelector('input.switch')!.closest('.ow-row')!.textContent).toContain('Remember opened files');
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

describe('the look (T4.9)', () => {
  test('the six palettes, each light and dark, and the names the window uses', () => {
    for (const p of ['naiad-default', 'moonpool', 'kelp', 'water-lily', 'glacier', 'coral']) {
      const body = rule(`:root[data-palette="${p}"]`);
      expect(body, p).not.toBeNull();
      for (const name of ['--bg', '--panel', '--accent', '--highlight', '--node', '--node-border', '--edge', '--group', '--group-border']) {
        expect(body, `${p} ${name}`).toMatch(new RegExp(`${name}:\\s*light-dark\\(`));
      }
    }
    // The aliases the window's rules use, kept with the palettes' first rule.
    const root = rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes(':root')).map((r) => r.body).join('');
    expect(root).toMatch(/--hl:\s*var\(--highlight\)/);
  });

  test('the fonts are bundled, each with its licence, and Nunito is gone', () => {
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, b]) => [/font-family:\s*'([^']+)'/.exec(b)![1], /url\('\.\/([^']+)'\)/.exec(b)![1]]);
    expect(faces.map(([f]) => f)).toEqual(['Lexend', 'Newsreader', 'JetBrains Mono', 'DM Mono', 'Recursive']);
    for (const [, file] of faces) expect(existsSync(resolve('src', file)), file).toBe(true);
    const licence = readFileSync(resolve('src', 'fonts', 'OFL.txt'), 'utf8');
    for (const name of ['Lexend', 'Newsreader', 'JetBrains Mono', 'DM Mono', 'Recursive']) expect(licence).toContain(`The ${name} Project Authors`);
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(existsSync(resolve('src', 'fonts', 'nunito-latin.woff2'))).toBe(false);
    expect(css).not.toMatch(/Nunito/);
  });

  test('the Syntax font\'s choices, and no ligatures in the Syntax pane', () => {
    expect(rule(':root[data-syntaxfont="dm-mono"]')).toMatch(/--font-mono:\s*'DM Mono'/);
    expect(rule(':root[data-syntaxfont="recursive"]')).toMatch(/--mono-fvs:\s*'MONO' 1, 'CASL' 1/);
    expect(rule('.textpane textarea')).toMatch(/font-variant-ligatures:\s*none/);
    expect(rule('.textpane textarea')).toMatch(/font-variation-settings:\s*var\(--mono-fvs/);
  });

  test('the mark is drawn through a mask, in the accent; the page has it as its icon', () => {
    expect(rule('.mark')).toMatch(/mask:\s*url\('\.\/brand\/naiad-mark\.svg'\)/);
    expect(rule('.mark')).toMatch(/background:\s*var\(--accent\)/);
    const page = readFileSync(resolve('index.html'), 'utf8');
    expect(page).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/src\/brand\/naiad-mark\.svg" \/>/);
    const mark = readFileSync(resolve('src', 'brand', 'naiad-mark.svg'), 'utf8');
    expect(mark).not.toMatch(/<script|on\w+=|href=|<metadata/i);
  });
});
