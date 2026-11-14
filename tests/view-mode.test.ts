// @vitest-environment jsdom
// View mode (D4.3, T1.11) in the real App (src/app.ts), on the fake disk of
// app-harness.ts: reading only, with every way to change the flowchart outside the
// Syntax pane turned off. The chart's own part (handles, gestures) is in chart-ends.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartEvents, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/view/flow.mmd';
const BASE = `flowchart TD
    collect[Collect data] --> clean{Clean?}
    clean -- yes --> train[Train model]
    subgraph prep [Preparation]
        train
    end

%% @collect
%% Pull the raw exports from the warehouse.
`;
const NOTICE = 'View mode: switch to Edit to change the chart';

async function start(text = BASE) {
  const disk = new FakeDisk();
  disk.files.set(FILE, text);
  return { disk, ui: await startApp(disk, FILE) };
}

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const viewButton = () => q<HTMLButtonElement>('[data-act="view"]')!;
const notice = () => q<HTMLElement>('.notice.info .notice-text')?.textContent ?? null;
const select = (ui: Awaited<ReturnType<typeof start>>['ui'], target: unknown) =>
  (ui.app as unknown as { select(t: unknown): void }).select(target);
/** A key pressed on the page, outside any field. */
const press = (key: string, more: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...more });
  document.body.dispatchEvent(e);
  return e;
};
async function toView() {
  viewButton().click();
  await vi.waitFor(() => expect(viewButton().getAttribute('aria-pressed')).toBe('true'));
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); });

describe('the View button (Q115) and the mode remembered (Q114)', () => {
  it('switches to View: pressed, the edit controls gone, the Syntax pane read-only', async () => {
    const { ui } = await start();
    expect(viewButton().getAttribute('aria-pressed')).toBe('false');
    expect(ui.area().readOnly).toBe(false);
    await toView();
    for (const act of ['add', 'undo', 'redo', 'dir']) expect(q<HTMLElement>(`[data-act="${act}"]`)!.hidden).toBe(true);
    for (const act of ['highlight', 'fit', 'syntax', 'view']) expect(q<HTMLElement>(`[data-act="${act}"]`)!.hidden).toBe(false);
    expect(ui.area().readOnly).toBe(true);
    viewButton().click();
    await vi.waitFor(() => expect(viewButton().getAttribute('aria-pressed')).toBe('false'));
    expect(q<HTMLElement>('[data-act="add"]')!.hidden).toBe(false);
    expect(ui.area().readOnly).toBe(false);
  });

  it('Naiad opens in the mode it was last left in; the file never holds it', async () => {
    const { disk } = await start();
    await toView();
    stopApps();
    const again = await startApp(disk, FILE);
    expect(viewButton().getAttribute('aria-pressed')).toBe('true');
    expect(again.area().readOnly).toBe(true);
    expect(q<HTMLElement>('[data-act="add"]')!.hidden).toBe(true);
    viewButton().click();
    await vi.waitFor(() => expect(viewButton().getAttribute('aria-pressed')).toBe('false'));
    stopApps();
    await startApp(disk, FILE);
    expect(viewButton().getAttribute('aria-pressed')).toBe('false');
    expect(disk.files.get(FILE)).toBe(BASE);
    expect(disk.writes).toEqual([]);
  });
});

describe('in View, an edit tried changes nothing and a notice says why (D4.3)', () => {
  it('Delete, Backspace, Ctrl+Z, Ctrl+Y and Enter on a selected node', async () => {
    const { disk, ui } = await start();
    ui.direction('LR'); // an edit, so Undo has something to take back
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
    await sleep(400);
    const before = disk.files.get(FILE);
    const writes = disk.writes.length;
    await toView();
    select(ui, { kind: 'node', id: 'collect' });
    expect(notice()).toBeNull();
    press('Delete');
    expect(notice()).toBe(NOTICE);
    press('Backspace');
    press('z', { ctrlKey: true });
    await sleep(400); // looked at alone: a Redo after it would put the same text back
    expect(disk.files.get(FILE)).toBe(before);
    press('y', { ctrlKey: true });
    press('z', { ctrlKey: true, shiftKey: true });
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(document.activeElement?.matches('input, textarea')).toBeFalsy();
    await sleep(400);
    expect(disk.files.get(FILE)).toBe(before);
    expect(disk.writes.length).toBe(writes);
    expect(ui.area().value).toBe(before);
  });

  it('the chart\'s edits (a connection, a new node, a double-click) change nothing', async () => {
    const { disk } = await start();
    await toView();
    chartEvents.last!.onConnect('collect', 'train');
    chartEvents.last!.onAddNode();
    chartEvents.last!.onMoveEnd(0, 'end', 'train');
    await sleep(400);
    expect(disk.files.get(FILE)).toBe(BASE);
    expect(disk.writes).toEqual([]);
    expect(notice()).toBe(NOTICE);
  });

  it('the chart\'s double-click or Shift-click in View shows the notice (onBlocked)', async () => {
    await start();
    await toView();
    chartEvents.last!.onBlocked();
    expect(notice()).toBe(NOTICE);
  });

  it('typing in the read-only Syntax pane shows the notice; Tab inserts nothing', async () => {
    const { ui } = await start();
    await toView();
    const area = ui.area();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    area.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(area.value).toBe(BASE);
    expect(notice()).toBeNull();
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    expect(notice()).toBe(NOTICE);
  });

  it('the notice goes after 6.5 seconds, and its Edit button switches back', async () => {
    const { ui } = await start();
    await toView();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      chartEvents.last!.onBlocked();
      vi.advanceTimersByTime(6499);
      expect(notice()).toBe(NOTICE);
      vi.advanceTimersByTime(1);
      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    chartEvents.last!.onBlocked();
    const edit = [...document.querySelectorAll<HTMLButtonElement>('.notice.info button')].find((b) => b.textContent === 'Edit')!;
    edit.click();
    await vi.waitFor(() => expect(viewButton().getAttribute('aria-pressed')).toBe('false'));
    expect(notice()).toBeNull();
    expect(ui.area().readOnly).toBe(false);
  });

  it('the bare "%%" notice keeps its text and loses its button, which changes the file', async () => {
    await start('flowchart TD\n%%\n    a --> b\n');
    const warn = () => q<HTMLElement>('.notice.warn')!;
    expect(warn().querySelectorAll('button').length).toBe(1);
    await toView();
    expect(warn().querySelector('.notice-text')!.textContent).toMatch(/bare "%%"/);
    expect(warn().querySelectorAll('button').length).toBe(0);
  });
});

describe('in View, the sidebar shows the item as text, with no fields', () => {
  const fields = () => document.querySelectorAll('.sidebar input, .sidebar textarea, .sidebar select').length;
  const buttons = () => [...document.querySelectorAll('.sidebar button')].map((b) => b.getAttribute('aria-label'));

  it('a node: its title and description', async () => {
    const { ui } = await start();
    await toView();
    select(ui, { kind: 'node', id: 'collect' });
    expect(q('.sidebar .read-title')!.textContent).toBe('Collect data');
    expect(q('.sidebar .desc-body')!.textContent).toContain('Pull the raw exports from the warehouse.');
    expect(fields()).toBe(0);
    expect(buttons()).toEqual(['Close']);
    select(ui, { kind: 'node', id: 'clean' });
    expect(q('.sidebar .desc-body')!.textContent).toBe('No description.');
  });

  it('an arrow: its ends and label; a group: its title and size', async () => {
    const { ui } = await start();
    await toView();
    select(ui, { kind: 'edge', index: 1 });
    expect(q('.sidebar .ends')!.textContent).toBe('Clean?→Train model');
    expect(q('.sidebar .read-title')!.textContent).toBe('yes');
    expect(fields()).toBe(0);
    expect(buttons()).toEqual(['Close']);
    select(ui, { kind: 'sub', id: 'prep' });
    expect(q('.sidebar .read-title')!.textContent).toBe('Preparation');
    expect(q('.sidebar .hint')!.textContent).toBe('1 item inside.');
    expect(fields()).toBe(0);
    expect(buttons()).toEqual(['Close']);
  });

  it('switching modes builds the panel again, with its fields back in Edit', async () => {
    const { ui } = await start();
    select(ui, { kind: 'node', id: 'collect' });
    expect(fields()).toBeGreaterThan(0);
    await toView();
    expect(fields()).toBe(0);
    viewButton().click();
    await vi.waitFor(() => expect(fields()).toBeGreaterThan(0));
    expect(q<HTMLInputElement>('.sidebar input.title')!.value).toBe('Collect data');
  });

  it('the text follows a change on disk', async () => {
    const { disk, ui } = await start();
    await toView();
    select(ui, { kind: 'node', id: 'collect' });
    disk.outside(FILE, BASE.replace('Collect data', 'Gather data').replace('the warehouse', 'the lake'));
    await vi.waitFor(() => expect(q('.sidebar .read-title')!.textContent).toBe('Gather data'));
    expect(q('.sidebar .desc-body')!.textContent).toContain('from the lake.');
  });
});

describe('what was typed in the sidebar is written before View starts (C36, Q90)', () => {
  it('a title typed and not entered', async () => {
    const { disk, ui } = await start();
    select(ui, { kind: 'node', id: 'collect' });
    q<HTMLInputElement>('.sidebar input.title')!.value = 'Collect everything';
    await toView();
    await sleep(400);
    expect(disk.files.get(FILE)).toContain('collect[Collect everything]');
  });

  it('a description being written', async () => {
    const { disk, ui } = await start();
    select(ui, { kind: 'node', id: 'collect' });
    document.querySelector<HTMLButtonElement>('.desc-head button:not(.primary):not([title="Esc"])')!.click(); // Edit
    q<HTMLTextAreaElement>('textarea.desc-edit')!.value = 'Pull everything.';
    await toView();
    await sleep(400);
    expect(disk.files.get(FILE)).toContain('%% Pull everything.');
  });

  it('one that cannot be written keeps Naiad in Edit, with the text still in its box', async () => {
    const { disk, ui } = await start();
    select(ui, { kind: 'node', id: 'collect' });
    q<HTMLInputElement>('.sidebar input.title')!.value = 'Collect everything';
    ui.type(BASE + '    c[[[ unfinished\n'); // Mermaid cannot read the text, so no edit can be made
    await sleep(400);
    viewButton().click();
    await vi.waitFor(() => expect(ui.toast()).toMatch(/The title you were typing was not saved, so Naiad stays in Edit mode\./));
    expect(viewButton().getAttribute('aria-pressed')).toBe('false');
    expect(q<HTMLInputElement>('.sidebar input.title')!.value).toBe('Collect everything');
    expect(disk.files.get(FILE)).not.toContain('Collect everything');
  });
});

describe('what stays in View', () => {
  it('Highlight: a click on an item highlights it', async () => {
    const { disk } = await start();
    await toView();
    q<HTMLButtonElement>('[data-act="highlight"]')!.click();
    expect(q('[data-act="highlight"]')!.getAttribute('aria-pressed')).toBe('true');
    chartEvents.last!.onHighlight({ kind: 'node', id: 'clean' });
    await vi.waitFor(() => expect(disk.highlights.get(FILE)).toContain('clean'));
    expect(disk.files.get(FILE)).toBe(BASE);
  });

  it('selecting an item, and Escape letting it go', async () => {
    await start();
    await toView();
    chartEvents.last!.onSelect({ kind: 'node', id: 'collect' });
    expect(q<HTMLElement>('.sidebar')!.hidden).toBe(false);
    press('Escape');
    // The flowchart's description is under it (T1.13), so the sidebar stays.
    expect(q<HTMLElement>('.sidebar')!.hidden).toBe(false);
    expect(q('.sidebar .side-head .kind')!.textContent).toBe('About this flowchart');
    expect(notice()).toBeNull();
  });
});
