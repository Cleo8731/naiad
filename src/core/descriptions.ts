// Description blocks: a node's full description, kept in Mermaid comments so the file
// stays a valid Mermaid flowchart. Spec: FILE-FORMAT.md, "Description blocks".
//
//   %% @nodeId
//   %% First line of the description (Markdown).
//   %% .
//   %% A line holding only "." is an empty line.

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

function decodeLine(body: string): string {
  let s = body.startsWith(' ') ? body.slice(1) : body;
  s = s.replace(/\s+$/, '');
  if (s === '.' || s === '') return '';
  if (s.startsWith('\\@') || /^\\\s+@\S+$/.test(s) || s === '\\.') s = s.slice(1);
  return unescapeDirectives(s);
}

function encodeLine(line: string): string {
  const s = line.replace(/\s+$/, '');
  if (s === '') return '%% .';
  // A line that would read as a block's first line (`@id`, spaces in front or not) or
  // as an empty line gets a backslash in front.
  if (/^\s*@\S+$/.test(s) || s === '.') return `%% \\${escapeDirectives(s)}`;
  return `%% ${escapeDirectives(s)}`;
}

/**
 * How many lines the front matter at the top takes, or 0. As Mermaid finds it: a first
 * line `---` (spaces or tabs around it), to the next line that starts with the same
 * spaces and `---` and has a line after it. Mermaid reads the front matter before it
 * drops comments, so a `%%` line in it is YAML text, never part of a description
 * (bug hunt round 3, xA23).
 */
function frontMatterLines(lines: string[]): number {
  const open = /^([ \t]*)---\s*$/.exec(lines[0] ?? '');
  if (!open) return 0;
  for (let k = 1; k < lines.length - 1; k++) {
    if (lines[k].startsWith(open[1] + '---') && /^\s*$/.test(lines[k].slice(open[1].length + 3))) return k + 1;
  }
  return 0;
}

export function parseDescriptions(lines: string[]): DescBlock[] {
  const blocks: DescBlock[] = [];
  let i = frontMatterLines(lines);
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

/** Sets, replaces or (for an empty description) removes a node's description block. */
export function setDescription(text: string, id: string, description: string): string {
  const lines = text.split('\n');
  const desc = description.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
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
      lines.splice(block.start, block.end - block.start, ...blockLines(id, desc, indent));
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
