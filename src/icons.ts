/**
 * The window's icons: Lucide's (lucide.dev, release 1.73.0), the set Obsidian uses,
 * copied unchanged into `icons/` with Lucide's licence, `icons/LICENSE` (Q131 and Q132,
 * 2026-11-14; twelve more with the design handoff, T4.9, 2026-11-15). Each is drawn
 * inline in its button, so its lines take the button's text colour in every theme; the
 * button's name says what it does, so the drawing itself is hidden from screen readers.
 * Two more, Maximize 2 and Minimize 2, the Syntax pane's full-window button (2026-11-25),
 * were written out by hand from Lucide's drawings, in the same form as the others; so was
 * Share, the rail's Export button, and Printer, its Print button (T6.3, 2026-11-25).
 * Naiad's own mark is not an icon: `brand/naiad-mark.svg`, drawn through a mask.
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
import paintbrush from './icons/paintbrush.svg?raw';
import settings from './icons/settings.svg?raw';
import info from './icons/info.svg?raw';
import scan from './icons/scan.svg?raw';
import arrowDown from './icons/arrow-down.svg?raw';
import arrowRight from './icons/arrow-right.svg?raw';
import arrowUp from './icons/arrow-up.svg?raw';
import arrowLeft from './icons/arrow-left.svg?raw';
import eraser from './icons/eraser.svg?raw';
import folderOpen from './icons/folder-open.svg?raw';
import filePlus from './icons/file-plus.svg?raw';
import circleAlert from './icons/circle-alert.svg?raw';
import chevronDown from './icons/chevron-down.svg?raw';
import trash from './icons/trash-2.svg?raw';
import maximize2 from './icons/maximize-2.svg?raw';
import minimize2 from './icons/minimize-2.svg?raw';
import share from './icons/share.svg?raw';
import printer from './icons/printer.svg?raw';

/**
 * The window's own buttons (T4.10, Q171): Naiad's drawings, not Lucide's, thin and
 * square like Windows' own, at 10 by 10 with a line one pixel wide at any scale.
 */
const caption = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke">${paths}</svg>`;
const minimize = caption('<path d="M0 5.5h10"/>');
const maximize = caption('<rect x="0.5" y="0.5" width="9" height="9" rx="1.5"/>');
const restore = caption('<rect x="0.5" y="2.5" width="7" height="7" rx="1.2"/><path d="M2.5 2.5V2A1.5 1.5 0 0 1 4 .5h4A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5"/>');
const winClose = caption('<path d="M.5.5l9 9M9.5.5l-9 9"/>');

/** An icon's markup, marked with its name (`data-icon`) and hidden from screen readers. */
function icon(name: string, svg: string): string {
  return svg.trim().replace(/^<svg\b/, `<svg data-icon="${name}" aria-hidden="true" focusable="false"`);
}

export const ICONS = {
  undo: icon('undo', undo),
  redo: icon('redo', redo),
  /** The open book: the mode button in View mode (it shows the mode Naiad is in, T4.9). */
  read: icon('read', bookOpen),
  /** The pencil: the mode button in Edit mode. */
  edit: icon('edit', pencilLine),
  syntax: icon('syntax', codeXml),
  highlight: icon('highlight', highlighter),
  /** The Touchpad and Mouse switch (D1.5) shows the mode it is in. */
  touchpad: icon('touchpad', touchpad),
  mouse: icon('mouse', mouse),
  /** Shows and hides the recent list's pane (T1.15), in the rail (T4.9). */
  recent: icon('recent', panelLeft),
  /** Shows and hides the flowchart's description in the sidebar (T1.13), in the rail. */
  about: icon('about', info),
  /** Opens the Customize window, at the rail's foot (T4.8, T4.9). */
  customize: icon('customize', paintbrush),
  /** Opens the Settings window, at the rail's foot. */
  settings: icon('settings', settings),
  /** Fits the chart to the window, in the pill (T4.9). */
  fit: icon('fit', scan),
  /** Export (T6.3): its menu saves the chart as a picture, or prints it; in the pill. */
  export: icon('export', share),
  print: icon('print', printer),
  /** The direction button and its menu (T4.9): the way the chart runs. */
  down: icon('down', arrowDown),
  right: icon('right', arrowRight),
  up: icon('up', arrowUp),
  left: icon('left', arrowLeft),
  /** Clear, beside the Undo island: takes every highlight off. */
  eraser: icon('eraser', eraser),
  /** A blank tab's Open a file and New flowchart. */
  open: icon('open', folderOpen),
  new: icon('new', filePlus),
  /** A notice that something is wrong (a syntax error, a save that failed). */
  alert: icon('alert', circleAlert),
  /** A list's arrow, in the sidebar. */
  chevron: icon('chevron', chevronDown),
  /** The sidebar's Delete and Ungroup. */
  trash: icon('trash', trash),
  /** The Syntax pane fills the window, and goes back to its own width (2026-11-25). */
  expand: icon('expand', maximize2),
  shrink: icon('shrink', minimize2),
  /** Takes an entry off the recent list; closes a tab (T1.16) and a window. */
  close: icon('close', x),
  /** Opens a blank tab, at the tab strip's end (T1.16); the add-node button in the pill. */
  plus: icon('plus', plus),
  /** Naiad's own title bar (T4.10): minimize, maximize, restore (while maximized), close. */
  minimize: icon('minimize', minimize),
  maximize: icon('maximize', maximize),
  restore: icon('restore', restore),
  winClose: icon('winclose', winClose),
} as const;
