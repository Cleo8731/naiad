// Finds the Mermaid blocks inside a Markdown file and puts an edited block back.
// Spec: FILE-FORMAT.md, "A flowchart inside a Markdown file". Text in, text out, no
// browser code. Every line outside the block's own lines is carried over as it is
// (file safety first), and a block that cannot be put back exactly is locked.

export interface Block {
  /** Line index (from 0) of the opening fence line in the file. */
  open: number;
  /** Line index of the closing fence line; -1 when the block runs to the end of the file. */
  close: number;
  /** The whitespace in front of the opening fence. Every line of the block carries it. */
  indent: string;
  /** Whether the block's empty lines carry the indent too (true) or are fully empty. */
  blankIndented: boolean;
  /** The block's text with the indent taken off: what Mermaid reads. */
  text: string;
  /** Whether the text is a flowchart (other Mermaid diagram types are not Naiad's). */
  flowchart: boolean;
  /** The nearest heading above the block, or '' (used to tell several blocks apart). */
  heading: string;
  /** Why the block can be shown but not changed, or null when it can be changed. */
  locked: string | null;
}

export class BlockError extends Error {}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;

/** How many columns a run of spaces and tabs takes, a tab reaching the next multiple of 4. */
function columns(ws: string): number {
  let w = 0;
  for (const c of ws) w = c === '\t' ? w + 4 - (w % 4) : w + 1;
  return w;
}

/**
 * The column a fence indented `w` columns on line `at` is measured from: 0 at the
 * margin, or the start of the text of the list item it stands in. Null when it is no
 * fence: Markdown reads a line indented four columns or more past that (at the margin,
 * or past the item's text) as an indented code sample, or as text. Unsure is null.
 * `opener[k]` is the opening line of the fenced block line k stands in, or -1: a line
 * inside a fenced block is text, never a list item, so the block's opening line stands
 * for it. A list item is one only when its own marker stands where a block may start
 * (bug hunt round 2, B10). Every line between the item and the fence must stand in the
 * item: indented to its text at least, or paragraph text going on from the line above
 * (a lazy line); any other line ended the item (bug hunt round 3, B15). Unsure counts
 * as ended: the block is then not found, the safe side.
 */
function fenceBase(lines: string[], at: number, w: number, opener: Int32Array): number | null {
  if (w <= 3) return 0;
  let least = Infinity; // the least indent of the lines passed that may have ended an item
  const lazy: [number, number][] = []; // [its indent, the indent of the line above] of the lazy lines passed
  for (let k = at - 1; k >= 0; k--) {
    if (opener[k] >= 0) k = opener[k];
    const line = lines[k];
    if (line.trim() === '') continue;
    const lead = columns(/^[ \t]*/.exec(line)![0]);
    const role = lineRole(lines, k, opener);
    if (role === 'item') {
      const text = textColumn(LIST_ITEM.exec(line)!);
      // A lazy line goes on with a paragraph of the item only if the line above it is
      // no code sample in the item (four columns or more past its text).
      if (w >= text && least >= text && lazy.every(([l, a]) => l >= text || a < text + 4)) {
        return w - text <= 3 ? text : null;
      }
      // Less indented than this item's text, or a line between ended the item: the
      // fence may stand in an item further out.
    } else if (role === 'lazy') {
      lazy.push([lead, columns(/^[ \t]*/.exec(lines[k - 1])![0])]);
      continue;
    }
    if (lead === 0) return null; // at the margin: the fence stands in no list
    least = Math.min(least, lead);
  }
  return null;
}

/** The column where a list item's text starts: one to four spaces past the marker, or one when more. */
function textColumn(item: RegExpExecArray): number {
  const gap = columns(item[1] + item[2] + item[3]) - columns(item[1] + item[2]);
  return columns(item[1]) + item[2].length + (gap >= 1 && gap <= 4 ? gap : 1);
}

/** Right under paragraph text, only a bullet or a 1 with text after it can start a list item. */
function mayInterrupt(line: string, item: RegExpExecArray): boolean {
  return /^([-+*]|0*1[.)])$/.test(item[2]) && line.slice(item[0].length).trim() !== '';
}

/** Lines that may open a block of their own: a quote, a heading, HTML, a table row, a
 * setext underline or a thematic break. Fences and list items are tested apart. */
const BLOCK_START = /^[ \t]*(>|#{1,6}([ \t]|$)|<|\||=|([-*_])([ \t]*\3){2,}[ \t]*$)/;

/**
 * What line k (not blank, not in a fenced block) is to a list item above it: 'item', a
 * list item's own line; 'lazy', paragraph text going on from the line above, which
 * stands in an item whatever its indent; 'other', any other line, or unsure.
 */
function lineRole(lines: string[], k: number, opener: Int32Array): 'item' | 'lazy' | 'other' {
  const line = lines[k];
  const para = paragraphAbove(lines, k, opener);
  const item = LIST_ITEM.exec(line);
  if (!item) return para === 1 && !FENCE.test(line) && !BLOCK_START.test(line) ? 'lazy' : 'other';
  const lead = columns(item[1]);
  // Right under paragraph text, and indented into the item that text stands in, only a
  // bullet or a 1 with text after it starts a list item; any other is more of the
  // paragraph.
  let starts: boolean | null = true;
  if (para === -1 && !mayInterrupt(line, item)) starts = null;
  else if (para === 1 && !mayInterrupt(line, item)) {
    const text = paragraphItemText(lines, k - 1, opener);
    starts = text === null ? null : lead < text;
  }
  if (starts === null) return 'other';
  if (!starts) return 'lazy';
  if (fenceBase(lines, k, lead, opener) !== null) return 'item';
  // Its marker is four columns or more past where a block may start: under paragraph
  // text, more of it; else a code sample.
  return para === 1 ? 'lazy' : 'other';
}

/**
 * The column where the text of the list item starts, when the paragraph that line k
 * holds began on that item's own line; Infinity when it stands in a quote (a line
 * without `>` never goes on with it as a list item); null when unsure.
 */
function paragraphItemText(lines: string[], k: number, opener: Int32Array): number | null {
  for (;;) {
    const line = lines[k];
    const lead = /^[ \t]*/.exec(line)![0];
    if (line[lead.length] === '>') return columns(lead) <= 3 ? Infinity : null;
    const para = paragraphAbove(lines, k, opener);
    const item = LIST_ITEM.exec(line);
    if (item) {
      const rest = line.slice(item[0].length);
      // Maybe more of the paragraph above, or no paragraph at all: unsure.
      if (rest.trim() === '' || (para !== 0 && !mayInterrupt(line, item))) return null;
      if (fenceBase(lines, k, columns(item[1]), opener) === null) {
        if (para !== 1) return null;
        k--; // more of the paragraph above
        continue;
      }
      if (rest.startsWith('>')) return columns(item[1] + item[2] + item[3]) - columns(item[1] + item[2]) <= 4 ? Infinity : null;
      return textColumn(item);
    }
    if (para !== 1) return null; // began on a line of its own, or unsure
    k--;
  }
}

/** Whether the line right above line k holds paragraph text: 1 sure, 0 sure not, -1 unsure. */
function paragraphAbove(lines: string[], k: number, opener: Int32Array): 1 | 0 | -1 {
  if (k === 0 || opener[k - 1] >= 0) return 0; // nothing above, or a line of a fenced block
  const line = lines[k - 1];
  let above = line;
  for (;;) { // take off the quote and list markers the text above stands in
    const m = /^[ \t]*>[ \t]?/.exec(above) ?? LIST_ITEM.exec(above);
    if (!m) break;
    above = above.slice(m[0].length);
  }
  if (above.trim() === '') return 0; // blank, or an empty item or quote
  if (!FENCE.test(above) && !BLOCK_START.test(above)) return 1;
  // A heading or a thematic break (or setext underline) three columns in at most ends
  // any paragraph; other lines like these may be more text.
  if (above === line && /^ {0,3}(#{1,6}([ \t]|$)|([-*_])([ \t]*\3){2,}[ \t]*$)/.test(line)) return 0;
  return -1;
}

/** True when the first line that is not empty, a comment or frontmatter starts a flowchart. */
export function isFlowchartText(text: string): boolean {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].trim() === '---') {
    i++;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('%%')) continue;
    return /^(flowchart|graph)\b/i.test(t);
  }
  return false;
}

/** Every fenced block marked `mermaid`, in file order, flowchart or not. */
export function findBlocks(file: string): Block[] {
  const lines = file.split('\n');
  const blocks: Block[] = [];
  const opener = new Int32Array(lines.length).fill(-1);
  let heading = '';
  let i = 0;
  // YAML front matter at the top of the file ("---" to "---" or "..."): its lines are
  // data, so a fence written inside it opens no block.
  if (/^---[ \t]*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
    if (end > 0) i = end + 1;
  }
  while (i < lines.length) {
    const m = FENCE.exec(lines[i]);
    // A backtick fence's first line cannot hold another backtick (that is inline code).
    const base = m && !(m[2][0] === '`' && m[3].includes('`')) ? fenceBase(lines, i, columns(m[1]), opener) : null;
    if (!m || base === null) {
      const h = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(lines[i]);
      if (h) heading = h[1];
      i++;
      continue;
    }
    const [, indent, fence, info] = m;
    const open = i;
    let close = -1;
    for (let j = open + 1; j < lines.length; j++) {
      const c = FENCE.exec(lines[j]);
      // The closing line may be indented up to three columns past the opening's base.
      if (c && c[2][0] === fence[0] && c[2].length >= fence.length && c[3].trim() === '' && columns(c[1]) <= base + 3) { close = j; break; }
    }
    const end = close < 0 ? lines.length : close;
    opener.fill(open, open + 1, Math.min(end + 1, lines.length));
    if (info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
      blocks.push(readBlock(file, lines, open, close, indent, heading));
    }
    i = end + 1;
  }
  return blocks;
}

function readBlock(file: string, lines: string[], open: number, close: number, indent: string, heading: string): Block {
  const content = lines.slice(open + 1, close < 0 ? lines.length : close);
  let even = true;
  let plainBlank = 0;
  let indentedBlank = 0;
  const inner = content.map((line) => {
    if (line === '') { plainBlank++; return ''; }
    if (!line.startsWith(indent)) { even = false; return line.trimStart(); }
    const rest = line.slice(indent.length);
    if (rest === '') indentedBlank++;
    return rest;
  });
  const text = inner.length ? inner.join('\n') + '\n' : '';
  const block: Block = {
    open, close, indent, blankIndented: indentedBlank > 0 && plainBlank === 0, text,
    flowchart: isFlowchartText(text), heading, locked: null,
  };
  if (close < 0) block.locked = 'the block has no closing fence line.';
  else if (!even || replaceBlock(file, block, text) !== file) block.locked = 'its lines are not indented evenly.';
  return block;
}

/**
 * After the file changed on disk: the index of the block that was shown, among the
 * Mermaid blocks `after` of the file `afterFile`, or -1 when it cannot be told for
 * certain. `before` are the blocks of `beforeFile`, the file as Naiad last read or wrote
 * it, and `was` the shown block's index then. Never a guess: a wrong answer would show
 * another flowchart, or send the person's edits and Undo into a copy of the one shown.
 */
export function findAgain(beforeFile: string, before: Block[], afterFile: string, after: Block[], was: number): number {
  const shown = before[was];
  if (!shown) return -1;
  // Every block as it was (only the text around them changed): it is still at its place.
  if (after.length === before.length && after.every((b, i) => b.text === before[i].text)) return was;
  const same = after.flatMap((b, i) => (b.text === shown.text ? [i] : []));
  if (same.length) {
    // The block holding its text: when only one does, now and before, it is the shown
    // block, unchanged, and moved by a block added or taken away above it. When several
    // do, now or before (a copy was written beside it, bug hunt round 2 B8; one of two
    // copies changed, round 3 B13): the one whose surrounding lines read more like the
    // shown block's did, above and below both, than every other block holding the text
    // does, and that reads more like the shown block's than like another copy's.
    // Anything less is not certain: a copy written right below the shown block reads
    // like it below, as the shown block does above (round 3, B14).
    const copies = before.flatMap((b, i) => (b.text === shown.text ? [i] : []));
    const old = beforeFile.split('\n');
    const now = afterFile.split('\n');
    const around = (o: number, n: number) => alikeAround(old, before[o], now, after[n]);
    const beats = (a: number[], b: number[]) => a[0] >= b[0] && a[1] >= b[1] && (a[0] > b[0] || a[1] > b[1]);
    const found = same.filter((n) => {
      const mine = around(was, n);
      return same.every((m) => m === n || beats(mine, around(was, m))) && copies.every((o) => o === was || beats(mine, around(o, n)));
    });
    // Nor is it certain when a block whose text no block held before reads more like the
    // shown block's place, above it (where its heading is) and no less below: the shown
    // block may have been changed there, and its old text kept elsewhere as a backup
    // (round 3, B13). Lines alike below alone do not decide: a block added right below
    // the shown one has them too.
    const known = new Set(before.map((b) => b.text));
    const rivalled = (n: number) =>
      after.some((b, i) => {
        if (known.has(b.text)) return false;
        const rival = around(was, i);
        const mine = around(was, n);
        return beats(rival, mine) && rival[0] > mine[0];
      });
    if (found.length === 1 && !rivalled(found[0])) return found[0];
  }
  // The shown block itself changed: it is still the one at its place only when no block
  // was added or taken away and every other block is as it was.
  const othersAsTheyWere = after.length === before.length && after.every((b, i) => i === was || b.text === before[i].text);
  return othersAsTheyWere && after[was].flowchart ? was : -1;
}

/**
 * How many lines read the same going up from block `a` of the lines `x` and from block
 * `b` of the lines `y`, and how many going down from each, until the first that differ.
 * Empty lines are passed over, so a blank line more or less does not decide.
 */
function alikeAround(x: string[], a: Block, y: string[], b: Block): [number, number] {
  const walk = (i: number, j: number, step: number): number => {
    let n = 0;
    for (;;) {
      while (i >= 0 && i < x.length && x[i].trim() === '') i += step;
      while (j >= 0 && j < y.length && y[j].trim() === '') j += step;
      if (i < 0 || j < 0 || i >= x.length || j >= y.length || x[i] !== y[j]) return n;
      n++;
      i += step;
      j += step;
    }
  };
  const below = (blk: Block, lines: string[]) => (blk.close < 0 ? lines.length : blk.close + 1);
  return [walk(a.open - 1, b.open - 1, -1), walk(below(a, x), below(b, y), 1)];
}

/** The file with one block's lines replaced. Lines outside the block are not touched. */
export function replaceBlock(file: string, block: Block, text: string): string {
  const lines = file.split('\n');
  const body = text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const out = body.map((line) => (line === '' ? (block.blankIndented ? block.indent : '') : block.indent + line));
  const end = block.close < 0 ? lines.length : block.close;
  return [...lines.slice(0, block.open + 1), ...out, ...lines.slice(end)].join('\n');
}

/**
 * The file with the block at `index` (among all Mermaid blocks) holding `text`. Checked
 * by reading the result back: the same blocks must be found, and this one must hold
 * exactly the text given. Throws a BlockError, and changes nothing, when it would not.
 */
export function putBlock(file: string, index: number, text: string): string {
  const before = findBlocks(file);
  const block = before[index];
  if (!block) throw new BlockError('The Mermaid block is no longer in the file.');
  if (block.locked) throw new BlockError(`This Mermaid block cannot be changed: ${block.locked}`);
  const want = text === '' || text.endsWith('\n') ? text : text + '\n';
  const next = replaceBlock(file, block, want);
  const after = findBlocks(next);
  const got = after[index];
  if (after.length !== before.length || !got || got.open !== block.open || got.text !== want || got.locked) {
    throw new BlockError('The text holds a line that would end the Mermaid block early (a line of ``` or ~~~).');
  }
  return next;
}
