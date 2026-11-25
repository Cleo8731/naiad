/**
 * The Syntax pane's text box (the user, 2026-11-25): coloured text, line numbers, and
 * long lines wrapped, a bar beside the numbers marking a line's wrapped rows (a text
 * area cannot indent only those rows: `style.css`, the text box). The text area stays the one
 * place the text is typed, selected and undone; its own letters are see-through, and a
 * copy of the text, coloured line by line (`syntax-colours.ts`), is drawn under it with
 * the same font, width and wrapping, so each letter of the copy sits under its own.
 * The text area grows with its text, and the box around both scrolls them together.
 */
import { colouredHtml } from './syntax-colours';

const VALUE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;

export class SyntaxBox {
  /** The scrolling box, holding the coloured copy and the text area. */
  readonly el: HTMLElement;
  private readonly copy: HTMLElement;

  constructor(readonly area: HTMLTextAreaElement) {
    this.el = document.createElement('div');
    this.el.className = 'code';
    const grid = document.createElement('div');
    grid.className = 'code-grid';
    this.copy = document.createElement('div');
    this.copy.className = 'code-copy';
    this.copy.setAttribute('aria-hidden', 'true');
    grid.append(this.copy, area);
    this.el.append(grid);
    area.addEventListener('input', () => this.draw());
    // Which lines wrap changes with the pane's width: shown, resized, filling the window.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.markWraps()).observe(this.el);
    // The tab sets the text whenever the file or an edit changes it; each time, the
    // copy is drawn again. A setter on this one text area catches every such change.
    const draw = () => this.draw();
    Object.defineProperty(area, 'value', {
      configurable: true,
      get(this: HTMLTextAreaElement) { return VALUE.get!.call(this); },
      set(this: HTMLTextAreaElement, v: string) { VALUE.set!.call(this, v); draw(); },
    });
    this.draw();
  }

  get hidden(): boolean { return this.el.hidden === true; }
  set hidden(on: boolean) { this.el.hidden = on; this.area.hidden = on; }

  /** Draws the coloured copy of the text area's text, and sizes the line numbers' column. */
  draw(): void {
    const text = VALUE.get!.call(this.area) as string;
    this.copy.innerHTML = colouredHtml(text);
    const lines = text.split('\n').length;
    this.el.style.setProperty('--digits', String(Math.max(2, String(lines).length)));
    this.markWraps();
  }

  /** Marks each line drawn on more than one row (`wraps`), for the bar beside it. */
  private markWraps(): void {
    if (this.el.hidden || !this.el.isConnected) return;
    const row = parseFloat(getComputedStyle(this.copy).lineHeight);
    if (!row) return;
    const lines = [...this.copy.children] as HTMLElement[];
    const wraps = lines.map((ln) => ln.offsetHeight > row * 1.5);
    lines.forEach((ln, i) => ln.classList.toggle('wraps', wraps[i]));
  }

  remove(): void { this.el.remove(); }
}
