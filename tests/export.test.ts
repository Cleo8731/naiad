// @vitest-environment jsdom
// Export and print (T6.3; the user, 2026-11-25, Q220 to Q223), on the real App with the
// chart stood in for (app-harness.ts): one Export button in the pill opens a menu, Save
// as SVG, Save as PNG and Print; a saved picture is the chart alone in the theme on
// screen; Print opens Naiad's print page, with three boxes, "The chart" ticked and the
// two descriptions not, and Print not available while nothing is ticked; the sheet it
// prints holds what is ticked, the nodes in the file's order.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDisk, paperDrawn, paperSize, sleep, startApp, stopApps } from './app-harness';

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
const box = (name: string) => [...page()!.querySelectorAll('label.print-box')].find((l) => l.textContent!.trim() === name)!.querySelector('input')!;
const printButton = () => [...page()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Print preview…')!;
const summary = () => page()!.querySelector('.print-summary')!.textContent;
const sheet = () => q<HTMLElement>('.print-sheet');
/** Opens the print page with the Print button and waits for the chart's measure (D6.2). */
async function openPage() {
  button('print').click();
  await vi.waitFor(() => expect(page()!.querySelector<HTMLElement>('.print-measuring')!.hidden).toBe(true));
}
const radio = (value: 'fit' | 'pages') => page()!.querySelector<HTMLInputElement>(`input[name="size"][value="${value}"]`)!;
const gives = (value: 'fit' | 'pages') => radio(value).closest('.print-choice-row')!.querySelector('small')!.textContent;
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
  paperSize.w = 120;
  paperSize.h = 80;
  disk = new FakeDisk();
  disk.files.set(A, TEXT);
  ui = await startApp(disk, A);
});
afterEach(() => stopApps());

describe('the Export button and its menu', () => {
  test('Export and Print sit on the rail, under its two switches, in both modes (the user, 2026-11-25)', () => {
    const mid = q<HTMLElement>('.rail .rail-mid')!;
    const acts = [...mid.querySelectorAll<HTMLElement>(':scope > button, :scope > .export-wrap > button')].map((b) => b.dataset.act);
    expect(acts).toEqual(['wheel', 'view', 'export', 'print']);
    expect(button('export').textContent!.trim()).toBe('Export');
    expect(button('print').textContent!.trim()).toBe('Print');
    expect(button('print').querySelector('svg')?.getAttribute('data-icon')).toBe('print');
    expect(q('.pill [data-act="export"], .pill [data-act="print"]')).toBeNull();
  });

  test('the menu holds Save as SVG and Save as PNG, and opens on a click', () => {
    const exp = button('export');
    expect(exp.textContent!.trim()).toBe('Export');
    expect(exp.getAttribute('aria-haspopup')).toBe('menu');
    expect(exp.querySelector('svg')?.getAttribute('data-icon')).toBe('export');
    expect(menu().hidden).toBe(true);
    exp.click();
    expect(menu().hidden).toBe(false);
    expect(exp.getAttribute('aria-expanded')).toBe('true');
    expect([...menu().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Save as SVG…', 'Save as PNG…']);
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
  test('the Print button opens it: "The chart" ticked, the two descriptions not; the heading says "Chart only"', async () => {
    await openPage();
    expect(page()?.hasAttribute('open')).toBe(true);
    const labels = [...page()!.querySelectorAll('label.print-box')].map((l) => l.textContent!.trim());
    expect(labels).toEqual(['The chart', "The flowchart's description", "Each node's description"]);
    expect(labels.map((l) => box(l).checked)).toEqual([true, false, false]);
    expect(summary()).toBe('Chart only');
    expect(printButton().disabled).toBe(false);
    expect([...page()!.querySelectorAll('.print-actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Print preview…']);
    expect(printed).not.toHaveBeenCalled();
  });

  test('the heading follows the boxes, and Print is not available with nothing ticked', async () => {
    await openPage();
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
    button('print').click();
    tick("Each node's description", true);
    [...page()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(page()!.hasAttribute('open')).toBe(false);
    button('print').click();
    expect(box("Each node's description").checked).toBe(false);
    expect(summary()).toBe('Chart only');
  });

  test('Print with the chart alone: the sheet holds the name and the chart drawn for paper, nothing more', async () => {
    await openPage();
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(page()!.hasAttribute('open')).toBe(false);
    // Drawn once to measure it when the page opened (D6.2), and again to print it.
    expect(paperDrawn).toEqual([TEXT, TEXT]);
    expect(q('#print-page-size')).toBeNull(); // on one page, the printer's own paper
    const s = sheet()!;
    expect(s.querySelector('h1')!.textContent).toBe('Making tea');
    expect(s.querySelector('.print-chart svg.paper')).not.toBeNull();
    expect(s.querySelector('.print-about')).toBeNull();
    expect(s.querySelector('.print-nodes')).toBeNull();
    window.dispatchEvent(new Event('afterprint'));
    expect(sheet()).toBeNull();
  });

  test('Print with everything: the flowchart\'s description above the chart, then each described node under its title, in the file\'s order', async () => {
    await openPage();
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

  test('Print without the chart draws nothing more for paper, and need not wait for the chart\'s measure', async () => {
    button('print').click();
    tick("Each node's description", true);
    tick('The chart', false);
    expect(printButton().disabled).toBe(false);
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(paperDrawn).toEqual([TEXT]); // the measure's drawing only
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

describe('a large chart over several pages (D6.2; the user, 2026-11-25, Q226 to Q228)', () => {
  /** The user's first document's size as the print sheet draws it (measured 2026-11-25). */
  const tall = () => { paperSize.w = 1218; paperSize.h = 4863; };

  test('Print preview waits for the chart\'s measure while the chart is ticked', async () => {
    button('print').click();
    expect(page()!.querySelector<HTMLElement>('.print-measuring')!.hidden).toBe(false);
    expect(printButton().disabled).toBe(true);
    await vi.waitFor(() => expect(printButton().disabled).toBe(false));
  });

  test('a small chart starts on one page; each choice says what it gives', async () => {
    await openPage();
    expect(radio('fit').checked).toBe(true);
    expect(gives('fit')).toBe('text 10.5 pt');
    expect(gives('pages')).toBe('1 page, A4 portrait');
    expect(page()!.querySelector<HTMLElement>('.print-change')!.hidden).toBe(true); // only for several pages
  });

  test('a tall chart starts on several pages (Q227): 7 on A4, sideways, against 2 pt text on one', async () => {
    tall();
    await openPage();
    expect(radio('pages').checked).toBe(true);
    expect(gives('fit')).toBe('text 2 pt'); // fitted at most 245 mm tall
    expect(gives('pages')).toBe('7 pages, A4 landscape');
  });

  test('the paper is the region\'s (Q228): 6 pages on Letter', async () => {
    tall();
    disk.regionPaper = 'Letter';
    await openPage();
    expect(gives('pages')).toBe('6 pages, Letter landscape');
  });

  test('Change shows the paper and the way up; a new paper takes the way up that needs the fewest pages', async () => {
    tall();
    await openPage();
    const paperRow = page()!.querySelector<HTMLElement>('.print-paper')!;
    expect(paperRow.hidden).toBe(true);
    page()!.querySelector<HTMLButtonElement>('.print-change')!.click();
    expect(paperRow.hidden).toBe(false);
    const sel = (name: string) => page()!.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
    const pick = (name: string, value: string) => { sel(name).value = value; sel(name).dispatchEvent(new Event('change', { bubbles: true })); };
    pick('paper', 'Letter');
    expect(sel('orientation').value).toBe('landscape');
    expect(gives('pages')).toBe('6 pages, Letter landscape');
    pick('orientation', 'portrait');
    expect(gives('pages')).toBe('10 pages, Letter portrait');
  });

  test('printed over several pages: one part a page, each under the name and "Part 2 of 7"; the page\'s size is the paper\'s', async () => {
    tall();
    await openPage();
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    const s = sheet()!;
    const parts = [...s.querySelectorAll('.print-part')];
    expect(parts).toHaveLength(7);
    expect(parts.map((p) => p.querySelector('.print-part-head span:last-child')!.textContent)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((i) => `Part ${String(i)} of 7`));
    expect(parts[0].querySelector('.print-part-head span')!.textContent).toBe('Making tea');
    // One column and no description: no first page; the parts' line names the flowchart.
    expect(s.querySelector('h1')).toBeNull();
    expect(s.querySelector('.print-chart')).toBeNull();
    expect(parts[0].classList.contains('print-part-first')).toBe(true);
    // Each part is a window on the whole drawing, down the chart; with no box to cut through
    // (jsdom lays nothing out) each starts where the last ended.
    const boxes = parts.map((p) => p.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number));
    expect(boxes.every(([x, , w]) => x === 0 && w === 1218)).toBe(true);
    expect(boxes[0][1]).toBe(0);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][1]).toBeCloseTo(boxes[i - 1][1] + boxes[i - 1][3]);
    expect(boxes[6][1] + boxes[6][3]).toBeCloseTo(4863);
    // The parts' arrowheads have ids of their own.
    expect(new Set(parts.map((p) => p.querySelector('svg [id]')?.id)).size).toBe(parts.length);
    expect(q('#print-page-size')!.textContent).toContain('size: 297mm 210mm');
    window.dispatchEvent(new Event('afterprint'));
    expect(sheet()).toBeNull();
    expect(q('#print-page-size')).toBeNull();
  });

  test('with the flowchart\'s description, the name and the description keep a first page', async () => {
    tall();
    await openPage();
    tick("The flowchart's description", true);
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    const s = sheet()!;
    expect([...s.children].slice(0, 3).map((c) => c.className || c.tagName.toLowerCase())).toEqual(['h1', 'print-about', 'print-part']);
    expect(s.querySelector('.print-part-first')).toBeNull();
  });

  test('parts that form a grid get a first page with the whole chart and each part\'s outline and number', async () => {
    paperSize.w = 5387; paperSize.h = 3366; // big.mmd's size; no boxes here, so no cut needs an overlap
    await openPage();
    expect(gives('pages')).toBe('18 pages, A4 portrait');
    tick("Each node's description", true);
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    const s = sheet()!;
    expect(s.querySelector('h1')!.textContent).toBe('Making tea');
    const map = s.querySelector('.print-chart.print-map svg')!;
    expect(map.querySelectorAll('.print-map-parts rect')).toHaveLength(18);
    expect([...map.querySelectorAll('.print-map-parts text')].map((t) => t.textContent).slice(0, 3)).toEqual(['1', '2', '3']);
    const heads = [...s.querySelectorAll('.print-part-head span:last-child')].map((h) => h.textContent);
    expect(heads[1]).toBe('Part 2 of 18, row 1, column 2');
    expect(heads[17]).toBe('Part 18 of 18, row 3, column 6');
    // The node descriptions come after the parts.
    expect(s.lastElementChild!.className).toBe('print-nodes');
  });

  test('a print on one page of a tall chart has no parts and no page size', async () => {
    tall();
    await openPage();
    radio('fit').checked = true;
    radio('fit').dispatchEvent(new Event('change', { bubbles: true }));
    printButton().click();
    await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(1));
    expect(sheet()!.querySelector('.print-part')).toBeNull();
    expect(sheet()!.querySelector('.print-chart svg')).not.toBeNull();
    expect(q('#print-page-size')).toBeNull();
  });
});
