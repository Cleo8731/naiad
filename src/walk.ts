// Walk (T6.4; the user, 2026-11-25 and 2026-11-26, Q229 to Q232): following one run
// through the flowchart, node by node, choosing an arrow at each step. What a walk is
// and where it can go; nothing here draws (the chart shows it, `Chart.setWalk`) and
// nothing is written to the file.
import { shown, type Snap } from './semantics';

/** One step of a walk: the node (or group) reached, and the arrow taken to it (none for the first). */
export interface Step { id: string; via: number | null }

/** An arrow the walk can take from where it is: the arrow's index, where it leads, its label and that item's title. */
export interface Choice { edge: number; to: string; label: string; title: string }

/** What the chart shows of a walk. */
export interface WalkView {
  /** Where the walk is; null while the reader picks where to start. */
  here: string | null;
  /** While the reader picks where to start, the nodes no arrow points to: the hints (Q243). Any node can still be picked. */
  starts: Choice[];
  /** The arrows out of `here`. None at an end. */
  choices: Choice[];
  /** The places walked through before `here`, and the arrows taken, in order. */
  path: string[];
  pathEdges: number[];
  /** The arrow just taken to `here` (the view travels along it), or null. */
  via: number | null;
  /** Back is possible: there is a step before this one. */
  canBack: boolean;
}

/** What the reader did on the chart or its walk bar during a walk. */
export type WalkAction =
  | { kind: 'start'; id: string }
  | { kind: 'choose'; edge: number }
  | { kind: 'back' }
  | { kind: 'again' }
  | { kind: 'leave' };

/** An item's title as the chart shows it: a node's text, a group's title, or its id. */
export function titleOf(snap: Pick<Snap, 'nodes' | 'subs'>, id: string): string {
  return shown(snap.nodes[id]?.text || snap.subs[id]?.title || id);
}

/** Whether an arrow can be walked: an invisible link (`~~~`) only places nodes, so it is no step. */
const walkable = (e: Snap['edges'][number]): boolean => e.stroke !== 'invisible';

/**
 * The nodes no arrow points to, in the file's order: the hints while the reader picks
 * where to start (Q243). A chart that is all loops has none, and then nothing is hinted.
 */
export function startNodes(snap: Pick<Snap, 'nodes' | 'edges'>): string[] {
  const reached = new Set<string>();
  for (const e of snap.edges) {
    if (!walkable(e)) continue;
    reached.add(e.end);
    if (e.type.startsWith('double_arrow')) reached.add(e.start); // `<-->` points both ways
  }
  return Object.keys(snap.nodes).filter((id) => !reached.has(id));
}

/**
 * The arrows a walk can take from `id`, in the file's order: each arrow that leaves it,
 * and one that points both ways (`<-->`) from either end. An arrow from a node to itself
 * is a choice like any other.
 */
export function choicesFrom(snap: Pick<Snap, 'nodes' | 'subs' | 'edges'>, id: string): Choice[] {
  const out: Choice[] = [];
  snap.edges.forEach((e, i) => {
    if (!walkable(e)) return;
    const to = e.start === id ? e.end : e.end === id && e.type.startsWith('double_arrow') ? e.start : null;
    if (to !== null) out.push({ edge: i, to, label: shown(e.text), title: titleOf(snap, to) });
  });
  return out;
}

const exists = (snap: Pick<Snap, 'nodes' | 'subs'>, id: string): boolean => id in snap.nodes || id in snap.subs;

/**
 * A walk after the file changed (an agent's edit, say): it keeps its steps up to the last
 * one whose place is still in the chart, so a walk whose node went steps back to the
 * last node still there. Arrows are numbered by their place in the file, so each step's
 * arrow is found again by its two ends; one no longer there leaves the step without one.
 */
export function stillThere(snap: Pick<Snap, 'nodes' | 'subs' | 'edges'>, path: Step[]): Step[] {
  const out: Step[] = [];
  for (const step of path) {
    if (!exists(snap, step.id)) break;
    const from = out[out.length - 1]?.id;
    const via = from === undefined ? null : choicesFrom(snap, from).find((c) => c.to === step.id)?.edge ?? null;
    out.push({ id: step.id, via });
  }
  return out;
}

/** What the chart shows for a walk at `path` (empty: picking where to start). */
export function walkView(snap: Pick<Snap, 'nodes' | 'subs' | 'edges'>, path: Step[]): WalkView {
  const last = path[path.length - 1];
  if (!last) {
    const starts = startNodes(snap).map((id) => ({ edge: -1, to: id, label: '', title: titleOf(snap, id) }));
    return { here: null, starts, choices: [], path: [], pathEdges: [], via: null, canBack: false };
  }
  return {
    here: last.id,
    starts: [],
    choices: choicesFrom(snap, last.id),
    path: path.slice(0, -1).map((s) => s.id),
    pathEdges: path.flatMap((s) => (s.via === null ? [] : [s.via])),
    via: last.via,
    canBack: path.length > 1,
  };
}
