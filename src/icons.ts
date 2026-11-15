/**
 * The window's icons: Lucide's (lucide.dev, release 1.73.0), the set Obsidian uses,
 * copied unchanged into `icons/` with Lucide's licence, `icons/LICENSE` (Q131 and Q132,
 * 2026-11-14). Each is drawn inline in its button, so its lines take the button's text
 * colour in light and dark; the button's `aria-label` says what it does, so the drawing
 * itself is hidden from screen readers.
 */
import undo from './icons/undo-2.svg?raw';
import redo from './icons/redo-2.svg?raw';
import bookOpen from './icons/book-open.svg?raw';
import pencilLine from './icons/pencil-line.svg?raw';
import codeXml from './icons/code-xml.svg?raw';
import highlighter from './icons/highlighter.svg?raw';
import touchpad from './icons/touchpad.svg?raw';
import mouse from './icons/mouse.svg?raw';
import panelLeft from './icons/panel-left.svg?raw';
import x from './icons/x.svg?raw';
import plus from './icons/plus.svg?raw';

/** An icon's markup, marked with its name (`data-icon`) and hidden from screen readers. */
function icon(name: string, svg: string): string {
  return svg.trim().replace(/^<svg\b/, `<svg data-icon="${name}" aria-hidden="true" focusable="false"`);
}

export const ICONS = {
  undo: icon('undo', undo),
  redo: icon('redo', redo),
  /** The open book: shown while editing, since a click goes to View mode (as Obsidian's). */
  read: icon('read', bookOpen),
  /** The pencil: shown in View mode, since a click goes back to editing. */
  edit: icon('edit', pencilLine),
  syntax: icon('syntax', codeXml),
  highlight: icon('highlight', highlighter),
  /** The Touchpad and Mouse switch (D1.5) shows the mode it is in. */
  touchpad: icon('touchpad', touchpad),
  mouse: icon('mouse', mouse),
  /** Shows and hides the recent list's pane (T1.15), at the toolbar's left end. */
  recent: icon('recent', panelLeft),
  /** Takes an entry off the recent list; closes a tab (T1.16). */
  close: icon('close', x),
  /** Opens a blank tab, at the tab strip's end (T1.16). */
  plus: icon('plus', plus),
} as const;
