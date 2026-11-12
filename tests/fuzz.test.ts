// @vitest-environment jsdom
// Fuzz test for the chart edits (src/core/edits.ts, src/core/descriptions.ts) and the
// checked edit (src/verify.ts, applyChecked).
//
// Random flowcharts come from a seeded generator (no Math.random), and random sequences
// of edits are run on each through applyChecked. After every edit the checked edit lets
// through, these hold (FILE-FORMAT.md, "What Naiad changes in a file"):
//   - the result still parses as a flowchart, and the scanner can still read it;
//   - the final newline is kept as it was;
//   - every line the edit does not need is kept, byte for byte and in order: comments,
//     blank lines, description blocks, classDef/click/acc lines, front matter...;
//   - every other node's description reads back exactly as before, and an edited
//     description reads back exactly as it was typed;
//   - everything else Mermaid's flowchart reader keeps stays as it was (whole(), bug hunt
//     round 6): every field of every node, arrow and group that the checked edit does not
//     compare (Markdown labels, links and their targets, tooltips, callbacks, icons,
//     images, forms, sizes, a group's `@{ ... }`...), the class definitions,
//     `linkStyle default`, and the configuration set in the file;
//   - Mermaid's reading matches the checked edit's expectation even when two untitled
//     groups share a title (canon() in src/semantics.ts names them alike).
// Besides, at some steps one line of a description already in the file is changed: only
// that line of its block may change (bug hunt round 6, A42).
// Every check above reads the text as Naiad's scanner does (through `forMermaid`, and the
// lines an edit may change), so a line the scanner reads otherwise than Mermaid escapes
// them all, as A43 did. So the accessible title and description are also read as Mermaid
// reads the text as it stands (`mermaidAcc`): Naiad's reading must match it, for every
// chart and after every accepted edit, and no edit may change it (round 7).
//
// Widened for round 7 (D5.5) with the forms behind the `%%` and accessible-text bugs of
// rounds 5 and 6, from a stream of its own (`w`), so every chart a seed made before is
// still made, with lines added: bare `%%` lines in ten spacings, comments holding U+2028
// or U+2029, description lines in hand spellings (`%%first`, another indent), an empty
// `accTitle:` or `accDescr:` before each kind of line, `accDescr { }` blocks holding a
// bare `%%`, a directive, a description block or a comment ending in `}`, `%%` inside
// accessible text, a `%%{` left open, and a directive and an arrow on one line. Most are
// from GLM's widened copy of round 6 (oA42, oA43). Since round 7's D35 to D37, also
// accessible texts after a directive on their line, after a statement and a ";", and
// with `accDescr` and its "{" (or `accTitle` and its ":") on two lines.
// An edit that is refused must be refused with an EditError (anything else is a crash).
// A failure that matches a known finding not yet fixed (KNOWN below) is counted and
// printed, and does not fail the run.
//
// Default run: a fixed seed, 20 charts, under 5 seconds. Longer run:
//   NAIAD_FUZZ_RUNS=2000 npx vitest run tests/fuzz.test.ts
// Replay one chart from a failure message:
//   NAIAD_FUZZ_SEED=<chart seed> NAIAD_FUZZ_RUNS=1 npx vitest run tests/fuzz.test.ts
import { beforeAll, expect, test } from 'vitest';
import mermaid from 'mermaid';
import { applyChecked, expectOp, type Op, type OpResult } from '../src/verify';
import { canon, forMermaid, snapshot, type Snap, type SnapSub } from '../src/semantics';
import { EditError } from '../src/core/edits';
import { parseDoc, SHAPES, type Doc } from '../src/core/scan';
import { getDescriptions, parseDescriptions, type DescBlock } from '../src/core/descriptions';
import { diff, lcs } from './line-diff';

beforeAll(() => mermaid.initialize({ startOnLoad: false }));

const RUNS = Number(process.env.NAIAD_FUZZ_RUNS ?? 20);
const BASE_SEED = Number(process.env.NAIAD_FUZZ_SEED ?? 20261111);
const OPS_PER_CHART = 5;

// ------------------------------------------------------------------ seeded randomness

/** mulberry32: a small, well-known 32-bit PRNG. */
class Rand {
  private a: number;
  constructor(seed: number) { this.a = seed >>> 0; }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]; }
  some<T>(xs: readonly T[], n: number): T[] {
    const pool = [...xs];
    const out: T[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(this.int(pool.length), 1)[0]);
    return out;
  }
}

// ------------------------------------------------------------------ the chart generator

const DIRS = ['TB', 'TD', 'BT', 'LR', 'RL'];
const NODE_IDS = ['a', 'b', 'c', 'd', 'node1', 'x_2', 'my-node', 'v.2', '7', '42', 'ü', '日本', 'Ω_x', 'end1',
  'endpoint', 'graphy', 'default', 'o1', 'x1', 'Start', 'classy', 'styled', 'n1', 'n2', 'group1', 'A', 'B'];
const SUB_IDS = ['g1', 'grp', 'sub-2', 'box', 'Ωg', 'outer', 'inner'];
const PLAIN_LABELS = ['Start', 'Load data', 'Ünï 日本', 'x', 'Step 2', 'Done?', 'a, b'];
const QUOTED_LABELS = ['"Say #quot;hi#quot;"', '"Paren (x) [y] {z}"', '"`**Bold** and _it_`"', '"a #35; b"', '"end"', '"x | y"',
  '"50% off"', '"a;b"', '"C:/path/file"', '"<b>tag</b>"'];
const LINKS = ['-->', '---', '-.->', '==>', '<-->', '--o', '--x', '--->', '-.-', '~~~', '---->', '<-.->', '<==>', 'x--x', 'o--o',
  '-->|go|', '-->|"Say #quot;yes#quot;"|', '-->|"`**md** edge`"|', '-- text -->', '-. dotted text .->', '== thick text ==>',
  '-- "quoted (text)" -->', '-- "`**md** inline`" -->', '---|open|'];
const COMMENTS = ['%% a plain comment', '%% TODO: tidy this', '%% a --> b (commented out)', '%%   indented text in a comment',
  '%%{init: {"flowchart": {"curve": "linear"}}}%%'];
const DESC_LINES = ['First line.', '.', '\\.', '\\@escaped', 'Two  spaces', '- a list item', '```', 'code();', '{braces}', 'a %% b'];

// The round 7 widening (D5.5); every list below is drawn from with `g.w` only.
/** Description texts ending in spaces, and `%%` and `.` forms (GLM, round 6). */
const W_DESC_LINES = ['trailing two spaces  ', 'trailing tab\t', 'trailing NBSP\u00a0', 'trailing backslash \\ ', '%%  ', '%%\t',
  '%%\u00a0', '%% \\. ', 'dot and spaces .  ', '\\.  ', '@x  ', '\\@x\t', '%% .  '];
/** A bare `%%` line in every spacing (GLM, round 6). */
const BARE = ['%%', '%% ', '%%\t', '%%\u00a0', '\u00a0%%', '%%\u3000', '  %%', '\t%%', ' \u00a0%%', '%%\u2028'];
/** Comments holding the line breaks Mermaid does not break a line at (A37, D33). */
const W_COMMENTS = ['%% a\u2028b', '%% x\u2029y', '%%\u2028', '%% }', '%% a\u2028}', '%% {'];
/** What may follow an empty `accTitle:` or `accDescr:` (GLM, round 6; A30, A41, D32). */
const ACC_NEXT = ['', '   ', '\t', '%%', '%% ', '%%\t', '%%\u00a0', '\u00a0%%', '%% a note', '%%{init: {"theme": "base"}}%%',
  'end', 'subgraph', 'accTitle: Two', 'accDescr: Two', '%% @zz\n%% zz text', 'end ;', 'direction LR'];

interface Gen { r: Rand; w: Rand; ids: string[]; subIds: string[]; unit: string; edgeIds: number; lines: string[]; mentioned: Set<string> }

/** A description line as a person or an agent may write it: no space after `%%`, or another indent. */
function handLine(w: Rand, indent: string, text: string): string {
  const forms = [`${indent}${w.pick(['  ', '\t', ' '])}%% ${text}`, `${w.pick(['', ' ', '\t'])}%% ${text}`];
  // `%%{` would open a directive, `%%@x` a block, and a space would be part of the text.
  if (!/^[\s{@]/.test(text)) forms.push(`${indent}%%${text}`);
  return w.pick(forms);
}

function shape(g: Gen): string {
  const s = g.r.pick(SHAPES);
  const label = g.r.chance(0.6) ? g.r.pick(PLAIN_LABELS) : g.r.pick(QUOTED_LABELS);
  // An unquoted label must not hold its shape's own closing characters.
  const safe = label.startsWith('"') || !/[()[\]{}/\\>-]/.test(label) ? label : 'Plain';
  return `${s.open}${safe}${s.close}`;
}

function mention(g: Gen): string {
  const id = g.r.pick(g.ids);
  g.mentioned.add(id);
  let out = id;
  if (g.r.chance(0.04)) out += `@{ shape: ${g.r.pick(['rounded', 'diam', 'cyl'])}, label: "Attr label" }`;
  else if (g.r.chance(0.4)) out += shape(g);
  if (g.r.chance(0.1)) out += ':::hot';
  return out;
}

function group(g: Gen): string {
  return g.r.chance(0.2) ? `${mention(g)} & ${mention(g)}` : mention(g);
}

function link(g: Gen): string {
  const l = g.r.pick(LINKS);
  if (g.r.chance(0.12) && !l.startsWith('~')) return `e${++g.edgeIds}@${l}`;
  return l;
}

function statement(g: Gen): string {
  let s = group(g);
  const n = g.r.chance(0.3) ? 0 : 1 + g.r.int(3);
  for (let i = 0; i < n; i++) s += ` ${link(g)} ${group(g)}`;
  if (g.r.chance(0.08)) s += `; ${group(g)} ${link(g)} ${group(g)}`;
  if (g.r.chance(0.05)) s += ';';
  return s;
}

function filler(g: Gen, indent: string): void {
  if (g.r.chance(0.12)) g.lines.push('');
  if (g.r.chance(0.08)) g.lines.push(indent + g.r.pick(COMMENTS));
  if (g.w.chance(0.05)) g.lines.push(indent + g.w.pick(BARE));
  if (g.w.chance(0.04)) g.lines.push(indent + g.w.pick(W_COMMENTS));
  if (g.r.chance(0.04)) descBlock(g, indent);
}

function descBlock(g: Gen, indent: string): void {
  const id = g.r.chance(0.8) ? g.r.pick(g.ids) : g.r.pick(['orphan', 'n3', 'group2']);
  g.lines.push(`${indent}%% @${id}`);
  const n = 1 + g.r.int(4);
  for (let i = 0; i < n; i++) {
    g.lines.push(`${indent}%% ${g.r.pick(DESC_LINES)}`);
    if (g.w.chance(0.25)) g.lines.push(handLine(g.w, indent, g.w.pick([...DESC_LINES, ...W_DESC_LINES])));
  }
  if (g.r.chance(0.05)) g.lines.push(`${indent}%%`); // a bare %%, which Naiad tolerates and warns about
  if (g.w.chance(0.08)) g.lines.push(indent + g.w.pick(BARE));
}

/**
 * Accessible text and directives in the forms that broke before (round 7, D5.5). Put
 * after the `linkStyle` line is chosen, since an open `%%{` hides the arrows after it
 * from the scanner, and the number of arrows it sees picks that line.
 */
function wide(g: Gen, used: string[]): void {
  const w = g.w;
  const u = g.unit;
  if (w.chance(0.18)) {
    // Also after a directive on its line, or with its ":" on the next line (D36).
    const opener = w.pick(['accTitle:', 'accDescr:', 'accTitle: %%{init: {}}%%', '%%{x}%% accDescr:', 'accTitle\n:']);
    g.lines.push(...opener.split('\n'), ...w.pick(ACC_NEXT).split('\n'));
  }
  if (w.chance(0.15)) {
    const id = w.pick(g.ids);
    g.lines.push(...w.pick([
      'accDescr {\nText\n}',
      'accDescr{\nFirst\n%%\nLast\n}', // A38
      '\u00a0accDescr {\n\u00a0%%\n}',
      `accDescr {\nFirst\n%%{init: {"theme":"dark"}}%%\n%% @${id}\n%%\nLast\n}`, // A43
      'accDescr {\nFirst\n%%{init: {\n"theme": "dark"}}%%\nLast\n}',
      'accDescr {\nx %% y\n%% a\u2028}\nLast\n}', // D33
      `accDescr {\nFirst\n%% @${id}\n%%\nLast\n}`, // A38, A43: a description block inside
      `accDescr {\n%% @${id}\n%%first\n  %% second\n}`,
      'accDescr { one line }',
      'accDescr\n {\nFirst\n%%\nLast\n}', // D37: `accDescr` and its "{" on two lines
      '%%{init: {}}%%accDescr {\n%%\nLast\n}', // D37: after a directive
      `${id}; accDescr {\n%%\nLast\n}`, // D35: after a statement and a ";"
      `${id}; accTitle:\n%%`, // D35
    ]).split('\n'));
  }
  if (w.chance(0.1)) g.lines.push(u + w.pick(['accTitle: hello %% world', 'accTitle: 50%% off', 'accDescr: hello %% world'])); // D34
  if (w.chance(0.05) && used.length) g.lines.push(`${u}%%{init: {"theme":"dark"}}%% ${w.pick(used)} --> ${w.pick(used)}`); // oA43
  if (w.chance(0.03)) g.lines.push(`${u}%%{ ${w.pick(['init', 'oops', 'x'])}`); // a %%{ left open (oA42)
}

function body(g: Gen, indent: string, depth: number): void {
  const n = g.r.int(depth === 0 ? 5 : 3) + (depth === 0 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    filler(g, indent);
    if (depth < 3 && g.r.chance(depth === 0 ? 0.35 : 0.2)) subgraph(g, indent, depth + 1);
    else g.lines.push(indent + statement(g) + (g.r.chance(0.05) ? '  ' : ''));
  }
}

function subgraph(g: Gen, indent: string, depth: number): void {
  const free = SUB_IDS.filter((s) => !g.subIds.includes(s));
  const forms = ['idTitle', 'idOnly', 'titleOnly', 'idQuoted'];
  const form = free.length ? g.r.pick(forms) : 'titleOnly';
  const id = free.length ? g.r.pick(free) : '';
  if (id && form !== 'titleOnly') g.subIds.push(id);
  const title = g.r.pick(['Review', 'Step two', 'Ünï', '`**md** group`']);
  const line = form === 'idTitle' ? `subgraph ${id} [${title.startsWith('`') ? `"${title}"` : title}]`
    : form === 'idOnly' ? `subgraph ${id}`
      : form === 'idQuoted' ? `subgraph ${id}["${title}"]`
        : `subgraph "${g.r.pick(['Title only', 'Another title', 'Title only'])}"`;
  g.lines.push(indent + line);
  const inner = indent + g.unit;
  if (g.r.chance(0.2)) g.lines.push(`${inner}direction ${g.r.pick(DIRS)}`);
  if (!g.r.chance(0.1)) body(g, inner, depth); // sometimes an empty group
  g.lines.push(indent + 'end');
}

/**
 * The rest of what Mermaid 12.3's flowchart reader keeps, for the whole-reading comparison
 * (bug hunt round 6, D5.4): icons, images and shapes set with `@{ ... }`, link targets,
 * callbacks, more class definitions, `linkStyle default`, an arrow's curve and speed, a
 * group's `@{ ... }`, the accessible description. From a stream of its own, `r2`, so that
 * every chart a seed made before is still made, these lines added; no line adds a node, an
 * arrow or a group.
 */
function more(r2: Rand, g: Gen, used: string[]): void {
  const u = g.unit;
  const some = () => r2.pick(used);
  if (used.length) {
    if (r2.chance(0.15)) g.lines.push(`${u}${some()}@{ icon: "fa:user", form: "${r2.pick(['square', 'circle', 'rounded'])}", label: "${r2.pick(['User', 'Ünï', 'Two words'])}", pos: "${r2.pick(['t', 'b'])}", h: 48 }`);
    if (r2.chance(0.1)) g.lines.push(`${u}${some()}@{ img: "https://example.test/i.png", label: "Pic", pos: "t", w: 60, h: 60, constraint: "${r2.pick(['on', 'off'])}" }`);
    if (r2.chance(0.1)) g.lines.push(`${u}${some()}@{ shape: ${r2.pick(['hex', 'cyl', 'stadium', 'doc', 'delay', 'tri', 'notch-rect'])}, label: "${r2.pick(['Set by shape', 'a **b**'])}" }`);
    if (r2.chance(0.15)) g.lines.push(`${u}click ${some()} href "https://example.test/t" "Tip t" ${r2.pick(['_blank', '_self', '_parent', '_top'])}`);
    if (r2.chance(0.08)) g.lines.push(`${u}click ${some()} "https://example.test/u"`);
    if (r2.chance(0.12)) g.lines.push(`${u}click ${some()} ${r2.pick(['callback "Tip cb"', 'call doIt(1, 2)', 'call doIt()'])}`);
    if (r2.chance(0.1)) g.lines.push(`${u}${some()}:::cold`);
  }
  if (r2.chance(0.2)) g.lines.push(`${u}classDef cold fill:#69f,color:#fff,stroke-width:2px`);
  if (r2.chance(0.1)) g.lines.push(`${u}classDef default fill:#eee`);
  if (r2.chance(0.1)) g.lines.push(`${u}classDef a,b font-style:italic`);
  if (r2.chance(0.12)) g.lines.push(`${u}linkStyle default ${r2.pick(['stroke:#888', 'interpolate step', 'interpolate basis stroke-width:2px'])}`);
  for (let k = 1; k <= g.edgeIds; k++) {
    if (r2.chance(0.2)) g.lines.push(`${u}e${k}@{ ${r2.pick(['curve: linear', 'curve: step', 'animation: slow', 'animation: fast'])} }`);
  }
  if (g.subIds.length && r2.chance(0.15)) g.lines.push(`${u}${r2.pick(g.subIds)}@{ view: ${r2.pick(['collapsed', 'expanded'])} }`);
  if (r2.chance(0.05)) g.lines.push(`${u}accDescr: A fuzz description`);
}

export function genChart(seed: number): string {
  const r = new Rand(seed);
  const w = new Rand(seed ^ 0x77696465);
  const g: Gen = { r, w, ids: r.some(NODE_IDS, 3 + r.int(6)), subIds: [], unit: r.pick(['  ', '    ', '\t']), edgeIds: 0, lines: [], mentioned: new Set() };
  if (r.chance(0.12)) g.lines.push('---', 'title: Fuzz chart', '---');
  if (r.chance(0.08)) g.lines.push('%%{init: {"theme": "neutral"}}%%');
  if (r.chance(0.08)) g.lines.push('%% a comment above the header');
  g.lines.push(`${r.pick(['flowchart', 'graph'])}${r.chance(0.92) ? ` ${r.pick(DIRS)}` : ''}${r.chance(0.05) ? ';' : ''}`);
  body(g, g.unit, 0);
  for (let k = 1; k <= g.edgeIds; k++) if (r.chance(0.4)) g.lines.push(`${g.unit}e${k}@{ animate: true }`);
  if (r.chance(0.03)) g.lines.push(`${g.unit}END`); // valid Mermaid (a node) that the scanner cannot read
  const used = [...g.mentioned];
  more(new Rand(seed ^ 0x6d6f7265), g, used);
  if (r.chance(0.3)) g.lines.push(`${g.unit}classDef hot fill:#f96,stroke:#333`);
  if (r.chance(0.3) && used.length) g.lines.push(`${g.unit}class ${r.some(used, 1 + r.int(2)).join(',')} hot`);
  if (r.chance(0.3) && used.length) g.lines.push(`${g.unit}style ${r.pick(used)} fill:#d3f9d8,stroke:#2f9e44`);
  if (r.chance(0.15) && g.subIds.length) g.lines.push(`${g.unit}style ${r.pick(g.subIds)} fill:#eef`);
  if (r.chance(0.15) && g.subIds.length) g.lines.push(`${g.unit}class ${r.pick(g.subIds)} hot`);
  if (r.chance(0.2) && used.length) g.lines.push(`${g.unit}click ${r.pick(used)} href "https://example.test" "A tooltip"`);
  if (r.chance(0.1)) g.lines.push(`${g.unit}accTitle: A fuzz chart`);
  const edges = parseDoc(g.lines.join('\n')).edges.length;
  if (edges && r.chance(0.35)) {
    const idx = r.some([...Array(edges).keys()], 1 + r.int(Math.min(2, edges)));
    g.lines.push(`${g.unit}linkStyle ${idx.join(',')} ${r.pick(['stroke:#f00', 'stroke-width:3px', 'interpolate basis', 'interpolate step stroke:#0a0'])}`);
  }
  wide(g, used);
  if (r.chance(0.6)) { g.lines.push(''); descBlock(g, ''); }
  if (r.chance(0.3)) { g.lines.push(''); descBlock(g, ''); }
  if (r.chance(0.05)) g.lines.push('%% @' + g.ids[0], '%% A second block for the same id.');
  let text = g.lines.join('\n');
  if (r.chance(0.85)) text += '\n';
  if (r.chance(0.08)) text += '\n\n';
  return text;
}

// ------------------------------------------------------------------ random edits

const TITLES = ['Renamed', 'Say "hi" (now) [x] {y}', 'end', 'Ünïcödé 日本', 'two\nlines', '  padded  ', 'default', 'a;b',
  '50% off', '#quot; typed', 'x | y', 'classDef', '<b>b</b>'];
const DESCRIPTIONS = ['A new description.', 'One.\n\nTwo paragraphs.', '', '.\n@x\n\\.', 'Code:\n```py\nclass A:\n    @property\n    def p(self): pass\n```',
  'Mention\n  @a\nindented', 'See %%{init: {"theme": "dark"}}%% here.', '- item\n  - nested', 'trailing   \nspaces\t', '%% looks like a comment',
  '   \n\nleading blank lines', '{x}\n---\n%%'];
const LABELS = ['label', 'a "b" (c) | d', '', 'end', 'two\nlines', '`code`'];
const STYLE_CHANGES: Record<string, string | null>[] = [{ fill: '#abcdef', stroke: '#123456' }, { fill: null, stroke: null, color: null }, { color: '#000' }, { fill: '#fff' }];

function randomOp(r: Rand, snap: Snap): Op {
  const nodes = Object.keys(snap.nodes);
  const subs = Object.keys(snap.subs);
  const choices: (() => Op)[] = [
    () => ({ kind: 'addNode', title: r.pick(TITLES), parent: subs.length && r.chance(0.5) ? r.pick(subs) : null }),
    () => ({ kind: 'setDirection', dir: r.pick(DIRS) }),
  ];
  if (nodes.length) {
    const id = () => r.pick(nodes);
    choices.push(
      () => ({ kind: 'setTitle', id: id(), title: r.pick(TITLES) }),
      () => ({ kind: 'setDescription', id: id(), description: r.pick(DESCRIPTIONS) }),
      () => ({ kind: 'setDescription', id: id(), description: r.pick(DESCRIPTIONS) }),
      () => ({ kind: 'setShape', id: id(), shape: r.pick(SHAPES).type }),
      () => ({ kind: 'deleteNode', id: id() }),
      () => ({ kind: 'addEdge', from: id(), to: id() }),
      () => ({ kind: 'setStyle', id: id(), changes: r.pick(STYLE_CHANGES) }),
      () => ({ kind: 'moveNode', id: id(), target: subs.length && r.chance(0.7) ? r.pick(subs) : null }),
      () => ({ kind: 'groupNode', id: id(), title: r.pick(['New group', 'G "q"']) }),
    );
  }
  if (snap.edges.length) {
    const index = () => r.int(snap.edges.length);
    choices.push(
      () => ({ kind: 'deleteEdge', index: index() }),
      () => ({ kind: 'setEdgeLabel', index: index(), label: r.pick(LABELS) }),
      () => ({ kind: 'setEdgeStyle', index: index(), stroke: r.pick(['normal', 'thick', 'dotted'] as const) }),
      () => ({ kind: 'setEdgeStyle', index: index(), arrow: r.pick(['arrow', 'none', 'both', 'circle', 'cross'] as const) }),
    );
  }
  if (subs.length) {
    const sid = () => r.pick(subs);
    choices.push(
      () => ({ kind: 'renameSubgraph', id: sid(), title: r.pick(['Renamed group', 'One']) }),
      () => ({ kind: 'setSubgraphDirection', id: sid(), dir: r.chance(0.3) ? null : r.pick(DIRS) }),
      () => ({ kind: 'ungroup', id: sid() }),
      () => ({ kind: 'setStyle', id: sid(), changes: r.pick(STYLE_CHANGES) }),
    );
  }
  return r.pick(choices)();
}

/** New text for one line of a description. None is empty: an empty first or last line is not part of the text. */
const LINE_TEXTS = ['Changed line.', 'x %% y', '.', '@x', 'trailing two  ', '  indented', 'See %%{init: {}}%% here', '- item'];

/**
 * One line of a description already in the file changed, as a person does in the sidebar
 * (bug hunt round 6, A42; round 7, D5.5). `oneLineCheck` then asks that only that line of
 * the block changed.
 */
function oneLineOp(w: Rand, text: string, snap: Snap): { op: Op; block: DescBlock } | null {
  const seen = new Set<string>();
  const blocks = parseDescriptions(text.split('\n')).filter((b) => {
    const first = !seen.has(b.id);
    seen.add(b.id);
    return first && b.text !== '' && b.id in snap.nodes;
  });
  if (!blocks.length) return null;
  const block = w.pick(blocks);
  const lines = block.text.split('\n');
  const k = w.int(lines.length);
  lines[k] = w.pick(LINE_TEXTS.filter((t) => t !== lines[k]));
  return { op: { kind: 'setDescription', id: block.id, description: lines.join('\n') }, block };
}

// ------------------------------------------------------------------ what Mermaid reads beyond the snapshot

/**
 * Everything Mermaid's flowchart reader keeps that the checked edit does not compare
 * (bug hunt round 6, D5.4): every field of every node, arrow and group other than the
 * snapshot's own (`snapshot`, src/semantics.ts, which the checked edit compares with what
 * the edit should give), read field by field from Mermaid's objects so that a field not
 * named here is compared too; and the chart's own settings. Left out as Mermaid's
 * bookkeeping: a node's `domId` and an arrow's made-up id (numbered in reading order), the
 * reader's counters, and the members a group lost to an earlier group that lists them too
 * (`droppedSubGraphMembers`, which follows from the membership the snapshot compares).
 */
interface Whole {
  /** By id: the node's other fields and its tooltip. */
  nodes: Record<string, string>;
  /** In Mermaid's order: each arrow's other fields, with its ends to find it by. */
  edges: string[];
  /** By id, or `~title#n` for an untitled group: the group's other fields. */
  subs: Record<string, string>;
  /** Class definitions, `linkStyle default`, callbacks, the title, the configuration. */
  chart: Record<string, string>;
}

const SNAP_NODE = new Set(['id', 'domId', 'text', 'type', 'styles', 'classes']);
const SNAP_EDGE = new Set(['start', 'end', 'text', 'type', 'stroke', 'length', 'style', 'labelType', 'interpolate', 'classes',
  'animate', 'animation', 'id', 'isUserDefinedId']);
const SNAP_SUB = new Set(['id', 'title', 'nodes', 'dir']);

/**
 * A label's kind is read as Markdown or plain: Mermaid 12.3 keeps "text" for a label
 * written bare and "string" for one in quotes, but its flowchart drawing only ever asks
 * whether a label is "markdown" (every use of `labelType` in its drawing code, 2026-11-12).
 */
function others(o: Record<string, unknown>, skip: Set<string>, add: Record<string, unknown> = {}): string {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) if (!skip.has(k) && o[k] !== undefined) out[k] = o[k];
  if ('labelType' in out) out.labelType = out.labelType === 'markdown' ? 'markdown' : 'plain';
  return JSON.stringify({ ...out, ...add });
}

const wholeCache = new Map<string, Whole>();
/** `drop`: a group read as if it were not there, so that untitled groups keep their numbers. */
async function whole(text: string, drop?: string): Promise<Whole> {
  const key = `${drop ?? ''}\u0000${text}`;
  const hit = wholeCache.get(key);
  if (hit) return hit;
  const api = (mermaid as unknown as { mermaidAPI: { getDiagramFromText(t: string): Promise<any> } }).mermaidAPI;
  const db = (await api.getDiagramFromText(forMermaid(text))).db;
  const tips: Map<string, string> = db.tooltips ?? new Map();
  const groups: any[] = db.getSubGraphs();
  const subIds = new Set<string>(groups.map((s) => s.id));
  const nodes: Record<string, string> = {};
  for (const v of db.getVertices().values()) {
    if (subIds.has(v.id)) continue;
    nodes[v.id] = others(v, SNAP_NODE, { tooltip: tips.get(v.id) ?? '' });
  }
  const edges = db.getEdges().map((e: any) => others(e, SNAP_EDGE, { s: e.start, e: e.end }));
  const subs: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const s of groups) {
    if (s.id === drop) continue;
    let name = s.id;
    if (/^subGraph\d+$/.test(s.id)) {
      const n = seen.get(s.title) ?? 0;
      seen.set(s.title, n + 1);
      name = `~${s.title}#${n}`;
    }
    subs[name] = others(s, SNAP_SUB);
  }
  const all = db.getEdges();
  const chart: Record<string, string> = {
    classDefs: JSON.stringify([...db.getClasses().values()].map((c: any) => others(c, new Set())).sort()),
    linkStyleDefault: JSON.stringify({ interpolate: all.defaultInterpolate, style: all.defaultStyle }),
    callbacks: String(db.funs?.length ?? 0),
    title: String(db.getDiagramTitle?.() ?? ''),
    config: JSON.stringify((await mermaid.parse(forMermaid(text))) as unknown),
  };
  const res = { nodes, edges, subs, chart };
  wholeCache.set(key, res);
  return res;
}

/**
 * The accessible title and description as Mermaid reads the text as it stands, without
 * `forMermaid`; null where Mermaid cannot read it so (a bare `%%` line the scanner warns
 * about, say). The checks in checkEdit read through the scanner, so a line the scanner
 * reads otherwise than Mermaid escapes them: A38, A41, A43, D32 and D33 were such lines
 * in accessible text (round 7).
 */
async function mermaidAcc(text: string): Promise<string | null> {
  const api = (mermaid as unknown as { mermaidAPI: { getDiagramFromText(t: string): Promise<any> } }).mermaidAPI;
  try {
    const db = (await api.getDiagramFromText(text)).db;
    return JSON.stringify([String(db.getAccTitle?.() ?? ''), String(db.getAccDescription?.() ?? '')]);
  } catch {
    return null;
  }
}
const naiadAcc = (s: Snap): string => JSON.stringify([s.accTitle, s.accDescr]);

/**
 * canon() from src/semantics.ts names an untitled group (`subGraph3`) by its title, so two
 * untitled groups with the same title share one name and only one of them is compared.
 * This form numbers them in Mermaid's order instead (`~Title#0`, `~Title#1`).
 */
function strictCanon(s: Snap): string {
  const seen = new Map<string, number>();
  const alias = new Map<string, string>();
  for (const [id, sub] of Object.entries(s.subs)) {
    if (!/^subGraph\d+$/.test(id)) continue;
    const k = seen.get(sub.title) ?? 0;
    seen.set(sub.title, k + 1);
    alias.set(id, `~${sub.title}#${k}`);
  }
  const name = (id: string) => alias.get(id) ?? id;
  const subs: Record<string, SnapSub> = {};
  for (const [id, sub] of Object.entries(s.subs)) subs[name(id)] = { ...sub, nodes: sub.nodes.map(name).sort() };
  const sorted = <T>(rec: Record<string, T>) => Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
  return JSON.stringify({ direction: s.direction, nodes: sorted(s.nodes), edges: s.edges.map((e) => JSON.stringify(e)).sort(), subs: sorted(subs) });
}

// ------------------------------------------------------------------ the checks

/** Normalises a description as typed to what reading it back must give. */
// A line keeps the spaces at its end (bug hunt round 5, A40); a line of spaces alone is an
// empty line.
function typedDescription(d: string): string {
  return d.replace(/\r\n?/g, '\n').split('\n').map((l) => (l.trim() === '' ? '' : l)).join('\n').replace(/^\n+|\n+$/g, '');
}

const mentions = (doc: Doc, i: number, id: string) => !!doc.info[i].chains?.some((ch) => ch.groups.some((g) => g.some((r) => r.id === id)));
const names = (doc: Doc, i: number, id: string) => !!doc.info[i].ids?.includes(id) && doc.info[i].kind !== 'linkStyle';

/** Lines of `before` an edit may rewrite or remove; every other line must be kept. */
function mayChange(doc: Doc, text: string, op: Op): Set<number> {
  const out = new Set<number>();
  const add = (pred: (i: number) => boolean) => doc.lines.forEach((_, i) => { if (pred(i)) out.add(i); });
  const linkStyles = () => add((i) => doc.info[i].kind === 'linkStyle');
  const block = (id: string, blank: boolean) => {
    const b = parseDescriptions(text.split('\n')).find((x) => x.id === id);
    if (!b) return;
    for (let i = b.start; i < b.end; i++) out.add(i);
    if (blank && b.start > 0 && doc.lines[b.start - 1].trim() === '') out.add(b.start - 1);
  };
  switch (op.kind) {
    case 'setTitle': case 'setShape': add((i) => mentions(doc, i, op.id)); break;
    case 'setDescription': block(op.id, op.description.trim() === ''); break;
    case 'deleteNode': add((i) => mentions(doc, i, op.id) || names(doc, i, op.id)); linkStyles(); block(op.id, true); break;
    case 'deleteEdge': case 'setEdgeLabel': case 'setEdgeStyle': {
      const e = doc.edges[op.index];
      if (e) out.add(e.line);
      linkStyles();
      break;
    }
    case 'setStyle': add((i) => doc.info[i].kind === 'style' && doc.info[i].ids!.length === 1 && doc.info[i].ids![0] === op.id); break;
    case 'setDirection': out.add(doc.header); break;
    case 'moveNode': case 'groupNode': add((i) => mentions(doc, i, op.id)); linkStyles(); break;
    case 'renameSubgraph': { const s = doc.subs.find((x) => x.id === op.id); if (s) out.add(s.line); break; }
    case 'setSubgraphDirection': {
      const s = doc.subs.find((x) => x.id === op.id);
      if (s) add((i) => doc.info[i].kind === 'direction' && doc.info[i].parent === s.line);
      break;
    }
    case 'ungroup': {
      const s = doc.subs.find((x) => x.id === op.id);
      if (s) { out.add(s.line); out.add(s.endLine); add((i) => doc.info[i].kind === 'direction' && doc.info[i].parent === s.line); }
      add((i) => names(doc, i, op.id));
      break;
    }
    default: break; // addNode, addEdge: insertions only
  }
  return out;
}

interface Violation { kind: string; detail: string }

/** After `oneLineOp`: the file has as many lines as before, and only one differs, inside the block. */
function oneLineCheck(before: string, after: string, block: DescBlock): Violation[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length !== b.length) return [{ kind: 'description-lines-not-kept', detail: `${a.length} lines became ${b.length}` }];
  const changed = a.map((_, i) => i).filter((i) => a[i] !== b[i]);
  if (changed.length === 1 && changed[0] > block.start && changed[0] < block.end) return [];
  return [{ kind: 'description-lines-not-kept', detail: `lines changed: ${changed.join(', ')}; the block is lines ${block.start} to ${block.end - 1}` }];
}

async function checkEdit(before: string, beforeSnap: Snap, op: Op, res: OpResult): Promise<Violation[]> {
  const v: Violation[] = [];
  const after = res.text;
  const created = op.kind === 'addNode' || op.kind === 'groupNode' ? res.created : undefined;
  const doc = parseDoc(before);
  // 1. Still a flowchart the scanner can read.
  let afterSnap: Snap;
  try { afterSnap = await snapshot(after); } catch (e) { v.push({ kind: 'no-longer-parses', detail: String(e) }); return v; }
  // 1b. Two untitled groups with one title are compared one by one.
  const expected = expectOp(beforeSnap, op, res);
  if (canon(expected) === canon(afterSnap) && strictCanon(expected) !== strictCanon(afterSnap)) {
    v.push({ kind: `check-blind-to-twin-groups:${op.kind}`, detail: `expected ${strictCanon(expected)}\n  got      ${strictCanon(afterSnap)}` });
  }
  if (!doc.problems.length && parseDoc(after).problems.length) {
    v.push({ kind: 'scanner-cannot-read-result', detail: JSON.stringify(parseDoc(after).problems[0]) });
  }
  // 2. Final newline as it was (unless the edit removed the file's last line, when the
  //    line above it, kept as it was, becomes the last).
  const allowed = mayChange(doc, before, op);
  const lastLine = before.split('\n').length - 1;
  if (before.endsWith('\n') !== after.endsWith('\n') && !allowed.has(lastLine)) v.push({ kind: 'final-newline-changed', detail: '' });
  // 3. Every line the edit does not need is kept, in order (ungroup may only re-indent).
  const norm = (t: string) => (op.kind === 'ungroup' ? t.split('\n').map((l) => l.trimStart()) : t.split('\n'));
  const a = norm(before);
  const kept = new Set(lcs(a, norm(after)).map(([i]) => i));
  let lost = a.map((_, i) => i).filter((i) => !kept.has(i) && !allowed.has(i));
  // Equal lines (blank lines above all) can be paired either way: a lost line counts as
  // kept when a line with the same text that the edit was allowed to drop was kept instead.
  const spare = a.map((_, i) => i).filter((i) => kept.has(i) && allowed.has(i));
  lost = lost.filter((i) => {
    const j = spare.findIndex((k) => a[k] === a[i]);
    if (j < 0) return true;
    spare.splice(j, 1);
    return false;
  });
  if (lost.length) {
    const kinds = [...new Set(lost.map((i) => doc.info[i].kind))].join(',');
    v.push({ kind: `line-lost:${op.kind}:${kinds}`, detail: lost.map((i) => `line ${i + 1} ${JSON.stringify(doc.lines[i])}`).join('; ') });
  }
  // 4. Descriptions: the edited one reads back as typed, every other one as it was.
  const dBefore = getDescriptions(before);
  const dAfter = getDescriptions(after);
  const blocksFor = (id: string) => parseDescriptions(before.split('\n')).filter((b) => b.id === id).length;
  const target = op.kind === 'setDescription' || op.kind === 'deleteNode' ? op.id : null;
  for (const id of new Set([...dBefore.keys(), ...dAfter.keys()])) {
    if (id === target) continue;
    if (dBefore.get(id) !== dAfter.get(id)) {
      v.push({ kind: `description-changed:${op.kind}`, detail: `@${id}: ${JSON.stringify(dBefore.get(id))} -> ${JSON.stringify(dAfter.get(id))}` });
    }
  }
  if (created && dAfter.has(created)) {
    v.push({ kind: `new-item-has-a-description:${op.kind}`, detail: `@${created}: ${JSON.stringify(dAfter.get(created))}` });
  }
  if (op.kind === 'setDescription') {
    const want = typedDescription(op.description);
    const got = dAfter.get(op.id);
    if (!(want === '' && blocksFor(op.id) > 1) && (got ?? '') !== want) {
      v.push({ kind: 'description-not-as-typed', detail: `@${op.id}: typed ${JSON.stringify(want)}, reads ${JSON.stringify(got)}` });
    }
  }
  // 5. Everything else Mermaid reads, which the checked edit does not compare (round 6).
  const xb = await whole(before, op.kind === 'ungroup' ? op.id : undefined);
  const xa = await whole(after);
  for (const id of Object.keys(xb.nodes)) {
    if (id in xa.nodes && xb.nodes[id] !== xa.nodes[id]) v.push({ kind: `node-extra-changed:${op.kind}`, detail: `${id}: ${xb.nodes[id]} -> ${xa.nodes[id]}` });
  }
  for (const id of Object.keys(xb.subs)) {
    if (op.kind === 'renameSubgraph' && id === op.id) continue;
    if (id in xa.subs && xb.subs[id] !== xa.subs[id]) v.push({ kind: `group-extra-changed:${op.kind}`, detail: `${id}: ${xb.subs[id]} -> ${xa.subs[id]}` });
  }
  for (const k of Object.keys(xb.chart)) {
    if (k === 'callbacks' && op.kind === 'deleteNode') continue; // its own `click ... call` goes with it
    if (xb.chart[k] !== xa.chart[k]) v.push({ kind: `chart-extra-changed:${op.kind}:${k}`, detail: `${xb.chart[k]} -> ${xa.chart[k]}` });
  }
  let eb = [...xb.edges];
  let ea = [...xa.edges];
  const touches = (e: string, id: string) => { const p = JSON.parse(e); return p.s === id || p.e === id; };
  switch (op.kind) {
    case 'addEdge': ea = ea.slice(0, eb.length); break;
    case 'deleteEdge': eb.splice(op.index, 1); break;
    case 'deleteNode': eb = eb.filter((e) => !touches(e, op.id)); break;
    case 'moveNode': case 'groupNode': eb.sort(); ea.sort(); break;
    default: break;
  }
  if (JSON.stringify(eb) !== JSON.stringify(ea)) {
    const i = eb.findIndex((e, k) => e !== ea[k]);
    v.push({ kind: `edge-extra-changed:${op.kind}`, detail: `edge ${i}: ${eb[i]} -> ${ea[i]}` });
  }
  return v;
}

// ------------------------------------------------------------------ known findings

/**
 * Findings of the bug hunt that are known and not yet fixed, each matched by its own
 * cause only: another failure of the same kind still fails the run. When a finding is
 * fixed, its entry goes, so the run fails if it comes back.
 */
const KNOWN: { id: string; kind: string; what: string; matches: (op: Op, before: string) => boolean }[] = [
  {
    id: 'A9', kind: 'description-not-as-typed',
    what: 'a description line typed with a backslash in front reads back without it',
    matches: (op) => op.kind === 'setDescription' && /^\s*\\/m.test(op.description),
  },
  {
    id: 'A10', kind: 'scanner-cannot-read-result',
    what: 'a title with a line break on a node written id@{ ... } leaves a line the scanner cannot read',
    matches: (op, before) => op.kind === 'setTitle' && op.title.includes('\n') && before.includes(`${op.id}@{`),
  },
  {
    id: 'oA43', kind: 'edge-extra-changed:addEdge',
    what: 'a new arrow goes above a line holding a directive and an arrow, so Mermaid numbers it before that arrow',
    matches: (op, before) => op.kind === 'addEdge' && /^\s*%%\{.*\}%%\s*\S/m.test(before),
  },
];

// ------------------------------------------------------------------ the run

interface Found { count: number; seed: number; step: number; before: string; op: Op; detail: string; diff: string }

test(`fuzz: ${RUNS} random flowcharts, up to ${OPS_PER_CHART} edits each (base seed ${BASE_SEED})`, async () => {
  const found = new Map<string, Found>();
  const known = new Map<string, number>();
  const stats = { charts: 0, invalid: 0, unreadable: 0, accepted: 0, refused: 0, oneLine: 0 };
  const note = (kind: string, f: Omit<Found, 'count'>) => {
    const had = found.get(kind);
    if (had) had.count++;
    else found.set(kind, { ...f, count: 1 });
  };
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + run;
    let text = genChart(seed);
    stats.charts++;
    let snap: Snap;
    try { snap = await snapshot(text); } catch { stats.invalid++; continue; }
    if (parseDoc(text).problems.length) stats.unreadable++;
    let acc = await mermaidAcc(text);
    if (acc !== null && acc !== naiadAcc(snap)) {
      note('acc-read-otherwise', { seed, step: -1, before: text, op: { kind: 'setDirection', dir: 'TB' }, detail: `Mermaid ${acc}, Naiad ${naiadAcc(snap)}`, diff: '' });
    }
    const r = new Rand(seed ^ 0x5eed);
    // The one-line description edits come from a stream of their own and change no node,
    // arrow or group, so `r` picks the same edits as before they were added (round 7).
    const w = new Rand(seed ^ 0x6c696e65);
    const edit = async (op: Op, step: number, block: DescBlock | null) => {
      let res: OpResult;
      try {
        res = await applyChecked(text, op);
      } catch (e) {
        if (e instanceof EditError) { stats.refused++; return; }
        note('crash', { seed, step, before: text, op, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e), diff: '' });
        return;
      }
      stats.accepted++;
      const vios = await checkEdit(text, snap, op, res);
      if (block) { stats.oneLine++; vios.push(...oneLineCheck(text, res.text, block)); }
      const accAfter = await mermaidAcc(res.text);
      if (acc !== null && accAfter !== acc) vios.push({ kind: `mermaid-acc-changed:${op.kind}`, detail: `${acc} -> ${accAfter}` });
      for (const vio of vios) {
        const k = KNOWN.find((x) => x.kind === vio.kind && x.matches(op, text));
        if (k) { known.set(k.id, (known.get(k.id) ?? 0) + 1); continue; }
        note(vio.kind, { seed, step, before: text, op, detail: vio.detail, diff: diff(text, res.text) });
      }
      const was = text;
      text = res.text;
      snap = await snapshot(text);
      if (accAfter !== null && accAfter !== naiadAcc(snap)) {
        note('acc-read-otherwise', { seed, step, before: was, op, detail: `after the edit: Mermaid ${accAfter}, Naiad ${naiadAcc(snap)}`, diff: diff(was, text) });
      }
      acc = accAfter;
    };
    for (let step = 0; step < OPS_PER_CHART; step++) {
      const one = w.chance(0.25) ? oneLineOp(w, text, snap) : null;
      if (one) await edit(one.op, step, one.block);
      await edit(randomOp(r, snap), step, null);
    }
  }
  const report = [...found].map(([kind, f]) => [
    `\n### ${kind} (${f.count}x). First: chart seed ${f.seed}, ${f.step < 0 ? 'as made' : `edit ${f.step + 1}: ${JSON.stringify(f.op)}`}`,
    `  ${f.detail}`,
    '  text before the edit:',
    ...f.before.split('\n').map((l) => `    | ${l}`),
    '  change:',
    ...f.diff.split('\n').map((l) => `    ${l}`),
  ].join('\n')).join('\n');
  console.log(`fuzz stats: ${JSON.stringify(stats)}`);
  for (const k of KNOWN) if (known.has(k.id)) console.log(`known, not yet fixed: ${k.id} (${known.get(k.id)}x), ${k.what}`);
  expect(stats.charts - stats.invalid, 'most generated charts must be valid Mermaid').toBeGreaterThan(stats.charts * 0.7);
  expect(found.size, `fuzz found ${found.size} kinds of failure (stats ${JSON.stringify(stats)}):${report}`).toBe(0);
}, 600_000);
