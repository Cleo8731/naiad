// @vitest-environment jsdom
// The tab strip with many tabs (T1.25; the user's report of 2026-11-18, Q177 and Q178
// answered "Yes"): a press on the strip's scroll bar moved the window, and the wheel did
// not scroll it. Now tabs shrink to a floor; past it the strip scrolls with the wheel,
// with no scroll bar and a fade at a cut edge; a gap past the + always moves the window;
// and while tabs are out of sight, a button lists every tab.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const TEXT = 'flowchart TD\n    a[A] --> b[B]\n';
const FILES = ['a', 'b', 'c', 'd', 'e'].map((n) => `C:/proj/${n}.mmd`);
const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const list = () => q<HTMLElement>('.tabs .tablist');
const more = () => q<HTMLButtonElement>('.tabs [data-act="alltabs"]');
const menu = () => q<HTMLElement>('.tabs .tabs-menu');
const items = () => [...document.querySelectorAll<HTMLElement>('.tabs .tablist .tab')];
const css = () => readFileSync('src/style.css', 'utf8');
const rule = (selector: string) => {
  const at = css().replace(/\/\*[\s\S]*?\*\//g, '').split('}').find((r) => r.split('{')[0].split(',').map((s) => s.trim()).includes(selector));
  return at?.split('{')[1] ?? '';
};

async function start() {
  const disk = new FakeDisk();
  disk.kind = 'desktop';
  for (const f of FILES) disk.files.set(f, TEXT);
  const ui = await startApp(disk, FILES[0]);
  for (const f of FILES.slice(1)) await ui.app.open(f);
  return ui;
}

/** Lays the strip out as a browser would: the list from 0 to `width`, each tab `tab` px wide, scrolled by `scroll`. */
function place(width: number, tab: number, scroll = 0) {
  const box = (left: number, w: number) => ({ left, right: left + w, top: 0, bottom: 30, width: w, height: 30, x: left, y: 0, toJSON() {} }) as DOMRect;
  list().getBoundingClientRect = () => box(0, width);
  items().forEach((t, i) => { t.getBoundingClientRect = () => box(i * tab - scroll, tab); });
}
/** The same, then the list's scroll event. */
function layOut(width: number, tab: number, scroll = 0) {
  place(width, tab, scroll);
  list().dispatchEvent(new Event('scroll'));
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the strip\'s parts (Q177)', () => {
  test('the tabs sit in a list of their own; the list\'s button and the + follow it', async () => {
    const ui = await start();
    expect(ui.tabs()).toEqual(['a.mmd', 'b.mmd', 'c.mmd', 'd.mmd', 'e.mmd']);
    expect(list().getAttribute('role')).toBe('tablist');
    expect(items()).toHaveLength(5);
    expect(list().querySelector('[data-act="newtab"]')).toBeNull();
    const after = [...q('.tabs').children].slice([...q('.tabs').children].indexOf(list()) + 1);
    expect(after.map((el) => el.querySelector('[data-act]')?.getAttribute('data-act') ?? el.getAttribute('data-act'))).toEqual(['alltabs', 'newtab', 'unsplit']);
  });

  test('a tab shrinks to 72 px before the list scrolls; the list has no scroll bar', () => {
    expect(rule('.tab')).toMatch(/min-width:\s*72px/);
    expect(rule('.tabs .tablist')).toMatch(/overflow-x:\s*auto/);
    expect(rule('.tabs .tablist')).toMatch(/scrollbar-width:\s*none/);
  });

  // Q219: tabs that all start from 200 px shrink by the same amount into a list as wide
  // as their names, so they come out equally wide and a name longer than the average is
  // cut ("b.m…", "sample.…") with the window half empty. Each starts from its own name.
  test('a tab starts from its own name\'s width, at most 200 px, and shrinks from there', () => {
    expect(rule('.tab')).toMatch(/flex:\s*0 1 auto/);
    expect(rule('.tab')).toMatch(/max-width:\s*200px/);
  });

  test('past the +, at least 40 px of the row is always left to move the window', () => {
    expect(rule('.tabs')).toMatch(/padding:\s*0 40px 0 2px/);
  });
});

describe('the list scrolls with the wheel (Q177)', () => {
  test('a turn of the wheel moves the list sideways while tabs are out of sight', async () => {
    await start();
    let left = 0;
    Object.defineProperty(list(), 'scrollLeft', { get: () => left, set: (v: number) => { left = v; }, configurable: true });
    Object.defineProperty(list(), 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(list(), 'clientWidth', { value: 400, configurable: true });
    const turn = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list().dispatchEvent(turn);
    expect(left).toBe(120);
    expect(turn.defaultPrevented).toBe(true);
    // A sideways swipe is the browser's own: left alone.
    const swipe = new WheelEvent('wheel', { deltaX: 50, deltaY: 2, bubbles: true, cancelable: true });
    list().dispatchEvent(swipe);
    expect(left).toBe(120);
    expect(swipe.defaultPrevented).toBe(false);
  });

  test('with every tab in sight, the wheel is left alone', async () => {
    await start();
    Object.defineProperty(list(), 'scrollWidth', { value: 400, configurable: true });
    Object.defineProperty(list(), 'clientWidth', { value: 400, configurable: true });
    const turn = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list().dispatchEvent(turn);
    expect(turn.defaultPrevented).toBe(false);
  });
});

describe('the fade and the list of all tabs (Q177, Q178)', () => {
  test('with every tab in sight, no fade and no list button', async () => {
    await start();
    layOut(600, 110);
    expect(more().hidden).toBe(true);
    expect(list().classList.contains('fade-start')).toBe(false);
    expect(list().classList.contains('fade-end')).toBe(false);
  });

  test('with tabs cut off at the end, a fade there, and the button says how many are out of sight', async () => {
    await start();
    layOut(300, 72); // 0-72, 72-144, 144-216, 216-288 in sight; 288-360 cut
    expect(more().hidden).toBe(false);
    expect(more().textContent).toContain('1');
    expect(more().getAttribute('aria-label')).toBe('1 more tab: list every tab');
    expect(list().classList.contains('fade-end')).toBe(true);
    expect(list().classList.contains('fade-start')).toBe(false);
    layOut(200, 72, 60); // -60 to 12 cut at the start; 228-300 and 300-372 past the end
    expect(more().getAttribute('aria-label')).toBe('3 more tabs: list every tab');
    expect(list().classList.contains('fade-start')).toBe(true);
    expect(list().classList.contains('fade-end')).toBe(true);
  });

  test('showing a tab scrolls it into sight and measures again at once, not on a later scroll event', async () => {
    const ui = await start();
    layOut(300, 72, 72); // a.mmd cut at the start, e.mmd at the end
    expect(list().classList.contains('fade-start')).toBe(true);
    const first = items()[0];
    // The browser scrolls the list to a.mmd; its scroll event has not come yet.
    first.scrollIntoView = () => place(300, 72, 0);
    first.querySelector<HTMLButtonElement>('.tname')!.click();
    expect(ui.shown()).toBe('a.mmd');
    expect(list().classList.contains('fade-start')).toBe(false);
    expect(list().classList.contains('fade-end')).toBe(true);
  });

  test('the button opens a list of every tab, the shown one marked; a click shows that tab', async () => {
    const ui = await start();
    layOut(200, 72);
    expect(menu().hidden).toBe(true);
    more().click();
    expect(menu().hidden).toBe(false);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    const entries = [...menu().querySelectorAll<HTMLButtonElement>('button')];
    expect(entries.map((b) => b.textContent)).toEqual(['a.mmd', 'b.mmd', 'c.mmd', 'd.mmd', 'e.mmd']);
    expect(entries.map((b) => b.getAttribute('aria-current'))).toEqual([null, null, null, null, 'true']);
    expect(entries[1].title).toBe(FILES[1]);
    entries[1].click();
    expect(ui.shown()).toBe('b.mmd');
    expect(menu().hidden).toBe(true);
  });

  test('a click elsewhere or Escape closes the list', async () => {
    await start();
    layOut(200, 72);
    more().click();
    q<HTMLElement>('main').click();
    expect(menu().hidden).toBe(true);
    more().click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().hidden).toBe(true);
    more().click();
    more().click();
    expect(menu().hidden).toBe(true);
  });
});

describe('a tab\'s width never changes on pointing or showing (Q189)', () => {
  test('every tab keeps room for its ×: no rule changes the name\'s padding by state', () => {
    expect(rule('.tab .tname')).toMatch(/padding:\s*0 28px 0 12px/);
    const byState = css().replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{'))
      .filter(([sel, body]) => /\.tab[^{]*(:hover|:focus-within|\.shown)[^{]*\.tname/.test(sel ?? '') && /padding|width|margin/.test(body ?? ''));
    expect(byState).toEqual([]);
  });

  test('each name keeps room for itself in bold, the shown tab\'s weight, so showing a tab doesn\'t widen it', async () => {
    await start();
    for (const item of items()) {
      const name = item.querySelector<HTMLElement>('.tname')!;
      expect(name.querySelector('.tlabel')!.textContent).toBe(name.textContent);
      expect(name.dataset.label).toBe(name.textContent);
    }
    const reserve = rule('.tab .tname::after');
    expect(reserve).toMatch(/content:\s*attr\(data-label\)/);
    expect(reserve).toMatch(/font-weight:\s*600/);
    expect(reserve).toMatch(/visibility:\s*hidden/);
    expect(rule('.tab.shown .tname')).toMatch(/font-weight:\s*600/);
  });
});

describe('the list of every tab\'s place (Q178)', () => {
  test('it opens under its button, lined up with the button\'s right side, so it stays inside the window', () => {
    expect(rule('.tabs-menu')).toMatch(/right:\s*0/);
    expect(rule('.tabs-menu')).not.toMatch(/left:/);
  });
});
