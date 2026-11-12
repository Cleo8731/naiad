// Reads a flowchart file line by line into a model the edits can work on.
// Spec: FILE-FORMAT.md. This is not a full Mermaid parser: a line it cannot read
// with certainty is marked "opaque" and never rewritten (file safety first).

export type LineKind =
  | 'blank' | 'comment' | 'directive' | 'frontmatter' | 'header' | 'subgraph' | 'end'
  | 'direction' | 'statement' | 'style' | 'classDef' | 'class' | 'linkStyle' | 'click'
  | 'acc' | 'string' | 'opaque';

export interface Shape {
  open: string;
  close: string;
  openStart: number;
  innerStart: number;
  innerEnd: number;
  closeEnd: number;
}

export interface NodeRef {
  id: string;
  start: number;
  end: number;
  idEnd: number;
  shape?: Shape;
  attrs?: { start: number; end: number };
  classes: string[];
}

export interface LinkTok { start: number; end: number; raw: string }

export interface Chain {
  start: number;
  end: number;
  groups: NodeRef[][];
  links: LinkTok[];
}

export interface LineInfo {
  kind: LineKind;
  indent: string;
  /** Line index of the enclosing subgraph's `subgraph` line, or -1 at top level. */
  parent: number;
  chains?: Chain[];
  /** For `style`, `class`, `click`: the ids named. For `linkStyle`: the index list. */
  ids?: string[];
  /** For `end`: the line index of the subgraph it closes. */
  closes?: number;
  dir?: string;
}

export interface Sub {
  line: number;
  endLine: number;
  /** Mermaid's id: explicit, or `subGraph<N>` when the line gives only a title. */
  id: string;
  explicitId: boolean;
  title: string;
  /** Line index of the enclosing subgraph, or -1. */
  parent: number;
}

export interface EdgeRef {
  line: number;
  chain: number;
  link: number;
  from: NodeRef;
  to: NodeRef;
}

export interface Problem { line: number; message: string }

export interface Doc {
  lines: string[];
  info: LineInfo[];
  /** Subgraphs in closing order, which is the order Mermaid numbers them in. */
  subs: Sub[];
  /** Edges in the order Mermaid numbers them (used by linkStyle). */
  edges: EdgeRef[];
  header: number;
  /** Lines that stop safe rewriting of the graph (opaque lines, unbalanced blocks). */
  problems: Problem[];
  /** Lines that are legal here but wrong in plain Mermaid (a bare `%%`). */
  warnings: Problem[];
}

const ID_RE = /(?:[\p{L}\p{N}_.]|-(?![>\-.\s]|$))+/uy;
const CLASS_RE = /[\p{L}\p{N}_-]+/uy;
const EDGE_ID_RE = /[\p{L}\p{N}_]+@(?=[<xo]?[-=~.])/uy;

const FULL_LINKS = [/[xo<]?--+[-xo>]/y, /[xo<]?==+[=xo>]/y, /[xo<]?-?\.+-[xo>]?/y, /~~~+/y];
const TEXT_LINKS = [
  { start: /[xo<]?--/y, end: /[xo<]?--+[-xo>]/y },
  { start: /[xo<]?==/y, end: /[xo<]?==+[=xo>]/y },
  { start: /[xo<]?-\./y, end: /[xo<]?-?\.+-[xo>]?/y },
];

/** Bracket pairs, longest opener first. `type` is Mermaid's name for the shape. */
export const SHAPES: { open: string; close: string; type: string; label: string }[] = [
  { open: '(((', close: ')))', type: 'doublecircle', label: 'Double circle' },
  { open: '((', close: '))', type: 'circle', label: 'Circle' },
  { open: '([', close: '])', type: 'stadium', label: 'Stadium' },
  { open: '(-', close: '-)', type: 'ellipse', label: 'Ellipse' },
  { open: '(', close: ')', type: 'round', label: 'Rounded' },
  { open: '[[', close: ']]', type: 'subroutine', label: 'Subroutine' },
  { open: '[(', close: ')]', type: 'cylinder', label: 'Cylinder' },
  { open: '[/', close: '/]', type: 'lean_right', label: 'Parallelogram' },
  { open: '[\\', close: '\\]', type: 'lean_left', label: 'Parallelogram (alt)' },
  { open: '[/', close: '\\]', type: 'trapezoid', label: 'Trapezoid' },
  { open: '[\\', close: '/]', type: 'inv_trapezoid', label: 'Trapezoid (alt)' },
  { open: '[', close: ']', type: 'square', label: 'Rectangle' },
  { open: '{{', close: '}}', type: 'hexagon', label: 'Hexagon' },
  { open: '{', close: '}', type: 'diamond', label: 'Diamond' },
  { open: '>', close: ']', type: 'odd', label: 'Flag' },
];

function skipWs(s: string, p: number): number {
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
  return p;
}

function matchAt(re: RegExp, s: string, p: number): string | null {
  re.lastIndex = p;
  const m = re.exec(s);
  return m ? m[0] : null;
}

function parseShape(s: string, p: number): Shape | null {
  for (const sh of SHAPES) {
    if (!s.startsWith(sh.open, p)) continue;
    const innerStart = p + sh.open.length;
    const c = skipWs(s, innerStart);
    if (s[c] === '"') {
      const q = s.indexOf('"', c + 1);
      if (q < 0) continue;
      const after = skipWs(s, q + 1);
      if (s.startsWith(sh.close, after)) {
        return { open: sh.open, close: sh.close, openStart: p, innerStart, innerEnd: after, closeEnd: after + sh.close.length };
      }
      continue;
    }
    const idx = s.indexOf(sh.close, innerStart);
    if (idx < 0) continue;
    // Take the earliest closer among shapes sharing this opener (`[/x/]` vs `[/x\]`).
    const rival = SHAPES.some((o) => o !== sh && o.open === sh.open && (() => {
      const j = s.indexOf(o.close, innerStart);
      return j >= 0 && j < idx;
    })());
    if (rival) continue;
    const inner = s.slice(innerStart, idx);
    if (inner.includes('"') || inner.trim() === '') continue;
    return { open: sh.open, close: sh.close, openStart: p, innerStart, innerEnd: idx, closeEnd: idx + sh.close.length };
  }
  return null;
}

function parseNodeRef(s: string, p: number): NodeRef | null {
  const id = matchAt(ID_RE, s, p);
  if (!id) return null;
  const idEnd = p + id.length;
  const ref: NodeRef = { id, start: p, end: idEnd, idEnd, classes: [] };
  let q = idEnd;
  if (s.startsWith('@{', q)) {
    let i = q + 2;
    let depth = 1;
    while (i < s.length && depth > 0) {
      if (s[i] === '"') {
        const e = s.indexOf('"', i + 1);
        if (e < 0) return null;
        i = e + 1;
        continue;
      }
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) return null;
    ref.attrs = { start: q, end: i };
    q = i;
  } else {
    const shape = parseShape(s, q);
    if (shape) {
      ref.shape = shape;
      q = shape.closeEnd;
    } else if ('([{>'.includes(s[q] ?? ' ') && s[q] !== undefined) {
      return null; // a bracket we could not read: do not guess
    }
  }
  while (s.startsWith(':::', q)) {
    const cls = matchAt(CLASS_RE, s, q + 3);
    if (!cls) return null;
    ref.classes.push(cls);
    q += 3 + cls.length;
  }
  ref.end = q;
  return ref;
}

function parseLinkTok(s: string, p: number): LinkTok | null {
  let q = p;
  const edgeId = matchAt(EDGE_ID_RE, s, q);
  if (edgeId) q += edgeId.length;
  for (const re of FULL_LINKS) {
    const m = matchAt(re, s, q);
    if (!m) continue;
    let end = q + m.length;
    const a = skipWs(s, end);
    if (s[a] === '|') {
      let i = skipWs(s, a + 1);
      if (s[i] === '"') {
        const e = s.indexOf('"', i + 1);
        if (e < 0) return null;
        i = e + 1;
      }
      const close = s.indexOf('|', i);
      if (close < 0) return null;
      end = close + 1;
    }
    return { start: p, end, raw: s.slice(p, end) };
  }
  for (const t of TEXT_LINKS) {
    const m = matchAt(t.start, s, q);
    if (!m) continue;
    let i = q + m.length;
    const textStart = i;
    while (i < s.length) {
      if (s[i] === '"') {
        const e = s.indexOf('"', i + 1);
        if (e < 0) return null;
        i = e + 1;
        continue;
      }
      const endTok = matchAt(t.end, s, i);
      if (endTok) {
        if (s.slice(textStart, i).trim() === '') return null;
        return { start: p, end: i + endTok.length, raw: s.slice(p, i + endTok.length) };
      }
      i++;
    }
    return null;
  }
  return null;
}

function parseGroup(s: string, p: number): { refs: NodeRef[]; end: number } | null {
  const first = parseNodeRef(s, p);
  if (!first) return null;
  const refs = [first];
  let end = first.end;
  for (;;) {
    const q = skipWs(s, end);
    if (s[q] !== '&') break;
    const next = parseNodeRef(s, skipWs(s, q + 1));
    if (!next) return null;
    refs.push(next);
    end = next.end;
  }
  return { refs, end };
}

/** One or more `;`-separated statements on a line, or null if the line is not one. */
export function tokenizeStatements(s: string): Chain[] | null {
  const chains: Chain[] = [];
  let p = skipWs(s, 0);
  while (p < s.length) {
    const g = parseGroup(s, p);
    if (!g) return null;
    const chain: Chain = { start: p, end: g.end, groups: [g.refs], links: [] };
    for (;;) {
      const q = skipWs(s, chain.end);
      if (q >= s.length || s[q] === ';') break;
      const link = parseLinkTok(s, q);
      if (!link) return null;
      const g2 = parseGroup(s, skipWs(s, link.end));
      if (!g2) return null;
      chain.links.push(link);
      chain.groups.push(g2.refs);
      chain.end = g2.end;
    }
    chains.push(chain);
    p = skipWs(s, chain.end);
    if (s[p] === ';') p = skipWs(s, p + 1);
  }
  return chains.length ? chains : null;
}

const HEADER_RE = /^(flowchart(?:-elk)?|graph)(?:\s+(TB|TD|BT|RL|LR))?\s*;?$/i;
const DIRS = 'TB|TD|BT|RL|LR';

/**
 * A `subgraph` line's id and title, or null when it names nothing. `line` has the spaces
 * before it taken off and those after it kept: Mermaid takes a name written without a
 * title in brackets together with any space after it, up to the line's end or a `;`, and
 * a name holding a space is a title only, the group's id `subGraph<N>` (`subgraph g ` and
 * `subgraph "g" ;` are `subGraph0`, `subgraph g; ` is `g`: bug hunt round 3, A28).
 */
export function parseSubgraphLine(line: string): { id: string | null; title: string } | null {
  const m = /^subgraph\s+(.*?)\s*;?$/.exec(line.trim());
  if (!m || !m[1]) return null;
  const rest = m[1];
  let mm = /^([^\s[\]"]+)\s*\[(.*)\]$/.exec(rest);
  if (mm) return { id: mm[1], title: unquote(mm[2]) };
  const spaced = /\s$/.test(line.replace(/;\s*$/, ''));
  mm = /^"(.*)"$/.exec(rest);
  if (mm) return /\s/.test(mm[1]) || spaced ? { id: null, title: mm[1] } : { id: mm[1], title: mm[1] };
  if (/^[^\s[\]"]+$/.test(rest) && !spaced) return { id: rest, title: rest };
  return { id: null, title: rest };
}

export function unquote(raw: string): string {
  let t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1);
    if (t.length >= 2 && t.startsWith('`') && t.endsWith('`')) t = t.slice(1, -1);
  }
  return t.replace(/#quot;/g, '"');
}

/**
 * An accessible title or description, as Mermaid 12.3's lexer reads one (its first rules,
 * which hold only between statements, never inside a title or a quoted text): `accTitle`
 * or `accDescr`, then `:` and its text, the rest of the line where the next character
 * other than a space stands (`accTitle:::hot` is a title, not a node: bug hunt round 3,
 * A25); or `accDescr`, then `{` and its text, up to the first "}". Each `\s*` runs over
 * line breaks (round 3, A30; round 7, D37: `accDescr` and its `{` on two lines). Matched
 * where a token starts: at a line's start, or after a ";" (round 7, D35). Mermaid reads
 * it once directives and comment lines are gone, so a directive before it on its line
 * leaves it at the line's start (round 7, D36, D37), as `accSeen` lays the lines out.
 */
const ACC_START = /^\s*acc(?:Title|Descr)/;
const ACC_COLON = /acc(?:Title|Descr)\s*:\s*/y;
const ACC_BLOCK = /accDescr\s*\{/y;

/**
 * The column of an accessible title or description after a ";" on a line (as `accSeen`
 * lays it out), or -1. A ";" counts only outside quotes, brackets and an arrow's `|`
 * label, where Mermaid would read it as text; a line whose shapes the count cannot follow
 * is left to the check that fixes compare against.
 */
function accAfterSemicolon(line: string): number {
  let quote = false;
  let depth = 0;
  let pipes = 0;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (ch === '"') quote = !quote;
    else if (quote) continue;
    else if ('[({'.includes(ch)) depth++;
    else if ('])}'.includes(ch)) depth--;
    else if (ch === '|') pipes++;
    else if (ch === ';' && depth === 0 && pipes % 2 === 0) {
      const m = /^\s*acc(?:Title|Descr)/.exec(line.slice(k + 1));
      if (m) return k + 1 + m[0].length - 8;
    }
  }
  return -1;
}

/**
 * The front matter, found as Mermaid finds it (its `frontMatterRegex`, Mermaid 12.3): at
 * the very top of the text, a `---` line, up to the next line that is `---` after
 * exactly the same spaces as the first, which may be any space but a line break (a
 * no-break space too), with a line after it. Mermaid reads it before it drops comments,
 * so all that stands in it is YAML text: no description, no statement (bug hunt round
 * 3, xA23; round 4, A35, A36). The match runs from the top to the closing `---`.
 */
export const FRONT_MATTER_RE = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}(?=\s*[\n\r])/s;

/** The number of lines the front matter takes at the top of `text`; 0 for none. */
export function frontMatterLines(text: string): number {
  const m = FRONT_MATTER_RE.exec(text);
  return m ? m[0].split('\n').length : 0;
}

// Mermaid 12.3's own pattern for a `%%{ ... }%%` directive (`directiveRegex`, used by
// its `removeDirectives`), copied: a directive may run over several lines, and one
// left open runs to the end of the text.
const DIRECTIVE_RE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;

/**
 * The lines of `text` as Mermaid's parser sees them inside `accDescr { ... }`, with the
 * same line breaks: every directive blanked, as Mermaid removes directives before it
 * reads (after the front matter, its `cleanupText` having made every CR a line break),
 * and every comment line (`%%` and at least one more character up to the line break, a
 * U+2028 included) blanked, as its `cleanupComments` drops them next.
 */
function accSeen(text: string, lines: string[], front: number): string[] {
  const from = front ? lines.slice(0, front).join('\n').length + 1 : 0;
  const probe = text.replace(/\r(?!\n)/g, '\n'); // same length: offsets stay
  const chars = text.split('');
  DIRECTIVE_RE.lastIndex = from;
  for (let m = DIRECTIVE_RE.exec(probe); m; m = DIRECTIVE_RE.exec(probe)) {
    if (m[0] === '') { DIRECTIVE_RE.lastIndex++; continue; }
    for (let k = m.index; k < m.index + m[0].length; k++) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
  }
  return chars.join('').split('\n').map((l) => l.replace(/^\s*%%(?!\{)[^\n\r]+/gm, ''));
}

export function parseDoc(text: string): Doc {
  const lines = text.split('\n');
  const front = frontMatterLines(text);
  // The lines as Mermaid's lexer meets them (`accSeen`), one text, made only when the
  // text names an accessible title or description.
  const hasAcc = /acc(?:Title|Descr)/.test(text);
  const seen = hasAcc ? accSeen(text, lines, front) : [];
  const joined = seen.join('\n');
  const starts: number[] = [];
  for (let i = 0, at = 0; i < seen.length; at += seen[i].length + 1, i++) starts.push(at);
  const lineAt = (p: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Lines further on that an accessible text takes, found where it starts.
  const accAhead = new Set<number>();
  /**
   * Whether an accessible title or description starts at column `col` of line `i`; if
   * so, the lines it takes are marked: those of `accTitle`/`accDescr`, its ":" and its
   * text (the lines between them hold nothing for Mermaid, and keep their own kind), or
   * every line up to its "}".
   */
  const accAt = (i: number, col: number): boolean => {
    const p = starts[i] + col;
    ACC_COLON.lastIndex = p;
    const colon = ACC_COLON.exec(joined);
    if (colon) {
      for (let k = i + 1; k <= lineAt(p + colon[0].length); k++) if (seen[k].trim() !== '') accAhead.add(k);
      return true;
    }
    ACC_BLOCK.lastIndex = p;
    const block = ACC_BLOCK.exec(joined);
    if (!block) return false;
    const close = joined.indexOf('}', p + block[0].length);
    const last = close < 0 ? lines.length - 1 : lineAt(close);
    for (let k = i + 1; k <= last; k++) accAhead.add(k);
    return true;
  };
  const info: LineInfo[] = [];
  const subs: Sub[] = [];
  const edges: EdgeRef[] = [];
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  const stack: { line: number; parsed: { id: string | null; title: string } }[] = [];
  let header = -1;
  // Inside a directive that runs over several lines.
  let inDirective = false;
  // Inside a quoted text that runs over several lines: Mermaid reads every line up to
  // the closing quote as part of the text, a "%%" line included.
  let inString = false;
  const opensOrCloses = (line: string) => (line.match(/"/g)?.length ?? 0) % 2 === 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    const parent = stack.length ? stack[stack.length - 1].line : -1;
    const li: LineInfo = { kind: 'opaque', indent, parent };
    info.push(li);

    if (i < front) { li.kind = 'frontmatter'; continue; }
    // A line an accessible text started above takes. Mermaid drops directives, then
    // comment lines (`%%` and at least one more character, not `%%{`), before it reads,
    // so in an accessible text a "}" in either ends nothing (bug hunt round 3, A24; round
    // 6, A43: a directive; D33: a comment line holding a U+2028), and a bare `%%` is its
    // text (round 5, D32, A41).
    if (accAhead.has(i)) { li.kind = 'acc'; continue; }
    if (inDirective) {
      li.kind = 'directive';
      if (t.includes('}%%')) inDirective = false;
      continue;
    }
    if (inString) {
      li.kind = 'string';
      problems.push({ line: i, message: 'A line inside a quoted text that runs over several lines.' });
      if (opensOrCloses(raw)) inString = false;
      continue;
    }
    if (t === '') { li.kind = 'blank'; continue; }
    // `accTitle:` and `accDescr:` hold plain text to the end of the line (`accDescr {` to
    // its "}"), in which a quote opens nothing (bug hunt round 2, A15), nor a "{" (round
    // 3, A23).
    if (hasAcc && ACC_START.test(seen[i]) && accAt(i, seen[i].length - seen[i].trimStart().length)) {
      li.kind = 'acc';
      continue;
    }
    if (t.startsWith('%%{')) {
      li.kind = 'directive';
      if (!t.includes('}%%')) inDirective = true;
      continue;
    }
    if (t.startsWith('%%')) {
      li.kind = 'comment';
      if (t === '%%') {
        warnings.push({ line: i, message: 'A bare "%%" is not a comment in Mermaid (other tools draw it as a node). Write "%% ." for an empty description line.' });
      }
      continue;
    }
    // An accessible text after a statement and a ";" on the same line: Mermaid reads
    // both, which the editor does not (bug hunt round 7, D35).
    if (hasAcc && !(header < 0 && /^(flowchart|graph)\b/i.test(t))) {
      const col = accAfterSemicolon(seen[i]);
      if (col >= 0 && accAt(i, col)) {
        li.kind = 'acc';
        problems.push({ line: i, message: 'A statement and an accessible title or description on one line.' });
        continue;
      }
    }
    if (opensOrCloses(raw)) inString = true;
    if (header < 0 && /^(flowchart|graph)\b/i.test(t)) {
      const m = HEADER_RE.exec(t);
      if (m) { li.kind = 'header'; li.dir = m[2]?.toUpperCase(); header = i; }
      else problems.push({ line: i, message: 'The header line carries more than the diagram type and direction.' });
      continue;
    }
    // Only in lower case, as Mermaid reads them: `END` or `SUBGRAPH` alone is a node (bug hunt A8).
    if (/^subgraph(\s|$)/.test(t)) {
      const parsed = parseSubgraphLine(raw.trimStart());
      if (!parsed) { problems.push({ line: i, message: 'A subgraph line with no name.' }); continue; }
      li.kind = 'subgraph';
      stack.push({ line: i, parsed });
      continue;
    }
    if (/^end\s*;?$/.test(t)) {
      const top = stack.pop();
      if (!top) { problems.push({ line: i, message: 'An "end" with no subgraph to close.' }); continue; }
      li.kind = 'end';
      li.closes = top.line;
      li.parent = stack.length ? stack[stack.length - 1].line : -1;
      const n = subs.length;
      subs.push({
        line: top.line,
        endLine: i,
        id: top.parsed.id ?? `subGraph${n}`,
        explicitId: top.parsed.id !== null,
        title: top.parsed.title,
        parent: li.parent,
      });
      continue;
    }
    let m = new RegExp(`^direction\\s+(${DIRS})\\s*;?$`, 'i').exec(t);
    if (m) { li.kind = 'direction'; li.dir = m[1].toUpperCase(); continue; }

    const chains = tokenizeStatements(raw);
    if (chains) {
      li.kind = 'statement';
      li.chains = chains;
      chains.forEach((ch, ci) => {
        ch.links.forEach((_, k) => {
          for (const from of ch.groups[k]) for (const to of ch.groups[k + 1]) {
            edges.push({ line: i, chain: ci, link: k, from, to });
          }
        });
      });
      continue;
    }
    m = /^style\s+(\S+)\s+\S/.exec(t);
    if (m) { li.kind = 'style'; li.ids = m[1].split(','); continue; }
    if (/^classDef\s+\S+\s+\S/.test(t)) { li.kind = 'classDef'; continue; }
    m = /^class\s+(\S+)\s+\S+\s*;?$/.exec(t);
    if (m) { li.kind = 'class'; li.ids = m[1].split(','); continue; }
    m = /^linkStyle\s+(\S+)\s+\S/.exec(t);
    if (m) { li.kind = 'linkStyle'; li.ids = m[1].split(','); continue; }
    m = /^click\s+(\S+)\s+\S/.exec(t);
    if (m) { li.kind = 'click'; li.ids = [m[1]]; continue; }
    problems.push({ line: i, message: 'A line the editor cannot read with certainty.' });
  }
  for (const s of stack) problems.push({ line: s.line, message: 'A subgraph with no "end".' });
  if (header < 0) problems.push({ line: 0, message: 'No "flowchart" or "graph" header line.' });
  return { lines, info, subs, edges, header, problems, warnings };
}

export function allRefs(doc: Doc): { ref: NodeRef; line: number; chain: number; group: number }[] {
  const out: { ref: NodeRef; line: number; chain: number; group: number }[] = [];
  doc.info.forEach((li, line) => {
    li.chains?.forEach((ch, chain) => ch.groups.forEach((g, group) => g.forEach((ref) => out.push({ ref, line, chain, group }))));
  });
  return out;
}

export function isDecorated(ref: NodeRef): boolean {
  return !!(ref.shape || ref.attrs || ref.classes.length);
}

/** Every id in use: nodes, subgraphs, and ids named by style/class/click lines. */
export function usedIds(doc: Doc): Set<string> {
  const ids = new Set<string>();
  for (const r of allRefs(doc)) ids.add(r.ref.id);
  for (const s of doc.subs) ids.add(s.id);
  for (const li of doc.info) if (li.kind !== 'linkStyle') li.ids?.forEach((x) => ids.add(x));
  return ids;
}

export function findSub(doc: Doc, id: string): Sub | undefined {
  return doc.subs.find((s) => s.id === id);
}

/** The raw label of a node as written (its last labelled mention wins, as in Mermaid). */
export function nodeLabel(doc: Doc, id: string): { title: string; type: string | null } | null {
  const refs = allRefs(doc).filter((r) => r.ref.id === id);
  if (!refs.length) return null;
  let title = id;
  let type: string | null = null;
  for (const r of refs) {
    const line = doc.lines[r.line];
    if (r.ref.shape) {
      title = unquote(line.slice(r.ref.shape.innerStart, r.ref.shape.innerEnd));
      type = SHAPES.find((s) => s.open === r.ref.shape!.open && s.close === r.ref.shape!.close)?.type ?? null;
    } else if (r.ref.attrs) {
      const m = /label:\s*"([^"]*)"/.exec(line.slice(r.ref.attrs.start, r.ref.attrs.end));
      if (m) title = m[1].replace(/#quot;/g, '"');
      type = 'attrs';
    }
  }
  return { title, type };
}
