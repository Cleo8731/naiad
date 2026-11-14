// @vitest-environment jsdom
// The Touchpad and Mouse button (D1.5, T1.14), on the real App with the chart stood in
// for (app-harness.ts): Touchpad at the first start, a click switches, and the app keeps
// the choice between runs. What each mode does to a wheel event: trackpad.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chartWheel, FakeDisk, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

describe('the Touchpad and Mouse button', () => {
  const FILE = 'C:/wheel/flow.mmd';
  const button = () => document.querySelector<HTMLButtonElement>('.bar [data-act="wheel"]')!;
  const icon = () => button().querySelector('svg')?.getAttribute('data-icon');
  async function start() {
    const disk = new FakeDisk();
    disk.files.set(FILE, 'flowchart TD\n    a[A] --> b[B]\n');
    return startApp(disk, FILE);
  }

  beforeEach(() => { localStorage.clear(); chartWheel.mode = null; });
  afterEach(() => { stopApps(); localStorage.clear(); });

  test('starts in Touchpad mode the first time, its icon and label saying so', async () => {
    await start();
    expect(chartWheel.mode).toBe('touchpad');
    expect(icon()).toBe('touchpad');
    expect(button().getAttribute('aria-label')).toBe('Touchpad mode');
    expect(button().title).toMatch(/^Touchpad mode: two fingers move the chart, a pinch zooms\. Click for Mouse mode/);
  });

  test('a click switches to Mouse mode and back, and the app keeps the choice', async () => {
    await start();
    button().click();
    expect(chartWheel.mode).toBe('mouse');
    expect(icon()).toBe('mouse');
    expect(button().getAttribute('aria-label')).toBe('Mouse mode');
    expect(button().title).toMatch(/^Mouse mode: the wheel zooms/);
    expect(localStorage.getItem('wheel')).toBe('mouse');
    button().click();
    expect(chartWheel.mode).toBe('touchpad');
    expect(localStorage.getItem('wheel')).toBe('touchpad');
  });

  test('a start after choosing Mouse mode starts in Mouse mode', async () => {
    localStorage.setItem('wheel', 'mouse');
    await start();
    expect(chartWheel.mode).toBe('mouse');
    expect(icon()).toBe('mouse');
  });

  test('the button stays in View mode, where moving around the chart is still wanted', async () => {
    await start();
    document.querySelector<HTMLButtonElement>('.bar [data-act="view"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.bar [data-act="view"]')!.getAttribute('aria-pressed')).toBe('true'));
    expect(button().hidden).toBe(false);
    button().click();
    expect(chartWheel.mode).toBe('mouse');
  });
});
