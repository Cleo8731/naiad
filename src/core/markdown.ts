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
 */
function fenceBase(lines: string[], at: number, w: number): number | null {
  if (w <= 3) return 0;
  for (let k = at - 1; k >= 0; k--) {
    const line = lines[k];
    if (line.trim() === '') continue;
    const item = LIST_ITEM.exec(line);
    const lead = columns(/^[ \t]*/.exec(line)![0]);
    if (item) {
      const gap = columns(item[1] + item[2] + item[3]) - columns(item[1] + item[2]);
      const text = columns(item[1]) + item[2].length + (gap >= 1 && gap <= 4 ? gap : 1);
      if (w >= text) return w - text <= 3 ? text : null;
      // Less indented than this item's text: it may stand in an item further out.
    }
    if (lead === 0) return null; // text at the margin: the fence stands in no list
  }
  return null;
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
    const base = m && !(m[2][0] === '`' && m[3].includes('`')) ? fenceBase(lines, i, columns(m[1])) : null;
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
  if (same.length === 1) return same[0]; // unchanged, and moved by a block added or removed above it
  if (same.length > 1) {
    // Several blocks hold its text (a copy was written beside it, bug hunt round 2 B8):
    // the one whose surrounding lines read most like the shown block's did, when exactly
    // one does. A tie, or no line alike, is not certain.
    const old = beforeFile.split('\n');
    const now = afterFile.split('\n');
    const scores = same.map((i) => alikeAround(old, shown, now, after[i]));
    const best = Math.max(...scores);
    return best > 0 && scores.filter((s) => s === best).length === 1 ? same[scores.indexOf(best)] : -1;
  }
  // The shown block itself changed: it is still the one at its place only when no block
  // was added or taken away and every other block is as it was.
  const othersAsTheyWere = after.length === before.length && after.every((b, i) => i === was || b.text === before[i].text);
  return othersAsTheyWere && after[was].flowchart ? was : -1;
}

/**
 * How many lines read the same going up from block `a` of the lines `x` and from block
 * `b` of the lines `y`, then going down from each, until the first that differ. Empty
 * lines are passed over, so a blank line more or less does not decide.
 */
function alikeAround(x: string[], a: Block, y: string[], b: Block): number {
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
  return walk(a.open - 1, b.open - 1, -1) + walk(below(a, x), below(b, y), 1);
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
