// @vitest-environment jsdom
// Saving, and changes made to the file from outside while the person works: the real
// app against a disk whose timing the test controls (tests/app-harness.ts). Each test
// is a break found by the bug hunt (agent C, round 1), named by its finding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartTiming, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/hunt/flow.mmd';
const OTHER = 'C:/hunt/other.mmd';
const BASE = `flowchart TD
    collect[Collect data] --> clean{Clean?}
    clean -- yes --> train[Train model]

%% @collect
%% Pull the raw exports from the warehouse.
`;
const TYPED = BASE.replace('flowchart TD\n', 'flowchart TD\n    typed[Typed by the person]\n');
const BROKEN = BASE + '    c[[[ unfinished\n';

afterEach(() => {
  stopApps();
  chartTiming.drawDelay = 0;
});

async function start(text = BASE) {
  const disk = new FakeDisk();
  disk.files.set(FILE, text);
  disk.files.set(OTHER, 'flowchart LR\n    o[O]\n');
  return { disk, ui: await startApp(disk, FILE) };
}

describe('what was just typed is never lost (bug hunt S16: C1, C12, C13)', () => {
  it('C1: text typed just before an outside change is kept in Undo', async () => {
    const { disk, ui } = await start();
    ui.type(TYPED);
    await sleep(20);
    disk.outside(FILE, BASE + '\n%% agent\n'); // seen 70 ms later, before the text pane's 220 ms wait ends
    await sleep(600);
    expect(ui.area().value).toContain('%% agent');
    expect(ui.toast()).toMatch(/Undo brings it back/);
    ui.undo();
    expect(await ui.until((t) => t.includes('typed[Typed by the person]'))).toBe(true);
  });

  it('C12: Ctrl+S right after typing saves what was typed, even with a syntax error', async () => {
    const { disk, ui } = await start();
    ui.type(BROKEN);
    await sleep(80);
    ui.ctrlS();
    await sleep(300);
    expect(disk.files.get(FILE)).toBe(BROKEN);
  });

  it('a chart edit right after typing keeps what was typed', async () => {
    const { disk, ui } = await start();
    ui.type(TYPED);
    await sleep(20);
    ui.direction('LR');
    await sleep(700);
    expect(disk.files.get(FILE)).toBe(TYPED.replace('flowchart TD', 'flowchart LR'));
  });

  it('Undo right after typing undoes the typing, and Redo brings it back', async () => {
    const { ui } = await start();
    ui.direction('LR'); // so that Undo can be pressed
    await ui.until((t) => t.startsWith('flowchart LR'));
    const edited = ui.area().value;
    ui.type(edited + '    more[More]\n');
    await sleep(20);
    ui.undo();
    expect(await ui.until((t) => t === edited)).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-act="redo"]')!.click();
    expect(await ui.until((t) => t === edited + '    more[More]\n')).toBe(true);
  });

  it('C13: closing the page while a change is not yet on disk asks first', async () => {
    const { ui } = await start();
    const close = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(close()).toBe(false);
    ui.type(TYPED);
    expect(close()).toBe(true); // typed, not yet taken in
    await sleep(800);
    expect(close()).toBe(false); // saved
    ui.type(BROKEN);
    await sleep(800);
    expect(close()).toBe(true); // not saved: a syntax error
  });

  it('C13: closing the window saves what was typed and closes', async () => {
    const { disk, ui } = await start();
    ui.type(TYPED);
    expect(await disk.closeGuard!()).toBe(true);
    expect(disk.files.get(FILE)).toBe(TYPED);
    expect(disk.asked).toEqual([]);
  });

  it('C13: closing the window with a change that cannot be saved asks, and stays open on No', async () => {
    const { disk, ui } = await start();
    ui.type(BROKEN);
    expect(await disk.closeGuard!()).toBe(false);
    expect(disk.asked).toEqual(['flow.mmd holds a change that is not saved (Mermaid cannot read the text). Close Naiad and lose it?']);
    expect(disk.files.get(FILE)).toBe(BASE);
    disk.answer = true;
    expect(await disk.closeGuard!()).toBe(true);
  });
});

describe('a save never overwrites a change made on disk meanwhile (bug hunt S17: C7, C8, C11)', () => {
  const AGENT = BASE + '\n%% agent\n';

  it('C7: a write from outside between the save\'s read and its write is kept', async () => {
    const { disk, ui } = await start();
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    let once = true;
    disk.afterRead = (path) => { if (once) { once = false; disk.outside(path, AGENT); } };
    await sleep(800);
    expect(disk.files.get(FILE)).toBe(AGENT);
    expect(ui.area().value).toBe(AGENT);
    expect(ui.toast()).toMatch(/Undo brings it back/);
  });

  it('C8: with slow reads, a change on disk while a save waits is kept', async () => {
    const { disk, ui } = await start();
    disk.afterRead = () => sleep(200);
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    await sleep(200); // the reload's slow read starts just before the save's
    disk.outside(FILE, AGENT);
    await sleep(1500);
    expect(disk.files.get(FILE)).toBe(AGENT);
    expect(ui.area().value).toBe(AGENT);
  });

  it('C11: two changes on disk in a row end with the second shown, even when the first read is slower', async () => {
    const { disk, ui } = await start();
    let n = 0;
    disk.afterRead = () => (++n === 1 ? sleep(300) : undefined);
    disk.outside(FILE, BASE + '\n%% v1\n');
    await sleep(150);
    disk.outside(FILE, BASE + '\n%% v1\n%% v2\n');
    await sleep(800);
    expect(ui.area().value).toBe(BASE + '\n%% v1\n%% v2\n');
  });

  it('a change on disk and a chart edit that both wait for a drawing are not mixed', async () => {
    const { disk, ui } = await start();
    chartTiming.drawDelay = 150;
    disk.watchDelay = 0;
    ui.direction('LR'); // drawn for 150 ms
    await sleep(20);
    disk.outside(FILE, AGENT); // its reload waits for the drawing
    await sleep(20);
    ui.direction('RL'); // so does this edit
    await sleep(1500);
    // Either order is right (the edit, then the reload; or the reload, then the edit
    // made on it), so long as the agent's line is kept.
    expect(disk.files.get(FILE)).toContain('%% agent');
    expect(ui.area().value).toBe(disk.files.get(FILE));
  });
});

describe('Undo while a Markdown flowchart block is locked (bug hunt S18: C9)', () => {
  const NOTES = 'C:/hunt/notes.md';
  const DOC = '# Notes\n\n```mermaid\nflowchart TD\n    a[A] --> b[B]\n\n%% @a\n%% Desc of A.\n```\n\nAfter.\n';
  const UNCLOSED = DOC.replace('%% Desc of A.\n```\n', '%% Desc of A.\n    b --> c[C]\n');
  const CLOSED = DOC.replace('%% Desc of A.\n```\n', '%% Desc of A.\n    b --> c[C]\n```\n');

  it('C9: Undo pressed while the block is locked is refused, and the edit it would bring back stays in Undo', async () => {
    const disk = new FakeDisk();
    disk.files.set(NOTES, DOC);
    const ui = await startApp(disk, NOTES);
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    // The agent's save leaves the block without its closing fence: Naiad shows it, locked.
    disk.outside(NOTES, UNCLOSED);
    await sleep(600);
    expect(ui.toast()).toMatch(/Undo brings it back/);
    expect(ui.area().readOnly).toBe(true);
    ui.undo(); // as the toast says
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }));
    await sleep(300);
    expect(ui.toast()).toMatch(/can be shown but not changed here/);
    expect(disk.files.get(NOTES)).toBe(UNCLOSED);
    // The agent puts the fence back; Undo now walks back to the person's edit.
    disk.outside(NOTES, CLOSED);
    await sleep(600);
    expect(ui.area().readOnly).toBe(false);
    const seen: string[] = [];
    for (let i = 0; i < 5 && ui.undoEnabled(); i++) { ui.undo(); await sleep(150); seen.push(ui.area().value); }
    expect(seen.some((t) => t.startsWith('flowchart LR'))).toBe(true);
  });
});
