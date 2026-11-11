// The highlights file: `.naiad/<file name>/highlights.txt` beside a flowchart's file,
// one highlighted item per line (FILE-FORMAT.md, Highlights). Read and written by Naiad
// and by agents with their own file tools. Text in, text out; no browser code.
//
//   collect            a node's or a group's id
//   collect --> clean  an arrow, by its two ends (the first arrow with those ends)
//   # a note           ignored, as are blank lines and lines naming nothing on the chart
//
// When Naiad changes the list it keeps every other line as it was, an agent's notes
// and items it cannot find included, and adds or removes only the item it was asked to.

export type HighlightItem = { kind: 'id'; id: string } | { kind: 'arrow'; from: string; to: string };

/** What a highlight can point at: the shapes of the chart Naiad has drawn. */
export interface HighlightChart {
  nodes: Record<string, unknown>;
  subs: Record<string, unknown>;
  edges: { start: string; end: string }[];
}

export type HighlightTarget =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; index: number }
  | { kind: 'sub'; id: string };

/** One line's item, or null for a blank line, a note, or a line that is not an item. */
export function parseItem(line: string): HighlightItem | null {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const arrow = /^(\S+)\s*-->\s*(\S+)$/.exec(t);
  if (arrow) return { kind: 'arrow', from: arrow[1], to: arrow[2] };
  return /^\S+$/.test(t) ? { kind: 'id', id: t } : null;
}

export function itemText(item: HighlightItem): string {
  return item.kind === 'id' ? item.id : `${item.from} --> ${item.to}`;
}

function sameItem(a: HighlightItem, b: HighlightItem): boolean {
  return itemText(a) === itemText(b);
}

/** Every item in the file's text, in order, each once. */
export function parseHighlights(text: string): HighlightItem[] {
  const out: HighlightItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const item = parseItem(line);
    if (item && !out.some((o) => sameItem(o, item))) out.push(item);
  }
  return out;
}

/** The items that name something on the chart, as the chart's targets. */
export function resolveHighlights(items: HighlightItem[], chart: HighlightChart): HighlightTarget[] {
  const out: HighlightTarget[] = [];
  for (const item of items) {
    if (item.kind === 'id') {
      if (item.id in chart.nodes) out.push({ kind: 'node', id: item.id });
      else if (item.id in chart.subs) out.push({ kind: 'sub', id: item.id });
    } else {
      const index = chart.edges.findIndex((e) => e.start === item.from && e.end === item.to);
      if (index >= 0 && !out.some((o) => o.kind === 'edge' && o.index === index)) out.push({ kind: 'edge', index });
    }
  }
  return out;
}

/** The item that stands for a target on the chart, or null if it is not on it. */
export function itemOf(target: HighlightTarget, chart: HighlightChart): HighlightItem | null {
  if (target.kind !== 'edge') return { kind: 'id', id: target.id };
  const e = chart.edges[target.index];
  return e ? { kind: 'arrow', from: e.start, to: e.end } : null;
}

/**
 * The file's text with the item added (at the end) or, if it is there, taken off (every
 * line naming it). Every other line is kept as it was. Returns '' when no item is left:
 * the file is then deleted.
 */
export function toggleHighlight(text: string, item: HighlightItem): string {
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const kept = lines.filter((l) => {
    const i = parseItem(l);
    return !(i && sameItem(i, item));
  });
  if (kept.length === lines.length) kept.push(itemText(item));
  return kept.some((l) => parseItem(l)) ? `${kept.join('\n')}\n` : '';
}

/**
 * Switches one item's highlight in the file as it is on disk now: reads the file (null
 * when there is none) and writes the result. When the file cannot be read, the error is
 * thrown and nothing is written: a file Naiad cannot read is never replaced.
 */
export async function toggleInFile(
  read: () => Promise<string | null>,
  write: (text: string) => Promise<void>,
  item: HighlightItem,
): Promise<void> {
  const disk = (await read()) ?? '';
  await write(toggleHighlight(disk, item));
}
