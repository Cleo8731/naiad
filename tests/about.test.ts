// @vitest-environment jsdom
// The flowchart's description (D1.4, T1.13) in the real App (src/app.ts), on the fake
// disk of app-harness.ts: the sidebar shows it while nothing is selected and About is
// on, so closing an item leaves the sidebar open; it is written as the `%% @flowchart`
// block under the header.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartEvents, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/about/flow.mmd';
const BASE = `flowchart TD
    collect[Collect data] --> clean{Clean?}

%% @collect
%% Pull the raw exports from the warehouse.
`;

async function start(text = BASE) {
  const disk = new FakeDisk();
  disk.files.set(FILE, text);
  return { disk, ui: await startApp(disk, FILE) };
}

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const sidebar = () => q<HTMLElement>('.sidebar')!;
const aboutButton = () => q<HTMLButtonElement>('[data-act="about"]')!;
const kind = () => q('.sidebar .side-head .kind')?.textContent ?? null;
const shownName = () => q('.sidebar .read-title')?.textContent ?? null;
const body = () => q('.sidebar .desc-body')?.textContent?.trim() ?? null;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.sidebar button')].find((b) => b.textContent === label && !b.hidden) ?? null;
const select = (target: unknown) => chartEvents.last!.onSelect(target as never);
/** Writes `text` as the flowchart's description: Edit, type, Done. */
function write(text: string) {
  button('Edit')!.click();
  const area = q<HTMLTextAreaElement>('.sidebar .desc-edit')!;
  area.value = text;
  button('Done')!.click();
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('About on (the start)', () => {
  it('shows the flowchart\'s description while nothing is selected', async () => {
    await start();
    expect(aboutButton().getAttribute('aria-pressed')).toBe('true');
    expect(sidebar().hidden).toBe(false);
    expect(kind()).toBe('About this flowchart');
    expect(shownName()).toBe('flow.mmd');
    expect(body()).toBe('No description yet. Double-click here to write one.');
  });

  it('names the flowchart by its front matter\'s title, else by the file\'s name', async () => {
    await start(`---\ntitle: "Nightly jobs"\n---\n${BASE}`);
    expect(shownName()).toBe('Nightly jobs');
  });

  it('shows a description an agent wrote, wherever its block is', async () => {
    await start(`${BASE}\n%% @flowchart\n%% How the **nightly** data gets in.\n`);
    expect(body()).toBe('How the nightly data gets in.');
    expect(q('.sidebar .desc-body strong')!.textContent).toBe('nightly');
  });

  it('an item\'s details show over it, and closing them shows it again: the sidebar never hides', async () => {
    await start();
    select({ kind: 'node', id: 'collect' });
    expect(kind()).toBe('Node');
    expect(sidebar().hidden).toBe(false);
    q<HTMLButtonElement>('.sidebar .close')!.click(); // the node's ×
    expect(sidebar().hidden).toBe(false);
    expect(kind()).toBe('About this flowchart');
    select({ kind: 'edge', index: 0 });
    expect(kind()).toBe('Arrow');
    select(null); // a click on empty space
    expect(kind()).toBe('About this flowchart');
  });
});

describe('About off', () => {
  it('the button and the description\'s × hide it: the sidebar then works as before', async () => {
    await start();
    q<HTMLButtonElement>('.sidebar .close')!.click(); // the description's ×
    expect(aboutButton().getAttribute('aria-pressed')).toBe('false');
    expect(sidebar().hidden).toBe(true);
    select({ kind: 'node', id: 'collect' });
    expect(kind()).toBe('Node');
    select(null);
    expect(sidebar().hidden).toBe(true);
    aboutButton().click();
    expect(aboutButton().getAttribute('aria-pressed')).toBe('true');
    expect(kind()).toBe('About this flowchart');
    aboutButton().click();
    expect(sidebar().hidden).toBe(true);
  });

  it('is kept by the app for the next start', async () => {
    await start();
    aboutButton().click();
    stopApps();
    await start();
    expect(aboutButton().getAttribute('aria-pressed')).toBe('false');
    expect(sidebar().hidden).toBe(true);
  });
});

describe('writing the flowchart\'s description', () => {
  it('Done writes it under the header line, and Undo takes it back', async () => {
    const { disk, ui } = await start();
    write('The nightly import.\n\nRuns at 2:00.');
    await vi.waitFor(() => expect(disk.files.get(FILE)).toBe(BASE.replace('flowchart TD\n',
      'flowchart TD\n%% @flowchart\n%% The nightly import.\n%% .\n%% Runs at 2:00.\n')));
    expect(body()).toBe('The nightly import.\nRuns at 2:00.');
    ui.undo();
    await vi.waitFor(() => expect(disk.files.get(FILE)).toBe(BASE));
    expect(body()).toBe('No description yet. Double-click here to write one.');
  });

  it('what is typed is written when an item is selected over it, as for a node\'s', async () => {
    const { disk } = await start();
    button('Edit')!.click();
    q<HTMLTextAreaElement>('.sidebar .desc-edit')!.value = 'Typed, no Done.';
    select({ kind: 'node', id: 'collect' });
    await vi.waitFor(() => expect(disk.files.get(FILE)).toContain('%% @flowchart\n%% Typed, no Done.\n'));
  });

  it('what is typed stays in its box when empty space is clicked: the panel is the same', async () => {
    const { disk } = await start();
    button('Edit')!.click();
    q<HTMLTextAreaElement>('.sidebar .desc-edit')!.value = 'Still typing';
    select(null);
    expect(q<HTMLTextAreaElement>('.sidebar .desc-edit')!.hidden).toBe(false);
    expect(q<HTMLTextAreaElement>('.sidebar .desc-edit')!.value).toBe('Still typing');
    expect(disk.files.get(FILE)).toBe(BASE);
  });

  it('what is typed is written when About is turned off', async () => {
    const { disk } = await start();
    button('Edit')!.click();
    q<HTMLTextAreaElement>('.sidebar .desc-edit')!.value = 'Typed, then hidden.';
    aboutButton().click();
    await vi.waitFor(() => expect(disk.files.get(FILE)).toContain('%% @flowchart\n%% Typed, then hidden.\n'));
  });

  it('a description that cannot be written goes back into its box', async () => {
    const { disk, ui } = await start();
    ui.type('flowchart TD\n    collect[Collect data] -->\n'); // a syntax error: no edit is made
    await vi.waitFor(() => expect(ui.status()).not.toBe(''));
    write('Not now.');
    await vi.waitFor(() => expect(q<HTMLTextAreaElement>('.sidebar .desc-edit')!.hidden).toBe(false));
    expect(q<HTMLTextAreaElement>('.sidebar .desc-edit')!.value).toBe('Not now.');
    expect(disk.files.get(FILE)).not.toContain('@flowchart');
  });
});

describe('View mode', () => {
  it('shows it as text, with no Edit; About stays in the toolbar', async () => {
    await start(`${BASE}\n%% @flowchart\n%% Read me.\n`);
    q<HTMLButtonElement>('[data-act="view"]')!.click();
    await vi.waitFor(() => expect(q('[data-act="view"]')!.getAttribute('aria-pressed')).toBe('true'));
    expect(kind()).toBe('About this flowchart');
    expect(body()).toBe('Read me.');
    expect(button('Edit')).toBeNull();
    expect(q('.sidebar textarea')).toBeNull();
    expect(aboutButton().hidden).toBe(false);
  });
});
