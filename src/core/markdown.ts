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
    if (!m || (m[2][0] === '`' && m[3].includes('`'))) {
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
      if (c && c[2][0] === fence[0] && c[2].length >= fence.length && c[3].trim() === '') { close = j; break; }
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
 * file's Mermaid blocks `after`, or -1 when it cannot be told for certain. `before` are
 * the blocks as Naiad last read or wrote them, `was` the shown block's index then.
 * Never a guess: a wrong answer would show another flowchart, and Undo would write the
 * shown one's old text into it.
 */
export function findAgain(before: Block[], after: Block[], was: number): number {
  const saved = before[was]?.text;
  if (after[was]?.text === saved) return was;
  const same = after.flatMap((b, i) => (b.text === saved ? [i] : []));
  if (same.length === 1) return same[0]; // unchanged, and moved by a block added or removed above it
  // The shown block itself changed: it is still the one at its place only when no block
  // was added or taken away and every other block is as it was.
  const othersAsTheyWere = after.length === before.length && after.every((b, i) => i === was || b.text === before[i].text);
  return othersAsTheyWere && after[was].flowchart ? was : -1;
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
