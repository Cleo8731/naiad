// @vitest-environment jsdom
// The rail's two switches as vertical sliding toggles (the user, 2026-11-17: "Edit/View
// and Mouse/Touchpad both become vertical sliding toggles"). Each is one button in the
// rail's middle holding a short vertical track with both modes' icons, Mouse over
// Touchpad and Edit over View, and a knob that slides onto the mode in use; a click
// anywhere on it switches. Its name, shown on pointing, still says the mode it is in.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/toggles/flow.mmd';
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
const toggle = (act: 'wheel' | 'view') => q<HTMLButtonElement>(`.rail-mid [data-act="${act}"]`);
const icons = (act: 'wheel' | 'view') => [...toggle(act).querySelectorAll('.track svg')].map((s) => s.getAttribute('data-icon'));
const shown = (act: 'wheel' | 'view') => toggle(act).querySelector('.track svg.on')?.getAttribute('data-icon');

async function start() {
  const disk = new FakeDisk();
  disk.files.set(FILE, 'flowchart TD\n    a[A] --> b[B]\n');
  return startApp(disk, FILE);
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the rail\'s switches slide (the user, 2026-11-17)', () => {
  it('each holds both modes\' icons in a vertical track, with a knob', async () => {
    await start();
    expect(icons('wheel')).toEqual(['mouse', 'touchpad']);
    expect(icons('view')).toEqual(['edit', 'read']);
    for (const act of ['wheel', 'view'] as const) {
      expect(toggle(act).classList.contains('slide'), act).toBe(true);
      expect(toggle(act).querySelector('.track .knob'), act).not.toBeNull();
      expect(toggle(act).querySelector('.track')!.getAttribute('aria-hidden'), act).toBe('true');
    }
  });

  it('the knob sits on the mode in use: Mouse and Edit at the first start', async () => {
    await start();
    expect([toggle('wheel').dataset.pos, shown('wheel')]).toEqual(['0', 'mouse']);
    expect([toggle('view').dataset.pos, shown('view')]).toEqual(['0', 'edit']);
    expect(toggle('wheel').querySelectorAll('svg.on')).toHaveLength(1);
  });

  it('a click slides the knob to the other mode and back, and the name follows', async () => {
    await start();
    const knob = toggle('wheel').querySelector('.knob');
    toggle('wheel').click();
    expect([toggle('wheel').dataset.pos, shown('wheel')]).toEqual(['1', 'touchpad']);
    expect(toggle('wheel').querySelector('.rlabel')!.textContent).toBe('Touchpad mode');
    // The same knob moves (so it can slide); the track is not drawn again.
    expect(toggle('wheel').querySelector('.knob')).toBe(knob);
    toggle('wheel').click();
    expect([toggle('wheel').dataset.pos, shown('wheel')]).toEqual(['0', 'mouse']);

    toggle('view').click();
    await vi.waitFor(() => expect(toggle('view').querySelector('.rlabel')!.textContent).toBe('View mode'));
    expect([toggle('view').dataset.pos, shown('view')]).toEqual(['1', 'read']);
  });

  it('Touchpad mode kept from the last run starts with the knob on Touchpad', async () => {
    localStorage.setItem('wheelmode', 'touchpad');
    await start();
    expect([toggle('wheel').dataset.pos, shown('wheel')]).toEqual(['1', 'touchpad']);
  });

  it('the track stands upright and the knob slides, unless the person asks for less motion', () => {
    const css = readFileSync('src/style.css', 'utf8');
    const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.slide .track')).toMatch(/flex-direction:\s*column/);
    expect(rule('.slide .knob')).toMatch(/transition:[^;]*transform/);
    expect(rule('.slide[data-pos="1"] .knob')).toMatch(/transform:\s*translateY/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{(?:[^{}]*\{[^}]*\})*?[^{}]*\.slide \.knob[^{]*\{\s*transition:\s*none/);
  });
});

// On pointing (the user, 2026-11-17, answering Q172: "Yes, build it"): the switch widens
// into two lines, both modes' names always shown; the knob stretches right over the mode
// in use and its name, in the accent, and the other name stays gray outside it. The knob
// reaches the end of the widened track, even on the shorter name (the user, 2026-11-18:
// "Make sure the highlight reaches the end of the extended tab, even if the word is
// shorter").
describe('the rail\'s switches on pointing (T4.13, Q172)', () => {
  const opts = (act: 'wheel' | 'view') => [...toggle(act).querySelectorAll<HTMLElement>('.track .opt')];
  const css = () => readFileSync('src/style.css', 'utf8');
  const rule = (sel: string) => css().match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  it('each line of the track holds its icon and its mode\'s name, in the order of the icons', async () => {
    await start();
    expect(opts('wheel').map((o) => [o.dataset.name, o.querySelector('svg')!.getAttribute('data-icon')]))
      .toEqual([['Mouse mode', 'mouse'], ['Touchpad mode', 'touchpad']]);
    expect(opts('view').map((o) => [o.dataset.name, o.querySelector('svg')!.getAttribute('data-icon')]))
      .toEqual([['Edit mode', 'edit'], ['View mode', 'read']]);
  });

  it('the line of the mode in use is marked, and the mark moves with a click', async () => {
    await start();
    expect(opts('wheel').map((o) => o.classList.contains('on'))).toEqual([true, false]);
    toggle('wheel').click();
    expect(opts('wheel').map((o) => o.classList.contains('on'))).toEqual([false, true]);
    toggle('view').click();
    await vi.waitFor(() => expect(opts('view').map((o) => o.classList.contains('on'))).toEqual([false, true]));
  });

  it('the knob\'s width comes from the track alone, not from one line: nothing is measured', async () => {
    await start();
    for (const act of ['wheel', 'view'] as const) {
      toggle(act).click();
      expect(toggle(act).querySelector<HTMLElement>('.knob')!.getAttribute('style'), act).toBeNull();
    }
  });

  it('the button keeps one name, the mode in use, for screen readers', async () => {
    await start();
    expect(toggle('wheel').textContent!.trim()).toBe('Mouse mode');
    expect(toggle('view').textContent!.trim()).toBe('Edit mode');
  });

  it('the names show only on pointing; the knob then stretches; the other name is gray', () => {
    expect(rule('.slide .opt::after')).toMatch(/content:\s*attr\(data-name\)/);
    expect(rule('.slide .opt::after')).toMatch(/color:\s*var\(--muted\)/);
    expect(rule('.slide .opt.on::after')).toMatch(/color:\s*var\(--accent\)/);
    expect(rule('.slide .track')).toMatch(/max-width:\s*26px/);
    expect(rule('.slide .track')).toMatch(/overflow:\s*hidden/);
    expect(rule('.rail button.slide:hover .track')).toMatch(/max-width:\s*\d{3}px/);
    // The knob spans the track inside its 2 px edge: as wide as the longer name, on either line.
    expect(rule('.rail button.slide:hover .knob')).toMatch(/width:\s*calc\(100% - 4px\)/);
    expect(rule('.slide .knob')).toMatch(/transition:[^;]*width/);
    expect(rule('.slide .rlabel')).toMatch(/clip-path:\s*inset\(50%\)/); // heard, not seen
  });
});
