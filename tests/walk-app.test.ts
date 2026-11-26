// @vitest-environment jsdom
// Walk (T6.4) in the real App (src/app.ts), on the fake disk of app-harness.ts: the pill's
// Walk button in View mode only (Q229), a walk's steps through the tab, the sidebar
// following it, and the walk kept, or ended, as the file and the mode change. What the
// chart draws of a walk is in walk.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { charts, chartEvents, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/walk/tea.mmd';
const BASE = `flowchart TD
    boil[Boil the water] --> ready{Tea bag in?}
    ready -- Yes --> pour[Pour]
    ready -- No --> bag[Add a bag]
    bag --> pour

%% @pour
%% Fill the cup to a finger's width from the top.
`;

async function start(text = BASE) {
  const disk = new FakeDisk();
  disk.files.set(FILE, text);
  return { disk, ui: await startApp(disk, FILE) };
}

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const walkButton = () => q<HTMLButtonElement>('[data-act="walk"]')!;
const walkItem = (from: 'start' | 'selected') => q<HTMLButtonElement>(`.walk-menu [data-walk-from="${from}"]`)!;
/** Walk, through its menu (the user, 2026-11-26): from the start, or from the node selected. */
const walkFrom = (from: 'start' | 'selected') => {
  walkButton().click();
  walkItem(from).click();
};
const viewButton = () => q<HTMLButtonElement>('[data-act="view"]')!;
const chart = () => charts.list[charts.list.length - 1] as unknown as { walks: ({ here: string | null; choices: { to: string; edge: number }[]; starts: { to: string }[] } | null)[]; walkMoves: boolean[]; drawn: string[] };
const lastWalk = () => chart().walks[chart().walks.length - 1];
const walk = (action: unknown) => chartEvents.last!.onWalk(action as never);
const readTitle = () => q('.sidebar .read-title')?.textContent ?? null;
/** A key pressed on the page, outside any field. */
const press = (key: string) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
};

async function toView() {
  viewButton().click();
  await vi.waitFor(() => expect(viewButton().textContent!.trim()).toBe('View mode'));
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the Walk button (Q229)', () => {
  it('is on the pill in View mode only', async () => {
    await start();
    expect(walkButton().hidden).toBe(true);
    await toView();
    expect(walkButton().hidden).toBe(false);
    expect(walkButton().closest('.pill')).not.toBeNull();
    viewButton().click();
    await vi.waitFor(() => expect(walkButton().hidden).toBe(true));
  });

  it('starts at the one place no arrow points to, shows it in the sidebar, hides the pill and turns Highlight off', async () => {
    await start();
    await toView();
    q<HTMLButtonElement>('[data-act="highlight"]')!.click();
    expect(q('[data-act="highlight"]')!.getAttribute('aria-pressed')).toBe('true');
    walkFrom('start');
    expect(lastWalk()).toMatchObject({ here: 'boil', choices: [{ to: 'ready' }] });
    expect(readTitle()).toBe('Boil the water');
    expect(q<HTMLElement>('.pill')!.hidden).toBe(true);
    expect(q('[data-act="highlight"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('with several places to start, the reader picks one', async () => {
    await start(BASE.replace('bag --> pour', 'bag --> pour\n    note[Spare cups]'));
    await toView();
    walkFrom('start');
    expect(lastWalk()).toMatchObject({ here: null, starts: [{ to: 'boil' }, { to: 'note' }] });
    walk({ kind: 'start', id: 'note' });
    expect(lastWalk()).toMatchObject({ here: 'note', choices: [] });
  });

  it('its menu: from the start, or from the node selected now, which is off while no node is selected (the user, 2026-11-26)', async () => {
    await start();
    await toView();
    const menu = () => q<HTMLElement>('.walk-menu')!;
    walkButton().click();
    expect(menu().hidden).toBe(false);
    expect(walkButton().getAttribute('aria-expanded')).toBe('true');
    expect(walkItem('selected').disabled).toBe(true);
    press('Escape');
    expect(menu().hidden).toBe(true);
    expect(chart().walks).toEqual([]); // nothing started
    chartEvents.last!.onSelect({ kind: 'node', id: 'ready' });
    walkButton().click();
    expect(walkItem('selected').disabled).toBe(false);
    expect(walkItem('selected').title).toBe('Start the walkthrough at "Tea bag in?"');
    walkItem('selected').click();
    expect(menu().hidden).toBe(true);
    expect(lastWalk()).toMatchObject({ here: 'ready', choices: [{ to: 'pour' }, { to: 'bag' }] });
    walk({ kind: 'again' }); // Start again goes to the start
    expect(lastWalk()!.here).toBe('boil');
  });
});

describe('a walk', () => {
  it('takes the chosen arrow, goes back, starts again and leaves; nothing is written', async () => {
    const { disk } = await start();
    await toView();
    walkFrom('start');
    walk({ kind: 'choose', edge: 0 });
    expect(lastWalk()!.here).toBe('ready');
    expect(lastWalk()!.choices.map((c) => c.to)).toEqual(['pour', 'bag']);
    walk({ kind: 'choose', edge: 99 }); // not an arrow from here: nothing happens
    expect(lastWalk()!.here).toBe('ready');
    walk({ kind: 'choose', edge: 2 });
    expect(lastWalk()!.here).toBe('bag');
    walk({ kind: 'back' });
    expect(lastWalk()!.here).toBe('ready');
    expect(readTitle()).toBe('Tea bag in?');
    walk({ kind: 'choose', edge: 1 });
    expect(readTitle()).toBe('Pour');
    expect(q('.sidebar')!.textContent).toContain("Fill the cup to a finger's width");
    walk({ kind: 'again' });
    expect(lastWalk()!.here).toBe('boil');
    walk({ kind: 'leave' });
    expect(lastWalk()).toBeNull();
    expect(q<HTMLElement>('.pill')!.hidden).toBe(false);
    expect(disk.writes).toEqual([]);
  });

  it('Clear, the button that takes the highlights off, is gone while a walk hides them (the user, 2026-11-26)', async () => {
    const disk = new FakeDisk();
    disk.files.set(FILE, BASE);
    disk.highlights.set(FILE, 'boil\npour\n');
    await startApp(disk, FILE);
    const clear = () => q<HTMLButtonElement>('[data-act="clear"]')!;
    await vi.waitFor(() => expect(clear().hidden).toBe(false));
    expect(clear().textContent).toContain('Clear 2');
    await toView();
    walkFrom('start');
    expect(clear().hidden).toBe(true);
    walk({ kind: 'leave' });
    expect(clear().hidden).toBe(false);
    expect(disk.highlights.get(FILE)).toBe('boil\npour\n'); // the file keeps them
  });

  it('keys (Q233): 1 to 9 take a choice, Right arrow takes the one way on, Left arrow goes back, Escape leaves', async () => {
    await start();
    await toView();
    walkFrom('start');
    expect(press('ArrowRight').defaultPrevented).toBe(true); // one way on: Next
    expect(lastWalk()!.here).toBe('ready');
    press('ArrowRight'); // two ways on: Right arrow does nothing
    expect(lastWalk()!.here).toBe('ready');
    press('3'); // no third choice
    expect(lastWalk()!.here).toBe('ready');
    press('2');
    expect(lastWalk()!.here).toBe('bag');
    press('ArrowLeft');
    expect(lastWalk()!.here).toBe('ready');
    press('h'); // Highlight waits until the walk ends
    expect(q('[data-act="highlight"]')!.getAttribute('aria-pressed')).toBe('false');
    press('Escape');
    expect(lastWalk()).toBeNull();
    expect(press('1').defaultPrevented).toBe(false); // no walk: the keys are not taken
  });

  it('keys while picking where to start: 1 to 9 pick the place; in a text field they type', async () => {
    const { ui } = await start(BASE.replace('bag --> pour', 'bag --> pour\n    note[Spare cups]'));
    await toView();
    walkFrom('start');
    const field = ui.area();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    expect(lastWalk()!.here).toBeNull();
    press('2');
    expect(lastWalk()!.here).toBe('note');
  });

  it('ends when View mode is switched off', async () => {
    await start();
    await toView();
    walkFrom('start');
    viewButton().click();
    await vi.waitFor(() => expect(lastWalk()).toBeNull());
    expect(q<HTMLElement>('.pill')!.hidden).toBe(false);
  });

  it('when an agent deletes the place it is at, it steps back to the last place still there', async () => {
    const { disk } = await start();
    await toView();
    walkFrom('start');
    walk({ kind: 'choose', edge: 0 });
    walk({ kind: 'choose', edge: 2 }); // at "Add a bag"
    const drawn = chart().drawn.length;
    disk.outside(FILE, BASE.replace('    ready -- No --> bag[Add a bag]\n    bag --> pour\n', ''));
    await vi.waitFor(() => expect(chart().drawn.length).toBeGreaterThan(drawn));
    await vi.waitFor(() => expect(lastWalk()!.here).toBe('ready'));
    expect(chart().walkMoves[chart().walkMoves.length - 1]).toBe(true);
    expect(readTitle()).toBe('Tea bag in?');
  });

  it('when the file changes elsewhere, it stays where it is and the view does not move', async () => {
    const { disk } = await start();
    await toView();
    walkFrom('start');
    walk({ kind: 'choose', edge: 0 });
    const drawn = chart().drawn.length;
    disk.outside(FILE, BASE + '%% @boil\n%% Fresh water only.\n');
    await vi.waitFor(() => expect(chart().drawn.length).toBeGreaterThan(drawn));
    await vi.waitFor(() => expect(chart().walkMoves[chart().walkMoves.length - 1]).toBe(false));
    expect(lastWalk()!.here).toBe('ready');
  });
});
