// The headings a `mermaid` block stands under, as Naiad reads them (`findBlocks`),
// compared with the CommonMark reference reader's (`commonmark`, the specification's own
// JavaScript reader) on generated Markdown with headings in the forms CommonMark gives
// (D5.6, after bug hunt round 7: B30, B31, B32 and oB30 were Naiad reading a heading
// otherwise than Markdown does). What must hold, for every generated file:
// - every block Naiad finds is a fenced `mermaid` block to the reader too, opened on the
//   same line (Naiad may find fewer: none in a quote, and none where it cannot tell
//   whether a list item ended);
// - the headings Naiad finds above it, one per level, and the nearest one, are the
//   reader's headings at the top level of the file (not in a list item or a quote), each
//   compared as the reader shows its text.
// GitHub reads a table (a header row over a delimiter row of as many cells), which
// CommonMark does not: under one, a `---` is no underline to GitHub. Naiad reads as GitHub
// does, so the generator ends each table with a blank line; `tests/markdown.test.ts`, R3,
// checks the rest. GitHub also reads YAML front matter at the top of a file (from a first
// line `---`), as Naiad does and CommonMark does not, so no generated file starts with
// `---`.
import { Node, Parser } from 'commonmark';
import { describe, expect, test } from 'vitest';
import { findBlocks } from '../src/core/markdown';

const FILES = 3000;
const BS = String.fromCharCode(92); // a backslash

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A heading's text as the reader shows it: the text of its inlines, a line break read as a space. */
function plain(node: Node): string {
  let out = '';
  const walker = node.walker();
  for (let e = walker.next(); e; e = walker.next()) {
    if (!e.entering) continue;
    const n = e.node;
    if (n.type === 'text' || n.type === 'code' || n.type === 'html_inline') out += n.literal ?? '';
    else if (n.type === 'softbreak' || n.type === 'linebreak') out += ' ';
  }
  return out;
}

/**
 * Naiad's text of a heading as the reader shows it once read as inlines, with the file's
 * link definitions. Naiad joins an underlined heading's lines with a space, so a
 * backslash ending one of them (a line break to Markdown) stands before a space; the
 * generated files have a backslash before a space nowhere else, so it is read as the
 * line break it was. (Naiad's heading text keeps it; it is shown in the list of blocks
 * and compared with Naiad's own reading only.)
 */
function shown(parser: Parser, raw: string): string {
  const p = new Node('paragraph');
  (p as unknown as { _string_content: string })._string_content = raw.replace(/\\ /g, '\\\n');
  (parser as unknown as { inlineParser: { parse(n: Node): void } }).inlineParser.parse(p);
  return plain(p);
}

interface Found { line: number; heading: string; headings: string }

/** Each fenced `mermaid` block outside quotes, by its opening line, with the headings above it, as the reader finds them. */
function reference(md: string): { found: Found[]; parser: Parser } {
  const parser = new Parser();
  const doc = parser.parse(md);
  const levels: string[] = [];
  let heading = '';
  const headings = () => Array.from(levels, (t, k) => (t === undefined ? '' : `${k + 1} ${t}`)).filter(Boolean).join('\n');
  const found: Found[] = [];
  for (let top = doc.firstChild; top; top = top.next) {
    if (top.type === 'heading') {
      heading = plain(top);
      levels.length = top.level - 1;
      levels[top.level - 1] = heading;
      continue;
    }
    if (top.type === 'block_quote') continue;
    const walker = top.walker();
    for (let e = walker.next(); e; e = walker.next()) {
      const n = e.node;
      if (!e.entering) continue;
      if (n.type === 'block_quote') { walker.resumeAt(n, false); continue; }
      if (n.type === 'code_block' && (n as unknown as { _isFenced: boolean })._isFenced && (n.info ?? '').trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
        found.push({ line: n.sourcepos[0][0] - 1, heading, headings: headings() });
      }
    }
  }
  return { found, parser };
}

/** A generated Markdown file: headings of every form among paragraphs, lists, quotes, code and HTML, and one to three `mermaid` blocks. */
function generate(r: () => number): string {
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  const sp = (max: number) => ' '.repeat(Math.floor(r() * (max + 1)));
  const word = () => pick(['Intro', 'Setup', 'Flow', 'Notes', 'Plan *B*', 'The `code`', 'A [link](u)', '[ref]', 'x']);
  const hashes = () => '#'.repeat(r() < 0.05 ? 7 : 1 + Math.floor(r() * 6));
  const atx = (): string => {
    const h = hashes();
    const t = word();
    return pick([
      `${h} ${t}`, `${h} ${t} ${'#'.repeat(1 + Math.floor(r() * 3))}`, `${h} ${t}#`, h, `${h} #`, `${h} ##`, `${h}  `,
      `${h} ${t} ${BS}#`, `${h}\t${t}`, `${h} ${t} #   `, `${h}${t}`, `${BS}${h} ${t}`, `${h}   ${t}   `, `${h} #${t}`,
      `${h} ${t} # x`, `${h} ${t}\t#`,
    ]);
  };
  const mermaid = (indent = ''): string[] => {
    const f = pick(['```', '~~~', '````']);
    return [indent + f + pick(['mermaid', 'mermaid', 'Mermaid', 'mermaid title']), `${indent}flowchart TD`, `${indent}  a --> b`, indent + f];
  };
  const textLine = () => pick([word(), word(), 'text', '2. continuation', '- item like', '1.', '+', '> quoted', '<div>', '| a | b |',
    '[ref]: /url', '***', `${word()}  `, `${word()}${BS}`, '#notheading', '1) item']);
  const pieces: (() => string[])[] = [
    () => [(r() < 0.1 ? '    ' : sp(3)) + atx()],
    () => [(r() < 0.1 ? '    ' : sp(3)) + atx()],
    () => { // an underlined heading, or text that only looks like one
      const lines = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, k) => (k === 0 ? sp(3) : sp(6)) + textLine());
      return [...lines, (r() < 0.1 ? '    ' : sp(3)) + (r() < 0.5 ? '=' : '-').repeat(1 + Math.floor(r() * 4)) + sp(2)];
    },
    () => [sp(3) + textLine()],
    () => { // a list item, with a heading, a block, text or an underline in it
      const lead = sp(2);
      const marker = pick(['-', '*', '+', '1.', '1)', '2.']);
      const pad = lead + ' '.repeat(marker.length + 1);
      const out = [`${lead}${marker} ${word()}`];
      const inner = pick(['heading', 'mermaid', 'text', 'underline', 'nested', 'none']);
      if (inner === 'heading') out.push(pad + atx());
      if (inner === 'mermaid') out.push(...mermaid(pad));
      if (inner === 'text') out.push(pad + textLine());
      if (inner === 'underline') out.push(pick(['---', '===', `${pad}---`, `${pad}===`]));
      if (inner === 'nested') out.push(`${pad}- ${word()}`, ...mermaid(`${pad}  `));
      return out;
    },
    () => pick([[`> ${atx()}`], ['> text', pick(['> ===', '> ---', '===', '---'])], mermaid('> '), ['> text', 'lazy', '===']]),
    () => pick([[`    ${atx()}`], ['    text', '    ===']]),
    () => pick([['```python', '# a comment', '---', '```'], ['~~~', `${atx()}`, '~~~'], ['```', 'text', '===', '```']]),
    () => pick([['<div>', atx(), '</div>'], ['<!--', atx(), '-->'], ['<details>', '', atx(), '', '</details>']]),
    () => [pick(['***', '- - -', '___', '---', '* * *'])],
    () => ['| a | b |', '|---|---|', `| ${word()} | x |`, ''], // a table: see the note at the top
  ];
  const out: string[] = [];
  const count = 4 + Math.floor(r() * 9);
  const blocks = new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * (count + 1))));
  for (let k = 0; k <= count; k++) {
    if (blocks.has(k)) out.push(...mermaid(r() < 0.2 ? sp(3) : ''), '');
    if (k === count) break;
    out.push(...pick(pieces)());
    if (r() < 0.7) out.push('');
  }
  if (/^---[ \t]*$/.test(out[0])) out.unshift(''); // no front matter: see the note at the top
  return out.join('\n') + '\n';
}

interface Finding { seed: number; line: number; naiad: string; reader: string; file: string }

function compare(seed: number, md: string, into: Finding[]): void {
  const { found, parser } = reference(md);
  const as = (heading: string, headings: string) => `${heading}\n${headings}`;
  for (const b of findBlocks(md)) {
    const ref = found.find((f) => f.line === b.open);
    const naiad = as(shown(parser, b.heading), b.headings.split('\n').filter(Boolean).map((l) => {
      const at = l.indexOf(' ');
      return `${l.slice(0, at)} ${shown(parser, l.slice(at + 1))}`;
    }).join('\n'));
    const reader = ref ? as(ref.heading, ref.headings) : '(no mermaid block here)';
    if (naiad !== reader) into.push({ seed, line: b.open, naiad, reader, file: md });
  }
}

describe('the headings above each mermaid block, compared with the CommonMark reference reader', () => {
  test(`${FILES} generated files`, () => {
    const findings: Finding[] = [];
    let blocks = 0;
    for (let seed = 1; seed <= FILES; seed++) {
      const md = generate(rng(seed));
      blocks += findBlocks(md).length;
      compare(seed, md, findings);
    }
    expect(blocks).toBeGreaterThan(FILES);
    expect(findings.slice(0, 3)).toEqual([]);
  });
});
