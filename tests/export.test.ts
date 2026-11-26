// @vitest-environment jsdom
// Export and print (T6.3; the user, 2026-11-25, Q220 to Q223), on the real App with the
// chart stood in for (app-harness.ts): one Export button in the pill opens a menu, Save
// as SVG, Save as PNG and Print; a saved picture is the chart alone in the theme on
// screen; Print opens Naiad's print page, with three boxes, "The chart" ticked and the
// two descriptions not, and Print not available while nothing is ticked; the sheet it
// prints holds what is ticked, the nodes in the file's order.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, paperDrawn, sleep, startApp, stopApps } from './app-harness';

vi.mock('../src/chart', async () => (await import('./app-harness')).chartMock());

const A = 'C:/proj/a.mmd';
const TEXT = [
  '---', 'title: Making tea', '---',
  'flowchart TD',
  '    boil[Boil water] --> steep[Steep]',
  '    steep --> pour[Pour]',
  '    cup[Cup] --> pour',
  '',
  '%% @flowchart',
  '%% How to make **tea**.',
  '',
  '%% @pour',
  '%% Into the cup.',
  '',
  '%% @boil',
  '%% Bring it to *100 °C*.',
  '',
].join('\n');

const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const button = (act: string) => q<HTMLButtonElement>(`[data-act="${act}"]`)!;
const menu = () => q<HTMLElement>('.export-menu')!;
const item = (name: string) => [...menu().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;
const page = () => q<HTMLDialogElement>('dialog[data-window="print"]');
const box = (name: string) => [...page()!.querySelectorAll('label')].find((l) => l.textContent!.trim() === name)!.querySelector('input')!;
const printButton = () => [...page()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Print')!;
const summary = () => page()!.querySelector('.print-summary')!.textContent;
const sheet = () => q<HTMLElement>('.print-sheet');
function tick(name: string, on: boolean) {
  const input = box(name);
  input.checked = on;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

let disk: FakeDisk;
let ui: Awaited<ReturnType<typeof startApp>>;
const printed = vi.fn();
beforeEach(async () => {
  // jsdom has no dialogs' showModal, nor printing.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  printed.mockReset();
  window.print = printed;
  paperDrawn.length = 0;
  disk = new FakeDisk();
  disk.files.set(A, TEXT);
  ui = await startApp(disk, A);
});
afterEach(() => stopApps());

describe('the Export button and its menu', () => {
  test('the menu holds Save as SVG, Save as PNG and Print, and opens on a click', () => {
    const exp = button('export');
    expect(exp.getAttribute('aria-label')).toBe('Export');
    expect(exp.getAttribute('aria-haspopup')).toBe('menu');
    expect(exp.querySelector('svg')?.getAttribute('data-icon')).toBe('export');
    expect(menu().hidden).toBe(true);
    exp.click();
    expect(menu().hidden).toBe(false);
    expect(exp.getAttribute('aria-expanded')).toBe('true');
    expect([...menu().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Save as SVG…', 'Save as PNG…', 'Print…']);
    expect([...menu().querySelectorAll('button')].every((b) => b.getAttribute('role') === 'menuitem')).toBe(true);
  });

  test('a click elsewhere, or Escape, closes the menu', () => {
    button('export').click();
    q<HTMLElement>('.stage')!.click();
    expect(menu().hidden).toBe(true);
    button('export').click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().hidden).toBe(true);
  });
});

describe('Save as SVG', () => {
  test('saves the chart as drawn, on its background, next to the flowchart under its name', async () => {
    button('export').click();
    item('Save as SVG…').click();
    await vi.waitFor(() => expect(disk.exports).toHaveLength(1));
    const [saved] = disk.exports;
    expect(saved.suggested).toBe('C:/proj/a.svg');
    expect(saved.kind).toBe('svg');
    expect(saved.text).toMatch(/^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    // The chart's background, a rect under everything (a dark chart stays dark, Q222).
    expect(saved.text).toMatch(/<svg[^>]*>(<style[\s\S]*?<\/style>)?<rect[^>]*fill="rgb\(11, 28, 33\)"/);
    expect(saved.text).toContain('fill="#12303a"');
    // A saved picture keeps the chart's own title: it has no heading (Q225).
    expect(saved.text).toContain('class="flowchartTitleText"');
    expect(menu().hidden).toBe(true);
    await vi.waitFor(() => expect(ui.toast()).toBe('Saved a.svg.'));
    expect(disk.writes).toEqual([]); // the flowchart itself is not written
  });

  test('a cancelled save says nothing', async () => {
    disk.cancelExport = true;
    button('export').click();
    item('Save as SVG…').click();
    await sleep(50);
    expect(disk.exports).toEqual([]);
    expect(ui.toast()).toBe('');
  });
});

describe('the print page (Q221, Q223)', () => {
  test('Print… opens it: "The chart" ticked, the two descriptions not; the heading says "Chart only"', () => {
    button('export').click();
    item('Print…').click();
    expect(page()?.hasAttribute('open')).toBe(true);
    expect(menu().hidden).toBe(true);
    const labels = [...page()!.querySelectorAll('label')].map((l) => l.textContent!.trim());
    expect(labels).toEqual(['The chart', "The flowchart's description", "Each node's description"]);
    expect(labels.map((l) => box(l).checked)).toEqual([true, false, false]);
    expect(summary()).toBe('Chart only');
    expect(printButton().disabled).toBe(false);
    expect([...page()!.querySelectorAll('.print-actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Print']);
    expect(printed).not.toHaveBeenCalled();
  });

  test('the heading follows the boxes, and Print is not available with nothing ticked', () => {
    button('export').click();
    item('Print…').click();
    tick("Each node's description", true);
    expect(summary()).toBe("Chart and each node's description");
    tick("The flowchart's description", true);
    expect(summary()).toBe('Chart and all descriptions');
    tick('The chart', false);
    expect(summary()).toBe('Descriptions only');
    tick("Each node's description", false);
    expect(summary()).toBe("The flowchart's description only");
    tick("The flowchart's description", false);
    expect(summary()).toBe('Nothing to print');
    expect(printButton().disabled).toBe(true);
    tick('The chart', true);
    expect(summary()).toBe('Chart only');
    expect(printButton().disabled).toBe(false);
  });

  test('every time it opens, it starts from the chart alone', () => {
    button('export').click();
    item('Print…').click();
    tick("Each node's description", true);
    [...page()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(page()!.hasAttribute('open')).toBe(false);
    button('export').click();
    item('Print…').click();
    expect(box("Each node's description").checked).toBe(false);
    expect(summary()).toBe('Chart only');
  });

  test('Print with the chart alone: the sheet holds the name and the chart drawn for paper, nothing more', async () => {
    button('export').click();
    item('Print…').click();
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(page()!.hasAttribute('open')).toBe(false);
    expect(paperDrawn).toEqual([TEXT]);
    const s = sheet()!;
    expect(s.querySelector('h1')!.textContent).toBe('Making tea');
    expect(s.querySelector('.print-chart svg.paper')).not.toBeNull();
    expect(s.querySelector('.print-about')).toBeNull();
    expect(s.querySelector('.print-nodes')).toBeNull();
    window.dispatchEvent(new Event('afterprint'));
    expect(sheet()).toBeNull();
  });

  test('Print with everything: the flowchart\'s description above the chart, then each described node under its title, in the file\'s order', async () => {
    button('export').click();
    item('Print…').click();
    tick("The flowchart's description", true);
    tick("Each node's description", true);
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    const s = sheet()!;
    const order = [...s.children].map((c) => c.className || c.tagName.toLowerCase());
    expect(order).toEqual(['h1', 'print-about', 'print-chart', 'print-nodes']);
    expect(s.querySelector('.print-about')!.innerHTML).toContain('<strong>tea</strong>');
    // Nodes with a description, in the order the file first names them; Steep and Cup have none.
    expect([...s.querySelectorAll('.print-nodes h3')].map((h) => h.textContent)).toEqual(['Boil water', 'Pour']);
    expect(s.querySelector('.print-nodes')!.innerHTML).toContain('<em>100 °C</em>');
  });

  test('Print without the chart draws nothing for paper', async () => {
    button('export').click();
    item('Print…').click();
    tick("Each node's description", true);
    tick('The chart', false);
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(paperDrawn).toEqual([]);
    expect(sheet()!.querySelector('.print-chart')).toBeNull();
    expect(sheet()!.querySelectorAll('.print-nodes h3')).toHaveLength(2);
  });

  test('Ctrl+P opens the print page, not the window as it is', () => {
    const e = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(page()?.hasAttribute('open')).toBe(true);
    expect(printed).not.toHaveBeenCalled();
  });

  test('a print started some other way prints the chart as drawn', () => {
    window.dispatchEvent(new Event('beforeprint'));
    expect(sheet()!.querySelector('.print-chart svg')).not.toBeNull();
    // The sheet's heading names the flowchart, so the chart's own title is left out (Q225).
    expect(sheet()!.querySelector('h1')!.textContent).toBe('Making tea');
    expect(sheet()!.querySelector('.flowchartTitleText')).toBeNull();
    // The copy's arrowhead has an id of its own, and its line names that one, not the
    // hidden chart's (a print hides the chart, and its arrowheads with it).
    const copy = sheet()!.querySelector('.print-chart svg')!;
    expect(copy.querySelector('marker')!.id).toBe('print-chart1_flowchart-v2-pointEnd');
    expect(copy.querySelector('path[marker-end]')!.getAttribute('marker-end')).toBe('url(#print-chart1_flowchart-v2-pointEnd)');
    window.dispatchEvent(new Event('afterprint'));
    expect(sheet()).toBeNull();
  });
});
