// Finds the Mermaid blocks inside a Markdown file and puts an edited block back.
// Spec: FILE-FORMAT.md, "A flowchart inside a Markdown file". Text in, text out, no
// browser code. Every line outside the block's own lines is carried over as it is
// (file safety first), and a block that cannot be put back exactly is locked.

import { frontMatterLines } from './scan';

export interface Block {
  /** Line index (from 0) of the opening fence line in the file. */
  open: number;
  /**
   * Line index of the closing fence line; -1 when there is none: the block runs to the
   * end of the file, or of the list item it stands in.
   */
  close: number;
  /** Line index of the first line past the block: after its closing line, or the line that ended its list item, or the number of lines. */
  end: number;
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
  /**
   * Every heading the block stands under, one per level, as one text: two blocks whose
   * nearest headings read alike may stand under different headings above them.
   */
  headings: string;
  /** Why the block can be shown but not changed, or null when it can be changed. */
  locked: string | null;
}

export class BlockError extends Error {}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;

/**
 * The list item line `line` starts, or null. A thematic break written with spaces
 * (`* * *`, `- - -`) is a break, not an item holding one (the CommonMark comparison,
 * T5.16, R4: a heading right under one was taken for the item's, and a block under one
 * ended where the item would have).
 */
function listItem(line: string): RegExpExecArray | null {
  return /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(line) ? null : LIST_ITEM.exec(line);
}

/** How many columns a run of spaces and tabs takes, a tab reaching the next multiple of 4. */
function columns(ws: string): number {
  let w = 0;
  for (const c of ws) w = c === '\t' ? w + 4 - (w % 4) : w + 1;
  return w;
}

type Role = 'item' | 'lazy' | 'other';

/**
 * What `findBlocks` knows of a file's lines as it reads them. `opener[k]` is the opening
 * line of the fenced block line k stands in, or of the HTML block (its opening line
 * too), or -1: a line inside a fenced block or HTML is text, never a list item, so the
 * block's opening line stands for it. `role`, `base` and
 * `itemText` keep what `lineRole`, `fenceBase` and `paragraphItemText` found, and every
 * line up to `known` has its role. Each answer depends only on the line and the lines
 * above it, which are final once `findBlocks` has read past them, so none is worked out
 * twice; without that, the time doubled with each indented list item (bug hunt round 3,
 * B20).
 */
interface Reading {
  lines: string[];
  opener: Int32Array;
  role: (Role | undefined)[];
  /** Each line's indent in columns, -1 for a blank line, -2 not yet worked out. */
  indent: Int32Array;
  /** The column where a list item's text starts, -1 not yet worked out. */
  text: Int32Array;
  known: number;
  base: Map<string, number | null>;
  itemText: Map<number, number | null>;
}

/**
 * The column a fence indented `w` columns on line `at` is measured from: 0 at the
 * margin, or the start of the text of the list item it stands in. Null when it is no
 * fence: Markdown reads a line indented four columns or more past that (at the margin,
 * or past the item's text) as an indented code sample, or as text. Unsure is null.
 * A list item is one only when its own marker stands where a block may start
 * (bug hunt round 2, B10). Every line between the item and the fence must stand in the
 * item: indented to its text at least, or paragraph text going on from the line above
 * (a lazy line); any other line ended the item (bug hunt round 3, B15). Unsure counts
 * as ended: the block is then not found, the safe side.
 */
function fenceBase(r: Reading, at: number, w: number): number | null {
  if (w <= 3) return 0;
  const key = `${at} ${w}`;
  let base = r.base.get(key);
  if (base === undefined) {
    know(r, at - 1);
    base = baseAbove(r, at, w);
    r.base.set(key, base);
  }
  return base;
}

/**
 * The column where the text of the list item that the fence on line `at` (indented `w`
 * columns, measured from `base`) stands in starts; 0 when it stands in none, or when
 * unsure, so that the block then runs on to its closing line, as before (the safe side:
 * its lines are never read as Markdown). A fence three columns in at most has base 0
 * whether it stands in an item or not, so for it the item is looked for apart. An item's
 * text starts two columns in at least.
 */
function itemText(r: Reading, at: number, w: number, base: number): number {
  if (base > 0 || w < 2) return base;
  know(r, at - 1);
  return baseAbove(r, at, w) ?? 0;
}

/**
 * Works out the role of each line not yet known, down to line `to`, first to last: each
 * then finds the lines above it known, so the calls never run deep.
 */
function know(r: Reading, to: number): void {
  while (r.known < to) {
    const k = ++r.known;
    if (r.opener[k] < 0 && r.lines[k].trim() !== '') lineRole(r, k);
  }
}

/** Line k's indent in columns, or -1 when the line is blank. */
function indentOf(r: Reading, k: number): number {
  if (r.indent[k] === -2) r.indent[k] = r.lines[k].trim() === '' ? -1 : columns(/^[ \t]*/.exec(r.lines[k])![0]);
  return r.indent[k];
}

/** `fenceBase`'s work, reading up from line `at`, the roles above it known. */
function baseAbove(r: Reading, at: number, w: number): number | null {
  const { lines, opener } = r;
  let least = Infinity; // the least indent of the lines passed that may have ended an item
  const lazy: [number, number][] = []; // [its indent, the indent of the line above] of the lazy lines passed
  for (let k = at - 1; k >= 0; k--) {
    if (opener[k] >= 0) k = opener[k];
    const lead = indentOf(r, k);
    if (lead < 0) continue;
    const role = lineRole(r, k);
    // An item with nothing on its line and a blank line under it holds nothing (a list
    // item begins with one blank line at most: R6).
    if (role === 'item' && !(emptyItem(listItem(lines[k])!) && indentOf(r, k + 1) < 0)) {
      if (r.text[k] < 0) r.text[k] = textColumn(listItem(lines[k])!);
      const text = r.text[k];
      // A lazy line goes on with a paragraph of the item only if the line above it is
      // no code sample in the item (four columns or more past its text).
      if (w >= text && least >= text && lazy.every(([l, a]) => l >= text || a < text + 4)) {
        return w - text <= 3 ? text : null;
      }
      // Less indented than this item's text, or a line between ended the item: the
      // fence may stand in an item further out.
    } else if (role === 'lazy') {
      lazy.push([lead, indentOf(r, k - 1)]);
      continue;
    }
    if (lead === 0) return null; // at the margin: the fence stands in no list
    least = Math.min(least, lead);
  }
  return null;
}

/**
 * The column where a list item's text starts: one to four spaces past the marker, or one
 * when more, or when nothing follows the marker on its line (the CommonMark comparison,
 * T5.16, R6).
 */
function textColumn(item: RegExpExecArray): number {
  const gap = columns(item[1] + item[2] + item[3]) - columns(item[1] + item[2]);
  return columns(item[1]) + item[2].length + (gap >= 1 && gap <= 4 && !emptyItem(item) ? gap : 1);
}

/** Whether a list item's own line holds nothing past its marker. */
function emptyItem(item: RegExpExecArray): boolean {
  return item.input.slice(item[0].length).trim() === '';
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
function lineRole(r: Reading, k: number): Role {
  return (r.role[k] ??= roleOf(r, k));
}

/** `lineRole`'s work, the first time line k is asked about. */
function roleOf(r: Reading, k: number): Role {
  const line = r.lines[k];
  const para = paragraphAbove(r, k);
  const item = listItem(line);
  // Under paragraph text, a line starting with `=` never ends an item: it is more of the
  // text, or (indented to the item's text) it underlines a heading in the item (the
  // CommonMark comparison, T5.16, R9).
  if (!item) return para === 1 && !FENCE.test(line) && (!BLOCK_START.test(line) || /^[ \t]*=/.test(line)) ? 'lazy' : 'other';
  const lead = columns(item[1]);
  // Right under paragraph text, and indented into the item that text stands in, only a
  // bullet or a 1 with text after it starts a list item; any other is more of the
  // paragraph.
  let starts: boolean | null = true;
  if (para === -1 && !mayInterrupt(line, item)) starts = null;
  else if (para === 1 && !mayInterrupt(line, item)) {
    const text = paragraphItemText(r, k - 1);
    starts = text === null ? null : lead < text;
  }
  if (starts === null) return 'other';
  if (!starts) return 'lazy';
  if (fenceBase(r, k, lead) !== null) return 'item';
  // Its marker is four columns or more past where a block may start: under paragraph
  // text, more of it; else a code sample.
  return para === 1 ? 'lazy' : 'other';
}

/**
 * The column where the text of the list item starts, when the paragraph that line k
 * holds began on that item's own line; Infinity when it stands in a quote (a line
 * without `>` never goes on with it as a list item); null when unsure. The answer is
 * kept for every line of the paragraph walked through.
 */
function paragraphItemText(r: Reading, k: number): number | null {
  const walked: number[] = [];
  let text: number | null | undefined;
  while ((text = r.itemText.get(k)) === undefined) {
    walked.push(k);
    const line = r.lines[k];
    const lead = /^[ \t]*/.exec(line)![0];
    if (line[lead.length] === '>') {
      text = columns(lead) <= 3 ? Infinity : null;
      break;
    }
    const para = paragraphAbove(r, k);
    const item = listItem(line);
    if (item) {
      const rest = line.slice(item[0].length);
      // Maybe more of the paragraph above, or no paragraph at all: unsure.
      if (rest.trim() === '' || (para !== 0 && !mayInterrupt(line, item))) {
        text = null;
        break;
      }
      if (fenceBase(r, k, columns(item[1])) !== null) {
        text = !rest.startsWith('>') ? textColumn(item)
          : columns(item[1] + item[2] + item[3]) - columns(item[1] + item[2]) <= 4 ? Infinity : null;
        break;
      }
      // No list item: more of the paragraph above, if there is one.
    }
    // Began right under an item with nothing on its line, indented to its text: in it (R6).
    const above = para === 0 && k > 0 && r.opener[k - 1] < 0 ? listItem(r.lines[k - 1]) : null;
    if (above && emptyItem(above) && lineRole(r, k - 1) === 'item' && indentOf(r, k) >= textColumn(above)) {
      text = textColumn(above);
      break;
    }
    if (para !== 1) { // began on a line of its own, or unsure
      text = null;
      break;
    }
    k--;
  }
  for (const w of walked) r.itemText.set(w, text);
  return text;
}

/** Whether the line right above line k holds paragraph text: 1 sure, 0 sure not, -1 unsure. */
function paragraphAbove(r: Reading, k: number): 1 | 0 | -1 {
  if (k === 0 || r.opener[k - 1] >= 0) return 0; // nothing above, or a line of a fenced block
  const line = r.lines[k - 1];
  let above = line;
  for (;;) { // take off the quote and list markers the text above stands in
    const m = /^[ \t]*>[ \t]?/.exec(above) ?? listItem(above);
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

const OPEN_TAG = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>`\x00-\x20]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.source;
const CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/.source;

/**
 * CommonMark's seven kinds of HTML block, by the start of the line that opens each (its
 * indent taken off): 1 `<script`, `<pre`, `<style` or `<textarea`; 2 a comment, `<!--`;
 * 3 `<?`; 4 `<!` and a letter; 5 `<![CDATA[`; 6 a block-level tag such as `<div>`,
 * `<details>` or `<p>`, opening or closing; 7 any other whole tag alone on its line.
 * The patterns are the reference reader's (`commonmark`).
 */
const HTML_START = [
  /^<(?:script|pre|textarea|style)(?:\s|>|$)/i,
  /^<!--/,
  /^<[?]/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  /^<[/]?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[123456]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|search|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|[/]?[>]|$)/i,
  new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})\\s*$`, 'i'),
];

/** Where kinds 1 to 5 end: on the line holding this, the opening line included. Kinds 6 and 7 end at a blank line. */
const HTML_END = [/<\/(?:script|pre|textarea|style)>/i, /-->/, /\?>/, />/, /\]\]>/];

/**
 * The line past the HTML block that line i opens, or i when it opens none. Markdown
 * shows the lines of an HTML block as HTML, so a fence or a heading written in them is
 * none (the CommonMark comparison, T5.16, R1: a heading inside `<div>` or `<!--` took
 * the place of the file's own, and a backup under another heading read as standing
 * under the shown block's). Its lines, the first included, are marked as a fenced
 * block's are. It opens where a fence may (`fenceBase`); a whole tag alone on its line
 * (kind 7) cannot interrupt paragraph text, so right under it, it is more of the text
 * (unsure counts as HTML: a block in it is then not found, the safe side). In a list
 * item, it ends with the item, as a fenced block does.
 */
function htmlBlock(r: Reading, i: number): number {
  const line = r.lines[i];
  const lead = /^[ \t]*/.exec(line)![0];
  if (line[lead.length] !== '<') return i;
  const rest = line.slice(lead.length);
  const kind = HTML_START.findIndex((re) => re.test(rest)) + 1;
  if (kind === 0 || (kind === 7 && paragraphAbove(r, i) === 1)) return i;
  const w = columns(lead);
  const base = fenceBase(r, i, w);
  if (base === null) return i;
  const item = itemText(r, i, w, base);
  let end = r.lines.length;
  for (let j = i; j < r.lines.length; j++) {
    const blank = indentOf(r, j) < 0;
    if (j > i && item > 0 && !blank && indentOf(r, j) < item) {
      end = j;
      break;
    }
    if (kind <= 5 ? HTML_END[kind - 1].test(j === i ? rest : r.lines[j]) : j > i && blank) {
      end = kind <= 5 ? j + 1 : j;
      break;
    }
  }
  r.opener.fill(i, i, end);
  return end;
}

/** True when the first line that is not empty, a comment or frontmatter starts a flowchart. */
export function isFlowchartText(text: string): boolean {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  // The front matter as Mermaid finds it: an indented `---` in a YAML text ends nothing
  // (bug hunt round 4, A36).
  i += frontMatterLines(lines.slice(i).join('\n'));
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
  const r: Reading = {
    lines, opener, role: [], indent: new Int32Array(lines.length).fill(-2), text: new Int32Array(lines.length).fill(-1),
    known: -1, base: new Map(), itemText: new Map(),
  };
  let heading = '';
  // The heading at each level, 1 to 6: a heading clears the levels below it.
  const levels: string[] = [];
  const under = (level: number, text: string) => {
    heading = text;
    levels.length = level - 1;
    levels[level - 1] = text;
  };
  const headings = () => Array.from(levels, (t, k) => (t === undefined ? '' : `${k + 1} ${t}`)).filter(Boolean).join('\n');
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
    const base = m && !(m[2][0] === '`' && m[3].includes('`')) ? fenceBase(r, i, columns(m[1])) : null;
    if (!m || base === null) {
      const html = htmlBlock(r, i);
      if (html > i) {
        i = html;
        continue;
      }
      const h = ATX_HEADING.exec(lines[i]);
      if (h) {
        if (!inItem(r, i)) under(h[1].length, atxText(h[2]));
      } else {
        const s = setextHeading(r, i);
        if (s !== null) under(lines[i].trim()[0] === '=' ? 1 : 2, s);
      }
      i++;
      continue;
    }
    const [, indent, fence, info] = m;
    const open = i;
    const item = itemText(r, i, columns(indent), base);
    let close = -1;
    let end = lines.length;
    for (let j = open + 1; j < lines.length; j++) {
      // In a list item, a line indented less than the item's text ends the item, and the
      // block with it: a fenced block takes no lazy lines (bug hunt round 4, B23: a code
      // example below the item was offered as a flowchart).
      if (item > 0 && indentOf(r, j) >= 0 && indentOf(r, j) < item) { end = j; break; }
      const c = FENCE.exec(lines[j]);
      // The closing line may be indented up to three columns past the opening's base, or
      // past the item's text when the block stands in a list item.
      if (c && c[2][0] === fence[0] && c[2].length >= fence.length && c[3].trim() === '' && columns(c[1]) <= item + 3) {
        close = j;
        end = j + 1;
        break;
      }
    }
    opener.fill(open, open + 1, end);
    if (info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
      blocks.push(readBlock(file, lines, open, close, end, indent, heading, headings()));
    }
    i = end;
  }
  return blocks;
}

/**
 * A heading written with "#" (CommonMark's ATX heading): one to six, then a space or tab
 * or the end of the line (`#` alone is an empty heading: bug hunt round 7, B32).
 */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * An ATX heading's text: a closing run of "#" is taken off only after a space or tab
 * (`# Original#` reads "Original#", `# Original #` reads "Original"), or when it is the
 * whole text (bug hunt round 7, B30).
 */
function atxText(text = ''): string {
  return /^#+$/.test(text) ? '' : text.replace(/[ \t]+#+$/, '');
}

/**
 * Whether line k stands in a list item. A heading there is the item's, not the file's:
 * it is not taken among the headings a block stands under (bug hunt round 7, oB30: a
 * level 1 heading in an item took the place of the file's level 1 heading above the
 * list). Only a line indented two columns or more can stand in an item; unsure counts
 * as not in one.
 */
function inItem(r: Reading, k: number): boolean {
  const w = columns(/^[ \t]*/.exec(r.lines[k])![0]);
  return w >= 2 && itemText(r, k, w, 0) > 0;
}

/**
 * A heading or a thematic break (`---` an underline, when under text), its indent taken
 * off: no paragraph goes on past it.
 */
const ENDS_PARAGRAPH = /^(#{1,6}([ \t]|$)|([-*_])([ \t]*\3){2,}[ \t]*$)/;

/**
 * The text of the heading that line i underlines (a `===` or `---` line right under
 * paragraph text), or null. The lines above it, up to a blank line, a block, a heading
 * or a thematic break, are read from the top, as Markdown reads them: a line indented
 * four columns or more is more of the text under text, else a code sample, and the
 * text starts below it (the CommonMark comparison, T5.16, R5). A `===` or `--` line
 * with no text above it is text itself (R7); so is the text under a list item with
 * nothing on its line, when indented less than the item's text (R6). Text standing in a list
 * item, a quote or a table is not taken for one: under it, a `---` is a thematic
 * break, and a `===` more text (in a table, a row). A line starting with `|` is text
 * unless a table starts. Lines of HTML are marked (`htmlBlock`), so the text starts
 * below them; a line starting with `<` that opens no HTML is text (R1). A line shaped
 * like a list item that cannot start one under paragraph text (a number other than 1,
 * or nothing after the marker) is more of the text (bug hunt round 7, B31:
 * `2. continuation`).
 */
function setextHeading(r: Reading, i: number): string | null {
  if (!/^ {0,3}(=+|-+)[ \t]*$/.test(r.lines[i])) return null;
  const lead = (k: number) => /^[ \t]*/.exec(r.lines[k])![0];
  // The first line after the last one that no paragraph goes on past.
  let s = i;
  for (let k = i - 1; k >= 0 && r.opener[k] < 0 && r.lines[k].trim() !== ''; k--) {
    const ws = lead(k);
    if (columns(ws) <= 3) {
      const t = r.lines[k].slice(ws.length);
      if (ENDS_PARAGRAPH.test(t)) break;
      if (t[0] === '>') {
        if (quoteCloses(t)) break;
        return null; // more of the quote, maybe
      }
    }
    s = k;
  }
  // Down from there: the paragraph open on line i, if any, starts on line `start`.
  let start = -1;
  const ended = new Set<number>(); // items with nothing on their line, ended by the line under them
  for (let k = s; k < i; k++) {
    const line = r.lines[k];
    const ws = lead(k);
    if (columns(ws) >= 4) continue; // more text, or a code sample: the text starts below it
    if (start >= 0 && /^(=+|-+)[ \t]*$/.test(line.slice(ws.length))) {
      // An underline: the text above is a heading, and the next starts below it. Under
      // link reference definitions alone, it is text (R7).
      const above = r.lines.slice(start, k).map((l) => l.trim());
      start = definitionLines(above) === above.length ? k : -1;
      continue;
    }
    const item = listItem(line);
    if (item) {
      if (start >= 0 && !mayInterrupt(line, item)) continue; // more of the text
      // An item with nothing on its line holds no text under it indented less than its
      // own text: that line ended it, and any list it stands in (R6).
      if (start < 0 && emptyItem(item) && k + 1 < i && indentOf(r, k + 1) < textColumn(item)) {
        ended.add(k);
        continue;
      }
      return null; // a list item: the lines under it may stand in it
    }
    if (FENCE.test(line)) return null;
    if (start < 0) start = k;
  }
  if (start < 0) return null;
  for (let k = s; k <= start; k++) if (!ended.has(k) && inItem(r, k)) return null;
  if (inItem(r, i)) return null;
  const text = r.lines.slice(start, i).map((l) => l.trim());
  const heading = text.slice(definitionLines(text));
  // A table (GitHub's: a header row over a delimiter row of as many cells) runs on to
  // the underline, which is then a row of it or a thematic break (R3: a line starting
  // with `|` alone made no table, and the heading under it was not read).
  for (let j = 0; j + 1 < heading.length; j++) if (DELIMITER_ROW.test(heading[j + 1]) && cells(heading[j + 1]) === cells(heading[j])) return null;
  return heading.length ? heading.join(' ') : null;
}

/**
 * Whether a quote's line `t` (its indent taken off) leaves no paragraph open in the
 * quote, so that the line under it, without `>`, is no more of the quote: its text, the
 * `>` markers taken off, is blank, a heading, a thematic break or a fence line (the
 * CommonMark comparison, T5.16, R8: the text under `> ---` was not read as a heading).
 * Text, or unsure (a tab, or a line indented four columns or more past the marker:
 * code, or more of the text above), is false.
 */
function quoteCloses(t: string): boolean {
  let rest = t;
  while (rest[0] === '>') {
    rest = rest.slice(rest[1] === ' ' ? 2 : 1);
    if (rest.trim() === '') return true;
    const ws = /^[ \t]*/.exec(rest)![0];
    if (ws.includes('\t') || ws.length >= 4) return false;
    rest = rest.slice(ws.length);
  }
  if (ENDS_PARAGRAPH.test(rest)) return true;
  const f = FENCE.exec(rest);
  return f !== null && !(f[2][0] === '`' && f[3].includes('`'));
}

/** A table's delimiter row (its line under the header row), trimmed: `---`, `:--`, `--:` or `:-:` cells between `|`. */
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?$/;

/** How many cells a table row (trimmed) holds: split at each `|` not escaped, a leading and a trailing `|` taken off. */
function cells(row: string): number {
  return row.replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1').split(/(?<!\\)\|/).length;
}

/**
 * A link reference definition at the start of a text: `[label]: destination`, with a
 * title in quotes or brackets if any, over one line or more, and nothing after it on its
 * last line. The patterns follow the reference reader's (`commonmark`).
 */
const LINK_DEFINITION = new RegExp(
  /^\[((?:[^[\]\\]|\\.){0,999})\]:[ \t]*\n?[ \t]*/.source +
  /(?:<(?:[^<>\n\\]|\\.)*>|(?!<)(?:[^\x00-\x20()\\]|\\[^\x00-\x20]?|\((?:[^\x00-\x20()\\]|\\[^\x00-\x20]?)*\))+)/.source +
  /(?:(?:[ \t]+|[ \t]*\n[ \t]*)(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\((?:[^()\\]|\\[\s\S])*\)))?[ \t]*(?:\n|$)/.source,
);

/**
 * How many of a paragraph's first lines (`text`, each trimmed) are link reference
 * definitions: Markdown takes them out of the paragraph, so they are no heading's text,
 * and under them alone a `---` is a thematic break (the CommonMark comparison, T5.16,
 * R2: `[ref]: /url` over `---` was read as a heading, and took the place of the file's
 * own at its level).
 */
function definitionLines(text: string[]): number {
  let used = 0;
  for (;;) {
    const m = LINK_DEFINITION.exec(text.slice(used).join('\n'));
    if (!m || !/\S/.test(m[1])) return used;
    used += m[0].replace(/\n$/, '').split('\n').length;
  }
}

function readBlock(file: string, lines: string[], open: number, close: number, end: number, indent: string, heading: string, headings: string): Block {
  const content = lines.slice(open + 1, close < 0 ? end : close);
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
    open, close, end, indent, blankIndented: indentedBlank > 0 && plainBlank === 0, text,
    flowchart: isFlowchartText(text), heading, headings, locked: null,
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
    // Nor is it certain when another block reads more like the shown block's place, above
    // it (where its heading is) and no less below, or as much above and more below: the
    // shown block may have been changed there, and its old text kept elsewhere as a
    // backup (round 3, B13), whatever text it was changed to, another block's included
    // (round 4, B22), and another block may have been changed to its text under the same
    // heading (round 7, B29). Lines alike below decide only beside lines alike above: a
    // block added right below a shown block with nothing alike above has them too.
    const rivalled = (n: number) =>
      after.some((_, i) => {
        const rival = around(was, i);
        const mine = around(was, n);
        return beats(rival, mine) && (rival[0] > mine[0] || mine[0] > 0);
      });
    // Nor when the block holding the text stands under other headings than the shown
    // block did: the shown block may have been changed in place, the text around it too,
    // and its old text kept elsewhere with the old text below (round 5, B25), its
    // heading renamed at once (round 6, B28). Every heading above it is compared, not the
    // nearest only (B26). Lines alike above alone do not decide this: they may be lines
    // any two blocks have between them.
    const moved = (n: number) => after[n].headings !== shown.headings;
    // Nor when no block was added or taken away, the block holding the text stands at
    // another place in their order, and the block at the shown block's place stands under
    // its headings and reads as much like that place above: the shown block may have been
    // changed there, the text around it too, and another block changed to its old text
    // (round 7, B29).
    const displaced = (n: number) =>
      after.length === before.length && n !== was && after[was].headings === shown.headings && around(was, was)[0] >= around(was, n)[0];
    if (found.length === 1 && !rivalled(found[0]) && !moved(found[0]) && !displaced(found[0])) return found[0];
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
  return [walk(a.open - 1, b.open - 1, -1), walk(a.end, b.end, 1)];
}

/** The file with one block's lines replaced. Lines outside the block are not touched. */
export function replaceBlock(file: string, block: Block, text: string): string {
  const lines = file.split('\n');
  const body = text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const out = body.map((line) => (line === '' ? (block.blankIndented ? block.indent : '') : block.indent + line));
  return [...lines.slice(0, block.open + 1), ...out, ...lines.slice(block.close < 0 ? block.end : block.close)].join('\n');
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
