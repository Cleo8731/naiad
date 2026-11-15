// The recent list (T1.15): the flowchart files opened in Naiad, newest first, kept by
// the app between runs (never in a flowchart file), and the pane on the window's far
// left that shows them. A click on an entry opens it (T1.16: in the shown tab when that
// tab is blank, otherwise in a new tab; a file already open shows its tab); × takes it
// off the list; a file that cannot be found stays, greyed, until it is taken off.

import { ICONS } from './icons';

/** How many files the list keeps. */
export const RECENT_KEEP = 50;
/** How many entries the pane shows at first, and how many more each View more shows. */
export const RECENT_SHOWN = 25;

/** Whether two paths name the same file. Naiad runs on Windows, where capitals do not count. */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The list after `path` was opened: on top, listed once, at most RECENT_KEEP. */
export function withOpened(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => !samePath(p, path))].slice(0, RECENT_KEEP);
}

/** The list without `path`. */
export function withoutPath(list: readonly string[], path: string): string[] {
  return list.filter((p) => !samePath(p, path));
}

/** The list as kept (JSON); anything unreadable counts as an empty list. */
export function readRecent(stored: string | null): string[] {
  let value: unknown;
  try {
    value = JSON.parse(stored ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const list: string[] = [];
  for (const p of value) {
    if (typeof p === 'string' && p && !list.some((q) => samePath(q, p))) list.push(p);
  }
  return list.slice(0, RECENT_KEEP);
}

/** The file's name, the last part of its path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The folder a file is in, by its last two folder names, written with the path's own separator. */
export function folderLabel(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  if (parts.length === 0) return sep;
  if (parts.length === 1) return parts[0] + sep;
  return parts.slice(-2).join(sep);
}

export interface RecentHooks {
  /** Opens a listed file, never in place of another file (Q142). */
  open(path: string): void;
  /** Which of these paths name a flowchart file that is there. */
  existing(paths: string[]): Promise<boolean[]>;
  /** The list as kept, and keeping it. */
  load(): string | null;
  save(value: string): void;
}

/** The pane: the list, the shown tab's file marked, the files not found greyed. */
export class RecentPane {
  private list: string[];
  private current: string | null = null;
  private shown = RECENT_SHOWN;
  /** The paths last found missing, in lower case. */
  private missing = new Set<string>();
  /** Counts the checks, so that only the latest one's answer is drawn. */
  private checks = 0;

  constructor(private el: HTMLElement, private hooks: RecentHooks) {
    this.list = readRecent(hooks.load());
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** Shows or hides the pane; shown, it looks again at which files are there. */
  show(visible: boolean): void {
    this.el.hidden = !visible;
    this.update();
  }

  /** A file was opened in this window: it goes on top. */
  opened(path: string): void {
    this.missing.delete(path.toLowerCase());
    this.keep(withOpened(this.list, path));
  }

  /** Marks the shown tab's file (T1.16); none for a blank tab. */
  mark(path: string | null): void {
    this.current = path;
    this.update();
  }

  /** Reads the list again: another window changed it. */
  reload(): void {
    this.list = readRecent(this.hooks.load());
    this.update();
  }

  /** Draws the list and looks again at which files are there (while the pane is shown). */
  update(): void {
    if (!this.visible) return;
    this.render();
    void this.check();
  }

  private keep(list: string[]): void {
    this.list = list;
    this.hooks.save(JSON.stringify(list));
    this.update();
  }

  private async check(): Promise<void> {
    const n = ++this.checks;
    const paths = [...this.list];
    let found: boolean[];
    try {
      found = await this.hooks.existing(paths);
    } catch {
      return; // not known: draw nothing as missing that was not before
    }
    if (n !== this.checks) return;
    this.missing = new Set(paths.filter((_, i) => found[i] === false).map((p) => p.toLowerCase()));
    this.render();
  }

  private render(): void {
    const head = document.createElement('h2');
    head.textContent = 'Recent files';
    if (!this.list.length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'Files you open show here.';
      this.el.replaceChildren(head, none);
      return;
    }
    const ul = document.createElement('ul');
    for (const path of this.list.slice(0, this.shown)) ul.append(this.item(path));
    const parts: HTMLElement[] = [head, ul];
    if (this.list.length > this.shown) {
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = 'View more';
      more.addEventListener('click', () => { this.shown += RECENT_SHOWN; this.render(); });
      parts.push(more);
    }
    this.el.replaceChildren(...parts);
  }

  private item(path: string): HTMLLIElement {
    const name = fileName(path);
    const current = this.current !== null && samePath(path, this.current);
    const missing = this.missing.has(path.toLowerCase());
    const li = document.createElement('li');
    if (current) li.classList.add('current');
    if (missing) li.classList.add('missing');

    const open = document.createElement('button');
    open.className = 'rentry';
    open.title = path;
    if (current) open.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'rname';
    title.textContent = name;
    const folder = document.createElement('span');
    folder.className = 'rfolder';
    folder.textContent = missing ? 'Not found' : folderLabel(path);
    open.append(title, folder);
    open.addEventListener('click', () => { if (!current) this.hooks.open(path); });

    const remove = document.createElement('button');
    remove.className = 'rremove';
    remove.title = 'Take it off the list (the file stays where it is)';
    remove.setAttribute('aria-label', `Take ${name} off the list`);
    remove.innerHTML = ICONS.close;
    remove.addEventListener('click', () => this.keep(withoutPath(this.list, path)));

    li.append(open, remove);
    return li;
  }
}
