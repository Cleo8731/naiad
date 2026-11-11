// @vitest-environment jsdom
// Saving, and changes made to the file from outside while the person works: the real
// app against a disk whose timing the test controls (tests/app-harness.ts). Each test
// is a break found by the bug hunt (agent C, round 1), named by its finding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDisk, sleep, startApp, stopApps } from './app-harness';

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

afterEach(stopApps);

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
