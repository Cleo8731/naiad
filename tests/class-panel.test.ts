// @vitest-environment jsdom
// Classes in the window (T1.26; the user, 2026-11-26, Q263 to Q265): a node's Class row,
// New class…, and the About panel's Classes, in the real App (src/app.ts) on the fake
// disk of app-harness.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartEvents, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/classes/flow.mmd';
const BASE = `flowchart TD
    ask[Ask] --> hold[Hold]:::held
    hold --> stop[Stop]
    classDef held fill:#fff0cd,stroke:#996300
    classDef stop fill:#ffe3e3,stroke:#e03131
    class stop stop
`;

async function start(text = BASE) {
  const disk = new FakeDisk();
  disk.files.set(FILE, text);
  return { disk, ui: await startApp(disk, FILE) };
}

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const select = (target: unknown) => chartEvents.last!.onSelect(target as never);
const row = (label: string) => [...document.querySelectorAll<HTMLElement>('.sidebar .row')].find((r) => r.querySelector('.row-label')?.textContent === label)!;
const classBox = () => row('Class').querySelector<HTMLSelectElement>('select')!;
const pick = (value: string) => { const s = classBox(); s.value = value; s.dispatchEvent(new Event('change')); };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.sidebar button')].find((b) => b.textContent === label && !b.closest('[hidden]')) ?? null;
const form = () => q<HTMLElement>('.sidebar .new-class:not([hidden])');

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('a node\'s Class row', () => {
  it('lists None, the file\'s classes and New class…, with the node\'s class chosen', async () => {
    await start();
    select({ kind: 'node', id: 'hold' });
    expect(row('Class').hidden).toBe(false);
    expect([...classBox().options].map((o) => o.textContent)).toEqual(['None', 'held', 'stop', 'New class…']);
    expect(classBox().value).toBe('held');
  });

  it('picking a class puts the node in it, and None takes it out; Undo puts it back', async () => {
    const { ui } = await start();
    select({ kind: 'node', id: 'ask' });
    pick('stop');
    expect(await ui.until((t) => t.includes('class stop,ask stop'))).toBe(true);
    pick('');
    expect(await ui.until((t) => t === BASE)).toBe(true);
    ui.undo();
    expect(await ui.until((t) => t.includes('class stop,ask stop'))).toBe(true);
  });

  it('is not shown while the file defines no class', async () => {
    await start('flowchart TD\n    a --> b\n');
    select({ kind: 'node', id: 'a' });
    expect(row('Class').hidden).toBe(true);
  });

  it('New class… makes a class of the picked colour with the node in it; a name in use says why', async () => {
    const { ui } = await start();
    select({ kind: 'node', id: 'ask' });
    pick('\u0000new-class');
    const name = form()!.querySelector<HTMLInputElement>('input')!;
    name.value = 'held';
    button('Create')!.click();
    expect(form()!.querySelector('.problem')!.textContent).toBe('There is already a class "held".');
    name.value = 'review';
    form()!.querySelectorAll<HTMLButtonElement>('.swatch')[1].click(); // Green
    button('Create')!.click();
    expect(await ui.until((t) => t.includes('classDef review fill:#d3f9d8,stroke:#2f9e44,color:#1c2026\n    class stop stop\n    class ask review\n'))).toBe(true);
    expect(form()).toBeNull();
    expect(classBox().value).toBe('review');
  });
});

describe('a new node', () => {
  it('opens with the Class row under its title, so it can be given a class at once (Q265)', async () => {
    const { ui } = await start();
    chartEvents.last!.onAddNode();
    expect(await ui.until((t) => t.includes('n1(New node)'))).toBe(true);
    expect(row('Class').hidden).toBe(false);
    pick('held');
    expect(await ui.until((t) => t.includes('n1(New node)') && /class \S*n1 held/.test(t))).toBe(true);
  });
});

describe('the About panel\'s Classes (Q264)', () => {
  const items = () => [...document.querySelectorAll<HTMLElement>('.sidebar .class-item')];

  it('lists each class with its name and how many nodes use it', async () => {
    await start();
    expect(items().map((i) => [i.querySelector('.class-name')!.textContent, i.querySelector('.class-count')!.textContent]))
      .toEqual([['held', '1 node'], ['stop', '1 node']]);
  });

  it('a swatch changes the class\'s colour; Delete takes the class away and leaves its nodes', async () => {
    const { ui } = await start();
    items()[0].querySelectorAll<HTMLButtonElement>('.swatch')[0].click(); // Blue
    expect(await ui.until((t) => t.includes('classDef held fill:#d0ebff,stroke:#1c7ed6,color:#1c2026'))).toBe(true);
    items()[1].querySelector<HTMLButtonElement>('button.danger')!.click();
    expect(await ui.until((t) => !t.includes('stop fill'))).toBe(true);
    expect(ui.area().value).toContain('hold --> stop[Stop]');
    expect(ui.area().value).not.toContain('class stop stop');
  });

  it('New class adds one in a file with none', async () => {
    const { ui } = await start('flowchart TD\n    a --> b\n');
    expect(q('.sidebar .classes .hint')!.textContent).toContain('No classes yet');
    button('New class')!.click();
    form()!.querySelector<HTMLInputElement>('input')!.value = 'calm';
    button('Create')!.click();
    expect(await ui.until((t) => t === 'flowchart TD\n    a --> b\n    classDef calm fill:#d0ebff,stroke:#1c7ed6,color:#1c2026\n')).toBe(true);
    expect(items().map((i) => i.querySelector('.class-count')!.textContent)).toEqual(['Not used']);
  });
});
