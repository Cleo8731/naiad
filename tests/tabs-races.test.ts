// @vitest-environment jsdom
// Tabs (T1.16): what the person does in one tab while Naiad waits on another, from the
// bug hunt after the tabs were built (H3 to H6). Each test holds a step of one tab open
// (a read of its file, a checked edit, a highlights write), acts in another, then lets
// the step finish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chartEvents, FakeDisk, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

// A checked edit (`applyChecked`) can be held open: `gate.pause` runs before each one.
const gate = vi.hoisted(() => ({ pause: null as null | (() => Promise<void>) }));
vi.mock('../src/verify', async (original) => {
  const real = await original<typeof import('../src/verify')>();
  return {
    ...real,
    applyChecked: async (...args: Parameters<typeof real.applyChecked>) => {
      if (gate.pause) await gate.pause();
      return real.applyChecked(...args);
    },
  };
});

const A = 'C:/p/a.mmd';
const B = 'C:/p/b.mmd';
const T = 'flowchart TD\n    a[A] --> b[B]\n';

/** A step held open: `hit` resolves when it is reached, `release` lets it go on. */
function hold() {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  const hit = new Promise<void>((r) => { reached = r; });
  return { hit, release, wait: async () => { reached(); await open; } };
}

/** Types into the shown tab's description box, as a person does (the box opens first). */
function typeDescription(text: string): void {
  const view = document.querySelector<HTMLElement>('.tabview:not([hidden])')!;
  view.querySelector<HTMLButtonElement>('.desc-head button:not(.primary):not([title="Esc"])')!.click();
  const box = view.querySelector<HTMLTextAreaElement>('textarea.desc-edit')!;
  box.value = text;
  box.dispatchEvent(new Event('input'));
}

async function twoTabs(kind: FakeDisk['kind'] = 'browser') {
  const disk = new FakeDisk();
  disk.kind = kind;
  disk.files.set(A, T);
  disk.files.set(B, T);
  const ui = await startApp(disk, A);
  await ui.app.open(B);
  return { disk, ui };
}

beforeEach(() => localStorage.clear());
afterEach(() => { stopApps(); localStorage.clear(); gate.pause = null; });

describe('while Naiad waits on one tab, another is changed', () => {
  it('closing the window asks again about a tab typed into after it was looked at (bug hunt H3)', async () => {
    const { disk, ui } = await twoTabs('desktop');
    ui.type(T + '    c[C]\n'); // in b.mmd, to be saved as the window closes
    await sleep(250);
    ui.showTab('a.mmd');
    const read = hold();
    disk.afterRead = async (path) => { if (path === B) await read.wait(); };
    const closing = disk.closeGuard!(); // a.mmd is looked at first, then b.mmd's save reads
    await read.hit;
    const broken = T + '    z[[[ unfinished\n';
    ui.type(broken); // in a.mmd, already looked at
    read.release();
    expect(await closing).toBe(false);
    expect(disk.asked).toEqual([expect.stringContaining('a.mmd holds a change that is not saved')]);
    expect(ui.area().value).toBe(broken);
  });

  it('going to View writes a description typed in a tab after it was looked at (bug hunt H4)', async () => {
    const { disk, ui } = await twoTabs();
    typeDescription('B description');
    ui.showTab('a.mmd');
    const check = hold();
    gate.pause = check.wait;
    document.querySelector<HTMLButtonElement>('[data-act="view"]')!.click(); // a.mmd, then b.mmd
    await check.hit; // b.mmd's description is being checked
    gate.pause = null;
    typeDescription('A description'); // in a.mmd, already looked at
    check.release();
    await vi.waitFor(() => expect(disk.files.get(A)).toContain('A description'));
    expect(disk.files.get(B)).toContain('B description');
    await vi.waitFor(() => expect(document.querySelector('[data-act="view"]')!.textContent!.trim()).toBe('View mode'));
  });

  it('a browser page asks before it goes while About is writing a description (bug hunt H6)', async () => {
    const { disk, ui } = await twoTabs();
    ui.showTab('a.mmd');
    typeDescription('About a'); // the flowchart's description: nothing selected, About on
    ui.showTab('b.mmd');
    const check = hold();
    gate.pause = check.wait;
    document.querySelector<HTMLButtonElement>('[data-act="about"]')!.click(); // About off: a.mmd's is written
    await check.hit;
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    gate.pause = null;
    check.release();
    expect(leaving.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(disk.files.get(A)).toContain('About a'));
  });

  it("a closed tab's highlight write lands before the shell is told its file is no longer shown (bug hunt H5)", async () => {
    const disk = new FakeDisk();
    disk.kind = 'desktop';
    disk.files.set(A, T);
    disk.files.set(B, T);
    const write = hold();
    const make = disk.backend.bind(disk);
    disk.backend = () => {
      const b = make();
      return {
        ...b,
        writeHighlights: async (path, text, expected) => {
          if (path === B) await write.wait();
          return b.writeHighlights(path, text, expected);
        },
        // The shell deletes the highlights file of a flowchart no view shows any more.
        viewing: (paths) => {
          b.viewing(paths);
          for (const p of [A, B]) if (!paths.includes(p)) disk.highlights.delete(p);
        },
      };
    };
    const ui = await startApp(disk, A);
    await ui.app.open(B);
    chartEvents.last!.onHighlight({ kind: 'node', id: 'a' });
    await write.hit;
    const closing = ui.closeTab('b.mmd');
    await sleep(50);
    write.release();
    await closing;
    await vi.waitFor(() => expect(disk.viewed).toEqual([A]));
    expect(ui.tabs()).toEqual(['a.mmd']);
    expect(disk.highlights.get(B) ?? null).toBe(null);
  });
});
