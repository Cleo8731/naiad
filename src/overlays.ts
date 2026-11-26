// The windows laid over Naiad's window (T1.21 and T4.8, the user, 2026-11-14): Customize
// and Settings, opened from the foot of the rail (T4.9). Each is a modal dialog:
// Naiad's window is dimmed behind it and takes no clicks or keys until it closes, by its
// ×, by Escape (the browser's own), or by a click outside it.

import { ICONS } from './icons';
import {
  bestPlan, defaultSize, fitScale, planFor, textPt,
  type ChartSize, type Orientation, type Paper, type Rect,
} from './print-pages';

/** Appearance (T4.8): the window and the chart in light, in dark, or as the computer is set. */
export type Appearance = 'light' | 'dark' | 'system';

const APPEARANCES: [Appearance, string][] = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];

/** The kept choice; anything else is System, the choice until the person picks another. */
export function readAppearance(stored: string | null): Appearance {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Whether the window and the chart are drawn dark: System follows the computer's setting. */
export function isDark(choice: Appearance, systemDark: boolean): boolean {
  return choice === 'system' ? systemDark : choice === 'dark';
}

/** The six palettes (the design handoff, T4.9): their names in `style.css`, and in the window. */
export const PALETTES = [
  ['naiad-default', 'Naiad Default'], ['moonpool', 'Moonpool'], ['kelp', 'Kelp'],
  ['water-lily', 'Water Lily'], ['glacier', 'Glacier'], ['coral', 'Coral'],
] as const;
export type Palette = (typeof PALETTES)[number][0];

/** The kept palette; anything else is Naiad Default, the palette until the person picks another. */
export function readPalette(stored: string | null): Palette {
  return PALETTES.find(([slug]) => slug === stored)?.[0] ?? 'naiad-default';
}

/** The Syntax pane's fonts (T4.9): their names in `style.css`, and in the window. */
export const SYNTAX_FONTS = [['jetbrains-mono', 'JetBrains Mono'], ['dm-mono', 'DM Mono'], ['recursive', 'Recursive Casual']] as const;
export type SyntaxFont = (typeof SYNTAX_FONTS)[number][0];

/** The kept Syntax font; anything else is JetBrains Mono, the font until the person picks another. */
export function readSyntaxFont(stored: string | null): SyntaxFont {
  return SYNTAX_FONTS.find(([slug]) => slug === stored)?.[0] ?? 'jetbrains-mono';
}

/** A window with its title, a ×, and its rows, in a box; the dialog around the box is the dimmed area. */
function overlay(name: string, rows: HTMLElement[]): HTMLDialogElement {
  const key = name.toLowerCase();
  const dialog = document.createElement('dialog');
  dialog.className = 'overlay-window';
  dialog.dataset.window = key;
  const title = document.createElement('h2');
  title.id = `ow-${key}`;
  title.textContent = name;
  dialog.setAttribute('aria-labelledby', title.id);
  const close = document.createElement('button');
  close.className = 'ow-close';
  close.title = 'Close';
  close.setAttribute('aria-label', `Close ${name}`);
  close.innerHTML = ICONS.close;
  close.addEventListener('click', () => dialog.close());
  const head = document.createElement('div');
  head.className = 'ow-head';
  head.append(title, close);
  const box = document.createElement('div');
  box.className = 'ow-box';
  box.append(head, ...rows);
  dialog.append(box);
  // A click outside the box lands on the dialog itself, the dimmed area: it closes.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  return dialog;
}

function note(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'ow-note';
  p.textContent = text;
  return p;
}

export interface CustomizeHooks {
  appearance(): Appearance;
  setAppearance(choice: Appearance): void;
  palette(): Palette;
  setPalette(choice: Palette): void;
  syntaxFont(): SyntaxFont;
  setSyntaxFont(choice: SyntaxFont): void;
}

/** A part of a window under a line, with its name above it. */
function section(name: string, ...rows: HTMLElement[]): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'ow-section';
  const head = document.createElement('span');
  head.className = 'ow-label';
  head.id = `ow-${name.toLowerCase().replace(/\s+/g, '-')}`;
  head.textContent = name;
  sec.setAttribute('aria-labelledby', head.id);
  sec.append(head, ...rows);
  return sec;
}

/**
 * The Customize window (T4.8, T4.9): Appearance (Light, Dark, System); Theme, a card for
 * each palette, drawn in its own colours; and the Syntax font, each shown in its letters.
 */
export function customizeWindow(hooks: CustomizeHooks): HTMLDialogElement {
  const label = document.createElement('span');
  label.id = 'ow-appearance';
  label.className = 'ow-label';
  label.textContent = 'Appearance';
  const group = document.createElement('div');
  group.className = 'segmented';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', label.id);
  for (const [value, text] of APPEARANCES) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'appearance';
    input.value = value;
    input.checked = hooks.appearance() === value;
    input.addEventListener('change', () => { if (input.checked) hooks.setAppearance(value); });
    const option = document.createElement('label');
    option.append(input, text);
    group.append(option);
  }
  const row = document.createElement('div');
  row.className = 'ow-row';
  row.append(label, group);

  // Theme: one card per palette; the chosen one is pressed.
  const cards = document.createElement('div');
  cards.className = 'theme-cards';
  const paint = () => {
    for (const card of cards.querySelectorAll<HTMLButtonElement>('button[data-palette]')) {
      card.setAttribute('aria-pressed', String(card.dataset.palette === hooks.palette()));
    }
  };
  for (const [slug, name] of PALETTES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.palette = slug;
    card.innerHTML = `<span class="theme-preview" data-palette="${slug}" aria-hidden="true"><span class="tp-node"></span><span class="tp-edge"></span><span class="tp-accent"></span><span class="tp-hl"></span></span><span class="theme-name"></span>`;
    card.querySelector('.theme-name')!.textContent = name;
    card.addEventListener('click', () => { hooks.setPalette(slug); paint(); });
    cards.append(card);
  }
  paint();

  // Syntax font: three choices, each with a line of a flowchart in its letters.
  const fonts = document.createElement('div');
  fonts.className = 'font-choices';
  fonts.setAttribute('role', 'radiogroup');
  fonts.setAttribute('aria-labelledby', 'ow-syntax-font');
  for (const [slug, name] of SYNTAX_FONTS) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'syntaxfont';
    input.value = slug;
    input.checked = hooks.syntaxFont() === slug;
    input.addEventListener('change', () => { if (input.checked) hooks.setSyntaxFont(slug); });
    const option = document.createElement('label');
    option.className = 'font-choice';
    option.innerHTML = '<span class="font-name"></span><span class="font-sample" aria-hidden="true">clean -- yes --&gt; train[Train model]</span>';
    option.querySelector('.font-name')!.textContent = name;
    option.querySelector<HTMLElement>('.font-sample')!.dataset.syntaxfont = slug;
    option.prepend(input);
    fonts.append(option);
  }

  return overlay('Customize', [
    row, note('System follows the light or dark setting of your computer.'),
    section('Theme', cards),
    section('Syntax font', fonts),
  ]);
}

export interface SettingsHooks {
  remembering(): boolean;
  setRemembering(on: boolean): void;
}

/**
 * The Settings window (T1.21). Its first setting, Remember opened files (T1.23, the
 * user, 2026-11-14), is an on-off switch: a checkbox drawn as a toggle.
 */
export function settingsWindow(hooks: SettingsHooks): HTMLDialogElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch';
  input.id = 'ow-remember';
  input.setAttribute('role', 'switch');
  input.checked = hooks.remembering();
  input.addEventListener('change', () => hooks.setRemembering(input.checked));
  const label = document.createElement('label');
  label.htmlFor = input.id;
  label.textContent = 'Remember opened files';
  const row = document.createElement('div');
  row.className = 'ow-row';
  row.append(label, input);
  return overlay('Settings', [row, note('When Naiad starts, it opens again the files that were open when it last closed.')]);
}

/**
 * What a print holds (T6.3, Q223): the chart, the flowchart's description, each node's
 * description; and the chart's size, fitted on one page or over several, with the paper
 * and the way up for several (D6.2, Q226 to Q228).
 */
export interface PrintChoice {
  chart: boolean; about: boolean; nodes: boolean;
  size: ChartSize; paper: Paper; orientation: Orientation;
}

/** What the print page knows of the chart once it is measured (D6.2): its frame, its boxes, the region's paper. */
export interface PrintMeasure { chart: Rect; boxes: Rect[]; paper: Paper }

/** The print page's heading: what is ticked, in a few words. */
export function printSummary({ chart, about, nodes }: PrintChoice): string {
  if (chart) return about && nodes ? 'Chart and all descriptions' : about ? "Chart and the flowchart's description" : nodes ? "Chart and each node's description" : 'Chart only';
  return about && nodes ? 'Descriptions only' : about ? "The flowchart's description only" : nodes ? "Each node's description only" : 'Nothing to print';
}

/**
 * The print page (T6.3; the user, 2026-11-25, Q221 and Q223): three boxes for what the
 * print holds, the chart ticked and the two descriptions not, so the chart alone is the
 * default; a heading that says what is ticked; Cancel, and Print preview, which is not
 * available while nothing is ticked. Print preview closes the page and hands the choice to
 * `print`, which opens the print window: its own preview, where the printing is done. The
 * button is not named Print, which read as printing at once (the user, 2026-11-25). Each
 * opening starts from the default.
 *
 * Under "The chart", its size (D6.2, Q226 to Q228): **Fit on one page** or **Readable
 * size, over several pages**, each saying what it gives ("text 2.1 pt"; "7 pages, A4
 * landscape"). The page is told the chart's measure once it is drawn (`measured`); until
 * then the choice waits, and so does Print preview while the chart is ticked. It starts
 * on one page while the fitted text is 8 pt or more (Q227). For several pages the paper
 * is the region's and the way up the one that needs the fewest pages; **Change** shows
 * both as menus (Q228).
 */
export function printWindow(print: (choice: PrintChoice) => void): HTMLDialogElement & { reset(): void; measured(m: PrintMeasure | null | 'failed'): void } {
  const summary = document.createElement('p');
  summary.className = 'print-summary';
  summary.setAttribute('aria-live', 'polite');
  type Box = 'chart' | 'about' | 'nodes';
  const BOXES: [Box, string, string, boolean][] = [
    ['chart', 'The chart', 'In black on white', true],
    ['about', "The flowchart's description", 'Above the chart', false],
    ['nodes', "Each node's description", 'After the chart, under each node\'s title', false],
  ];
  const inputs = {} as Record<Box, HTMLInputElement>;
  const rows = BOXES.map(([key, text, where]) => {
    const label = document.createElement('label');
    label.className = 'print-box';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = key;
    inputs[key] = input;
    const name = document.createElement('span');
    name.textContent = text;
    const hint = document.createElement('small');
    hint.textContent = where;
    hint.setAttribute('aria-hidden', 'true');
    label.append(input, name);
    const row = document.createElement('div');
    row.className = 'print-row';
    row.append(label, hint);
    return row;
  });

  // The chart's size: two choices, what each gives, and the paper for several pages.
  const sizes = document.createElement('div');
  sizes.className = 'print-size';
  sizes.setAttribute('role', 'radiogroup');
  sizes.setAttribute('aria-label', "The chart's size");
  const waiting = document.createElement('small');
  waiting.className = 'print-measuring';
  waiting.textContent = 'Measuring the chart…';
  const radio = (value: ChartSize, text: string) => {
    const label = document.createElement('label');
    label.className = 'print-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'size';
    input.value = value;
    const name = document.createElement('span');
    name.textContent = text;
    const gives = document.createElement('small');
    label.append(input, name);
    const row = document.createElement('div');
    row.className = 'print-choice-row';
    row.append(label, gives);
    return { row, input, gives };
  };
  const fit = radio('fit', 'Fit on one page');
  const pages = radio('pages', 'Readable size, over several pages');
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'print-change';
  change.textContent = 'Change';
  pages.row.append(change);
  const menu = (name: 'paper' | 'orientation', text: string, options: [string, string][]) => {
    const label = document.createElement('label');
    const sel = document.createElement('select');
    sel.name = name;
    for (const [value, shown] of options) sel.add(new Option(shown, value));
    label.append(text, sel);
    return { label, sel };
  };
  const paperMenu = menu('paper', 'Paper', [['A4', 'A4'], ['Letter', 'Letter']]);
  const wayMenu = menu('orientation', 'Way up', [['portrait', 'Portrait (upright)'], ['landscape', 'Landscape (sideways)']]);
  const paperRow = document.createElement('div');
  paperRow.className = 'print-paper';
  paperRow.append(paperMenu.label, wayMenu.label);
  sizes.append(waiting, fit.row, pages.row, paperRow);
  rows[0].append(sizes);

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const go = document.createElement('button');
  go.textContent = 'Print preview…';
  go.className = 'primary';
  const actions = document.createElement('div');
  actions.className = 'print-actions';
  actions.append(cancel, go);
  const dialog = overlay('Print', [summary, ...rows, actions]) as ReturnType<typeof printWindow>;

  let measure: PrintMeasure | null | 'failed' = null;
  let paper: Paper = 'A4';
  let orientation: Orientation = 'portrait';
  let changing = false;
  const choice = (): PrintChoice => ({
    chart: inputs.chart.checked, about: inputs.about.checked, nodes: inputs.nodes.checked,
    size: pages.input.checked ? 'pages' : 'fit', paper, orientation,
  });
  const show = () => {
    const c = choice();
    summary.textContent = printSummary(c);
    const known = measure && measure !== 'failed' ? measure : null;
    // A chart that cannot be drawn shows no size: the print says why when it is tried.
    sizes.hidden = !c.chart || measure === 'failed';
    waiting.hidden = !!known;
    fit.row.hidden = pages.row.hidden = !known;
    if (known) {
      fit.gives.textContent = `text ${String(textPt(fitScale(known.chart, paper)))} pt`;
      const n = planFor(known.chart, known.boxes, paper, orientation).parts.length;
      pages.gives.textContent = `${String(n)} ${n === 1 ? 'page' : 'pages'}, ${paper} ${orientation}`;
    }
    paperRow.hidden = !(known && c.size === 'pages' && changing);
    change.hidden = !(known && c.size === 'pages' && !changing);
    // The chart waits for its measure; a print of the descriptions alone does not.
    go.disabled = !(c.chart || c.about || c.nodes) || (c.chart && measure === null);
  };
  /** The way up that needs the fewest pages on the paper now chosen. */
  const bestWay = () => {
    if (measure && measure !== 'failed') orientation = bestPlan(measure.chart, measure.boxes, paper).orientation;
    wayMenu.sel.value = orientation;
  };
  dialog.reset = () => {
    for (const [key, , , on] of BOXES) inputs[key].checked = on;
    measure = null;
    changing = false;
    fit.input.checked = pages.input.checked = false;
    show();
  };
  dialog.measured = (m) => {
    measure = m;
    if (m && m !== 'failed') {
      paper = m.paper;
      paperMenu.sel.value = paper;
      bestWay();
      (defaultSize(m.chart, paper) === 'fit' ? fit : pages).input.checked = true;
    } else {
      fit.input.checked = true;
    }
    show();
  };
  paperMenu.sel.addEventListener('change', () => { paper = paperMenu.sel.value as Paper; bestWay(); });
  wayMenu.sel.addEventListener('change', () => { orientation = wayMenu.sel.value as Orientation; });
  change.addEventListener('click', () => {
    changing = true;
    show();
    paperMenu.sel.focus();
  });
  dialog.addEventListener('change', show);
  cancel.addEventListener('click', () => dialog.close());
  go.addEventListener('click', () => {
    if (go.disabled) return;
    const c = choice();
    dialog.close();
    print(c);
  });
  dialog.reset();
  return dialog;
}
