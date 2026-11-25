/**
 * The Syntax pane's colours (the user, 2026-11-25): each line of a flowchart's text cut
 * into pieces, each piece with its kind, which the pane draws in its own colour. Only
 * for showing: the text itself is never changed, and a line this does not understand is
 * drawn plain, piece by piece, so every character is always there once and in order.
 */

export type Kind =
  | 'plain'
  | 'keyword' // flowchart, graph, subgraph, end, direction, classDef, class, style, linkStyle, click
  | 'direction' // TD, LR... after `flowchart` or `direction`
  | 'id' // a node's or a group's id
  | 'title' // a node's title, inside its brackets
  | 'bracket' // the brackets of a node's shape, `&`, `:::`
  | 'arrow' // -->, ---, -.->, ==> and the like, and the pipes of `|label|`
  | 'label' // an arrow's label
  | 'class' // a class name after `:::`
  | 'prop' // a style's property name, `fill` in `fill:#fde`
  | 'value' // a style's value, `#fde`
  | 'comment' // the `%%` of a comment, or a comment that is no description
  | 'mark' // `@id` at a description's start
  | 'desc'; // a description's text

export interface Piece { text: string; kind: Kind }

const KEYWORDS = new Set(['subgraph', 'end', 'direction', 'classDef', 'class', 'style', 'linkStyle', 'click']);
const DIRECTIONS = /^(?:TB|TD|BT|RL|LR)\b/;
/** A node's shapes, longest opening first, each with the closings that may end it. */
const SHAPES: [string, string[]][] = [
  ['(((', [')))']], ['((', ['))']], ['([', ['])']], ['[[', [']]']], ['[(', [')]']], ['{{', ['}}']],
  ['[/', ['/]', '\\]']], ['[\\', ['\\]', '/]']], ['(', [')']], ['[', [']']], ['{', ['}']],
];
/** An arrow with its label inside it, `-- yes -->`: the opening, the label, the rest. */
const LABELLED = /^(--|==|-\.)( +)([^\s>].*?)( +)(-{2,}>|-{3,}|={2,}>|={3,}|\.+->|\.+-|-{2,}[ox]|={2,}[ox])/;
const ARROW = /^(?:<|[ox](?=--|==))?(?:-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-|-{2,}[ox]\b|={2,}[ox]\b|~~~)/;
/** An id or a word: a hyphen only between letters, so `a-->b` is `a`, an arrow and `b`. */
const WORD = /^[\p{L}\p{N}_]+(?:-(?![-.>=])[\p{L}\p{N}_]+)*/u;

/** The pieces of every line of `text`, one array per line. */
export function colourLines(text: string): Piece[][] {
  let inDescription = false;
  return text.split('\n').map((line) => {
    const comment = /^(\s*)(%%)(.*)$/.exec(line);
    if (!comment) { inDescription = false; return statement(line); }
    const [, lead, marks, rest] = comment;
    const start = /^(\s*)(@\S+)(.*)$/.exec(rest);
    if (start) {
      inDescription = true;
      return join([{ text: lead, kind: 'plain' }, { text: marks, kind: 'comment' }, { text: start[1], kind: 'plain' }, { text: start[2], kind: 'mark' }, { text: start[3], kind: 'desc' }]);
    }
    return join([{ text: lead, kind: 'plain' }, { text: marks, kind: 'comment' }, { text: rest, kind: inDescription ? 'desc' : 'comment' }]);
  });
}

/** The pieces of a line that is no comment: a header, a statement or a blank line. */
function statement(line: string): Piece[] {
  const out: Piece[] = [];
  const push = (text: string, kind: Kind) => { if (text) out.push({ text, kind }); };
  let rest = line;
  let first = true; // the line's first word
  let style = false; // a classDef, style or linkStyle line: properties and values follow
  let afterId = false; // the last piece was an id, so a bracket opens its shape
  while (rest) {
    const space = /^\s+/.exec(rest);
    if (space) { push(space[0], 'plain'); rest = rest.slice(space[0].length); continue; }
    if (first) {
      const head = /^(flowchart|graph)\b(\s+)?/.exec(rest);
      if (head) {
        push(head[1], 'keyword');
        rest = rest.slice(head[1].length);
        first = false;
        continue;
      }
    }
    const dir = DIRECTIONS.exec(rest);
    if (dir && out.some((p) => p.kind === 'keyword' && /^(flowchart|graph|direction)$/.test(p.text)) && !out.some((p) => p.kind === 'direction')) {
      push(dir[0], 'direction'); rest = rest.slice(dir[0].length); continue;
    }
    if (style) {
      const prop = /^([\w-]+)(:)([^,;]*)/.exec(rest);
      if (prop) { push(prop[1], 'prop'); push(prop[2], 'bracket'); push(prop[3], 'value'); rest = rest.slice(prop[0].length); continue; }
    }
    const word = WORD.exec(rest);
    if (word && first && KEYWORDS.has(word[0])) {
      push(word[0], 'keyword');
      style = ['classDef', 'style', 'linkStyle'].includes(word[0]);
      rest = rest.slice(word[0].length); first = false; afterId = false;
      continue;
    }
    if (rest.startsWith(':::')) {
      push(':::', 'bracket');
      const name = /^[\w-]+/.exec(rest.slice(3));
      push(name?.[0] ?? '', 'class');
      rest = rest.slice(3 + (name?.[0].length ?? 0));
      afterId = false;
      continue;
    }
    const labelled = LABELLED.exec(rest);
    if (labelled) {
      push(labelled[1], 'arrow'); push(labelled[2], 'plain'); push(labelled[3], 'label'); push(labelled[4], 'plain'); push(labelled[5], 'arrow');
      rest = rest.slice(labelled[0].length); first = false; afterId = false;
      continue;
    }
    const arrow = ARROW.exec(rest);
    if (arrow) { push(arrow[0], 'arrow'); rest = rest.slice(arrow[0].length); first = false; afterId = false; continue; }
    if (rest[0] === '|') {
      const end = rest.indexOf('|', 1);
      if (end > 0) {
        push('|', 'arrow'); push(rest.slice(1, end), 'label'); push('|', 'arrow');
        rest = rest.slice(end + 1); afterId = false;
        continue;
      }
    }
    if (afterId) {
      const shape = shapeAt(rest);
      if (shape) {
        for (const p of shape.pieces) push(p.text, p.kind);
        rest = rest.slice(shape.length); afterId = false;
        continue;
      }
    }
    if (word) { push(word[0], style && out.find((p) => p.kind === 'keyword')?.text === 'classDef' ? 'class' : 'id'); rest = rest.slice(word[0].length); first = false; afterId = !style; continue; }
    push(rest[0], rest[0] === '&' ? 'bracket' : 'plain');
    rest = rest.slice(1); first = false; afterId = false;
  }
  return join(out);
}

/** A node's shape at the start of `text`: its opening, title and closing; null if none closes. */
function shapeAt(text: string): { pieces: Piece[]; length: number } | null {
  const asym = text[0] === '>' ? ['>', [']']] as const : null;
  for (const [open, closes] of asym ? [asym] : SHAPES) {
    if (!text.startsWith(open)) continue;
    const inner = text.slice(open.length);
    // A quoted title runs to its closing quote, whatever brackets it holds.
    const quoted = /^"[^"]*"/.exec(inner);
    const from = quoted ? quoted[0].length : 0;
    let at = -1, close = '';
    for (const c of closes) {
      const i = inner.indexOf(c, from);
      if (i >= 0 && (at < 0 || i < at)) { at = i; close = c; }
    }
    if (at < 0) return null;
    return {
      pieces: [{ text: open, kind: 'bracket' }, { text: inner.slice(0, at), kind: 'title' }, { text: close, kind: 'bracket' }],
      length: open.length + at + close.length,
    };
  }
  return null;
}

/** Joins neighbouring pieces of one kind and drops empty ones. */
function join(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (!p.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/** The pane's drawing of `text`: one element a line, its pieces in coloured spans. */
export function colouredHtml(text: string): string {
  return colourLines(text)
    .map((pieces) => `<div class="ln">${pieces.map((p) => (p.kind === 'plain' ? escape(p.text) : `<span class="s-${p.kind}">${escape(p.text)}</span>`)).join('')}</div>`)
    .join('');
}
