// The windows laid over Naiad's window (T1.21 and T4.8, the user, 2026-11-14): Customize
// and Settings, opened from the foot of the rail (T4.9). Each is a modal dialog:
// Naiad's window is dimmed behind it and takes no clicks or keys until it closes, by its
// ×, by Escape (the browser's own), or by a click outside it.

import { ICONS } from './icons';

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
