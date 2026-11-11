// Description blocks: a node's full description, kept in Mermaid comments so the file
// stays a valid Mermaid flowchart. Spec: FILE-FORMAT.md, "Description blocks".
//
//   %% @nodeId
//   %% First line of the description (Markdown).
//   %% .
//   %% A line holding only "." is an empty line.

const HEADER_RE = /^\s*%%\s*@(\S+)\s*$/;
const COMMENT_RE = /^\s*%%(?!\{)(.*)$/;

export interface DescBlock {
  id: string;
  /** Line index of the `%% @id` line. */
  start: number;
  /** Line index after the block's last line. */
  end: number;
  text: string;
}

function decodeLine(body: string): string {
  let s = body.startsWith(' ') ? body.slice(1) : body;
  s = s.replace(/\s+$/, '');
  if (s === '.' || s === '') return '';
  if (s.startsWith('\\@') || /^\\\s+@\S+$/.test(s) || s === '\\.') return s.slice(1);
  return s;
}

function encodeLine(line: string): string {
  const s = line.replace(/\s+$/, '');
  if (s === '') return '%% .';
  // A line that would read as a block's first line (`@id`, spaces in front or not) or
  // as an empty line gets a backslash in front.
  if (/^\s*@\S+$/.test(s) || s === '.') return `%% \\${s}`;
  return `%% ${s}`;
}

export function parseDescriptions(lines: string[]): DescBlock[] {
  const blocks: DescBlock[] = [];
  let i = 0;
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

  // No block yet: add one at the end of the file, after one empty line.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const tail = lines.slice(end);
  const out = lines.slice(0, end);
  if (out.length) out.push('');
  out.push(...blockLines(id, desc, ''));
  out.push(...tail.slice(-1)); // keep the file's final newline as it was
  return out.join('\n');
}

/** Removes a node's description block, if it has one. */
export function removeDescription(text: string, id: string): string {
  return setDescription(text, id, '');
}
