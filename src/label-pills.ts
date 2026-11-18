/**
 * The colour of an arrow label's pill (Q176, the user's idea, 2026-11-18): outside every
 * group the pill takes the group colour, and inside a group the chart's background, so
 * the pill always stands apart from what lies around it and uses no colour the chart
 * doesn't already have. This marks each label whose centre lies in a group's box with
 * the class `in-group`; the colours themselves are rules in `configureMermaid`
 * (`chart.ts`). Drawing only: the file and the layout are not touched.
 */

/** How far an element's own `translate()` and its parents' move it, up to `root`. */
function offset(el: Element | null, root: Element): [number, number] {
  let x = 0;
  let y = 0;
  for (let at = el; at && at !== root; at = at.parentElement) {
    const m = /translate\(\s*(-?[\d.e+-]+)(?:[\s,]+(-?[\d.e+-]+))?\s*\)/.exec(at.getAttribute('transform') ?? '');
    if (m) { x += Number(m[1]); y += Number(m[2] ?? 0); }
  }
  return [x, y];
}

export function markLabelsInGroups(svg: SVGSVGElement): void {
  for (const root of svg.querySelectorAll<SVGGElement>('g.root')) {
    const boxes = [...root.querySelectorAll<SVGRectElement>('g.cluster > rect')].map((rect) => {
      const [dx, dy] = offset(rect.parentElement, root);
      const n = (name: string) => Number(rect.getAttribute(name) ?? 0);
      return { x: n('x') + dx, y: n('y') + dy, w: n('width'), h: n('height') };
    });
    for (const label of root.querySelectorAll<SVGGElement>('g.edgeLabel')) {
      // Mermaid places a label's group at the label's centre.
      const [x, y] = offset(label, root);
      const inside = boxes.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      label.classList.toggle('in-group', inside);
    }
  }
}
