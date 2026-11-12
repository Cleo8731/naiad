// What a flowchart file means, according to Mermaid's own parser: its nodes, edges and
// groups. The app compares this before and after every edit (src/verify.ts).

import mermaid from 'mermaid';
import { parseDoc } from './core/scan';

export interface SnapNode { text: string; type: string; styles: string[]; classes: string[] }
export interface SnapEdge {
  start: string; end: string; text: string; type: string; stroke: string; length: number; style: string[];
  /** The label is a Markdown string (`"\`...\`"`). */
  markdown: boolean;
  /** The curve, from `linkStyle N interpolate` or the arrow's own settings. */
  interpolate: string;
  classes: string[];
  animate: boolean;
  animation: string;
  /** The arrow's own id (`e1@-->`); '' for the id Mermaid makes up, which shifts. */
  id: string;
}
export interface SnapSub { title: string; nodes: string[]; dir: string; styles: string[] }

export interface Snap {
  direction: string;
  nodes: Record<string, SnapNode>;
  /** In Mermaid's order, which is the order `linkStyle` counts in. */
  edges: SnapEdge[];
  /** Mermaid's id for each edge, used to find the edge's line in the drawing. */
  edgeIds: string[];
  subs: Record<string, SnapSub>;
  /** The accessible title and description, which no edit changes (bug hunt round 5, A38). */
  accTitle: string;
  accDescr: string;
}

/**
 * A bare `%%` line where a comment may stand is not a comment to Mermaid (it becomes a
 * node), so it is blanked here: the lines the scanner warns about. Elsewhere Mermaid reads
 * a bare `%%` as text, and it is left as it stands: in the front matter, which is YAML
 * (bug hunt round 4, D29), and in a title or an accessible text written over several
 * lines (round 5, A38, A39). A line ends where Mermaid ends one, at LF, CR or CRLF; not at
 * U+2028 or U+2029 (round 4, A37).
 */
export function forMermaid(text: string): string {
  const warned = parseDoc(text.replace(/\r\n?/g, '\n')).warnings;
  if (!warned.length) return text;
  // Lines at even places, each followed by its line break.
  const parts = text.split(/(\r\n|\r|\n)/);
  for (const { line } of warned) if (/^[ \t]*%%[ \t]*$/.test(parts[2 * line] ?? '')) parts[2 * line] = '';
  return parts.join('');
}

const normDir = (d: unknown): string => (d === 'TD' ? 'TB' : typeof d === 'string' ? d : '');
// Mermaid stores "#quot;" style entities behind placeholder characters; undo that.
const normText = (t: unknown): string => String(t ?? '').replace(/ﬂ°°?(\w+)¶ß/g, '#$1;').trim();

export async function snapshot(text: string, asIs = false): Promise<Snap> {
  const api = (mermaid as unknown as { mermaidAPI: { getDiagramFromText(t: string): Promise<any> } }).mermaidAPI;
  const diagram = await api.getDiagramFromText(asIs ? text : forMermaid(text));
  if (!String(diagram.type).startsWith('flowchart')) {
    throw new Error(`This file is a "${diagram.type}" diagram, not a flowchart.`);
  }
  const db = diagram.db;
  const snap: Snap = {
    direction: normDir(db.getDirection()), nodes: {}, edges: [], edgeIds: [], subs: {},
    accTitle: String(db.getAccTitle?.() ?? ''), accDescr: String(db.getAccDescription?.() ?? ''),
  };
  for (const v of db.getVertices().values()) {
    snap.nodes[v.id] = {
      text: normText(v.text),
      type: v.type ?? 'square',
      styles: [...(v.styles ?? [])].map((s: string) => s.trim()).sort(),
      classes: [...(v.classes ?? [])].sort(),
    };
  }
  for (const e of db.getEdges()) {
    snap.edges.push({
      start: e.start, end: e.end, text: normText(e.text), type: e.type ?? '', stroke: e.stroke ?? '',
      length: e.length ?? 1, style: [...(e.style ?? [])].sort(),
      markdown: e.labelType === 'markdown', interpolate: e.interpolate ?? '', classes: [...(e.classes ?? [])].sort(),
      animate: !!e.animate, animation: e.animation ?? '', id: e.isUserDefinedId ? e.id : '',
    });
    snap.edgeIds.push(e.id);
  }
  for (const s of db.getSubGraphs()) {
    snap.subs[s.id] = { title: normText(s.title), nodes: [...s.nodes].sort(), dir: normDir(s.dir), styles: [] };
  }
  // A group that is styled, or is an arrow's end, also shows up as a node; fold it back.
  for (const id of Object.keys(snap.subs)) {
    const twin = snap.nodes[id];
    if (!twin) continue;
    snap.subs[id].styles = twin.styles;
    delete snap.nodes[id];
  }
  return snap;
}

/** Mermaid's reading of a flowchart in the form the checker takes (src/core/check.ts). */
export async function reading(text: string, asIs = false): Promise<{ ids: string[]; shape: string; acc: string }> {
  const snap = await snapshot(text, asIs);
  return { ids: [...Object.keys(snap.nodes), ...Object.keys(snap.subs)], shape: canon(snap), acc: JSON.stringify([snap.accTitle, snap.accDescr]) };
}

function sortKeys<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
}

/**
 * A form two snapshots share exactly when they mean the same chart. A group written
 * with only a title gets a numbered id from Mermaid (`subGraph2`) that shifts whenever
 * a group is added or removed, so those ids are replaced by the group's title here.
 */
export function canon(s: Snap): string {
  const alias = new Map<string, string>();
  for (const [id, sub] of Object.entries(s.subs)) if (/^subGraph\d+$/.test(id)) alias.set(id, `~untitled-id:${sub.title}`);
  const name = (id: string) => alias.get(id) ?? id;
  const subs: Record<string, SnapSub> = {};
  for (const [id, sub] of Object.entries(s.subs)) subs[name(id)] = { ...sub, nodes: sub.nodes.map(name).sort() };
  return JSON.stringify({
    direction: s.direction,
    nodes: sortKeys(s.nodes),
    edges: s.edges.map((e) => JSON.stringify(e)).sort(),
    subs: sortKeys(subs),
    accTitle: s.accTitle,
    accDescr: s.accDescr,
  });
}
