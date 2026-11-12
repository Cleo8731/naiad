// @vitest-environment jsdom
// Saving, and changes made to the file from outside while the person works: the real
// app against a disk whose timing the test controls (tests/app-harness.ts). Each test
// is a break found by the bug hunt (agent C, round 1), named by its finding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartTiming, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

// A checked edit that takes a while, when a test sets `timing.delay` (ms); otherwise the real one.
const timing = vi.hoisted(() => ({ delay: 0 }));
vi.mock('../src/verify', async (original) => {
  const real = await original<typeof import('../src/verify')>();
  return {
    ...real,
    applyChecked: async (...args: Parameters<typeof real.applyChecked>) => {
      if (timing.delay) await new Promise((r) => setTimeout(r, timing.delay));
      return real.applyChecked(...args);
    },
  };
});

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
    disk.answer = true; // Undo asks before it takes back the change on disk (C3)
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

  /** Closes the window, typing `late` into the text pane while the close's save reads the file. */
  async function closeTypingDuringRead(disk: FakeDisk, ui: Awaited<ReturnType<typeof start>>['ui'], late: string) {
    let reading!: () => void;
    let release!: () => void;
    const read = new Promise<void>((r) => { reading = r; });
    disk.afterRead = () => { disk.afterRead = null; reading(); return new Promise<void>((r) => { release = r; }); };
    const closing = disk.closeGuard!();
    await read;
    ui.type(late);
    release();
    return closing;
  }

  it('C43: text typed while closing reads the file is saved too (bug hunt round 5)', async () => {
    const { disk, ui } = await start();
    const late = TYPED + '    late[Typed while closing]\n';
    ui.type(TYPED);
    expect(await closeTypingDuringRead(disk, ui, late)).toBe(true);
    expect(disk.files.get(FILE)).toBe(late);
    expect(disk.asked).toEqual([]);
  });

  it('C43: and typing that cannot be saved then is asked about, and stays on No', async () => {
    const { disk, ui } = await start();
    ui.type(TYPED);
    expect(await closeTypingDuringRead(disk, ui, BROKEN)).toBe(false);
    expect(disk.asked).toEqual(['flow.mmd holds a change that is not saved (Mermaid cannot read the text). Close Naiad and lose it?']);
    expect(ui.area().value).toBe(BROKEN);
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

describe('Undo asks before it takes back a change made on disk (bug hunt C3)', () => {
  const AGENT = BASE + '\n%% agent\n';
  const QUESTION = /^The last change to flow\.mmd was made on disk, by an agent or another program\. Undo takes it back and saves your earlier version over it; Redo brings it back\. Undo it\?$/;

  /** The person's chart edit is waiting to be saved when the agent's write is taken in. */
  async function displaced() {
    const s = await start();
    s.ui.direction('LR');
    await s.ui.until((t) => t.startsWith('flowchart LR'));
    s.disk.outside(FILE, AGENT); // lands inside the 350 ms wait: the person's edit goes to Undo
    await sleep(600);
    return s;
  }

  it('C3: Undo right after the disk\'s version was taken asks, and No keeps the agent\'s change', async () => {
    const { disk, ui } = await displaced();
    const toast = ui.toast();
    ui.undo();
    await sleep(800);
    expect(disk.files.get(FILE)).toBe(AGENT);
    expect(ui.area().value).toBe(AGENT);
    expect(disk.asked).toHaveLength(1);
    expect(disk.asked[0]).toMatch(QUESTION);
    expect(ui.undoEnabled()).toBe(true);
    expect(toast).toMatch(/Undo brings it back, in place of the change on disk\.$/);
  });

  it('Yes brings the person\'s edit back over it, and Redo brings the agent\'s change back', async () => {
    const { disk, ui } = await displaced();
    disk.answer = true;
    ui.undo();
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
    await sleep(800);
    expect(disk.files.get(FILE)).toBe(BASE.replace('flowchart TD', 'flowchart LR'));
    ui.redo();
    expect(await ui.until((t) => t === AGENT)).toBe(true);
    await sleep(800);
    expect(disk.files.get(FILE)).toBe(AGENT);
    // Taking it back a second time asks again.
    ui.undo();
    await sleep(300);
    expect(disk.asked).toHaveLength(2);
  });

  it('Undo of a change on disk asks even when nothing was unsaved', async () => {
    const { disk, ui } = await start();
    disk.outside(FILE, AGENT);
    expect(await ui.until((t) => t === AGENT)).toBe(true);
    ui.undo();
    await sleep(600);
    expect(disk.asked).toHaveLength(1);
    expect(disk.files.get(FILE)).toBe(AGENT);
  });

  it('Undo of the person\'s own edits asks nothing', async () => {
    const { disk, ui } = await start();
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    ui.direction('RL');
    await ui.until((t) => t.startsWith('flowchart RL'));
    ui.undo();
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
    await sleep(800);
    expect(disk.asked).toEqual([]);
    expect(disk.files.get(FILE)).toMatch(/^flowchart LR/);
  });
});

describe('a program that writes the file in two steps is not cut in on (bug hunt C19)', () => {
  // The first step closes the file; the second adds the rest (`echo a > f; echo b >> f`).
  const FIRST = BASE + '    train --> report[Report]\n';
  const REST = '\n%% @report\n%% Written by the agent in a second step.\n';

  /** Writes FIRST, then appends REST to whatever the file holds `gap` ms later. */
  function twoSteps(disk: FakeDisk, gap: number) {
    disk.outside(FILE, FIRST);
    setTimeout(() => disk.outside(FILE, disk.files.get(FILE)! + REST), gap);
  }

  it('C19: a chart edit made between the two steps is not saved in between, so the halves are never joined', async () => {
    const { disk, ui } = await start();
    twoSteps(disk, 500);
    expect(await ui.until((t) => t === FIRST)).toBe(true);
    ui.direction('LR'); // saved 350 ms later without the fix: before the second step
    await sleep(1600);
    expect(disk.files.get(FILE)).toBe(FIRST + REST);
    expect(ui.area().value).toBe(FIRST + REST);
    expect(ui.toast()).toMatch(/Undo brings it back/);
  });

  it('an edit made a second after the change on disk is saved as usual', async () => {
    const { disk, ui } = await start();
    disk.outside(FILE, FIRST);
    expect(await ui.until((t) => t === FIRST)).toBe(true);
    await sleep(1000);
    ui.direction('LR');
    await sleep(500);
    expect(disk.files.get(FILE)).toBe(FIRST.replace('flowchart TD', 'flowchart LR'));
  });
});

describe('a Markdown flowchart block that disappears and comes back (bug hunt C5)', () => {
  const NOTES = 'C:/hunt/back.md';
  const DOC = '# Notes\n\n```mermaid\nflowchart TD\n    a[A] --> b[B]\n```\n\nAfter.\n';
  const WITHOUT = '# Notes\n\nAfter.\n';

  async function goneThenBack(back: string) {
    const disk = new FakeDisk();
    disk.files.set(NOTES, DOC);
    const ui = await startApp(disk, NOTES);
    disk.outside(NOTES, WITHOUT);
    await sleep(300);
    expect(ui.area().readOnly).toBe(true);
    expect(ui.status()).toMatch(/cannot be found/);
    disk.outside(NOTES, back);
    await sleep(300);
    return { disk, ui };
  }

  it('C5: back exactly as it was, it can be changed again', async () => {
    const { disk, ui } = await goneThenBack(DOC);
    expect(ui.area().readOnly).toBe(false);
    expect(ui.status()).not.toMatch(/cannot be found/);
    ui.direction('LR');
    await sleep(1500); // a second's wait after a change on disk (C19), then the save
    expect(disk.files.get(NOTES)).toBe(DOC.replace('flowchart TD', 'flowchart LR'));
  });

  it('back with other text around it, it can be changed again', async () => {
    const { ui } = await goneThenBack(DOC.replace('After.', 'After, changed.'));
    expect(ui.area().readOnly).toBe(false);
    expect(ui.status()).not.toMatch(/cannot be found/);
  });
});

describe('a copy of the shown Markdown block written above it (bug hunt round 2: B8)', () => {
  const NOTES = 'C:/hunt/copy.md';
  const CHART = '```mermaid\nflowchart TD\n    a[A] --> b[B]\n```\n';
  const DOC = '# Original\n\n' + CHART + '\nend\n';

  async function copied(copy: string) {
    const disk = new FakeDisk();
    disk.files.set(NOTES, DOC);
    const ui = await startApp(disk, NOTES);
    disk.outside(NOTES, copy);
    await sleep(500);
    return { disk, ui };
  }

  it('B8: under its own heading, the edit goes to the block that was shown, not the copy', async () => {
    const copy = '# Variant (copy)\n\n' + CHART + '\n' + DOC;
    const { disk, ui } = await copied(copy);
    ui.direction('LR');
    await sleep(1800); // a second's wait after a change on disk (C19), then the save
    expect(disk.files.get(NOTES)).toBe('# Variant (copy)\n\n' + CHART + '\n' + DOC.replace('flowchart TD', 'flowchart LR'));
  }, 10000);

  it('right beside it, nothing to tell them apart: changed nowhere, and the person is told', async () => {
    const copy = '# Original\n\n' + CHART + '\n' + CHART + '\nend\n';
    const { disk, ui } = await copied(copy);
    expect(ui.area().readOnly).toBe(true);
    expect(ui.status()).toMatch(/cannot be found/);
    ui.direction('LR');
    await sleep(1800);
    expect(disk.files.get(NOTES)).toBe(copy);
  }, 10000);
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
    // A key press reaches the page's handler from the element in focus (the page itself here).
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true, bubbles: true }));
    await sleep(300);
    expect(ui.toast()).toMatch(/can be shown but not changed here/);
    expect(disk.files.get(NOTES)).toBe(UNCLOSED);
    // The agent puts the fence back; Undo now walks back to the person's edit.
    disk.outside(NOTES, CLOSED);
    await sleep(600);
    expect(ui.area().readOnly).toBe(false);
    disk.answer = true; // each step back over a change on disk asks (C3)
    const seen: string[] = [];
    for (let i = 0; i < 5 && ui.undoEnabled(); i++) { ui.undo(); await sleep(150); seen.push(ui.area().value); }
    expect(seen.some((t) => t.startsWith('flowchart LR'))).toBe(true);
  });
});

describe('leaving a flowchart asks before an edit is lost (bug hunt S19: C10)', () => {
  const AGENT = BASE + '\n%% agent\n';
  const SHOWN_OTHER = 'flowchart LR\n    o[O]\n';

  /** A chart edit waiting to be saved when the agent's write lands; the watcher has not fired yet. */
  async function displaced() {
    const s = await start();
    s.disk.watchDelay = 2000;
    s.ui.direction('LR');
    await s.ui.until((t) => t.startsWith('flowchart LR'));
    s.disk.outside(FILE, AGENT);
    return s;
  }

  it('C10: Open right after a change on disk displaced the edit asks, and No keeps the edit in Undo', async () => {
    const { disk, ui } = await displaced();
    disk.answer = false;
    await ui.app.open(OTHER);
    expect(disk.asked).toHaveLength(1);
    expect(disk.asked[0]).toMatch(/^Your last edit to flow\.mmd was not written: the file changed on disk first\..*Open other\.mmd and lose it\?$/);
    expect(ui.area().value).toBe(AGENT);
    expect(ui.undoEnabled()).toBe(true);
    disk.answer = true; // Undo asks before it takes back the change on disk (C3)
    ui.undo();
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
  });

  it('C10: and Yes opens the other file', async () => {
    const { disk, ui } = await displaced();
    disk.answer = true;
    await ui.app.open(OTHER);
    expect(disk.asked).toHaveLength(1);
    expect(ui.area().value).toBe(SHOWN_OTHER);
    expect(disk.files.get(FILE)).toBe(AGENT);
  });

  it('Open while the text holds a change Mermaid cannot read asks first', async () => {
    const { disk, ui } = await start();
    ui.type(BROKEN);
    await sleep(400);
    await ui.app.open(OTHER);
    expect(disk.asked).toEqual(['flow.mmd holds a change that is not saved (Mermaid cannot read the text). Open other.mmd and lose it?']);
    expect(ui.area().value).toBe(BROKEN);
    expect(disk.files.get(FILE)).toBe(BASE);
  });

  it('Open with nothing unsaved asks nothing', async () => {
    const { disk, ui } = await start();
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    await ui.app.open(OTHER);
    expect(disk.asked).toEqual([]);
    expect(ui.area().value).toBe(SHOWN_OTHER);
    expect(disk.files.get(FILE)).toMatch(/^flowchart LR/);
  });

  it('closing right after a change on disk displaced the edit asks', async () => {
    const { disk } = await displaced();
    disk.answer = false;
    await expect(disk.closeGuard!()).resolves.toBe(false);
    expect(disk.asked[0]).toMatch(/^Your last edit to flow\.mmd was not written: .*Close Naiad and lose it\?$/);
  });
});

describe('showing another flowchart of a Markdown file asks before an edit is lost (bug hunt S19)', () => {
  const NOTES = 'C:/hunt/two.md';
  const DOC = '# Two\n\n```mermaid\nflowchart TD\n    a[A] --> b[B]\n```\n\n```mermaid\nflowchart TD\n    x[X] --> y[Y]\n```\n';
  const AGENT = DOC.replace('    a[A] --> b[B]\n', '    a[A] --> b[B]\n    %% agent\n');

  async function displacedThenPick(answer: boolean) {
    const disk = new FakeDisk();
    disk.files.set(NOTES, DOC);
    const ui = await startApp(disk, NOTES);
    disk.watchDelay = 2000;
    disk.answer = answer;
    ui.direction('LR');
    await ui.until((t) => t.startsWith('flowchart LR'));
    disk.outside(NOTES, AGENT);
    const pick = document.querySelector<HTMLSelectElement>('[data-act="block"]')!;
    pick.value = '1';
    pick.dispatchEvent(new Event('change'));
    await sleep(500);
    return { disk, ui };
  }

  it('No keeps the flowchart shown and the edit in Undo', async () => {
    const { disk, ui } = await displacedThenPick(false);
    expect(disk.asked).toHaveLength(1);
    expect(disk.asked[0]).toMatch(/^Your last edit to two\.md was not written: .*Show another flowchart and lose it\?$/);
    expect(ui.area().value).toContain('%% agent');
    disk.answer = true; // Undo asks before it takes back the change on disk (C3)
    ui.undo();
    expect(await ui.until((t) => t.startsWith('flowchart LR'))).toBe(true);
  });

  it('Yes shows the other flowchart, and the file keeps the agent\'s change', async () => {
    const { disk, ui } = await displacedThenPick(true);
    expect(disk.asked).toHaveLength(1);
    expect(ui.area().value).toBe('flowchart TD\n    x[X] --> y[Y]\n');
    expect(disk.files.get(NOTES)).toBe(AGENT);
  });
});

describe('text typed while a change on disk is being taken in is kept (bug hunt round 2: C25)', () => {
  const AGENT = BASE + '\n%% agent\n';
  const LINE = 'typed[Typed by the person]';

  /** Everything the person could see of their typing: the pane, the file, and each step of Undo. */
  async function seenThroughUndo(disk: FakeDisk, ui: Awaited<ReturnType<typeof start>>['ui'], steps: number) {
    const seen = [ui.area().value, disk.files.get(FILE)!];
    disk.answer = true;
    for (let i = 0; i < steps && ui.undoEnabled(); i++) { ui.undo(); await sleep(150); seen.push(ui.area().value); }
    return seen;
  }

  it('C25: typing while the file is read is not written over by the reload', async () => {
    const { disk, ui } = await start();
    disk.afterRead = async () => { await sleep(250); };
    disk.outside(FILE, AGENT); // seen 70 ms later; the reload's read takes 250 ms
    await sleep(150);
    ui.type(BASE + `    ${LINE}\n`);
    await sleep(1500);
    expect(ui.area().value).toContain('%% agent');
    expect(ui.toast()).toMatch(/Undo brings it back/);
    expect((await seenThroughUndo(disk, ui, 4)).some((t) => t.includes(LINE))).toBe(true);
  });

  it('C25: typing while the reload waits behind a drawing is not written over', async () => {
    const { disk, ui } = await start();
    chartTiming.drawDelay = 400;
    ui.direction('LR'); // draws for 400 ms
    await sleep(30);
    disk.outside(FILE, AGENT); // the reload waits behind the drawing
    await sleep(300);
    ui.type(ui.area().value + `    ${LINE}\n`);
    await sleep(2500);
    expect((await seenThroughUndo(disk, ui, 5)).some((t) => t.includes(LINE))).toBe(true);
  });
});

describe('the sidebar never puts back a value a change on disk replaced (bug hunt round 2: C26)', () => {
  const select = (ui: Awaited<ReturnType<typeof start>>['ui'], id: string) =>
    (ui.app as unknown as { select(t: unknown): void }).select({ kind: 'node', id });

  it('C26: a title box left untouched does not put the old title back when focus leaves', async () => {
    const { disk, ui } = await start();
    select(ui, 'collect');
    await sleep(50);
    const input = document.querySelector<HTMLInputElement>('input.title')!;
    expect(input.value).toBe('Collect data');
    input.focus();
    disk.outside(FILE, BASE.replace('collect[Collect data]', 'collect[Gather data]'));
    await sleep(500);
    expect(input.value).toBe('Gather data'); // an untouched box follows the file
    input.blur();
    await sleep(1000);
    expect(disk.files.get(FILE)).toContain('collect[Gather data]');
    expect(ui.area().value).toContain('collect[Gather data]');
  });

  it('a title the person typed is still saved when the file changed meanwhile', async () => {
    const { disk, ui } = await start();
    select(ui, 'collect');
    await sleep(50);
    const input = document.querySelector<HTMLInputElement>('input.title')!;
    input.focus();
    input.value = 'Collect everything';
    disk.outside(FILE, BASE.replace('collect[Collect data]', 'collect[Gather data]'));
    await sleep(500);
    expect(input.value).toBe('Collect everything'); // what is typed stays
    input.blur();
    expect(await ui.until((t) => t.includes('collect[Collect everything]'))).toBe(true);
  });

  it('C26: Done on a description left untouched does not put the old text back', async () => {
    const { disk, ui } = await start();
    select(ui, 'collect');
    await sleep(50);
    document.querySelector<HTMLButtonElement>('.desc-head button:not(.primary):not([title="Esc"])')!.click(); // Edit
    const area = document.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!;
    expect(area.hidden).toBe(false);
    disk.outside(FILE, BASE.replace('%% Pull the raw exports from the warehouse.', '%% The agent wrote this instead.'));
    await sleep(500);
    expect(area.value).toBe('The agent wrote this instead.'); // an untouched description follows the file
    document.querySelector<HTMLButtonElement>('.desc-head button.primary')!.click(); // Done
    await sleep(1000);
    expect(disk.files.get(FILE)).toContain('The agent wrote this instead.');
    expect(disk.files.get(FILE)).not.toContain('Pull the raw exports');
  });
});

describe('a description being written is saved when the person leaves it (bug hunt round 3: C36)', () => {
  const select = (ui: Awaited<ReturnType<typeof start>>['ui'], target: unknown) =>
    (ui.app as unknown as { select(t: unknown): void }).select(target);
  const DRAFT = 'A long description the person typed and has not finished.';
  async function writing(ui: Awaited<ReturnType<typeof start>>['ui']) {
    select(ui, { kind: 'node', id: 'collect' });
    await sleep(50);
    document.querySelector<HTMLButtonElement>('.desc-head button:not(.primary):not([title="Esc"])')!.click(); // Edit
    const area = document.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!;
    area.value = DRAFT;
    area.dispatchEvent(new Event('input'));
  }

  it('C36: another node is clicked: the description is written', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    select(ui, { kind: 'node', id: 'clean' });
    expect(await ui.until((t) => t.includes(`%% ${DRAFT}`))).toBe(true);
    await sleep(800);
    expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
    expect(disk.files.get(FILE)).not.toContain('Pull the raw exports');
  });

  it('C36: the panel is closed: the description is written', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    select(ui, null);
    expect(await ui.until((t) => t.includes(`%% ${DRAFT}`))).toBe(true);
    await sleep(800);
    expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
  });

  it('C36: the window is closed: the description is written before it closes', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    expect(await disk.closeGuard!()).toBe(true);
    expect(disk.asked).toEqual([]);
    expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
  });

  it('C36: the window is closed while the description cannot be written: Naiad asks', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    ui.type(BROKEN); // Mermaid cannot read the text, so no edit can be made
    await sleep(400);
    disk.answer = false;
    expect(await disk.closeGuard!()).toBe(false);
    expect(disk.asked.some((q) => /description/.test(q))).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!.value).toBe(DRAFT); // still there to copy
  });

  it('C36: a node is added: the description is written before the new node takes the panel', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    await (ui.app as unknown as { addNode(p: string | null): Promise<void> }).addNode(null);
    await sleep(800);
    expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
    expect(disk.files.get(FILE)).toContain('New node');
  });

  it('Cancel still drops the description being written', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    document.querySelector<HTMLButtonElement>('.desc-head button[title="Esc"]')!.click(); // Cancel
    select(ui, { kind: 'node', id: 'clean' });
    await sleep(800);
    expect(disk.files.get(FILE)).toContain('Pull the raw exports');
    expect(disk.files.get(FILE)).not.toContain(DRAFT);
  });

  // Bug hunt round 4, C40 and oC40: the description could not be written (the text pane
  // holds an error) and went with the panel, unasked.
  const box = () => document.querySelector<HTMLTextAreaElement>('textarea.desc-edit');
  const shown = (ui: Awaited<ReturnType<typeof start>>['ui']) =>
    (ui.app as unknown as { selection: unknown }).selection;

  it('C40: another node is clicked while the description cannot be written: Naiad asks, and it comes back', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    ui.type(BROKEN);
    await sleep(400);
    disk.answer = false; // keep it
    select(ui, { kind: 'node', id: 'clean' });
    await sleep(800);
    expect(disk.asked.some((q) => /description/.test(q) && /Collect data/.test(q))).toBe(true);
    expect(shown(ui)).toEqual({ kind: 'node', id: 'collect' });
    expect(box()!.hidden).toBe(false);
    expect(box()!.value).toBe(DRAFT);
  });

  it('C40: the panel is closed while the description cannot be written: Naiad asks, and it can be let go', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    ui.type(BROKEN);
    await sleep(400);
    disk.answer = true; // lose it
    select(ui, null);
    await sleep(800);
    expect(disk.asked.some((q) => /description/.test(q))).toBe(true);
    expect(shown(ui)).toBe(null);
    expect(disk.files.get(FILE)).not.toContain(DRAFT);
  });

  it('C40: Done while the description cannot be written: it stays in its box', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    ui.type(BROKEN);
    await sleep(400);
    document.querySelector<HTMLButtonElement>('.desc-head button.primary')!.click(); // Done
    await sleep(800);
    expect(disk.asked).toEqual([]);
    expect(box()!.hidden).toBe(false);
    expect(box()!.value).toBe(DRAFT);
  });

  it('C41: text typed while closing writes the description is written too', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    timing.delay = 300; // each checked edit takes a while
    try {
      const closing = disk.closeGuard!();
      await sleep(100);
      box()!.value = `${DRAFT} And more.`;
      box()!.dispatchEvent(new Event('input'));
      expect(await closing).toBe(true);
      expect(disk.files.get(FILE)).toContain(`%% ${DRAFT} And more.`);
    } finally {
      timing.delay = 0;
    }
  });

  // Bug hunt round 5, C42: Edit pressed again while Done's write was still being checked
  // showed the old description, and when the write failed the description was lost.
  const done = () => document.querySelector<HTMLButtonElement>('.desc-head button.primary')!.click();
  const edit = () => document.querySelector<HTMLButtonElement>('.desc-head button:not(.primary):not([title="Esc"])')!.click();

  it('C42: Edit pressed again while a Done that cannot be written is checked: the description comes back', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    ui.type(BROKEN);
    await sleep(400);
    timing.delay = 300;
    try {
      done();
      edit();
      expect(box()!.value).toBe(DRAFT); // what Done is writing, not the old description
      await sleep(800);
      expect(disk.asked).toEqual([]);
      expect(box()!.hidden).toBe(false);
      expect(box()!.value).toBe(DRAFT);
      ui.type(BASE); // the text pane mended: Done writes it now
      await sleep(400);
      done();
      await sleep(800);
      expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
    } finally {
      timing.delay = 0;
    }
  });

  it('C42: and what is typed into it meanwhile is kept, and written by the next Done', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    ui.type(BROKEN);
    await sleep(400);
    timing.delay = 300;
    try {
      done();
      edit();
      box()!.value = `${DRAFT} And more.`;
      box()!.dispatchEvent(new Event('input'));
      await sleep(800);
      expect(disk.asked).toEqual([]);
      expect(box()!.value).toBe(`${DRAFT} And more.`);
      ui.type(BASE);
      await sleep(400);
      box()!.value = DRAFT; // typed back to what the failed Done held: still not in the file
      box()!.dispatchEvent(new Event('input'));
      done();
      await sleep(800);
      expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
    } finally {
      timing.delay = 0;
    }
  });

  it('C42: Edit pressed again while a Done that can be written is checked shows what Done writes', async () => {
    const { disk, ui } = await start();
    await writing(ui);
    timing.delay = 300;
    try {
      done();
      edit();
      expect(box()!.value).toBe(DRAFT);
      await sleep(800);
      expect(disk.files.get(FILE)).toContain(`%% ${DRAFT}`);
      expect(box()!.value).toBe(DRAFT);
      expect((ui.app as unknown as { sidebar: { draft(): unknown } }).sidebar.draft()).toBe(null); // nothing left to write
    } finally {
      timing.delay = 0;
    }
  });
});
