// @vitest-environment jsdom
// Split view (T1.17; the user, 2026-11-18: Q180 to Q182, Q184 "both options", Q185 "two
// groups"): a tab dragged to an edge of the chart splits it in two halves, each with its
// own tab group and strip. The half last clicked is the active half; the island, the
// pill, the sidebar, Undo and the window's title follow it. A divider between the halves
// resizes them. A group's × closes the split, moving its tabs to the other group, and so
// does a group left with no tab. Remember opened files keeps the split.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';
const path = (n: string) => `C:/proj/${n}.mmd`;
const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const all = <T extends Element>(s: string) => [...document.querySelectorAll<T>(s)];
const body = () => q<HTMLElement>('.body');
const bars = () => all<HTMLElement>('.tabs');
const names = (bar: HTMLElement) => [...bar.querySelectorAll('.tab .tname')].map((n) => n.textContent);
const tabOf = (name: string) => all<HTMLElement>('.tabs .tab').find((t) => t.querySelector('.tname')!.textContent === name)!;
const viewOf = (name: string) => all<HTMLElement>('.tabview').find((v) => v.dataset.file === name)!;
const half = (which: 'a' | 'b') => q<HTMLElement>(`.tabview.half-${which}:not([hidden])`);
const active = () => q<HTMLElement>('.tabview.active');
const zone = () => document.querySelector<HTMLElement>('.drop-zone:not([hidden])');
const css = () => readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const at = css().split('}').find((r) => r.split('{')[0].split(',').map((s) => s.trim()).includes(selector));
  return at?.split('{')[1] ?? '';
};

async function start(files: string[], disk = new FakeDisk()) {
  disk.kind = 'desktop';
  for (const n of files) if (!disk.files.has(path(n))) disk.files.set(path(n), TEXT);
  const ui = await startApp(disk, files.length ? path(files[0]) : null);
  for (const n of files.slice(1)) await ui.app.open(path(n));
  lay();
  return { ui, disk };
}

const W = 1000;
const TOP = 44;
const H = 744;
function box(el: Element, left: number, top: number, right: number, bottom: number) {
  el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect;
}
/** Lays the window out as a browser would, 1,000 by 744 px: the strips, their tabs (100 px each) and the shown charts. */
function lay() {
  const split = body().classList.contains('split');
  const col = body().classList.contains('split-col');
  const [a, b] = bars();
  const areas = all<HTMLElement>('.tabview > .chartarea');
  if (!split) {
    box(a, 0, 0, W, TOP);
    for (const c of areas) box(c, 0, TOP, W, H);
  } else if (!col) {
    box(a, 0, 0, 500, TOP);
    box(b, 500, 0, W, TOP);
    box(half('a').querySelector('.chartarea')!, 0, TOP, 500, H);
    box(half('b').querySelector('.chartarea')!, 501, TOP, W, H);
  } else {
    box(a, 0, 0, W, TOP);
    box(half('a').querySelector('.chartarea')!, 0, TOP, W, 394);
    box(b, 0, 394, W, 434);
    box(half('b').querySelector('.chartarea')!, 0, 434, W, H);
  }
  for (const bar of bars()) {
    const r = bar.getBoundingClientRect();
    [...bar.querySelectorAll('.tab')].forEach((t, i) => box(t, r.left + i * 100, r.top, r.left + (i + 1) * 100, r.bottom));
  }
}

const pointer = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
/** Presses on a tab's name, moves the pointer to (x, y), and, unless `hold`, lets go there. */
function dragTab(name: string, x: number, y: number, hold = false) {
  const r = tabOf(name).getBoundingClientRect();
  const x0 = r.left + 20;
  const y0 = r.top + 10;
  tabOf(name).querySelector('.tname')!.dispatchEvent(pointer('pointerdown', x0, y0));
  window.dispatchEvent(pointer('pointermove', x0 + 10, y0 + 10));
  window.dispatchEvent(pointer('pointermove', x, y));
  if (!hold) {
    window.dispatchEvent(pointer('pointerup', x, y));
    lay();
  }
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('dragging a tab over the chart (Q180)', () => {
  test('a press and a move of 6 px or less is still a click, not a drag', async () => {
    const { ui } = await start(['a', 'b']);
    const name = tabOf('a.mmd').querySelector<HTMLButtonElement>('.tname')!;
    name.dispatchEvent(pointer('pointerdown', 20, 10));
    window.dispatchEvent(pointer('pointermove', 24, 12));
    expect(document.querySelector('.tab-ghost:not([hidden])')).toBeNull();
    window.dispatchEvent(pointer('pointerup', 24, 12));
    name.click();
    expect(ui.shown()).toBe('a.mmd');
  });

  test('the half nearest the pointer lights and names the tab; the copy of the tab follows the pointer', async () => {
    await start(['a', 'b', 'c']);
    dragTab('a.mmd', 900, 300, true);
    expect(q('.tab-ghost').textContent).toBe('a.mmd');
    expect(zone()!.textContent).toBe('a.mmd opens here');
    expect([zone()!.style.left, zone()!.style.top, zone()!.style.width]).toEqual(['500px', '44px', '500px']);
    window.dispatchEvent(pointer('pointermove', 500, 700));
    expect([zone()!.style.left, zone()!.style.top, zone()!.style.height]).toEqual(['0px', '394px', '350px']);
    window.dispatchEvent(pointer('pointermove', 30, 300));
    expect([zone()!.style.left, zone()!.style.width]).toEqual(['0px', '500px']);
  });

  test('letting go splits: the tab alone in a new group on that side, the rest in the other, the new half active', async () => {
    const { ui, disk } = await start(['a', 'b', 'c']);
    dragTab('a.mmd', 900, 300);
    expect(zone()).toBeNull();
    expect(document.querySelector('.tab-ghost:not([hidden])')).toBeNull();
    expect(body().classList.contains('split')).toBe(true);
    expect(body().classList.contains('split-row')).toBe(true);
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd'], ['a.mmd']]);
    expect(bars().every((b) => b.closest('header.top'))).toBe(true);
    expect(half('a').dataset.file).toBe('c.mmd');
    expect(half('b').dataset.file).toBe('a.mmd');
    expect(all('.tabview:not([hidden])')).toHaveLength(2);
    expect(active().dataset.file).toBe('a.mmd');
    expect(active().querySelector('.chartarea > .island-row')).not.toBeNull();
    expect(active().querySelector('.chartarea > .pill')).not.toBeNull();
    expect(disk.title).toBe('a.mmd - Naiad');
    expect(ui.area().value).toBe(TEXT);
  });

  test('dropped on the left edge, the new group is the first', async () => {
    await start(['a', 'b', 'c']);
    dragTab('c.mmd', 30, 300);
    expect(bars().map(names)).toEqual([['c.mmd'], ['a.mmd', 'b.mmd']]);
    expect(half('a').dataset.file).toBe('c.mmd');
    expect(half('b').dataset.file).toBe('b.mmd');
  });

  test('dropped on the bottom edge, one above the other: the second strip sits above the lower half', async () => {
    await start(['a', 'b', 'c']);
    dragTab('a.mmd', 500, 700);
    expect(body().classList.contains('split-col')).toBe(true);
    expect(bars()[0].closest('header.top')).not.toBeNull();
    expect(bars()[1].parentElement).toBe(body());
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd'], ['a.mmd']]);
  });

  test('a group\'s only tab lights nothing over the chart, and letting go changes nothing', async () => {
    await start(['a']);
    dragTab('a.mmd', 900, 300, true);
    expect(zone()).toBeNull();
    window.dispatchEvent(pointer('pointerup', 900, 300));
    expect(body().classList.contains('split')).toBe(false);
    expect(bars()).toHaveLength(1);
  });

  test('Escape cancels a drag', async () => {
    await start(['a', 'b']);
    dragTab('a.mmd', 900, 300, true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(zone()).toBeNull();
    expect(document.querySelector('.tab-ghost:not([hidden])')).toBeNull();
    window.dispatchEvent(pointer('pointerup', 900, 300));
    expect(body().classList.contains('split')).toBe(false);
  });

  test('a drag ends without a click: the tab pressed is not shown by it', async () => {
    const { ui } = await start(['a', 'b', 'c']);
    dragTab('a.mmd', 250, 20); // within the strip, between b.mmd and c.mmd
    tabOf('a.mmd').querySelector<HTMLButtonElement>('.tname')!.click();
    expect(ui.shown()).toBe('c.mmd');
  });
});

describe('dragging a tab over a strip (Q180)', () => {
  test('a line shows where the tab would go; letting go moves it there', async () => {
    await start(['a', 'b', 'c']);
    dragTab('a.mmd', 260, 20, true);
    const line = q<HTMLElement>('.drop-line:not([hidden])');
    expect(line.style.left).toBe('300px');
    window.dispatchEvent(pointer('pointerup', 260, 20));
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd', 'a.mmd']]);
  });

  test('over its own place, a tab shows no line, and letting go leaves it there', async () => {
    await start(['a', 'b', 'c']);
    for (const x of [60, 130]) {
      dragTab('b.mmd', 100 + x, 20, true); // b sits from 100 to 200 px
      expect(document.querySelector('.drop-line:not([hidden])')).toBeNull();
      window.dispatchEvent(pointer('pointerup', 100 + x, 20));
      lay();
      expect(bars().map(names)).toEqual([['a.mmd', 'b.mmd', 'c.mmd']]);
      await sleep(1);
    }
  });

  test('while a tab is dragged, nothing in the window answers the pointer: no hover, no handles, no trace', () => {
    expect(rule('body.dragging-tab #app')).toContain('pointer-events: none');
  });
});

describe('two tab groups (Q185)', () => {
  async function split() {
    const s = await start(['a', 'b', 'c']);
    dragTab('a.mmd', 900, 300); // [b, c] | [a], a active
    await sleep(1); // the click that ends a drag is past
    return s;
  }

  test('a click on a tab shows it in its own half and makes that half active', async () => {
    await split();
    tabOf('b.mmd').querySelector<HTMLButtonElement>('.tname')!.click();
    lay();
    expect(half('a').dataset.file).toBe('b.mmd');
    expect(half('b').dataset.file).toBe('a.mmd');
    expect(active().dataset.file).toBe('b.mmd');
    expect(viewOf('c.mmd').hidden).toBe(true);
  });

  test('a press in the other half makes it active: the island, the pill and the window\'s title follow', async () => {
    const { disk } = await split();
    half('a').querySelector('.stage')!.dispatchEvent(pointer('pointerdown', 100, 300));
    expect(active().dataset.file).toBe('c.mmd');
    expect(half('a').querySelector('.chartarea > .island-row')).not.toBeNull();
    expect(disk.title).toBe('c.mmd - Naiad');
    expect(half('b').classList.contains('active')).toBe(false);
  });

  test('only the active half\'s sidebar shows; the active half has an accent line along its top', () => {
    expect(rule('.body.split > .tabview:not(.active) > .sidebar')).toMatch(/display:\s*none/);
    expect(rule('.body.split > .tabview.active > .chartarea::before')).toMatch(/height:\s*2px/);
  });

  test('Undo acts on the active half', async () => {
    const { ui, disk } = await split();
    ui.direction('LR'); // in a.mmd, the active half
    await ui.until((t) => t.includes('flowchart LR'));
    await sleep(700);
    expect(disk.files.get(path('a'))).toContain('flowchart LR');
    half('a').querySelector('.stage')!.dispatchEvent(pointer('pointerdown', 100, 300));
    expect(ui.undoEnabled()).toBe(false); // c.mmd has nothing to undo
    half('b').querySelector('.stage')!.dispatchEvent(pointer('pointerdown', 700, 300));
    ui.undo();
    expect(await ui.until((t) => t.includes('flowchart TD'))).toBe(true);
  });

  test('a group\'s + opens a blank tab in that group', async () => {
    await split();
    bars()[0].querySelector<HTMLButtonElement>('[data-act="newtab"]')!.click();
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd', 'New tab'], ['a.mmd']]);
    expect(active().dataset.file).toBe('');
  });

  test('Open puts a file in the active group; a file open in the other group shows there', async () => {
    const { ui, disk } = await split();
    disk.files.set(path('d'), TEXT);
    await ui.app.open(path('d'));
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd'], ['a.mmd', 'd.mmd']]);
    await ui.app.open(path('b'));
    expect(active().dataset.file).toBe('b.mmd');
    expect(half('a').dataset.file).toBe('b.mmd');
  });

  test('dragging a tab onto the other strip moves it into that group and shows it there', async () => {
    await split();
    dragTab('b.mmd', 900, 20);
    expect(bars().map(names)).toEqual([['c.mmd'], ['a.mmd', 'b.mmd']]);
    expect(half('b').dataset.file).toBe('b.mmd');
    expect(active().dataset.file).toBe('b.mmd');
  });

  test('dropping a tab on the other half moves it into that half\'s group', async () => {
    await split();
    dragTab('b.mmd', 800, 400, true);
    expect([zone()!.style.left, zone()!.style.width]).toEqual(['501px', '499px']);
    window.dispatchEvent(pointer('pointerup', 800, 400));
    lay();
    expect(bars().map(names)).toEqual([['c.mmd'], ['a.mmd', 'b.mmd']]);
    expect(half('b').dataset.file).toBe('b.mmd');
  });

  test('the island and the pill are in the active half only, and each strip names its side', async () => {
    await split();
    expect(all('.island-row')).toHaveLength(1);
    expect(bars().map((b) => b.querySelector('.tablist')!.getAttribute('aria-label'))).toEqual(['Open flowcharts, left side', 'Open flowcharts, right side']);
  });
});

describe('leaving split view (Q184: both ways)', () => {
  async function split(side: 'right' | 'bottom' = 'right') {
    const s = await start(['a', 'b', 'c']);
    if (side === 'right') dragTab('a.mmd', 900, 300);
    else dragTab('a.mmd', 500, 700);
    return s;
  }
  const unsplit = (i: number) => bars()[i].querySelector<HTMLButtonElement>('[data-act="unsplit"]')!;

  test('each strip has a × that closes the split, there only while split', async () => {
    await start(['a', 'b']);
    expect(q<HTMLButtonElement>('[data-act="unsplit"]').hidden).toBe(true);
    dragTab('a.mmd', 900, 300);
    expect(bars().map((b) => b.querySelector<HTMLButtonElement>('[data-act="unsplit"]')!.hidden)).toEqual([false, false]);
    expect(unsplit(1).getAttribute('aria-label')).toBe('Close the split: move these tabs to the other side');
  });

  test('a group\'s × moves its tabs after the other group\'s; no tab closes', async () => {
    const { ui } = await split();
    unsplit(1).click();
    expect(body().classList.contains('split')).toBe(false);
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd', 'a.mmd']]);
    expect(ui.shown()).toBe('c.mmd');
    expect(all('.tabview:not([hidden])')).toHaveLength(1);
    expect(all('.tabview.half-a, .tabview.half-b, .tabview.active')).toHaveLength(0);
  });

  test('closing the first group, one above the other: the strip left moves to the tabs row', async () => {
    const { ui } = await split('bottom');
    unsplit(0).click();
    expect(bars()).toHaveLength(1);
    expect(bars()[0].closest('header.top')).not.toBeNull();
    expect(bars().map(names)).toEqual([['a.mmd', 'b.mmd', 'c.mmd']]);
    expect(ui.shown()).toBe('a.mmd');
    expect(body().classList.contains('split-col')).toBe(false);
  });

  test('closing a group\'s last tab closes the split', async () => {
    const { ui } = await split();
    await ui.closeTab('a.mmd');
    expect(body().classList.contains('split')).toBe(false);
    expect(bars().map(names)).toEqual([['b.mmd', 'c.mmd']]);
    expect(ui.shown()).toBe('c.mmd');
  });

  test('dragging a group\'s last tab onto the other strip closes the split', async () => {
    await split();
    dragTab('a.mmd', 150, 20);
    expect(body().classList.contains('split')).toBe(false);
    expect(bars().map(names)).toEqual([['b.mmd', 'a.mmd', 'c.mmd']]);
  });
});

describe('the divider (Q182)', () => {
  const divider = () => q<HTMLElement>('.split-divider');
  test('a drag resizes the halves, each at least 240 px; a double-click puts it back to half and half', async () => {
    await start(['a', 'b']);
    dragTab('a.mmd', 900, 300);
    expect(body().style.getPropertyValue('--fa')).toBe('0.5fr');
    divider().dispatchEvent(pointer('pointerdown', 500, 300));
    window.dispatchEvent(pointer('pointermove', 700, 300));
    expect(body().style.getPropertyValue('--fa')).toBe('0.7fr');
    expect(body().style.getPropertyValue('--fb')).toBe('0.3fr');
    window.dispatchEvent(pointer('pointermove', 990, 300));
    expect(body().style.getPropertyValue('--fa')).toBe('0.76fr');
    window.dispatchEvent(pointer('pointerup', 990, 300));
    expect(divider().getAttribute('aria-orientation')).toBe('vertical');
    divider().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(body().style.getPropertyValue('--fa')).toBe('0.5fr');
  });
});

describe('remembering the split (T1.23)', () => {
  test('the next start opens the split as it was left: the groups, their shown tabs, the axis, the divider and the active half', async () => {
    const first = await start(['a', 'b', 'c', 'd']);
    dragTab('a.mmd', 500, 700); // [b, c, d] | [a], one above the other
    dragTab('b.mmd', 500, 414); // b joins the lower group, after a
    await sleep(1);
    tabOf('c.mmd').querySelector<HTMLButtonElement>('.tname')!.click(); // the upper half active, showing c
    q<HTMLElement>('.split-divider').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    stopApps();
    const again = await startApp(first.disk, null);
    lay();
    expect(body().classList.contains('split-col')).toBe(true);
    expect(bars().map(names)).toEqual([['c.mmd', 'd.mmd'], ['a.mmd', 'b.mmd']]);
    expect(half('a').dataset.file).toBe('c.mmd');
    expect(half('b').dataset.file).toBe('b.mmd');
    expect(active().dataset.file).toBe('c.mmd');
    expect(again.shown()).toBe('c.mmd');
  });

  test('a split whose second group\'s files are all gone opens unsplit', async () => {
    const first = await start(['a', 'b']);
    dragTab('a.mmd', 900, 300);
    stopApps();
    first.disk.files.delete(path('a'));
    await startApp(first.disk, null);
    expect(body().classList.contains('split')).toBe(false);
    expect(bars().map(names)).toEqual([['b.mmd']]);
  });
});
