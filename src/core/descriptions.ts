// Description blocks: a node's full description, kept in Mermaid comments so the file
// stays a valid Mermaid flowchart. Spec: FILE-FORMAT.md, "Description blocks".
//
//   %% @nodeId
//   %% First line of the description (Markdown).
//   %% .
//   %% A line holding only "." is an empty line.

import { matchLines } from './endings';
import { frontMatterLines } from './scan';

const HEADER_RE = /^\s*%%\s*@(\S+)\s*$/;
// `s`: a line may hold U+2028 or U+2029, which `.` would not match; Mermaid reads them
// as part of the comment (bug hunt round 3, C37).
const COMMENT_RE = /^\s*%%(?!\{)(.*)$/s;

export interface DescBlock {
  id: string;
  /** Line index of the `%% @id` line. */
  start: number;
  /** Line index after the block's last line. */
  end: number;
  text: string;
}

// Mermaid reads `%%{` anywhere in the file as the start of a directive that sets the
// chart's settings, inside a comment line too (bug hunt A7). In a description it is
// written `%%\{`; where backslashes already stand between `%%` and `{`, one more is
// added. Reading takes one off, so every text reads back exactly as it was written.
const escapeDirectives = (s: string): string => s.replace(/%%(\\*)\{/g, '%%\\$1{');
const unescapeDirectives = (s: string): string => s.replace(/%%\\(\\*)\{/g, '%%$1{');

// One space after `%%` is dropped; the rest of the line is the text, spaces at its end
// too (a Markdown line break; bug hunt round 5, A40). Whether a line is empty, or a
// form with a backslash in front, is judged without the spaces at its end.
function decodeLine(body: string): string {
  let s = body.startsWith(' ') ? body.slice(1) : body;
  const t = s.replace(/\s+$/, '');
  if (t === '.' || t === '') return '';
  if (t.startsWith('\\@') || /^\\\s+@\S+$/.test(t) || t === '\\.') s = s.slice(1);
  return unescapeDirectives(s);
}

function encodeLine(line: string): string {
  const t = line.replace(/\s+$/, '');
  if (t === '') return '%% .';
  // A line that would read as a block's first line (`@id`, spaces in front or not) or
  // as an empty line gets a backslash in front.
  if (/^\s*@\S+$/.test(t) || t === '.') return `%% \\${escapeDirectives(line)}`;
  return `%% ${escapeDirectives(line)}`;
}

export function parseDescriptions(lines: string[]): DescBlock[] {
  const blocks: DescBlock[] = [];
  // Mermaid reads the front matter before it drops comments, so a `%%` line in it is
  // YAML text, never part of a description (bug hunt round 3, xA23; round 4, A35).
  let i = frontMatterLines(lines.join('\n'));
  while (i < lines.length) {
    const h = HEADER_RE.exec(lines[i]);
    if (!h) { i++; continue; }
    const start = i;
    const body: string[] = [];
    i++;
    while (i < lines.length && !HEADER_RE.test(lines[i])) {
      const c = COMMENT_RE.exec(lines[i]);
      if (!c) break;
      body.push(decodeLine(c[1]));
      i++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    while (body.length && body[0] === '') body.shift();
    blocks.push({ id: h[1], start, end: i, text: body.join('\n') });
  }
  return blocks;
}

/** True for a line that, written directly under a description block, becomes part of it. */
export function joinsBlock(line: string): boolean {
  return !HEADER_RE.test(line) && COMMENT_RE.test(line);
}

/** Every description by node id. When an id has two blocks, the first one wins. */
export function getDescriptions(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of parseDescriptions(text.split('\n'))) if (!map.has(b.id)) map.set(b.id, b.text);
  return map;
}

function blockLines(id: string, desc: string, indent: string): string[] {
  return [`${indent}%% @${id}`, ...desc.split('\n').map((l) => indent + encodeLine(l))];
}

/**
 * A block's lines (`old`, its first line included) for a new description. The first line,
 * and each line whose text is the same as a line of the new description, stay as they
 * were written, wherever the line moves; a changed or added line is written in Naiad's
 * spelling with the first line's indent. Empty lines at the block's start and end are not
 * part of the text, and stay too (bug hunt round 6, A42).
 */
function rewriteBlock(old: string[], desc: string, indent: string): string[] {
  const body = old.slice(1);
  const read = body.map((l) => decodeLine(COMMENT_RE.exec(l)![1]));
  let from = 0;
  while (from < read.length && read[from] === '') from++;
  let to = read.length;
  while (to > from && read[to - 1] === '') to--;
  const want = desc.split('\n');
  const was = read.slice(from, to);
  const same = matchLines(was, want);
  // Lines are matched in their order first; a line moved past another is then matched
  // by its text alone, so that it keeps its spelling too (bug hunt round 7, A44). Each old
  // line is taken once, the copies of a repeated line in their order.
  const taken = new Set(same);
  const free = new Map<string, number[]>();
  was.forEach((l, k) => {
    if (taken.has(k)) return;
    const copies = free.get(l);
    if (copies) copies.push(k);
    else free.set(l, [k]);
  });
  for (let j = 0; j < want.length; j++) {
    const k = same[j] < 0 ? free.get(want[j])?.shift() : undefined;
    if (k !== undefined) same[j] = k;
  }
  const middle = want.map((l, j) => (same[j] >= 0 ? body[from + same[j]] : indent + encodeLine(l)));
  return [old[0], ...body.slice(0, from), ...middle, ...body.slice(to)];
}

/** Sets, replaces or (for an empty description) removes a node's description block. */
export function setDescription(text: string, id: string, description: string): string {
  const lines = text.split('\n');
  // Empty lines at the end go; the last line keeps the spaces at its end (A40).
  const lf = description.replace(/\r\n?/g, '\n');
  const desc = lf.trim() === '' ? '' : lf.replace(/^\n+/, '').replace(/(?:\n\s*)+$/, '');
  const block = parseDescriptions(lines).find((b) => b.id === id);

  if (block) {
    const indent = /^\s*/.exec(lines[block.start])![0];
    if (desc === '') {
      let from = block.start;
      let count = block.end - block.start;
      // Take one neighbouring blank line with the block, so blank lines do not pile up.
      if (from > 0 && lines[from - 1].trim() === '' && (block.end >= lines.length || lines[block.end].trim() === '')) {
        from--;
        count++;
      }
      lines.splice(from, count);
    } else {
      lines.splice(block.start, block.end - block.start, ...rewriteBlock(lines.slice(block.start, block.end), desc, indent));
    }
    return lines.join('\n');
  }
  if (desc === '') return text;

  // No block yet: add one at the end of the file, after every line already there (blank
  // lines included), with one empty line before it unless a blank line is there already.
  // The file's final newline stays as it was.
  const at = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const add = blockLines(id, desc, '');
  if (at > 0 && lines[at - 1].trim() !== '') add.unshift('');
  lines.splice(at, 0, ...add);
  return lines.join('\n');
}

/** Removes a node's description block, if it has one. */
export function removeDescription(text: string, id: string): string {
  return setDescription(text, id, '');
}
