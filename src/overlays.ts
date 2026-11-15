// The windows laid over Naiad's window (T1.21 and T4.8, the user, 2026-11-14): Customize
// and Settings, opened from the foot of the recent list's pane. Each is a modal dialog:
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
}

/** The Customize window (T4.8): Appearance. Fonts and themes wait on D4.5. */
export function customizeWindow(hooks: CustomizeHooks): HTMLDialogElement {
  const label = document.createElement('span');
  label.id = 'ow-appearance';
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
  return overlay('Customize', [row, note('System follows the light or dark setting of your computer.')]);
}

/** The Settings window (T1.21): nothing to set until its first setting is known (Q149). */
export function settingsWindow(): HTMLDialogElement {
  return overlay('Settings', [note('Nothing to set yet.')]);
}
