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
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.sidebar button')].find((b) => b.textContent?.trim() === label && !b.closest('[hidden]')) ?? null;
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
  const menuOf = (i: number) => items()[i].querySelector<HTMLElement>('.class-menu')!;
  const openMenu = (i: number) => { items()[i].querySelector<HTMLButtonElement>('.class-more')!.click(); return menuOf(i); };
  const listIn = (menu: HTMLElement, label: string) => [...menu.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent === label)!.querySelector<HTMLSelectElement>('select')!;
  const choose = (sel: HTMLSelectElement, value: string) => { sel.value = value; sel.dispatchEvent(new Event('change')); };

  it('lists each class with its name and how many nodes use it', async () => {
    await start();
    expect(items().map((i) => [i.querySelector('.class-name')!.textContent, i.querySelector('.class-count')!.textContent]))
      .toEqual([['held', '1 node'], ['stop', '1 node']]);
  });

  it('a swatch in a class\'s menu changes its colour; Delete class takes the class away and leaves its nodes', async () => {
    const { ui } = await start();
    openMenu(0).querySelectorAll<HTMLButtonElement>('.swatch:not(.own)')[0].click(); // Blue
    expect(await ui.until((t) => t.includes('classDef held fill:#d0ebff,stroke:#1c7ed6,color:#1c2026'))).toBe(true);
    openMenu(1);
    button('Delete class')!.click();
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

  it('each line has a picture of its shape and border; the menu opens from the three-dot button, one at a time (Q275)', async () => {
    await start(BASE.replace('classDef stop fill:#ffe3e3,stroke:#e03131', 'classDef stop fill:#ffe3e3,stroke:#e03131,stroke-width:3px\n    %% @class stop shape: stadium'));
    const pics = items().map((i) => i.querySelector<HTMLElement>('.class-pic')!.dataset);
    expect(pics.map((d) => [d.shape, d.border])).toEqual([['', 'normal'], ['stadium', 'thick']]);
    expect(menuOf(0).hidden).toBe(true);
    openMenu(0);
    expect(menuOf(0).hidden).toBe(false);
    expect(listIn(menuOf(0), 'Shape').value).toBe('');
    expect(listIn(menuOf(0), 'Shape').options[0].textContent).toBe('Any shape');
    openMenu(1);
    expect(menuOf(0).hidden).toBe(true);
    expect(listIn(menuOf(1), 'Border').value).toBe('thick'); // 3px: the nearest choice, kept until one is picked
    expect(listIn(menuOf(1), 'Shape').value).toBe('stadium');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menuOf(1).hidden).toBe(true);
  });

  it('the picture names the colour, shape and border; the menu marks the colour, its own one too (the user, 2026-11-26)', async () => {
    await start(BASE.replace('classDef stop fill:#ffe3e3,stroke:#e03131', 'classDef stop fill:#ffe3e3,stroke:#e03131,stroke-dasharray:5 3\n    %% @class stop shape: stadium'));
    const pic = (i: number) => items()[i].querySelector<HTMLElement>('.class-pic')!.title;
    expect(pic(0)).toBe('Colour: its own, #fff0cd\nShape: Any shape\nBorder: Normal');
    expect(pic(1)).toBe('Colour: Red\nShape: Stadium\nBorder: Dashed');
    const marked = (i: number) => [...menuOf(i).querySelectorAll<HTMLButtonElement>('.swatch.on:not([hidden])')].map((b) => b.title);
    expect(marked(0)).toEqual(['Its own colour, #fff0cd']); // none of the six: shown first, marked
    expect(marked(1)).toEqual(['Red']);
    expect(menuOf(1).querySelector<HTMLElement>('.swatch.own')!.hidden).toBe(true);
  });

  it('Border writes a thick or dashed border, and Normal takes it off (Q274)', async () => {
    const { ui } = await start();
    choose(listIn(openMenu(0), 'Border'), 'thickdashed');
    expect(await ui.until((t) => t.includes('classDef held fill:#fff0cd,stroke:#996300,stroke-width:2px,stroke-dasharray:5 3'))).toBe(true);
    expect(menuOf(0).hidden).toBe(false); // the menu stays open while the file changes
    choose(listIn(menuOf(0), 'Border'), 'normal');
    expect(await ui.until((t) => t === BASE)).toBe(true);
  });

  it('Shape gives the class a shape and its nodes take it; Any shape takes the line away (Q267, Q271)', async () => {
    const { ui } = await start();
    choose(listIn(openMenu(0), 'Shape'), 'diamond');
    expect(await ui.until((t) => t.includes('    classDef held fill:#fff0cd,stroke:#996300\n    %% @class held shape: diamond\n') && /hold\{"?Hold"?\}/.test(t))).toBe(true);
    choose(listIn(menuOf(0), 'Shape'), '');
    expect(await ui.until((t) => !t.includes('@class held'))).toBe(true);
    expect(ui.area().value).toMatch(/hold\{"?Hold"?\}/); // the nodes keep the shape they have
  });

  it('double-clicking a name renames the class everywhere the file names it; one Undo takes it back (Q276)', async () => {
    const { ui } = await start();
    items()[1].querySelector('.class-name')!.dispatchEvent(new MouseEvent('dblclick'));
    const input = q<HTMLInputElement>('.sidebar input.class-rename')!;
    expect(input.value).toBe('stop');
    input.value = 'held';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(items()[1].querySelector('.problem')!.textContent).toBe('There is already a class "held".');
    input.value = 'halt';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await ui.until((t) => t.includes('classDef halt fill:#ffe3e3') && t.includes('class stop halt') && !t.includes('stop stop'))).toBe(true);
    expect(q('.sidebar input.class-rename')).toBeNull();
    expect(items().map((i) => i.querySelector('.class-name')!.textContent)).toEqual(['held', 'halt']);
    ui.undo();
    expect(await ui.until((t) => t === BASE)).toBe(true);
  });

  it('Rename in the menu opens the same box; Escape keeps the old name', async () => {
    const { disk } = await start();
    openMenu(0);
    button('Rename')!.click();
    expect(menuOf(0).hidden).toBe(true);
    const input = q<HTMLInputElement>('.sidebar input.class-rename')!;
    input.value = 'other';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(q('.sidebar input.class-rename')).toBeNull();
    expect(items()[0].querySelector('.class-name')!.textContent).toBe('held');
    expect(disk.files.get(FILE)).toBe(BASE);
  });

  it('New class sets a border and a shape too', async () => {
    const { ui } = await start('flowchart TD\n    a --> b\n');
    button('New class')!.click();
    const f = form()!;
    f.querySelector<HTMLInputElement>('input')!.value = 'calm';
    choose(listIn(f, 'Border'), 'thick');
    choose(listIn(f, 'Shape'), 'hexagon');
    button('Create')!.click();
    expect(await ui.until((t) => t === 'flowchart TD\n    a --> b\n    classDef calm fill:#d0ebff,stroke:#1c7ed6,color:#1c2026,stroke-width:2px\n    %% @class calm shape: hexagon\n')).toBe(true);
  });
});

describe('putting a node in a class from its panel (Q267, Q270)', () => {
  it('the node takes the class\'s shape, and loses its own colour so the class\'s shows; Undo puts both back', async () => {
    const text = BASE.replace('classDef stop fill:#ffe3e3,stroke:#e03131', 'classDef stop fill:#ffe3e3,stroke:#e03131\n    %% @class stop shape: stadium') + '    style ask fill:#d3f9d8,stroke:#2f9e44\n';
    const { ui } = await start(text);
    select({ kind: 'node', id: 'ask' });
    pick('stop');
    expect(await ui.until((t) => /ask\(\["?Ask"?\]\)/.test(t) && t.includes('class stop,ask stop') && !t.includes('style ask'))).toBe(true);
    ui.undo();
    expect(await ui.until((t) => t === text)).toBe(true);
  });
});

describe('the panels\' order (Q272)', () => {
  const order = () => [...document.querySelectorAll<HTMLElement>('.sidebar > .props, .sidebar > .desc, .sidebar > .hint')]
    .map((el) => (el.classList.contains('props') ? [...el.querySelectorAll(':scope > .row .row-label')].map((l) => l.textContent).join('+') : el.className));

  it('a node: Class and Group, then the description, then Shape and Colour', async () => {
    await start();
    select({ kind: 'node', id: 'hold' });
    expect(order()).toEqual(['Class+Group', 'desc', 'Shape+Colour']);
  });

  it('a group: Class right under the title', async () => {
    await start('flowchart TD\n    subgraph g [Work]\n        a\n    end\n    classDef held fill:#fff0cd\n');
    select({ kind: 'sub', id: 'g' });
    expect(order()).toEqual(['Class', 'hint', 'Direction+Colour']);
  });
});
