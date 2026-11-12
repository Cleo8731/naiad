// Runs an edit and checks the result against Mermaid's own parser before it is used:
// the new text must parse, and must differ from the old chart in exactly the way the
// edit intends. Anything else is refused and the file is left as it was.

import { FRONT_MATTER_RE, parseDoc } from './core/scan';
import { parseDescriptions, setDescription } from './core/descriptions';
import * as E from './core/edits';
import { canon, snapshot, type Snap } from './semantics';

export type Op =
  | { kind: 'setTitle'; id: string; title: string }
  | { kind: 'setDescription'; id: string; description: string }
  | { kind: 'setShape'; id: string; shape: string }
  | { kind: 'addNode'; title: string; parent: string | null }
  | { kind: 'deleteNode'; id: string }
  | { kind: 'addEdge'; from: string; to: string }
  | { kind: 'deleteEdge'; index: number }
  | { kind: 'setEdgeLabel'; index: number; label: string }
  | { kind: 'setEdgeStyle'; index: number; stroke?: E.LinkParts['stroke']; arrow?: E.ArrowKind }
  | { kind: 'setStyle'; id: string; changes: Record<string, string | null> }
  | { kind: 'setDirection'; dir: string }
  | { kind: 'moveNode'; id: string; target: string | null }
  | { kind: 'groupNode'; id: string; title: string }
  | { kind: 'renameSubgraph'; id: string; title: string }
  | { kind: 'setSubgraphDirection'; id: string; dir: string | null }
  | { kind: 'ungroup'; id: string };

export interface OpResult { text: string; created?: string }

/** The edit itself: text in, text out, no checking. */
export function runOp(text: string, op: Op): OpResult {
  switch (op.kind) {
    case 'setTitle': return { text: E.setTitle(text, op.id, op.title) };
    case 'setDescription': return { text: setDescription(text, op.id, op.description) };
    case 'setShape': return { text: E.setShape(text, op.id, op.shape) };
    case 'addNode': {
      const r = E.addNode(text, op.title, op.parent);
      return { text: r.text, created: r.id };
    }
    case 'deleteNode': return { text: E.deleteNode(text, op.id) };
    case 'addEdge': return { text: E.addEdge(text, op.from, op.to) };
    case 'deleteEdge': return { text: E.deleteEdge(text, op.index) };
    case 'setEdgeLabel': return { text: E.setEdgeLabel(text, op.index, op.label) };
    case 'setEdgeStyle': return { text: E.setEdgeStyle(text, op.index, { stroke: op.stroke, arrow: op.arrow }) };
    case 'setStyle': return { text: E.setStyle(text, op.id, op.changes) };
    case 'setDirection': return { text: E.setDirection(text, op.dir) };
    case 'moveNode': return { text: E.moveNode(text, op.id, op.target) };
    case 'groupNode': {
      const g = E.addSubgraph(text, op.title);
      return { text: E.moveNode(g.text, op.id, g.id), created: g.id };
    }
    case 'renameSubgraph': {
      const r = E.renameSubgraph(text, op.id, op.title);
      return { text: r.text, created: r.id };
    }
    case 'setSubgraphDirection': return { text: E.setSubgraphDirection(text, op.id, op.dir) };
    case 'ungroup': return { text: E.ungroup(text, op.id) };
  }
}

const enc = (t: string): string => t.replace(/\r?\n/g, '<br/>').trim().replace(/"/g, '#quot;');
const dirOf = (d: string | null): string => (d === 'TD' ? 'TB' : d ?? '');

function styleAfter(styles: string[], changes: Record<string, string | null>): string[] {
  const keyOf = (s: string) => s.slice(0, s.indexOf(':')).trim();
  const out = styles.filter((s) => !(keyOf(s) in changes));
  for (const [k, v] of Object.entries(changes)) if (v !== null) out.push(`${k}:${v}`);
  return out.sort();
}

const ARROWS: Record<E.ArrowKind, string> = {
  arrow: 'arrow_point', none: 'arrow_open', both: 'double_arrow_point', circle: 'arrow_circle', cross: 'arrow_cross',
};

/** What the chart must be after the edit, worked out from what it was before. */
export function expectOp(before: Snap, op: Op, res: OpResult): Snap {
  const s: Snap = structuredClone(before);
  const outOfGroups = (id: string) => {
    for (const g of Object.values(s.subs)) g.nodes = g.nodes.filter((n) => n !== id);
  };
  switch (op.kind) {
    case 'setDescription': break;
    case 'setTitle': s.nodes[op.id].text = enc(op.title); break;
    case 'setShape': s.nodes[op.id].type = op.shape; break;
    case 'addNode':
      s.nodes[res.created!] = { text: enc(op.title), type: 'square', styles: [], classes: [] };
      if (op.parent) s.subs[op.parent].nodes = [...s.subs[op.parent].nodes, res.created!].sort();
      break;
    case 'deleteNode':
      delete s.nodes[op.id];
      s.edges = s.edges.filter((e) => e.start !== op.id && e.end !== op.id);
      outOfGroups(op.id);
      break;
    case 'addEdge':
      s.edges.push({
        start: op.from, end: op.to, text: '', type: 'arrow_point', stroke: 'normal', length: 1, style: [],
        markdown: false, interpolate: '', classes: [], animate: false, animation: '', id: '',
      });
      break;
    case 'deleteEdge': s.edges.splice(op.index, 1); break;
    case 'setEdgeLabel': {
      // A Markdown label stays Markdown (as a node's title does); no label is plain.
      const e = s.edges[op.index];
      e.text = enc(op.label);
      e.markdown = e.markdown && e.text !== '';
      break;
    }
    case 'setEdgeStyle':
      if (op.stroke) s.edges[op.index].stroke = op.stroke;
      if (op.arrow) s.edges[op.index].type = ARROWS[op.arrow];
      if (s.edges[op.index].stroke === 'invisible') Object.assign(s.edges[op.index], { type: 'arrow_open', text: '', length: 1, markdown: false });
      break;
    case 'setStyle': {
      const target = s.subs[op.id] ?? s.nodes[op.id];
      target.styles = styleAfter(target.styles, op.changes);
      break;
    }
    case 'setDirection': s.direction = dirOf(op.dir); break;
    case 'moveNode':
      outOfGroups(op.id);
      if (op.target) s.subs[op.target].nodes = [...s.subs[op.target].nodes, op.id].sort();
      break;
    case 'groupNode':
      outOfGroups(op.id);
      s.subs[res.created!] = { title: enc(op.title), nodes: [op.id], dir: '', styles: [] };
      break;
    case 'renameSubgraph': {
      const sub = s.subs[op.id];
      sub.title = enc(op.title);
      if (res.created && res.created !== op.id) {
        delete s.subs[op.id];
        s.subs[res.created] = sub;
        for (const g of Object.values(s.subs)) g.nodes = g.nodes.map((n) => (n === op.id ? res.created! : n)).sort();
      }
      break;
    }
    case 'setSubgraphDirection': s.subs[op.id].dir = dirOf(op.dir); break;
    case 'ungroup': {
      const inside = s.subs[op.id].nodes;
      delete s.subs[op.id];
      for (const g of Object.values(s.subs)) {
        if (!g.nodes.includes(op.id)) continue;
        g.nodes = [...g.nodes.filter((n) => n !== op.id), ...inside].sort();
      }
      break;
    }
  }
  return s;
}

const EDGE_OPS = new Set(['deleteEdge', 'setEdgeLabel', 'setEdgeStyle']);

/**
 * Runs an edit with the check. Throws E.EditError (with a message for the user) when
 * the edit cannot be made safely; the caller keeps the old text.
 */
export async function applyChecked(text: string, op: Op): Promise<OpResult> {
  let before: Snap;
  try {
    before = await snapshot(text);
  } catch {
    throw new E.EditError('The file has a syntax error right now. Fix it in the text pane first.');
  }
  if (EDGE_OPS.has(op.kind)) {
    const mine = parseDoc(text).edges.map((e) => `${e.from.id}>${e.to.id}`).join('|');
    const theirs = before.edges.map((e) => `${e.start}>${e.end}`).join('|');
    if (mine !== theirs) {
      throw new E.EditError('The editor reads the arrows in this file differently from Mermaid, so it will not rewrite them. Change this arrow in the text pane.');
    }
  }
  const res = runOp(text, op);
  if (directives(text) !== directives(res.text)) {
    throw new E.EditError('That change would have changed the chart\'s settings (a %%{ }%% directive), so it was not made. Make it in the text pane instead.');
  }
  // The front matter holds the chart's title and settings, which `snapshot` does not
  // compare: no edit changes it (bug hunt round 4, A35).
  if (frontMatter(text) !== frontMatter(res.text)) {
    throw new E.EditError('That change would have changed the front matter (the settings between the "---" lines at the top), so it was not made. Make it in the text pane instead.');
  }
  let after: Snap;
  try {
    after = await snapshot(res.text);
  } catch {
    throw new E.EditError('That change would have broken the file, so it was not made. Make it in the text pane instead.');
  }
  if (canon(expectOp(before, op, res)) !== canon(after)) {
    throw new E.EditError('That change would have altered other parts of the chart, so it was not made. Make it in the text pane instead.');
  }
  if (descriptionsOf(text, op) !== descriptionsOf(res.text, op)) {
    throw new E.EditError('That change would have altered a description, so it was not made. Make it in the text pane instead.');
  }
  return res;
}

/**
 * Mermaid's own pattern for a directive (`directiveRegex`, Mermaid 12.3.0). Mermaid looks
 * for it in the whole text, comment lines and titles included, and takes the chart's
 * settings from it, which `snapshot` does not compare (bug hunt A7).
 */
const DIRECTIVE_RE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;

/** The front matter as Mermaid finds it, its fences included; '' for none. */
function frontMatter(text: string): string {
  return FRONT_MATTER_RE.exec(text)?.[0] ?? '';
}

/** Every directive Mermaid finds in the text, in order. */
function directives(text: string): string {
  return JSON.stringify(text.match(DIRECTIVE_RE) ?? []);
}

/**
 * Every description block, in order, as Naiad reads it; Mermaid's parser does not see
 * them. Only a change to a node's description, or deleting the node, may change that
 * node's blocks (bug hunt S24).
 */
function descriptionsOf(text: string, op: Op): string {
  const own = op.kind === 'setDescription' || op.kind === 'deleteNode' ? op.id : null;
  return JSON.stringify(parseDescriptions(text.split('\n')).filter((b) => b.id !== own).map((b) => [b.id, b.text]));
}
