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
//   - what Mermaid reads but the checked edit does not compare stays as it was:
//     Markdown labels, an arrow's own id and its `@{ animate }`, `interpolate`, links,
//     tooltips, group classes, and the configuration set in the file;
//   - Mermaid's reading matches the checked edit's expectation even when two untitled
//     groups share a title (canon() in src/semantics.ts names them alike).
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
import { getDescriptions, parseDescriptions } from '../src/core/descriptions';
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

interface Gen { r: Rand; ids: string[]; subIds: string[]; unit: string; edgeIds: number; lines: string[]; mentioned: Set<string> }

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
  if (g.r.chance(0.04)) descBlock(g, indent);
}

function descBlock(g: Gen, indent: string): void {
  const id = g.r.chance(0.8) ? g.r.pick(g.ids) : g.r.pick(['orphan', 'n3', 'group2']);
  g.lines.push(`${indent}%% @${id}`);
  const n = 1 + g.r.int(4);
  for (let i = 0; i < n; i++) g.lines.push(`${indent}%% ${g.r.pick(DESC_LINES)}`);
  if (g.r.chance(0.05)) g.lines.push(`${indent}%%`); // a bare %%, which Naiad tolerates and warns about
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

export function genChart(seed: number): string {
  const r = new Rand(seed);
  const g: Gen = { r, ids: r.some(NODE_IDS, 3 + r.int(6)), subIds: [], unit: r.pick(['  ', '    ', '\t']), edgeIds: 0, lines: [], mentioned: new Set() };
  if (r.chance(0.12)) g.lines.push('---', 'title: Fuzz chart', '---');
  if (r.chance(0.08)) g.lines.push('%%{init: {"theme": "neutral"}}%%');
  if (r.chance(0.08)) g.lines.push('%% a comment above the header');
  g.lines.push(`${r.pick(['flowchart', 'graph'])}${r.chance(0.92) ? ` ${r.pick(DIRS)}` : ''}${r.chance(0.05) ? ';' : ''}`);
  body(g, g.unit, 0);
  for (let k = 1; k <= g.edgeIds; k++) if (r.chance(0.4)) g.lines.push(`${g.unit}e${k}@{ animate: true }`);
  if (r.chance(0.03)) g.lines.push(`${g.unit}END`); // valid Mermaid (a node) that the scanner cannot read
  const used = [...g.mentioned];
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

// ------------------------------------------------------------------ what Mermaid reads beyond the snapshot

interface Extra {
  nodes: Record<string, string>;
  edges: string[];
  subs: Record<string, string>;
}

const extraCache = new Map<string, Extra>();
async function extra(text: string): Promise<Extra> {
  const hit = extraCache.get(text);
  if (hit) return hit;
  const api = (mermaid as unknown as { mermaidAPI: { getDiagramFromText(t: string): Promise<any> } }).mermaidAPI;
  const db = (await api.getDiagramFromText(forMermaid(text))).db;
  const tips: Map<string, string> = db.tooltips ?? new Map();
  const subIds = new Set<string>(db.getSubGraphs().map((s: any) => s.id));
  const nodes: Record<string, string> = {};
  for (const v of db.getVertices().values()) {
    if (subIds.has(v.id)) continue;
    nodes[v.id] = JSON.stringify({ md: v.labelType === 'markdown', link: v.link ?? '', tip: tips.get(v.id) ?? '' });
  }
  const edges = db.getEdges().map((e: any) => JSON.stringify({
    s: e.start, e: e.end, text: e.text, md: e.labelType === 'markdown', id: e.isUserDefinedId ? e.id : '',
    animate: e.animate ?? false, interpolate: e.interpolate ?? '', classes: e.classes ?? [],
  }));
  const subs: Record<string, string> = {};
  for (const s of db.getSubGraphs()) {
    const key = /^subGraph\d+$/.test(s.id) ? `~${s.title}` : s.id;
    subs[key] = JSON.stringify({ md: s.labelType === 'markdown', classes: [...(s.classes ?? [])].sort() });
  }
  const res = { nodes, edges, subs };
  extraCache.set(text, res);
  return res;
}

const configCache = new Map<string, string>();
async function config(text: string): Promise<string> {
  if (!configCache.has(text)) configCache.set(text, JSON.stringify((await mermaid.parse(forMermaid(text))) as unknown));
  return configCache.get(text)!;
}

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
  // 5. What Mermaid reads that the checked edit does not compare.
  const xb = await extra(before);
  const xa = await extra(after);
  for (const id of Object.keys(xb.nodes)) {
    if (id in xa.nodes && xb.nodes[id] !== xa.nodes[id]) v.push({ kind: `node-extra-changed:${op.kind}`, detail: `${id}: ${xb.nodes[id]} -> ${xa.nodes[id]}` });
  }
  for (const id of Object.keys(xb.subs)) {
    if (op.kind === 'renameSubgraph') break;
    if (id in xa.subs && xb.subs[id] !== xa.subs[id]) v.push({ kind: `group-extra-changed:${op.kind}`, detail: `${id}: ${xb.subs[id]} -> ${xa.subs[id]}` });
  }
  let eb = [...xb.edges];
  let ea = [...xa.edges];
  const touches = (e: string, id: string) => { const p = JSON.parse(e); return p.s === id || p.e === id; };
  switch (op.kind) {
    case 'addEdge': ea = ea.slice(0, eb.length); break;
    case 'deleteEdge': eb.splice(op.index, 1); break;
    case 'deleteNode': eb = eb.filter((e) => !touches(e, op.id)); break;
    case 'moveNode': case 'groupNode': eb.sort(); ea.sort(); break;
    case 'setEdgeLabel': {
      const strip = (e: string) => JSON.stringify({ ...JSON.parse(e), md: null, text: null });
      if (eb[op.index]) eb[op.index] = strip(eb[op.index]);
      if (ea[op.index]) ea[op.index] = strip(ea[op.index]);
      break;
    }
    default: break;
  }
  if (JSON.stringify(eb) !== JSON.stringify(ea)) {
    const i = eb.findIndex((e, k) => e !== ea[k]);
    v.push({ kind: `edge-extra-changed:${op.kind}`, detail: `edge ${i}: ${eb[i]} -> ${ea[i]}` });
  }
  if (op.kind === 'setDescription' && (await config(before)) !== (await config(after))) {
    v.push({ kind: 'config-changed:setDescription', detail: `${await config(before)} -> ${await config(after)}` });
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
];

// ------------------------------------------------------------------ the run

interface Found { count: number; seed: number; step: number; before: string; op: Op; detail: string; diff: string }

test(`fuzz: ${RUNS} random flowcharts, up to ${OPS_PER_CHART} edits each (base seed ${BASE_SEED})`, async () => {
  const found = new Map<string, Found>();
  const known = new Map<string, number>();
  const stats = { charts: 0, invalid: 0, unreadable: 0, accepted: 0, refused: 0 };
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
    const r = new Rand(seed ^ 0x5eed);
    for (let step = 0; step < OPS_PER_CHART; step++) {
      const op = randomOp(r, snap);
      let res: OpResult;
      try {
        res = await applyChecked(text, op);
      } catch (e) {
        if (e instanceof EditError) { stats.refused++; continue; }
        note('crash', { seed, step, before: text, op, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e), diff: '' });
        continue;
      }
      stats.accepted++;
      for (const vio of await checkEdit(text, snap, op, res)) {
        const k = KNOWN.find((x) => x.kind === vio.kind && x.matches(op, text));
        if (k) { known.set(k.id, (known.get(k.id) ?? 0) + 1); continue; }
        note(vio.kind, { seed, step, before: text, op, detail: vio.detail, diff: diff(text, res.text) });
      }
      text = res.text;
      snap = await snapshot(text);
    }
  }
  const report = [...found].map(([kind, f]) => [
    `\n### ${kind} (${f.count}x). First: chart seed ${f.seed}, edit ${f.step + 1}: ${JSON.stringify(f.op)}`,
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
