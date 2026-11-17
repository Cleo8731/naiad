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
