// Arrow labels near the node they leave (D1.7, the user, 2026-11-14). Mermaid hands its
// layout, ELK, every arrow label to place in the middle of the arrow; on an arrow that
// spans several rows that is the middle row, far from the decision it answers. ELK's
// own setting puts the label in the row nearest the arrow's source instead, and makes
// room for it there. Mermaid has no public way to pass it, so Naiad passes it on each
// call to ELK's `layout`, whose second argument holds options for the whole graph.
// Naiad imports the same ELK file Mermaid's layout imports (`elkjs` is listed in
// `package.json` at the version Mermaid installs), so both use one copy and the change
// reaches Mermaid's calls; a test fails if a Mermaid update stops importing it. Drawing
// only: nothing is written into the file.

import ELK from 'elkjs/lib/elk.bundled.js';

const LABEL_LAYER = 'elk.layered.edgeLabels.centerLabelPlacementStrategy';

type Options = Record<string, string>;
interface Edge {
  /** Set by Mermaid on an arrow it turned around before the layout (an arrow that
   * loops back out of a group), so ELK's source is the arrow's target. */
  layoutReversed?: boolean;
  labels?: { layoutOptions?: Options }[];
}
interface Graph { layoutOptions?: Options; edges?: Edge[]; children?: Graph[] }
interface Args { layoutOptions?: Options }
type Layout = (this: { defaultLayoutOptions?: Options }, graph: Graph, args?: Args) => Promise<Graph>;

function* edgesOf(g: Graph): Generator<Edge> {
  yield* g.edges ?? [];
  for (const c of g.children ?? []) yield* edgesOf(c);
}

/**
 * What Naiad changes in one call to ELK's `layout(graph, args)`: every arrow label goes
 * in the row nearest the arrow's tail, ELK's source (`TAIL_LAYER`), added to the call's
 * options or, when it has none, to ELK's defaults, which a call's own options replace.
 * An arrow ELK turns around itself (one back up to an earlier step) keeps its own source
 * as the tail. One Mermaid turned around has ELK's tail at its target, so its label
 * takes the head's row (`HEAD_LAYER`), which is the arrow's own source.
 */
export function labelsNearSource(graph: Graph, args: Args = {}, defaults: Options = {}): Args {
  for (const e of edgesOf(graph)) {
    const label = e.layoutReversed ? e.labels?.[0] : undefined;
    if (label) label.layoutOptions = { ...label.layoutOptions, [LABEL_LAYER]: 'HEAD_LAYER' };
  }
  return { ...args, layoutOptions: { ...(args.layoutOptions ?? defaults), [LABEL_LAYER]: 'TAIL_LAYER' } };
}

let done = false;

/** Makes every ELK layout place arrow labels near their source; once, from `configureMermaid`. */
export function placeLabelsNearSource(): void {
  if (done) return;
  done = true;
  const proto = ELK.prototype as unknown as { layout: Layout };
  const layout = proto.layout;
  proto.layout = function (graph, args) {
    return layout.call(this, graph, labelsNearSource(graph, args, this.defaultLayoutOptions));
  };
}
