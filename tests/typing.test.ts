// @vitest-environment jsdom
// Text typed while a job of the app is under way is never written over: the real app
// against a disk and a chart whose timing the test controls (tests/app-harness.ts). A
// job that puts in a text from elsewhere (a reload, an edit, Undo) first takes in the
// typing (bug hunt round 2, C25: tests/saving.test.ts); these are the keys pressed after
// that, while the typing just taken in is drawn or while an edit is checked (bug hunt
// round 3, oC1 and oC2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartTiming, FakeDisk, sleep, startApp, stopApps } from './app-harness';

const checkTiming = vi.hoisted(() => ({ delay: 0 }));
vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());
// The checked edit, made slow on demand: Mermaid's reading takes a while on a large chart.
vi.mock('../src/verify', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/verify')>();
  return {
    ...m,
    applyChecked: async (...args: Parameters<typeof m.applyChecked>) => {
      if (checkTiming.delay) await new Promise((r) => setTimeout(r, checkTiming.delay));
      return m.applyChecked(...args);
    },
  };
});

const FILE = 'C:/hunt/flow.mmd';
const BASE = `flowchart TD
    collect[Collect data] --> clean{Clean?}
    clean -- yes --> train[Train model]

%% @collect
%% Pull the raw exports from the warehouse.
`;
const FIRST = BASE + '    first[First typed]\n';
const LINE = 'second[Typed while drawn]';

afterEach(() => {
  stopApps();
  chartTiming.drawDelay = 0;
  checkTiming.delay = 0;
});

async function start() {
  const disk = new FakeDisk();
  disk.files.set(FILE, BASE);
  return { disk, ui: await startApp(disk, FILE) };
}

/** Everything the person could see of their typing: the pane, the file, and each step of Undo. */
async function seenThroughUndo(disk: FakeDisk, ui: Awaited<ReturnType<typeof start>>['ui'], steps: number) {
  const seen = [ui.area().value, disk.files.get(FILE)!];
  disk.answer = true;
  for (let i = 0; i < steps && ui.undoEnabled(); i++) { ui.undo(); await sleep(150); seen.push(ui.area().value); }
  return seen;
}

describe('keys pressed while a job is under way are kept (bug hunt round 3: oC1, oC2)', () => {
  it('oC1: typing while a reload draws the typing it took in is not written over', async () => {
    const { disk, ui } = await start();
    chartTiming.drawDelay = 400;
    disk.afterRead = async () => { await sleep(250); };
    disk.outside(FILE, BASE + '\n%% agent\n'); // seen 70 ms later; the read takes 250 ms
    await sleep(150);
    ui.type(FIRST); // taken in by the reload at about 320 ms, then drawn for 400 ms
    await sleep(250);
    ui.type(FIRST + `    ${LINE}\n`); // while that drawing runs
    await sleep(2500);
    expect(ui.area().value).toContain('%% agent');
    expect((await seenThroughUndo(disk, ui, 6)).some((t) => t.includes(LINE))).toBe(true);
  }, 15000);

  // Undo pressed while earlier typing is drawn; more keys come while the Undo's own
  // take-in is drawn. They come after the press, so the Undo takes them back, as it takes
  // back typing that waited for it (C25), and Redo brings them back. Before the fix they
  // were in no step at all. (Keys pressed while an earlier job draws are already taken
  // in as a step of their own before the Undo, the steps first reported for oC2.)
  it('oC2: typing while Undo draws the typing it took in is kept, and Redo brings it back', async () => {
    const { ui } = await start();
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    await sleep(600);
    chartTiming.drawDelay = 800;
    const edited = ui.area().value;
    const t1 = edited + '    first[First typed]\n';
    const t2 = t1 + '    more[Typed before the Undo ran]\n';
    const t3 = t2 + `    ${LINE}\n`;
    ui.type(t1); // taken in at 220 ms, drawn until about 1020 ms
    await sleep(300);
    ui.undo(); // waits for that drawing; its own job starts at about 1020 ms
    await sleep(610);
    ui.type(t2); // under 220 ms before then: taken in by the Undo, drawn until about 1820 ms
    await sleep(390);
    ui.type(t3); // while that drawing runs
    await sleep(3500);
    ui.redo();
    await sleep(2000);
    expect(ui.area().value).toBe(t3);
  }, 15000);

  it('typing while an edit is checked is kept, and the edit is made on it', async () => {
    const { disk, ui } = await start();
    ui.type(FIRST);
    await sleep(400); // taken in
    checkTiming.delay = 400;
    ui.direction('LR'); // checked for 400 ms
    await sleep(150);
    ui.type(FIRST + `    ${LINE}\n`); // while it is checked
    await sleep(2000);
    expect(ui.area().value).toMatch(/^flowchart LR\n/);
    expect(ui.area().value).toContain(LINE);
    expect(disk.files.get(FILE)).toContain(LINE);
  }, 15000);
});
