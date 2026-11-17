// @vitest-environment jsdom
// T1.24 (the user, 2026-11-16: "pinch to zoom doesn't work in touchpad mode"): WebView2
// passes a touchpad pinch on to the page only when Tauri's `zoomHotkeysEnabled` is on.
// That setting also lets Ctrl+wheel, a pinch and Ctrl with plus, minus or 0 zoom the
// whole window, so in the desktop app the page stops those outside the chart (the chart
// zooms on a pinch itself, src/chart.ts). In a browser, the browser's own zoom is left alone.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '../src/backend';
import { FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const FILE = 'C:/hunt/flow.mmd';
const TEXT = 'flowchart TD\n    a(Start) --> b(End)\n';

async function start(kind: Backend['kind']) {
  const disk = new FakeDisk();
  disk.kind = kind;
  disk.files.set(FILE, TEXT);
  return startApp(disk, FILE);
}

/** A wheel event on `target`, as a pinch (Ctrl set) or as two fingers; whether it was stopped. */
function wheel(target: Element, ctrlKey: boolean): boolean {
  const e = new WheelEvent('wheel', { deltaY: -2, ctrlKey, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

/** A key pressed with or without Ctrl; whether it was stopped. */
function key(name: string, ctrlKey = true): boolean {
  const e = new KeyboardEvent('keydown', { key: name, ctrlKey, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e.defaultPrevented;
}

afterEach(() => stopApps());

describe('a pinch reaches the chart in the desktop app (T1.24)', () => {
  it("the desktop window passes a pinch on to the page (Tauri's zoomHotkeysEnabled)", () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    expect(conf.app.windows.map((w: { zoomHotkeysEnabled?: boolean }) => w.zoomHotkeysEnabled)).toEqual([true]);
  });

  it('a pinch or Ctrl+wheel outside the chart does not zoom the window; two fingers still scroll', async () => {
    await start('desktop');
    for (const where of ['.tabs', '.sidebar', 'textarea']) {
      const el = document.querySelector(where)!;
      expect(wheel(el, true), where).toBe(true);
      expect(wheel(el, false), where).toBe(false);
    }
  });

  it('Ctrl with plus, minus or 0 does not zoom the window; other keys are left alone', async () => {
    await start('desktop');
    for (const name of ['=', '+', '-', '_', '0']) expect(key(name), name).toBe(true);
    expect(key('0', false)).toBe(false);
    expect(key('k')).toBe(false);
  });

  it("in a browser (the dev page, naiad serve), the browser's own zoom is left alone", async () => {
    await start('browser');
    expect(wheel(document.querySelector('.tabs')!, true)).toBe(false);
    for (const name of ['=', '-', '0']) expect(key(name), name).toBe(false);
  });
});
