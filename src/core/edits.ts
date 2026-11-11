// Every change the app makes to a flowchart file, as text in, text out.
// Each edit rewrites only the lines it must; a line the scanner could not read is never
// touched. The app checks every result against Mermaid's own parser before saving it
// (src/verify.ts), so an edit that would change anything else is refused.

import {
  allRefs, findSub, isDecorated, parseDoc, SHAPES, unquote, usedIds,
  type Chain, type Doc, type LinkTok, type NodeRef, type Sub,
} from './scan';
import { parseDescriptions, removeDescription } from './descriptions';

export class EditError extends Error {}

const ID_OK = /^(?:[\p{L}\p{N}_.]|-(?![>\-.\s]|$))+$/u;
const SAFE_LABEL = /^[\p{L}\p{N}_][\p{L}\p{N}_ .,?!]*$/u;
const KEYWORDS = /\b(end|subgraph|graph|flowchart|style|class|classDef|click|linkStyle|direction|default|call|href)\b/i;

/** A label as it must be written inside brackets or pipes. */
export function encodeLabel(title: string, forceQuotes = false): string {
  const t = title.replace(/\r?\n/g, '<br/>').trim();
  if (!forceQuotes && SAFE_LABEL.test(t) && !KEYWORDS.test(t)) return t;
  return `"${t.replace(/"/g, '#quot;')}"`;
}

function load(text: string): Doc {
  const doc = parseDoc(text);
  if (doc.problems.length) {
    const p = doc.problems[0];
    throw new EditError(`Line ${p.line + 1}: ${p.message} Change it in the text pane; the chart cannot edit this file safely until then.`);
  }
  return doc;
}

// ---------------------------------------------------------------- patching lines

interface Piece {
  text: string;
  ids: string[];
  /** A bare mention kept only if the node would otherwise lose its place. */
  optional?: boolean;
}

class Rewriter {
  private repl = new Map<number, Piece[]>();
  private after = new Map<number, { pieces: Piece[]; parent: number }[]>();
  constructor(readonly doc: Doc) {}

  replace(line: number, pieces: Piece[]): void { this.repl.set(line, pieces); }
  remove(line: number): void { this.repl.set(line, []); }
  setLine(line: number, text: string): void { this.repl.set(line, [{ text, ids: [] }]); }
  insertAfter(line: number, pieces: Piece[], parent: number): void {
    const list = this.after.get(line) ?? [];
    list.push({ pieces, parent });
    this.after.set(line, list);
  }

  finish(): string {
    const { doc } = this;
    const subIds = new Set(doc.subs.map((s) => s.id));
    const keptAt = new Map<number, Set<string>>();
    const keptAny = new Set<string>();
    const keep = (parent: number, id: string) => {
      keptAny.add(id);
      if (!keptAt.has(parent)) keptAt.set(parent, new Set());
      keptAt.get(parent)!.add(id);
    };
    doc.info.forEach((li, i) => {
      if (this.repl.has(i)) return;
      li.chains?.forEach((ch) => ch.groups.forEach((g) => g.forEach((r) => keep(li.parent, r.id))));
    });
    const groups: { pieces: Piece[]; parent: number }[] = [];
    for (const [i, pieces] of this.repl) groups.push({ pieces, parent: doc.info[i].parent });
    for (const list of this.after.values()) groups.push(...list);
    for (const g of groups) for (const p of g.pieces) if (!p.optional) p.ids.forEach((id) => keep(g.parent, id));

    const decide = (pieces: Piece[], parent: number): string[] => {
      const out: string[] = [];
      for (const p of pieces) {
        if (p.optional) {
          const id = p.ids[0];
          if (subIds.has(id)) continue;
          if (keptAt.get(parent)?.has(id) || (parent === -1 && keptAny.has(id))) continue;
          keep(parent, id);
        }
        out.push(p.text);
      }
      return out;
    };

    const out: string[] = [];
    const emitAfter = (i: number) => {
      for (const g of this.after.get(i) ?? []) out.push(...decide(g.pieces, g.parent));
    };
    emitAfter(-1);
    doc.lines.forEach((line, i) => {
      const r = this.repl.get(i);
      if (r) out.push(...decide(r, doc.info[i].parent));
      else out.push(line);
      emitAfter(i);
    });
    return out.join('\n');
  }
}

function refRaw(line: string, ref: NodeRef): string { return line.slice(ref.start, ref.end); }

/** Prints part of a chain as lines, splitting it where a group empties or a link is cut. */
function rebuild(
  line: string, indent: string, groups: NodeRef[][], links: LinkTok[],
  drop: (r: NodeRef) => boolean = () => false, cut: Set<number> = new Set(),
): Piece[] {
  const kept = groups.map((g) => g.filter((r) => !drop(r)));
  const pieces: Piece[] = [];
  let i = 0;
  while (i < kept.length) {
    if (!kept[i].length) { i++; continue; }
    let j = i;
    while (j + 1 < kept.length && kept[j + 1].length && !cut.has(j)) j++;
    if (j === i) {
      for (const r of kept[i]) {
        pieces.push(isDecorated(r)
          ? { text: indent + refRaw(line, r), ids: [r.id] }
          : { text: indent + r.id, ids: [r.id], optional: true });
      }
    } else {
      let text = indent;
      const ids: string[] = [];
      for (let k = i; k <= j; k++) {
        if (k > i) text += ` ${links[k - 1].raw} `;
        text += kept[k].map((r) => refRaw(line, r)).join(' & ');
        kept[k].forEach((r) => ids.push(r.id));
      }
      pieces.push({ text, ids });
    }
    i = j + 1;
  }
  return pieces;
}

function chainPiece(line: string, indent: string, ch: Chain): Piece {
  return { text: indent + line.slice(ch.start, ch.end), ids: ch.groups.flat().map((r) => r.id) };
}

/** Where a new top-level statement goes: after the last top-level statement or block. */
function topInsertLine(doc: Doc): number {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const li = doc.info[i];
    if (li.parent === -1 && (li.kind === 'statement' || li.kind === 'end')) return i;
  }
  return doc.header;
}

function lastStructuralLine(doc: Doc): number {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const k = doc.info[i].kind;
    if (k !== 'blank' && k !== 'comment') return i;
  }
  return doc.header;
}

function topIndent(doc: Doc): string {
  const li = doc.info.find((x) => x.parent === -1 && (x.kind === 'statement' || x.kind === 'subgraph'));
  return li ? li.indent : '    ';
}

function innerIndent(doc: Doc, sub: Sub): string {
  for (let i = sub.line + 1; i < sub.endLine; i++) {
    const li = doc.info[i];
    if (li.parent === sub.line && li.kind !== 'blank' && li.kind !== 'comment') return li.indent;
  }
  const unit = topIndent(doc) || '  ';
  return doc.info[sub.line].indent + unit;
}

/** An id no node, group or description block has. A block whose id matches no node is
 * kept for later (FILE-FORMAT.md, rule 8): a new node or group must not take it. */
function newId(doc: Doc, prefix: string): string {
  const used = usedIds(doc);
  for (const block of parseDescriptions(doc.lines)) used.add(block.id);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

function requireNode(doc: Doc, id: string) {
  const refs = allRefs(doc).filter((r) => r.ref.id === id);
  if (!refs.length) throw new EditError(`"${id}" is not written as a node in this file.`);
  return refs;
}

// ---------------------------------------------------------------- linkStyle indexes

/**
 * Keeps `linkStyle` lines pointing at the same edges after edges move or go. An edge is
 * found again by its two ends and its arrow as written; an edge whose arrow the edit
 * rewrote, by its two ends alone, in order. Edges alike in both are alike to Mermaid, so
 * which of them a line lands on changes nothing.
 */
function fixLinkStyles(oldDoc: Doc, newText: string, removed: Set<number> = new Set()): string {
  if (!oldDoc.info.some((li) => li.kind === 'linkStyle' && li.ids!.some((x) => /^\d+$/.test(x)))) return newText;
  const newDoc = parseDoc(newText);
  type EdgeAt = Doc['edges'][number];
  const ends = (e: EdgeAt) => `${e.from.id}\u0000${e.to.id}`;
  const written = (doc: Doc) => (e: EdgeAt) => `${ends(e)}\u0000${doc.info[e.line].chains![e.chain].links[e.link].raw.trim()}`;
  const map = new Map<number, number>();
  const taken = new Set<number>();
  for (const [oldKey, newKey] of [[written(oldDoc), written(newDoc)], [ends, ends]]) {
    const slots = new Map<string, number[]>();
    newDoc.edges.forEach((e, i) => {
      if (taken.has(i)) return;
      const k = newKey(e);
      if (!slots.has(k)) slots.set(k, []);
      slots.get(k)!.push(i);
    });
    oldDoc.edges.forEach((e, i) => {
      if (removed.has(i) || map.has(i)) return;
      const target = slots.get(oldKey(e))?.shift();
      if (target === undefined) return;
      map.set(i, target);
      taken.add(target);
    });
  }
  const lines = newDoc.lines.slice();
  const drop: number[] = [];
  newDoc.info.forEach((li, i) => {
    if (li.kind !== 'linkStyle' || !li.ids!.every((x) => /^\d+$/.test(x))) return;
    const next = li.ids!.map((x) => map.get(Number(x))).filter((x): x is number => x !== undefined);
    if (!next.length) { drop.push(i); return; }
    lines[i] = lines[i].replace(/^(\s*linkStyle\s+)\S+/, `$1${next.join(',')}`);
  });
  for (const i of drop.reverse()) lines.splice(i, 1);
  return lines.join('\n');
}

// ---------------------------------------------------------------- nodes

export function setTitle(text: string, id: string, title: string): string {
  if (!title.trim()) throw new EditError('A title cannot be empty.');
  const doc = load(text);
  const refs = requireNode(doc, id);
  const labelled = refs.filter((r) => r.ref.shape || r.ref.attrs);
  const target = labelled.length ? labelled[labelled.length - 1] : refs[0];
  const line = doc.lines[target.line];
  const { ref } = target;
  let next: string;
  if (ref.shape) {
    const inner = line.slice(ref.shape.innerStart, ref.shape.innerEnd).trim();
    const markdown = /^"`.*`"$/.test(inner);
    const enc = markdown ? `"\`${title.trim().replace(/"/g, '#quot;')}\`"` : encodeLabel(title);
    next = line.slice(0, ref.shape.innerStart) + enc + line.slice(ref.shape.innerEnd);
  } else if (ref.attrs) {
    const raw = line.slice(ref.attrs.start, ref.attrs.end);
    if (!/label:\s*"[^"]*"/.test(raw)) {
      throw new EditError('This node is written in the @{ … } form without a quoted label; change its title in the text pane.');
    }
    const safe = title.trim().replace(/"/g, '#quot;');
    next = line.slice(0, ref.attrs.start) + raw.replace(/label:\s*"[^"]*"/, () => `label: "${safe}"`) + line.slice(ref.attrs.end);
  } else {
    next = `${line.slice(0, ref.idEnd)}[${encodeLabel(title)}]${line.slice(ref.idEnd)}`;
  }
  const rw = new Rewriter(doc);
  rw.setLine(target.line, next);
  return rw.finish();
}

export function setShape(text: string, id: string, type: string): string {
  const shape = SHAPES.find((s) => s.type === type);
  if (!shape) throw new EditError(`Unknown shape "${type}".`);
  const doc = load(text);
  const refs = requireNode(doc, id);
  if (refs.some((r) => r.ref.attrs)) {
    throw new EditError('This node is written in the @{ … } form; change its shape in the text pane.');
  }
  const shaped = refs.filter((r) => r.ref.shape);
  const target = shaped.length ? shaped[shaped.length - 1] : refs[0];
  const line = doc.lines[target.line];
  const { ref } = target;
  let next: string;
  if (ref.shape) {
    const inner = line.slice(ref.shape.innerStart, ref.shape.innerEnd).trim();
    const body = /^".*"$/.test(inner) ? inner : encodeLabel(unquote(inner), true);
    next = line.slice(0, ref.shape.openStart) + shape.open + body + shape.close + line.slice(ref.shape.closeEnd);
  } else {
    next = line.slice(0, ref.idEnd) + shape.open + encodeLabel(id, true) + shape.close + line.slice(ref.idEnd);
  }
  const rw = new Rewriter(doc);
  rw.setLine(target.line, next);
  return rw.finish();
}

export function addNode(text: string, title: string, parentSub: string | null = null): { text: string; id: string } {
  const doc = load(text);
  const id = newId(doc, 'n');
  const rw = new Rewriter(doc);
  if (parentSub) {
    const sub = findSub(doc, parentSub);
    if (!sub) throw new EditError(`No group "${parentSub}" in this file.`);
    rw.insertAfter(sub.endLine - 1, [{ text: `${innerIndent(doc, sub)}${id}[${encodeLabel(title)}]`, ids: [id] }], sub.line);
  } else {
    rw.insertAfter(topInsertLine(doc), [{ text: `${topIndent(doc)}${id}[${encodeLabel(title)}]`, ids: [id] }], -1);
  }
  return { text: rw.finish(), id };
}

function dropIdFromListLine(line: string, keyword: string, id: string): string | null {
  const m = new RegExp(`^(\\s*${keyword}\\s+)(\\S+)(.*)$`).exec(line);
  if (!m) return line;
  const rest = m[2].split(',').filter((x) => x !== id);
  return rest.length ? m[1] + rest.join(',') + m[3] : null;
}

function dropIdLines(rw: Rewriter, doc: Doc, id: string): void {
  doc.info.forEach((li, i) => {
    if (!li.ids?.includes(id)) return;
    if (li.kind === 'click') { rw.remove(i); return; }
    if (li.kind === 'style' || li.kind === 'class') {
      const next = dropIdFromListLine(doc.lines[i], li.kind, id);
      if (next === null) rw.remove(i);
      else rw.setLine(i, next);
    }
  });
}

export function deleteNode(text: string, id: string): string {
  const doc = load(text);
  requireNode(doc, id);
  const rw = new Rewriter(doc);
  doc.info.forEach((li, i) => {
    if (!li.chains?.some((ch) => ch.groups.some((g) => g.some((r) => r.id === id)))) return;
    const pieces: Piece[] = [];
    for (const ch of li.chains) {
      if (ch.groups.some((g) => g.some((r) => r.id === id))) {
        pieces.push(...rebuild(doc.lines[i], li.indent, ch.groups, ch.links, (r) => r.id === id));
      } else {
        pieces.push(chainPiece(doc.lines[i], li.indent, ch));
      }
    }
    rw.replace(i, pieces);
  });
  dropIdLines(rw, doc, id);
  const removed = new Set<number>();
  doc.edges.forEach((e, i) => { if (e.from.id === id || e.to.id === id) removed.add(i); });
  return removeDescription(fixLinkStyles(doc, rw.finish(), removed), id);
}

// ---------------------------------------------------------------- edges

export interface LinkParts {
  edgeId: string;
  left: '' | '<' | 'x' | 'o';
  stroke: 'normal' | 'thick' | 'dotted' | 'invisible';
  length: number;
  right: '' | '>' | 'x' | 'o';
  label: string;
  /** The label is a Markdown string, written `"\`...\`"`; it stays one when rewritten. */
  markdown: boolean;
  form: 'none' | 'pipe' | 'inline';
}

const isMarkdownLabel = (raw: string): boolean => /^"`[\s\S]*`"$/.test(raw.trim());

function arrowParts(startTok: string, endTok: string): Pick<LinkParts, 'left' | 'stroke' | 'length' | 'right'> {
  const left = (/^[xo<]/.exec(startTok)?.[0] ?? '') as LinkParts['left'];
  const right = (/[xo>]$/.exec(endTok)?.[0] ?? '') as LinkParts['right'];
  const body = endTok.replace(/^[xo<]/, '');
  if (body.startsWith('~')) return { left: '', stroke: 'invisible', length: 1, right: '' };
  if (body.includes('.')) return { left, stroke: 'dotted', length: (body.match(/\./g) ?? []).length, right };
  const ch = body.includes('=') ? '=' : '-';
  const n = body.split(ch).length - 1;
  return { left, stroke: ch === '=' ? 'thick' : 'normal', length: Math.max(1, right ? n - 1 : n - 2), right };
}

export function parseLink(raw: string): LinkParts {
  let s = raw.trim();
  let edgeId = '';
  const idm = /^([\p{L}\p{N}_]+)@/u.exec(s);
  if (idm) { edgeId = idm[1]; s = s.slice(idm[0].length); }
  const full = /^(?:[xo<]?--+[-xo>]|[xo<]?==+[=xo>]|[xo<]?-?\.+-[xo>]?|~~~+)$/;
  if (full.test(s)) return { edgeId, ...arrowParts(s, s), label: '', markdown: false, form: 'none' };
  const pipe = /^(\S+?)\s*\|(.*)\|$/.exec(s);
  if (pipe && full.test(pipe[1])) {
    return { edgeId, ...arrowParts(pipe[1], pipe[1]), label: unquote(pipe[2]), markdown: isMarkdownLabel(pipe[2]), form: 'pipe' };
  }
  const inl = /^([xo<]?(?:--|==|-\.))(.*?)([xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?))$/.exec(s);
  if (inl) return { edgeId, ...arrowParts(inl[1], inl[3]), label: unquote(inl[2]), markdown: isMarkdownLabel(inl[2]), form: 'inline' };
  throw new EditError(`Cannot read the arrow "${raw}".`);
}

export function buildLink(p: Omit<LinkParts, 'form'>): string {
  let arrow: string;
  if (p.stroke === 'invisible') arrow = '~~~';
  else if (p.stroke === 'dotted') arrow = `${p.left}-${'.'.repeat(p.length)}-${p.right}`;
  else {
    const ch = p.stroke === 'thick' ? '=' : '-';
    arrow = p.left + ch.repeat(p.length + (p.right ? 1 : 2)) + p.right;
  }
  const md = (t: string) => `"\`${t.replace(/\r?\n/g, '<br/>').trim().replace(/"/g, '#quot;')}\``;
  const label = p.stroke !== 'invisible' && p.label.trim() ? `|${p.markdown ? `${md(p.label)}"` : encodeLabel(p.label)}|` : '';
  return `${p.edgeId ? `${p.edgeId}@` : ''}${arrow}${label}`;
}

export function addEdge(text: string, from: string, to: string): string {
  const doc = load(text);
  for (const id of [from, to]) {
    if (!ID_OK.test(id)) throw new EditError(`The id "${id}" has characters the chart cannot write safely; add the arrow in the text pane.`);
  }
  const rw = new Rewriter(doc);
  rw.insertAfter(topInsertLine(doc), [{ text: `${topIndent(doc)}${from} --> ${to}`, ids: [from, to] }], -1);
  return rw.finish();
}

/** Rewrites one edge's arrow; `change` returns the new arrow, or null to delete the edge. */
function rewriteEdge(text: string, index: number, change: (raw: string) => string | null): string {
  const doc = load(text);
  const edge = doc.edges[index];
  if (!edge) throw new EditError('That arrow is not in the file any more.');
  const li = doc.info[edge.line];
  const line = doc.lines[edge.line];
  const ch = li.chains![edge.chain];
  const k = edge.link;
  const left = ch.groups[k];
  const right = ch.groups[k + 1];
  const link = ch.links[k];
  const next = change(link.raw);
  const rw = new Rewriter(doc);
  const removed = new Set<number>();

  if (left.length === 1 && right.length === 1 && next !== null) {
    rw.setLine(edge.line, line.slice(0, link.start) + next + line.slice(link.end));
    return rw.finish();
  }
  const pieces: Piece[] = [];
  li.chains!.forEach((other, ci) => {
    if (ci !== edge.chain) { pieces.push(chainPiece(line, li.indent, other)); return; }
    if (left.length === 1 && right.length === 1) {
      pieces.push(...rebuild(line, li.indent, ch.groups, ch.links, undefined, new Set([k])));
      return;
    }
    // One arrow written for several node pairs: write each pair out on its own line.
    pieces.push(...rebuild(line, li.indent, ch.groups.slice(0, k + 1), ch.links.slice(0, k)));
    for (const a of left) for (const b of right) {
      const isTarget = a === edge.from && b === edge.to;
      const raw = isTarget ? next : link.raw;
      if (raw !== null) pieces.push({ text: `${li.indent}${a.id} ${raw} ${b.id}`, ids: [a.id, b.id] });
    }
    pieces.push(...rebuild(line, li.indent, ch.groups.slice(k + 1), ch.links.slice(k + 1)));
  });
  if (next === null) removed.add(index);
  rw.replace(edge.line, pieces);
  return fixLinkStyles(doc, rw.finish(), removed);
}

export function deleteEdge(text: string, index: number): string {
  return rewriteEdge(text, index, () => null);
}

export function setEdgeLabel(text: string, index: number, label: string): string {
  return rewriteEdge(text, index, (raw) => buildLink({ ...parseLink(raw), label }));
}

export type ArrowKind = 'arrow' | 'none' | 'both' | 'circle' | 'cross';

export function setEdgeStyle(text: string, index: number, change: { stroke?: LinkParts['stroke']; arrow?: ArrowKind }): string {
  return rewriteEdge(text, index, (raw) => {
    const p = parseLink(raw);
    if (change.stroke) p.stroke = change.stroke;
    if (change.arrow) {
      const ends: Record<ArrowKind, [LinkParts['left'], LinkParts['right']]> = {
        arrow: ['', '>'], none: ['', ''], both: ['<', '>'], circle: ['', 'o'], cross: ['', 'x'],
      };
      [p.left, p.right] = ends[change.arrow];
    }
    return buildLink(p);
  });
}

// ---------------------------------------------------------------- styles

/** Sets (or, with null, clears) style properties such as fill and stroke on a node or group. */
export function setStyle(text: string, id: string, changes: Record<string, string | null>): string {
  const doc = load(text);
  if (!ID_OK.test(id)) throw new EditError(`The id "${id}" has characters the chart cannot write safely; style it in the text pane.`);
  const rw = new Rewriter(doc);
  const mine: { line: number; head: string; props: [string, string][] }[] = [];
  doc.info.forEach((li, i) => {
    if (li.kind !== 'style' || li.ids!.length !== 1 || li.ids![0] !== id) return;
    const m = /^(\s*style\s+\S+\s+)(.*?)\s*;?\s*$/.exec(doc.lines[i])!;
    if (m[2].includes('(')) throw new EditError(`Line ${i + 1}: this style line is too involved for the chart to edit; change it in the text pane.`);
    const props = m[2].split(',').map((p) => {
      const c = p.indexOf(':');
      if (c < 0) throw new EditError(`Line ${i + 1}: cannot read this style line; change it in the text pane.`);
      return [p.slice(0, c).trim(), p.slice(c + 1).trim()] as [string, string];
    });
    mine.push({ line: i, head: m[1], props });
  });
  const pending: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    let done = false;
    for (const s of mine) {
      for (let j = s.props.length - 1; j >= 0; j--) {
        if (s.props[j][0] !== key) continue;
        if (value === null || done) s.props.splice(j, 1);
        else { s.props[j][1] = value; done = true; }
      }
    }
    if (value !== null && !done) {
      if (mine.length) mine[0].props.push([key, value]);
      else pending.push(`${key}:${value}`);
    }
  }
  for (const s of mine) {
    if (s.props.length) rw.setLine(s.line, s.head + s.props.map(([k, v]) => `${k}:${v}`).join(','));
    else rw.remove(s.line);
  }
  if (pending.length) {
    let at = -1;
    doc.info.forEach((li, i) => { if (li.kind === 'style') at = i; });
    if (at < 0) at = lastStructuralLine(doc);
    rw.insertAfter(at, [{ text: `${topIndent(doc)}style ${id} ${pending.join(',')}`, ids: [] }], -1);
  }
  return rw.finish();
}

export function setDirection(text: string, dir: string): string {
  const doc = load(text);
  const line = doc.lines[doc.header];
  const m = /^(\s*)(flowchart(?:-elk)?|graph)(?:\s+[A-Za-z]+)?(\s*;?\s*)$/i.exec(line);
  if (!m) throw new EditError('Cannot read the header line.');
  const rw = new Rewriter(doc);
  rw.setLine(doc.header, `${m[1]}${m[2]} ${dir}${m[3].trim()}`);
  return rw.finish();
}

// ---------------------------------------------------------------- groups (subgraphs)

export function addSubgraph(text: string, title: string): { text: string; id: string } {
  const doc = load(text);
  const id = newId(doc, 'group');
  const ind = topIndent(doc);
  const rw = new Rewriter(doc);
  rw.insertAfter(topInsertLine(doc), [
    { text: `${ind}subgraph ${id}[${encodeLabel(title, true)}]`, ids: [] },
    { text: `${ind}end`, ids: [] },
  ], -1);
  return { text: rw.finish(), id };
}

export function renameSubgraph(text: string, id: string, title: string): { text: string; id: string } {
  if (!title.trim()) throw new EditError('A title cannot be empty.');
  const doc = load(text);
  const sub = findSub(doc, id);
  if (!sub) throw new EditError(`No group "${id}" in this file.`);
  const ind = doc.info[sub.line].indent;
  const semi = /;\s*$/.test(doc.lines[sub.line]) ? ';' : '';
  const keepId = sub.explicitId && ID_OK.test(sub.id) ? sub.id : newId(doc, 'group');
  const rw = new Rewriter(doc);
  rw.setLine(sub.line, `${ind}subgraph ${keepId}[${encodeLabel(title, true)}]${semi}`);
  return { text: rw.finish(), id: keepId };
}

export function setSubgraphDirection(text: string, id: string, dir: string | null): string {
  const doc = load(text);
  const sub = findSub(doc, id);
  if (!sub) throw new EditError(`No group "${id}" in this file.`);
  const rw = new Rewriter(doc);
  let found = false;
  for (let i = sub.line + 1; i < sub.endLine; i++) {
    const li = doc.info[i];
    if (li.kind !== 'direction' || li.parent !== sub.line) continue;
    if (dir === null || found) rw.remove(i);
    else rw.setLine(i, `${li.indent}direction ${dir}`);
    found = true;
  }
  if (!found && dir !== null) {
    rw.insertAfter(sub.line, [{ text: `${innerIndent(doc, sub)}direction ${dir}`, ids: [] }], sub.line);
  }
  return rw.finish();
}

/** Removes a group's frame; what was inside stays, one level up. */
export function ungroup(text: string, id: string): string {
  const doc = load(text);
  const sub = findSub(doc, id);
  if (!sub) throw new EditError(`No group "${id}" in this file.`);
  const rw = new Rewriter(doc);
  rw.remove(sub.line);
  rw.remove(sub.endLine);
  const outer = doc.info[sub.line].indent;
  const inner = innerIndent(doc, sub);
  const extra = inner.startsWith(outer) ? inner.slice(outer.length) : '';
  for (let i = sub.line + 1; i < sub.endLine; i++) {
    const li = doc.info[i];
    if (li.kind === 'direction' && li.parent === sub.line) { rw.remove(i); continue; }
    const line = doc.lines[i];
    if (extra && line.startsWith(outer + extra)) rw.setLine(i, outer + line.slice(outer.length + extra.length));
  }
  dropIdLines(rw, doc, id);
  return rw.finish();
}

/** Moves a node into a group, or out to the top level (target null). */
export function moveNode(text: string, id: string, target: string | null): string {
  const doc = load(text);
  requireNode(doc, id);
  const tsub = target === null ? null : findSub(doc, target);
  if (target !== null && !tsub) throw new EditError(`No group "${target}" in this file.`);
  const rw = new Rewriter(doc);
  const carried: string[] = [];
  const moved: Piece[] = [];
  const top = topIndent(doc);

  doc.info.forEach((li, i) => {
    if (!li.chains || li.parent === -1 || (tsub && li.parent === tsub.line)) return;
    if (!li.chains.some((ch) => ch.groups.some((g) => g.some((r) => r.id === id)))) return;
    const line = doc.lines[i];
    const pieces: Piece[] = [];
    for (const ch of li.chains) {
      const mine = ch.groups.flat().filter((r) => r.id === id);
      if (!mine.length) { pieces.push(chainPiece(line, li.indent, ch)); continue; }
      if (!ch.links.length) {
        for (const r of mine) if (isDecorated(r)) carried.push(refRaw(line, r));
        pieces.push(...rebuild(line, li.indent, ch.groups, ch.links, (r) => r.id === id));
        continue;
      }
      moved.push({ text: top + line.slice(ch.start, ch.end), ids: ch.groups.flat().map((r) => r.id) });
      for (const r of ch.groups.flat()) {
        if (r.id !== id) pieces.push({ text: li.indent + r.id, ids: [r.id], optional: true });
      }
    }
    rw.replace(i, pieces);
  });

  if (tsub) {
    const ind = innerIndent(doc, tsub);
    const here: Piece[] = carried.length
      ? carried.map((raw) => ({ text: ind + raw, ids: [id] }))
      : [{ text: ind + id, ids: [id], optional: true }];
    rw.insertAfter(tsub.endLine - 1, here, tsub.line);
  }
  const at = topInsertLine(doc);
  const tail: Piece[] = [...moved];
  if (!tsub) {
    if (carried.length) tail.unshift(...carried.map((raw) => ({ text: top + raw, ids: [id] })));
    else tail.push({ text: top + id, ids: [id], optional: true });
  }
  if (tail.length) rw.insertAfter(at, tail, -1);
  return fixLinkStyles(doc, rw.finish());
}
